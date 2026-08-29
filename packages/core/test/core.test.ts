import { describe, expect, test } from "vitest";
import {
  createOverviewDocument,
  createRecordDocument,
  formatMarkdownDocument,
  parseMarkdownDocument,
  renderViews,
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

  test("keeps dynamic work state out of the default Overview", () => {
    const source = createOverviewDocument(metadata);
    const document = parseMarkdownDocument(source);

    expect(document.body).toContain("## Purpose");
    expect(document.body).not.toContain("## Current state");
    expect(document.body).not.toContain("## Progress");
    expect(document.body).not.toContain("## Outcome");
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
});
