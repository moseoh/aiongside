import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AGENT_SKILL_NAME,
  CURRENT_AGENT_SKILL_VERSION,
  calculateMarkdownBodyDigest,
  compareWorkIds,
  createOverviewDocument,
  createRecordDocument,
  createRulesDocument,
  createSessionStartHookOutput,
  createStopHookOutput,
  evaluateTransition,
  formatMarkdownDocument,
  isExactAgentSkillSource,
  overviewMetadataSchema,
  parseAgentHookEvent,
  parseAgentSkill,
  parseKnowledgeRegistry,
  parseMarkdownDocument,
  renderViews,
  replaceMarkdownMetadata,
  validateKnowledgeRegistryEntries,
  WORK_STATUSES,
  workMetadataSchema,
  workspaceConfigSchema,
} from "../src/index.js";

const metadata = workMetadataSchema.parse({
  schema: 1,
  id: "WORK-1",
  title: "First task",
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

describe("Markdown document", () => {
  test("round-trips frontmatter and body", () => {
    const source = createRecordDocument(metadata);
    const parsed = parseMarkdownDocument(source);

    expect(workMetadataSchema.parse(parsed.metadata)).toEqual(metadata);
    expect(
      formatMarkdownDocument(
        parsed.metadata as Record<string, unknown>,
        parsed.body,
      ),
    ).toBe(source);
  });

  test("round-trips transition history and a completion seal", () => {
    const enriched = workMetadataSchema.parse({
      ...metadata,
      status: "done",
      transitions: [
        {
          at: "2026-08-30T12:00:00.000Z",
          from: "active",
          to: "done",
        },
      ],
      completionSeal: {
        completedAt: "2026-08-30T12:00:00.000Z",
        digest: "a".repeat(64),
      },
    });
    const source = createRecordDocument(enriched);

    expect(
      workMetadataSchema.parse(parseMarkdownDocument(source).metadata),
    ).toEqual(enriched);
  });

  test("defaults missing Knowledge relationships and validates keys", () => {
    expect(metadata.knowledge).toEqual([]);
    expect(
      workMetadataSchema.parse({
        ...metadata,
        knowledge: ["incident-response"],
      }).knowledge,
    ).toEqual(["incident-response"]);
    expect(
      workMetadataSchema.safeParse({ ...metadata, knowledge: ["Operations"] })
        .success,
    ).toBe(false);
  });

  test("keeps dynamic work state out of the default Overview", () => {
    const source = createOverviewDocument(metadata, "a".repeat(64));
    const document = parseMarkdownDocument(source);

    expect(document.body).toContain("## Purpose");
    expect(document.body).not.toContain("## Current state");
    expect(document.body).not.toContain("## Progress");
    expect(document.body).not.toContain("## Outcome");
    expect(document.metadata).toEqual(
      expect.objectContaining({ recordBodyDigest: "a".repeat(64) }),
    );
  });

  test("hashes only the normalized Markdown body", () => {
    const source = createRecordDocument(metadata);
    const changedFrontmatter = source.replace(
      "updated: 2026-08-30",
      "updated: 2026-08-31",
    );
    const changedBody = source.replace(
      "Describe the confirmed context.",
      "Changed context.",
    );

    expect(calculateMarkdownBodyDigest(source.replaceAll("\n", "\r\n"))).toBe(
      calculateMarkdownBodyDigest(source),
    );
    expect(calculateMarkdownBodyDigest(changedFrontmatter)).toBe(
      calculateMarkdownBodyDigest(source),
    );
    expect(calculateMarkdownBodyDigest(changedBody)).not.toBe(
      calculateMarkdownBodyDigest(source),
    );
  });

  test.each(["\n", "\r\n"])(
    "rewrites metadata and preserves %j body bytes",
    (lineEnding) => {
      const source = [
        "---",
        "schema: 1",
        "id: WORK-1",
        "title: First task",
        "---",
        "",
        "# First task  ",
        "",
      ].join(lineEnding);
      const bodyStart =
        source.indexOf(`${lineEnding}---${lineEnding}`) +
        `${lineEnding}---`.length;
      const rewritten = replaceMarkdownMetadata(source, {
        schema: 1,
        id: "WORK-1",
        title: "First task",
        recordBodyDigest: "b".repeat(64),
      });
      const rewrittenBodyStart =
        rewritten.indexOf(`${lineEnding}---${lineEnding}`) +
        `${lineEnding}---`.length;

      expect(rewritten.slice(rewrittenBodyStart)).toBe(source.slice(bodyStart));
      expect(parseMarkdownDocument(rewritten).metadata).toEqual(
        expect.objectContaining({ recordBodyDigest: "b".repeat(64) }),
      );
    },
  );

  test("accepts unpadded IDs and rejects zero or padded IDs", () => {
    expect(workMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(
      workMetadataSchema.safeParse({ ...metadata, needs: ["WORK-2"] }).success,
    ).toBe(true);
    for (const id of ["WORK-0", "WORK-01", "AIO-001"]) {
      expect(workMetadataSchema.safeParse({ ...metadata, id }).success).toBe(
        false,
      );
    }
  });

  test("accepts a missing Overview digest but rejects malformed values", () => {
    const source = createOverviewDocument(metadata, "c".repeat(64));
    const parsed = parseMarkdownDocument(source).metadata as Record<
      string,
      unknown
    >;
    const { recordBodyDigest: _digest, ...withoutDigest } = parsed;

    expect(overviewMetadataSchema.safeParse(withoutDigest).success).toBe(true);
    expect(
      overviewMetadataSchema.safeParse({
        ...withoutDigest,
        recordBodyDigest: "not-a-digest",
      }).success,
    ).toBe(false);
  });
});

describe("Knowledge Registry", () => {
  test("parses current and legacy tables while preserving user content", () => {
    const current = parseKnowledgeRegistry(`# Knowledge registry

User introduction.

| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| operations | operations | | Operations |
| incident-response | operations/incident-response | operations | Incident \\| response |

User notes.
`);
    const legacy = parseKnowledgeRegistry(`# Knowledge registry

| Key | Display name |
| --- | --- |
| operations | Operations |
`);

    expect(current).toEqual({
      format: "current",
      entries: [
        {
          key: "operations",
          path: "operations",
          displayName: "Operations",
          line: 7,
        },
        {
          key: "incident-response",
          path: "operations/incident-response",
          parent: "operations",
          displayName: "Incident | response",
          line: 8,
        },
      ],
    });
    expect(legacy.entries[0]).toEqual({
      key: "operations",
      path: "operations",
      displayName: "Operations",
      line: 5,
    });
  });

  test("rejects missing, duplicate, and malformed managed tables", () => {
    expect(() => parseKnowledgeRegistry("# Knowledge registry\n")).toThrow(
      "Missing Knowledge Registry table",
    );
    expect(() =>
      parseKnowledgeRegistry(`| Key | Display name |
| --- | --- |

| Key | Display name |
| --- | --- |
`),
    ).toThrow("exactly one managed table");
    expect(() =>
      parseKnowledgeRegistry(`| Key | Path | Parent | Display name |
| --- | --- |
`),
    ).toThrow("Invalid Knowledge Registry separator");
  });

  test("validates keys, paths, parents, duplicates, and cycles", () => {
    const entries =
      parseKnowledgeRegistry(`| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| operations | operations | | Operations |
| incident-response | operations/incident-response | operations | Incidents |
`).entries;
    expect(validateKnowledgeRegistryEntries(entries)).toEqual([]);

    const invalid =
      parseKnowledgeRegistry(`| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| Invalid | ../outside | missing | Invalid |
| duplicate | same | duplicate | Duplicate |
| duplicate | same | duplicate | |
`).entries;
    expect(validateKnowledgeRegistryEntries(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "AIO-KNOWLEDGE-KEY" }),
        expect.objectContaining({ code: "AIO-KNOWLEDGE-PATH" }),
        expect.objectContaining({ code: "AIO-KNOWLEDGE-PARENT" }),
        expect.objectContaining({ code: "AIO-KNOWLEDGE-DISPLAY-NAME" }),
      ]),
    );

    const cycle = parseKnowledgeRegistry(`| Key | Path | Parent | Display name |
| --- | --- | --- | --- |
| first | first/second | second | First |
| second | first | first | Second |
`).entries;
    expect(validateKnowledgeRegistryEntries(cycle)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AIO-KNOWLEDGE-PARENT",
          message: expect.stringContaining("cycle"),
        }),
      ]),
    );
  });
});

describe("workspace configuration", () => {
  test("keeps the Agent Skill version optional for schema 1 workspaces", () => {
    const legacy = { schema: 1, name: "Legacy", idPrefix: "AIO" };
    const managed = { ...legacy, agentSkillVersion: 1 };

    expect(workspaceConfigSchema.parse(legacy)).toEqual(legacy);
    expect(workspaceConfigSchema.parse(managed)).toEqual(managed);
    for (const invalid of [0, -1, 1.5, "1"]) {
      expect(
        workspaceConfigSchema.safeParse({
          ...legacy,
          agentSkillVersion: invalid,
        }).success,
      ).toBe(false);
    }
  });
});

describe("Agent Skill", () => {
  test("validates the canonical managed skill", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../../../skills/aiongside/SKILL.md"),
      "utf8",
    );
    const skill = parseAgentSkill(source);

    expect(skill).toEqual(
      expect.objectContaining({
        name: AGENT_SKILL_NAME,
        description: expect.any(String),
        license: "MIT",
        version: CURRENT_AGENT_SKILL_VERSION,
      }),
    );
    expect(source).toContain("aiongside work move");
    expect(source).toContain("aiongside work knowledge add");
    expect(source).toContain("aiongside work sync");
    expect(source).toContain("aiongside check");
  });

  test("rejects invalid metadata and detects exact-byte drift", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../../../skills/aiongside/SKILL.md"),
      "utf8",
    );
    const crlf = source.replaceAll("\n", "\r\n");

    expect(parseAgentSkill(crlf).version).toBe(CURRENT_AGENT_SKILL_VERSION);
    expect(isExactAgentSkillSource(source, source)).toBe(true);
    expect(isExactAgentSkillSource(crlf, source)).toBe(false);
    expect(() =>
      parseAgentSkill(source.replace("license: MIT", "license: Proprietary")),
    ).toThrow("Invalid Agent Skill metadata");
  });
});

describe("Agent integration", () => {
  test("keeps managed instructions separate from user-owned rules", async () => {
    const instructions = await readFile(
      path.resolve(import.meta.dirname, "../../../instructions/aiongside.md"),
      "utf8",
    );
    const rules = createRulesDocument();

    expect(instructions).toContain("AIongside managed instructions");
    expect(instructions).toContain("aiongside work move");
    expect(instructions).toContain("Knowledge relationships");
    expect(instructions).toContain("knowledgeReview");
    expect(instructions).toContain("aiongside work sync");
    expect(instructions).toContain("aiongside check");
    expect(rules).toContain("workspace-specific instructions");
    expect(rules).not.toContain("aiongside work move");
  });

  test("parses common hook events and rejects invalid input", () => {
    expect(
      parseAgentHookEvent(
        JSON.stringify({
          cwd: "/workspace",
          hook_event_name: "Stop",
          stop_hook_active: true,
        }),
        "Stop",
      ),
    ).toEqual(
      expect.objectContaining({
        cwd: "/workspace",
        hook_event_name: "Stop",
        stop_hook_active: true,
      }),
    );
    expect(() => parseAgentHookEvent("not json", "Stop")).toThrow();
    expect(() =>
      parseAgentHookEvent(
        JSON.stringify({ cwd: "/workspace", hook_event_name: "Stop" }),
        "SessionStart",
      ),
    ).toThrow("Expected SessionStart");
  });

  test("renders session context and bounded stop decisions", () => {
    expect(createSessionStartHookOutput("context")).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "context",
      },
    });
    const issue = {
      code: "AIO-TEST",
      path: "record.md",
      message: "Invalid record",
      hint: "Fix the record.",
    };
    expect(createStopHookOutput([], false)).toEqual({});
    expect(createStopHookOutput([issue], false)).toEqual(
      expect.objectContaining({ decision: "block" }),
    );
    expect(createStopHookOutput([issue], true)).toEqual(
      expect.objectContaining({
        systemMessage: expect.stringContaining("after one recovery turn"),
      }),
    );
  });
});

describe("work status transitions", () => {
  test("supports only the five MVP statuses", () => {
    expect(WORK_STATUSES).toEqual([
      "inbox",
      "active",
      "waiting",
      "done",
      "cancelled",
    ]);
    for (const removed of ["ready", "verify"]) {
      expect(
        workMetadataSchema.safeParse({ ...metadata, status: removed }).success,
      ).toBe(false);
    }
  });

  test("maps all 25 transitions to their requirements", () => {
    const expected = {
      inbox: {
        inbox: "",
        active: "",
        waiting: "W",
        done: "D",
        cancelled: "C",
      },
      active: {
        inbox: "",
        active: "",
        waiting: "W",
        done: "D",
        cancelled: "C",
      },
      waiting: {
        inbox: "E",
        active: "E",
        waiting: "",
        done: "ED",
        cancelled: "C",
      },
      done: {
        inbox: "RI",
        active: "RI",
        waiting: "RWI",
        done: "",
        cancelled: "CI",
      },
      cancelled: {
        inbox: "R",
        active: "R",
        waiting: "RW",
        done: "RD",
        cancelled: "",
      },
    } as const;

    for (const from of WORK_STATUSES) {
      for (const to of WORK_STATUSES) {
        expect(
          evaluateTransition(from, to).requirements.join(""),
          `${from} -> ${to}`,
        ).toBe(expected[from][to]);
      }
    }
  });

  test("returns explicit option-backed questions", () => {
    const rule = evaluateTransition("done", "waiting");

    expect(rule.requiredInputs).toEqual([
      expect.objectContaining({
        key: "reopenReason",
        option: "--reopen-reason",
      }),
      expect.objectContaining({
        key: "waitingReason",
        option: "--waiting-reason",
      }),
      expect.objectContaining({
        key: "resumeWhen",
        option: "--resume-when",
      }),
    ]);
    expect(rule.invalidatesCompletion).toBe(true);
  });
});

describe("views", () => {
  test("renders deterministic Views for the same input", () => {
    const first = renderViews([metadata]);
    const second = renderViews([metadata]);

    expect(first).toEqual(second);
    expect(first["views/open.md"]).toContain("WORK-1");
    expect(first["views/closed.md"]).not.toContain("WORK-1");
  });

  test("sorts the five statuses deterministically", () => {
    const items = WORK_STATUSES.map((status, index) =>
      workMetadataSchema.parse({
        ...metadata,
        id: `WORK-${index + 1}`,
        title: status,
        status,
      }),
    );
    const open = renderViews(items)["views/open.md"] ?? "";
    const closed = renderViews(items)["views/closed.md"] ?? "";

    expect(open.indexOf("active")).toBeLessThan(open.indexOf("waiting"));
    expect(open.indexOf("waiting")).toBeLessThan(open.indexOf("inbox"));
    expect(closed.indexOf("done")).toBeLessThan(closed.indexOf("cancelled"));
  });

  test("sorts work IDs by arbitrary-size numeric suffix", () => {
    const ids = ["WORK-100", "WORK-10", "WORK-2", "WORK-1"];
    expect(ids.sort(compareWorkIds)).toEqual([
      "WORK-1",
      "WORK-2",
      "WORK-10",
      "WORK-100",
    ]);
  });
});
