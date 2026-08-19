import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { DesktopProfile } from "./profile.js";
import { parseConfiguredDaemonPort, profileDefaults } from "./profile.js";

type ProbeResult =
  | { readonly state: "ready" }
  | { readonly state: "absent" }
  | { readonly state: "foreign"; readonly reason: string };

export type RuntimeOwnership = "desktop" | "external" | "none";

export class RuntimeSupervisor extends EventEmitter {
  readonly #profile: DesktopProfile;
  readonly #resourcesRoot: string;
  #child: ChildProcess | undefined;
  #origin = "";
  #ownership: RuntimeOwnership = "none";
  #stopping = false;
  #restartCount = 0;

  constructor(input: {
    readonly profile: DesktopProfile;
    readonly resourcesRoot: string;
  }) {
    super();
    this.#profile = input.profile;
    this.#resourcesRoot = input.resourcesRoot;
  }

  get origin(): string {
    return this.#origin;
  }

  get ownership(): RuntimeOwnership {
    return this.#ownership;
  }

  async ensureReady(): Promise<string> {
    const defaults = profileDefaults(this.#profile);
    const configSource = await readFile(
      join(defaults.stateRoot, "config.toml"),
      "utf8"
    ).catch(() => "");
    const port = parseConfiguredDaemonPort(configSource, defaults.daemonPort);
    this.#origin = `http://127.0.0.1:${port}`;

    const existing = await probeNexum(this.#origin);
    if (existing.state === "ready") {
      this.#ownership = "external";
      this.emit("ready", this.#origin);
      return this.#origin;
    }
    if (existing.state === "foreign") {
      throw new Error(existing.reason);
    }

    await this.#startOwnedRuntime();
    return this.#origin;
  }

  async stopOwned(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await waitForExit(child, 4_000).catch(() => {
      child.kill("SIGKILL");
    });
    await waitForExit(child, 1_000).catch(() => undefined);
    this.#ownership = "none";
  }

  async #startOwnedRuntime(): Promise<void> {
    const runtimeRoot = join(this.#resourcesRoot, "runtime");
    const nodePath = join(
      this.#resourcesRoot,
      "node",
      process.platform === "win32" ? "node.exe" : "node"
    );
    const entrypoint = join(runtimeRoot, "dist", "main.js");
    await Promise.all([access(nodePath), access(entrypoint)]);
    this.#stopping = false;
    const child = spawn(
      nodePath,
      [entrypoint, "--profile", this.#profile, "start"],
      {
        cwd: runtimeRoot,
        env: scrubRuntimeEnvironment(process.env),
        stdio:
          process.env.NEXUM_DESKTOP_DIAGNOSTICS === "1" ? "inherit" : "ignore",
        windowsHide: true
      }
    );
    this.#child = child;
    this.#ownership = "desktop";
    child.once("exit", () => {
      if (this.#child === child) this.#child = undefined;
      if (!this.#stopping) void this.#recoverFromUnexpectedExit();
    });
    child.once("error", (error) => this.emit("error", error));
    await waitForRuntimeReady(this.#origin, child, 45_000);
    this.#restartCount = 0;
    this.emit("ready", this.#origin);
  }

  async #recoverFromUnexpectedExit(): Promise<void> {
    if (this.#restartCount >= 2) {
      this.#ownership = "none";
      this.emit("error", new Error("Embedded Runtime stopped unexpectedly."));
      return;
    }
    this.#restartCount += 1;
    await delay(this.#restartCount * 750);
    if (this.#stopping) return;
    try {
      await this.#startOwnedRuntime();
    } catch (error) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

async function probeNexum(origin: string): Promise<ProbeResult> {
  try {
    const response = await timedFetch(`${origin}/api/v1/health`, 900);
    if (!response.ok) {
      return {
        state: "foreign",
        reason: `Configured endpoint returned HTTP ${response.status}.`
      };
    }
    const health = (await response.json()) as Record<string, unknown>;
    if (health.service !== "nexum" || health.status !== "ready") {
      return {
        state: "foreign",
        reason: "Configured endpoint is not a ready Nexum Runtime."
      };
    }
    const ui = await timedFetch(`${origin}/`, 900);
    if (!ui.ok || !ui.headers.get("content-type")?.includes("text/html")) {
      return {
        state: "foreign",
        reason: "Nexum endpoint does not provide its Local UI."
      };
    }
    return { state: "ready" };
  } catch {
    return { state: "absent" };
  }
}

export function scrubRuntimeEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "PATH",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL"
  ];
  return Object.fromEntries(
    allowed.flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]]
    )
  );
}

async function waitForRuntimeReady(
  origin: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Embedded Runtime exited before becoming ready.");
    }
    const probe = await probeNexum(origin);
    if (probe.state === "ready") return;
    if (probe.state === "foreign") throw new Error(probe.reason);
    await delay(200);
  }
  throw new Error(
    "Embedded Runtime did not become ready before the startup timeout."
  );
}

async function timedFetch(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Process exit timed out."));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
