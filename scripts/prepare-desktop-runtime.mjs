import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const artifact = resolve(
  args.artifact ??
    join(repoRoot, "dist", "release", "runtime", "nexum-runtime.tgz")
);
const manifestPath = resolve(
  args.manifest ??
    join(repoRoot, "dist", "release", "runtime", "runtime-manifest.json")
);
const checksumsPath = resolve(
  args.checksums ??
    join(repoRoot, "dist", "release", "runtime", "SHA256SUMS.txt")
);
const output = resolve(
  args.output ?? join(repoRoot, "apps", "desktop", "resources", "runtime")
);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest?.schemaVersion !== 2 ||
  manifest?.current?.assetName !== "nexum-runtime.tgz" ||
  typeof manifest?.current?.sha256 !== "string"
) {
  throw new Error("Unsupported Runtime manifest for Desktop embedding.");
}

const digest = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
if (digest !== manifest.current.sha256) {
  throw new Error(
    `Desktop Runtime SHA-256 mismatch: expected ${manifest.current.sha256}, got ${digest}.`
  );
}
const checksums = await readFile(checksumsPath, "utf8");
if (!checksums.includes(`${digest}  ${basename(artifact)}`)) {
  throw new Error("Desktop Runtime checksum file does not match the artifact.");
}

const artifactDirectory = dirname(artifact);
const extractionRoot = await mkdtemp(
  join(artifactDirectory, ".nexum-desktop-runtime-")
);
try {
  const extraction = spawnSync(
    "tar",
    ["-xzf", basename(artifact), "-C", basename(extractionRoot)],
    { cwd: artifactDirectory, encoding: "utf8" }
  );
  if (extraction.status !== 0) {
    throw new Error(
      `Failed to extract Desktop Runtime: ${extraction.stderr || extraction.stdout || `status ${extraction.status}`}`
    );
  }

  const packageRoot = join(extractionRoot, "package");
  for (const relative of [
    "dist/main.js",
    "web/index.html",
    "nexum-runtime.json",
    "package.json"
  ]) {
    const metadata = await stat(join(packageRoot, relative)).catch(
      () => undefined
    );
    if (!metadata?.isFile()) {
      throw new Error(`Embedded Runtime source is missing ${relative}.`);
    }
  }

  await rm(output, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
  await mkdir(output, { recursive: true });
  await cp(packageRoot, output, { recursive: true });
  await writeFile(
    join(output, "embedded-runtime.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        artifactName: "nexum-runtime.tgz",
        sha256: digest
      },
      null,
      2
    )}\n`,
    "utf8"
  );
} finally {
  await rm(extractionRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
}

console.log(`Prepared embedded Desktop Runtime: ${output} sha256=${digest}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: prepare-desktop-runtime.mjs [--artifact <tgz>] [--manifest <json>] [--checksums <txt>] [--output <dir>]"
      );
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}
