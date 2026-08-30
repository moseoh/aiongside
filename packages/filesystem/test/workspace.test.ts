import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  calculateMarkdownBodyDigest,
  createOverviewDocument,
  createRecordDocument,
  evaluateTransition,
  formatMarkdownDocument,
  parseMarkdownDocument,
  WORK_STATUSES,
  workMetadataSchema,
} from "@aiongside/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addWorkDependency,
  cancelWork,
  confirmWork,
  createWork,
  discardWork,
  initializeWorkspace,
  listWorks,
  loadAgentInstructionsSource,
  loadAgentSkillSource,
  mergeAgentHookSettings,
  moveWork,
  pathExists,
  previewDiscard,
  previewMoveWork,
  rebuildViews,
  removeWorkDependency,
  syncAgentSkills,
  syncWorkOverview,
  validateWorkspace,
} from "../src/index.js";

const writeFailure = vi.hoisted(() => ({ target: "" }));

vi.mock("write-file-atomic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("write-file-atomic")>();
  const original = actual.default as (...args: unknown[]) => unknown;
  return {
    ...actual,
    default: (...args: unknown[]) => {
      if (args[0] === writeFailure.target) {
        writeFailure.target = "";
        return Promise.reject(new Error("Injected View write failure"));
      }
      return original(...args);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "aiongside-test-"));
  roots.push(root);
  await initializeWorkspace(root, { name: "Test", idPrefix: "AIO" });
  return root;
}

async function setNeeds(
  root: string,
  id: string,
  needs: string[],
): Promise<void> {
  const recordPath = path.join(root, "work", id, "record.md");
  const source = await readFile(recordPath, "utf8");
  const replacement = needs.length
    ? `needs:\n${needs.map((dependency) => `  - ${dependency}`).join("\n")}`
    : "needs: []";
  await writeFile(recordPath, source.replace("needs: []", replacement));
}

async function writeWorkFixture(root: string, id: string): Promise<void> {
  const metadata = workMetadataSchema.parse({
    schema: 1,
    id,
    title: id,
    status: "inbox",
    type: "delivery",
    created: "2026-08-30",
    updated: "2026-08-30",
    needs: [],
    checks: {
      scope: false,
      completion: false,
      verification: false,
      outcome: false,
      knowledge: false,
    },
  });
  const directory = path.join(root, "work", id);
  const record = createRecordDocument(metadata);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "record.md"), record),
    writeFile(
      path.join(directory, "overview.md"),
      createOverviewDocument(metadata, calculateMarkdownBodyDigest(record)),
    ),
    ...["references", "deliverables", "evidence"].map((name) =>
      mkdir(path.join(directory, name)),
    ),
  ]);
}

const allChecks = [
  "scope",
  "completion",
  "verification",
  "outcome",
  "knowledge",
] as const;

const allTransitionInputs = {
  reopenReason: "The work needs to be reopened",
  waitingReason: "An external response is required",
  resumeWhen: "The response is received",
  waitingResolution: "The external response arrived",
  cancellationReason: "The work is no longer needed",
};

describe("workspace lifecycle", () => {
  test("merges managed Hooks without changing user settings or current output", () => {
    const source = `${JSON.stringify(
      {
        permissions: { allow: ["Read"] },
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "team stop" }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`;

    const merged = mergeAgentHookSettings(source);
    const settings = JSON.parse(merged) as {
      permissions: { allow: string[] };
      hooks: { SessionStart: unknown[]; Stop: unknown[] };
    };

    expect(settings.permissions.allow).toEqual(["Read"]);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(merged).toContain("team stop");
    expect(mergeAgentHookSettings(merged)).toBe(merged);
    const semanticallyCurrent = `${JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                command: "aiongside hook stop",
                statusMessage: "Checking AIongside workspace",
                timeout: 30,
                type: "command",
              },
            ],
          },
        ],
        SessionStart: [
          {
            hooks: [
              {
                command: "aiongside hook session-start",
                statusMessage: "Loading AIongside instructions",
                timeout: 10,
                type: "command",
              },
            ],
            matcher: "startup|resume|clear|compact",
          },
        ],
      },
    })}\n`;
    expect(mergeAgentHookSettings(semanticallyCurrent)).toBe(
      semanticallyCurrent,
    );
    expect(() => mergeAgentHookSettings('{"hooks":[]}\n')).toThrow(
      "hooks property must be a JSON object",
    );
    expect(() =>
      mergeAgentHookSettings(
        '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"aiongside hook stop"}]}]}}\n',
      ),
    ).toThrow("registered under PreToolUse");
  });

  test("installs the managed Agent integration during initialization", async () => {
    const root = await workspace();
    const source = await loadAgentSkillSource();
    const instructions = await loadAgentInstructionsSource();
    const config = await readFile(
      path.join(root, ".aiongside", "config.yaml"),
      "utf8",
    );

    expect(config).toContain("agentSkillVersion: 4");
    for (const target of [
      path.join(root, ".agents", "skills", "aiongside", "SKILL.md"),
      path.join(root, ".claude", "skills", "aiongside", "SKILL.md"),
    ]) {
      expect(await readFile(target, "utf8")).toBe(source);
    }
    expect(
      await readFile(path.join(root, ".aiongside", "instructions.md"), "utf8"),
    ).toBe(instructions);
    for (const target of [
      path.join(root, ".claude", "settings.json"),
      path.join(root, ".codex", "hooks.json"),
    ]) {
      const hooks = await readFile(target, "utf8");
      expect(mergeAgentHookSettings(hooks)).toBe(hooks);
    }
    expect(await pathExists(path.join(root, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(root, "CLAUDE.md"))).toBe(false);
  });

  test("preserves existing Agent entry files and Hook settings on init", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiongside-test-"));
    roots.push(root);
    const agents = "# Team agents\n";
    const claude = "# Team Claude instructions\n";
    const settingsPath = path.join(root, ".claude", "settings.json");
    const settings = `${JSON.stringify(
      {
        permissions: { allow: ["Read"] },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "team stop" }] }],
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(path.join(root, "AGENTS.md"), agents);
    await writeFile(path.join(root, "CLAUDE.md"), claude);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, settings);

    await initializeWorkspace(root);

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(agents);
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(claude);
    const merged = await readFile(settingsPath, "utf8");
    expect(merged).toContain("team stop");
    expect(merged).toContain('"permissions"');
  });

  test("preflights missing, current, older, conflicting, and newer skill targets", async () => {
    const source = await loadAgentSkillSource();

    const olderRoot = await mkdtemp(path.join(tmpdir(), "aiongside-test-"));
    roots.push(olderRoot);
    const olderTarget = path.join(
      olderRoot,
      ".agents",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    await mkdir(path.dirname(olderTarget), { recursive: true });
    await writeFile(
      olderTarget,
      source.replace('aiongside-version: "4"', 'aiongside-version: "3"'),
    );
    await initializeWorkspace(olderRoot);
    expect(await readFile(olderTarget, "utf8")).toBe(source);
    expect(
      await readFile(
        path.join(olderRoot, ".claude", "skills", "aiongside", "SKILL.md"),
        "utf8",
      ),
    ).toBe(source);

    const conflictRoot = await mkdtemp(path.join(tmpdir(), "aiongside-test-"));
    roots.push(conflictRoot);
    const conflictTarget = path.join(
      conflictRoot,
      ".claude",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    await mkdir(path.dirname(conflictTarget), { recursive: true });
    await writeFile(conflictTarget, "# Team skill\n");
    await expect(initializeWorkspace(conflictRoot)).rejects.toMatchObject({
      code: "AIO-SKILL-CONFLICT",
    });
    expect(await readFile(conflictTarget, "utf8")).toBe("# Team skill\n");
    expect(
      await pathExists(path.join(conflictRoot, ".aiongside", "config.yaml")),
    ).toBe(false);
    expect(await pathExists(path.join(conflictRoot, "work"))).toBe(false);

    const newerRoot = await mkdtemp(path.join(tmpdir(), "aiongside-test-"));
    roots.push(newerRoot);
    const newerTarget = path.join(
      newerRoot,
      ".agents",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    const newer = source.replace(
      'aiongside-version: "4"',
      'aiongside-version: "5"',
    );
    await mkdir(path.dirname(newerTarget), { recursive: true });
    await writeFile(newerTarget, newer);
    await expect(initializeWorkspace(newerRoot)).rejects.toMatchObject({
      code: "AIO-SKILL-VERSION",
    });
    expect(await readFile(newerTarget, "utf8")).toBe(newer);
    expect(
      await pathExists(path.join(newerRoot, ".aiongside", "config.yaml")),
    ).toBe(false);

    const hookConflictRoot = await mkdtemp(
      path.join(tmpdir(), "aiongside-test-"),
    );
    roots.push(hookConflictRoot);
    const hookConflictTarget = path.join(
      hookConflictRoot,
      ".codex",
      "hooks.json",
    );
    await mkdir(path.dirname(hookConflictTarget), { recursive: true });
    await writeFile(hookConflictTarget, '{"hooks":[]}\n');
    await expect(initializeWorkspace(hookConflictRoot)).rejects.toMatchObject({
      code: "AIO-HOOK-CONFLICT",
    });
    expect(await readFile(hookConflictTarget, "utf8")).toBe('{"hooks":[]}\n');
    expect(
      await pathExists(
        path.join(hookConflictRoot, ".aiongside", "config.yaml"),
      ),
    ).toBe(false);
    expect(await pathExists(path.join(hookConflictRoot, "work"))).toBe(false);
  });

  test("registers legacy workspaces and keeps current sync byte-stable", async () => {
    const root = await workspace();
    const configPath = path.join(root, ".aiongside", "config.yaml");
    const legacyConfig = (await readFile(configPath, "utf8")).replace(
      "agentSkillVersion: 4\n",
      "",
    );
    await writeFile(configPath, legacyConfig);
    await rm(path.join(root, ".agents"), { recursive: true, force: true });
    await rm(path.join(root, ".claude"), { recursive: true, force: true });

    const registered = await syncAgentSkills(root);
    expect(registered.changes).toEqual([
      {
        path: ".agents/skills/aiongside/SKILL.md",
        action: "created",
      },
      {
        path: ".claude/skills/aiongside/SKILL.md",
        action: "created",
      },
      {
        path: ".claude/settings.json",
        action: "created",
      },
      { path: ".aiongside/config.yaml", action: "updated" },
    ]);
    const managedPaths = [
      configPath,
      path.join(root, ".agents", "skills", "aiongside", "SKILL.md"),
      path.join(root, ".claude", "skills", "aiongside", "SKILL.md"),
      path.join(root, ".aiongside", "instructions.md"),
      path.join(root, ".claude", "settings.json"),
      path.join(root, ".codex", "hooks.json"),
    ];
    const beforeNoOp = await Promise.all(
      managedPaths.map((target) => readFile(target, "utf8")),
    );
    expect((await syncAgentSkills(root)).changes).toEqual([]);
    expect(
      await Promise.all(managedPaths.map((target) => readFile(target, "utf8"))),
    ).toEqual(beforeNoOp);
  });

  test("updates older managed skills and refuses a newer configured version", async () => {
    const root = await workspace();
    const source = await loadAgentSkillSource();
    const skillPath = path.join(
      root,
      ".agents",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    await writeFile(
      skillPath,
      source.replace('aiongside-version: "4"', 'aiongside-version: "3"'),
    );
    expect((await syncAgentSkills(root)).changes).toContainEqual({
      path: ".agents/skills/aiongside/SKILL.md",
      action: "updated",
    });
    expect(await readFile(skillPath, "utf8")).toBe(source);

    const configPath = path.join(root, ".aiongside", "config.yaml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "agentSkillVersion: 4",
        "agentSkillVersion: 5",
      ),
    );
    const before = await readFile(skillPath, "utf8");
    await expect(syncAgentSkills(root)).rejects.toMatchObject({
      code: "AIO-SKILL-VERSION",
    });
    expect(await readFile(skillPath, "utf8")).toBe(before);
  });

  test("rolls back all managed files when skill sync fails", async () => {
    const root = await workspace();
    const configPath = path.join(root, ".aiongside", "config.yaml");
    const legacyConfig = (await readFile(configPath, "utf8")).replace(
      "agentSkillVersion: 4\n",
      "",
    );
    await writeFile(configPath, legacyConfig);
    await rm(path.join(root, ".agents"), { recursive: true, force: true });
    await rm(path.join(root, ".claude"), { recursive: true, force: true });
    writeFailure.target = path.join(
      root,
      ".claude",
      "skills",
      "aiongside",
      "SKILL.md",
    );

    await expect(syncAgentSkills(root)).rejects.toMatchObject({
      code: "AIO-WRITE",
    });
    expect(await readFile(configPath, "utf8")).toBe(legacyConfig);
    expect(
      await pathExists(
        path.join(root, ".agents", "skills", "aiongside", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      await pathExists(
        path.join(root, ".claude", "skills", "aiongside", "SKILL.md"),
      ),
    ).toBe(false);
  });

  test("rolls back skills, instructions, and Hooks as one sync bundle", async () => {
    const root = await workspace();
    const agentsPath = path.join(
      root,
      ".agents",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    const claudeSkillPath = path.join(
      root,
      ".claude",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    const instructionsPath = path.join(root, ".aiongside", "instructions.md");
    const codexHooksPath = path.join(root, ".codex", "hooks.json");
    const changedInstructions = "# Locally changed managed instructions\n";
    await rm(agentsPath);
    await rm(claudeSkillPath);
    await writeFile(instructionsPath, changedInstructions);
    await rm(codexHooksPath);
    writeFailure.target = codexHooksPath;

    await expect(syncAgentSkills(root)).rejects.toMatchObject({
      code: "AIO-WRITE",
    });

    expect(await pathExists(agentsPath)).toBe(false);
    expect(await pathExists(claudeSkillPath)).toBe(false);
    expect(await readFile(instructionsPath, "utf8")).toBe(changedInstructions);
    expect(await pathExists(codexHooksPath)).toBe(false);
  });

  test("keeps user rules while repairing managed instructions and Hooks", async () => {
    const root = await workspace();
    const rulesPath = path.join(root, ".aiongside", "rules.md");
    const instructionsPath = path.join(root, ".aiongside", "instructions.md");
    const codexHooksPath = path.join(root, ".codex", "hooks.json");
    const customRules = "# Team rules\n\nWrite updates in concise English.\n";
    await writeFile(rulesPath, customRules);
    await writeFile(instructionsPath, "# Changed managed instructions\n");
    await rm(codexHooksPath);

    const result = await syncAgentSkills(root);

    expect(await readFile(rulesPath, "utf8")).toBe(customRules);
    expect(await readFile(instructionsPath, "utf8")).toBe(
      await loadAgentInstructionsSource(),
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { path: ".aiongside/instructions.md", action: "updated" },
        { path: ".codex/hooks.json", action: "created" },
      ]),
    );
  });

  test("reports managed skill issues read-only, blocks work, and allows sync recovery", async () => {
    const root = await workspace();
    const source = await loadAgentSkillSource();
    const agentsPath = path.join(
      root,
      ".agents",
      "skills",
      "aiongside",
      "SKILL.md",
    );
    const claudePath = path.join(
      root,
      ".claude",
      "skills",
      "aiongside",
      "SKILL.md",
    );

    await rm(agentsPath);
    const missingBefore = await readFile(claudePath, "utf8");
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-SKILL-MISSING",
        path: ".agents/skills/aiongside/SKILL.md",
      }),
    );
    expect(await readFile(claudePath, "utf8")).toBe(missingBefore);
    await expect(
      createWork(root, "Blocked by skill damage"),
    ).rejects.toMatchObject({
      code: "AIO-WORKSPACE-INVALID",
    });
    await syncAgentSkills(root);

    await writeFile(
      agentsPath,
      source.replace("license: MIT", "license: Unknown"),
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-SKILL-FORMAT" }),
    );
    await writeFile(agentsPath, source);

    await writeFile(
      agentsPath,
      source.replace('aiongside-version: "4"', 'aiongside-version: "3"'),
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-SKILL-OUTDATED" }),
    );
    await syncAgentSkills(root);

    const crlf = source.replaceAll("\n", "\r\n");
    await writeFile(agentsPath, crlf);
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-SKILL-DRIFT",
        path: ".agents/skills/aiongside/SKILL.md",
      }),
    );
    expect(await readFile(agentsPath, "utf8")).toBe(crlf);
    await syncAgentSkills(root);
    expect(await readFile(agentsPath, "utf8")).toBe(source);

    const instructionsPath = path.join(root, ".aiongside", "instructions.md");
    await rm(instructionsPath);
    const beforeInstructionsCheck = await readFile(claudePath, "utf8");
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-INSTRUCTIONS-MISSING",
        path: ".aiongside/instructions.md",
      }),
    );
    expect(await readFile(claudePath, "utf8")).toBe(beforeInstructionsCheck);
    await expect(
      createWork(root, "Blocked by instruction damage"),
    ).rejects.toMatchObject({ code: "AIO-WORKSPACE-INVALID" });
    await syncAgentSkills(root);

    await writeFile(instructionsPath, "# Drifted instructions\n");
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-INSTRUCTIONS-DRIFT" }),
    );
    await syncAgentSkills(root);

    const codexHooksPath = path.join(root, ".codex", "hooks.json");
    await rm(codexHooksPath);
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-HOOK-MISSING",
        path: ".codex/hooks.json",
      }),
    );
    await syncAgentSkills(root);

    await writeFile(codexHooksPath, "{}\n");
    const hookBeforeCheck = await readFile(codexHooksPath, "utf8");
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-HOOK-DRIFT",
        path: ".codex/hooks.json",
      }),
    );
    expect(await readFile(codexHooksPath, "utf8")).toBe(hookBeforeCheck);
    await syncAgentSkills(root);
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("handles initialization, creation, movement, and cancellation", async () => {
    const root = await workspace();
    const created = await createWork(root, "First Work");
    expect(
      await pathExists(path.join(root, "work", created.id, "plan.md")),
    ).toBe(false);
    for (const name of ["references", "deliverables", "evidence"]) {
      expect(await pathExists(path.join(root, "work", created.id, name))).toBe(
        true,
      );
    }
    expect(
      await pathExists(path.join(root, "work", created.id, "reports")),
    ).toBe(false);

    await confirmWork(root, created.id, ["scope", "completion"]);
    const active = await moveWork(root, created.id, "active");
    const cancelled = await cancelWork(root, created.id, {
      cancellationReason: "No longer needed",
    });

    expect(created.id).toBe("AIO-1");
    expect(active.metadata.status).toBe("active");
    expect(cancelled.metadata.status).toBe("cancelled");
    expect(
      await pathExists(path.join(root, "work", created.id, "plan.md")),
    ).toBe(true);
    expect(await validateWorkspace(root)).toEqual([]);
    expect(
      await readFile(path.join(root, "views", "closed.md"), "utf8"),
    ).toContain(created.id);
  });

  test("does not duplicate IDs during concurrent creation", async () => {
    const root = await workspace();
    const records = await Promise.all([
      createWork(root, "One"),
      createWork(root, "Two"),
      createWork(root, "Three"),
    ]);

    expect(records.map((record) => record.id).sort()).toEqual([
      "AIO-1",
      "AIO-2",
      "AIO-3",
    ]);
  });

  test("uses WORK by default and preserves a custom ID prefix", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiongside-default-id-"));
    roots.push(root);

    const config = await initializeWorkspace(root, { name: "Default" });
    const created = await createWork(root, "Default prefix");

    expect(config.idPrefix).toBe("WORK");
    expect(created.id).toBe("WORK-1");

    const customRoot = await mkdtemp(
      path.join(tmpdir(), "aiongside-custom-id-"),
    );
    roots.push(customRoot);
    const custom = await initializeWorkspace(customRoot, {
      name: "Custom",
      idPrefix: "OPS",
    });
    expect(custom.idPrefix).toBe("OPS");
    expect((await createWork(customRoot, "Custom prefix")).id).toBe("OPS-1");
  });

  test("allocates unpadded arbitrary-size IDs and sorts them numerically", async () => {
    const root = await workspace();
    for (const id of ["AIO-10", "AIO-2", "AIO-100", "AIO-1"]) {
      await writeWorkFixture(root, id);
    }
    await rebuildViews(root);

    expect((await listWorks(root)).map((work) => work.metadata.id)).toEqual([
      "AIO-1",
      "AIO-2",
      "AIO-10",
      "AIO-100",
    ]);

    await writeWorkFixture(root, "AIO-9007199254740993");
    await rebuildViews(root);
    expect((await createWork(root, "Beyond safe integer")).id).toBe(
      "AIO-9007199254740994",
    );
  });

  test("creates Overview freshness metadata and ignores Record metadata or CRLF changes", async () => {
    const root = await workspace();
    const work = await createWork(root, "Fresh overview");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const overviewPath = path.join(root, "work", work.id, "overview.md");
    const record = await readFile(recordPath, "utf8");
    const overview = parseMarkdownDocument(await readFile(overviewPath, "utf8"))
      .metadata as { recordBodyDigest?: string };

    expect(overview.recordBodyDigest).toBe(calculateMarkdownBodyDigest(record));
    await confirmWork(root, work.id, ["scope"]);
    expect(await validateWorkspace(root)).toEqual([]);

    const confirmed = await readFile(recordPath, "utf8");
    await writeFile(recordPath, confirmed.replaceAll("\n", "\r\n"));
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("reports stale Overview read-only and blocks ordinary mutations", async () => {
    const root = await workspace();
    const work = await createWork(root, "Stale overview");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const overviewPath = path.join(root, "work", work.id, "overview.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}New confirmed context.\n`,
    );
    const before = await Promise.all([
      readFile(recordPath, "utf8"),
      readFile(overviewPath, "utf8"),
    ]);

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-OVERVIEW-STALE",
        path: `work/${work.id}/overview.md#recordBodyDigest`,
        hint: expect.stringContaining(`work sync ${work.id}`),
      }),
    );
    await expect(confirmWork(root, work.id, ["scope"])).rejects.toMatchObject({
      code: "AIO-WORKSPACE-INVALID",
      message: expect.stringContaining("AIO-OVERVIEW-STALE"),
    });
    expect(
      await Promise.all([
        readFile(recordPath, "utf8"),
        readFile(overviewPath, "utf8"),
      ]),
    ).toEqual(before);
  });

  test("syncs stale Overviews one at a time and preserves Overview body bytes", async () => {
    const root = await workspace();
    const first = await createWork(root, "First stale overview");
    const second = await createWork(root, "Second stale overview");
    const firstRecord = path.join(root, "work", first.id, "record.md");
    const secondRecord = path.join(root, "work", second.id, "record.md");
    const firstOverview = path.join(root, "work", first.id, "overview.md");
    const overviewWithCrlf = (await readFile(firstOverview, "utf8")).replaceAll(
      "\n",
      "\r\n",
    );
    await Promise.all([
      writeFile(firstOverview, overviewWithCrlf),
      writeFile(
        firstRecord,
        `${await readFile(firstRecord, "utf8")}First change.\n`,
      ),
      writeFile(
        secondRecord,
        `${await readFile(secondRecord, "utf8")}Second change.\n`,
      ),
    ]);
    const originalBody = overviewWithCrlf.slice(
      overviewWithCrlf.indexOf("\r\n---\r\n") + "\r\n---".length,
    );

    const synced = await syncWorkOverview(root, first.id);
    const syncedOverview = await readFile(firstOverview, "utf8");
    const syncedBody = syncedOverview.slice(
      syncedOverview.indexOf("\r\n---\r\n") + "\r\n---".length,
    );
    expect(synced).toEqual({
      id: first.id,
      changed: true,
      path: `work/${first.id}/overview.md`,
    });
    expect(syncedBody).toBe(originalBody);
    expect(
      (await validateWorkspace(root)).filter(
        (issue) => issue.code === "AIO-OVERVIEW-STALE",
      ),
    ).toEqual([
      expect.objectContaining({
        path: `work/${second.id}/overview.md#recordBodyDigest`,
      }),
    ]);
    expect(await syncWorkOverview(root, first.id)).toEqual(
      expect.objectContaining({ changed: false }),
    );
    expect(await readFile(firstOverview, "utf8")).toBe(syncedOverview);
  });

  test("validates dependency targets, uniqueness, self-reference, and cycles", async () => {
    const root = await workspace();
    const first = await createWork(root, "First dependency node");
    const second = await createWork(root, "Second dependency node");
    await setNeeds(root, first.id, [first.id, "AIO-999", second.id, second.id]);
    await setNeeds(root, second.id, [first.id]);

    const codes = new Set(
      (await validateWorkspace(root)).map((issue) => issue.code),
    );

    expect(codes).toEqual(
      new Set([
        "AIO-DEPENDENCY-CYCLE",
        "AIO-DEPENDENCY-DUPLICATE",
        "AIO-DEPENDENCY-MISSING",
        "AIO-DEPENDENCY-SELF",
      ]),
    );
  });

  test("preflights dependency additions against the full graph", async () => {
    const root = await workspace();
    const first = await createWork(root, "First dependency node");
    const second = await createWork(root, "Second dependency node");

    await expect(
      addWorkDependency(root, "AIO-999", second.id),
    ).rejects.toMatchObject({ code: "AIO-WORK-NOT-FOUND" });
    await expect(
      addWorkDependency(root, first.id, "AIO-999"),
    ).rejects.toMatchObject({ code: "AIO-DEPENDENCY-MISSING" });
    await expect(
      addWorkDependency(root, first.id, first.id),
    ).rejects.toMatchObject({ code: "AIO-DEPENDENCY-SELF" });

    await addWorkDependency(root, first.id, second.id);
    await expect(
      addWorkDependency(root, first.id, second.id),
    ).rejects.toMatchObject({ code: "AIO-DEPENDENCY-DUPLICATE" });
    await expect(
      addWorkDependency(root, second.id, first.id),
    ).rejects.toMatchObject({ code: "AIO-DEPENDENCY-CYCLE" });
  });

  test("adds normalized dependencies and preserves their order", async () => {
    const root = await workspace();
    const target = await createWork(root, "Dependency target");
    const first = await createWork(root, "First prerequisite");
    const second = await createWork(root, "Second prerequisite");
    const recordPath = path.join(root, "work", target.id, "record.md");
    await writeFile(
      recordPath,
      (await readFile(recordPath, "utf8")).replace(
        /updated: \d{4}-\d{2}-\d{2}/,
        "updated: 2020-01-01",
      ),
    );

    const addedFirst = await addWorkDependency(
      root,
      target.id.toLowerCase(),
      first.id.toLowerCase(),
    );
    await rm(path.join(root, "views", "open.md"));
    const addedSecond = await addWorkDependency(root, target.id, second.id);

    expect(addedFirst).toEqual(
      expect.objectContaining({
        id: target.id,
        dependencyId: first.id,
        action: "add",
        changed: true,
      }),
    );
    expect(addedSecond.needs).toEqual([first.id, second.id]);
    expect(addedSecond.metadata.updated).not.toBe("2020-01-01");
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("removes one dependency and treats an absent relation as a no-op", async () => {
    const root = await workspace();
    const target = await createWork(root, "Dependency target");
    const first = await createWork(root, "First prerequisite");
    const second = await createWork(root, "Second prerequisite");
    await addWorkDependency(root, target.id, first.id);
    await addWorkDependency(root, target.id, second.id);

    const removed = await removeWorkDependency(root, target.id, first.id);
    expect(removed.needs).toEqual([second.id]);
    const paths = [
      path.join(root, "work", target.id, "record.md"),
      path.join(root, "views", "open.md"),
      path.join(root, "views", "closed.md"),
    ];
    const beforeNoOp = await Promise.all(
      paths.map((targetPath) => readFile(targetPath, "utf8")),
    );

    const noOp = await removeWorkDependency(root, target.id, first.id);

    expect(noOp).toEqual(
      expect.objectContaining({
        action: "remove",
        changed: false,
        needs: [second.id],
      }),
    );
    expect(
      await Promise.all(
        paths.map((targetPath) => readFile(targetPath, "utf8")),
      ),
    ).toEqual(beforeNoOp);
  });

  test("protects done dependencies until the work is reopened", async () => {
    const root = await workspace();
    const target = await createWork(root, "Completed dependent work");
    const dependency = await createWork(root, "Completed prerequisite");
    const extra = await createWork(root, "Extra prerequisite");
    await addWorkDependency(root, target.id, dependency.id);
    for (const work of [dependency, target]) {
      await confirmWork(root, work.id, [...allChecks]);
      await moveWork(root, work.id, "done");
    }

    await expect(
      addWorkDependency(root, target.id, extra.id),
    ).rejects.toMatchObject({ code: "AIO-DONE-SEALED" });
    await expect(
      removeWorkDependency(root, target.id, dependency.id),
    ).rejects.toMatchObject({ code: "AIO-DONE-SEALED" });

    await moveWork(root, target.id, "active", {
      reopenReason: "Dependency assumptions changed",
    });
    expect(
      (await removeWorkDependency(root, target.id, dependency.id)).changed,
    ).toBe(true);
    expect((await addWorkDependency(root, target.id, extra.id)).changed).toBe(
      true,
    );
  });

  test("allows only dependency mutations that reduce existing damage", async () => {
    const root = await workspace();
    const target = await createWork(root, "Damaged dependencies");
    const other = await createWork(root, "Unrelated work");
    await setNeeds(root, target.id, ["AIO-999", target.id]);

    await expect(
      addWorkDependency(root, target.id, other.id),
    ).rejects.toMatchObject({ code: "AIO-WORKSPACE-INVALID" });
    await expect(
      removeWorkDependency(root, target.id, other.id),
    ).rejects.toMatchObject({ code: "AIO-WORKSPACE-INVALID" });

    expect(
      (await removeWorkDependency(root, target.id, "AIO-999")).changed,
    ).toBe(true);
    expect(
      new Set((await validateWorkspace(root)).map((issue) => issue.code)),
    ).toEqual(new Set(["AIO-DEPENDENCY-SELF"]));
    expect(
      (await removeWorkDependency(root, target.id, target.id)).changed,
    ).toBe(true);
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("reopens damaged done work before repairing its dependency", async () => {
    const root = await workspace();
    const target = await createWork(root, "Damaged completed work");
    await confirmWork(root, target.id, [...allChecks]);
    await moveWork(root, target.id, "done");
    await setNeeds(root, target.id, ["AIO-999"]);

    const reopened = await moveWork(root, target.id, "active", {
      reopenReason: "Repair an invalid dependency",
    });
    const repaired = await removeWorkDependency(root, target.id, "AIO-999");

    expect(reopened.metadata.status).toBe("active");
    expect(repaired.needs).toEqual([]);
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("rolls back dependency changes when Record or View writes fail", async () => {
    const root = await workspace();
    const target = await createWork(root, "Rollback dependency target");
    const dependency = await createWork(root, "Rollback prerequisite");
    const recordPath = path.join(root, "work", target.id, "record.md");
    const openPath = path.join(root, "views", "open.md");
    const closedPath = path.join(root, "views", "closed.md");
    const paths = [recordPath, openPath, closedPath];
    const before = await Promise.all(
      paths.map((targetPath) => readFile(targetPath, "utf8")),
    );

    for (const failureTarget of [recordPath, closedPath]) {
      writeFailure.target = failureTarget;
      await expect(
        addWorkDependency(root, target.id, dependency.id),
      ).rejects.toMatchObject({ code: "AIO-WRITE" });
      expect(
        await Promise.all(
          paths.map((targetPath) => readFile(targetPath, "utf8")),
        ),
      ).toEqual(before);
    }
  });

  test("requires completed dependencies only before done", async () => {
    const root = await workspace();
    const dependency = await createWork(root, "Required work");
    const dependent = await createWork(root, "Blocked work");
    await setNeeds(root, dependent.id, [dependency.id]);
    expect((await moveWork(root, dependent.id, "active")).metadata.status).toBe(
      "active",
    );
    await confirmWork(root, dependent.id, [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ]);

    await expect(moveWork(root, dependent.id, "done")).rejects.toMatchObject({
      code: "AIO-DEPENDENCY-BLOCKED",
    });

    await confirmWork(root, dependency.id, [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ]);
    await moveWork(root, dependency.id, "done");

    expect((await moveWork(root, dependent.id, "done")).metadata.status).toBe(
      "done",
    );
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("allows active work freely and enforces confirmations for done", async () => {
    const root = await workspace();
    const metadata = await createWork(root, "Gated work");

    expect((await moveWork(root, metadata.id, "active")).metadata.status).toBe(
      "active",
    );

    await expect(moveWork(root, metadata.id, "done")).rejects.toMatchObject({
      code: "AIO-STATE-GATE",
    });
    await confirmWork(root, metadata.id, [
      "scope",
      "completion",
      "verification",
      "outcome",
    ]);
    await expect(moveWork(root, metadata.id, "done")).rejects.toMatchObject({
      code: "AIO-STATE-GATE",
    });
    await confirmWork(root, metadata.id, ["knowledge"]);
    expect((await moveWork(root, metadata.id, "done")).metadata.status).toBe(
      "done",
    );
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("previews required waiting inputs without writing", async () => {
    const root = await workspace();
    const work = await createWork(root, "Wait for approval");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const openPath = path.join(root, "views", "open.md");
    const before = await Promise.all([
      readFile(recordPath, "utf8"),
      readFile(openPath, "utf8"),
    ]);

    const preview = await previewMoveWork(root, work.id, "waiting");

    expect(preview.applied).toBe(false);
    expect(preview.canMove).toBe(false);
    expect(preview.missingInputs.map((input) => input.key)).toEqual([
      "waitingReason",
      "resumeWhen",
    ]);
    expect(
      await Promise.all([
        readFile(recordPath, "utf8"),
        readFile(openPath, "utf8"),
      ]),
    ).toEqual(before);
  });

  test("records explicit transition inputs and rolls back on View failure", async () => {
    const root = await workspace();
    const work = await createWork(root, "Wait safely");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const before = await readFile(recordPath, "utf8");

    await expect(moveWork(root, work.id, "waiting")).rejects.toMatchObject({
      code: "AIO-TRANSITION-INPUT",
    });
    expect(await readFile(recordPath, "utf8")).toBe(before);

    writeFailure.target = path.join(root, "views", "closed.md");
    await expect(
      moveWork(root, work.id, "waiting", {
        waitingReason: "Approval is pending",
        resumeWhen: "Approval is received",
      }),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(await readFile(recordPath, "utf8")).toBe(before);

    const moved = await moveWork(root, work.id, "waiting", {
      waitingReason: "Approval is pending",
      resumeWhen: "Approval is received",
    });
    expect(moved.metadata.transitions.at(-1)).toEqual(
      expect.objectContaining({
        from: "inbox",
        to: "waiting",
        waitingReason: "Approval is pending",
        resumeWhen: "Approval is received",
      }),
    );
  });

  test("treats same-status moves as no-ops for all five statuses", async () => {
    const root = await workspace();
    for (const status of WORK_STATUSES) {
      const work = await createWork(root, `No-op ${status}`);
      await confirmWork(root, work.id, [...allChecks]);
      if (status !== "inbox") {
        await moveWork(root, work.id, status, allTransitionInputs);
      }
      const recordPath = path.join(root, "work", work.id, "record.md");
      const beforeRecord = await readFile(recordPath, "utf8");
      const beforeViews = await Promise.all([
        readFile(path.join(root, "views", "open.md"), "utf8"),
        readFile(path.join(root, "views", "closed.md"), "utf8"),
      ]);

      const result = await moveWork(root, work.id, status, allTransitionInputs);

      expect(result.applied, status).toBe(false);
      expect(await readFile(recordPath, "utf8"), status).toBe(beforeRecord);
      expect(
        await Promise.all([
          readFile(path.join(root, "views", "open.md"), "utf8"),
          readFile(path.join(root, "views", "closed.md"), "utf8"),
        ]),
        status,
      ).toEqual(beforeViews);
    }
  });

  test("detects changed done content and permits changes after reopening", async () => {
    const root = await workspace();
    const work = await createWork(root, "Sealed result");
    await confirmWork(root, work.id, [...allChecks]);
    const completed = await moveWork(root, work.id, "done");
    expect(completed.metadata.completionSeal?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await validateWorkspace(root)).toEqual([]);

    const recordPath = path.join(root, "work", work.id, "record.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}Changed after completion.\n`,
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-DONE-INVALIDATED" }),
    );

    await syncWorkOverview(root, work.id);

    const reopened = await moveWork(root, work.id, "active", {
      reopenReason: "The verified result changed",
    });
    expect(reopened.metadata.completionSeal).toBeNull();
    expect(reopened.metadata.checks).toEqual(
      expect.objectContaining({
        scope: true,
        completion: true,
        verification: false,
        outcome: false,
        knowledge: false,
      }),
    );
    expect(
      (await validateWorkspace(root)).some(
        (issue) => issue.code === "AIO-DONE-INVALIDATED",
      ),
    ).toBe(false);

    await confirmWork(root, work.id, ["verification", "outcome", "knowledge"]);
    await moveWork(root, work.id, "done");
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("allows target done recovery during sync but blocks unrelated damage", async () => {
    const root = await workspace();
    const target = await createWork(root, "Target done work");
    await confirmWork(root, target.id, [...allChecks]);
    await moveWork(root, target.id, "done");
    const recordPath = path.join(root, "work", target.id, "record.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}Changed while done.\n`,
    );

    expect(await syncWorkOverview(root, target.id)).toEqual(
      expect.objectContaining({ changed: true }),
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-DONE-INVALIDATED" }),
    );

    const unrelated = await createWork(root, "Unrelated damage").catch(
      () => undefined,
    );
    expect(unrelated).toBeUndefined();
    await rm(path.join(root, "work", target.id, "evidence"), {
      recursive: true,
    });
    await expect(syncWorkOverview(root, target.id)).rejects.toMatchObject({
      code: "AIO-WORKSPACE-INVALID",
      message: expect.stringContaining("AIO-STRUCTURE-EVIDENCE"),
    });
  });

  test("detects every supporting file change after completion", async () => {
    const cases = [
      {
        name: "added",
        relativePath: ["references", "new.md"],
        prepare: async (_target: string) => {},
        mutate: async (target: string) => writeFile(target, "new source\n"),
      },
      {
        name: "deleted",
        relativePath: ["deliverables", "result.bin"],
        prepare: async (target: string) =>
          writeFile(target, Buffer.from([0x01, 0x02])),
        mutate: async (target: string) => rm(target),
      },
      {
        name: "renamed",
        relativePath: ["evidence", "before.bin"],
        prepare: async (target: string) =>
          writeFile(target, Buffer.from([0x03, 0x04])),
        mutate: async (target: string) =>
          rename(target, path.join(path.dirname(target), "after.bin")),
      },
      {
        name: "binary byte changed",
        relativePath: ["evidence", "measurement.bin"],
        prepare: async (target: string) =>
          writeFile(target, Buffer.from([0x80])),
        mutate: async (target: string) =>
          writeFile(target, Buffer.from([0x81])),
      },
    ];

    for (const testCase of cases) {
      const root = await workspace();
      const work = await createWork(root, `Supporting file ${testCase.name}`);
      const target = path.join(root, "work", work.id, ...testCase.relativePath);
      await testCase.prepare(target);
      await confirmWork(root, work.id, [...allChecks]);
      await moveWork(root, work.id, "done");
      expect(await validateWorkspace(root), testCase.name).toEqual([]);

      await testCase.mutate(target);

      expect(await validateWorkspace(root), testCase.name).toContainEqual(
        expect.objectContaining({ code: "AIO-DONE-INVALIDATED" }),
      );
      await moveWork(root, work.id, "active", {
        reopenReason: `Supporting file ${testCase.name}`,
      });
      expect(
        (await validateWorkspace(root)).some(
          (issue) => issue.code === "AIO-DONE-INVALIDATED",
        ),
        testCase.name,
      ).toBe(false);
    }
  });

  test("preserves Markdown normalization outside supporting directories", async () => {
    const root = await workspace();
    const work = await createWork(root, "Normalized Markdown completion");
    await confirmWork(root, work.id, [...allChecks]);
    await moveWork(root, work.id, "done");
    const overviewPath = path.join(root, "work", work.id, "overview.md");
    const overview = await readFile(overviewPath, "utf8");

    await writeFile(overviewPath, overview.replaceAll("\n", "\r\n"));

    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("keeps Knowledge Registry outside individual completion seals", async () => {
    const root = await workspace();
    const work = await createWork(root, "Shared knowledge boundary");
    await confirmWork(root, work.id, [...allChecks]);
    await moveWork(root, work.id, "done");

    await writeFile(
      path.join(root, "knowledge", "registry.md"),
      "A user-defined Knowledge Registry format\n",
    );

    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("creates an initial seal for a legacy done record", async () => {
    const root = await workspace();
    const work = await createWork(root, "Legacy completion");
    await confirmWork(root, work.id, [...allChecks]);
    await moveWork(root, work.id, "done");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const document = parseMarkdownDocument(await readFile(recordPath, "utf8"));
    const legacyMetadata = document.metadata as Record<string, unknown>;
    delete legacyMetadata.completionSeal;
    await writeFile(
      recordPath,
      formatMarkdownDocument(legacyMetadata, document.body),
    );
    const viewsBeforeMigration = await Promise.all([
      readFile(path.join(root, "views", "open.md"), "utf8"),
      readFile(path.join(root, "views", "closed.md"), "utf8"),
    ]);

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-DONE-INVALIDATED" }),
    );
    const migrated = await moveWork(root, work.id, "done");

    expect(migrated.applied).toBe(true);
    expect(migrated.metadata.completionSeal?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await Promise.all([
        readFile(path.join(root, "views", "open.md"), "utf8"),
        readFile(path.join(root, "views", "closed.md"), "utf8"),
      ]),
    ).toEqual(viewsBeforeMigration);
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("warns about direct and indirect completed dependents when reopening done work", async () => {
    const root = await workspace();
    const first = await createWork(root, "Root dependency");
    const second = await createWork(root, "Direct dependent");
    const third = await createWork(root, "Indirect dependent");
    await setNeeds(root, second.id, [first.id]);
    await setNeeds(root, third.id, [second.id]);
    for (const work of [first, second, third]) {
      await confirmWork(root, work.id, [...allChecks]);
      await moveWork(root, work.id, "done");
    }

    const preview = await previewMoveWork(root, first.id, "active", {
      reopenReason: "The root result changed",
    });

    expect(preview.warnings.join("\n")).toContain(second.id);
    expect(preview.warnings.join("\n")).toContain(third.id);
    const moved = await moveWork(root, first.id, "active", {
      reopenReason: "The root result changed",
    });
    expect(moved.warnings).toEqual(preview.warnings);
    expect(
      (await listWorks(root)).find((work) => work.metadata.id === second.id)
        ?.metadata.status,
    ).toBe("done");
    expect(
      (await listWorks(root)).find((work) => work.metadata.id === third.id)
        ?.metadata.status,
    ).toBe("done");
  });

  test("applies the specified dry-run and move contract to all 25 transitions", async () => {
    const root = await workspace();
    for (const from of WORK_STATUSES) {
      for (const to of WORK_STATUSES) {
        const work = await createWork(root, `${from} to ${to}`);
        await confirmWork(root, work.id, [...allChecks]);
        if (from !== "inbox") {
          await moveWork(root, work.id, from, allTransitionInputs);
        }
        const recordPath = path.join(root, "work", work.id, "record.md");
        const before = await readFile(recordPath, "utf8");

        const preview = await previewMoveWork(
          root,
          work.id,
          to,
          allTransitionInputs,
        );
        expect(preview.requirements, `${from} -> ${to}`).toEqual(
          evaluateTransition(from, to).requirements,
        );
        expect(preview.canMove, `${from} -> ${to}`).toBe(true);
        expect(await readFile(recordPath, "utf8"), `${from} -> ${to}`).toBe(
          before,
        );

        const moved = await moveWork(root, work.id, to, allTransitionInputs);
        expect(moved.metadata.status, `${from} -> ${to}`).toBe(to);
        expect(moved.applied, `${from} -> ${to}`).toBe(from !== to);
      }
    }
    expect(await validateWorkspace(root)).toEqual([]);
  }, 15_000);

  test("detects state and dependency gates bypassed by manual edits", async () => {
    const root = await workspace();
    const dependency = await createWork(root, "Unfinished dependency");
    const dependent = await createWork(root, "Manually started work");
    await setNeeds(root, dependent.id, [dependency.id]);
    const recordPath = path.join(root, "work", dependent.id, "record.md");
    const record = await readFile(recordPath, "utf8");
    await writeFile(
      recordPath,
      record.replace("status: inbox", "status: done"),
    );

    const codes = (await validateWorkspace(root)).map((issue) => issue.code);

    expect(codes).toContain("AIO-STATE-GATE");
    expect(codes).toContain("AIO-DEPENDENCY-BLOCKED");
  });

  test("rejects unknown work checks", async () => {
    const root = await workspace();
    const metadata = await createWork(root, "Unknown check");

    await expect(
      confirmWork(root, metadata.id, ["unsupported"]),
    ).rejects.toMatchObject({ code: "AIO-WORK-CHECK" });
  });

  test("detects a mismatch between Record and directory IDs", async () => {
    const root = await workspace();
    const record = await createWork(root, "Corruption test");
    const recordPath = path.join(root, "work", record.id, "record.md");
    const source = await readFile(recordPath, "utf8");
    await writeFile(recordPath, source.replace("id: AIO-1", "id: AIO-999"));

    const issues = await validateWorkspace(root);

    expect(
      issues.some((issue) => issue.code === "AIO-IDENTITY-DIRECTORY"),
    ).toBe(true);
  });

  test("reports padded work IDs as an identity format error", async () => {
    const root = await workspace();
    const work = await createWork(root, "Padded ID");
    const sourceDirectory = path.join(root, "work", work.id);
    const paddedDirectory = path.join(root, "work", "AIO-001");
    await rename(sourceDirectory, paddedDirectory);
    for (const name of ["record.md", "overview.md"]) {
      const target = path.join(paddedDirectory, name);
      await writeFile(
        target,
        (await readFile(target, "utf8")).replaceAll(work.id, "AIO-001"),
      );
    }

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-IDENTITY-FORMAT" }),
    );
  });

  test("validates Knowledge structure independently from work structure", async () => {
    const root = await workspace();
    const work = await createWork(root, "Multiple structure problems");
    await rm(path.join(root, "knowledge", "registry.md"));
    await rm(path.join(root, "work", work.id, "references"), {
      recursive: true,
    });

    const codes = new Set(
      (await validateWorkspace(root)).map((issue) => issue.code),
    );
    expect(codes).toEqual(
      new Set(["AIO-STRUCTURE-KNOWLEDGE-REGISTRY", "AIO-STRUCTURE-REFERENCES"]),
    );

    const wrongDirectoryRoot = await workspace();
    await rm(path.join(wrongDirectoryRoot, "knowledge"), { recursive: true });
    await writeFile(path.join(wrongDirectoryRoot, "knowledge"), "not a dir");
    expect(await validateWorkspace(wrongDirectoryRoot)).toContainEqual(
      expect.objectContaining({ code: "AIO-STRUCTURE-KNOWLEDGE" }),
    );

    const wrongRegistryRoot = await workspace();
    await rm(path.join(wrongRegistryRoot, "knowledge", "registry.md"));
    await mkdir(path.join(wrongRegistryRoot, "knowledge", "registry.md"));
    expect(await validateWorkspace(wrongRegistryRoot)).toContainEqual(
      expect.objectContaining({
        code: "AIO-STRUCTURE-KNOWLEDGE-REGISTRY",
      }),
    );
  });

  test("validates every supporting directory even with an invalid Record", async () => {
    const root = await workspace();
    const work = await createWork(root, "Damaged support structure");
    const workPath = path.join(root, "work", work.id);
    await rm(path.join(workPath, "references"), { recursive: true });
    await rm(path.join(workPath, "deliverables"), { recursive: true });
    await writeFile(path.join(workPath, "deliverables"), "not a directory");
    await rm(path.join(workPath, "evidence"), { recursive: true });
    const recordPath = path.join(workPath, "record.md");
    await writeFile(
      recordPath,
      (await readFile(recordPath, "utf8")).replace(
        "status: inbox",
        "status: invalid",
      ),
    );

    const codes = new Set(
      (await validateWorkspace(root)).map((issue) => issue.code),
    );
    expect(codes).toEqual(
      new Set([
        "AIO-STRUCTURE-REFERENCES",
        "AIO-STRUCTURE-DELIVERABLES",
        "AIO-STRUCTURE-EVIDENCE",
        "AIO-SCHEMA-RECORD",
      ]),
    );
  });

  test("leaves arbitrary supporting content and Registry text untouched", async () => {
    const root = await workspace();
    const work = await createWork(root, "Opaque supporting content");
    const binaryPath = path.join(
      root,
      "work",
      work.id,
      "evidence",
      "nested",
      "result.bin",
    );
    const registryPath = path.join(root, "knowledge", "registry.md");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, Buffer.from([0x00, 0x80, 0xff]));
    await writeFile(registryPath, "Any user-owned format\n");
    const targets = [
      path.join(root, "work", work.id, "record.md"),
      path.join(root, "views", "open.md"),
      path.join(root, "views", "closed.md"),
      binaryPath,
      registryPath,
    ];
    const before = await Promise.all(targets.map((target) => readFile(target)));

    expect(await validateWorkspace(root)).toEqual([]);

    const after = await Promise.all(targets.map((target) => readFile(target)));
    expect(after).toEqual(before);
  });

  test("blocks mutations when supporting structure is invalid", async () => {
    const root = await workspace();
    const work = await createWork(root, "Blocked support mutation");
    await rm(path.join(root, "work", work.id, "evidence"), {
      recursive: true,
    });
    const targets = [
      path.join(root, "work", work.id, "record.md"),
      path.join(root, "views", "open.md"),
      path.join(root, "views", "closed.md"),
    ];
    const before = await Promise.all(
      targets.map((target) => readFile(target, "utf8")),
    );

    await expect(confirmWork(root, work.id, ["scope"])).rejects.toMatchObject({
      code: "AIO-WORKSPACE-INVALID",
      message: expect.stringContaining("AIO-STRUCTURE-EVIDENCE"),
    });
    expect(
      await Promise.all(targets.map((target) => readFile(target, "utf8"))),
    ).toEqual(before);
  });

  test("does not mutate files during validation", async () => {
    const root = await workspace();
    const record = await createWork(root, "Read-only validation");
    const targets = [
      path.join(root, "work", record.id, "record.md"),
      path.join(root, "views", "open.md"),
      path.join(root, "views", "closed.md"),
    ];
    const before = await Promise.all(
      targets.map((target) => readFile(target, "utf8")),
    );

    expect(await validateWorkspace(root)).toEqual([]);

    const after = await Promise.all(
      targets.map((target) => readFile(target, "utf8")),
    );
    expect(after).toEqual(before);
  });

  test("detects a missing View and regenerates it on mutation", async () => {
    const root = await workspace();
    await rm(path.join(root, "views", "open.md"));

    expect(
      (await validateWorkspace(root)).some(
        (issue) => issue.code === "AIO-STRUCTURE-VIEW",
      ),
    ).toBe(true);

    await createWork(root, "Regenerate View");
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("detects a manually modified View without rewriting it", async () => {
    const root = await workspace();
    await createWork(root, "Manual View edit");
    const viewPath = path.join(root, "views", "open.md");
    const modified = `${await readFile(viewPath, "utf8")}\nManual edit\n`;
    await writeFile(viewPath, modified);

    expect(await validateWorkspace(root)).toContainEqual({
      code: "AIO-VIEW-DRIFT",
      path: "views/open.md",
      message: "Generated View does not match current Records.",
      hint: "Run `aiongside view rebuild`.",
    });
    expect(await readFile(viewPath, "utf8")).toBe(modified);
  });

  test("detects deleted, added, and reordered View rows", async () => {
    const mutations = [
      (source: string) =>
        source
          .split("\n")
          .filter((line) => !line.includes("AIO-1"))
          .join("\n"),
      (source: string) =>
        `${source}| [AIO-999](../work/AIO-999/overview.md) | Invented | inbox | 2026-08-30 |\n`,
      (source: string) => {
        const lines = source.split("\n");
        const first = lines.findIndex((line) => line.includes("AIO-1"));
        const second = lines.findIndex((line) => line.includes("AIO-2"));
        [lines[first], lines[second]] = [
          lines[second] ?? "",
          lines[first] ?? "",
        ];
        return lines.join("\n");
      },
    ];

    for (const mutate of mutations) {
      const root = await workspace();
      await createWork(root, "First row");
      await createWork(root, "Second row");
      const viewPath = path.join(root, "views", "open.md");
      await writeFile(viewPath, mutate(await readFile(viewPath, "utf8")));

      expect(await validateWorkspace(root)).toContainEqual(
        expect.objectContaining({
          code: "AIO-VIEW-DRIFT",
          path: "views/open.md",
        }),
      );
    }
  });

  test("detects stale Views after direct Record metadata changes", async () => {
    const root = await workspace();
    const metadata = await createWork(root, "Stale View");
    const recordPath = path.join(root, "work", metadata.id, "record.md");
    const record = await readFile(recordPath, "utf8");
    await writeFile(
      recordPath,
      record.replace("status: inbox", "status: done"),
    );

    const driftPaths = (await validateWorkspace(root))
      .filter((issue) => issue.code === "AIO-VIEW-DRIFT")
      .map((issue) => issue.path)
      .sort();

    expect(driftPaths).toEqual(["views/closed.md", "views/open.md"]);
  });

  test("treats line ending changes as View drift", async () => {
    const root = await workspace();
    const viewPath = path.join(root, "views", "open.md");
    const source = await readFile(viewPath, "utf8");
    await writeFile(viewPath, source.replaceAll("\n", "\r\n"));

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-VIEW-DRIFT",
        path: "views/open.md",
      }),
    );
  });

  test("defers View comparison until invalid Record metadata is fixed", async () => {
    const root = await workspace();
    const metadata = await createWork(root, "Invalid Record");
    const recordPath = path.join(root, "work", metadata.id, "record.md");
    const record = await readFile(recordPath, "utf8");
    await writeFile(
      recordPath,
      record.replace("status: inbox", "status: invalid"),
    );

    const issues = await validateWorkspace(root);

    expect(issues).toContainEqual(
      expect.objectContaining({ code: "AIO-SCHEMA-RECORD" }),
    );
    expect(issues.some((issue) => issue.code === "AIO-VIEW-DRIFT")).toBe(false);
  });

  test("rebuilds drifted Views from Records", async () => {
    const root = await workspace();
    await createWork(root, "Rebuild View");
    const viewPath = path.join(root, "views", "open.md");
    await writeFile(viewPath, "corrupted\n");

    await rebuildViews(root);

    expect(await validateWorkspace(root)).toEqual([]);
    expect(await readFile(viewPath, "utf8")).toContain("Rebuild View");
  });

  test("refuses to rebuild Views from an invalid Record", async () => {
    const root = await workspace();
    const metadata = await createWork(root, "Invalid rebuild source");
    const recordPath = path.join(root, "work", metadata.id, "record.md");
    const record = await readFile(recordPath, "utf8");
    await writeFile(
      recordPath,
      record.replace("status: inbox", "status: invalid"),
    );

    await expect(rebuildViews(root)).rejects.toMatchObject({
      code: "AIO-WORKSPACE-INVALID",
    });
  });

  test("restores both Views when a rebuild write fails", async () => {
    const root = await workspace();
    await createWork(root, "Rollback View rebuild");
    const openPath = path.join(root, "views", "open.md");
    const closedPath = path.join(root, "views", "closed.md");
    await writeFile(openPath, "previous open\n");
    await writeFile(closedPath, "previous closed\n");
    writeFailure.target = closedPath;

    await expect(rebuildViews(root)).rejects.toMatchObject({
      code: "AIO-WRITE",
    });

    expect(await readFile(openPath, "utf8")).toBe("previous open\n");
    expect(await readFile(closedPath, "utf8")).toBe("previous closed\n");
  });

  test("reopens a cancelled work item with an explicit reason", async () => {
    const root = await workspace();
    const record = await createWork(root, "Cancelled Work");
    await cancelWork(root, record.id, {
      cancellationReason: "Not needed now",
    });

    await expect(moveWork(root, record.id, "active")).rejects.toMatchObject({
      code: "AIO-TRANSITION-INPUT",
    });
    const reopened = await moveWork(root, record.id, "active", {
      reopenReason: "Work is needed again",
    });

    expect(reopened.metadata.status).toBe("active");
  });

  test("moves a work item to trash after a discard preview", async () => {
    const root = await workspace();
    const record = await createWork(root, "Discard test");
    const preview = await previewDiscard(root, record.id);

    expect(preview.files).toContain(`work/${record.id}/record.md`);
    const trashPath = await discardWork(root, record.id, record.id);

    expect(await pathExists(path.join(root, "work", record.id))).toBe(false);
    expect(await pathExists(path.join(root, trashPath))).toBe(true);
    expect(await listWorks(root)).toEqual([]);
  });

  test("creates editable templates and uses customized content", async () => {
    const root = await workspace();
    const templatePath = path.join(
      root,
      ".aiongside",
      "templates",
      "record.md",
    );
    await writeFile(templatePath, "# {{title}}\n\n## Team notes\n");
    await writeFile(
      path.join(root, ".aiongside", "templates", "plan.md"),
      "# Plan for {{title}}\n",
    );

    const record = await createWork(root, "Custom template");
    await confirmWork(root, record.id, ["scope", "completion"]);
    await moveWork(root, record.id, "active");
    const source = await readFile(
      path.join(root, "work", record.id, "record.md"),
      "utf8",
    );
    const plan = await readFile(
      path.join(root, "work", record.id, "plan.md"),
      "utf8",
    );

    expect(source).toContain("# Custom template");
    expect(source).toContain("## Team notes");
    expect(plan).toBe("# Plan for Custom template\n");
  });

  test("preserves a template that exists before initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiongside-test-"));
    roots.push(root);
    const templatePath = path.join(
      root,
      ".aiongside",
      "templates",
      "record.md",
    );
    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(templatePath, "# {{title}}\n\n## Existing team format\n");

    await initializeWorkspace(root);

    expect(await readFile(templatePath, "utf8")).toBe(
      "# {{title}}\n\n## Existing team format\n",
    );
  });

  test("reports a missing required template placeholder", async () => {
    const root = await workspace();
    await writeFile(
      path.join(root, ".aiongside", "templates", "overview.md"),
      "# Static overview\n",
    );

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-TEMPLATE-PLACEHOLDER",
        path: ".aiongside/templates/overview.md",
      }),
    );
  });
});
