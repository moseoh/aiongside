import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  knowledgeMetadataSchema,
  parseMarkdownDocument,
  type WorkMetadata,
  workMetadataSchema,
} from "@aiongside/core";
import { z } from "zod";
import { WorkspaceError } from "./errors.js";
import { ManagedFiles } from "./gitignore.js";
import { safePathKind } from "./knowledge-files.js";
import { loadConfig } from "./workspace.js";

export const PREVIEW_LIMIT = 1024 * 1024;
const WORK_ID = /^[A-Z][A-Z0-9]{1,7}-[1-9]\d*$/;

function readError(message: string): WorkspaceError {
  return new WorkspaceError(message, "AIO-WEB-READ");
}

/** Read only the metadata prefix, with at most one small chunk of read-ahead. */
export async function readFrontmatter(target: string): Promise<unknown> {
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile())
      throw readError("Document is not a regular file.");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= PREVIEW_LIMIT) {
      const chunk = Buffer.alloc(1024);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
      const prefix = Buffer.concat(chunks).toString("utf8");
      if (!prefix.startsWith("---\n") && !prefix.startsWith("---\r\n")) {
        throw readError("Missing opening frontmatter delimiter.");
      }
      const end = /\r?\n---(?:\r?\n|$)/.exec(prefix);
      if (end)
        return parseMarkdownDocument(prefix.slice(0, end.index + end[0].length))
          .metadata;
    }
    throw readError(
      "Frontmatter is missing its closing delimiter or exceeds 1 MiB.",
    );
  } finally {
    await file.close();
  }
}

export async function readWorkFrontmatter(
  target: string,
): Promise<WorkMetadata> {
  return workMetadataSchema.parse(await readFrontmatter(target));
}

const knowledgeEnvelope = z
  .object({ aiongside: knowledgeMetadataSchema })
  .passthrough();

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  ignored: boolean;
}

export type KnowledgeNode =
  | {
      kind: "directory";
      name: string;
      path: string;
      index: string | null;
      children: KnowledgeNode[];
    }
  | {
      kind: "document";
      name: string;
      path: string;
      key: string | null;
      title: string | null;
      error: string | null;
    }
  | { kind: "file"; name: string; path: string };

export interface KnowledgeIssue {
  path: string;
  message: string;
}

function compareNames(a: string, b: string): number {
  return (
    a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) ||
    a.localeCompare(b, "en")
  );
}

/** One reader per request: no persistent document or ignore-rule cache. */
export class WorkReader {
  readonly files: ManagedFiles;

  constructor(readonly root: string) {
    this.files = new ManagedFiles(root);
  }

  static async create(root: string): Promise<WorkReader> {
    const canonical = await realpath(root);
    if (
      (await safePathKind(
        canonical,
        path.join(canonical, ".aiongside/config.yaml"),
      )) !== "file"
    ) {
      throw readError("Workspace configuration must be a safe regular file.");
    }
    await loadConfig(canonical);
    return new WorkReader(canonical);
  }

  private async recordMetadata(id: string): Promise<WorkMetadata> {
    const config = await loadConfig(this.root);
    const record = `work/${id}/record.md`;
    if (!(await this.files.includes(record)))
      throw readError("Record is excluded by .gitignore.");
    if (
      (await safePathKind(this.root, path.join(this.root, record))) !== "file"
    )
      throw readError("Record is missing or unsafe.");
    const metadata = await readWorkFrontmatter(path.join(this.root, record));
    if (metadata.id !== id || !metadata.id.startsWith(`${config.idPrefix}-`))
      throw readError(
        "Record ID does not match its folder or workspace prefix.",
      );
    return metadata;
  }

  async list() {
    const works: WorkMetadata[] = [];
    const issues: { path: string; message: string }[] = [];
    const config = await loadConfig(this.root);
    if (!(await this.files.includes("work", true)))
      return { root: this.root, name: config.name, works, issues };
    if (
      (await safePathKind(this.root, path.join(this.root, "work"))) !==
      "directory"
    ) {
      throw readError("Work directory is missing or unsafe.");
    }
    for (const entry of await this.files.entries("work")) {
      if (!entry.isDirectory()) continue;
      const record = `work/${entry.name}/record.md`;
      try {
        if (!(await this.files.includes(record))) continue;
        works.push(await this.recordMetadata(entry.name));
      } catch (error) {
        issues.push({
          path: record,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { root: this.root, name: config.name, works, issues };
  }

  /** One Work's metadata plus its Overview path when a safe Overview exists. */
  async work(id: string) {
    if (!WORK_ID.test(id)) throw readError("Invalid Work ID.");
    const metadata = await this.recordMetadata(id);
    const overview = `work/${id}/overview.md`;
    const hasOverview =
      (await safePathKind(this.root, path.join(this.root, overview))) ===
      "file";
    return { ...metadata, overview: hasOverview ? overview : null };
  }

  /**
   * Resolve a workspace-relative path inside a managed Work or Knowledge.
   * Work content stays readable when `.gitignore` excludes it; the Work's
   * Record must be managed. Knowledge paths follow the managed selection.
   */
  async target(relative: string, directory: boolean) {
    // API paths are workspace-relative, decoded once by the HTTP query parser.
    const segments = relative.split("/");
    const scope = segments[0];
    if (
      (scope !== "work" && scope !== "knowledge") ||
      (scope === "work" && !WORK_ID.test(segments[1] ?? "")) ||
      segments.some((part) => !part || part === "." || part === "..") ||
      relative.includes("\\") ||
      [...relative].some((char) => char.charCodeAt(0) < 32)
    ) {
      throw readError("Only safe Work or Knowledge paths can be opened.");
    }
    const absolute = path.join(this.root, relative);
    if (
      (await safePathKind(this.root, absolute)) !==
      (directory ? "directory" : "file")
    )
      throw readError(
        "Path is missing, unsafe, or not the requested file type.",
      );
    if (scope === "work") {
      const record = `${segments.slice(0, 2).join("/")}/record.md`;
      await this.files.assertIncluded(record);
      if (
        (await safePathKind(this.root, path.join(this.root, record))) !== "file"
      )
        throw readError("Path does not belong to a managed Work.");
    } else {
      await this.files.assertIncluded("knowledge", true);
      if (path.basename(relative) !== ".gitignore")
        await this.files.assertIncluded(relative, directory);
    }
    return absolute;
  }

  async directory(relative: string): Promise<DirectoryEntry[]> {
    const absolute = await this.target(relative, true);
    const listed =
      relative.split("/")[0] === "work"
        ? (await this.files.selection(absolute)).entries
        : (await this.files.entries(absolute)).map((entry) => ({
            entry,
            ignored: false,
          }));
    return listed
      .filter(({ entry }) => entry.isFile() || entry.isDirectory())
      .map(({ entry, ignored }) => ({
        name: entry.name,
        path: `${relative}/${entry.name}`,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        ignored,
      }))
      .sort((a, b) =>
        a.kind === b.kind
          ? compareNames(a.name, b.name)
          : a.kind === "directory"
            ? -1
            : 1,
      );
  }

  async open(relative: string) {
    const absolute = await this.target(relative, false);
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        (await safePathKind(this.root, absolute)) !== "file"
      )
        throw readError("File changed during opening. Refresh and retry.");
      return { handle, size: info.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async document(relative: string) {
    const { handle, size } = await this.open(relative);
    try {
      if (size > PREVIEW_LIMIT)
        return { path: relative, size, kind: "download" as const };
      const buffer = Buffer.alloc(PREVIEW_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (
        length > PREVIEW_LIMIT ||
        bytes.includes(0) ||
        /\.(?:html?|svg|xml|xhtml)$/i.test(relative)
      )
        return { path: relative, size, kind: "download" as const };
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { path: relative, size, kind: "download" as const };
      }
      const markdown = /\.md$/i.test(relative);
      if (markdown && source.startsWith("---")) {
        try {
          source = parseMarkdownDocument(source).body;
        } catch {
          /* Show malformed documents as text. */
        }
      }
      return {
        path: relative,
        size,
        kind: markdown ? ("markdown" as const) : ("text" as const),
        source,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Knowledge tree from the managed selection. Documents carry their key and
   * display name from frontmatter; index.md is attached to its folder.
   * `references` maps each key to the Work IDs that list it.
   */
  async knowledge() {
    const issues: KnowledgeIssue[] = [];
    const keys = new Map<string, string[]>();
    const nodes: KnowledgeNode[] = [];
    const knowledgeRoot = path.join(this.root, "knowledge");
    let rootIndex: string | null = null;
    if (
      (await this.files.includes("knowledge", true)) &&
      (await safePathKind(this.root, knowledgeRoot)) === "directory"
    ) {
      const visit = async (
        directory: string,
        relative: string,
      ): Promise<{ index: string | null; children: KnowledgeNode[] }> => {
        const children: KnowledgeNode[] = [];
        let index: string | null = null;
        const entries = [...(await this.files.entries(directory))].sort(
          (a, b) =>
            a.isDirectory() === b.isDirectory()
              ? compareNames(a.name, b.name)
              : a.isDirectory()
                ? -1
                : 1,
        );
        for (const entry of entries) {
          const target = path.join(directory, entry.name);
          const rel = `${relative}/${entry.name}`;
          if (
            entry.isSymbolicLink() ||
            (!entry.isFile() && !entry.isDirectory())
          ) {
            issues.push({
              path: rel,
              message:
                "Knowledge entries must be regular files or directories, not symbolic links.",
            });
            continue;
          }
          if (entry.isDirectory()) {
            const nested = await visit(target, rel);
            children.push({
              kind: "directory",
              name: entry.name,
              path: rel,
              index: nested.index,
              children: nested.children,
            });
          } else if (entry.name === "index.md") {
            index = rel;
          } else if (entry.name.toLowerCase().endsWith(".md")) {
            try {
              const metadata = knowledgeEnvelope.parse(
                await readFrontmatter(target),
              ).aiongside;
              keys.set(metadata.key, [...(keys.get(metadata.key) ?? []), rel]);
              children.push({
                kind: "document",
                name: entry.name,
                path: rel,
                key: metadata.key,
                title: metadata.title ?? metadata.key,
                error: null,
              });
            } catch (error) {
              const message = `Invalid Knowledge frontmatter: ${error instanceof Error ? error.message : String(error)}`;
              issues.push({ path: rel, message });
              children.push({
                kind: "document",
                name: entry.name,
                path: rel,
                key: null,
                title: null,
                error: message,
              });
            }
          } else {
            children.push({ kind: "file", name: entry.name, path: rel });
          }
        }
        return { index, children };
      };
      const top = await visit(knowledgeRoot, "knowledge");
      rootIndex = top.index;
      nodes.push(...top.children);
      const markDuplicates = (items: KnowledgeNode[]) => {
        for (const node of items) {
          if (node.kind === "directory") markDuplicates(node.children);
          else if (node.kind === "document" && node.key) {
            const paths = keys.get(node.key) ?? [];
            if (paths.length > 1) {
              node.error = `Duplicate Knowledge key ${node.key}: ${paths.join(", ")}`;
              issues.push({ path: node.path, message: node.error });
            }
          }
        }
      };
      markDuplicates(nodes);
    }
    const references: Record<string, string[]> = {};
    const listed = await this.list();
    for (const work of listed.works)
      for (const key of work.knowledge)
        references[key] = [...(references[key] ?? []), work.id];
    return { index: rootIndex, nodes, references, issues };
  }
}
