import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";

export class DocumentFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentFormatError";
  }
}

export interface MarkdownDocument {
  metadata: unknown;
  body: string;
}

export function parseMarkdownDocument(source: string): MarkdownDocument {
  const normalized = source.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    throw new DocumentFormatError("Missing opening YAML frontmatter delimiter");
  }

  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) {
    throw new DocumentFormatError("Missing closing YAML frontmatter delimiter");
  }

  try {
    return {
      metadata: parse(lines.slice(1, end).join("\n")),
      body: lines
        .slice(end + 1)
        .join("\n")
        .replace(/^\n/, ""),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DocumentFormatError(`Cannot parse YAML frontmatter: ${message}`);
  }
}

export function formatMarkdownDocument(
  metadata: Record<string, unknown>,
  body: string,
): string {
  const yaml = stringify(metadata, { lineWidth: 0 }).trimEnd();
  const normalizedBody = body.replaceAll("\r\n", "\n").trimEnd();
  return `---\n${yaml}\n---\n\n${normalizedBody}\n`;
}

export function calculateMarkdownBodyDigest(source: string): string {
  const { body } = parseMarkdownDocument(source);
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function replaceMarkdownMetadata(
  source: string,
  metadata: Record<string, unknown>,
): string {
  parseMarkdownDocument(source);
  const delimiters = [...source.matchAll(/(^|\r?\n)---(?=\r?\n|$)/g)];
  const closing = delimiters[1];
  if (!closing || closing.index === undefined) {
    throw new DocumentFormatError("Missing closing YAML frontmatter delimiter");
  }

  const prefixLength = closing[1]?.length ?? 0;
  const closingStart = closing.index + prefixLength;
  const suffix = source.slice(closingStart + 3);
  const lineEnding = source.startsWith("---\r\n") ? "\r\n" : "\n";
  const yaml = stringify(metadata, { lineWidth: 0 })
    .trimEnd()
    .replaceAll("\n", lineEnding);
  return `---${lineEnding}${yaml}${lineEnding}---${suffix}`;
}
