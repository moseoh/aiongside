import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const bin = path.resolve(import.meta.dirname, "../dist/bin.js");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aiongside-cli-"));
  roots.push(root);
  return root;
}

async function cli(args: string[]) {
  return execFileAsync(process.execPath, [bin, ...args], { encoding: "utf8" });
}

describe("CLI", () => {
  test("runs initialization, creation, movement, and validation", async () => {
    const root = await tempRoot();

    const initialized = await cli(["init", root, "--name", "Workspace"]);
    const created = await cli(["--root", root, "work", "new", "First Work"]);
    const moved = await cli([
      "--root",
      root,
      "work",
      "move",
      "AIO-001",
      "active",
    ]);
    const checked = await cli(["--root", root, "check"]);

    expect(initialized.stdout).toContain("Initialized");
    expect(created.stdout).toContain("AIO-001 First Work");
    expect(moved.stdout).toContain("AIO-001 -> active");
    expect(checked.stdout).toBe("Check passed\n");
  });

  test("does not discard without a dry run", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Discard candidate"]);

    await expect(
      cli(["--root", root, "work", "discard", "AIO-001"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-DISCARD-DRY-RUN"),
    });

    const preview = await cli([
      "--root",
      root,
      "work",
      "discard",
      "AIO-001",
      "--dry-run",
    ]);
    expect(preview.stdout).toContain("No changes made");
  });
});
