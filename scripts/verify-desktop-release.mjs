import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    `Desktop release verification currently supports darwin-arm64, not ${process.platform}-${process.arch}`
  );
}

const appRoot = join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "Nexum.app"
);
const resourcesRoot = join(appRoot, "Contents", "Resources");
const nodePath = join(resourcesRoot, "bootstrap", "node");
const runtimeRoot = join(resourcesRoot, "runtime");

await requireExecutable(join(appRoot, "Contents", "MacOS", "nexum-desktop"));
await requireExecutable(nodePath);
for (const relative of [
  "dist/main.js",
  "web/index.html",
  "nexum-runtime.json",
  "embedded-runtime.json"
]) {
  await requireRegularFile(join(runtimeRoot, relative));
}

console.log("Verified Desktop: darwin-arm64 Node bootstrap + embedded Runtime");

async function requireRegularFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Expected regular file: ${path}`);
}

async function requireExecutable(path) {
  await requireRegularFile(path);
  await access(path, constants.X_OK);
}
