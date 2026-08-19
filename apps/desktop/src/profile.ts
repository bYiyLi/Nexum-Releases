import { homedir } from "node:os";
import { join } from "node:path";

export type DesktopProfile = "production" | "development";

export function resolveDesktopProfile(input: {
  readonly isPackaged: boolean;
  readonly environmentProfile?: string;
}): DesktopProfile {
  if (input.environmentProfile === "production") return "production";
  if (input.environmentProfile === "development") return "development";
  return input.isPackaged ? "production" : "development";
}

export function profileDefaults(profile: DesktopProfile): {
  readonly appName: string;
  readonly appUserModelId: string;
  readonly stateRoot: string;
  readonly daemonPort: number;
} {
  if (profile === "development") {
    return {
      appName: "Nexum Dev",
      appUserModelId: "com.nexum.desktop.dev",
      stateRoot: join(homedir(), ".nexum-dev"),
      daemonPort: 38401
    };
  }
  return {
    appName: "Nexum",
    appUserModelId: "com.nexum.desktop",
    stateRoot: join(homedir(), ".nexum"),
    daemonPort: 38400
  };
}

export function desktopUserDataRoot(profile: DesktopProfile): string {
  return join(profileDefaults(profile).stateRoot, "desktop");
}

export function parseConfiguredDaemonPort(
  source: string,
  fallbackPort: number
): number {
  const daemonSection = source.match(
    /(?:^|\n)\s*\[daemon\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/u
  )?.[1];
  const rawPort = daemonSection?.match(
    /(?:^|\n)\s*port\s*=\s*(\d+)\s*(?:#.*)?(?:\n|$)/u
  )?.[1];
  const port = rawPort ? Number(rawPort) : fallbackPort;
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : fallbackPort;
}
