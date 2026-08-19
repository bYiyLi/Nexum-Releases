import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateTrayWindowPosition,
  parseTrayShellAction
} from "./tray-controller.js";

test("tray popup stays inside the display work area", () => {
  assert.deepEqual(
    calculateTrayWindowPosition(
      { x: 1350, y: 0, width: 24, height: 24 },
      { x: 0, y: 24, width: 1440, height: 876 },
      { width: 360, height: 420 }
    ),
    { x: 1074, y: 32 }
  );
  assert.deepEqual(
    calculateTrayWindowPosition(
      { x: 1850, y: 1040, width: 24, height: 24 },
      { x: 0, y: 0, width: 1920, height: 1040 },
      { width: 360, height: 420 }
    ),
    { x: 1554, y: 612 }
  );
});

test("tray shell navigation accepts only explicit shell actions", () => {
  assert.equal(parseTrayShellAction("nexum-shell://open-main"), "open-main");
  assert.equal(parseTrayShellAction("nexum-shell://quit"), "quit");
  assert.equal(parseTrayShellAction("nexum-shell://anything-else"), undefined);
  assert.equal(parseTrayShellAction("https://example.com"), undefined);
});
