import assert from "node:assert/strict";
import test from "node:test";
import { parseWindowBounds } from "./window-state.js";

test("window bounds retain valid state and reject pathological persisted values", () => {
  assert.deepEqual(
    parseWindowBounds({ x: 120, y: 80, width: 1280, height: 800 }),
    {
      x: 120,
      y: 80,
      width: 1280,
      height: 800
    }
  );
  assert.deepEqual(parseWindowBounds({ x: "no", width: 1, height: -1 }), {
    x: 0,
    y: 0,
    width: 1180,
    height: 760
  });
});
