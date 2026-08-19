import { createRequire } from "node:module";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url)
);
const { listPackage } = desktopRequire("@electron/asar");
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const targetPlatform = args.get("--platform") ?? process.platform;
  const targetArch = args.get("--arch") ?? process.arch;
  assertSupportedTarget(targetPlatform, targetArch);

  const appRoot = resolve(
    args.get("--app") ?? defaultAppRoot(targetPlatform, targetArch)
  );
  const resourcesRoot = desktopResourcesRoot(appRoot, targetPlatform);
  const executable = desktopExecutable(appRoot, targetPlatform);
  const nodePath = join(
    resourcesRoot,
    "node",
    targetPlatform === "win32" ? "node.exe" : "node"
  );
  const runtimeRoot = join(resourcesRoot, "runtime");
  const asarPath = join(resourcesRoot, "app.asar");

  await requirePackagedExecutable(executable, targetPlatform);
  await requirePackagedExecutable(nodePath, targetPlatform);
  for (const relative of [
    "dist/main.js",
    "web/index.html",
    "nexum-runtime.json",
    "embedded-runtime.json",
    "node_modules/@nexum/core/package.json",
    "node_modules/@nexum/daemon/package.json"
  ]) {
    await requireRegularFile(join(runtimeRoot, relative));
  }
  await verifyShellAsar(asarPath);
  await verifyRuntimeWebIsBrowserOnly(runtimeRoot);

  console.log(
    `Verified Electron Desktop shell + standalone Node + embedded Runtime: ${appRoot}`
  );
}

export function defaultAppRoot(targetPlatform, targetArch) {
  if (targetPlatform === "darwin" && targetArch === "arm64") {
    return join(repoRoot, "apps", "desktop", "out", "mac-arm64", "Nexum.app");
  }
  if (targetPlatform === "win32" && targetArch === "x64") {
    return join(repoRoot, "apps", "desktop", "out", "win-unpacked");
  }
  if (targetPlatform === "linux" && targetArch === "x64") {
    return join(repoRoot, "apps", "desktop", "out", "linux-unpacked");
  }
  throw new Error(
    `Desktop release verification does not support ${targetPlatform}-${targetArch}`
  );
}

export function desktopResourcesRoot(root, targetPlatform) {
  return targetPlatform === "darwin"
    ? join(root, "Contents", "Resources")
    : join(root, "resources");
}

export function desktopExecutable(root, targetPlatform) {
  if (targetPlatform === "darwin") {
    return join(root, "Contents", "MacOS", "Nexum");
  }
  if (targetPlatform === "win32") {
    return join(root, "Nexum.exe");
  }
  if (targetPlatform === "linux") {
    return join(root, "Nexum");
  }
  throw new Error(`Unsupported Desktop platform: ${targetPlatform}`);
}

async function verifyShellAsar(path) {
  await requireRegularFile(path);
  verifyShellEntries(listPackage(path));
}

export function verifyShellEntries(rawEntries) {
  const entries = rawEntries.map(normalizeAsarEntry);
  const forbidden = entries.filter((entry) =>
    /(?:^|\/)(?:src-tauri|\.runtime|\.bootstrap|resources)(?:\/|$)|\.test\.js$|\.tsx?$|\.map$/u.test(
      entry
    )
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Electron app.asar contains forbidden development/runtime paths: ${forbidden.slice(0, 8).join(", ")}`
    );
  }
  if (!entries.some((entry) => entry === "/dist/main.js")) {
    throw new Error("Electron app.asar is missing dist/main.js.");
  }
  if (!entries.some((entry) => entry === "/icons/icon.png")) {
    throw new Error("Electron app.asar is missing the Nexum application icon.");
  }
}

export function normalizeAsarEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function assertSupportedTarget(targetPlatform, targetArch) {
  if (
    (targetPlatform === "darwin" && targetArch === "arm64") ||
    (targetPlatform === "win32" && targetArch === "x64") ||
    (targetPlatform === "linux" && targetArch === "x64")
  ) {
    return;
  }
  throw new Error(
    `Desktop release verification does not support ${targetPlatform}-${targetArch}`
  );
}

async function verifyRuntimeWebIsBrowserOnly(runtimeRoot) {
  const index = await readFile(join(runtimeRoot, "web", "index.html"), "utf8");
  if (!index.includes("/assets/")) {
    throw new Error(
      "Embedded Runtime web UI has no production asset reference."
    );
  }
  const { readdir } = await import("node:fs/promises");
  const assets = await readdir(join(runtimeRoot, "web", "assets"));
  const scripts = assets.filter((name) => name.endsWith(".js"));
  if (scripts.length === 0)
    throw new Error("Embedded Runtime web UI has no JavaScript assets.");
  const source = (
    await Promise.all(
      scripts.map((name) =>
        readFile(join(runtimeRoot, "web", "assets", name), "utf8")
      )
    )
  ).join("\n");
  for (const forbidden of [
    "__TAURI__",
    "daemon_request",
    "desktop_runtime_restart",
    "desktop_runtime_status",
    "pick_project_folder",
    "show_system_notification",
    "start_main_window_drag",
    "set_desktop_theme"
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(
        `Embedded Runtime Web UI still contains Desktop bridge marker: ${forbidden}`
      );
    }
  }
  if (!source.includes("/api/v1/local-directories")) {
    throw new Error(
      "Embedded Runtime Web UI is missing the Runtime-owned directory browser."
    );
  }
}

async function requireRegularFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Expected regular file: ${path}`);
}

async function requireExecutable(path) {
  await requireRegularFile(path);
  await access(path, constants.X_OK);
}

async function requirePackagedExecutable(path, targetPlatform) {
  if (targetPlatform === "win32") {
    await requireRegularFile(path);
    return;
  }
  await requireExecutable(path);
}
