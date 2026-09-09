import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKnowledgeDocument, WORK_STATUSES } from "@aiongside/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addWorkKnowledge,
  createKnowledge,
  createWork,
  discardKnowledge,
  getKnowledgeTree,
  initializeWorkspace,
  listKnowledge,
  listWorks,
  moveKnowledge,
  moveWork,
  previewDiscardKnowledge,
  previewMoveKnowledge,
  showKnowledge,
  syncWorkOverview,
  validateWorkspace,
} from "../src/index.js";

const failure = vi.hoisted(() => ({ write: "", rename: "" }));
vi.mock("write-file-atomic", async (load) => {
  const actual = await load<typeof import("write-file-atomic")>();
  return {
    ...actual,
    default: (...args: unknown[]) => {
      if (failure.write && String(args[0]).endsWith(failure.write)) {
        failure.write = "";
        return Promise.reject(new Error("Injected write failure"));
      }
      return (actual.default as (...args: unknown[]) => unknown)(...args);
    },
  };
});
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (from === failure.rename) {
        failure.rename = "";
        throw new Error("Injected rename failure");
      }
      return actual.rename(from, to);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  failure.write = "";
  failure.rename = "";
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "aiongside-file-knowledge-"));
  roots.push(root);
  await initializeWorkspace(root, { name: "Documents" });
  return root;
}
async function put(root: string, file: string, text: string | Buffer) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result[path.relative(root, target)] = "directory";
        await visit(target);
      } else if (entry.isFile())
        result[path.relative(root, target)] = (await readFile(target)).toString(
          "base64",
        );
    }
  };
  await visit(root);
  return result;
}
async function codes(root: string) {
  return (await validateWorkspace(root)).map((issue) => issue.code);
}

describe("file Knowledge mutations and routing", () => {
  test("creates nested documents and blank indexes without rewriting existing routing", async () => {
    const root = await workspace();
    const index = await readFile(path.join(root, "knowledge/index.md"));
    const created = await createKnowledge(root, {
      key: "venue",
      path: "events/rooms/venue.md",
      displayName: "Venue selection",
    });
    expect(created.indexPaths).toEqual([
      "knowledge/index.md",
      "knowledge/events/index.md",
      "knowledge/events/rooms/index.md",
    ]);
    expect(await readFile(path.join(root, "knowledge/index.md"))).toEqual(
      index,
    );
    expect((await listKnowledge(root))[0]).toMatchObject({
      key: "venue",
      path: "events/rooms/venue.md",
      displayName: "Venue selection",
    });
    expect((await getKnowledgeTree(root))[0]).toMatchObject({
      type: "directory",
      path: "events",
    });
    expect(await codes(root)).toEqual(
      Array(3).fill("AIO-KNOWLEDGE-INDEX-OMISSION"),
    );
    await put(root, "knowledge/index.md", "[Events](events/)\n");
    await put(root, "knowledge/events/index.md", "[Rooms](rooms/index.md)\n");
    await put(
      root,
      "knowledge/events/rooms/index.md",
      "[Venue selection](venue.md)\n",
    );
    expect(await validateWorkspace(root)).toEqual([]);
    const before = await snapshot(root);
    await expect(createKnowledge(root, { key: "venue" })).rejects.toMatchObject(
      { code: "AIO-KNOWLEDGE-CREATE-CONFLICT" },
    );
    await expect(
      createKnowledge(root, {
        key: "different",
        path: "events/rooms/venue.md",
      }),
    ).rejects.toThrow();
    expect(await snapshot(root)).toEqual(before);
  });

  test("discovers direct documents, requires keys, and never resolves duplicate keys arbitrarily", async () => {
    const root = await workspace();
    const source = createKnowledgeDocument({ key: "policy" });
    await put(root, "knowledge/policy.md", source);
    expect((await showKnowledge(root, "policy")).path).toBe("policy.md");
    await put(root, "knowledge/copy.md", source);
    const before = await snapshot(root);
    const duplicates = (await validateWorkspace(root)).filter(
      (issue) => issue.code === "AIO-KNOWLEDGE-KEY",
    );
    expect(duplicates).toHaveLength(2);
    expect(
      duplicates.every(
        (issue) =>
          issue.message.includes("knowledge/copy.md") &&
          issue.message.includes("knowledge/policy.md"),
      ),
    ).toBe(true);
    await expect(showKnowledge(root, "policy")).rejects.toThrow();
    await expect(createKnowledge(root, { key: "another" })).rejects.toThrow();
    expect(await snapshot(root)).toEqual(before);
    await put(root, "knowledge/copy.md", "# Missing key\n");
    expect(await codes(root)).toContain("AIO-KNOWLEDGE-METADATA");
  });

  test("indexes direct children recursively including attachments, not plain paths or example links", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "doc", path: "dir/doc.md" });
    await put(root, "knowledge/dir/asset.png", Buffer.from([1, 2, 3]));
    await put(root, "knowledge/index.md", "[Too deep](dir/doc.md)\n");
    await put(
      root,
      "knowledge/dir/index.md",
      "doc.md\n\n<!-- [Doc](doc.md) -->\n\n~~~md\n[Image](asset.png)\n~~~\n",
    );
    expect(
      (await codes(root)).filter(
        (code) => code === "AIO-KNOWLEDGE-INDEX-OMISSION",
      ),
    ).toHaveLength(3);
    await put(root, "knowledge/index.md", "[Dir](dir/index.md)\n");
    await put(
      root,
      "knowledge/dir/index.md",
      "[Doc][doc]\n\n[doc]: doc.md\n\n[Asset](asset.png)\n",
    );
    expect(await validateWorkspace(root)).toEqual([]);
    await rm(path.join(root, "knowledge/dir/index.md"));
    expect(await codes(root)).toContain("AIO-KNOWLEDGE-INDEX-MISSING");
    expect(await codes(root)).toContain("AIO-LINK-MISSING");
  });

  test("checks encoded, spaced, reference and image links without reading external URLs or outside paths", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "guide" });
    await put(root, "knowledge/two words.png", Buffer.from([0]));
    await put(
      root,
      "knowledge/index.md",
      "[Guide](guide.md) [Attachment](<two words.png>)\n",
    );
    const target = path.join(root, "knowledge/guide.md");
    const original = await readFile(target, "utf8");
    await writeFile(
      target,
      original +
        "\n![image](two%20words.png) [fragment](guide.md#unchecked) [outside](../../outside.md) [remote](https://example.invalid/no)\n\n[Reference][ref]\n\n[ref]: <two words.png>\n",
    );
    expect(await validateWorkspace(root)).toEqual([]);
    await writeFile(
      target,
      (await readFile(target, "utf8")) +
        "\n[Missing](missing.md) [Invalid](bad%ZZ.md)\n",
    );
    const before = await snapshot(root);
    expect(await codes(root)).toEqual(["AIO-LINK-MISSING", "AIO-LINK-FORMAT"]);
    expect(await snapshot(root)).toEqual(before);
  });

  test("refuses symlink entries, symlink indexes and unsafe destinations without following targets", async () => {
    const root = await workspace();
    const outside = await workspace();
    await put(outside, "secret.md", "Secret\n");
    await symlink(
      path.join(outside, "secret.md"),
      path.join(root, "knowledge/leak.md"),
    );
    const before = await readFile(path.join(outside, "secret.md"));
    expect(await codes(root)).toContain("AIO-KNOWLEDGE-PATH");
    await expect(createKnowledge(root, { key: "safe" })).rejects.toThrow();
    await rm(path.join(root, "knowledge/leak.md"));
    await rm(path.join(root, "knowledge/index.md"));
    await symlink(
      path.join(outside, "secret.md"),
      path.join(root, "knowledge/index.md"),
    );
    await expect(
      createKnowledge(root, { key: "safe", path: "nested/safe.md" }),
    ).rejects.toThrow();
    expect(await readFile(path.join(outside, "secret.md"))).toEqual(before);
    expect(await readdir(path.join(root, "knowledge"))).toEqual(["index.md"]);
  });

  test("moves bytes only, preserves contribution keys, and reports old/new index paths", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "policy", path: "company/policy.md" });
    await put(root, "knowledge/company/asset.txt", "Attachment");
    const document = path.join(root, "knowledge/company/policy.md");
    await writeFile(
      document,
      `${await readFile(document, "utf8")}\n[Asset](asset.txt)\n`,
    );
    await put(root, "knowledge/index.md", "[Company](company/)\n");
    await put(
      root,
      "knowledge/company/index.md",
      "[Policy](policy.md) [Asset](asset.txt)\n",
    );
    const work = await createWork(root, "Publish policy");
    await moveWork(root, work.id, "done");
    await addWorkKnowledge(root, work.id, "policy");
    const record = await readFile(
      path.join(root, "work", work.id, "record.md"),
    );
    const bytes = await readFile(document);
    const before = await snapshot(root);
    expect(
      (await previewMoveKnowledge(root, "policy", "archive/policy.md")).applied,
    ).toBe(false);
    expect(await snapshot(root)).toEqual(before);
    const moved = await moveKnowledge(root, "policy", "archive/policy.md");
    expect(moved.indexPaths).toEqual([
      "knowledge/index.md",
      "knowledge/company/index.md",
      "knowledge/archive/index.md",
    ]);
    expect(
      await readFile(path.join(root, "knowledge/archive/policy.md")),
    ).toEqual(bytes);
    expect(
      await readFile(path.join(root, "work", work.id, "record.md")),
    ).toEqual(record);
    expect(await codes(root)).toContain("AIO-LINK-MISSING");
    expect((await showKnowledge(root, "policy")).path).toBe(
      "archive/policy.md",
    );
    const after = await snapshot(root);
    expect(
      (await moveKnowledge(root, "policy", "archive/policy.md")).applied,
    ).toBe(false);
    expect(await snapshot(root)).toEqual(after);
    await expect(
      moveKnowledge(root, "policy", "../outside.md"),
    ).rejects.toThrow();
  });

  test("protects references in every Work status and recovers only the discarded document", async () => {
    const root = await workspace();
    await createKnowledge(root, { key: "policy" });
    const ids: string[] = [];
    for (const status of WORK_STATUSES) {
      const work = await createWork(root, status);
      await moveWork(root, work.id, "done");
      await addWorkKnowledge(root, work.id, "policy");
      await moveWork(root, work.id, status, {
        reopenReason: "Status test",
        waitingReason: "Waiting",
        resumeWhen: "Response",
        cancellationReason: "Cancelled",
      });
      ids.push(work.id);
    }
    expect(
      (await previewDiscardKnowledge(root, "policy")).referencedBy,
    ).toEqual(ids);
    await expect(
      discardKnowledge(root, "policy", "policy"),
    ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-DISCARD-REFERENCED" });
    const clean = await workspace();
    await createKnowledge(clean, { key: "policy", path: "company/policy.md" });
    await put(clean, "knowledge/company/asset.txt", "Keep");
    const bytes = await readFile(
      path.join(clean, "knowledge/company/policy.md"),
    );
    await expect(discardKnowledge(clean, "policy", "wrong")).rejects.toThrow();
    const result = await discardKnowledge(clean, "policy", "policy");
    expect(
      await readFile(path.join(clean, result.trashTarget, "content.md")),
    ).toEqual(bytes);
    expect(
      await readFile(
        path.join(clean, result.trashTarget, "recovery.yaml"),
        "utf8",
      ),
    ).toContain("path: company/policy.md");
    expect(
      (await readdir(path.join(clean, "knowledge/company"))).sort(),
    ).toEqual(["asset.txt", "index.md"]);
    expect(await listKnowledge(clean)).toEqual([]);
  });

  test("rolls back new directories and indexes after creation and movement failures", async () => {
    const root = await workspace();
    const before = await snapshot(root);
    failure.write = "policy.md";
    await expect(
      createKnowledge(root, { key: "policy", path: "new/nested/policy.md" }),
    ).rejects.toThrow("Injected");
    expect(await snapshot(root)).toEqual(before);
    await createKnowledge(root, { key: "policy" });
    const source = path.join(root, "knowledge/policy.md");
    const created = await snapshot(root);
    failure.rename = source;
    await expect(
      moveKnowledge(root, "policy", "new/nested/policy.md"),
    ).rejects.toThrow("Injected");
    expect(await snapshot(root)).toEqual(created);
    failure.write = "recovery.yaml";
    await expect(discardKnowledge(root, "policy", "policy")).rejects.toThrow(
      "Injected",
    );
    expect(await readFile(source, "utf8")).toContain("key: policy");
    expect(
      await readdir(path.join(root, ".aiongside/internal/trash/knowledge")),
    ).toEqual([]);
    failure.rename = source;
    await expect(discardKnowledge(root, "policy", "policy")).rejects.toThrow(
      "Injected",
    );
    expect(
      await readdir(path.join(root, ".aiongside/internal/trash/knowledge")),
    ).toEqual([]);
  });

  test("checks missing Work keys and moved links while preserving completion seals", async () => {
    const root = await workspace();
    const work = await createWork(root, "Link and contribute");
    await createKnowledge(root, { key: "policy" });
    await put(root, "knowledge/index.md", "[Policy](policy.md)\n");
    const record = path.join(root, "work", work.id, "record.md");
    await writeFile(
      record,
      (await readFile(record, "utf8")) +
        "\n[Policy](../../knowledge/policy.md)\n",
    );
    await syncWorkOverview(root, work.id);
    const done = await moveWork(root, work.id, "done");
    await addWorkKnowledge(root, work.id, "policy");
    await moveKnowledge(root, "policy", "new.md");
    await put(root, "knowledge/index.md", "[Policy](new.md)\n");
    expect(await codes(root)).toEqual(["AIO-LINK-MISSING"]);
    expect((await listWorks(root))[0]?.metadata.completionSeal).toEqual(
      done.metadata.completionSeal,
    );
    await moveWork(root, work.id, "active", {
      reopenReason: "Repair moved Knowledge link",
    });
    await writeFile(
      record,
      (await readFile(record, "utf8")).replace(
        "knowledge/policy.md",
        "knowledge/new.md",
      ),
    );
    await syncWorkOverview(root, work.id);
    await moveWork(root, work.id, "done");
    expect(await validateWorkspace(root)).toEqual([]);
    await rm(path.join(root, "knowledge/new.md"));
    expect(await codes(root)).toContain("AIO-WORK-KNOWLEDGE-MISSING");
  });
});
