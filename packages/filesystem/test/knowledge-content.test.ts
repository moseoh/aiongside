import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeEntry } from "@aiongside/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  calculateKnowledgeContentDigest,
  listKnowledgeOwnedContent,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const result = await mkdtemp(path.join(tmpdir(), "aiongside-knowledge-"));
  roots.push(result);
  await mkdir(path.join(result, "knowledge"));
  return result;
}

async function createEntry(
  rootPath: string,
  entry: KnowledgeEntry,
): Promise<void> {
  const directory = path.join(rootPath, "knowledge", ...entry.path.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "overview.md"),
    `# ${entry.displayName}\n`,
  );
}

describe("Knowledge content ownership", () => {
  test("assigns unregistered content to the nearest registered path", async () => {
    const rootPath = await root();
    const entries: KnowledgeEntry[] = [
      {
        key: "engineering",
        path: "engineering",
        displayName: "Engineering",
        line: 1,
      },
      {
        key: "standards",
        path: "engineering/standards",
        parent: "engineering",
        displayName: "Standards",
        line: 2,
      },
      {
        key: "stored-independently",
        path: "engineering/storage",
        displayName: "Stored independently",
        line: 3,
      },
    ];
    const engineering = entries[0];
    if (!engineering) throw new Error("Missing test Knowledge entry");
    for (const entry of entries) await createEntry(rootPath, entry);
    await writeFile(
      path.join(rootPath, "knowledge", "engineering", "handbook.md"),
      "# Handbook\n",
    );
    await mkdir(
      path.join(rootPath, "knowledge", "engineering", "unregistered"),
    );
    await writeFile(
      path.join(
        rootPath,
        "knowledge",
        "engineering",
        "unregistered",
        "notes.md",
      ),
      "# Notes\n",
    );
    await writeFile(
      path.join(
        rootPath,
        "knowledge",
        "engineering",
        "standards",
        "typescript.md",
      ),
      "# TypeScript\n",
    );

    expect(
      await listKnowledgeOwnedContent(rootPath, engineering, entries),
    ).toEqual([
      { type: "file", path: "handbook.md" },
      { type: "file", path: "unregistered/notes.md" },
    ]);
  });

  test("hashes paths, normalized Markdown, binary bytes, and link targets", async () => {
    const rootPath = await root();
    const entry: KnowledgeEntry = {
      key: "environment",
      path: "environment",
      displayName: "Environment",
      line: 1,
    };
    await createEntry(rootPath, entry);
    const directory = path.join(rootPath, "knowledge", entry.path);
    const markdownPath = path.join(directory, "setup.md");
    const binaryPath = path.join(directory, "asset.bin");
    const linkPath = path.join(directory, "current");
    await writeFile(markdownPath, "# Setup\n\nCurrent.\n");
    await writeFile(binaryPath, Buffer.from([0, 1, 2]));
    await symlink("setup.md", linkPath);
    const initial = await calculateKnowledgeContentDigest(rootPath, entry, [
      entry,
    ]);

    await writeFile(markdownPath, "# Setup\r\n\r\nCurrent.\r\n");
    expect(
      await calculateKnowledgeContentDigest(rootPath, entry, [entry]),
    ).toBe(initial);

    await writeFile(markdownPath, "# Setup\n\nChanged.\n");
    expect(
      await calculateKnowledgeContentDigest(rootPath, entry, [entry]),
    ).not.toBe(initial);
    await writeFile(markdownPath, "# Setup\n\nCurrent.\n");

    const addedPath = path.join(directory, "added.md");
    await writeFile(addedPath, "# Added\n");
    expect(
      await calculateKnowledgeContentDigest(rootPath, entry, [entry]),
    ).not.toBe(initial);
    await rm(addedPath);

    const renamedPath = path.join(directory, "renamed.md");
    await rename(markdownPath, renamedPath);
    expect(
      await calculateKnowledgeContentDigest(rootPath, entry, [entry]),
    ).not.toBe(initial);
    await rename(renamedPath, markdownPath);

    await writeFile(binaryPath, Buffer.from([0, 1, 3]));
    expect(
      await calculateKnowledgeContentDigest(rootPath, entry, [entry]),
    ).not.toBe(initial);
    await writeFile(binaryPath, Buffer.from([0, 1, 2]));
    await rm(linkPath);
    await symlink("asset.bin", linkPath);
    expect(
      await calculateKnowledgeContentDigest(rootPath, entry, [entry]),
    ).not.toBe(initial);
  });

  test("isolates descendants and only hashes direct child registration", async () => {
    const rootPath = await root();
    const entries: KnowledgeEntry[] = [
      {
        key: "company",
        path: "company",
        displayName: "Company",
        line: 1,
      },
      {
        key: "engineering",
        path: "company/engineering",
        parent: "company",
        displayName: "Engineering",
        line: 2,
      },
      {
        key: "standards",
        path: "company/engineering/standards",
        parent: "engineering",
        displayName: "Standards",
        line: 3,
      },
    ];
    for (const entry of entries) await createEntry(rootPath, entry);
    const documentPath = path.join(
      rootPath,
      "knowledge",
      "company",
      "engineering",
      "standards",
      "typescript.md",
    );
    await writeFile(documentPath, "# TypeScript\n");
    const before = await Promise.all(
      entries.map((entry) =>
        calculateKnowledgeContentDigest(rootPath, entry, entries),
      ),
    );

    await writeFile(documentPath, "# TypeScript\n\nUpdated.\n");
    const afterContent = await Promise.all(
      entries.map((entry) =>
        calculateKnowledgeContentDigest(rootPath, entry, entries),
      ),
    );
    expect(afterContent[0]).toBe(before[0]);
    expect(afterContent[1]).toBe(before[1]);
    expect(afterContent[2]).not.toBe(before[2]);

    const renamedGrandchild = entries.map((entry) =>
      entry.key === "standards"
        ? { ...entry, displayName: "Engineering standards" }
        : entry,
    );
    const afterRegistration = await Promise.all(
      entries.map((entry) =>
        calculateKnowledgeContentDigest(rootPath, entry, renamedGrandchild),
      ),
    );
    expect(afterRegistration[0]).toBe(afterContent[0]);
    expect(afterRegistration[1]).not.toBe(afterContent[1]);
    expect(afterRegistration[2]).toBe(afterContent[2]);
  });
});
