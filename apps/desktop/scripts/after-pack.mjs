import { cp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export default async function stageUniversalRuntime(context) {
  const source = resolve(import.meta.dirname, "..", "resources", "runtime");
  const sourceMetadata = await stat(source).catch(() => undefined);
  if (!sourceMetadata?.isDirectory()) {
    throw new Error(`Staged Universal Runtime is missing: ${source}`);
  }

  const resourcesRoot =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources"
        )
      : join(context.appOutDir, "resources");
  const destination = join(resourcesRoot, "runtime");

  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    preserveTimestamps: true
  });
}
