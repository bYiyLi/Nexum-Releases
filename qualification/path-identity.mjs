import { realpath, stat } from "node:fs/promises";

export async function canonicalDirectory(path) {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new Error(`Expected directory path, got: ${path}`);
  }
  return canonical;
}

export async function sameDirectory(left, right) {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalDirectory(left),
    canonicalDirectory(right)
  ]);
  return comparablePath(canonicalLeft) === comparablePath(canonicalRight);
}

function comparablePath(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
