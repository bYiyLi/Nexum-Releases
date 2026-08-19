import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const root = join(repoRoot, "apps", "desktop", "resources", "node");
const nodeTarget = join(
  root,
  process.platform === "win32" ? "node.exe" : "node"
);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await cp(process.execPath, nodeTarget);
if (process.platform !== "win32") await chmod(nodeTarget, 0o755);
console.log(`Prepared Desktop standalone Node: ${nodeTarget}`);
