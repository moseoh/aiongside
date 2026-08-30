import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { repositoryRoot } from "./package-lib.mjs";

async function readWorkflow(name) {
  const source = await readFile(
    path.join(repositoryRoot, ".github", "workflows", name),
    "utf8",
  );
  return { source, workflow: parse(source) };
}

function runSteps(job) {
  return job.steps.flatMap((step) =>
    typeof step.run === "string" ? [step.run] : [],
  );
}

function actionStep(job, action) {
  return job.steps.find((step) => step.uses?.startsWith(`${action}@`));
}

test("CI validates the package on Node.js 22 and 24", async () => {
  const { workflow } = await readWorkflow("ci.yml");
  const check = workflow.jobs.check;

  assert.deepEqual(check.strategy.matrix.node, [22, 24]);
  assert.deepEqual(
    runSteps(check).filter((command) => command.startsWith("bun run")),
    ["bun run check", "bun run package:check"],
  );
});

test("publish workflow gates npm publishing behind package and smoke jobs", async () => {
  const { source, workflow } = await readWorkflow("publish.yml");

  assert.deepEqual(Object.keys(workflow.on), ["release"]);
  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["package", "smoke", "publish"]);
  assert.equal(workflow.jobs.smoke.needs, "package");
  assert.deepEqual(workflow.jobs.smoke.strategy.matrix.node, [22, 24]);
  assert.deepEqual(workflow.jobs.publish.needs, ["package", "smoke"]);
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: "read",
    "id-token": "write",
  });

  const packageCommands = runSteps(workflow.jobs.package);
  assert.ok(packageCommands.includes("bun run check"));
  assert.ok(packageCommands.includes("bun run package:pack"));
  assert.ok(
    packageCommands.indexOf(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This is a literal GitHub Actions expression.
      'node scripts/verify-release.mjs "${{ github.event.release.tag_name }}"',
    ) < packageCommands.indexOf("bun run package:pack"),
  );
  assert.deepEqual(runSteps(workflow.jobs.smoke), [
    "node scripts/smoke-package.mjs .artifacts/npm/aiongside-*.tgz",
  ]);
  assert.ok(
    runSteps(workflow.jobs.publish).includes(
      "npm publish .artifacts/npm/aiongside-*.tgz",
    ),
  );

  const upload = actionStep(workflow.jobs.package, "actions/upload-artifact");
  const smokeDownload = actionStep(
    workflow.jobs.smoke,
    "actions/download-artifact",
  );
  const publishDownload = actionStep(
    workflow.jobs.publish,
    "actions/download-artifact",
  );
  assert.equal(upload.with.name, "npm-package");
  assert.equal(upload.with.path, ".artifacts/npm/*.tgz");
  assert.equal(smokeDownload.with.name, "npm-package");
  assert.equal(publishDownload.with.name, "npm-package");
  assert.equal(publishDownload.with.path, ".artifacts/npm");

  const jobsWithOidc = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.["id-token"] === "write")
    .map(([name]) => name);
  assert.deepEqual(jobsWithOidc, ["publish"]);
  assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/);
  assert.doesNotMatch(source, /registry-url:/);
});
