import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const adhoc = process.argv.includes("--adhoc");
const dmgArgumentIndex = process.argv.indexOf("--dmg");
const dmgArgument =
  dmgArgumentIndex >= 0 ? process.argv[dmgArgumentIndex + 1] : undefined;
if (dmgArgumentIndex >= 0 && !dmgArgument) {
  throw new Error("--dmg requires a path.");
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("macOS DMG verification requires darwin-arm64.");
}

const repoRoot = resolve(import.meta.dirname, "..");
const dmgPath = resolve(
  dmgArgument ??
    join(repoRoot, "apps", "desktop", "out", "Nexum-0.1.0-arm64.dmg")
);
const mountRoot = await mkdtemp(join(tmpdir(), "nexum-dmg-verify-"));
let mounted = false;

try {
  const dmg = await stat(dmgPath).catch(() => undefined);
  if (!dmg?.isFile() || dmg.size === 0) {
    throw new Error(`macOS DMG is missing or empty: ${dmgPath}`);
  }

  requireSuccess(
    spawnSync(
      "hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mountRoot, dmgPath],
      { encoding: "utf8" }
    ),
    "mount macOS DMG"
  );
  mounted = true;

  const appPath = join(mountRoot, "Nexum.app");
  const applicationsPath = join(mountRoot, "Applications");
  if (!(await stat(appPath).catch(() => undefined))?.isDirectory()) {
    throw new Error("Mounted DMG does not contain Nexum.app.");
  }
  const applicationsTarget = await realpath(applicationsPath);
  if (applicationsTarget !== "/Applications") {
    throw new Error(
      `Mounted DMG Applications link resolves to ${applicationsTarget}, not /Applications.`
    );
  }

  if (adhoc) {
    requireSuccess(
      spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], {
        encoding: "utf8"
      }),
      "verify ad-hoc app bundle seal"
    );
    const details = spawnSync(
      "codesign",
      ["--display", "--verbose=4", appPath],
      {
        encoding: "utf8"
      }
    );
    requireSuccess(details, "inspect ad-hoc app bundle seal");
    if (!`${details.stdout}\n${details.stderr}`.includes("Signature=adhoc")) {
      throw new Error("Expected ad-hoc macOS signature for test distribution.");
    }
  } else {
    requireSuccess(
      spawnSync(
        "codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", appPath],
        { encoding: "utf8" }
      ),
      "verify Developer ID code signature"
    );
    const signatureDetails = spawnSync(
      "codesign",
      ["--display", "--verbose=4", appPath],
      { encoding: "utf8" }
    );
    requireSuccess(signatureDetails, "inspect Developer ID signature");
    const signatureOutput = `${signatureDetails.stdout}\n${signatureDetails.stderr}`;
    if (!/Authority=Developer ID Application:/u.test(signatureOutput)) {
      throw new Error(
        "Nexum.app is signed, but not with a Developer ID Application identity."
      );
    }
    requireSuccess(
      spawnSync(
        "spctl",
        [
          "--assess",
          "--type",
          "open",
          "--context",
          "context:primary-signature",
          dmgPath
        ],
        {
          encoding: "utf8"
        }
      ),
      "assess notarized DMG with Gatekeeper"
    );
    const staple = spawnSync("xcrun", ["stapler", "validate", dmgPath], {
      encoding: "utf8"
    });
    requireSuccess(staple, "validate notarization staple");
  }

  console.log(
    adhoc
      ? `Verified ad-hoc sealed, unnotarized macOS installer candidate: ${dmgPath}`
      : `Verified signed and notarized macOS installer: ${dmgPath}`
  );
} finally {
  if (mounted) {
    spawnSync("hdiutil", ["detach", mountRoot, "-force"], { encoding: "utf8" });
  }
  await rm(mountRoot, { recursive: true, force: true });
}

function requireSuccess(result, operation) {
  if (result.status !== 0) {
    throw new Error(
      `Failed to ${operation}: ${result.stderr || result.stdout || `status ${result.status}`}`
    );
  }
}
