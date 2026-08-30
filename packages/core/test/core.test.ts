import { describe, expect, test } from "vitest";
import {
  createOverviewDocument,
  createRecordDocument,
  evaluateTransition,
  formatMarkdownDocument,
  parseMarkdownDocument,
  renderViews,
  WORK_STATUSES,
  workMetadataSchema,
} from "../src/index.js";

const metadata = workMetadataSchema.parse({
  schema: 1,
  id: "AIO-001",
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

  test("keeps dynamic work state out of the default Overview", () => {
    const source = createOverviewDocument(metadata);
    const document = parseMarkdownDocument(source);

    expect(document.body).toContain("## Purpose");
    expect(document.body).not.toContain("## Current state");
    expect(document.body).not.toContain("## Progress");
    expect(document.body).not.toContain("## Outcome");
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
    expect(first["views/open.md"]).toContain("AIO-001");
    expect(first["views/closed.md"]).not.toContain("AIO-001");
  });

  test("sorts the five statuses deterministically", () => {
    const items = WORK_STATUSES.map((status, index) =>
      workMetadataSchema.parse({
        ...metadata,
        id: `AIO-${String(index + 1).padStart(3, "0")}`,
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
});
