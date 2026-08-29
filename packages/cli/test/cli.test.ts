import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const confirmed = await cli([
      "--root",
      root,
      "work",
      "confirm",
      "AIO-001",
      "scope",
      "completion",
    ]);
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
    expect(confirmed.stdout).toContain("AIO-001 scope, completion");
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

  test("reports View drift without writing and rebuilds explicitly", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "View drift"]);
    const viewPath = path.join(root, "views", "open.md");
    const modified = `${await readFile(viewPath, "utf8")}Manual edit\n`;
    await writeFile(viewPath, modified);

    await expect(cli(["--root", root, "check"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("[AIO-VIEW-DRIFT] views/open.md"),
    });
    expect(await readFile(viewPath, "utf8")).toBe(modified);

    const rebuilt = await cli(["--root", root, "view", "rebuild"]);
    expect(rebuilt.stdout).toBe("Views rebuilt\n");
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "Check passed\n",
    );
  });
});
