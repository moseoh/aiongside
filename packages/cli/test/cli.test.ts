import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(moved.stdout).toContain("AIO-001 inbox -> active");
    expect(checked.stdout).toBe("Check passed\n");
  });

  test("documents explicit transition options in move help", async () => {
    const help = await cli(["work", "move", "--help"]);

    for (const option of [
      "--dry-run",
      "--json",
      "--reopen-reason",
      "--waiting-reason",
      "--resume-when",
      "--waiting-resolution",
      "--cancellation-reason",
    ]) {
      expect(help.stdout).toContain(option);
    }
  });

  test("documents nested dependency commands", async () => {
    const help = await cli(["work", "needs", "--help"]);
    const addHelp = await cli(["work", "needs", "add", "--help"]);
    const removeHelp = await cli(["work", "needs", "remove", "--help"]);

    expect(help.stdout).toContain("add");
    expect(help.stdout).toContain("remove");
    expect(addHelp.stdout).toContain("<id> <dependency-id>");
    expect(removeHelp.stdout).toContain("<id> <dependency-id>");
  });

  test("adds, removes, and safely repeats dependency commands", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Dependent work"]);
    await cli(["--root", root, "work", "new", "Prerequisite work"]);

    const added = await cli([
      "--root",
      root,
      "work",
      "needs",
      "add",
      "aio-001",
      "aio-002",
    ]);
    expect(added.stdout).toBe("Dependency added: AIO-001 needs AIO-002\n");
    const removed = await cli([
      "--root",
      root,
      "work",
      "needs",
      "remove",
      "AIO-001",
      "AIO-002",
    ]);
    expect(removed.stdout).toBe(
      "Dependency removed: AIO-001 no longer needs AIO-002\n",
    );

    const paths = [
      path.join(root, "work", "AIO-001", "record.md"),
      path.join(root, "views", "open.md"),
      path.join(root, "views", "closed.md"),
    ];
    const beforeNoOp = await Promise.all(
      paths.map((target) => readFile(target, "utf8")),
    );
    const noOp = await cli([
      "--root",
      root,
      "work",
      "needs",
      "remove",
      "AIO-001",
      "AIO-002",
    ]);

    expect(noOp.stdout).toContain("Dependency unchanged");
    expect(noOp.stdout).toContain("No changes made");
    expect(
      await Promise.all(paths.map((target) => readFile(target, "utf8"))),
    ).toEqual(beforeNoOp);
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "Check passed\n",
    );
  });

  test("reports dependency validation failures with exit code 2", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Dependent work"]);
    await cli(["--root", root, "work", "new", "Prerequisite work"]);

    for (const [args, code] of [
      [["AIO-999", "AIO-002"], "AIO-WORK-NOT-FOUND"],
      [["AIO-001", "AIO-999"], "AIO-DEPENDENCY-MISSING"],
      [["AIO-001", "AIO-001"], "AIO-DEPENDENCY-SELF"],
    ] as const) {
      await expect(
        cli(["--root", root, "work", "needs", "add", ...args]),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining(code),
      });
    }

    await cli(["--root", root, "work", "needs", "add", "AIO-001", "AIO-002"]);
    await expect(
      cli(["--root", root, "work", "needs", "add", "AIO-001", "AIO-002"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-DEPENDENCY-DUPLICATE"),
    });
    await expect(
      cli(["--root", root, "work", "needs", "add", "AIO-002", "AIO-001"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-DEPENDENCY-CYCLE"),
    });

    const checks = [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ];
    for (const id of ["AIO-002", "AIO-001"]) {
      await cli(["--root", root, "work", "confirm", id, ...checks]);
      await cli(["--root", root, "work", "move", id, "done"]);
    }
    await expect(
      cli(["--root", root, "work", "needs", "remove", "AIO-001", "AIO-002"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-DONE-SEALED"),
    });
  });

  test("rolls back built CLI dependency changes after a View write failure", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Dependent work"]);
    await cli(["--root", root, "work", "new", "Prerequisite work"]);
    const paths = [
      path.join(root, "work", "AIO-001", "record.md"),
      path.join(root, "views", "open.md"),
      path.join(root, "views", "closed.md"),
    ];
    const before = await Promise.all(
      paths.map((target) => readFile(target, "utf8")),
    );
    const viewsDirectory = path.join(root, "views");

    await chmod(viewsDirectory, 0o555);
    try {
      await expect(
        cli(["--root", root, "work", "needs", "add", "AIO-001", "AIO-002"]),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("AIO-WRITE"),
      });
    } finally {
      await chmod(viewsDirectory, 0o755);
    }

    expect(
      await Promise.all(paths.map((target) => readFile(target, "utf8"))),
    ).toEqual(before);
  });

  test("returns structured dry-run questions without writing", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Wait for review"]);
    const recordPath = path.join(root, "work", "AIO-001", "record.md");
    const before = await readFile(recordPath, "utf8");

    const preview = await cli([
      "--root",
      root,
      "work",
      "move",
      "AIO-001",
      "waiting",
      "--dry-run",
      "--json",
    ]);
    const result = JSON.parse(preview.stdout) as {
      canMove: boolean;
      applied: boolean;
      missingInputs: { option?: string }[];
    };

    expect(result.canMove).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.missingInputs.map((input) => input.option)).toEqual([
      "--waiting-reason",
      "--resume-when",
    ]);
    expect(await readFile(recordPath, "utf8")).toBe(before);
  });

  test("rejects missing transition input and records explicit values", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Wait safely"]);
    const recordPath = path.join(root, "work", "AIO-001", "record.md");
    const before = await readFile(recordPath, "utf8");

    await expect(
      cli(["--root", root, "work", "move", "AIO-001", "waiting"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-TRANSITION-INPUT"),
    });
    expect(await readFile(recordPath, "utf8")).toBe(before);

    const moved = await cli([
      "--root",
      root,
      "work",
      "move",
      "AIO-001",
      "waiting",
      "--waiting-reason",
      "Review is pending",
      "--resume-when",
      "Review is complete",
      "--json",
    ]);
    const result = JSON.parse(moved.stdout) as {
      from: string;
      to: string;
      applied: boolean;
    };
    const record = await readFile(recordPath, "utf8");

    expect(result).toEqual(
      expect.objectContaining({ from: "inbox", to: "waiting", applied: true }),
    );
    expect(record).toContain("waitingReason: Review is pending");
    expect(record).toContain("resumeWhen: Review is complete");
  });

  test("uses the same cancellation contract for move and cancel", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Move cancellation"]);
    await cli(["--root", root, "work", "new", "Cancel alias"]);
    const common = ["--cancellation-reason", "No longer needed", "--json"];

    const moved = JSON.parse(
      (
        await cli([
          "--root",
          root,
          "work",
          "move",
          "AIO-001",
          "cancelled",
          ...common,
        ])
      ).stdout,
    ) as Record<string, unknown>;
    const cancelled = JSON.parse(
      (await cli(["--root", root, "work", "cancel", "AIO-002", ...common]))
        .stdout,
    ) as Record<string, unknown>;

    expect({ ...moved, id: "same" }).toEqual({ ...cancelled, id: "same" });
    expect(
      await readFile(path.join(root, "work", "AIO-001", "record.md"), "utf8"),
    ).toContain("cancellationReason: No longer needed");
    expect(
      await readFile(path.join(root, "work", "AIO-002", "record.md"), "utf8"),
    ).toContain("cancellationReason: No longer needed");
  });

  test("reports completion invalidation and dependent warnings", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Foundation"]);
    await cli(["--root", root, "work", "new", "Dependent"]);
    const dependentPath = path.join(root, "work", "AIO-002", "record.md");
    await writeFile(
      dependentPath,
      (await readFile(dependentPath, "utf8")).replace(
        "needs: []",
        "needs:\n  - AIO-001",
      ),
    );
    const checks = [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ];
    for (const id of ["AIO-001", "AIO-002"]) {
      await cli(["--root", root, "work", "confirm", id, ...checks]);
      await cli(["--root", root, "work", "move", id, "done"]);
    }

    const reopened = await cli([
      "--root",
      root,
      "work",
      "move",
      "AIO-001",
      "active",
      "--reopen-reason",
      "The result changed",
      "--json",
    ]);
    const result = JSON.parse(reopened.stdout) as {
      invalidatesCompletion: boolean;
      warnings: string[];
      changes: string[];
    };

    expect(result.invalidatesCompletion).toBe(true);
    expect(result.warnings.join("\n")).toContain("AIO-002");
    expect(result.changes.join("\n")).toContain(
      "Reset verification, outcome, and knowledge confirmations.",
    );
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

    const discarded = await cli([
      "--root",
      root,
      "work",
      "discard",
      "AIO-001",
      "--confirm",
      "AIO-001",
    ]);
    expect(discarded.stdout).toContain("Discarded: AIO-001");
    expect(discarded.stdout).toContain(
      "Recovery location: .aiongside/trash/AIO-001-",
    );
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
