import { stringify } from "yaml";
import { z } from "zod";
import {
  DocumentFormatError,
  parseMarkdownDocument,
  replaceMarkdownMetadata,
} from "./frontmatter.js";
import { knowledgeKeySchema } from "./model.js";

const CURRENT_HEADERS = ["Key", "Path", "Parent", "Display name"] as const;
const LEGACY_HEADERS = ["Key", "Display name"] as const;
const PATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const knowledgeOverviewMetadataSchema = z
  .object({
    schema: z.literal(1),
    key: knowledgeKeySchema,
    contentDigest: z.string().regex(SHA256, "Expected a SHA-256 digest"),
  })
  .strict();

export type KnowledgeOverviewMetadata = z.infer<
  typeof knowledgeOverviewMetadataSchema
>;

export interface KnowledgeOverviewDocument {
  metadata: Record<string, unknown>;
  managed?: KnowledgeOverviewMetadata;
  body: string;
  hasFrontmatter: boolean;
}

export interface KnowledgeEntry {
  key: string;
  path: string;
  parent?: string;
  displayName: string;
  line: number;
}

export interface KnowledgeRegistry {
  format: "current" | "legacy";
  entries: KnowledgeEntry[];
}

export type KnowledgeMutationErrorCode =
  | "AIO-KNOWLEDGE-KEY"
  | "AIO-KNOWLEDGE-PATH"
  | "AIO-KNOWLEDGE-PARENT"
  | "AIO-KNOWLEDGE-DISPLAY-NAME"
  | "AIO-KNOWLEDGE-NOT-FOUND"
  | "AIO-KNOWLEDGE-CREATE-CONFLICT"
  | "AIO-KNOWLEDGE-MOVE-CONFLICT"
  | "AIO-KNOWLEDGE-DISCARD-CHILDREN"
  | "AIO-KNOWLEDGE-DISCARD-REFERENCED"
  | "AIO-KNOWLEDGE-DISCARD-CONFIRM";

export class KnowledgeMutationError extends Error {
  constructor(
    message: string,
    readonly code: KnowledgeMutationErrorCode,
  ) {
    super(message);
    this.name = "KnowledgeMutationError";
  }
}

export interface KnowledgeCreateInput {
  key: string;
  displayName?: string;
  path?: string;
  parent?: string;
}

export interface KnowledgeCreatePlan {
  entry: KnowledgeEntry;
  entries: KnowledgeEntry[];
  staleKeys: string[];
}

export interface KnowledgeMoveInput {
  key: string;
  path: string;
  parent?: string | null;
  preserveParent?: boolean;
}

export interface KnowledgeMovePlan {
  key: string;
  sourcePath: string;
  destinationPath: string;
  previousParent: string | null;
  parent: string | null;
  movedKeys: string[];
  entries: KnowledgeEntry[];
  staleKeys: string[];
  warnings: string[];
}

export interface KnowledgeDiscardPlan {
  entry: KnowledgeEntry;
  childKeys: string[];
  referencedBy: string[];
  staleKeys: string[];
}

export interface KnowledgeRegistryProblem {
  code:
    | "AIO-KNOWLEDGE-KEY"
    | "AIO-KNOWLEDGE-PATH"
    | "AIO-KNOWLEDGE-PARENT"
    | "AIO-KNOWLEDGE-DISPLAY-NAME";
  line: number;
  field: "key" | "path" | "parent" | "displayName";
  message: string;
}

export class KnowledgeRegistryFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeRegistryFormatError";
  }
}

export class KnowledgeOverviewFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeOverviewFormatError";
  }
}

export function parseKnowledgeOverviewDocument(
  source: string,
): KnowledgeOverviewDocument {
  if (!/^---(?:\r?\n|$)/.test(source)) {
    return {
      metadata: {},
      body: source,
      hasFrontmatter: false,
    };
  }

  let document: ReturnType<typeof parseMarkdownDocument>;
  try {
    document = parseMarkdownDocument(source);
  } catch (error) {
    throw new KnowledgeOverviewFormatError(errorMessage(error));
  }
  if (!isRecord(document.metadata)) {
    throw new KnowledgeOverviewFormatError(
      "Knowledge Overview frontmatter must be a YAML mapping.",
    );
  }
  const managedSource = document.metadata.aiongside;
  if (managedSource === undefined) {
    return {
      metadata: document.metadata,
      body: document.body,
      hasFrontmatter: true,
    };
  }
  const managed = knowledgeOverviewMetadataSchema.safeParse(managedSource);
  if (!managed.success) {
    throw new KnowledgeOverviewFormatError(
      `Invalid aiongside Knowledge metadata: ${managed.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "metadata"}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }
  return {
    metadata: document.metadata,
    managed: managed.data,
    body: document.body,
    hasFrontmatter: true,
  };
}

export function formatKnowledgeOverviewDocument(
  source: string,
  managed: KnowledgeOverviewMetadata,
): string {
  const document = parseKnowledgeOverviewDocument(source);
  const metadata = { ...document.metadata, aiongside: managed };
  if (document.hasFrontmatter) {
    return replaceMarkdownMetadata(source, metadata);
  }
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const yaml = stringify(metadata, { lineWidth: 0 })
    .trimEnd()
    .replaceAll("\n", lineEnding);
  return `---${lineEnding}${yaml}${lineEnding}---${lineEnding}${lineEnding}${source}`;
}

export function parseKnowledgeRegistry(source: string): KnowledgeRegistry {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const matches: Array<{
    index: number;
    format: KnowledgeRegistry["format"];
    headers: readonly string[];
  }> = [];

  for (const [index, line] of lines.entries()) {
    const cells = parseTableRow(line);
    if (cells && sameCells(cells, CURRENT_HEADERS)) {
      matches.push({ index, format: "current", headers: CURRENT_HEADERS });
    } else if (cells && sameCells(cells, LEGACY_HEADERS)) {
      matches.push({ index, format: "legacy", headers: LEGACY_HEADERS });
    }
  }

  if (matches.length === 0) {
    throw new KnowledgeRegistryFormatError(
      "Missing Knowledge Registry table with Key, Path, Parent, Display name columns.",
    );
  }
  if (matches.length > 1) {
    throw new KnowledgeRegistryFormatError(
      "Knowledge Registry must contain exactly one managed table.",
    );
  }

  const match = matches[0];
  if (!match) {
    throw new KnowledgeRegistryFormatError("Cannot resolve Registry table.");
  }
  const separator = parseTableRow(lines[match.index + 1] ?? "");
  if (
    !separator ||
    separator.length !== match.headers.length ||
    !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    throw new KnowledgeRegistryFormatError(
      `Invalid Knowledge Registry separator at line ${match.index + 2}.`,
    );
  }

  const entries: KnowledgeEntry[] = [];
  for (let index = match.index + 2; index < lines.length; index += 1) {
    const cells = parseTableRow(lines[index] ?? "");
    if (!cells) {
      break;
    }
    if (cells.length !== match.headers.length) {
      throw new KnowledgeRegistryFormatError(
        `Knowledge Registry row at line ${index + 1} has ${cells.length} cells; expected ${match.headers.length}.`,
      );
    }
    if (match.format === "legacy") {
      const [key = "", displayName = ""] = cells;
      entries.push({
        key,
        path: key,
        displayName,
        line: index + 1,
      });
      continue;
    }
    const [key = "", entryPath = "", parent = "", displayName = ""] = cells;
    entries.push({
      key,
      path: entryPath,
      ...(parent ? { parent } : {}),
      displayName,
      line: index + 1,
    });
  }

  return { format: match.format, entries };
}

export function renderKnowledgeRegistry(
  source: string,
  entries: KnowledgeEntry[],
): string {
  parseKnowledgeRegistry(source);
  const problem = validateKnowledgeRegistryEntries(entries)[0];
  if (problem) {
    throw new KnowledgeRegistryFormatError(problem.message);
  }
  const boundary = findRegistryTableBoundary(source);
  const rows = [
    `| ${CURRENT_HEADERS.join(" | ")} |`,
    `| ${CURRENT_HEADERS.map(() => "---").join(" | ")} |`,
    ...entries.map(
      (entry) =>
        `| ${escapeTableCell(entry.key)} | ${escapeTableCell(entry.path)} | ${escapeTableCell(entry.parent ?? "")} | ${escapeTableCell(entry.displayName)} |`,
    ),
  ];
  return `${source.slice(0, boundary.start)}${rows.join(boundary.lineEnding)}${source.slice(boundary.end)}`;
}

export function planKnowledgeCreate(
  entries: KnowledgeEntry[],
  input: KnowledgeCreateInput,
): KnowledgeCreatePlan {
  const key = normalizeKnowledgeKey(input.key);
  const parent = input.parent ? normalizeKnowledgeKey(input.parent) : undefined;
  const parentEntry = parent
    ? entries.find((entry) => entry.key === parent)
    : undefined;
  if (parent && !parentEntry) {
    throw new KnowledgeMutationError(
      `Knowledge parent does not exist: ${parent}`,
      "AIO-KNOWLEDGE-PARENT",
    );
  }
  const entryPath = normalizeKnowledgePath(
    input.path ?? (parentEntry ? `${parentEntry.path}/${key}` : key),
  );
  const displayName =
    input.displayName === undefined ? key : input.displayName.trim();
  if (!displayName || /\r|\n/.test(displayName)) {
    throw new KnowledgeMutationError(
      "Knowledge display name must be a non-empty single line.",
      "AIO-KNOWLEDGE-DISPLAY-NAME",
    );
  }
  if (entries.some((entry) => entry.key === key)) {
    throw new KnowledgeMutationError(
      `Knowledge key is already registered: ${key}`,
      "AIO-KNOWLEDGE-CREATE-CONFLICT",
    );
  }
  if (entries.some((entry) => entry.path === entryPath)) {
    throw new KnowledgeMutationError(
      `Knowledge path is already registered: ${entryPath}`,
      "AIO-KNOWLEDGE-CREATE-CONFLICT",
    );
  }
  const entry: KnowledgeEntry = {
    key,
    path: entryPath,
    ...(parent ? { parent } : {}),
    displayName,
    line: entries.length + 1,
  };
  const next = [...entries, entry];
  assertValidMutationEntries(next);
  return {
    entry,
    entries: next,
    staleKeys: parent ? [parent] : [],
  };
}

export function planKnowledgeMove(
  entries: KnowledgeEntry[],
  input: KnowledgeMoveInput,
): KnowledgeMovePlan {
  const key = normalizeKnowledgeKey(input.key);
  const current = entries.find((entry) => entry.key === key);
  if (!current) {
    throw new KnowledgeMutationError(
      `Knowledge key does not exist: ${key}`,
      "AIO-KNOWLEDGE-NOT-FOUND",
    );
  }
  const destinationPath = normalizeKnowledgePath(input.path);
  if (destinationPath.startsWith(`${current.path}/`)) {
    throw new KnowledgeMutationError(
      `Knowledge destination is inside its source: ${destinationPath}`,
      "AIO-KNOWLEDGE-MOVE-CONFLICT",
    );
  }
  const parent = input.preserveParent
    ? current.parent
    : input.parent === null
      ? undefined
      : input.parent
        ? normalizeKnowledgeKey(input.parent)
        : current.parent;
  const moved = entries.filter(
    (entry) =>
      entry.path === current.path || entry.path.startsWith(`${current.path}/`),
  );
  const movedKeys = new Set(moved.map((entry) => entry.key));
  if (
    entries.some(
      (entry) =>
        !movedKeys.has(entry.key) &&
        (entry.path === destinationPath ||
          entry.path.startsWith(`${destinationPath}/`)),
    )
  ) {
    throw new KnowledgeMutationError(
      `Knowledge destination conflicts with a registered path: ${destinationPath}`,
      "AIO-KNOWLEDGE-MOVE-CONFLICT",
    );
  }
  const next = entries.map((entry) => {
    if (!movedKeys.has(entry.key)) return entry;
    const suffix = entry.path.slice(current.path.length);
    const updated: KnowledgeEntry = {
      ...entry,
      path: `${destinationPath}${suffix}`,
    };
    if (entry.key === key) {
      if (parent) updated.parent = parent;
      else delete updated.parent;
    }
    return updated;
  });
  assertValidMutationEntries(next, "AIO-KNOWLEDGE-MOVE-CONFLICT");
  const staleKeys = new Set<string>();
  if (current.parent) staleKeys.add(current.parent);
  if (parent) staleKeys.add(parent);
  for (const entry of moved) {
    if (entry.parent && movedKeys.has(entry.parent))
      staleKeys.add(entry.parent);
  }
  return {
    key,
    sourcePath: current.path,
    destinationPath,
    previousParent: current.parent ?? null,
    parent: parent ?? null,
    movedKeys: moved.map((entry) => entry.key),
    entries: next,
    staleKeys: [...staleKeys].sort(),
    warnings: ["Markdown links are not rewritten."],
  };
}

export function planKnowledgeDiscard(
  entries: KnowledgeEntry[],
  keyValue: string,
  referencedBy: string[] = [],
): KnowledgeDiscardPlan {
  const key = normalizeKnowledgeKey(keyValue);
  const entry = entries.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new KnowledgeMutationError(
      `Knowledge key does not exist: ${key}`,
      "AIO-KNOWLEDGE-NOT-FOUND",
    );
  }
  const childKeys = entries
    .filter(
      (candidate) =>
        candidate.key !== key && candidate.path.startsWith(`${entry.path}/`),
    )
    .map((candidate) => candidate.key)
    .sort();
  return {
    entry,
    childKeys,
    referencedBy: [...new Set(referencedBy)].sort(),
    staleKeys: entry.parent ? [entry.parent] : [],
  };
}

export function validateKnowledgeRegistryEntries(
  entries: KnowledgeEntry[],
): KnowledgeRegistryProblem[] {
  const problems: KnowledgeRegistryProblem[] = [];
  const byKey = new Map<string, KnowledgeEntry>();
  const byPath = new Map<string, KnowledgeEntry>();

  for (const entry of entries) {
    if (!knowledgeKeySchema.safeParse(entry.key).success) {
      problems.push({
        code: "AIO-KNOWLEDGE-KEY",
        line: entry.line,
        field: "key",
        message: `Invalid Knowledge key: ${entry.key || "<empty>"}`,
      });
    } else if (byKey.has(entry.key)) {
      problems.push({
        code: "AIO-KNOWLEDGE-KEY",
        line: entry.line,
        field: "key",
        message: `Duplicate Knowledge key: ${entry.key}`,
      });
    } else {
      byKey.set(entry.key, entry);
    }

    if (!isValidKnowledgePath(entry.path)) {
      problems.push({
        code: "AIO-KNOWLEDGE-PATH",
        line: entry.line,
        field: "path",
        message: `Invalid Knowledge path: ${entry.path || "<empty>"}`,
      });
    } else if (byPath.has(entry.path)) {
      problems.push({
        code: "AIO-KNOWLEDGE-PATH",
        line: entry.line,
        field: "path",
        message: `Duplicate Knowledge path: ${entry.path}`,
      });
    } else {
      byPath.set(entry.path, entry);
    }

    if (!entry.displayName.trim()) {
      problems.push({
        code: "AIO-KNOWLEDGE-DISPLAY-NAME",
        line: entry.line,
        field: "displayName",
        message: "Knowledge display name must not be empty.",
      });
    }
  }

  for (const entry of entries) {
    if (!entry.parent) {
      continue;
    }
    const parent = byKey.get(entry.parent);
    if (entry.parent === entry.key) {
      problems.push(
        parentProblem(entry, "Knowledge cannot be its own parent."),
      );
    } else if (!parent) {
      problems.push(
        parentProblem(
          entry,
          `Knowledge parent does not exist: ${entry.parent}`,
        ),
      );
    } else if (!entry.path.startsWith(`${parent.path}/`)) {
      problems.push(
        parentProblem(
          entry,
          `Knowledge path ${entry.path} is not below parent path ${parent.path}.`,
        ),
      );
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const reported = new Set<string>();
  const visit = (key: string, stack: string[]): void => {
    state.set(key, "visiting");
    const entry = byKey.get(key);
    const parent = entry?.parent;
    if (parent && byKey.has(parent)) {
      if (state.get(parent) === undefined) {
        visit(parent, [...stack, key]);
      } else if (state.get(parent) === "visiting") {
        const cycle = [...stack, key, parent];
        const cycleKey = [...new Set(cycle)].sort().join("|");
        if (!reported.has(cycleKey) && entry) {
          reported.add(cycleKey);
          problems.push(
            parentProblem(
              entry,
              `Knowledge parent cycle: ${cycle.join(" -> ")}`,
            ),
          );
        }
      }
    }
    state.set(key, "visited");
  };
  for (const key of [...byKey.keys()].sort()) {
    if (state.get(key) === undefined) {
      visit(key, []);
    }
  }

  return problems;
}

export function knowledgeEntriesByKey(
  entries: KnowledgeEntry[],
): Map<string, KnowledgeEntry> {
  return new Map(entries.map((entry) => [entry.key, entry]));
}

export function normalizeKnowledgePath(value: string): string {
  const normalized = value.trim();
  if (!isValidKnowledgePath(normalized)) {
    throw new KnowledgeMutationError(
      `Invalid Knowledge path: ${normalized || "<empty>"}`,
      "AIO-KNOWLEDGE-PATH",
    );
  }
  return normalized;
}

function normalizeKnowledgeKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!knowledgeKeySchema.safeParse(normalized).success) {
    throw new KnowledgeMutationError(
      `Invalid Knowledge key: ${normalized || "<empty>"}`,
      "AIO-KNOWLEDGE-KEY",
    );
  }
  return normalized;
}

function assertValidMutationEntries(
  entries: KnowledgeEntry[],
  fallbackCode?: KnowledgeMutationErrorCode,
): void {
  const problem = validateKnowledgeRegistryEntries(entries)[0];
  if (problem) {
    throw new KnowledgeMutationError(
      problem.message,
      fallbackCode ?? problem.code,
    );
  }
}

function findRegistryTableBoundary(source: string): {
  start: number;
  end: number;
  lineEnding: string;
} {
  const lines: Array<{
    text: string;
    start: number;
    endWithoutEnding: number;
    ending: string;
  }> = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|$)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const raw = match[0];
    if (raw === "" && match.index === source.length) break;
    const ending = raw.endsWith("\r\n")
      ? "\r\n"
      : raw.endsWith("\n")
        ? "\n"
        : "";
    lines.push({
      text: ending ? raw.slice(0, -ending.length) : raw,
      start: match.index,
      endWithoutEnding: match.index + raw.length - ending.length,
      ending,
    });
    match = pattern.exec(source);
  }
  const headers = lines
    .map((line, index) => ({ cells: parseTableRow(line.text), index }))
    .filter(
      (item) =>
        item.cells &&
        (sameCells(item.cells, CURRENT_HEADERS) ||
          sameCells(item.cells, LEGACY_HEADERS)),
    );
  const header = headers[0];
  if (!header) {
    throw new KnowledgeRegistryFormatError("Cannot resolve Registry table.");
  }
  let last = header.index + 1;
  while (
    last + 1 < lines.length &&
    parseTableRow(lines[last + 1]?.text ?? "")
  ) {
    last += 1;
  }
  const firstLine = lines[header.index];
  const lastLine = lines[last];
  if (!firstLine || !lastLine) {
    throw new KnowledgeRegistryFormatError("Cannot resolve Registry table.");
  }
  return {
    start: firstLine.start,
    end: lastLine.endWithoutEnding,
    lineEnding: firstLine.ending || (source.includes("\r\n") ? "\r\n" : "\n"),
  };
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function parseTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return undefined;
  }
  const content = trimmed.slice(1, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\\" && content[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function sameCells(left: string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((cell, i) => cell === right[i])
  );
}

function isValidKnowledgePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment !== "." && segment !== ".." && PATH_SEGMENT.test(segment),
  );
}

function parentProblem(
  entry: KnowledgeEntry,
  message: string,
): KnowledgeRegistryProblem {
  return {
    code: "AIO-KNOWLEDGE-PARENT",
    line: entry.line,
    field: "parent",
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof DocumentFormatError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
