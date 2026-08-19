import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  desktopUserDataRoot,
  parseConfiguredDaemonPort,
  resolveDesktopProfile
} from "./profile.js";

test("desktop profile defaults development source runs away from production", () => {
  assert.equal(resolveDesktopProfile({ isPackaged: false }), "development");
  assert.equal(resolveDesktopProfile({ isPackaged: true }), "production");
  assert.equal(
    resolveDesktopProfile({
      isPackaged: true,
      environmentProfile: "development"
    }),
    "development"
  );
});

test("desktop shell state stays inside the selected Nexum profile root", () => {
  assert.equal(
    desktopUserDataRoot("production"),
    join(homedir(), ".nexum", "desktop")
  );
  assert.equal(
    desktopUserDataRoot("development"),
    join(homedir(), ".nexum-dev", "desktop")
  );
});

test("daemon port parser reads only the daemon section and fails to default", () => {
  assert.equal(
    parseConfiguredDaemonPort(
      '[daemon]\nhost = "127.0.0.1"\nport = 43123\n\n[other]\nport = 1\n',
      38400
    ),
    43123
  );
  assert.equal(
    parseConfiguredDaemonPort("[daemon]\nport = 99999\n", 38400),
    38400
  );
  assert.equal(parseConfiguredDaemonPort("[auth]\nport = 5\n", 38400), 38400);
});
