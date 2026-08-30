import assert from "node:assert/strict";
import { test } from "node:test";
import { validateReleaseTag, verifyRelease } from "./verify-release.mjs";

test("accepts the package version as a v-prefixed release tag", () => {
  assert.doesNotThrow(() => validateReleaseTag("v0.1.0", "0.1.0"));
});

test("rejects a mismatched release tag before checking the registry", async () => {
  let registryChecked = false;

  await assert.rejects(
    verifyRelease("v0.1.0", {
      versionExists: async () => {
        registryChecked = true;
        return false;
      },
    }),
    /Release tag must be v0\.2\.1/,
  );
  assert.equal(registryChecked, false);
});

test("rejects an already published package version", async () => {
  await assert.rejects(
    verifyRelease("v0.2.1", { versionExists: async () => true }),
    /aiongside@0\.2\.1 is already published/,
  );
});
