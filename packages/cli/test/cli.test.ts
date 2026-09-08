import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const adapterBin = path.resolve(
  import.meta.dirname,
  "../dist/agent-adapter.js",
);
const bin = path.resolve(import.meta.dirname, "../dist/bin.js");
const runtime = process.env.AIONGSIDE_TEST_RUNTIME ?? process.execPath;
let testUserRoot: string | undefined;

afterEach(async () => {
  testUserRoot = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aiongside-cli-"));
  roots.push(root);
  return root;
}

async function registerKnowledge(root: string, routed = true): Promise<void> {
  await cli([
    "--root",
    root,
    "knowledge",
    "new",
    "incident-response",
    "--path",
    "operations/incident-response.md",
    "--display-name",
    "Incident response",
  ]);
  if (routed) {
    await writeFile(
      path.join(root, "knowledge/index.md"),
      "[Operations](operations/)\n",
    );
    await writeFile(
      path.join(root, "knowledge/operations/index.md"),
      "[Incidents](incident-response.md)\n",
    );
  }
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else
        files[path.relative(root, file)] = (await readFile(file)).toString(
          "base64",
        );
    }
  }
  await visit(root);
  return files;
}

async function cli(args: string[], input?: string) {
  if (!testUserRoot) {
    testUserRoot = await tempRoot();
    await mkdir(path.join(testUserRoot, "cache", "aiongside"), {
      recursive: true,
    });
    await writeFile(
      path.join(testUserRoot, "cache", "aiongside", "update-check.json"),
      JSON.stringify({ schema: 1, version: "0.0.0", checkedAt: Date.now() }),
    );
  }
  const userRoot = testUserRoot;
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(userRoot, "config"),
    XDG_CACHE_HOME: path.join(userRoot, "cache"),
  };
  if (input === undefined) {
    return execFileAsync(runtime, [bin, ...args], {
      encoding: "utf8",
      env,
    });
  }
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      runtime,
      [adapterBin, ...args],
      { encoding: "utf8", env },
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
  test("returns versioned context, check and doctor JSON with 0, 1 and 2 exits", async () => {
    const root = await tempRoot();
    for (const command of ["context", "check", "doctor"]) {
      const failed = await cli(["--root", root, command, "--json"]).catch(
        (error) => error,
      );
      expect(failed.code).toBe(2);
      expect(failed.stderr).toBe("");
      expect(JSON.parse(failed.stdout)).toMatchObject({
        version: 1,
        ok: false,
      });
    }
    await cli(["init", root]);
    expect(
      JSON.parse((await cli(["--root", root, "context", "--json"])).stdout),
    ).toMatchObject({
      version: 1,
      root,
      ok: true,
      instructions: expect.any(String),
      issues: [],
    });
    await writeFile(path.join(root, ".aiongside/instructions.md"), "# Drift\n");
    const doctor = await cli(["--root", root, "doctor", "--json"]).catch(
      (error) => error,
    );
    expect(doctor.code).toBe(1);
    expect(JSON.parse(doctor.stdout).issues[0].code).toBe(
      "AIO-INSTRUCTIONS-DRIFT",
    );
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
  });

  test("forwards Work hash reasons and conditional update guidance to Stop unchanged", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(
      ["session-start"],
      JSON.stringify({
        session_id: root,
        source: "startup",
        cwd: root,
        hook_event_name: "SessionStart",
      }),
    );
    await cli(["--root", root, "work", "new", "Hash reason"]);
    const recordPath = path.join(root, "work/WORK-1/record.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}\nChanged content.\n`,
    );
    const checked = await cli(["--root", root, "check", "--json"]).catch(
      (error) => error,
    );
    const issue = JSON.parse(checked.stdout).issues.find(
      (item: { code: string }) => item.code === "AIO-OVERVIEW-STALE",
    );
    expect(issue.message).toContain("does not match");
    expect(issue.hint).toContain("otherwise leave its body unchanged");
    expect(issue.hint).toContain("work/WORK-1/record.md");
    expect(issue.hint).toContain("work/WORK-1/overview.md");
    const stop = JSON.parse(
      (
        await cli(
          ["stop"],
          JSON.stringify({
            session_id: root,
            cwd: root,
            hook_event_name: "Stop",
          }),
        )
      ).stdout,
    );
    expect(stop.reason).toContain(issue.message);
    expect(stop.reason).toContain(issue.hint);
    await cli(["--root", root, "work", "sync", "WORK-1"]);
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
  });

  test("reports the package version", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, "../package.json"),
        "utf8",
      ),
    ) as { version: string };

    expect((await cli(["--version"])).stdout).toBe(`${manifest.version}\n`);
  });

  test("documents global update and accepts version refusal outside a workspace", async () => {
    const root = await tempRoot();
    const help = await cli(["update", "--help"]);
    expect(help.stdout).toContain("--yes");
    expect(help.stdout).toContain("global CLI from any directory");

    expect(
      (await cli(["--root", root, "update", "--skip-version", "0.9.0"])).stdout,
    ).toContain("No installation performed");
    await expect(
      cli(["update", "--yes", "--skip-version", "0.9.0"]),
    ).rejects.toMatchObject({ code: 2 });
  });

  test("runs initialization, creation, movement, and validation", async () => {
    const root = await tempRoot();

    const initialized = await cli(["init", root, "--name", "Workspace"]);
    const created = await cli(["--root", root, "work", "new", "First Work"]);
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
    expect(initialized.stdout).toContain(root);
    expect(initialized.stdout).toContain("ID prefix");
    expect(initialized.stdout).not.toContain("Agent Skills");
    expect(initialized.stdout).toContain("+ Instructions");
    expect(initialized.stdout).toContain("+ Hooks");
    expect(initialized.stdout).toContain("! Approve project Hooks");
    expect(initialized.stdout).toContain("→ Create your first work:");
    expect(initialized.stdout).not.toContain("\u001b[");
    expect(created.stdout).toContain("WORK-1 — First Work");
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
    expect(syncHelp.stdout).toContain("Record body hash");
    expect(synced.stdout).toBe(
      "✓ Recorded current Record body hash for WORK-1 — work/WORK-1/overview.md; Overview body unchanged\n",
    );
    expect(unchanged.stdout).toBe(
      "✓ Record body hash already matches for WORK-1 — work/WORK-1/overview.md; no files changed\n",
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

  test("sync succeeds during dependency recovery while check keeps reporting the error", async () => {
    const root = await tempRoot();
    const run = (...args: string[]) => cli(["--root", root, ...args]);
    await cli(["init", root]);
    await run("work", "new", "Venue");
    await run("work", "new", "Preparation");
    await run("work", "needs", "add", "WORK-2", "WORK-1");
    await run("work", "move", "WORK-1", "done");
    await run("work", "move", "WORK-2", "done");
    await run(
      "work",
      "move",
      "WORK-1",
      "active",
      "--reopen-reason",
      "Recheck venue",
    );
    const recordPath = path.join(root, "work/WORK-1/record.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}Rechecking availability.\n`,
    );
    const sync = await run("work", "sync", "WORK-1");
    expect(sync.stdout).toContain("Recorded current Record body hash");
    const checked = await run("check", "--json").catch((error) => error);
    expect(checked.code).toBe(1);
    expect(JSON.parse(checked.stdout)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "AIO-DEPENDENCY-BLOCKED" })],
    });
    await run(
      "work",
      "move",
      "WORK-2",
      "active",
      "--reopen-reason",
      "Review preparation",
    );
    expect(JSON.parse((await run("check", "--json")).stdout).ok).toBe(true);
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

  test("creates, scans, moves, and discards documents with routing guidance", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const run = async (...args: string[]) =>
      JSON.parse(
        (await cli(["--root", root, "knowledge", ...args, "--json"])).stdout,
      );
    const created = await run("new", "policy", "--path", "company/policy.md");
    expect(created.path).toBe("company/policy.md");
    expect(created.postActions[0].paths).toEqual([
      "knowledge/index.md",
      "knowledge/company/index.md",
    ]);
    expect((await run("list"))[0].key).toBe("policy");
    expect((await run("tree"))[0].children[0].key).toBe("policy");
    expect((await run("show", "policy")).document).toBe(
      "knowledge/company/policy.md",
    );
    expect(
      (await cli(["--root", root, "knowledge", "show", "policy"])).stdout,
    ).toContain("knowledge/company/policy.md");
    const original = await readFile(
      path.join(root, "knowledge/company/policy.md"),
    );
    const preview = await run(
      "move",
      "policy",
      "--path",
      "policy.md",
      "--dry-run",
    );
    expect(preview.postActions).toEqual([]);
    const moved = await run("move", "policy", "--path", "policy.md");
    expect(moved.postActions[0].message).toContain(
      "relative links inside the moved document",
    );
    expect(await readFile(path.join(root, "knowledge/policy.md"))).toEqual(
      original,
    );
    expect(
      (await run("move", "policy", "--path", "policy.md")).postActions,
    ).toEqual([]);
    expect((await run("discard", "policy", "--dry-run")).postActions).toEqual(
      [],
    );
    const discarded = await run("discard", "policy", "--confirm", "policy");
    expect(discarded.applied).toBe(true);
    expect(discarded.postActions[0].commands).toEqual([
      "aiongside check --json",
    ]);
    expect(await run("list")).toEqual([]);
    expect(
      await readFile(path.join(root, discarded.trashTarget, "content.md")),
    ).toEqual(original);
  });

  test("rejects duplicate keys, reserved paths, removed options and sync", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "knowledge", "new", "policy"]);
    for (const args of [
      ["new", "policy"],
      ["new", "second", "--path", "policy.md"],
      ["new", "second", "--path", "index.md"],
      ["new", "second", "--path", "../outside.md"],
      ["new", "second", "--parent", "policy"],
      ["move", "policy", "--path", "x.md", "--no-parent"],
      ["sync", "policy"],
      ["show", "absent"],
      ["discard", "policy"],
      ["discard", "policy", "--confirm", "wrong"],
    ])
      await expect(
        cli(["--root", root, "knowledge", ...args]),
      ).rejects.toMatchObject({ code: 2 });
    expect((await cli(["knowledge", "--help"])).stdout).not.toMatch(
      /sync|freshness|Registry/,
    );
  });

  test("exposes integration and doctor without retired command namespaces", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    expect((await cli(["workspace", "--help"])).stdout).toContain("upgrade");
    expect(
      (await cli(["--root", root, "workspace", "upgrade"])).stdout,
    ).toContain("current");
    expect(
      JSON.parse((await cli(["--root", root, "doctor", "--json"])).stdout).ok,
    ).toBe(true);
    for (const command of ["skill", "hook"])
      await expect(cli([command])).rejects.toMatchObject({ code: 2 });
    for (const command of ["confirm", "cancel", "review", "resolve"])
      await expect(cli(["work", command])).rejects.toMatchObject({ code: 2 });
  });
  test("reports integration conflicts with exit code 2", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await writeFile(path.join(root, ".codex/hooks.json"), "{broken");
    await expect(
      cli(["--root", root, "workspace", "upgrade"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-HOOK-CONFLICT"),
    });
  });
  test("injects only managed instructions and ignores legacy user rules on session start", async () => {
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
      path.join(root, "knowledge", "operations", "private-runbook.txt"),
      "Do not preload this Knowledge content.\n",
    );
    const nested = path.join(root, "work", "WORK-1");

    const result = await cli(
      ["session-start"],
      JSON.stringify({
        session_id: root,
        source: "startup",
        cwd: nested,
        hook_event_name: "SessionStart",
      }),
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
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "Use the team vocabulary.",
    );
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "# Workspace rules",
    );
    expect(await readFile(rulesPath, "utf8")).toBe(customRules);
    const context = JSON.parse(
      (await cli(["--root", root, "context", "--json"])).stdout,
    );
    expect(context).not.toHaveProperty("rules");
    const humanContext = await cli(["--root", root, "context"]);
    expect(humanContext.stdout).toContain("Document and folder roles");
    expect(humanContext.stdout).not.toContain("Use the team vocabulary.");
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "Do not preload this Record",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain("aiongside");
    expect(output.hookSpecificOutput.additionalContext).not.toContain(
      "Do not preload this Knowledge content",
    );

    await rm(path.join(root, ".aiongside", "instructions.md"));
    const missing = await cli(
      ["session-start"],
      JSON.stringify({
        session_id: root,
        source: "resume",
        cwd: root,
        hook_event_name: "SessionStart",
      }),
    );
    const missingOutput = JSON.parse(missing.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(missingOutput.hookSpecificOutput.additionalContext).toContain(
      ".aiongside/instructions.md",
    );
    expect(missingOutput.hookSpecificOutput.additionalContext).toContain(
      "aiongside workspace upgrade",
    );
  });

  test("allows a valid stop and blocks a failing check only once", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(
      ["session-start"],
      JSON.stringify({
        session_id: root,
        source: "startup",
        cwd: root,
        hook_event_name: "SessionStart",
      }),
    );
    const event = JSON.stringify({
      session_id: root,
      cwd: root,
      hook_event_name: "Stop",
    });
    expect(JSON.parse((await cli(["stop"], event)).stdout)).toEqual({});
    await writeFile(path.join(root, ".aiongside/instructions.md"), "# Drift\n");
    expect(JSON.parse((await cli(["stop"], event)).stdout)).toEqual({});
    await writeFile(path.join(root, "views/open.md"), "# Drift\n");
    const check = await cli(["--root", root, "check", "--json"]).catch(
      (error) => error,
    );
    expect(check.code).toBe(1);
    const issue = JSON.parse(check.stdout).issues[0];
    const blocked = JSON.parse((await cli(["stop"], event)).stdout);
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain(issue.message);
    expect(blocked.reason).toContain(issue.hint);
    const retry = JSON.parse(
      (
        await cli(
          ["stop"],
          JSON.stringify({
            cwd: root,
            session_id: root,
            hook_event_name: "Stop",
            stop_hook_active: true,
          }),
        )
      ).stdout,
    );
    expect(retry.decision).toBeUndefined();
    expect(retry.systemMessage).toContain(issue.message);
  });
  test("passes index omissions and duplicate keys through the bounded Stop Hook", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(
      ["session-start"],
      JSON.stringify({
        session_id: root,
        source: "startup",
        cwd: root,
        hook_event_name: "SessionStart",
      }),
    );
    await registerKnowledge(root, false);
    const input = JSON.stringify({
      session_id: root,
      cwd: root,
      hook_event_name: "Stop",
    });
    const stopped = JSON.parse((await cli(["stop"], input)).stdout);
    expect(JSON.stringify(stopped)).toContain("AIO-KNOWLEDGE-INDEX-OMISSION");
    expect(JSON.stringify(stopped)).toContain("knowledge/index.md");
    expect(JSON.stringify(stopped)).not.toContain("knowledge sync");
    const doc = await readFile(
      path.join(root, "knowledge/operations/incident-response.md"),
    );
    await writeFile(path.join(root, "knowledge/duplicate.md"), doc);
    const failed = await cli(["--root", root, "check", "--json"]).catch(
      (error) => error,
    );
    expect(failed.code).toBe(1);
    expect(
      JSON.parse(failed.stdout).issues.filter(
        (issue: { code: string }) => issue.code === "AIO-KNOWLEDGE-KEY",
      ),
    ).toHaveLength(2);
    const repeated = await cli(
      ["stop"],
      JSON.stringify({
        cwd: root,
        session_id: root,
        hook_event_name: "Stop",
        stop_hook_active: true,
      }),
    );
    expect(JSON.parse(repeated.stdout).decision).not.toBe("block");
  });

  test("rejects malformed Hook input without changing workspace files", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const configPath = path.join(root, ".aiongside", "config.yaml");
    const before = await readFile(configPath, "utf8");

    await expect(cli(["stop"], "not-json")).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-ADAPTER-INPUT"),
    });
    await expect(
      cli(
        ["session-start"],
        JSON.stringify({ cwd: root, hook_event_name: "Stop" }),
      ),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("AIO-ADAPTER-INPUT"),
    });
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  test("keeps context, Stop and recovery in the original workspace after cwd changes", async () => {
    const parent = await tempRoot();
    const root = path.join(parent, "team's workspace");
    const legacy = path.join(root, ".legacy");
    await cli(["init", root]);
    await cli(["init", legacy]);
    await writeFile(path.join(legacy, "views/open.md"), "# Legacy drift\n");
    const before = await snapshotFiles(root);
    const session_id = "stable-root";
    const start = (cwd: string, source: string) =>
      cli(
        ["session-start"],
        JSON.stringify({
          session_id,
          cwd,
          source,
          hook_event_name: "SessionStart",
        }),
      );
    const stop = (cwd: string, stop_hook_active = false) =>
      cli(
        ["stop"],
        JSON.stringify({
          session_id,
          cwd,
          stop_hook_active,
          hook_event_name: "Stop",
        }),
      );
    const first = JSON.parse((await start(root, "startup")).stdout);
    expect(first.hookSpecificOutput.additionalContext).toContain(
      JSON.stringify(root),
    );
    for (const cwd of [
      legacy,
      parent,
      path.join(parent, "deleted-directory"),
    ]) {
      expect(JSON.parse((await stop(cwd)).stdout)).toEqual({});
      const resumed = JSON.parse((await start(cwd, "resume")).stdout);
      expect(resumed.hookSpecificOutput.additionalContext).toContain(
        JSON.stringify(root),
      );
      expect(resumed.hookSpecificOutput.additionalContext).not.toContain(
        JSON.stringify(legacy),
      );
    }
    expect(await snapshotFiles(root)).toEqual(before);
    const manual = await cli(["--root", legacy, "check", "--json"]).catch(
      (error) => error,
    );
    expect(JSON.parse(manual.stdout)).toMatchObject({
      root: legacy,
      ok: false,
    });
    await writeFile(path.join(root, "views/open.md"), "# Current drift\n");
    const drifted = await snapshotFiles(root);
    const sessionFiles = path.join(testUserRoot as string, "cache");
    const bindings = await snapshotFiles(sessionFiles);
    const blocked = JSON.parse((await stop(legacy)).stdout);
    expect(blocked.reason).toContain("AIO-VIEW-DRIFT");
    expect(blocked.reason).toContain(
      `--root '${root.replaceAll("'", "'\\''")}'`,
    );
    expect(blocked.reason).not.toContain(JSON.stringify(legacy));
    const retry = JSON.parse((await stop(parent, true)).stdout);
    expect(retry.decision).toBeUndefined();
    expect(retry.systemMessage).toContain(JSON.stringify(root));
    expect(await snapshotFiles(root)).toEqual(drifted);
    expect(await snapshotFiles(sessionFiles)).toEqual(bindings);
  }, 30_000);

  test("reports missing binding or lost root instead of checking the current healthy workspace", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    for (const retry of [false, true]) {
      const stopped = JSON.parse(
        (
          await cli(
            ["stop"],
            JSON.stringify({
              session_id: "missing",
              cwd: root,
              hook_event_name: "Stop",
              stop_hook_active: retry,
            }),
          )
        ).stdout,
      );
      const message = retry ? stopped.systemMessage : stopped.reason;
      expect(message).toContain("AIO-ADAPTER-SESSION");
      expect(message).toContain("Start a new agent session");
      expect(message).not.toContain("work sync");
      expect(stopped.decision).toBe(retry ? undefined : "block");
    }
    const nested = path.join(root, "nested");
    await cli(["init", nested]);
    await cli(
      ["session-start"],
      JSON.stringify({
        session_id: "lost-root",
        source: "startup",
        cwd: nested,
        hook_event_name: "SessionStart",
      }),
    );
    await rename(
      path.join(nested, ".aiongside/config.yaml"),
      path.join(nested, ".aiongside/config.saved"),
    );
    const lost = JSON.parse(
      (
        await cli(
          ["stop"],
          JSON.stringify({
            session_id: "lost-root",
            cwd: root,
            hook_event_name: "Stop",
          }),
        )
      ).stdout,
    );
    expect(lost.decision).toBe("block");
    expect(lost.reason).toContain("AIO-ADAPTER-SESSION");
    expect(lost.reason).toContain("no longer available");
    expect(lost.reason).not.toContain("--root");
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
    await cli(["--root", root, "work", "move", "WORK-1", "done"]);

    const added = await cli([
      "--root",
      root,
      "work",
      "knowledge",
      "add",
      "work-1",
      "Incident-Response",
    ]);
    expect(added.stdout).toContain(
      "✓ Recorded Knowledge contribution — WORK-1 → incident-response (knowledge/operations/incident-response.md). Knowledge content was not changed.\n",
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
    expect(duplicate.stdout).toContain("already recorded");

    const removed = await cli([
      "--root",
      root,
      "work",
      "knowledge",
      "remove",
      "WORK-1",
      "incident-response",
    ]);
    expect(removed.stdout).toContain(
      "✓ Removed Knowledge contribution record — WORK-1 → incident-response (knowledge/operations/incident-response.md). Knowledge content was not changed.\n",
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
    expect(added.stdout).not.toContain("update the Knowledge");
    expect(added.stdout).not.toContain("knowledge sync");
    expect(removed.stdout).toContain("Ask the user");
    expect(removed.stdout).toContain("origin is unclear");
    expect(absent.stdout).not.toContain("Ask the user");
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "✓ Check passed\n",
    );
  });

  test("records a contribution without new update actions or semantic verification", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Follow-up work"]);
    await cli(["--root", root, "knowledge", "new", "policy"]);
    await cli(["--root", root, "work", "move", "WORK-1", "done"]);
    await writeFile(
      path.join(root, "knowledge/index.md"),
      "[Policy](policy.md)\n",
    );
    const overview = path.join(root, "knowledge/policy.md");
    const before = await readFile(overview, "utf8");
    const call = async (action: string) =>
      JSON.parse(
        (
          await cli([
            "--root",
            root,
            "work",
            "knowledge",
            action,
            "WORK-1",
            "policy",
            "--json",
          ])
        ).stdout,
      );
    const added = await call("add");
    expect(added.message).toContain("Recorded Knowledge contribution");
    expect(added.message).toContain("Knowledge content was not changed");
    expect(added.record).toBe("work/WORK-1/record.md");
    expect(added.postActions).toEqual([]);
    expect((await call("add")).postActions).toEqual([]);
    const removed = await call("remove");
    expect(removed.postActions[0].kind).toBe("knowledge-removal-question");
    expect(removed.postActions[0].message).toContain(
      "obtain approval before editing",
    );
    expect((await call("remove")).postActions).toEqual([]);
    expect(await readFile(overview, "utf8")).toBe(before);
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
  });

  test("explains incorporation before add and preserves Work sync only", async () => {
    const add = (await cli(["work", "knowledge", "add", "--help"])).stdout;
    expect(add).toContain(
      "Incorporate the Work results into Knowledge before running add",
    );
    expect(add).toContain("not a reference or a request to update content");
    expect(add).toContain("does not edit content or verify incorporation");
    expect(
      (await cli(["work", "knowledge", "remove", "--help"])).stdout,
    ).toContain("without deleting Knowledge content");
    expect((await cli(["work", "sync", "--help"])).stdout).toContain("hash");
    expect((await cli(["knowledge", "--help"])).stdout).not.toContain("sync");
  });

  test("incorporates Knowledge and repairs routing before recording without changing the seal", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Confirmed venue capacity"]);
    await cli(["--root", root, "work", "move", "WORK-1", "done"]);
    const recordPath = path.join(root, "work/WORK-1/record.md");
    const seal = (await readFile(recordPath, "utf8")).match(
      /completionSeal:[\s\S]*?\n---/,
    )?.[0];
    await cli(["--root", root, "knowledge", "new", "venues"]);
    const target = path.join(root, "knowledge/venues.md");
    const content =
      (await readFile(target, "utf8")) +
      "\nVerify actual capacity before selecting a venue.\n";
    await writeFile(target, content);
    await writeFile(
      path.join(root, "knowledge/index.md"),
      "[Venue selection](venues.md)\n",
    );
    const args = [
      "--root",
      root,
      "work",
      "knowledge",
      "add",
      "WORK-1",
      "venues",
      "--json",
    ];
    const added = JSON.parse((await cli(args)).stdout);
    expect(added.changed).toBe(true);
    expect(added.postActions).toEqual([]);
    expect(
      (await readFile(recordPath, "utf8")).match(
        /completionSeal:[\s\S]*?\n---/,
      )?.[0],
    ).toBe(seal);
    expect(await readFile(target, "utf8")).toBe(content);
    expect(JSON.parse((await cli(args)).stdout).changed).toBe(false);
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
  });

  test("preserves the original document recovery hint when another Work blocks a mutation", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Changed source"]);
    await cli(["--root", root, "work", "new", "Unchanged target"]);
    const sourcePath = path.join(root, "work/WORK-1/record.md");
    const targetPath = path.join(root, "work/WORK-2/record.md");
    await writeFile(
      sourcePath,
      `${await readFile(sourcePath, "utf8")}\nNew confirmed result.\n`,
    );
    const before = await readFile(targetPath, "utf8");
    const check = await cli(["--root", root, "check", "--json"]).catch(
      (error) => error,
    );
    const issue = JSON.parse(check.stdout).issues.find(
      (item: { code: string }) => item.code === "AIO-OVERVIEW-STALE",
    );
    expect(issue.hint).toContain("aiongside work sync WORK-1");
    await expect(
      cli(["--root", root, "work", "move", "WORK-2", "active"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(issue.hint),
    });
    expect(await readFile(targetPath, "utf8")).toBe(before);
  });

  test("returns move guidance with actual paths and no applied actions for dry-run", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "knowledge", "new", "policy"]);
    const args = [
      "--root",
      root,
      "knowledge",
      "move",
      "policy",
      "--path",
      "new-policy.md",
      "--json",
    ];
    const preview = JSON.parse((await cli([...args, "--dry-run"])).stdout);
    expect(preview.postActions).toEqual([]);
    const moved = JSON.parse((await cli(args)).stdout);
    expect(moved.postActions[0].paths).toContain("knowledge/policy.md");
    expect(moved.postActions[0].paths).toContain("knowledge/new-policy.md");
    expect(moved.postActions[0].message).toContain("links were not rewritten");
    expect(moved.postActions[0].commands).toContain("aiongside check --json");
  });

  test("project version refusal is separate from integration and does not block check", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    const integration = path.join(root, ".aiongside/internal/integration.json");
    const before = await readFile(integration, "utf8");
    await cli(["--root", root, "workspace", "upgrade", "--skip-version", "3"]);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, ".aiongside/internal/update-preferences.json"),
          "utf8",
        ),
      ).skippedVersions,
    ).toEqual(["3"]);
    expect(await readFile(integration, "utf8")).toBe(before);
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
    await cli(["--root", root, "workspace", "upgrade"]);
    expect(await readFile(integration, "utf8")).toBe(before);
  });

  test("reports Work Knowledge command failures with exit code 2", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Knowledge-linked work"]);
    await registerKnowledge(root);
    await cli(["--root", root, "work", "move", "WORK-1", "done"]);

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

    const _checks = [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ];
    for (const id of ["WORK-2", "WORK-1"]) {
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

  test("omits completed prerequisites from dry-run and actual done JSON", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Completed prerequisite"]);
    await cli(["--root", root, "work", "new", "Dependent work"]);
    await cli(["--root", root, "work", "move", "WORK-1", "done"]);
    await cli(["--root", root, "work", "needs", "add", "WORK-2", "WORK-1"]);
    const args = ["--root", root, "work", "move", "WORK-2", "done"];
    for (const options of [["--dry-run", "--json"], ["--json"], ["--json"]]) {
      const response = await cli([...args, ...options]);
      expect(response.stderr).toBe("");
      expect(JSON.parse(response.stdout)).toMatchObject({
        canMove: true,
        requiredInputs: [],
        missingInputs: [],
      });
    }
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
  });

  test("explains cancelled prerequisites without bypassing completion", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    for (const title of [
      "Completed prerequisite",
      "Cancelled prerequisite",
      "Dependent work",
    ])
      await cli(["--root", root, "work", "new", title]);
    await cli(["--root", root, "work", "move", "WORK-1", "done"]);
    await cli([
      "--root",
      root,
      "work",
      "move",
      "WORK-2",
      "cancelled",
      "--cancellation-reason",
      "Budget removed",
    ]);
    for (const id of ["WORK-1", "WORK-2"])
      await cli(["--root", root, "work", "needs", "add", "WORK-3", id]);
    const recordPath = path.join(root, "work/WORK-3/record.md");
    const before = await readFile(recordPath, "utf8");
    const args = ["--root", root, "work", "move", "WORK-3", "done"];
    const removeCommand = "aiongside work needs remove WORK-3 WORK-2";
    const preview = JSON.parse(
      (await cli([...args, "--dry-run", "--json"])).stdout,
    );
    expect(preview.canMove).toBe(false);
    expect(preview.requiredInputs).toEqual([
      expect.objectContaining({
        key: "needs.WORK-2",
        code: "AIO-DEPENDENCY-BLOCKED",
        question: expect.stringContaining("is cancelled"),
        hint: expect.stringContaining(removeCommand),
      }),
    ]);
    expect(preview.missingInputs).toEqual(preview.requiredInputs);
    const human = await cli([...args, "--dry-run"]);
    expect(human.stdout).toContain("is cancelled");
    expect(human.stdout).toContain(removeCommand);
    expect(human.stdout).not.toContain("Dependency WORK-1");
    for (const options of [[], ["--json"]]) {
      const failed = await cli([...args, ...options]).catch((error) => error);
      expect(failed.code).toBe(2);
      expect(failed.stderr).toContain("AIO-DEPENDENCY-BLOCKED");
      expect(failed.stderr).toContain("is cancelled");
      expect(failed.stderr).toContain(
        "If this prerequisite is no longer required",
      );
      expect(failed.stderr).toContain(removeCommand);
    }
    expect(await readFile(recordPath, "utf8")).toBe(before);
    await cli(["--root", root, "work", "needs", "remove", "WORK-3", "WORK-2"]);
    expect(JSON.parse((await cli([...args, "--json"])).stdout)).toMatchObject({
      applied: true,
      requiredInputs: [],
      missingInputs: [],
    });
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
  });

  test("returns one-time Knowledge guidance only for an actual done move", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Booking"]);
    const args = ["--root", root, "work", "move", "WORK-1", "done", "--json"];
    expect(
      JSON.parse((await cli([...args, "--dry-run"])).stdout).postActions,
    ).toBeUndefined();
    const done = JSON.parse((await cli(args)).stdout);
    expect(done.postActions).toEqual([
      expect.objectContaining({ kind: "knowledge-update", workId: "WORK-1" }),
    ]);
    expect(done.postActions[0].message).toContain("no further action");
    expect(done.postActions[0].message).toContain("Read work/WORK-1/record.md");
    expect(done.postActions[0].message).toContain("aiongside knowledge list");
    expect(done.postActions[0].message).toContain(
      "without duplicating existing material",
    );
    expect(done.postActions[0].message).toContain(
      "After incorporating the Work results",
    );
    expect(done.postActions[0].message).toContain(
      "aiongside work knowledge add WORK-1 <key>",
    );
    expect(done.postActions[0].message).toContain(
      "only if that relationship is absent",
    );
    expect(done.postActions[0].message).toContain(
      "Do not add relationships for reference-only topics",
    );
    expect(done.postActions[0].message).not.toContain("Consider updating");
    expect(JSON.parse((await cli(args)).stdout).postActions).toBeUndefined();
    expect(
      JSON.parse((await cli(["--root", root, "check", "--json"])).stdout).ok,
    ).toBe(true);
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

  test("cancels through move and lists every supported status", async () => {
    const root = await tempRoot();
    await cli(["init", root]);
    await cli(["--root", root, "work", "new", "Cancelled booking"]);
    await expect(
      cli(["--root", root, "work", "move", "WORK-1", "cancelled"]),
    ).rejects.toMatchObject({ code: 2 });
    const moved = JSON.parse(
      (
        await cli([
          "--root",
          root,
          "work",
          "move",
          "WORK-1",
          "cancelled",
          "--cancellation-reason",
          "No longer needed",
          "--json",
        ])
      ).stdout,
    );
    expect(moved.to).toBe("cancelled");
    expect(moved.postActions).toBeUndefined();
    const help = (await cli(["work", "move", "--help"])).stdout;
    for (const status of ["inbox", "active", "waiting", "done", "cancelled"])
      expect(help).toContain(status);
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
    const _checks = [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ];
    for (const id of ["WORK-1", "WORK-2"]) {
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
      "Invalidate the existing completion seal.",
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
    expect(discarded.stdout).toContain(
      "• Recovery  .aiongside/internal/trash/WORK-1-",
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

    const rebuilt = await cli(["--root", root, "view", "sync"]);
    expect(rebuilt.stdout).toBe("✓ Views synced\n");
    expect((await cli(["--root", root, "check"])).stdout).toBe(
      "✓ Check passed\n",
    );
  });
});
