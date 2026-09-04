import { createHash, type Hash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeEntry } from "@aiongside/core";

const KNOWLEDGE_DIR = "knowledge";
const OVERVIEW_NAME = "overview.md";

export interface KnowledgeContentItem {
  type: "file" | "link";
  path: string;
}

export async function listKnowledgeOwnedContent(
  root: string,
  entry: KnowledgeEntry,
  entries: KnowledgeEntry[],
): Promise<KnowledgeContentItem[]> {
  const knowledgeRoot = path.join(root, KNOWLEDGE_DIR);
  const entryRoot = path.join(knowledgeRoot, ...entry.path.split("/"));
  const boundaries = new Set(
    entries
      .filter(
        (candidate) =>
          candidate.key !== entry.key &&
          candidate.path.startsWith(`${entry.path}/`),
      )
      .map((candidate) => candidate.path),
  );
  const result: KnowledgeContentItem[] = [];

  const visit = async (
    directory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    for (const child of directoryEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const registryPath = `${entry.path}/${relativePath}`;
      if (boundaries.has(registryPath)) {
        continue;
      }
      const target = path.join(directory, child.name);
      if (child.isDirectory()) {
        await visit(target, relativePath);
      } else if (child.isFile()) {
        if (relativePath !== OVERVIEW_NAME) {
          result.push({ type: "file", path: relativePath });
        }
      } else if (child.isSymbolicLink()) {
        result.push({ type: "link", path: relativePath });
      } else {
        throw new Error(
          `Unsupported Knowledge content entry: ${KNOWLEDGE_DIR}/${entry.path}/${relativePath}`,
        );
      }
    }
  };

  await visit(entryRoot, "");
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export async function calculateKnowledgeContentDigest(
  root: string,
  entry: KnowledgeEntry,
  entries: KnowledgeEntry[],
): Promise<string> {
  const hash = createHash("sha256");
  const entryRoot = path.join(root, KNOWLEDGE_DIR, ...entry.path.split("/"));
  const content = await listKnowledgeOwnedContent(root, entry, entries);
  for (const item of content) {
    const target = path.join(entryRoot, ...item.path.split("/"));
    if (item.type === "link") {
      updateFrame(hash, "link", item.path, Buffer.from(await readlink(target)));
      continue;
    }
    const bytes = await readFile(target);
    updateFrame(
      hash,
      "file",
      item.path,
      item.path.toLowerCase().endsWith(".md")
        ? Buffer.from(normalizeMarkdown(bytes.toString("utf8")))
        : bytes,
    );
  }

  const directChildren = entries
    .filter((candidate) => candidate.parent === entry.key)
    .sort((left, right) => left.key.localeCompare(right.key));
  for (const child of directChildren) {
    updateFrame(
      hash,
      "child",
      child.key,
      Buffer.from(
        JSON.stringify({
          key: child.key,
          path: child.path,
          parent: child.parent,
          displayName: child.displayName,
        }),
      ),
    );
  }
  return hash.digest("hex");
}

function updateFrame(
  hash: Hash,
  type: KnowledgeContentItem["type"] | "child",
  itemPath: string,
  content: Buffer,
): void {
  const pathBytes = Buffer.from(itemPath);
  hash.update(`${type}\0${pathBytes.length}\0`);
  hash.update(pathBytes);
  hash.update(`\0${content.length}\0`);
  hash.update(content);
}

function normalizeMarkdown(source: string): string {
  return `${source.replaceAll("\r\n", "\n").trimEnd()}\n`;
}
