import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

async function registerKnowledge(root: string, sync = true): Promise<void> {
  const knowledgePath = path.join(
    root,
    "knowledge",
    "operations",
    "incident-response",
  );
  await mkdir(knowledgePath, { recursive: true });
  await writeFile(
    path.join(knowledgePath, "overview.md"),
    "# Incident response\n",
  );
  await writeFile(
    path.join(root, "knowledge", "registry.md"),
    `# Knowledge registry

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| incident-response | operations/incident-response | | Incident response |
`,
  );
  if (sync) {
    await cli(["--root", root, "knowledge", "sync", "incident-response"]);
  }
}

async function cli(args: string[], input?: string) {
  if (input === undefined) {
    return execFileAsync(process.execPath, [bin, ...args], {
      encoding: "utf8",
    });
  }
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [bin, ...args],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
}

describe("CLI", () => {
  test("reports the package version", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, "../package.json"),
        "utf8",
      ),
    ) as { version: string };

    expect((await cli(["--version"])).stdout).toBe(`${manifest.version}\n`);
  });

  test("documents update and rejects it outside a workspace before network access", async () => {
    const root = await tempRoot();
    const help = await cli(["update", "--help"]);
    expect(help.stdout).toContain("--yes");
    expect(help.stdout).toContain("current workspace agent integration");

    await expect(cli(["--root", root, "update"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-WORKSPACE-NOT-FOUND"),
    });
  });

  test("runs initialization, creation, movement, and validation", async () => {
    const root = await tempRoot();

    const initialized = await cli(["init", root, "--name", "Workspace"]);
    const created = await cli(["--root", root, "work", "new", "First Work"]);
    const confirmed = await cli([
      "--root",
      root,
      "work",
      "confirm",
      "WORK-1",
      "scope",
      "completion",
    ]);
    const moved = await cli([
      "--root",
      root,
      "work",
      "move",
      "WORK-1",
      "active",
    ]);
    const checked = await cli(["--root", root, "check"]);

    expect(initialized.stdout).toContain("✓ Workspace initialized");
    expect(initialized.stdout).toContain(`• Root          ${root}`);
    expect(initialized.stdout).toContain("• ID prefix     WORK");
    expect(initialized.stdout).toContain("+ Agent Skills");
    expect(initialized.stdout).toContain("+ Instructions");
    expect(initialized.stdout).toContain("+ Hooks");
    expect(initialized.stdout).toContain("! Approve project Hooks");
    expect(initialized.stdout).toContain("→ Create your first work:");
    expect(initialized.stdout).not.toContain("\u001b[");
    expect(created.stdout).toContain("WORK-1 — First Work");
    expect(confirmed.stdout).toContain("WORK-1 — scope, completion");
    expect(moved.stdout).toContain("WORK-1 — inbox → active");
    expect(checked.stdout).toBe("✓ Check passed\n");
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

  test("documents and runs explicit Overview sync", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Review overview"]);
    const help = await cli(["work", "--help"]);
    const syncHelp = await cli(["work", "sync", "--help"]);
    const recordPath = path.join(root, "work", "WORK-1", "record.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}New Record context.\n`,
    );

    const synced = await cli(["--root", root, "work", "sync", "WORK-1"]);
    const unchanged = await cli(["--root", root, "work", "sync", "work-1"]);

    expect(help.stdout).toContain("sync");
    expect(syncHelp.stdout).toContain("Overview review");
    expect(synced.stdout).toBe("✓ Synced WORK-1 — work/WORK-1/overview.md\n");
    expect(unchanged.stdout).toBe(
      "✓ Overview is current for WORK-1 — work/WORK-1/overview.md\n",
    );
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "✓ Check passed\n",
    );
    await expect(
      cli(["--root", root, "work", "sync", "WORK-999"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-WORK-NOT-FOUND"),
    });
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

  test("documents nested Work Knowledge commands", async () => {
    const help = await cli(["work", "knowledge", "--help"]);
    const addHelp = await cli(["work", "knowledge", "add", "--help"]);
    const removeHelp = await cli(["work", "knowledge", "remove", "--help"]);

    expect(help.stdout).toContain("add");
    expect(help.stdout).toContain("remove");
    expect(addHelp.stdout).toContain("<id> <key>");
    expect(removeHelp.stdout).toContain("<id> <key>");
  });

  test("lists, trees, shows, and syncs Knowledge in human and JSON formats", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const help = await cli(["knowledge", "--help"]);
    for (const command of ["list", "tree", "show", "sync"]) {
      expect(help.stdout).toContain(command);
    }
    expect((await cli(["--root", root, "knowledge", "list"])).stdout).toBe(
      "• No Knowledge registered\n",
    );

    await registerKnowledge(root, false);
    const list = await cli(["--root", root, "knowledge", "list"]);
    expect(list.stdout).toContain("incident-response");
    expect(list.stdout).toContain("stale");
    const listJson = JSON.parse(
      (await cli(["--root", root, "knowledge", "list", "--json"])).stdout,
    ) as Array<{ key: string; fresh: boolean }>;
    expect(listJson).toEqual([
      expect.objectContaining({ key: "incident-response", fresh: false }),
    ]);

    const synced = await cli([
      "--root",
      root,
      "knowledge",
      "sync",
      "incident-response",
      "--json",
    ]);
    expect(JSON.parse(synced.stdout)).toEqual(
      expect.objectContaining({
        key: "incident-response",
        changed: true,
        fresh: true,
      }),
    );
    expect(
      (await cli(["--root", root, "knowledge", "sync", "incident-response"]))
        .stdout,
    ).toContain("Knowledge is current");

    const shown = JSON.parse(
      (
        await cli([
          "--root",
          root,
          "knowledge",
          "show",
          "incident-response",
          "--json",
        ])
      ).stdout,
    ) as { overview: string; fresh: boolean };
    expect(shown).toEqual(
      expect.objectContaining({
        overview: "knowledge/operations/incident-response/overview.md",
        fresh: true,
      }),
    );
    const tree = JSON.parse(
      (await cli(["--root", root, "knowledge", "tree", "--json"])).stdout,
    ) as Array<{ key: string }>;
    expect(tree[0]?.key).toBe("incident-response");

    await expect(
      cli(["--root", root, "knowledge", "show", "missing"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-KNOWLEDGE-NOT-FOUND"),
    });
    await expect(
      cli(["--root", root, "knowledge", "sync", "missing", "--json"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-KNOWLEDGE-NOT-FOUND"),
    });
  });

  test("documents and runs Agent Skill sync", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const help = await cli(["skill", "sync", "--help"]);
    expect(help.stdout).toContain("Restore managed agent integration");

    const configPath = path.join(root, ".aiongside", "config.yaml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "agentSkillVersion: 7\n",
        "",
      ),
    );
    await rm(path.join(root, ".agents"), { recursive: true, force: true });
    await rm(path.join(root, ".claude"), { recursive: true, force: true });
    const nested = path.join(root, "work", "nested");
    await mkdir(nested, { recursive: true });

    const synced = await cli(["--root", nested, "skill", "sync"]);
    expect(synced.stdout).toContain("Agent integration synced (version 7)");
    expect(synced.stdout).toContain(
      "+ Created  .agents/skills/aiongside/SKILL.md",
    );
    expect(synced.stdout).toContain(
      "+ Created  .claude/skills/aiongside/SKILL.md",
    );
    expect(synced.stdout).toContain("+ Created  .claude/settings.json");
    expect(synced.stdout).toContain("~ Updated  .aiongside/config.yaml");
    expect(synced.stdout).toContain("Approve project Hooks");

    const noOp = await cli(["--root", root, "skill", "sync"]);
    expect(noOp.stdout).toContain(
      "✓ Agent integration is current (version 7)\n",
    );
    expect(noOp.stdout).toContain("Approve project Hooks");
  });

  test("reports Agent Skill sync conflicts with exit code 2", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const target = path.join(
      root,
      ".agents",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    await writeFile(target, "# Team-owned skill\n");

    await expect(cli(["--root", root, "skill", "sync"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-SKILL-CONFLICT"),
    });
  });

  test("injects only managed instructions and user rules on session start", async () => {
    const root = await tempRoot();
    const initialized = await cli(["init", root]);
    expect(initialized.stdout).toContain(".aiongside/instructions.md");
    expect(initialized.stdout).toContain(".claude/settings.json");
    expect(initialized.stdout).toContain(".codex/hooks.json");
    expect(initialized.stdout).toContain("Approve project Hooks");
    const rulesPath = path.join(root, ".aiongside", "rules.md");
    const customRules = "# Workspace rules\n\nUse the team vocabulary.\n";
    await writeFile(rulesPath, customRules);
    await cli(["--root", root, "work", "new", "Do not preload this Record"]);
    await registerKnowledge(root, false);
    await writeFile(
      path.join(
        root,
        "knowledge",
        "operations",
        "incident-response",
        "private-runbook.md",
      ),
      "Do not preload this Knowledge content.\n",
    );
    const nested = path.join(root, "work", "WORK-1");

    const result = await cli(
      ["hook", "session-start"],
      JSON.stringify({ cwd: nested, hook_event_name: "SessionStart" }),
    );
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
      };
    };

    expect(result.stdout).toBe(`${JSON.stringify(output)}\n`);
    expect(result.stderr).toBe("");

    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "AIongside managed instructions",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Use the team vocabulary.",
    );
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "Do not preload this Record",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "aiongside knowledge",
    );
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "Do not preload this Knowledge content",
    );

    await rm(path.join(root, ".aiongside", "instructions.md"));
    const missing = await cli(
      ["hook", "session-start"],
      JSON.stringify({ cwd: root, hook_event_name: "SessionStart" }),
    );
    const missingOutput = JSON.parse(missing.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(missingOutput.hookSpecificOutput.additionalContext).toContain(
      ".aiongside/instructions.md",
    );
    expect(missingOutput.hookSpecificOutput.additionalContext).toContain(
      "aiongside skill sync",
    );
  });

  test("allows a valid stop and blocks a failing check only once", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const validEvent = JSON.stringify({
      cwd: root,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect((await cli(["hook", "stop"], validEvent)).stdout).toBe("{}\n");

    const instructionsPath = path.join(root, ".aiongside", "instructions.md");
    await rm(instructionsPath);
    const blocked = JSON.parse(
      (await cli(["hook", "stop"], validEvent)).stdout,
    ) as { decision: string; reason: string };
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("AIO-INSTRUCTIONS-MISSING");

    const retryEvent = JSON.stringify({
      cwd: root,
      hook_event_name: "Stop",
      stop_hook_active: true,
    });
    const retry = JSON.parse(
      (await cli(["hook", "stop"], retryEvent)).stdout,
    ) as { decision?: string; systemMessage: string };
    expect(retry.decision).toBeUndefined();
    expect(retry.systemMessage).toContain("AIO-INSTRUCTIONS-MISSING");
    await expect(readFile(instructionsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("passes Knowledge stale through the bounded Stop Hook contract", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await registerKnowledge(root, false);
    const event = JSON.stringify({
      cwd: root,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });

    const blocked = JSON.parse((await cli(["hook", "stop"], event)).stdout) as {
      decision: string;
      reason: string;
    };
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("AIO-KNOWLEDGE-STALE");
    expect(blocked.reason).toContain(
      "aiongside knowledge sync incident-response",
    );

    const retry = JSON.parse(
      (
        await cli(
          ["hook", "stop"],
          JSON.stringify({
            cwd: root,
            hook_event_name: "Stop",
            stop_hook_active: true,
          }),
        )
      ).stdout,
    ) as { decision?: string; systemMessage: string };
    expect(retry.decision).toBeUndefined();
    expect(retry.systemMessage).toContain("AIO-KNOWLEDGE-STALE");
  });

  test("rejects malformed Hook input without changing workspace files", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const configPath = path.join(root, ".aiongside", "config.yaml");
    const before = await readFile(configPath, "utf8");

    await expect(cli(["hook", "stop"], "not-json")).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-HOOK-INPUT"),
    });
    await expect(
      cli(
        ["hook", "session-start"],
        JSON.stringify({ cwd: root, hook_event_name: "Stop" }),
      ),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-HOOK-INPUT"),
    });
    expect(await readFile(configPath, "utf8")).toBe(before);
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
      "work-1",
      "work-2",
    ]);
    expect(added.stdout).toBe("✓ Added dependency — WORK-1 needs WORK-2\n");
    const removed = await cli([
      "--root",
      root,
      "work",
      "needs",
      "remove",
      "WORK-1",
      "WORK-2",
    ]);
    expect(removed.stdout).toBe(
      "✓ Removed dependency — WORK-1 no longer needs WORK-2\n",
    );

    const paths = [
      path.join(root, "work", "WORK-1", "record.md"),
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
      "WORK-1",
      "WORK-2",
    ]);

    expect(noOp.stdout).toContain("Dependency is already absent");
    expect(
      await Promise.all(paths.map((target) => readFile(target, "utf8"))),
    ).toEqual(beforeNoOp);
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "✓ Check passed\n",
    );
  });

  test("adds, removes, and safely repeats Work Knowledge commands", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Knowledge-linked work"]);
    await registerKnowledge(root);

    const added = await cli([
      "--root",
      root,
      "work",
      "knowledge",
      "add",
      "work-1",
      "Incident-Response",
    ]);
    expect(added.stdout).toBe(
      "✓ Added Knowledge relationship — WORK-1 → incident-response (operations/incident-response)\n",
    );
    const duplicate = await cli([
      "--root",
      root,
      "work",
      "knowledge",
      "add",
      "WORK-1",
      "incident-response",
    ]);
    expect(duplicate.stdout).toContain("already exists");

    const removed = await cli([
      "--root",
      root,
      "work",
      "knowledge",
      "remove",
      "WORK-1",
      "incident-response",
    ]);
    expect(removed.stdout).toBe(
      "✓ Removed Knowledge relationship — WORK-1 ⇥ incident-response\n",
    );
    const absent = await cli([
      "--root",
      root,
      "work",
      "knowledge",
      "remove",
      "WORK-1",
      "incident-response",
    ]);
    expect(absent.stdout).toContain("already absent");
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "✓ Check passed\n",
    );
  });

  test("reports Work Knowledge command failures with exit code 2", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Knowledge-linked work"]);
    await registerKnowledge(root);

    await expect(
      cli(["--root", root, "work", "knowledge", "add", "WORK-1", "missing"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-WORK-KNOWLEDGE-MISSING"),
    });
  });

  test("reports dependency validation failures with exit code 2", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Dependent work"]);
    await cli(["--root", root, "work", "new", "Prerequisite work"]);

    for (const [args, code] of [
      [["WORK-999", "WORK-2"], "AIO-WORK-NOT-FOUND"],
      [["WORK-1", "WORK-999"], "AIO-DEPENDENCY-MISSING"],
      [["WORK-1", "WORK-1"], "AIO-DEPENDENCY-SELF"],
    ] as const) {
      await expect(
        cli(["--root", root, "work", "needs", "add", ...args]),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining(code),
      });
    }

    await cli(["--root", root, "work", "needs", "add", "WORK-1", "WORK-2"]);
    await expect(
      cli(["--root", root, "work", "needs", "add", "WORK-1", "WORK-2"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-DEPENDENCY-DUPLICATE"),
    });
    await expect(
      cli(["--root", root, "work", "needs", "add", "WORK-2", "WORK-1"]),
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
    for (const id of ["WORK-2", "WORK-1"]) {
      await cli(["--root", root, "work", "confirm", id, ...checks]);
      await cli(["--root", root, "work", "move", id, "done"]);
    }
    await expect(
      cli(["--root", root, "work", "needs", "remove", "WORK-1", "WORK-2"]),
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
      path.join(root, "work", "WORK-1", "record.md"),
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
        cli(["--root", root, "work", "needs", "add", "WORK-1", "WORK-2"]),
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
    const recordPath = path.join(root, "work", "WORK-1", "record.md");
    const before = await readFile(recordPath, "utf8");

    const preview = await cli([
      "--root",
      root,
      "work",
      "move",
      "WORK-1",
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
    expect(preview.stdout).toBe(`${JSON.stringify(result, null, 2)}\n`);
    expect(preview.stderr).toBe("");
    expect(await readFile(recordPath, "utf8")).toBe(before);
  });

  test("prints no-impact and linked Knowledge review details for done dry-runs", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "No Knowledge update"]);

    const noImpact = await cli([
      "--root",
      root,
      "work",
      "move",
      "WORK-1",
      "done",
      "--dry-run",
    ]);
    expect(noImpact.stdout).toContain("Knowledge");
    expect(noImpact.stdout).toContain("no lasting Knowledge impact");

    await cli(["--root", root, "work", "new", "Update incident guidance"]);
    await registerKnowledge(root);
    await cli([
      "--root",
      root,
      "work",
      "knowledge",
      "add",
      "WORK-2",
      "incident-response",
    ]);
    const linked = await cli([
      "--root",
      root,
      "work",
      "move",
      "WORK-2",
      "done",
      "--dry-run",
      "--json",
    ]);
    const result = JSON.parse(linked.stdout) as {
      knowledgeReview: {
        confirmed: boolean;
        targets: Array<{ key: string; path: string; overview: string }>;
      };
    };
    expect(result.knowledgeReview).toEqual({
      confirmed: false,
      targets: [
        {
          key: "incident-response",
          path: "operations/incident-response",
          overview: "knowledge/operations/incident-response/overview.md",
          fresh: true,
        },
      ],
    });
  });

  test("rejects missing transition input and records explicit values", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Wait safely"]);
    const recordPath = path.join(root, "work", "WORK-1", "record.md");
    const before = await readFile(recordPath, "utf8");

    await expect(
      cli(["--root", root, "work", "move", "WORK-1", "waiting"]),
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
      "WORK-1",
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
          "WORK-1",
          "cancelled",
          ...common,
        ])
      ).stdout,
    ) as Record<string, unknown>;
    const cancelled = JSON.parse(
      (await cli(["--root", root, "work", "cancel", "WORK-2", ...common]))
        .stdout,
    ) as Record<string, unknown>;

    expect({ ...moved, id: "same" }).toEqual({ ...cancelled, id: "same" });
    expect(
      await readFile(path.join(root, "work", "WORK-1", "record.md"), "utf8"),
    ).toContain("cancellationReason: No longer needed");
    expect(
      await readFile(path.join(root, "work", "WORK-2", "record.md"), "utf8"),
    ).toContain("cancellationReason: No longer needed");
  });

  test("reports completion invalidation and dependent warnings", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Foundation"]);
    await cli(["--root", root, "work", "new", "Dependent"]);
    const dependentPath = path.join(root, "work", "WORK-2", "record.md");
    await writeFile(
      dependentPath,
      (await readFile(dependentPath, "utf8")).replace(
        "needs: []",
        "needs:\n  - WORK-1",
      ),
    );
    const checks = [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ];
    for (const id of ["WORK-1", "WORK-2"]) {
      await cli(["--root", root, "work", "confirm", id, ...checks]);
      await cli(["--root", root, "work", "move", id, "done"]);
    }

    const reopened = await cli([
      "--root",
      root,
      "work",
      "move",
      "WORK-1",
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
    expect(result.warnings.join("\n")).toContain("WORK-2");
    expect(result.changes.join("\n")).toContain(
      "Reset verification, outcome, and knowledge confirmations.",
    );
  });

  test("does not discard without a dry run", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Discard candidate"]);

    await expect(
      cli(["--root", root, "work", "discard", "WORK-1"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-DISCARD-DRY-RUN"),
    });

    const preview = await cli([
      "--root",
      root,
      "work",
      "discard",
      "WORK-1",
      "--dry-run",
    ]);
    expect(preview.stdout).toContain("No changes made");

    const discarded = await cli([
      "--root",
      root,
      "work",
      "discard",
      "WORK-1",
      "--confirm",
      "WORK-1",
    ]);
    expect(discarded.stdout).toContain("✓ Discarded WORK-1");
    expect(discarded.stdout).toContain("• Recovery  .aiongside/trash/WORK-1-");
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
    expect(rebuilt.stdout).toBe("✓ Views rebuilt\n");
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "✓ Check passed\n",
    );
  });
});
