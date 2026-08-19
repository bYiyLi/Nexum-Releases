import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    `macOS installer packaging currently supports darwin-arm64, not ${process.platform}-${process.arch}`
  );
}

const repoRoot = resolve(import.meta.dirname, "..");
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
const packageJson = JSON.parse(
  await readFile(join(repoRoot, "apps", "desktop", "package.json"), "utf8")
);
const outputRoot = join(repoRoot, "dist", "release", "macos");
const outputPath = join(outputRoot, `Nexum_${packageJson.version}_aarch64.dmg`);
const workRoot = await mkdtemp(join(tmpdir(), "nexum-dmg-package-"));
const sourceRoot = join(workRoot, "root");

try {
  const appInfo = await lstat(appRoot).catch(() => undefined);
  if (!appInfo?.isDirectory()) {
    throw new Error(`Nexum.app is missing: ${appRoot}`);
  }
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(appRoot, join(sourceRoot, basename(appRoot)), {
    recursive: true,
    dereference: false
  });
  requireSuccess(
    spawnSync(
      "codesign",
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--timestamp=none",
        join(sourceRoot, basename(appRoot))
      ],
      { encoding: "utf8" }
    ),
    "apply ad-hoc macOS bundle seal"
  );
  requireSuccess(
    spawnSync(
      "codesign",
      ["--verify", "--deep", "--strict", join(sourceRoot, basename(appRoot))],
      { encoding: "utf8" }
    ),
    "verify ad-hoc macOS bundle seal"
  );

  const linkResult = spawnSync("ln", ["-s", "/Applications", "Applications"], {
    cwd: sourceRoot,
    encoding: "utf8"
  });
  requireSuccess(linkResult, "create Applications link");

  const result = spawnSync(
    "hdiutil",
    [
      "create",
      "-volname",
      "Nexum",
      "-srcfolder",
      sourceRoot,
      "-ov",
      "-format",
      "UDZO",
      outputPath
    ],
    { encoding: "utf8" }
  );
  requireSuccess(result, "create macOS DMG");
  console.log(`Packaged macOS installer candidate: ${outputPath}`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

function requireSuccess(result, operation) {
  if (result.status !== 0) {
    throw new Error(
      `Failed to ${operation}: ${result.stderr || result.stdout || `status ${result.status}`}`
    );
  }
}
