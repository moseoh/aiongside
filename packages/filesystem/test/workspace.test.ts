import { createHash } from "node:crypto";
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
  formatMarkdownDocument,
  parseMarkdownDocument,
  WORK_STATUSES,
  workMetadataSchema,
} from "@aiongside/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addWorkDependency,
  addWorkKnowledge,
  cancelWork,
  confirmWork,
  createKnowledge,
  createWork,
  discardKnowledge,
  discardWork,
  getKnowledgeTree,
  initializeWorkspace,
  listKnowledge,
  listWorks,
  loadAgentInstructionsSource,
  loadAgentSkillSource,
  mergeAgentHookSettings,
  moveKnowledge,
  moveWork,
  pathExists,
  previewDiscard,
  previewDiscardKnowledge,
  previewMoveKnowledge,
  previewMoveWork,
  rebuildViews,
  removeWorkDependency,
  removeWorkKnowledge,
  showKnowledge,
  syncAgentSkills,
  syncKnowledgeOverview,
  syncWorkOverview,
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

describe("Knowledge topic mutations", () => {
  test("creates default and nested topics while preserving Registry prose", async () => {
    const root = await workspace();
    const registryPath = path.join(root, "knowledge", "registry.md");
    const registry = await readFile(registryPath, "utf8");
    await writeFile(
      registryPath,
      registry.replace(
        "# Knowledge registry\n",
        "# Knowledge registry\n\nOwner notes.\n",
      ),
    );

    const parent = await createKnowledge(root, { key: "operations" });
    const child = await createKnowledge(root, {
      key: "incident-response",
      parent: "operations",
      displayName: "Incident response",
    });

    expect(parent).toEqual(
      expect.objectContaining({
        key: "operations",
        path: "operations",
        parent: null,
        fresh: true,
        adopted: false,
      }),
    );
    expect(child).toEqual(
      expect.objectContaining({
        path: "operations/incident-response",
        parent: "operations",
        fresh: true,
        staleKeys: ["operations"],
      }),
    );
    expect(await readFile(registryPath, "utf8")).toContain("Owner notes.\n");
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-KNOWLEDGE-STALE",
        path: "knowledge/operations/overview.md",
      }),
    );
  });

  test("adopts existing content without rewriting it and leaves it stale", async () => {
    const root = await workspace();
    const directory = path.join(root, "knowledge", "company", "handbook");
    const overviewPath = path.join(directory, "overview.md");
    const binaryPath = path.join(directory, "assets", "sample.bin");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(overviewPath, "# Existing handbook\r\n\r\nKeep this.\r\n");
    await writeFile(binaryPath, Buffer.from([0, 1, 2, 255]));
    const overviewBefore = await readFile(overviewPath);
    const binaryBefore = await readFile(binaryPath);

    const result = await createKnowledge(root, {
      key: "handbook",
      path: "company/handbook",
      displayName: "Company handbook",
    });

    expect(result).toEqual(
      expect.objectContaining({ adopted: true, fresh: false }),
    );
    expect(await readFile(overviewPath)).toEqual(overviewBefore);
    expect(await readFile(binaryPath)).toEqual(binaryBefore);

    const missingOverview = path.join(root, "knowledge", "policies");
    await mkdir(missingOverview);
    await writeFile(path.join(missingOverview, "leave.md"), "# Leave\n");
    const registered = await createKnowledge(root, { key: "policies" });
    expect(registered.fresh).toBe(false);
    expect(
      await readFile(path.join(missingOverview, "overview.md"), "utf8"),
    ).toBe("# policies\n");
  });

  test("rejects create conflicts and rolls back failed writes", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    await expect(
      createKnowledge(root, { key: "operations" }),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-CREATE-CONFLICT" });
    await writeFile(path.join(root, "knowledge", "blocked"), "file");
    await expect(
      createKnowledge(root, { key: "blocked" }),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-CREATE-CONFLICT" });
    const external = path.join(root, "external-knowledge");
    await mkdir(external);
    await symlink(external, path.join(root, "knowledge", "linked"));
    await expect(
      createKnowledge(root, { key: "linked" }),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-CREATE-CONFLICT" });

    const registryPath = path.join(root, "knowledge", "registry.md");
    const before = await readFile(registryPath);
    writeFailure.target = registryPath;
    await expect(
      createKnowledge(root, { key: "rollback" }),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(await readFile(registryPath)).toEqual(before);
    expect(await pathExists(path.join(root, "knowledge", "rollback"))).toBe(
      false,
    );

    writeFailure.target = path.join(
      root,
      "knowledge",
      "overview-failure",
      "overview.md",
    );
    await expect(
      createKnowledge(root, { key: "overview-failure" }),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(
      await pathExists(path.join(root, "knowledge", "overview-failure")),
    ).toBe(false);
  });

  test("allows existing stale topics but blocks damaged registered structure", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    await writeFile(
      path.join(root, "knowledge", "operations", "guide.md"),
      "# Changed\n",
    );
    await expect(
      createKnowledge(root, { key: "engineering" }),
    ).resolves.toEqual(expect.objectContaining({ key: "engineering" }));

    await rm(path.join(root, "knowledge", "operations", "overview.md"));
    const registryBefore = await readFile(
      path.join(root, "knowledge", "registry.md"),
    );
    await expect(
      createKnowledge(root, { key: "blocked" }),
    ).rejects.toMatchObject({ code: "AIO-WORKSPACE-INVALID" });
    expect(await readFile(path.join(root, "knowledge", "registry.md"))).toEqual(
      registryBefore,
    );
  });

  test("previews and applies a nested move without changing keys or content", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    await createKnowledge(root, {
      key: "incidents",
      parent: "operations",
    });
    await createKnowledge(root, { key: "runbooks" });
    await createKnowledge(root, {
      key: "sev-one",
      path: "operations/incidents/sev-one",
      parent: "incidents",
    });
    const work = await createWork(root, "Move linked Knowledge");
    await addWorkKnowledge(root, work.id, "incidents");
    const contentPath = path.join(
      root,
      "knowledge",
      "operations",
      "incidents",
      "notes.bin",
    );
    await writeFile(contentPath, Buffer.from([3, 2, 1]));
    const registryPath = path.join(root, "knowledge", "registry.md");
    const registryBefore = await readFile(registryPath);

    const preview = await previewMoveKnowledge(
      root,
      "incidents",
      "runbooks/incidents",
      { parent: "runbooks" },
    );
    expect(preview).toEqual(
      expect.objectContaining({
        applied: false,
        movedKeys: ["incidents", "sev-one"],
        previousParent: "operations",
        parent: "runbooks",
      }),
    );
    expect(await readFile(registryPath)).toEqual(registryBefore);

    const result = await moveKnowledge(
      root,
      "incidents",
      "runbooks/incidents",
      { parent: "runbooks" },
    );
    expect(result.applied).toBe(true);
    expect((await showKnowledge(root, "incidents")).path).toBe(
      "runbooks/incidents",
    );
    expect((await showKnowledge(root, "sev-one")).path).toBe(
      "runbooks/incidents/sev-one",
    );
    expect((await listWorks(root))[0]?.metadata.knowledge).toEqual([
      "incidents",
    ]);
    expect(
      await readFile(
        path.join(root, "knowledge", "runbooks", "incidents", "notes.bin"),
      ),
    ).toEqual(Buffer.from([3, 2, 1]));
  });

  test("rejects move conflicts and rolls back a Registry write failure", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    await createKnowledge(root, { key: "engineering" });
    await expect(
      previewMoveKnowledge(root, "operations", "operations/inside"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-MOVE-CONFLICT" });
    await expect(
      previewMoveKnowledge(root, "operations", "engineering"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-MOVE-CONFLICT" });
    const external = path.join(root, "external-move");
    await mkdir(external);
    await symlink(external, path.join(root, "knowledge", "linked"));
    await expect(
      previewMoveKnowledge(root, "operations", "linked/operations"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-MOVE-CONFLICT" });

    const registryPath = path.join(root, "knowledge", "registry.md");
    const before = await readFile(registryPath);
    writeFailure.target = registryPath;
    await expect(
      moveKnowledge(root, "operations", "company/operations"),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(await readFile(registryPath)).toEqual(before);
    expect(await pathExists(path.join(root, "knowledge", "operations"))).toBe(
      true,
    );
    expect(
      await pathExists(path.join(root, "knowledge", "company", "operations")),
    ).toBe(false);

    renameFailure.source = path.join(root, "knowledge", "operations");
    await expect(
      moveKnowledge(root, "operations", "another/operations"),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(await readFile(registryPath)).toEqual(before);
    expect(await pathExists(path.join(root, "knowledge", "operations"))).toBe(
      true,
    );
  });

  test("previews discard blockers and preserves all Work status references", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    await createKnowledge(root, {
      key: "incidents",
      parent: "operations",
    });
    const work = await createWork(root, "Uses operations");
    await addWorkKnowledge(root, work.id, "operations");

    const preview = await previewDiscardKnowledge(root, "operations");
    expect(preview).toEqual(
      expect.objectContaining({
        childKeys: ["incidents"],
        referencedBy: [work.id],
        staleKeys: [],
      }),
    );
    await expect(
      discardKnowledge(root, "operations", "operations"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-DISCARD-CHILDREN" });
    await addWorkKnowledge(root, work.id, "incidents");
    await expect(
      discardKnowledge(root, "incidents", "incidents"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-DISCARD-REFERENCED" });
    await expect(
      discardKnowledge(root, "incidents", "wrong"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-DISCARD-CONFIRM" });
  });

  test("discards a leaf into recoverable trash and rolls back failures", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "operations" });
    await createKnowledge(root, {
      key: "incidents",
      parent: "operations",
      displayName: "Incident response",
    });
    await syncKnowledgeOverview(root, "operations");
    await writeFile(
      path.join(root, "knowledge", "operations", "incidents", "notes.md"),
      "# Stale content\n",
    );
    const result = await discardKnowledge(root, "incidents", "incidents");
    expect(result).toEqual(
      expect.objectContaining({
        applied: true,
        key: "incidents",
        staleKeys: ["operations"],
      }),
    );
    const trash = path.join(root, ...result.trashTarget.split("/"));
    expect(
      await readFile(path.join(trash, "content", "overview.md"), "utf8"),
    ).toContain("key: incidents");
    expect(await readFile(path.join(trash, "recovery.yaml"), "utf8")).toContain(
      "displayName: Incident response",
    );
    await expect(showKnowledge(root, "incidents")).rejects.toMatchObject({
      code: "AIO-KNOWLEDGE-NOT-FOUND",
    });

    await createKnowledge(root, { key: "rollback" });
    const registryPath = path.join(root, "knowledge", "registry.md");
    const before = await readFile(registryPath);
    writeFailure.suffix = "/recovery.yaml";
    await expect(
      discardKnowledge(root, "rollback", "rollback"),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(await readFile(registryPath)).toEqual(before);
    expect(await pathExists(path.join(root, "knowledge", "rollback"))).toBe(
      true,
    );

    renameFailure.source = path.join(root, "knowledge", "rollback");
    await expect(
      discardKnowledge(root, "rollback", "rollback"),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(await readFile(registryPath)).toEqual(before);
    expect(await pathExists(path.join(root, "knowledge", "rollback"))).toBe(
      true,
    );

    writeFailure.target = registryPath;
    await expect(
      discardKnowledge(root, "rollback", "rollback"),
    ).rejects.toMatchObject({ code: "AIO-WRITE" });
    expect(await readFile(registryPath)).toEqual(before);
    expect(await pathExists(path.join(root, "knowledge", "rollback"))).toBe(
      true,
    );
  });

  test("reports Knowledge references from every Work status", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "shared" });
    const statuses = [
      "inbox",
      "active",
      "waiting",
      "done",
      "cancelled",
    ] as const;
    const ids: string[] = [];
    for (const status of statuses) {
      const work = await createWork(root, `${status} reference`);
      ids.push(work.id);
      await addWorkKnowledge(root, work.id, "shared");
      if (status === "active") await moveWork(root, work.id, status);
      if (status === "waiting") {
        await moveWork(root, work.id, status, {
          waitingReason: "External response",
          resumeWhen: "Response arrives",
        });
      }
      if (status === "done") {
        await confirmWork(root, work.id, [...allChecks]);
        await moveWork(root, work.id, status);
      }
      if (status === "cancelled") {
        await moveWork(root, work.id, status, {
          cancellationReason: "No longer required",
        });
      }
    }

    expect(
      (await previewDiscardKnowledge(root, "shared")).referencedBy,
    ).toEqual(ids);
  });
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

async function registerKnowledge(
  root: string,
  entries: Array<{
    key: string;
    path: string;
    parent?: string;
    displayName: string;
  }>,
): Promise<void> {
  for (const entry of entries) {
    const directory = path.join(root, "knowledge", ...entry.path.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "overview.md"),
      `# ${entry.displayName}\n`,
    );
  }
  await writeFile(
    path.join(root, "knowledge", "registry.md"),
    `# Knowledge registry

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
${entries
  .map(
    (entry) =>
      `| ${entry.key} | ${entry.path} | ${entry.parent ?? ""} | ${entry.displayName} |`,
  )
  .join("\n")}
`,
  );
  for (const entry of entries) {
    await syncKnowledgeOverview(root, entry.key);
  }
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

async function legacyCompletionDigest(
  root: string,
  id: string,
  metadata: ReturnType<typeof workMetadataSchema.parse>,
  recordBody: string,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("record-metadata\0");
  hash.update(
    JSON.stringify({
      schema: metadata.schema,
      id: metadata.id,
      title: metadata.title,
      type: metadata.type,
      created: metadata.created,
      needs: metadata.needs,
      checks: metadata.checks,
    }),
  );
  hash.update("\0record-body\0");
  hash.update(`${recordBody.replaceAll("\r\n", "\n").trimEnd()}\n`);

  const workPath = path.join(root, "work", id);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(path.relative(root, target));
    }
  };
  await visit(workPath);
  for (const file of files.sort()) {
    if (file === `work/${id}/record.md`) continue;
    hash.update(`\0${file}\0`);
    if (/\/(references|deliverables|evidence)\//.test(file)) {
      hash.update(await readFile(path.join(root, file)));
    } else {
      const source = await readFile(path.join(root, file), "utf8");
      hash.update(`${source.replaceAll("\r\n", "\n").trimEnd()}\n`);
    }
  }
  return hash.digest("hex");
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

    expect(config).toContain("agentSkillVersion: 8");
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

  test("creates an empty Knowledge Registry without default Knowledge entries", async () => {
    const root = await workspace();
    const knowledgePath = path.join(root, "knowledge");

    expect(
      await readFile(path.join(knowledgePath, "registry.md"), "utf8"),
    ).toBe(
      "# Knowledge registry\n\n| Key | Path | Parent | Display name |\n| --- | --- | --- | --- |\n",
    );
    expect(await readdir(knowledgePath)).toEqual(["registry.md"]);
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
      source.replace('aiongside-version: "8"', 'aiongside-version: "7"'),
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
      'aiongside-version: "8"',
      'aiongside-version: "9"',
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
      "agentSkillVersion: 8\n",
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
      source.replace('aiongside-version: "8"', 'aiongside-version: "7"'),
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
        "agentSkillVersion: 8",
        "agentSkillVersion: 9",
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
      "agentSkillVersion: 8\n",
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
      source.replace('aiongside-version: "8"', 'aiongside-version: "7"'),
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
    await confirmWork(root, work.id, ["knowledge"]);

    const added = await addWorkKnowledge(root, work.id, "Incident-Response");
    expect(added).toEqual(
      expect.objectContaining({
        id: work.id,
        key: "incident-response",
        path: "operations/incident-response",
        changed: true,
        knowledge: ["incident-response"],
      }),
    );
    expect(added.metadata.checks.knowledge).toBe(false);

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

  test("lists, trees, and shows Knowledge with current freshness", async () => {
    const root = await workspace();
    await registerKnowledge(root, [
      {
        key: "operations",
        path: "company/operations",
        displayName: "Operations",
      },
      {
        key: "incident-response",
        path: "company/operations/incidents",
        parent: "operations",
        displayName: "Incident response",
      },
    ]);

    expect(await listKnowledge(root)).toEqual([
      {
        key: "incident-response",
        displayName: "Incident response",
        path: "company/operations/incidents",
        parent: "operations",
        children: [],
        overview: "knowledge/company/operations/incidents/overview.md",
        fresh: true,
      },
      {
        key: "operations",
        displayName: "Operations",
        path: "company/operations",
        parent: null,
        children: ["incident-response"],
        overview: "knowledge/company/operations/overview.md",
        fresh: true,
      },
    ]);
    expect((await getKnowledgeTree(root))[0]).toEqual(
      expect.objectContaining({
        key: "operations",
        children: [expect.objectContaining({ key: "incident-response" })],
      }),
    );
    expect(await showKnowledge(root, "INCIDENT-RESPONSE")).toEqual(
      expect.objectContaining({
        key: "incident-response",
        parent: "operations",
        fresh: true,
      }),
    );
    await expect(showKnowledge(root, "missing")).rejects.toMatchObject({
      code: "AIO-KNOWLEDGE-NOT-FOUND",
    });
  });

  test("reports missing, stale, malformed, and mismatched Knowledge metadata", async () => {
    const root = await workspace();
    const directory = path.join(root, "knowledge", "operations");
    const overviewPath = path.join(directory, "overview.md");
    await mkdir(directory, { recursive: true });
    await writeFile(overviewPath, "# Operations\n");
    await writeFile(
      path.join(root, "knowledge", "registry.md"),
      "# Knowledge registry\n\n| Key | Display name |\n| --- | --- |\n| operations | Operations |\n",
    );

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-KNOWLEDGE-STALE",
        path: "knowledge/operations/overview.md",
      }),
    );
    expect(await readFile(overviewPath, "utf8")).toBe("# Operations\n");

    await syncKnowledgeOverview(root, "operations");
    await writeFile(path.join(directory, "runbook.md"), "# Runbook\n");
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-KNOWLEDGE-STALE" }),
    );

    await writeFile(
      overviewPath,
      "---\naiongside:\n  schema: 2\n  key: operations\n  contentDigest: bad\n---\n\n# Operations\n",
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-KNOWLEDGE-OVERVIEW" }),
    );

    await writeFile(
      overviewPath,
      `---\naiongside:\n  schema: 1\n  key: another-key\n  contentDigest: "${"0".repeat(64)}"\n---\n\n# Operations\n`,
    );
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-KNOWLEDGE-IDENTITY",
        path: "knowledge/operations/overview.md",
      }),
    );
  });

  test("syncs only one Knowledge Overview and preserves user content", async () => {
    const root = await workspace();
    await registerKnowledge(root, [
      {
        key: "operations",
        path: "operations",
        displayName: "Operations",
      },
      {
        key: "engineering",
        path: "engineering",
        displayName: "Engineering",
      },
    ]);
    const operationsOverview = path.join(
      root,
      "knowledge",
      "operations",
      "overview.md",
    );
    const engineeringOverview = path.join(
      root,
      "knowledge",
      "engineering",
      "overview.md",
    );
    const managed = await readFile(operationsOverview, "utf8");
    const digestMatch = /contentDigest: ([a-f0-9]{64})/.exec(managed);
    const digest = digestMatch?.[1];
    if (!digest) throw new Error("Missing test digest");
    await writeFile(
      operationsOverview,
      `---\nowner: team-a\naiongside:\n  schema: 1\n  key: operations\n  contentDigest: ${digest}\n---\r\n\r\n# Operations\r\n\r\nRouting text.\r\n`,
    );
    await writeFile(
      path.join(root, "knowledge", "operations", "runbook.md"),
      "# Changed\n",
    );
    await writeFile(
      path.join(root, "knowledge", "engineering", "standards.md"),
      "# Changed\n",
    );
    const engineeringBefore = await readFile(engineeringOverview);

    const synced = await syncKnowledgeOverview(root, "operations");
    expect(synced).toEqual(
      expect.objectContaining({
        key: "operations",
        changed: true,
        fresh: true,
      }),
    );
    const operationsAfter = await readFile(operationsOverview, "utf8");
    expect(operationsAfter).toContain("owner: team-a");
    expect(operationsAfter).toContain("# Operations\r\n\r\nRouting text.\r\n");
    expect(await readFile(engineeringOverview)).toEqual(engineeringBefore);
    expect((await showKnowledge(root, "operations")).fresh).toBe(true);
    expect((await showKnowledge(root, "engineering")).fresh).toBe(false);
    expect((await syncKnowledgeOverview(root, "operations")).changed).toBe(
      false,
    );
  });

  test("does not write when Knowledge sync cannot safely resolve its target", async () => {
    const identityRoot = await workspace();
    await registerKnowledge(identityRoot, [
      {
        key: "operations",
        path: "operations",
        displayName: "Operations",
      },
    ]);
    const identityOverview = path.join(
      identityRoot,
      "knowledge",
      "operations",
      "overview.md",
    );
    const mismatched = (await readFile(identityOverview, "utf8")).replace(
      "key: operations",
      "key: engineering",
    );
    await writeFile(identityOverview, mismatched);
    await expect(
      syncKnowledgeOverview(identityRoot, "operations"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-IDENTITY" });
    expect(await readFile(identityOverview, "utf8")).toBe(mismatched);

    const registryRoot = await workspace();
    const registryPath = path.join(registryRoot, "knowledge", "registry.md");
    await writeFile(registryPath, "# Broken Registry\n");
    const registryBefore = await readFile(registryPath);
    await expect(
      syncKnowledgeOverview(registryRoot, "operations"),
    ).rejects.toMatchObject({ code: "AIO-STRUCTURE-KNOWLEDGE-REGISTRY" });
    expect(await readFile(registryPath)).toEqual(registryBefore);

    for (const damage of ["path", "overview"] as const) {
      const damagedRoot = await workspace();
      await registerKnowledge(damagedRoot, [
        {
          key: "operations",
          path: "operations",
          displayName: "Operations",
        },
      ]);
      const target = path.join(damagedRoot, "knowledge", "operations");
      if (damage === "path") {
        await rm(target, { recursive: true });
      } else {
        await rm(path.join(target, "overview.md"));
      }
      const beforeRegistry = await readFile(
        path.join(damagedRoot, "knowledge", "registry.md"),
      );
      await expect(
        syncKnowledgeOverview(damagedRoot, "operations"),
      ).rejects.toMatchObject({ code: "AIO-WORKSPACE-INVALID" });
      expect(
        await readFile(path.join(damagedRoot, "knowledge", "registry.md")),
      ).toEqual(beforeRegistry);
      expect(await pathExists(path.join(target, "overview.md"))).toBe(false);
    }
  });

  test("validates Knowledge mutation targets and seals done Work", async () => {
    const root = await workspace();
    const work = await createWork(root, "Knowledge mutation gates");
    await registerKnowledge(root, [
      {
        key: "operations",
        path: "operations",
        displayName: "Operations",
      },
      {
        key: "incident-response",
        path: "operations/incident-response",
        parent: "operations",
        displayName: "Incident response",
      },
    ]);

    await expect(
      addWorkKnowledge(root, work.id, "missing"),
    ).rejects.toMatchObject({ code: "AIO-WORK-KNOWLEDGE-MISSING" });
    await addWorkKnowledge(root, work.id, "incident-response");
    await confirmWork(root, work.id, [...allChecks]);
    await moveWork(root, work.id, "done");
    await expect(
      addWorkKnowledge(root, work.id, "operations"),
    ).rejects.toMatchObject({ code: "AIO-DONE-SEALED" });
    await expect(
      removeWorkKnowledge(root, work.id, "incident-response"),
    ).rejects.toMatchObject({ code: "AIO-DONE-SEALED" });
  });

  test("keeps Work Knowledge relationships when a registered path moves", async () => {
    const root = await workspace();
    const work = await createWork(root, "Move Knowledge path");
    await registerKnowledge(root, [
      {
        key: "incident-response",
        path: "operations/incident-response",
        displayName: "Incident response",
      },
    ]);
    await addWorkKnowledge(root, work.id, "incident-response");
    const source = path.join(
      root,
      "knowledge",
      "operations",
      "incident-response",
    );
    const target = path.join(root, "knowledge", "reliability", "incidents");
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
    await writeFile(
      path.join(root, "knowledge", "registry.md"),
      `# Knowledge registry

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| incident-response | reliability/incidents | | Incident response |
`,
    );

    expect(await validateWorkspace(root)).toEqual([]);
    expect((await listWorks(root))[0]?.metadata.knowledge).toEqual([
      "incident-response",
    ]);
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

  test("previews no-impact and linked Knowledge reviews before done", async () => {
    const root = await workspace();
    const unlinked = await createWork(root, "No lasting Knowledge");
    const noImpact = await previewMoveWork(root, unlinked.id, "done");
    expect(noImpact.knowledgeReview).toEqual({
      confirmed: false,
      targets: [],
    });
    expect(
      noImpact.requiredInputs.find((input) => input.key === "checks.knowledge")
        ?.question,
    ).toContain("no lasting Knowledge impact");

    const linked = await createWork(root, "Update incident guidance");
    await registerKnowledge(root, [
      {
        key: "operations",
        path: "operations",
        displayName: "Operations",
      },
      {
        key: "incident-response",
        path: "operations/incident-response",
        parent: "operations",
        displayName: "Incident response",
      },
    ]);
    await addWorkKnowledge(root, linked.id, "incident-response");
    const review = await previewMoveWork(root, linked.id, "done");
    expect(review.knowledgeReview).toEqual({
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
    expect(
      review.knowledgeReview?.targets.map((target) => target.key),
    ).not.toContain("operations");
  });

  test("keeps Knowledge candidates and requires review again after reopening", async () => {
    const root = await workspace();
    const work = await createWork(root, "Repeat Knowledge review");
    await registerKnowledge(root, [
      {
        key: "operations",
        path: "operations",
        displayName: "Operations",
      },
    ]);
    await addWorkKnowledge(root, work.id, "operations");
    await confirmWork(root, work.id, [...allChecks]);
    await moveWork(root, work.id, "done");

    const same = await previewMoveWork(root, work.id, "done");
    expect(same.knowledgeReview).toBeUndefined();
    const reopened = await moveWork(root, work.id, "active", {
      reopenReason: "Operational guidance changed",
    });
    expect(reopened.metadata.knowledge).toEqual(["operations"]);
    expect(reopened.metadata.checks.knowledge).toBe(false);
    const repeated = await previewMoveWork(root, work.id, "done");
    expect(repeated.knowledgeReview?.targets).toEqual([
      {
        key: "operations",
        path: "operations",
        overview: "knowledge/operations/overview.md",
        fresh: true,
      },
    ]);
    expect(repeated.canMove).toBe(false);
  });

  test("reports linked Knowledge freshness and gates only related completion", async () => {
    const root = await workspace();
    await registerKnowledge(root, [
      {
        key: "operations",
        path: "operations",
        displayName: "Operations",
      },
      {
        key: "incident-response",
        path: "operations/incidents",
        parent: "operations",
        displayName: "Incident response",
      },
      {
        key: "engineering",
        path: "engineering",
        displayName: "Engineering",
      },
    ]);
    const linked = await createWork(root, "Update durable guidance");
    await addWorkKnowledge(root, linked.id, "incident-response");
    await addWorkKnowledge(root, linked.id, "engineering");
    await confirmWork(root, linked.id, [...allChecks]);
    await writeFile(
      path.join(root, "knowledge", "operations", "incidents", "runbook.md"),
      "# Updated runbook\n",
    );

    const preview = await previewMoveWork(root, linked.id, "done");
    expect(preview.knowledgeReview?.targets).toEqual([
      expect.objectContaining({
        key: "incident-response",
        path: "operations/incidents",
        fresh: false,
      }),
      expect.objectContaining({ key: "engineering", fresh: true }),
    ]);
    expect(preview.canMove).toBe(false);
    await expect(moveWork(root, linked.id, "done")).rejects.toMatchObject({
      code: "AIO-KNOWLEDGE-STALE",
    });

    await syncKnowledgeOverview(root, "incident-response");
    expect((await moveWork(root, linked.id, "done")).metadata.status).toBe(
      "done",
    );

    await writeFile(
      path.join(root, "knowledge", "engineering", "standards.md"),
      "# Changed later\n",
    );
    const unrelated = await createWork(root, "Unrelated delivery");
    await confirmWork(root, unrelated.id, [...allChecks]);
    expect((await moveWork(root, unrelated.id, "done")).metadata.status).toBe(
      "done",
    );
    const codes = (await validateWorkspace(root)).map((issue) => issue.code);
    expect(codes).toContain("AIO-KNOWLEDGE-STALE");
    expect(codes).not.toContain("AIO-DONE-INVALIDATED");
  });

  test("allows non-completion Work mutations while Knowledge is stale", async () => {
    const root = await workspace();
    await registerKnowledge(root, [
      {
        key: "operations",
        path: "operations",
        displayName: "Operations",
      },
    ]);
    await writeFile(
      path.join(root, "knowledge", "operations", "changed.md"),
      "# Changed\n",
    );

    const first = await createWork(root, "Continue during review");
    const second = await createWork(root, "Dependency");
    expect((await moveWork(root, first.id, "active")).metadata.status).toBe(
      "active",
    );
    expect((await addWorkDependency(root, first.id, second.id)).changed).toBe(
      true,
    );
    expect(
      (await removeWorkDependency(root, first.id, second.id)).changed,
    ).toBe(true);
    expect((await addWorkKnowledge(root, first.id, "operations")).changed).toBe(
      true,
    );
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

  test("preserves shared Knowledge outside work mutations and completion seals", async () => {
    const root = await workspace();
    const registryPath = path.join(root, "knowledge", "registry.md");
    const overviewPath = path.join(
      root,
      "knowledge",
      "content-operations",
      "overview.md",
    );
    const guidePath = path.join(
      root,
      "knowledge",
      "content-operations",
      "guides",
      "publishing.md",
    );
    await mkdir(path.dirname(guidePath), { recursive: true });
    await writeFile(
      registryPath,
      "# Knowledge registry\n\n| Key | Display name |\n| --- | --- |\n| content-operations | Content Operations |\n",
    );
    await writeFile(overviewPath, "# Content Operations\n");
    await writeFile(guidePath, "# Publishing\n");
    await syncKnowledgeOverview(root, "content-operations");
    const knowledgeTargets = [registryPath, overviewPath, guidePath];
    const beforeMutation = await Promise.all(
      knowledgeTargets.map((target) => readFile(target)),
    );

    const work = await createWork(root, "Shared knowledge boundary");
    expect(await validateWorkspace(root)).toEqual([]);
    expect(
      await Promise.all(knowledgeTargets.map((target) => readFile(target))),
    ).toEqual(beforeMutation);

    await confirmWork(root, work.id, [...allChecks]);
    await moveWork(root, work.id, "done");

    await writeFile(
      overviewPath,
      (await readFile(overviewPath, "utf8")).replace(
        "# Content Operations\n",
        "# Content Operations\n\nCurrent facts.\n",
      ),
    );
    expect(await validateWorkspace(root)).toEqual([]);
    await writeFile(guidePath, "# Publishing\n\nCurrent process.\n");

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-KNOWLEDGE-STALE" }),
    );
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

  test("preserves completion seals created before Knowledge relationships", async () => {
    const root = await workspace();
    const work = await createWork(root, "Pre-Knowledge completion seal");
    await confirmWork(root, work.id, [...allChecks]);
    await moveWork(root, work.id, "done");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const document = parseMarkdownDocument(await readFile(recordPath, "utf8"));
    const metadata = workMetadataSchema.parse(document.metadata);
    const digest = await legacyCompletionDigest(
      root,
      work.id,
      metadata,
      document.body,
    );
    const legacyMetadata = document.metadata as Record<string, unknown>;
    delete legacyMetadata.knowledge;
    legacyMetadata.completionSeal = {
      ...metadata.completionSeal,
      digest,
    };
    await writeFile(
      recordPath,
      formatMarkdownDocument(legacyMetadata, document.body),
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
    const registryPath = path.join(root, "knowledge", "registry.md");
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

  test("validates nested Knowledge entries and ignores unregistered content", async () => {
    const root = await workspace();
    const registryPath = path.join(root, "knowledge", "registry.md");
    const operationsPath = path.join(root, "knowledge", "operations");
    const incidentPath = path.join(operationsPath, "incident-response");
    await mkdir(path.join(incidentPath, "troubleshooting"), {
      recursive: true,
    });
    await writeFile(path.join(operationsPath, "overview.md"), "# Operations\n");
    await writeFile(path.join(incidentPath, "overview.md"), "# Incidents\n");
    await writeFile(
      path.join(incidentPath, "troubleshooting", "database.md"),
      "# Database\n",
    );
    await writeFile(
      registryPath,
      `# Knowledge registry

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| operations | operations | | Operations |
| incident-response | operations/incident-response | operations | Incident response |
`,
    );

    await syncKnowledgeOverview(root, "operations");
    await syncKnowledgeOverview(root, "incident-response");

    expect(await validateWorkspace(root)).toEqual([]);
  });

  test("reports invalid Knowledge Registry relationships and entrypoints", async () => {
    const root = await workspace();
    const knowledgePath = path.join(root, "knowledge");
    await mkdir(path.join(knowledgePath, "operations"));
    await writeFile(
      path.join(knowledgePath, "operations", "overview.md"),
      "# Operations\n",
    );
    await writeFile(
      path.join(knowledgePath, "registry.md"),
      `# Knowledge registry

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| operations | operations | | Operations |
| operations | operations | operations | Duplicate |
| missing-parent | missing-parent | unknown | Missing parent |
| invalid-path | ../outside | | Invalid path |
`,
    );

    const codes = new Set(
      (await validateWorkspace(root)).map((issue) => issue.code),
    );
    expect(codes).toEqual(
      new Set([
        "AIO-KNOWLEDGE-KEY",
        "AIO-KNOWLEDGE-PATH",
        "AIO-KNOWLEDGE-PARENT",
        "AIO-KNOWLEDGE-ENTRYPOINT",
      ]),
    );
  });

  test("rejects symbolic links in registered Knowledge paths", async () => {
    const root = await workspace();
    const knowledgePath = path.join(root, "knowledge");
    const target = path.join(root, "external-knowledge");
    await mkdir(target);
    await writeFile(path.join(target, "overview.md"), "# External\n");
    await symlink(target, path.join(knowledgePath, "linked"));
    await writeFile(
      path.join(knowledgePath, "registry.md"),
      `# Knowledge registry

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| linked | linked | | Linked |
`,
    );

    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({ code: "AIO-KNOWLEDGE-PATH" }),
    );
  });

  test("validates Work Knowledge references without requiring parent keys", async () => {
    const root = await workspace();
    const work = await createWork(root, "Knowledge references");
    const knowledgePath = path.join(root, "knowledge");
    await mkdir(path.join(knowledgePath, "operations", "incident-response"), {
      recursive: true,
    });
    await writeFile(
      path.join(knowledgePath, "operations", "overview.md"),
      "# Operations\n",
    );
    await writeFile(
      path.join(
        knowledgePath,
        "operations",
        "incident-response",
        "overview.md",
      ),
      "# Incidents\n",
    );
    await writeFile(
      path.join(knowledgePath, "registry.md"),
      `# Knowledge registry

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| operations | operations | | Operations |
| incident-response | operations/incident-response | operations | Incident response |
`,
    );
    await syncKnowledgeOverview(root, "operations");
    await syncKnowledgeOverview(root, "incident-response");
    const recordPath = path.join(root, "work", work.id, "record.md");
    const source = await readFile(recordPath, "utf8");
    await writeFile(
      recordPath,
      source.replace("knowledge: []", "knowledge:\n  - incident-response"),
    );

    expect(await validateWorkspace(root)).toEqual([]);

    await writeFile(
      recordPath,
      source.replace("knowledge: []", "knowledge:\n  - missing\n  - missing"),
    );
    const codes = new Set(
      (await validateWorkspace(root)).map((issue) => issue.code),
    );
    expect(codes).toEqual(
      new Set(["AIO-WORK-KNOWLEDGE-MISSING", "AIO-WORK-KNOWLEDGE-DUPLICATE"]),
    );
  });

  test("accepts legacy Registry rows and Records without Knowledge metadata", async () => {
    const root = await workspace();
    const work = await createWork(root, "Legacy Knowledge");
    const knowledgePath = path.join(root, "knowledge", "operations");
    await mkdir(knowledgePath);
    await writeFile(path.join(knowledgePath, "overview.md"), "# Operations\n");
    await writeFile(
      path.join(root, "knowledge", "registry.md"),
      "# Knowledge registry\n\n| Key | Display name |\n| --- | --- |\n| operations | Operations |\n",
    );
    const recordPath = path.join(root, "work", work.id, "record.md");
    await writeFile(
      recordPath,
      (await readFile(recordPath, "utf8")).replace("knowledge: []\n", ""),
    );

    const before = await readFile(path.join(root, "knowledge", "registry.md"));
    expect(await validateWorkspace(root)).toContainEqual(
      expect.objectContaining({
        code: "AIO-KNOWLEDGE-STALE",
        path: "knowledge/operations/overview.md",
      }),
    );
    expect(await readFile(path.join(root, "knowledge", "registry.md"))).toEqual(
      before,
    );
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
