import { marked } from "marked";
import { z } from "zod";
import {
  formatMarkdownDocument,
  parseMarkdownDocument,
} from "./frontmatter.js";
import { knowledgeKeySchema } from "./model.js";

export const KNOWLEDGE_INDEX_NAME = "index.md";

export const knowledgeMetadataSchema = z
  .object({
    schema: z.literal(1),
    key: knowledgeKeySchema,
    title: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/[\r\n]/.test(value))
      .optional(),
  })
  .strict();

export interface KnowledgeEntry {
  key: string;
  path: string;
  displayName: string;
}

export interface KnowledgeCreateInput {
  key: string;
  path?: string;
  displayName?: string;
}

export class KnowledgeMutationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "KnowledgeMutationError";
  }
}

export function normalizeKnowledgeKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (!knowledgeKeySchema.safeParse(normalized).success) {
    throw new KnowledgeMutationError(
      "Knowledge key must be a lowercase kebab-case identifier.",
      "AIO-KNOWLEDGE-KEY",
    );
  }
  return normalized;
}

export function normalizeKnowledgePath(input: string): string {
  const value = input.trim();
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    /[\\\0\r\n]/.test(value) ||
    /^[a-zA-Z]:/.test(value) ||
    segments.some((part) => !part || part === "." || part === "..") ||
    !value.toLowerCase().endsWith(".md") ||
    segments.at(-1)?.toLowerCase() === KNOWLEDGE_INDEX_NAME
  ) {
    throw new KnowledgeMutationError(
      "Use a relative .md file path inside knowledge/; index.md is reserved.",
      "AIO-KNOWLEDGE-PATH",
    );
  }
  return value;
}

export function parseKnowledgeDocument(
  source: string,
  filePath: string,
): KnowledgeEntry {
  const { metadata } = parseMarkdownDocument(source);
  const envelope = z
    .object({ aiongside: knowledgeMetadataSchema })
    .passthrough()
    .parse(metadata);
  return {
    key: envelope.aiongside.key,
    path: filePath,
    displayName: envelope.aiongside.title ?? envelope.aiongside.key,
  };
}

export function createKnowledgeDocument(input: KnowledgeCreateInput): string {
  const key = normalizeKnowledgeKey(input.key);
  const managed = knowledgeMetadataSchema.parse({
    schema: 1,
    key,
    ...(input.displayName === undefined ? {} : { title: input.displayName }),
  });
  return formatMarkdownDocument(
    { aiongside: managed },
    `# ${managed.title ?? key}\n\n<!-- Write reusable knowledge here. Keep routing in the folder index.md. -->\n`,
  );
}

export function knowledgeEntriesByKey(
  entries: KnowledgeEntry[],
): Map<string, KnowledgeEntry> {
  return new Map(entries.map((entry) => [entry.key, entry]));
}

export interface MarkdownLink {
  href: string;
  image: boolean;
}

export function markdownLinks(source: string): MarkdownLink[] {
  let body = source;
  if (/^---\r?\n/.test(source)) body = parseMarkdownDocument(source).body;
  const result: MarkdownLink[] = [];
  marked.walkTokens(marked.lexer(body), (token) => {
    if (token.type === "link" || token.type === "image") {
      result.push({ href: token.href, image: token.type === "image" });
    }
  });
  return result;
}
