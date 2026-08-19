import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let rpcId = 0;
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const artifact = args.get("--artifact");
const manifestPath = args.get("--manifest");
const checksumsPath = args.get("--checksums");
const installUrl = args.get("--install-url");
if (!artifact || !manifestPath || !checksumsPath) {
  throw new Error(
    "Usage: node runtime-qualification.mjs --artifact <tgz> --manifest <json> --checksums <txt> [--install-url <https-url>]"
  );
}

const platform = releasePlatform();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const expectedSha = manifest?.current?.sha256;
if (
  manifest?.schemaVersion !== 2 ||
  manifest?.current?.assetName !== "nexum-runtime.tgz"
) {
  throw new Error("Unsupported Runtime manifest.");
}
if (
  !manifest.current.supportedNativeTargets?.some(
    (target) => target.platform === platform
  )
) {
  throw new Error(`Runtime manifest does not support ${platform}.`);
}
const actualSha = await sha256File(artifact);
if (actualSha !== expectedSha)
  throw new Error(`Runtime SHA-256 mismatch: ${actualSha}`);
if (
  !(await readFile(checksumsPath, "utf8")).includes(
    `${expectedSha}  nexum-runtime.tgz`
  )
) {
  throw new Error("SHA256SUMS.txt does not match the Runtime manifest.");
}

const root = await mkdtemp(join(tmpdir(), "nexum-public-qualification-"));
const home = join(root, "home");
const prefix = join(root, "prefix");
const project = join(root, "project");
let runtime;
try {
  await mkdir(join(home, "tmp"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.txt"), "before\n");
  const packageRoot = await installRuntime(artifact, prefix, home, installUrl);
  await verifyPackage(packageRoot, platform, manifest);
  const port = await reservePort();
  await writeConfig(home, port, project);
  runtime = await startRuntime(packageRoot, home, port);
  const origin = `http://127.0.0.1:${port}`;
  const firstProject = await openProject(origin, project);
  const read = await callTool(origin, "files.read", {
    projectId: firstProject,
    path: "notes.txt"
  });
  const revision = read.revision;
  if (read.content !== "before\n" || typeof revision !== "string")
    throw new Error("files.read failed.");
  await callTool(origin, "files.apply_patch", {
    projectId: firstProject,
    patch:
      "*** Begin Patch\n*** Update File: notes.txt\n@@\n-before\n+after\n*** End Patch",
    expectedRevisions: [{ path: "notes.txt", revision }]
  });
  const proc = await callTool(origin, "process.exec", {
    projectId: firstProject,
    command: "node -e \"console.log('runtime-public-qualification')\""
  });
  if (proc.status !== "completed" || proc.exitCode !== 0)
    throw new Error("process.exec failed.");
  const activity = await requestJson(`${origin}/api/v1/activity?limit=100`);
  const actions = new Set(activity.records?.map((record) => record.action));
  for (const action of [
    "project.open",
    "files.read",
    "files.patch",
    "process.finish"
  ]) {
    if (!actions.has(action)) throw new Error(`Activity is missing ${action}.`);
  }
  const database = join(home, ".nexum", "nexum.db");
  if ((await stat(database)).size <= 0)
    throw new Error("Runtime database is empty.");
  await runtime.stop();
  runtime = undefined;
  runtime = await startRuntime(packageRoot, home, port);
  const state = await requestJson(`${origin}/api/v1/management/state`);
  if (state.stats?.openProjects !== 0 || state.stats?.activeProcesses !== 0) {
    throw new Error("Runtime-only state survived restart.");
  }
  if ((await readFile(join(project, "notes.txt"), "utf8")) !== "after\n") {
    throw new Error("Patched file was not preserved.");
  }
  const secondProject = await openProject(origin, project);
  if (secondProject === firstProject)
    throw new Error("Project ID unexpectedly survived restart.");
  await runtime.stop();
  runtime = undefined;
  console.log(
    `Verified public-safe Runtime qualification: ${platform} sha256=${expectedSha}`
  );
} finally {
  if (runtime) await runtime.stop(true);
  await rm(root, { recursive: true, force: true });
}

async function installRuntime(tarball, installPrefix, installHome, publicUrl) {
  await mkdir(installPrefix, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const env = cleanEnv(installHome);
  const result = spawnSync(
    npm,
    [
      "install",
      "--global",
      "--prefix",
      installPrefix,
      "--omit=dev",
      "--ignore-scripts",
      publicUrl ?? resolve(tarball)
    ],
    {
      cwd: installHome,
      env: {
        ...env,
        npm_config_registry: "http://127.0.0.1:9/",
        npm_config_fetch_retries: "0",
        npm_config_fetch_timeout: "1000",
        npm_config_audit: "false",
        npm_config_fund: "false"
      },
      encoding: "utf8",
      shell: process.platform === "win32"
    }
  );
  if (result.status !== 0)
    throw new Error(`npm install failed: ${result.stderr || result.stdout}`);
  const packageRoot =
    process.platform === "win32"
      ? join(installPrefix, "node_modules", "nexum")
      : join(installPrefix, "lib", "node_modules", "nexum");
  await access(join(packageRoot, "nexum-runtime.json"));
  const cli =
    process.platform === "win32"
      ? join(installPrefix, "nexum.cmd")
      : join(installPrefix, "bin", "nexum");
  const help = spawnSync(cli, ["help"], {
    cwd: installHome,
    env,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (help.status !== 0 || !help.stdout.includes("--profile"))
    throw new Error("Installed CLI help failed.");
  return packageRoot;
}

async function verifyPackage(packageRoot, currentPlatform, releaseManifest) {
  for (const path of ["dist/main.js", "web/index.html", "nexum-runtime.json"])
    await access(join(packageRoot, path));
  const ptyUrl = pathToFileURL(
    join(packageRoot, "node_modules", "node-pty", "lib", "index.js")
  ).href;
  const pty = await import(ptyUrl);
  if (typeof pty.spawn !== "function")
    throw new Error("node-pty native module did not load.");
  const tunnel = join(
    packageRoot,
    "node_modules",
    "@nexum",
    "daemon",
    "vendor",
    "openai",
    "tunnel-client",
    "v0.0.11",
    currentPlatform,
    process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client"
  );
  await access(tunnel);
  const version = spawnSync(tunnel, ["--version"], { encoding: "utf8" });
  if (
    version.status !== 0 ||
    !`${version.stdout}${version.stderr}`.includes("0.0.11")
  )
    throw new Error("Tunnel binary version check failed.");
  const inventory = releaseManifest.current.nativeVendor;
  if (
    !inventory?.tunnel?.assets?.some(
      (asset) => asset.platform === currentPlatform
    )
  )
    throw new Error("Tunnel inventory missing target.");
  if (
    !inventory?.nodePty?.targets?.some(
      (target) => target.platform === currentPlatform
    )
  )
    throw new Error("node-pty inventory missing target.");
}

async function startRuntime(packageRoot, homePath, port) {
  const child = spawn(
    process.execPath,
    [join(packageRoot, "dist", "main.js"), "--profile", "production", "start"],
    {
      cwd: homePath,
      env: cleanEnv(homePath),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Runtime exited before ready: ${stderr.slice(-2000)}`);
    try {
      await requestJson(`http://127.0.0.1:${port}/api/v1/health`);
      return { child, stop: (force = false) => stopRuntime(child, force) };
    } catch {
      // Retry while the source-free Runtime starts.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  await stopRuntime(child, true);
  throw new Error(`Runtime readiness timeout: ${stderr.slice(-2000)}`);
}

async function stopRuntime(child, force = false) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
      { stdio: "ignore" }
    );
  } else child.kill(force ? "SIGKILL" : "SIGTERM");
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  if (child.exitCode === null && !force) return stopRuntime(child, true);
}

async function openProject(origin, path) {
  const result = await callTool(origin, "project.open", { path });
  if (typeof result.project?.id !== "string")
    throw new Error("project.open failed.");
  return result.project.id;
}

async function callTool(origin, name, toolArgs) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": "2026-07-28"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: toolArgs, _meta: mcpMeta() }
    })
  });
  const payload = await response.json();
  if (!response.ok || payload.error || payload.result?.isError)
    throw new Error(
      `MCP ${name} failed: ${JSON.stringify(payload.error || payload.result)}`
    );
  return payload.result?.structuredContent;
}

function mcpMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "nexum-public-qualification",
      version: "1.0.0"
    },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
}

async function requestJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function writeConfig(homePath, port, projectRoot) {
  const state = join(homePath, ".nexum");
  await mkdir(state, { recursive: true });
  const root = projectRoot.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  await writeFile(
    join(state, "config.toml"),
    `[daemon]\nhost = "127.0.0.1"\nport = ${port}\n\n[auth]\nmode = "off"\n\n[openai_tunnel]\nenabled = false\n\n[projects]\nallowed_roots = ["${root}"]\n\n[logging]\nlevel = "warn"\n`
  );
}

async function reservePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function cleanEnv(homePath) {
  const temp = join(homePath, "tmp");
  const keys =
    process.platform === "win32"
      ? ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "USERNAME"]
      : ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE"];
  const environment = {};
  for (const key of keys) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    HOME: homePath,
    USERPROFILE: homePath,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    npm_config_cache: join(homePath, ".npm-cache")
  };
}

function releasePlatform() {
  if (process.platform === "darwin" && process.arch === "arm64")
    return "darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64")
    return "windows-amd64";
  if (process.platform === "linux" && process.arch === "x64")
    return "linux-amd64";
  throw new Error(
    `Unsupported qualification platform: ${process.platform}/${process.arch}`
  );
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
