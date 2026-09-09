import assert from "node:assert/strict";
import { test } from "node:test";
import { readSourceManifest } from "./package-lib.mjs";
import { validateReleaseTag, verifyRelease } from "./verify-release.mjs";

async function manifestAt(version) {
  return { ...(await readSourceManifest()), version };
}

test("accepts the package version as a v-prefixed release tag", () => {
  assert.doesNotThrow(() => validateReleaseTag("v0.1.0", "0.1.0"));
});

test("rejects a mismatched release tag before checking the registry", async () => {
  let registryChecked = false;
  const manifest = await manifestAt("1.2.3");

  await assert.rejects(
    verifyRelease("v0.1.0", {
      readManifest: async () => manifest,
      versionExists: async () => {
        registryChecked = true;
        return false;
      },
    }),
    /Release tag must be v1\.2\.3/,
  );
  assert.equal(registryChecked, false);
});

test("rejects an already published package version", async () => {
  const manifest = await manifestAt("1.2.3");

  await assert.rejects(
    verifyRelease("v1.2.3", {
      readManifest: async () => manifest,
      versionExists: async () => true,
    }),
    /aiongside@1\.2\.3 is already published/,
  );
});
