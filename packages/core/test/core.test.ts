import { describe, expect, test } from "vitest";
import {
  calculateMarkdownBodyDigest,
  compareWorkIds,
  createKnowledgeDocument,
  createOverviewDocument,
  createPlanDocument,
  createRecordDocument,
  evaluateTransition,
  formatMarkdownDocument,
  markdownLinks,
  normalizeKnowledgeKey,
  normalizeKnowledgePath,
  overviewMetadataSchema,
  parseKnowledgeDocument,
  parseMarkdownDocument,
  renderViews,
  replaceMarkdownMetadata,
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
  test("keeps default writing hints in HTML comments rather than visible content", () => {
    const documents = [
      parseMarkdownDocument(createRecordDocument(metadata)).body,
      parseMarkdownDocument(createOverviewDocument(metadata, "a".repeat(64)))
        .body,
      createPlanDocument(),
    ];
    for (const body of documents) {
      expect(body).toContain("<!--");
      expect(body).toContain("-->");
      expect(body).not.toContain("{{title}}");
      const visibleLines = body
        .replace(/<!--[\s\S]*?-->/g, "")
        .split("\n")
        .filter((line) => line.trim());
      expect(visibleLines.length).toBeGreaterThan(0);
      expect(visibleLines.every((line) => /^#{1,6} /.test(line))).toBe(true);
    }
  });

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

describe("Knowledge documents", () => {
  test("creates and scans a stable key while allowing user metadata", () => {
    const source = createKnowledgeDocument({
      key: "venue",
      displayName: "Venues",
    });
    expect(parseKnowledgeDocument(source, "events/venue.md")).toEqual({
      key: "venue",
      path: "events/venue.md",
      displayName: "Venues",
    });
    expect(
      parseKnowledgeDocument(
        source.replace("---\n", "---\nowner: events\n"),
        "venue.md",
      ).key,
    ).toBe("venue");
    expect(normalizeKnowledgeKey(" Venue ")).toBe("venue");
  });
  test.each([
    "",
    "../file.md",
    "/file.md",
    "C:/file.md",
    "folder",
    "index.md",
    "a/index.md",
    "a/../file.md",
    "a//file.md",
  ])("rejects unsafe or reserved file path %s", (value) => {
    expect(() => normalizeKnowledgePath(value)).toThrow();
  });
  test("requires valid managed metadata, not a content hash", () => {
    expect(() => parseKnowledgeDocument("# Plain", "plain.md")).toThrow();
    expect(() =>
      parseKnowledgeDocument(
        "---\naiongside: {schema: 1, key: Bad}\n---\n",
        "bad.md",
      ),
    ).toThrow();
    expect(
      parseKnowledgeDocument(
        "---\naiongside: {schema: 1, key: good}\n---\n",
        "good.md",
      ).displayName,
    ).toBe("good");
    expect(() =>
      parseKnowledgeDocument(
        "---\naiongside: {schema: 1, key: good, contentDigest: old}\n---\n",
        "good.md",
      ),
    ).toThrow();
  });
  test("extracts real inline, reference, and image links but not examples or comments", () => {
    const source = [
      "---",
      "example: '[not](metadata.md)'",
      "---",
      "",
      "[File](file.md) [Space](<two words.md>) ![Image](pic.png)",
      "[Ref][target]",
      "",
      "[target]: nested/doc.md",
      "",
      "`[code](inline.md)`",
      "~~~md",
      "[code](fenced.md)",
      "~~~",
      "<!-- [hidden](comment.md) -->",
      '<a href="html.md">HTML</a>',
    ].join("\n");
    expect(markdownLinks(source)).toEqual([
      { href: "file.md", image: false },
      { href: "two words.md", image: false },
      { href: "pic.png", image: true },
      { href: "nested/doc.md", image: false },
    ]);
  });
});

describe("domain boundaries", () => {
  test("keeps configuration independent from integration", () => {
    const config = workspaceConfigSchema.parse({
      schema: 1,
      name: "Workspace",
      idPrefix: "WORK",
    });
    expect(config).toEqual({ schema: 1, name: "Workspace", idPrefix: "WORK" });
    expect(metadata).not.toHaveProperty("checks");
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
