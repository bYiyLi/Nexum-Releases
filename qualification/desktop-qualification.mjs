import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { canonicalDirectory, sameDirectory } from "./path-identity.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const installer = args.get("--installer");
const expectedRuntimeSha = args.get("--runtime-sha");
if (!installer || !expectedRuntimeSha) {
  throw new Error(
    "Usage: node desktop-qualification.mjs --installer <dmg-exe-or-appimage> --runtime-sha <sha256>"
  );
}

const installerPath = resolve(installer);
const installerStat = await stat(installerPath);
if (!installerStat.isFile() || installerStat.size <= 0) {
  throw new Error(`Desktop installer is empty or missing: ${installerPath}`);
}

if (process.platform === "darwin" && process.arch === "arm64") {
  await qualifyMacosDmg(installerPath, expectedRuntimeSha);
} else if (process.platform === "win32" && process.arch === "x64") {
  await qualifyWindowsInstaller(installerPath, expectedRuntimeSha);
} else if (process.platform === "linux" && process.arch === "x64") {
  await qualifyLinuxAppImage(installerPath, expectedRuntimeSha);
} else {
  throw new Error(
    `Unsupported Desktop qualification platform: ${process.platform}/${process.arch}`
  );
}

console.log(`Verified Electron Desktop installer: ${basename(installerPath)}`);

async function qualifyMacosDmg(path, runtimeSha) {
  requireSuccess(
    spawnSync("hdiutil", ["verify", path], {
      encoding: "utf8",
      timeout: 30_000
    }),
    "DMG verify"
  );
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "nexum-electron-dmg-")
  );
  const mount = join(root, "mount");
  let mounted = false;
  try {
    await mkdir(mount);
    requireSuccess(
      spawnSync(
        "hdiutil",
        ["attach", path, "-readonly", "-nobrowse", "-mountpoint", mount],
        { encoding: "utf8", timeout: 30_000 }
      ),
      "DMG attach"
    );
    mounted = true;
    const app = join(mount, "Nexum.app");
    const executable = join(app, "Contents", "MacOS", "Nexum");
    const resources = join(app, "Contents", "Resources");
    await access(executable, fsConstants.X_OK);
    await access(join(resources, "node", "node"), fsConstants.X_OK);
    await verifyEmbeddedRuntime(resources, runtimeSha);
    requireSuccess(
      spawnSync("codesign", ["--verify", "--deep", "--strict", app], {
        encoding: "utf8",
        timeout: 30_000
      }),
      "macOS bundle seal verification"
    );
    await qualifyMacosLaunch(app, executable);
  } finally {
    if (mounted) {
      requireSuccess(
        spawnSync("hdiutil", ["detach", mount, "-force"], {
          encoding: "utf8",
          timeout: 30_000
        }),
        "DMG detach"
      );
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function qualifyMacosLaunch(app, executable) {
  const home = await mkdtemp(
    join(await realpath(tmpdir()), "nexum-electron-home-")
  );
  const projectPath = join(home, "Project");
  const port = await reserveLoopbackPort();
  await mkdir(projectPath, { recursive: true });
  const project = await canonicalDirectory(projectPath);
  await writeProductionConfig(home, port, project);
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NEXUM_DESKTOP_DIAGNOSTICS: "1"
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = captureProcessOutput(child);
  try {
    await waitForHealth(port, child, 45_000);
    await waitForUiLoadedMarker(port, async () => output(), child, 15_000);
    await verifyBrowserManagementFlow(port, project);
    if (child.exitCode !== null)
      throw new Error(
        `Electron Desktop exited during macOS qualification: ${JSON.stringify(output())}`
      );
  } finally {
    await terminateProcessTree(child.pid);
    disposeChildProcess(child);
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200
    });
  }
}

async function qualifyWindowsInstaller(path, runtimeSha) {
  const home = await mkdtemp(join(tmpdir(), "nexum-electron-home-"));
  const projectPath = join(home, "Project");
  const localAppData = join(home, "AppData", "Local");
  const installRoot = join(home, "Nexum");
  await mkdir(projectPath, { recursive: true });
  const project = await canonicalDirectory(projectPath);
  await mkdir(localAppData, { recursive: true });
  const port = await reserveLoopbackPort();
  await writeProductionConfig(home, port, project);
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    USERPROFILE: home,
    HOME: home,
    NEXUM_DESKTOP_DIAGNOSTICS: "1"
  };
  requireSuccess(
    spawnSync(path, ["/S", `/D=${installRoot}`], {
      encoding: "utf8",
      env,
      windowsHide: true
    }),
    "silent NSIS installation"
  );

  const executable = await findFile(installRoot, "Nexum.exe", 4);
  if (!executable)
    throw new Error(`Installed Nexum.exe was not found under ${installRoot}.`);
  verifyWindowsGuiSubsystem(await readFile(executable));
  const resources = join(resolve(executable, ".."), "resources");
  const bundledNode = join(resources, "node", "node.exe");
  await access(bundledNode, fsConstants.X_OK);
  requireSuccess(
    spawnSync(bundledNode, ["--version"], {
      encoding: "utf8",
      env,
      windowsHide: true
    }),
    "bundled standalone Node"
  );
  await verifyEmbeddedRuntime(resources, runtimeSha);

  const child = spawn(executable, [], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = captureProcessOutput(child);
  try {
    await waitForHealth(port, child, 60_000);
    await waitForUiLoadedMarker(port, async () => output(), child, 20_000);
    await verifyBrowserManagementFlow(port, project);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; Desktop output: ${JSON.stringify(output())}`,
      { cause: error }
    );
  } finally {
    await terminateProcessTree(child.pid);
    disposeChildProcess(child);
    const uninstaller = await findFile(installRoot, "Uninstall Nexum.exe", 2);
    if (uninstaller) {
      spawnSync(uninstaller, ["/S"], {
        encoding: "utf8",
        env,
        windowsHide: true
      });
    }
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200
    });
  }
}

async function qualifyLinuxAppImage(path, runtimeSha) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "nexum-appimage-"));
  const extractRoot = join(root, "extract");
  await mkdir(extractRoot);
  requireSuccess(
    spawnSync(path, ["--appimage-extract"], {
      cwd: extractRoot,
      encoding: "utf8"
    }),
    "AppImage extraction"
  );
  const appRoot = join(extractRoot, "squashfs-root");
  const executable = join(appRoot, "Nexum");
  const resources = join(appRoot, "resources");
  await access(executable, fsConstants.X_OK);
  await access(join(resources, "node", "node"), fsConstants.X_OK);
  await verifyEmbeddedRuntime(resources, runtimeSha);

  const home = await mkdtemp(join(root, "home-"));
  const projectPath = join(home, "Project");
  const port = await reserveLoopbackPort();
  await mkdir(projectPath, { recursive: true });
  const project = await canonicalDirectory(projectPath);
  await writeProductionConfig(home, port, project);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NEXUM_DESKTOP_DIAGNOSTICS: "1"
  };
  const child = spawn(executable, ["--no-sandbox"], {
    cwd: appRoot,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = captureProcessOutput(child);
  try {
    await waitForHealth(port, child, 60_000);
    await waitForUiLoadedMarker(port, async () => output(), child, 20_000);
    await verifyBrowserManagementFlow(port, project);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; Desktop output: ${JSON.stringify(output())}`,
      { cause: error }
    );
  } finally {
    await terminateProcessTree(child.pid);
    disposeChildProcess(child);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200
    });
  }
}

async function verifyEmbeddedRuntime(resourcesRoot, expectedSha) {
  const runtime = join(resourcesRoot, "runtime");
  for (const relative of [
    "dist/main.js",
    "web/index.html",
    "nexum-runtime.json",
    "embedded-runtime.json"
  ]) {
    await access(join(runtime, relative));
  }
  const embedded = JSON.parse(
    await readFile(join(runtime, "embedded-runtime.json"), "utf8")
  );
  if (embedded.schemaVersion !== 1 || embedded.sha256 !== expectedSha) {
    throw new Error(
      `Desktop embedded Runtime identity mismatch: expected ${expectedSha}, got ${embedded.sha256 ?? "missing"}.`
    );
  }
  const assets = await readdir(join(runtime, "web", "assets"));
  const source = (
    await Promise.all(
      assets
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(join(runtime, "web", "assets", name), "utf8"))
    )
  ).join("\n");
  if (!source.includes("/api/v1/local-directories")) {
    throw new Error(
      "Embedded Runtime Web UI has no local directory browser client."
    );
  }
  for (const marker of [
    "__TAURI__",
    "daemon_request",
    "pick_project_folder",
    "desktop_runtime_"
  ]) {
    if (source.includes(marker)) {
      throw new Error(
        `Embedded Runtime Web UI still contains obsolete Desktop bridge marker: ${marker}`
      );
    }
  }
}

async function verifyBrowserManagementFlow(port, projectPath) {
  const origin = `http://127.0.0.1:${port}`;
  const headers = { origin, "sec-fetch-site": "same-origin" };
  const state = await fetchJson(`${origin}/api/v1/management/state`, {
    headers
  });
  if (!state.config?.effective)
    throw new Error(
      "Local management state is unavailable from Browser origin."
    );
  const directories = await fetchJson(
    `${origin}/api/v1/local-directories?scope=allowed`,
    { headers }
  );
  const exposedRoot = await findSameDirectory(
    directories.roots?.map((root) => root.path),
    projectPath
  );
  if (!exposedRoot) {
    throw new Error(
      `Runtime directory browser did not expose the configured allowed root. expected=${projectPath} roots=${JSON.stringify(directories.roots?.map((root) => root.path) ?? [])}`
    );
  }
  const projects = await fetchJson(`${origin}/api/v1/projects`, { headers });
  if (!Array.isArray(projects.projects))
    throw new Error("Project list is not available from Browser origin.");
  const opened = await fetchJson(`${origin}/api/v1/projects/open`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ path: projectPath })
  });
  const openedProjectMatches =
    typeof opened.project?.root === "string" &&
    (await sameDirectory(opened.project.root, projectPath).catch(() => false));
  if (!opened.project?.id || !openedProjectMatches) {
    throw new Error(
      `Browser-origin Project open did not return the selected canonical Project. expected=${projectPath} actual=${opened.project?.root ?? "missing"}`
    );
  }
  const processes = await fetchJson(
    `${origin}/api/v1/processes?projectId=${encodeURIComponent(opened.project.id)}&maxResults=20`,
    { headers }
  );
  if (!Array.isArray(processes.processes)) {
    throw new Error("Process list is not available from Browser origin.");
  }
  const activity = await fetchJson(
    `${origin}/api/v1/activity?projectId=${encodeURIComponent(opened.project.id)}&limit=20`,
    { headers }
  );
  if (!Array.isArray(activity.records)) {
    throw new Error("Activity list is not available from Browser origin.");
  }
}

async function findSameDirectory(paths, expected) {
  if (!Array.isArray(paths)) return undefined;
  for (const path of paths) {
    if (typeof path !== "string") continue;
    if (await sameDirectory(path, expected).catch(() => false)) return path;
  }
  return undefined;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url} returned HTTP ${response.status}: ${await response.text()}`
    );
  }
  return response.json();
}

function verifyWindowsGuiSubsystem(bytes) {
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("Desktop executable is not a valid PE file.");
  }
  const optionalHeader = peOffset + 24;
  const subsystem = bytes.readUInt16LE(optionalHeader + 68);
  if (subsystem !== 2) {
    throw new Error(
      `Windows Desktop PE subsystem must be GUI (2), got ${subsystem}.`
    );
  }
}

async function writeProductionConfig(home, port, allowedRoot) {
  const stateRoot = join(home, ".nexum");
  await mkdir(stateRoot, { recursive: true });
  const root = allowedRoot.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  await writeFile(
    join(stateRoot, "config.toml"),
    `[daemon]\nhost = "127.0.0.1"\nport = ${port}\n\n[auth]\nmode = "off"\n\n[openai_tunnel]\nenabled = false\n\n[projects]\nallowed_roots = ["${root}"]\n\n[logging]\nlevel = "warn"\n`,
    "utf8"
  );
}

async function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate loopback port."));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port)
      );
    });
  });
}

async function waitForHealth(port, child, timeout) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(
        `Desktop launcher exited before Runtime became ready: ${child.exitCode}`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.service === "nexum" && health.status === "ready")
          return health;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(
    `Timed out waiting for embedded Desktop Runtime: ${lastError instanceof Error ? lastError.message : "not ready"}`
  );
}

async function waitForUiLoadedMarker(port, readOutput, child, timeout) {
  const marker = `[nexum] Desktop UI loaded: http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const output = await readOutput();
    if (`${output.stdout}\n${output.stderr}`.includes(marker)) return;
    if (child.exitCode !== null) {
      throw new Error(
        `Electron Desktop exited before Renderer loaded Runtime UI: ${child.exitCode}`
      );
    }
    await sleep(150);
  }
  throw new Error(
    `Electron Renderer never loaded Runtime UI: ${JSON.stringify(await readOutput())}`
  );
}

function captureProcessOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on(
    "data",
    (chunk) => (stdout = `${stdout}${chunk}`.slice(-8192))
  );
  child.stderr?.on(
    "data",
    (chunk) => (stderr = `${stderr}${chunk}`.slice(-8192))
  );
  return () => ({ stdout: stdout.trim(), stderr: stderr.trim() });
}

async function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8"
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited.
      }
    }
    await sleep(500);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }
}

function disposeChildProcess(child) {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  child.unref();
}

async function findFile(root, name, depth) {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return join(root, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function requireSuccess(result, action) {
  if (result.status !== 0) {
    throw new Error(
      `${action} failed: ${result.stderr || result.stdout || `status ${result.status}`}`
    );
  }
}
