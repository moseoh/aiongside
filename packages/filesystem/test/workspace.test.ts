import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluateTransition,
  formatMarkdownDocument,
  parseMarkdownDocument,
  WORK_STATUSES,
} from "@aiongside/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cancelWork,
  confirmWork,
  createWork,
  discardWork,
  initializeWorkspace,
  listWorks,
  moveWork,
  pathExists,
  previewDiscard,
  previewMoveWork,
  rebuildViews,
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
  test("handles initialization, creation, movement, and cancellation", async () => {
    const root = await workspace();
    const created = await createWork(root, "First Work");
    expect(
      await pathExists(path.join(root, "work", created.id, "plan.md")),
    ).toBe(false);
    expect(
      await pathExists(path.join(root, "work", created.id, "reports")),
    ).toBe(true);
    expect(
      await pathExists(path.join(root, "work", created.id, "references")),
    ).toBe(true);

    await confirmWork(root, created.id, ["scope", "completion"]);
    const active = await moveWork(root, created.id, "active");
    const cancelled = await cancelWork(root, created.id, {
      cancellationReason: "No longer needed",
    });

    expect(created.id).toBe("AIO-001");
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
      "AIO-001",
      "AIO-002",
      "AIO-003",
    ]);
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
  });

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
    await writeFile(recordPath, source.replace("id: AIO-001", "id: AIO-999"));

    const issues = await validateWorkspace(root);

    expect(
      issues.some((issue) => issue.code === "AIO-IDENTITY-DIRECTORY"),
    ).toBe(true);
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
          .filter((line) => !line.includes("AIO-001"))
          .join("\n"),
      (source: string) =>
        `${source}| [AIO-999](../work/AIO-999/overview.md) | Invented | inbox | 2026-08-30 |\n`,
      (source: string) => {
        const lines = source.split("\n");
        const first = lines.findIndex((line) => line.includes("AIO-001"));
        const second = lines.findIndex((line) => line.includes("AIO-002"));
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
