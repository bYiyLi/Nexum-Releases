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

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const installer = args.get("--installer");
const expectedRuntimeSha = args.get("--runtime-sha");
if (!installer || !expectedRuntimeSha) {
  throw new Error(
    "Usage: node desktop-qualification.mjs --installer <dmg-or-exe> --runtime-sha <sha256>"
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
} else {
  throw new Error(
    `Unsupported Desktop qualification platform: ${process.platform}/${process.arch}`
  );
}

console.log(
  `Verified embedded-runtime Desktop installer: ${basename(installerPath)}`
);

async function qualifyMacosDmg(path, runtimeSha) {
  requireSuccess(
    spawnSync("hdiutil", ["verify", path], { encoding: "utf8" }),
    "DMG verify"
  );
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "nexum-desktop-dmg-")
  );
  const mount = join(root, "mount");
  let mounted = false;
  try {
    await mkdir(mount);
    requireSuccess(
      spawnSync(
        "hdiutil",
        ["attach", path, "-readonly", "-nobrowse", "-mountpoint", mount],
        {
          encoding: "utf8"
        }
      ),
      "DMG attach"
    );
    mounted = true;
    const app = join(mount, "Nexum.app");
    const executable = await findMacosExecutable(
      join(app, "Contents", "MacOS")
    );
    if (!executable) throw new Error("Nexum.app has no executable payload.");
    const resources = join(app, "Contents", "Resources");
    await access(executable, fsConstants.X_OK);
    await access(join(resources, "bootstrap", "node"), fsConstants.X_OK);
    await verifyEmbeddedRuntime(resources, runtimeSha);
    requireSuccess(
      spawnSync("codesign", ["--verify", "--deep", "--strict", app], {
        encoding: "utf8"
      }),
      "macOS bundle seal verification"
    );
    await qualifyMacosLaunch(app, executable);
  } finally {
    if (mounted) {
      requireSuccess(
        spawnSync("hdiutil", ["detach", mount, "-force"], { encoding: "utf8" }),
        "DMG detach"
      );
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function qualifyMacosLaunch(app, executable) {
  const home = await mkdtemp(
    join(await realpath(tmpdir()), "nexum-desktop-home-")
  );
  const port = await reserveLoopbackPort();
  await writeProductionConfig(home, port);
  const child = spawn(
    "open",
    ["-n", "-W", app, "--env", `HOME=${home}`, "--env", `USERPROFILE=${home}`],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const output = captureProcessOutput(child);
  try {
    await waitForHealth(port, child, 30_000);
    const processProbe = spawnSync("pgrep", ["-f", executable], {
      encoding: "utf8"
    });
    if (processProbe.status !== 0) {
      throw new Error(
        `Normal macOS app launch did not leave Nexum running: ${JSON.stringify(output())}`
      );
    }
  } finally {
    spawnSync("pkill", ["-TERM", "-f", executable], { encoding: "utf8" });
    await sleep(500);
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
}

async function qualifyWindowsInstaller(path, runtimeSha) {
  const home = await mkdtemp(join(tmpdir(), "nexum-desktop-home-"));
  const localAppData = join(home, "AppData", "Local");
  await mkdir(localAppData, { recursive: true });
  const installEnv = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    USERPROFILE: home,
    HOME: home,
    NEXUM_DESKTOP_DIAGNOSTICS: "1"
  };
  requireSuccess(
    spawnSync(path, ["/S"], { encoding: "utf8", env: installEnv }),
    "silent NSIS installation"
  );
  const installRoot = join(localAppData, "Nexum");
  const executable = join(installRoot, "nexum-desktop.exe");
  await access(executable, fsConstants.X_OK);
  verifyWindowsGuiSubsystem(await readFile(executable));
  const bundledNode = join(installRoot, "bootstrap", "node.exe");
  await access(bundledNode, fsConstants.X_OK);
  requireSuccess(
    spawnSync(bundledNode, ["--version"], {
      encoding: "utf8",
      env: installEnv,
      windowsHide: true
    }),
    "bundled Desktop Node bootstrap"
  );
  await verifyEmbeddedRuntime(installRoot, runtimeSha);
  await qualifyWindowsEmbeddedRuntimeDirectly(installRoot, installEnv);
  const port = await reserveLoopbackPort();
  await writeProductionConfig(home, port);
  const child = spawn(executable, [], {
    env: installEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = captureProcessOutput(child);
  try {
    try {
      await waitForHealth(port, child, 60_000);
    } catch (error) {
      const diagnostics = collectWindowsDiagnostics(child.pid, installEnv);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; Desktop output: ${JSON.stringify(output())}; Windows diagnostics: ${JSON.stringify(diagnostics)}`,
        { cause: error }
      );
    }
    const processProbe = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${child.pid}).MainWindowHandle.ToInt64()`
      ],
      { encoding: "utf8", env: installEnv }
    );
    requireSuccess(processProbe, "inspect Desktop main window");
    if (Number(processProbe.stdout.trim()) === 0) {
      throw new Error(
        `Windows Desktop did not create a GUI window: ${JSON.stringify(output())}`
      );
    }
  } finally {
    await terminateProcessTree(child.pid);
    const uninstaller = await findFile(installRoot, "uninstall.exe", 2);
    if (uninstaller) {
      spawnSync(uninstaller, ["/S"], { encoding: "utf8", env: installEnv });
    }
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200
    });
  }
}

async function qualifyWindowsEmbeddedRuntimeDirectly(installRoot, installEnv) {
  const home = await mkdtemp(join(tmpdir(), "nexum-desktop-runtime-home-"));
  const port = await reserveLoopbackPort();
  await writeProductionConfig(home, port);
  const env = {
    ...installEnv,
    HOME: home,
    USERPROFILE: home
  };
  const child = spawn(
    join(installRoot, "bootstrap", "node.exe"),
    [
      join(installRoot, "runtime", "dist", "main.js"),
      "--profile",
      "production",
      "start"
    ],
    {
      cwd: join(installRoot, "runtime"),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const output = captureProcessOutput(child);
  try {
    await waitForHealth(port, child, 30_000);
  } catch (error) {
    throw new Error(
      `Installed embedded Runtime could not start directly: ${error instanceof Error ? error.message : String(error)}; output=${JSON.stringify(output())}`,
      { cause: error }
    );
  } finally {
    await terminateProcessTree(child.pid);
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200
    });
  }
}

function collectWindowsDiagnostics(pid, env) {
  const processProbe = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$root=${pid}; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $root -or $_.ParentProcessId -eq $root -or $_.CommandLine -like '*runtime\\dist\\main.js*' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`
    ],
    { encoding: "utf8", env }
  );
  const listenerProbe = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress"
    ],
    { encoding: "utf8", env }
  );
  return {
    processes: processProbe.stdout.trim(),
    processProbeError: processProbe.stderr.trim(),
    listeners: listenerProbe.stdout.trim(),
    listenerProbeError: listenerProbe.stderr.trim()
  };
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

async function writeProductionConfig(home, port) {
  const stateRoot = join(home, ".nexum");
  await mkdir(stateRoot, { recursive: true });
  const allowedRoot = home.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  await writeFile(
    join(stateRoot, "config.toml"),
    `[daemon]\nhost = "127.0.0.1"\nport = ${port}\n\n[auth]\nmode = "off"\n\n[openai_tunnel]\nenabled = false\n\n[projects]\nallowed_roots = ["${allowedRoot}"]\n\n[logging]\nlevel = "warn"\n`,
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

function captureProcessOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on(
    "data",
    (chunk) => (stdout = `${stdout}${chunk}`.slice(-4096))
  );
  child.stderr?.on(
    "data",
    (chunk) => (stderr = `${stderr}${chunk}`.slice(-4096))
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
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }
}

async function findMacosExecutable(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(root, entry.name);
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {
      // Continue scanning.
    }
  }
  return undefined;
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
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase())
      return path;
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
