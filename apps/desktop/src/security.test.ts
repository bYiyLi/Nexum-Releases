import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedNavigation } from "./security.js";

test("renderer navigation is restricted to bootstrap files and exact Runtime origin", () => {
  const bootstrap = "file:///app/assets/bootstrap.html";
  assert.equal(
    isAllowedNavigation(`${bootstrap}?message=Starting`, "", bootstrap),
    true
  );
  assert.equal(isAllowedNavigation("file:///etc/passwd", "", bootstrap), false);
  assert.equal(
    isAllowedNavigation(
      "http://127.0.0.1:38400/projects",
      "http://127.0.0.1:38400",
      bootstrap
    ),
    true
  );
  assert.equal(
    isAllowedNavigation(
      "http://127.0.0.1:38401/",
      "http://127.0.0.1:38400",
      bootstrap
    ),
    false
  );
  assert.equal(
    isAllowedNavigation(
      "https://example.com/",
      "http://127.0.0.1:38400",
      bootstrap
    ),
    false
  );
});
