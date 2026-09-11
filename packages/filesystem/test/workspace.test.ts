import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  calculateMarkdownBodyDigest,
  createOverviewDocument,
  createRecordDocument,
  evaluateTransition,
  parseMarkdownDocument,
  WORK_STATUSES,
  workMetadataSchema,
} from "@aiongside/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addWorkDependency,
  addWorkKnowledge,
  createKnowledge as createKnowledgeFile,
  createWork,
  discardKnowledge,
  discardWork,
  initializeWorkspace,
  listKnowledge,
  listWorks,
  loadAgentInstructionsSource,
  mergeAgentHookSettings,
  moveWork,
  pathExists,
  previewDiscard,
  previewMoveWork,
  readWorkspaceContext,
  rebuildViews,
  removeWorkDependency,
  removeWorkKnowledge,
  showKnowledge,
  syncAgentIntegration,
  syncWorkOverview,
  validateAgentIntegration,
  validateWorkspace,
} from "../src/index.js";

const writeFailure = vi.hoisted(() => ({ target: "", suffix: "" }));
const renameFailure = vi.hoisted(() => ({ source: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (source: string, destination: string) => {
      if (source === renameFailure.source) {
        renameFailure.source = "";
        throw new Error("Injected rename failure");
      }
      return actual.rename(source, destination);
    },
  };
});

vi.mock("write-file-atomic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("write-file-atomic")>();
  const original = actual.default as (...args: unknown[]) => unknown;
  return {
    ...actual,
    default: (...args: unknown[]) => {
      if (
        args[0] === writeFailure.target ||
        (writeFailure.suffix && String(args[0]).endsWith(writeFailure.suffix))
      ) {
        writeFailure.target = "";
        writeFailure.suffix = "";
        return Promise.reject(new Error("Injected View write failure"));
      }
      return original(...args);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  writeFailure.target = "";
  writeFailure.suffix = "";
  renameFailure.source = "";
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

async function refreshFixtureIndexes(
  root: string,
  directory = "knowledge",
): Promise<void> {
  const children = (
    await readdir(path.join(root, directory), { withFileTypes: true })
  ).filter((entry) => entry.name !== "index.md");
  await writeFile(
    path.join(root, directory, "index.md"),
    "# Routing\n\n" +
      children
        .map(
          (entry) =>
            `- [${entry.name}](<${entry.name}${entry.isDirectory() ? "/" : ""}>)\n`,
        )
        .join(""),
  );
  for (const child of children)
    if (child.isDirectory())
      await refreshFixtureIndexes(root, `${directory}/${child.name}`);
}

async function createKnowledge(
  root: string,
  input: Parameters<typeof createKnowledgeFile>[1],
) {
  const result = await createKnowledgeFile(root, input);
  await refreshFixtureIndexes(root);
  return result;
}

async function registerKnowledge(
  root: string,
  entries: Array<{ key: string; path: string; displayName: string }>,
): Promise<void> {
  for (const entry of entries)
    await createKnowledge(root, { ...entry, path: `${entry.path}.md` });
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

const allTransitionInputs = {
  reopenReason: "The work needs to be reopened",
  waitingReason: "An external response is required",
  resumeWhen: "The response is received",
  waitingResolution: "The external response arrived",
  cancellationReason: "The work is no longer needed",
};

describe("workspace lifecycle", () => {
  test("distinguishes missing Work hashes from mismatched hashes", async () => {
    const root = await workspace();
    const work = await createWork(root, "Missing hash");
    const target = path.join(root, "work", work.id, "overview.md");
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace(/^recordBodyDigest:.*\n/m, ""),
    );
    const body = parseMarkdownDocument(await readFile(target, "utf8")).body;
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-OVERVIEW-STALE",
        message: expect.stringContaining("Missing recordBodyDigest"),
      }),
    );
    await syncWorkOverview(root, work.id);
    expect(parseMarkdownDocument(await readFile(target, "utf8")).body).toBe(
      body,
    );
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("rolls back done state, history, seal and Views after a write failure", async () => {
    const root = await workspace();
    const work = await createWork(root, "Transactional completion");
    const targets = [
      `work/${work.id}/record.md`,
      "views/open.md",
      "views/closed.md",
    ];
    const before = await Promise.all(
      targets.map((target) => readFile(path.join(root, target))),
    );
    for (const target of targets) {
      writeFailure.target = path.join(root, target);
      await expect(moveWork(root, work.id, "done")).rejects.toMatchObject({
        code: "AIO-WRITE",
      });
      expect(
        await Promise.all(
          targets.map((item) => readFile(path.join(root, item))),
        ),
      ).toEqual(before);
      expect(await validateWorkspace(root)).toEqual([]);
    }
  });

  test("seals plan bytes exactly while excluding Overview prose", async () => {
    const root = await workspace();
    const work = await createWork(root, "Exact plan bytes");
    await moveWork(root, work.id, "active");
    await moveWork(root, work.id, "done");
    const plan = path.join(root, "work", work.id, "plan.md");
    await writeFile(
      plan,
      (await readFile(plan, "utf8")).replaceAll("\n", "\r\n"),
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-DONE-INVALIDATED" }),
    );
  });

  test("preserves preexisting rules and unrelated Skills during init", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aiongside-rules-"));
    roots.push(root);
    await mkdir(path.join(root, ".aiongside"), { recursive: true });
    await mkdir(path.join(root, ".agents/skills/custom"), { recursive: true });
    await writeFile(path.join(root, ".aiongside/rules.md"), "Custom rules\r\n");
    await writeFile(
      path.join(root, ".agents/skills/custom/SKILL.md"),
      "Custom skill\n",
    );
    await initializeWorkspace(root);
    expect(await readFile(path.join(root, ".aiongside/rules.md"), "utf8")).toBe(
      "Custom rules\r\n",
    );
    expect(
      await readFile(path.join(root, ".agents/skills/custom/SKILL.md"), "utf8"),
    ).toBe("Custom skill\n");
  });

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
                command: 'aiongside-agent-adapter stop --root "$PWD"',
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
                command: 'aiongside-agent-adapter session-start --root "$PWD"',
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
        '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"aiongside-agent-adapter stop"}]}]}}\n',
      ),
    ).toThrow("registered under PreToolUse");
  });

  test("installs the managed Agent integration during initialization", async () => {
    const root = await workspace();
    expect(await validateAgentIntegration(root)).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, ".aiongside/internal/integration.json"),
          "utf8",
        ),
      ),
    ).toEqual({ schema: 1, version: 6 });
    for (const target of [
      ".agents/skills/aiongside/SKILL.md",
      ".claude/skills/aiongside/SKILL.md",
    ])
      expect(await pathExists(path.join(root, target))).toBe(false);
    const context = await readWorkspaceContext(root);
    expect(context.instructions).toBe(await loadAgentInstructionsSource());
    expect(context.instructions).not.toContain("{{AIONGSIDE_USER_GUIDE_PATH}}");
    const guidePath = JSON.parse(
      context.instructions?.match(
        /local user guide at (".*") and answer/,
      )?.[1] ?? "null",
    );
    expect(path.isAbsolute(guidePath)).toBe(true);
    const guide = await readFile(guidePath, "utf8");
    expect(guide).toContain("# Working with AIongside");
    expect(context.instructions).not.toContain("## Start work");
    expect(context.instructions).not.toContain("context --json");
    expect(context.instructions).toContain("aiongside check --json");
    expect(context.instructions).toContain("aiongside doctor --json");
    for (const name of [
      "record.md",
      "overview.md",
      "plan.md",
      "references/",
      "deliverables/",
      "evidence/",
      "knowledge/index.md",
      "views/open.md",
    ]) {
      expect(context.instructions).toContain(name);
    }
    expect(context.instructions).toContain("link to their files");
    expect(context.instructions).toContain("Read HTML comments");
    expect(context.instructions).toContain("not required sections");
    expect(context).not.toHaveProperty("rules");
    expect(context.instructions).not.toContain("rules.md");
    expect((await readdir(path.join(root, ".aiongside"))).sort()).toEqual([
      "config.yaml",
      "instructions.md",
      "internal",
      "templates",
    ]);
    expect(
      (await readdir(path.join(root, ".aiongside/internal"))).sort(),
    ).toEqual(["integration.json", "trash"]);
    expect(
      await readFile(path.join(root, ".aiongside/config.yaml"), "utf8"),
    ).not.toContain("agentSkillVersion");
  });
  test("creates an empty Knowledge routing index without a Registry", async () => {
    const root = await workspace();
    expect(await readdir(path.join(root, "knowledge"))).toEqual(["index.md"]);
    expect(await listKnowledge(root)).toEqual([]);
    expect(await validateWorkspace(root)).toEqual([]);
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

  test("sync preserves rules and unrelated files, is byte stable, and repairs integration only", async () => {
    const root = await workspace();
    const rulesPath = path.join(root, ".aiongside/rules.md");
    await writeFile(rulesPath, "# User rules\n");
    expect((await syncAgentIntegration(root)).changes).toEqual([]);
    const config = await readFile(path.join(root, ".aiongside/config.yaml"));
    await writeFile(path.join(root, ".aiongside/instructions.md"), "# Drift\n");
    expect(await validateWorkspace(root)).toEqual([]);
    expect(await validateAgentIntegration(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-INSTRUCTIONS-DRIFT" }),
    );
    await createWork(root, "Integration drift does not block work");
    await syncAgentIntegration(root);
    expect(await readFile(rulesPath, "utf8")).toBe("# User rules\n");
    expect(await readFile(path.join(root, ".aiongside/config.yaml"))).toEqual(
      config,
    );
    expect(await validateAgentIntegration(root)).toEqual([]);
  });

  test("upgrades role instructions without rewriting templates or existing Work", async () => {
    const root = await workspace();
    const templatePath = path.join(root, ".aiongside/templates/record.md");
    const template = "# {{title}}\n\n<!-- Team hint. -->\n\n## Team notes\n";
    await writeFile(templatePath, template);
    const work = await createWork(root, "Keep existing content");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const before = await readFile(recordPath);
    await writeFile(
      path.join(root, ".aiongside/internal/integration.json"),
      '{"schema":1,"version":2}\n',
    );
    await writeFile(
      path.join(root, ".aiongside/instructions.md"),
      "# Old instructions\n",
    );

    await syncAgentIntegration(root);

    expect(await readFile(templatePath, "utf8")).toBe(template);
    expect(await readFile(recordPath)).toEqual(before);
    expect((await readWorkspaceContext(root)).instructions).toContain(
      "Document and folder roles",
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(root, ".aiongside/internal/integration.json"),
          "utf8",
        ),
      ),
    ).toEqual({ schema: 1, version: 6 });
    expect(await validateAgentIntegration(root)).toEqual([]);
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("sync preflights conflicts and future versions without writing", async () => {
    const root = await workspace();
    const instructionsPath = path.join(root, ".aiongside/instructions.md");
    await writeFile(instructionsPath, "# Keep on failure\n");
    const settingsPath = path.join(root, ".codex/hooks.json");
    const previous = await readFile(settingsPath);
    await writeFile(settingsPath, "{broken");
    await expect(syncAgentIntegration(root)).rejects.toMatchObject({
      code: "AIO-HOOK-CONFLICT",
    });
    expect(await readFile(instructionsPath, "utf8")).toBe(
      "# Keep on failure\n",
    );
    await writeFile(settingsPath, previous);
    await writeFile(
      path.join(root, ".aiongside/internal/integration.json"),
      '{"schema":1,"version":999}\n',
    );
    await expect(syncAgentIntegration(root)).rejects.toMatchObject({
      code: "AIO-INTEGRATION-VERSION",
    });
    expect(await readFile(instructionsPath, "utf8")).toBe(
      "# Keep on failure\n",
    );
  });

  test.each(["create", "discard-work", "discard-knowledge", "upgrade"])(
    "rejects an internal directory symlink before %s writes",
    async (operation) => {
      const root = await workspace();
      const work = await createWork(root, "Preserve this Work");
      await createKnowledge(root, { key: "preserve-topic" });
      const internal = path.join(root, ".aiongside/internal");
      const saved = path.join(root, "saved-internal");
      await rename(internal, saved);
      await symlink(saved, internal);
      const before = await readdir(saved);
      const action =
        operation === "create"
          ? createWork(root, "Rejected Work")
          : operation === "discard-work"
            ? discardWork(root, work.id, work.id)
            : operation === "discard-knowledge"
              ? discardKnowledge(root, "preserve-topic", "preserve-topic")
              : syncAgentIntegration(root);
      await expect(action).rejects.toMatchObject({
        code:
          operation === "upgrade"
            ? "AIO-INSTRUCTIONS-CONFLICT"
            : "AIO-INTERNAL-CONFLICT",
      });
      expect(await readdir(saved)).toEqual(before);
      expect(await listWorks(root)).toHaveLength(1);
      expect(
        await pathExists(path.join(root, "knowledge/preserve-topic.md")),
      ).toBe(true);
      expect(await validateWorkspace(root)).toEqual([]);
    },
  );

  test("ignores a legacy rules path even when it is not a readable file", async () => {
    const root = await workspace();
    await mkdir(path.join(root, ".aiongside/rules.md"));
    const context = await readWorkspaceContext(root);
    expect(context.ok).toBe(true);
    expect(context.issues).toEqual([]);
    expect(context).not.toHaveProperty("rules");
  });

  test("sync rolls back all managed writes", async () => {
    const root = await workspace();
    const paths = [
      ".aiongside/instructions.md",
      ".claude/settings.json",
      ".codex/hooks.json",
    ];
    for (const relative of paths)
      await writeFile(
        path.join(root, relative),
        relative.endsWith(".json") ? "{}\n" : "# Drift\n",
      );
    const before = await Promise.all(
      paths.map((relative) => readFile(path.join(root, relative))),
    );
    writeFailure.target = path.join(root, ".codex/hooks.json");
    await expect(syncAgentIntegration(root)).rejects.toMatchObject({
      code: "AIO-WRITE",
    });
    expect(
      await Promise.all(
        paths.map((relative) => readFile(path.join(root, relative))),
      ),
    ).toEqual(before);
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

    const active = await moveWork(root, created.id, "active");
    const cancelled = await moveWork(root, created.id, "cancelled", {
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
    await expect(moveWork(root, work.id, "active")).rejects.toMatchObject({
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

  test("adds, removes, and safely repeats Work Knowledge relationships", async () => {
    const root = await workspace();
    const work = await createWork(root, "Knowledge-linked work");
    await registerKnowledge(root, [
      {
        key: "incident-response",
        path: "operations/incident-response",
        displayName: "Incident response",
      },
    ]);

    await moveWork(root, work.id, "done");
    const added = await addWorkKnowledge(root, work.id, "Incident-Response");
    expect(added).toEqual(
      expect.objectContaining({
        id: work.id,
        key: "incident-response",
        path: "operations/incident-response.md",
        changed: true,
        knowledge: ["incident-response"],
      }),
    );
    expect(added.metadata).not.toHaveProperty("checks");

    const recordPath = path.join(root, "work", work.id, "record.md");
    const views = [
      path.join(root, "views", "open.md"),
      path.join(root, "views", "closed.md"),
    ];
    const beforeDuplicate = await Promise.all(
      [recordPath, ...views].map((target) => readFile(target)),
    );
    expect(
      (await addWorkKnowledge(root, work.id, "incident-response")).changed,
    ).toBe(false);
    expect(
      await Promise.all(
        [recordPath, ...views].map((target) => readFile(target)),
      ),
    ).toEqual(beforeDuplicate);

    expect(
      (await removeWorkKnowledge(root, work.id, "incident-response")).changed,
    ).toBe(true);
    const beforeAbsent = await readFile(recordPath);
    expect(
      (await removeWorkKnowledge(root, work.id, "incident-response")).changed,
    ).toBe(false);
    expect(await readFile(recordPath)).toEqual(beforeAbsent);
  });

  test("allows relationship editing only for done Work with valid Knowledge keys", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    const work = await createWork(root, "Relationships after completion");
    await expect(
      addWorkKnowledge(root, work.id, "operations"),
    ).rejects.toMatchObject({ code: "AIO-WORK-KNOWLEDGE-STATUS" });
    await expect(
      removeWorkKnowledge(root, work.id, "operations"),
    ).rejects.toMatchObject({ code: "AIO-WORK-KNOWLEDGE-STATUS" });
    await moveWork(root, work.id, "done");
    await expect(
      addWorkKnowledge(root, work.id, "missing"),
    ).rejects.toMatchObject({ code: "AIO-WORK-KNOWLEDGE-MISSING" });
    await addWorkKnowledge(root, work.id, "operations");
    expect(await validateWorkspace(root)).toEqual([]);
  });
  test("keeps Work contribution keys when a document moves directly", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "incident-response" });
    const work = await createWork(root, "Move document");
    await moveWork(root, work.id, "done");
    await addWorkKnowledge(root, work.id, "incident-response");
    const before = await readFile(
      path.join(root, "work", work.id, "record.md"),
    );
    await rename(
      path.join(root, "knowledge/incident-response.md"),
      path.join(root, "knowledge/renamed.md"),
    );
    await refreshFixtureIndexes(root);
    expect((await showKnowledge(root, "incident-response")).path).toBe(
      "renamed.md",
    );
    expect(
      await readFile(path.join(root, "work", work.id, "record.md")),
    ).toEqual(before);
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("requires completed dependencies only before done", async () => {
    const root = await workspace();
    const dependency = await createWork(root, "Required work");
    const dependent = await createWork(root, "Blocked work");
    await setNeeds(root, dependent.id, [dependency.id]);
    expect((await moveWork(root, dependent.id, "active")).metadata.status).toBe(
      "active",
    );

    await expect(moveWork(root, dependent.id, "done")).rejects.toMatchObject({
      code: "AIO-DEPENDENCY-BLOCKED",
    });

    await moveWork(root, dependency.id, "done");

    expect((await moveWork(root, dependent.id, "done")).metadata.status).toBe(
      "done",
    );
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test.each(WORK_STATUSES)(
    "reports only unsatisfied completion dependencies when a prerequisite is %s",
    async (status) => {
      const root = await workspace();
      const completed = await createWork(root, "Completed prerequisite");
      const candidate = await createWork(root, "Other prerequisite");
      const dependent = await createWork(root, "Dependent work");
      await moveWork(root, completed.id, "done");
      if (status !== "inbox") {
        await moveWork(root, candidate.id, status, {
          waitingReason: "Awaiting confirmation",
          resumeWhen: "Confirmation arrives",
          cancellationReason: "Prerequisite was cancelled",
        });
      }
      await addWorkDependency(root, dependent.id, completed.id);
      await addWorkDependency(root, dependent.id, candidate.id);
      const recordPath = path.join(root, "work", dependent.id, "record.md");
      const before = await readFile(recordPath, "utf8");
      const preview = await previewMoveWork(root, dependent.id, "done");
      expect(await readFile(recordPath, "utf8")).toBe(before);
      expect(preview.requiredInputs.map((input) => input.key)).toEqual(
        status === "done" ? [] : [`needs.${candidate.id}`],
      );
      expect(preview.missingInputs).toEqual(preview.requiredInputs);
      expect(preview.canMove).toBe(status === "done");

      if (status !== "done") {
        if (status === "cancelled") {
          expect(preview.requiredInputs[0]?.question).toContain("cancelled");
          expect(preview.requiredInputs[0]?.hint).toContain(
            "If this prerequisite is no longer required",
          );
          expect(preview.requiredInputs[0]?.hint).toContain(
            `aiongside work needs remove ${dependent.id} ${candidate.id}`,
          );
        }
        await expect(
          moveWork(root, dependent.id, "done"),
        ).rejects.toMatchObject({
          code: "AIO-DEPENDENCY-BLOCKED",
        });
        expect(await readFile(recordPath, "utf8")).toBe(before);
        await removeWorkDependency(root, dependent.id, candidate.id);
      }

      const done = await moveWork(root, dependent.id, "done");
      expect(done.applied).toBe(true);
      expect(done.requiredInputs).toEqual([]);
      expect(done.missingInputs).toEqual([]);
      const repeated = await moveWork(root, dependent.id, "done");
      expect(repeated.applied).toBe(false);
      expect(repeated.requiredInputs).toEqual([]);
      expect(await validateWorkspace(root)).toEqual([]);
    },
  );

  test("keeps missing prerequisites in completion questions", async () => {
    const root = await workspace();
    const dependent = await createWork(root, "Missing prerequisite");
    await setNeeds(root, dependent.id, ["AIO-999"]);
    const preview = await previewMoveWork(root, dependent.id, "done");
    expect(preview.canMove).toBe(false);
    expect(preview.requiredInputs).toEqual([
      expect.objectContaining({
        key: "needs.AIO-999",
        code: "AIO-DEPENDENCY-BLOCKED",
        question: expect.stringContaining("is missing"),
      }),
    ]);
    await expect(moveWork(root, dependent.id, "done")).rejects.toMatchObject({
      code: "AIO-WORKSPACE-INVALID",
    });
  });

  test("completes arbitrary Korean content without confirmations or template matching", async () => {
    const root = await workspace();
    await writeFile(
      path.join(root, ".aiongside/templates/record.md"),
      "\uc608\uc57d \uc644\ub8cc.\n- [ ] \ub098\uc911\uc5d0 \ud560 \uc120\ud0dd \uc0ac\ud56d\n{{unknown}}\n",
    );
    const work = await createWork(root, "\uc7a5\uc18c \uc608\uc57d");
    await moveWork(root, work.id, "active");
    const done = await moveWork(root, work.id, "done");
    expect(done.metadata).not.toHaveProperty("checks");
    expect(done.postActions).toEqual([
      expect.objectContaining({ kind: "knowledge-update", workId: work.id }),
    ]);
    expect(await validateWorkspace(root)).toEqual([]);
  });
  test("returns Knowledge guidance only after an actual successful done move", async () => {
    const root = await workspace();
    const work = await createWork(root, "One-time guidance");
    const preview = await previewMoveWork(root, work.id, "done");
    expect(preview.canMove).toBe(true);
    expect(preview.postActions).toBeUndefined();
    expect(preview.requiredInputs).toEqual([]);
    const done = await moveWork(root, work.id, "done");
    expect(done.postActions?.[0]?.message).toContain("no further action");
    expect((await moveWork(root, work.id, "done")).postActions).toBeUndefined();
    expect(await validateWorkspace(root)).toEqual([]);
  });
  test("preserves Knowledge on reopening and excludes relationship edits from the seal", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    const work = await createWork(root, "Repeat completion");
    await moveWork(root, work.id, "done");
    const linked = await addWorkKnowledge(root, work.id, "operations");
    const seal = linked.metadata.completionSeal;
    expect(await validateWorkspace(root)).toEqual([]);
    const reopened = await moveWork(root, work.id, "active", {
      reopenReason: "Correction",
    });
    expect(reopened.metadata.knowledge).toEqual(["operations"]);
    expect(reopened.metadata.completionSeal).toBeNull();
    const repeated = await moveWork(root, work.id, "done");
    expect(repeated.postActions?.[0]?.targets).toEqual([
      {
        key: "operations",
        path: "operations.md",
      },
    ]);
    const removed = await removeWorkKnowledge(root, work.id, "operations");
    expect(removed.metadata.completionSeal).toEqual(
      repeated.metadata.completionSeal,
    );
    expect(seal).not.toBeNull();
    expect(JSON.stringify(removed.metadata)).not.toMatch(
      /checks|review|revision|resolved/,
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
    expect(reopened.metadata).not.toHaveProperty("checks");
    expect(
      (await validateWorkspace(root)).some(
        (issue) => issue.code === "AIO-DONE-INVALIDATED",
      ),
    ).toBe(false);

    await moveWork(root, work.id, "done");
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("sync preserves completion errors and ignores supporting structure damage", async () => {
    const root = await workspace();
    const target = await createWork(root, "Target done work");

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
    expect(await syncWorkOverview(root, target.id)).toMatchObject({
      changed: false,
    });
    expect(await validateWorkspace(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "AIO-DONE-INVALIDATED" }),
        expect.objectContaining({ code: "AIO-STRUCTURE-EVIDENCE" }),
      ]),
    );
  });

  test("sync breaks the stale Overview and reopened dependency recovery deadlock", async () => {
    const root = await workspace();
    const prerequisite = await createWork(root, "Venue");
    const dependent = await createWork(root, "Workshop");
    await addWorkDependency(root, dependent.id, prerequisite.id);
    await moveWork(root, prerequisite.id, "done");
    const completed = await moveWork(root, dependent.id, "done");
    await moveWork(root, prerequisite.id, "active", {
      reopenReason: "Recheck venue",
    });
    const recordPath = path.join(root, "work", prerequisite.id, "record.md");
    const record = `${await readFile(recordPath, "utf8")}Availability needs checking.\n`;
    await writeFile(recordPath, record);
    const dependentPath = path.join(root, "work", dependent.id, "record.md");
    const dependentBefore = await readFile(dependentPath, "utf8");
    const views = await Promise.all(
      ["open", "closed"].map((name) =>
        readFile(path.join(root, "views", `${name}.md`), "utf8"),
      ),
    );
    expect(await validateWorkspace(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "AIO-OVERVIEW-STALE" }),
        expect.objectContaining({ code: "AIO-DEPENDENCY-BLOCKED" }),
      ]),
    );

    expect(await syncWorkOverview(root, prerequisite.id)).toMatchObject({
      changed: true,
    });
    expect(await readFile(recordPath, "utf8")).toBe(record);
    expect(await readFile(dependentPath, "utf8")).toBe(dependentBefore);
    expect(
      await Promise.all(
        ["open", "closed"].map((name) =>
          readFile(path.join(root, "views", `${name}.md`), "utf8"),
        ),
      ),
    ).toEqual(views);
    expect(
      (await listWorks(root)).find((work) => work.metadata.id === dependent.id)
        ?.metadata.completionSeal,
    ).toEqual(completed.metadata.completionSeal);
    expect(await validateWorkspace(root)).toEqual([
      expect.objectContaining({ code: "AIO-DEPENDENCY-BLOCKED" }),
    ]);
    await moveWork(root, dependent.id, "active", {
      reopenReason: "Recheck preparation",
    });
    expect(await validateWorkspace(root)).toEqual([]);
    await expect(moveWork(root, dependent.id, "done")).rejects.toMatchObject({
      code: "AIO-DEPENDENCY-BLOCKED",
    });
  });

  test("sync ignores unrelated malformed records and Knowledge metadata", async () => {
    const root = await workspace();
    const target = await createWork(root, "Sync target");
    const other = await createWork(root, "Unrelated work");
    const otherPath = path.join(root, "work", other.id, "record.md");
    await writeFile(
      otherPath,
      "---\ninvalid: [\n---\nKeep this damaged record.\n",
    );
    const knowledgePath = path.join(root, "knowledge", "unkeyed.md");
    await writeFile(knowledgePath, "# User knowledge without metadata\n");
    const recordPath = path.join(root, "work", target.id, "record.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}New result.\n`,
    );
    const issuesBefore = (await validateWorkspace(root)).filter(
      (issue) => issue.code !== "AIO-OVERVIEW-STALE",
    );
    expect(issuesBefore.length).toBeGreaterThan(0);
    expect(await syncWorkOverview(root, target.id.toLowerCase())).toMatchObject(
      { changed: true },
    );
    expect(await validateWorkspace(root)).toEqual(issuesBefore);
    expect(await readFile(knowledgePath, "utf8")).toBe(
      "# User knowledge without metadata\n",
    );
    expect(await readFile(otherPath, "utf8")).toContain("invalid: [");
  });

  test("sync preserves all metadata values except the recorded body hash", async () => {
    const root = await workspace();
    const target = await createWork(root, "Target");
    const overviewPath = path.join(root, "work", target.id, "overview.md");
    await writeFile(
      overviewPath,
      (await readFile(overviewPath, "utf8")).replace(
        "title: Target",
        'title: " Target "\ncustom: { owner: user, enabled: false }',
      ),
    );
    const before = parseMarkdownDocument(await readFile(overviewPath, "utf8"))
      .metadata as Record<string, unknown>;
    const recordPath = path.join(root, "work", target.id, "record.md");
    const record = `${await readFile(recordPath, "utf8")}New content.\n`;
    await writeFile(recordPath, record);
    await syncWorkOverview(root, target.id);
    expect(
      parseMarkdownDocument(await readFile(overviewPath, "utf8")).metadata,
    ).toEqual({
      ...before,
      recordBodyDigest: calculateMarkdownBodyDigest(record),
    });
  });

  test.each(["record.md", "overview.md"])(
    "sync refuses a missing target %s",
    async (name) => {
      const root = await workspace();
      const target = await createWork(root, "Target");
      const document = path.join(root, "work", target.id, name);
      await rename(document, `${document}.saved`);
      await expect(syncWorkOverview(root, target.id)).rejects.toMatchObject({
        code:
          name === "record.md"
            ? "AIO-STRUCTURE-RECORD"
            : "AIO-STRUCTURE-OVERVIEW",
      });
      expect(await pathExists(document)).toBe(false);
    },
  );

  test.each([
    ["record.md", "id: AIO-1", "id: AIO-2", "AIO-IDENTITY-DIRECTORY"],
    ["record.md", "schema: 1", "schema: 99", "AIO-SCHEMA-RECORD"],
    ["overview.md", "id: AIO-1", "id: AIO-2", "AIO-IDENTITY-OVERVIEW"],
    [
      "overview.md",
      "title: Target",
      "title: Wrong",
      "AIO-IDENTITY-OVERVIEW-TITLE",
    ],
    ["overview.md", "schema: 1", "schema: 99", "AIO-SCHEMA-OVERVIEW"],
  ])(
    "sync rejects unsafe target metadata in %s (%s)",
    async (file, from, to, code) => {
      const root = await workspace();
      const target = await createWork(root, "Target");
      const directory = path.join(root, "work", target.id);
      const document = path.join(directory, file);
      await writeFile(
        document,
        (await readFile(document, "utf8")).replace(from, to),
      );
      const before = await Promise.all(
        ["record.md", "overview.md"].map((name) =>
          readFile(path.join(directory, name), "utf8"),
        ),
      );
      await expect(syncWorkOverview(root, target.id)).rejects.toMatchObject({
        code,
      });
      expect(
        await Promise.all(
          ["record.md", "overview.md"].map((name) =>
            readFile(path.join(directory, name), "utf8"),
          ),
        ),
      ).toEqual(before);
    },
  );

  test.each([
    "work",
    "work/AIO-1",
    "work/AIO-1/record.md",
    "work/AIO-1/overview.md",
  ])("sync rejects symbolic links at %s", async (relativeTarget) => {
    const root = await workspace();
    const target = await createWork(root, "Target");
    const outside = await mkdtemp(
      path.join(tmpdir(), "aiongside-sync-outside-"),
    );
    roots.push(outside);
    const original = path.join(root, relativeTarget);
    const moved = path.join(outside, "original");
    await rename(original, moved);
    await symlink(moved, original);
    const overview =
      relativeTarget === "work"
        ? path.join(moved, target.id, "overview.md")
        : relativeTarget === "work/AIO-1"
          ? path.join(moved, "overview.md")
          : relativeTarget.endsWith("overview.md")
            ? moved
            : path.join(root, "work", target.id, "overview.md");
    const before = await readFile(overview, "utf8");
    await expect(syncWorkOverview(root, target.id)).rejects.toMatchObject({
      code: relativeTarget.endsWith("overview.md")
        ? "AIO-STRUCTURE-OVERVIEW"
        : "AIO-STRUCTURE-RECORD",
    });
    expect(await readFile(overview, "utf8")).toBe(before);
  });

  test("sync rejects invalid paths and mismatched prefixes and preserves failed writes", async () => {
    const root = await workspace();
    const target = await createWork(root, "Target");
    await expect(syncWorkOverview(root, "../AIO-1")).rejects.toMatchObject({
      code: "AIO-IDENTITY-FORMAT",
    });
    await expect(syncWorkOverview(root, "AIO-999")).rejects.toMatchObject({
      code: "AIO-WORK-NOT-FOUND",
    });
    const configPath = path.join(root, ".aiongside", "config.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace("idPrefix: AIO", "idPrefix: WORK"),
    );
    await expect(syncWorkOverview(root, target.id)).rejects.toMatchObject({
      code: "AIO-IDENTITY-PREFIX",
    });
    await writeFile(configPath, config);
    const recordPath = path.join(root, "work", target.id, "record.md");
    await writeFile(
      recordPath,
      `${await readFile(recordPath, "utf8")}New result.\n`,
    );
    const overviewPath = path.join(root, "work", target.id, "overview.md");
    const before = await readFile(overviewPath, "utf8");
    writeFailure.target = overviewPath;
    await expect(syncWorkOverview(root, target.id)).rejects.toMatchObject({
      code: "AIO-WRITE",
    });
    expect(await readFile(overviewPath, "utf8")).toBe(before);
    expect(await syncWorkOverview(root, target.id)).toMatchObject({
      changed: true,
    });
    expect(await syncWorkOverview(root, target.id)).toMatchObject({
      changed: false,
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

    await moveWork(root, work.id, "done");
    const overviewPath = path.join(root, "work", work.id, "overview.md");
    const overview = await readFile(overviewPath, "utf8");

    await writeFile(overviewPath, overview.replaceAll("\n", "\r\n"));

    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("preserves shared Knowledge outside Work mutations and completion seals", async () => {
    const root = await workspace();
    await createKnowledge(root, {
      key: "publishing",
      path: "content/publishing.md",
    });
    const target = path.join(root, "knowledge/content/publishing.md");
    const before = await readFile(target, "utf8");
    const work = await createWork(root, "Shared Knowledge boundary");
    await moveWork(root, work.id, "done");
    expect(await readFile(target, "utf8")).toBe(before);
    await writeFile(target, `${before}\nUpdated reusable content.\n`);
    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("requires reopening to restore a missing seal", async () => {
    const root = await workspace();
    const work = await createWork(root, "Missing seal");
    const target = path.join(root, "work", work.id, "record.md");
    await writeFile(
      target,
      (await readFile(target, "utf8")).replace("status: inbox", "status: done"),
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-DONE-INVALIDATED",
        hint: expect.stringContaining("--reopen-reason"),
      }),
    );
    await moveWork(root, work.id, "active", { reopenReason: "Restore seal" });
    await moveWork(root, work.id, "done");
    expect(await validateWorkspace(root)).toEqual([]);
  });
  test("excludes Overview prose from completion seals", async () => {
    const root = await workspace();
    const work = await createWork(root, "Overview outside seal");
    await moveWork(root, work.id, "done");
    const overview = path.join(root, "work", work.id, "overview.md");
    await writeFile(
      overview,
      `${await readFile(overview, "utf8")}\nMore navigation.\n`,
    );
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

    expect(codes).not.toContain("AIO-STATE-GATE");
    expect(codes).toContain("AIO-DEPENDENCY-BLOCKED");
  });

  test("writes the current model without confirmation fields", async () => {
    const root = await workspace();
    const work = await createWork(root, "Current metadata");
    expect(work).not.toHaveProperty("checks");
    const source = await readFile(
      path.join(root, "work", work.id, "record.md"),
      "utf8",
    );
    expect(source).not.toContain("checks:");
    expect(workMetadataSchema.safeParse({ ...work, schema: 2 }).success).toBe(
      false,
    );
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
    await rm(path.join(root, "knowledge", "index.md"));
    await rm(path.join(root, "work", work.id, "references"), {
      recursive: true,
    });

    const codes = new Set(
      (await validateWorkspace(root)).map((issue) => issue.code),
    );
    expect(codes).toEqual(
      new Set(["AIO-KNOWLEDGE-INDEX-MISSING", "AIO-STRUCTURE-REFERENCES"]),
    );

    const wrongDirectoryRoot = await workspace();
    await rm(path.join(wrongDirectoryRoot, "knowledge"), { recursive: true });
    await writeFile(path.join(wrongDirectoryRoot, "knowledge"), "not a dir");
    expect(await validateWorkspace(wrongDirectoryRoot)).toContainEqual(
      expect.objectContaining({ code: "AIO-STRUCTURE-KNOWLEDGE" }),
    );

    const wrongRegistryRoot = await workspace();
    await rm(path.join(wrongRegistryRoot, "knowledge", "index.md"));
    await mkdir(path.join(wrongRegistryRoot, "knowledge", "index.md"));
    expect(await validateWorkspace(wrongRegistryRoot)).toContainEqual(
      expect.objectContaining({
        code: "AIO-KNOWLEDGE-INDEX-MISSING",
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

  test("leaves arbitrary supporting content and Registry prose untouched", async () => {
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
    const registryPath = path.join(root, "knowledge", "index.md");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, Buffer.from([0x00, 0x80, 0xff]));
    await writeFile(
      registryPath,
      "# Custom registry\n\nUser prose.\n\n| Key | Path | Parent | Display name |\n| --- | --- | --- | --- |\n\nMore user prose.\n",
    );
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

    await expect(moveWork(root, work.id, "active")).rejects.toMatchObject({
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
      hint: "Run `aiongside view sync`.",
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
    await moveWork(root, record.id, "cancelled", {
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

  test("permits arbitrary templates and limits missing templates to creation", async () => {
    const root = await workspace();
    await writeFile(
      path.join(root, ".aiongside/templates/overview.md"),
      "\uc124\uba85\ub9cc \uc788\uc74c. {{custom}}\n",
    );
    const work = await createWork(root, "Free template");
    expect(
      await readFile(path.join(root, "work", work.id, "overview.md"), "utf8"),
    ).toContain("{{custom}}");
    await rm(path.join(root, ".aiongside/templates/record.md"));
    expect(await validateWorkspace(root)).toEqual([]);
    await moveWork(root, work.id, "done");
    await expect(
      createWork(root, "Missing creation template"),
    ).rejects.toMatchObject({ code: "AIO-TEMPLATE-READ" });
  });
});
