import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type KnowledgeEntry,
  markdownLinks,
  parseKnowledgeDocument,
  type ValidationIssue,
} from "@aiongside/core";

export const INDEX_SOURCE =
  "# Knowledge index\n\n<!-- Link each direct file and folder with a short description of when to read it. Keep knowledge content in separate documents. -->\n";
export const ROUTING_CODES = [
  "AIO-KNOWLEDGE-INDEX-MISSING",
  "AIO-KNOWLEDGE-INDEX-OMISSION",
  "AIO-LINK-MISSING",
  "AIO-LINK-PATH",
  "AIO-LINK-FORMAT",
] as const;

export interface KnowledgeScan {
  entries: KnowledgeEntry[];
  issues: ValidationIssue[];
  documents: Map<string, string>;
}

export function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

export async function safePathKind(
  root: string,
  target: string,
): Promise<"file" | "directory" | "missing" | "unsafe"> {
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    return "unsafe";
  let current = root;
  const segments = rel ? rel.split(path.sep) : [];
  for (let i = -1; i < segments.length; i++) {
    if (i >= 0) current = path.join(current, segments[i] as string);
    try {
      const item = await lstat(current);
      if (item.isSymbolicLink()) return "unsafe";
      if (i < segments.length - 1 && !item.isDirectory()) return "unsafe";
      if (i === segments.length - 1)
        return item.isFile()
          ? "file"
          : item.isDirectory()
            ? "directory"
            : "unsafe";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
  return "unsafe";
}

function localTarget(
  root: string,
  document: string,
  href: string,
): string | undefined {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("?") ||
    href.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)
  )
    return;
  const raw = href.split(/[?#]/, 1)[0] ?? "";
  const decoded = decodeURIComponent(raw.replaceAll("&amp;", "&"));
  if (!decoded || decoded.includes("\0") || decoded.includes("\\"))
    throw new Error("Invalid local link path");
  const target = path.resolve(path.dirname(path.join(root, document)), decoded);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    return;
  return target;
}

export async function validateDocumentLinks(
  root: string,
  documents: Map<string, string>,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const [document, source] of documents) {
    let links: ReturnType<typeof markdownLinks>;
    try {
      links = markdownLinks(source);
    } catch {
      continue; // Document metadata errors are reported by the owning scanner.
    }
    for (const link of links) {
      try {
        const target = localTarget(root, document, link.href);
        if (!target) continue;
        const kind = await safePathKind(root, target);
        if (kind === "file" || kind === "directory") continue;
        issues.push({
          code: kind === "missing" ? "AIO-LINK-MISSING" : "AIO-LINK-PATH",
          path: document,
          message: `Local link ${JSON.stringify(link.href)} resolves to ${relativePath(root, target)}, which ${kind === "missing" ? "does not exist" : "is not a safe regular path"}.`,
          hint: `Fix the link in ${document} or restore its intended target, then run aiongside check --json. Use the previous and new paths from knowledge move when available; do not guess a replacement. Reopen done Work before editing its sealed content.`,
        });
      } catch (error) {
        issues.push({
          code: "AIO-LINK-FORMAT",
          path: document,
          message: `Cannot resolve local link ${JSON.stringify(link.href)}: ${String(error)}`,
          hint: `Correct the link path in ${document}, then run aiongside check --json.`,
        });
      }
    }
  }
  return issues;
}

export async function scanKnowledge(root: string): Promise<KnowledgeScan> {
  const result: KnowledgeScan = {
    entries: [],
    issues: [],
    documents: new Map(),
  };
  const knowledgeRoot = path.join(root, "knowledge");
  if ((await safePathKind(root, knowledgeRoot)) !== "directory") {
    result.issues.push({
      code: "AIO-STRUCTURE-KNOWLEDGE",
      path: "knowledge",
      message: "Knowledge must be a regular directory, not a symbolic link.",
      hint: "Restore the knowledge directory without following symbolic links.",
    });
    return result;
  }
  const visit = async (directory: string): Promise<void> => {
    // Read the directory once; index coverage uses the same snapshot.
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    const indexPath = path.join(directory, "index.md");
    const indexRelative = relativePath(root, indexPath);
    let indexSource: string | undefined;
    if ((await safePathKind(root, indexPath)) === "file") {
      indexSource = await readFile(indexPath, "utf8");
      result.documents.set(indexRelative, indexSource);
    } else {
      result.issues.push({
        code: "AIO-KNOWLEDGE-INDEX-MISSING",
        path: indexRelative,
        message: "Missing regular index.md for this Knowledge directory.",
        hint: `Create ${indexRelative} with Markdown links and short routing descriptions for its direct entries, then run aiongside check --json.`,
      });
    }
    const linked = new Set<string>();
    if (indexSource !== undefined) {
      try {
        for (const link of markdownLinks(indexSource)) {
          if (link.image) continue;
          try {
            const target = localTarget(root, indexRelative, link.href);
            if (target) linked.add(target);
          } catch {
            /* The link validator reports malformed targets. */
          }
        }
      } catch (error) {
        result.issues.push({
          code: "AIO-LINK-FORMAT",
          path: indexRelative,
          message: `Cannot parse index: ${String(error)}`,
          hint: `Repair ${indexRelative}, then run aiongside check --json.`,
        });
      }
    }
    for (const child of children) {
      if (child.name === "index.md") continue;
      const target = path.join(directory, child.name);
      const rel = relativePath(root, target);
      if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) {
        result.issues.push({
          code: "AIO-KNOWLEDGE-PATH",
          path: rel,
          message:
            "Knowledge entries must be regular files or directories, not symbolic links.",
          hint: "Preserve the target outside this tree and use a regular Knowledge document.",
        });
        continue;
      }
      if (
        indexSource !== undefined &&
        !linked.has(target) &&
        !(child.isDirectory() && linked.has(path.join(target, "index.md")))
      ) {
        result.issues.push({
          code: "AIO-KNOWLEDGE-INDEX-OMISSION",
          path: indexRelative,
          message: `Direct entry ${rel} is not linked from ${indexRelative}.`,
          hint: `Add a Markdown link for ${JSON.stringify(child.name + (child.isDirectory() ? "/" : ""))} with a short routing description to ${indexRelative}, then run aiongside check --json.`,
        });
      }
      if (child.isDirectory()) {
        await visit(target);
      } else if (child.name.toLowerCase().endsWith(".md")) {
        const source = await readFile(target, "utf8");
        result.documents.set(rel, source);
        try {
          result.entries.push(
            parseKnowledgeDocument(source, relativePath(knowledgeRoot, target)),
          );
        } catch (error) {
          result.issues.push({
            code: "AIO-KNOWLEDGE-METADATA",
            path: rel,
            message: `Invalid Knowledge frontmatter: ${String(error)}`,
            hint: "Set aiongside.schema to 1 and a globally unique lowercase kebab-case aiongside.key. Keep routing in index.md; preserve the document body. Then run aiongside check --json.",
          });
        }
      }
    }
  };
  try {
    await visit(knowledgeRoot);
  } catch (error) {
    result.issues.push({
      code: "AIO-STRUCTURE-KNOWLEDGE",
      path: "knowledge",
      message: `Cannot read Knowledge files: ${String(error)}`,
      hint: "Restore access to the Knowledge files and retry.",
    });
  }
  const byKey = new Map<string, KnowledgeEntry[]>();
  for (const entry of result.entries)
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    for (const entry of entries)
      result.issues.push({
        code: "AIO-KNOWLEDGE-KEY",
        path: `knowledge/${entry.path}`,
        message: `Duplicate Knowledge key ${key}: ${entries.map((item) => `knowledge/${item.path}`).join(", ")}`,
        hint: "Give distinct documents unique keys. Check existing Work references before choosing which document keeps the original key. Then run aiongside check --json.",
      });
  }
  result.entries.sort((a, b) => a.key.localeCompare(b.key));
  result.issues.push(...(await validateDocumentLinks(root, result.documents)));
  return result;
}

export async function workMarkdownDocuments(
  root: string,
): Promise<Map<string, string>> {
  const documents = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        documents.set(
          relativePath(root, target),
          await readFile(target, "utf8"),
        );
    }
  };
  if ((await safePathKind(root, path.join(root, "work"))) === "directory")
    await visit(path.join(root, "work"));
  return documents;
}
