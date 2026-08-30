import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createConsumerManifest,
  expectedPackageFiles,
  preparePackage,
  readSourceManifest,
  validatePackageDirectory,
  validatePackResult,
  validateSourceManifest,
} from "./package-lib.mjs";

test("creates public package metadata from the CLI manifest", async () => {
  const source = await readSourceManifest();
  validateSourceManifest(source);
  assert.equal(source.version, "0.1.0");

  const consumer = createConsumerManifest(source);
  assert.equal(consumer.name, "aiongside");
  assert.equal(consumer.version, "0.1.0");
  assert.deepEqual(consumer.bin, { aiongside: "./dist/bin.js" });
  assert.deepEqual(consumer.engines, { node: ">=22" });
  assert.deepEqual(consumer.repository, {
    type: "git",
    url: "git+https://github.com/moseoh/aiongside.git",
  });
  assert.equal("devDependencies" in consumer, false);
  assert.equal("scripts" in consumer, false);
  assert.equal(JSON.stringify(consumer).includes("workspace:"), false);
});

test("rejects invalid public package metadata", async () => {
  const source = await readSourceManifest();

  assert.throws(
    () => validateSourceManifest({ ...source, engines: { node: ">=24" } }),
    /engine must be >=22/,
  );
  assert.throws(
    () =>
      validateSourceManifest({
        ...source,
        repository: { type: "git", url: "https://example.com/wrong.git" },
      }),
    /moseoh\/aiongside/,
  );
});

test("prepares only the public package files", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "aiongside-package-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const stageDirectory = path.join(temporaryRoot, "stage");

  await preparePackage({ stageDirectory });
  const result = await validatePackageDirectory(stageDirectory);

  assert.deepEqual(result.files, expectedPackageFiles);
  assert.equal(result.manifest.version, "0.1.0");
  assert.match(
    await readFile(path.join(stageDirectory, "dist", "bin.js"), "utf8"),
    /^#!\/usr\/bin\/env node/,
  );
});

test("rejects unexpected package files and an invalid executable", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "aiongside-package-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const stageDirectory = path.join(temporaryRoot, "stage");
  await preparePackage({ stageDirectory });

  await writeFile(path.join(stageDirectory, "unexpected.txt"), "no\n", "utf8");
  await assert.rejects(
    validatePackageDirectory(stageDirectory),
    /Package files must be exactly/,
  );
  await rm(path.join(stageDirectory, "unexpected.txt"));

  const binPath = path.join(stageDirectory, "dist", "bin.js");
  await chmod(binPath, 0o644);
  await assert.rejects(validatePackageDirectory(stageDirectory), /executable/);
  await chmod(binPath, 0o755);
  await writeFile(binPath, "console.log('invalid');\n", "utf8");
  await assert.rejects(validatePackageDirectory(stageDirectory), /shebang/);
});

test("rejects an unexpected tarball inventory", async () => {
  const source = await readSourceManifest();
  const manifest = createConsumerManifest(source);
  assert.throws(
    () =>
      validatePackResult(
        {
          name: "aiongside",
          version: "0.1.0",
          files: [
            ...expectedPackageFiles.map((file) => ({
              path: file,
              mode: 0o644,
            })),
            { path: "src/index.ts", mode: 0o644 },
          ],
        },
        manifest,
      ),
    /Tarball files must be exactly/,
  );
});
