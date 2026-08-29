import { describe, expect, test } from "vitest";
import {
  createRecordDocument,
  formatMarkdownDocument,
  parseMarkdownDocument,
  renderViews,
  workRecordSchema,
} from "../src/index.js";

const record = workRecordSchema.parse({
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
    const source = createRecordDocument(record);
    const parsed = parseMarkdownDocument(source);

    expect(workRecordSchema.parse(parsed.metadata)).toEqual(record);
    expect(
      formatMarkdownDocument(
        parsed.metadata as Record<string, unknown>,
        parsed.body,
      ),
    ).toBe(source);
  });
});

describe("views", () => {
  test("renders deterministic Views for the same input", () => {
    const first = renderViews([record]);
    const second = renderViews([record]);

    expect(first).toEqual(second);
    expect(first["views/open.md"]).toContain("AIO-001");
    expect(first["views/closed.md"]).not.toContain("AIO-001");
  });
});
