import { knowledgeKeySchema } from "./model.js";

const CURRENT_HEADERS = ["Key", "Path", "Parent", "Display name"] as const;
const LEGACY_HEADERS = ["Key", "Display name"] as const;
const PATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
