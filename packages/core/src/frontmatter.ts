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
