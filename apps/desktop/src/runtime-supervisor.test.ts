import assert from "node:assert/strict";
import test from "node:test";
import { scrubRuntimeEnvironment } from "./runtime-supervisor.js";

test("Desktop Runtime child environment drops arbitrary parent credentials", () => {
  const scrubbed = scrubRuntimeEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    OPENAI_API_KEY: "secret",
    NEXUM_RELEASE_TOKEN: "secret"
  });
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.HOME, "/tmp/home");
  assert.equal(scrubbed.OPENAI_API_KEY, undefined);
  assert.equal(scrubbed.NEXUM_RELEASE_TOKEN, undefined);
});
