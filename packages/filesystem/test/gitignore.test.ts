import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ManagedFiles } from "../src/gitignore.js";
import {
  addWorkDependency,
  addWorkKnowledge,
  createKnowledge,
  createWork,
  discardWork,
  getKnowledgeTree,
  initializeWorkspace,
  listKnowledge,
  listWorks,
  moveKnowledge,
  moveWork,
  previewDiscard,
  rebuildViews,
  syncWorkOverview,
  validateWorkspace,
} from "../src/index.js";
import {
  scanKnowledge,
  workMarkdownDocuments,
} from "../src/knowledge-files.js";

const roots: string[] = [];
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function workspace() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "aiongside-gitignore-"));
  roots.push(root);
  await initializeWorkspace(root, { name: "Ignore rules" });
  await createWork(root, "Inspect documents");
  return root;
}
async function put(
  root: string,
  file: string,
  text = "[Missing](missing.md)\n",
) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function documents(root: string) {
  return [...(await workMarkdownDocuments(root)).keys()].sort();
}
const core = ["work/WORK-1/overview.md", "work/WORK-1/record.md"];

test("without ignore rules includes dependency Markdown; requires no Git repository", async () => {
  const root = await workspace();
  await put(root, "work/WORK-1/poc/node_modules/pkg/README.md");
  expect(await documents(root)).toContain(
    "work/WORK-1/poc/node_modules/pkg/README.md",
  );
  expect((await validateWorkspace(root)).map((issue) => issue.code)).toEqual([
    "AIO-LINK-MISSING",
  ]);
});

test.each([
  ".gitignore",
  "work/.gitignore",
  "work/WORK-1/.gitignore",
  "work/WORK-1/poc/.gitignore",
])(
  "reads %s once and prunes ignored directories without reading their files or rules",
  async (ignorePath) => {
    const root = await workspace();
    await put(root, ignorePath, "node_modules/\n");
    await put(root, "work/WORK-1/poc/node_modules/pkg/README.md");
    await put(root, "work/WORK-1/poc/node_modules/.gitignore", "!pkg/\n");
    const read = vi.mocked(fs.readFile).mockClear();
    const list = vi.mocked(fs.readdir).mockClear();
    expect(await documents(root)).toEqual(core);
    expect(
      read.mock.calls.filter(
        (args) => String(args[0]) === path.join(root, ignorePath),
      ),
    ).toHaveLength(1);
    expect(
      read.mock.calls.some((args) =>
        String(args[0]).includes("/node_modules/"),
      ),
    ).toBe(false);
    expect(
      list.mock.calls.some((args) => String(args[0]).includes("/node_modules")),
    ).toBe(false);
    expect(await validateWorkspace(root)).toEqual([]);
  },
);

test("nested overrides are local; supports negation, anchors, globstar, comments and escaped names", async () => {
  const root = await workspace();
  await put(root, ".gitignore", "# Comment\n*.md\n!keep.md\nnode_modules/\n");
  await put(
    root,
    "work/WORK-1/poc/.gitignore",
    "!*.md\n/local.md\n**/temp?.md\n\\#draft.md\n\\!draft.md\n",
  );
  for (const name of [
    "keep.md",
    "other.md",
    "README.MD",
    "poc/show.md",
    "poc/local.md",
    "poc/deep/local.md",
    "poc/deep/temp1.md",
    "poc/#draft.md",
    "poc/!draft.md",
    "poc/node_modules/pkg/README.md",
  ])
    await put(root, `work/WORK-1/${name}`);
  await put(root, "work/WORK-1/poc/node_modules/.gitignore", "!**\n");
  expect(await documents(root)).toEqual(
    [
      "work/WORK-1/README.MD",
      "work/WORK-1/keep.md",
      "work/WORK-1/poc/show.md",
      "work/WORK-1/poc/deep/local.md",
    ].sort(),
  );
});

test.each(["work/\nknowledge/\n", "work/WORK-1/\nknowledge/\n", "*.md\n"])(
  "Work and Knowledge discovery consistently respect broad ignores: %s",
  async (rules) => {
    const root = await workspace();
    await put(root, "work/WORK-1/plan.md");
    await put(root, "work/WORK-1/references/hidden.md");
    await put(root, "knowledge/broken.md", "# Missing key\n");
    await put(root, ".gitignore", rules);
    expect(await documents(root)).toEqual([]);
    const issues = await validateWorkspace(root);
    expect(issues.every((issue) => issue.code === "AIO-VIEW-DRIFT")).toBe(true);
    expect(await listWorks(root)).toEqual([]);
    expect(await listKnowledge(root)).toEqual([]);
    expect(await getKnowledgeTree(root)).toEqual([]);
    await fs.appendFile(
      path.join(root, "work/WORK-1/record.md"),
      "\nChanged record\n",
    );
    expect(
      (await validateWorkspace(root)).some(
        (issue) => issue.code === "AIO-OVERVIEW-STALE",
      ),
    ).toBe(false);
  },
);

test("checks links into ignored paths for existence and safety without reading target bodies", async () => {
  const root = await workspace();
  await put(root, ".gitignore", "node_modules/\n");
  await put(root, "work/WORK-1/node_modules/pkg/README.md");
  await put(
    root,
    "work/WORK-1/references/links.md",
    "[Present](../node_modules/pkg/README.md) [Absent](../node_modules/pkg/absent.md) [Unsafe](../node_modules/link.md)\n",
  );
  await fs.symlink(
    path.join(root, "knowledge/index.md"),
    path.join(root, "work/WORK-1/node_modules/link.md"),
  );
  const issues = await validateWorkspace(root);
  expect(issues.map((issue) => issue.code)).toEqual([
    "AIO-LINK-MISSING",
    "AIO-LINK-PATH",
  ]);
  expect(
    issues.every((issue) => issue.path === "work/WORK-1/references/links.md"),
  ).toBe(true);
});

test("seal follows selected paths and bytes, not ignore configuration bytes", async () => {
  const root = await workspace();
  await put(root, "work/WORK-1/references/notes.md", "# Original\n");
  await syncWorkOverview(root, "WORK-1");
  await moveWork(root, "WORK-1", "done");
  const record = await fs.readFile(path.join(root, "work/WORK-1/record.md"));
  await put(root, "work/WORK-1/.gitignore", "nonexistent/\n");
  expect(await validateWorkspace(root)).toEqual([]);
  await put(root, "work/WORK-1/.gitignore", "references/notes.md\n");
  expect((await validateWorkspace(root)).map((issue) => issue.code)).toEqual([
    "AIO-DONE-INVALIDATED",
  ]);
  expect(await fs.readFile(path.join(root, "work/WORK-1/record.md"))).toEqual(
    record,
  );
  await moveWork(root, "WORK-1", "active", {
    reopenReason: "Changed managed scope",
  });
  await moveWork(root, "WORK-1", "done");
  await put(root, "work/WORK-1/references/notes.md");
  expect(await validateWorkspace(root)).toEqual([]);
  await put(
    root,
    "work/WORK-1/.gitignore",
    "# Comment\nreferences/notes.md\nmissing-folder/\n",
  );
  expect(await validateWorkspace(root)).toEqual([]);
  await put(root, "work/WORK-1/.gitignore", "");
  expect((await validateWorkspace(root)).map((issue) => issue.code)).toEqual([
    "AIO-DONE-INVALIDATED",
    "AIO-LINK-MISSING",
  ]);
});

test("nested selection agrees with Git, including parent pruning and sibling isolation", async () => {
  const root = await workspace();
  execFileSync("git", ["init", "--quiet", root]);
  await put(
    root,
    ".gitignore",
    "*.tmp\n/build/\nnode_modules/\nblocked/\n!blocked/keep.md\n*.md\n!record.md\n!overview.md\n",
  );
  await put(
    root,
    "work/WORK-1/poc/.gitignore",
    "!*.md\n/local.md\n**/temp?.md\n\\#draft.md\n\\!draft.md\n*.txt\n!keep.txt\n",
  );
  await put(root, "work/WORK-1/poc/deep/.gitignore", "!local.md\n");
  const paths = [
    ...core,
    "build/result.txt",
    "work/WORK-1/build/result.txt",
    "work/WORK-1/poc/show.md",
    "work/WORK-1/poc/local.md",
    "work/WORK-1/poc/deep/local.md",
    "work/WORK-1/poc/deep/temp1.md",
    "work/WORK-1/poc/#draft.md",
    "work/WORK-1/poc/!draft.md",
    "work/WORK-1/poc/keep.txt",
    "work/WORK-1/poc/other.txt",
    "work/WORK-1/other/show.md",
    "work/WORK-1/other/test.tmp",
    "work/WORK-1/poc/node_modules/pkg/README.md",
    "blocked/keep.md",
    "knowledge/file.md",
    "knowledge/FILE.MD",
  ];
  for (const file of paths) await put(root, file, "fixture\n");
  await put(root, "blocked/.gitignore", "!**\n");
  const ignored = new Set(
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "core.ignoreCase=false",
        "check-ignore",
        "--no-index",
        "--stdin",
      ],
      {
        input: `${paths.join("\n")}\n`,
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n"),
  );
  const files = new ManagedFiles(root);
  for (const file of paths)
    expect(await files.includes(file), file).toBe(!ignored.has(file));
});

test("all check consumers avoid ignored contents and read each rules file once", async () => {
  const root = await workspace();
  await put(root, ".gitignore", "node_modules/\nviews/closed.md\n");
  await put(root, "knowledge/.gitignore", "scratch/\n");
  await put(root, "knowledge/scratch/invalid.md", "not valid metadata\n");
  await put(root, "work/WORK-1/poc/node_modules/pkg/README.md");
  await put(root, "work/WORK-1/poc/node_modules/pkg/big.bin", "payload");
  await put(root, "views/closed.md", "custom excluded view");
  await moveWork(root, "WORK-1", "done");
  const read = vi.mocked(fs.readFile).mockClear();
  const list = vi.mocked(fs.readdir).mockClear();
  expect(await validateWorkspace(root)).toEqual([]);
  for (const rules of [".gitignore", "knowledge/.gitignore"])
    expect(
      read.mock.calls.filter(
        ([file]) => String(file) === path.join(root, rules),
      ),
    ).toHaveLength(1);
  expect(
    read.mock.calls.some(([file]) =>
      /node_modules|knowledge\/scratch|views\/closed.md/.test(String(file)),
    ),
  ).toBe(false);
  expect(
    list.mock.calls.some(([file]) =>
      /node_modules|knowledge\/scratch/.test(String(file)),
    ),
  ).toBe(false);
  await listWorks(root);
  await listKnowledge(root);
  await getKnowledgeTree(root);
  await rebuildViews(root);
  expect(
    read.mock.calls.some(([file]) =>
      /node_modules|knowledge\/scratch|views\/closed.md/.test(String(file)),
    ),
  ).toBe(false);
  expect(await fs.readFile(path.join(root, "views/closed.md"), "utf8")).toBe(
    "custom excluded view",
  );
});

test("Knowledge ignores apply to keys, index coverage and tree; re-inclusion exposes duplicates", async () => {
  const root = await workspace();
  await createKnowledge(root, { key: "guide" });
  await put(root, "knowledge/index.md", "[Guide](guide.md)\n");
  await put(root, "knowledge/.gitignore", "scratch/\nattachment.bin\n");
  await put(
    root,
    "knowledge/scratch/duplicate.md",
    await fs.readFile(path.join(root, "knowledge/guide.md"), "utf8"),
  );
  await put(root, "knowledge/attachment.bin", "data");
  expect(await validateWorkspace(root)).toEqual([]);
  expect((await listKnowledge(root)).map((item) => item.key)).toEqual([
    "guide",
  ]);
  expect((await getKnowledgeTree(root)).map((item) => item.path)).toEqual([
    "guide.md",
  ]);
  await put(root, "knowledge/.gitignore", "attachment.bin\n");
  expect(
    (await scanKnowledge(root)).issues.some(
      (item) => item.code === "AIO-KNOWLEDGE-KEY",
    ),
  ).toBe(true);
});

test("excluded core documents are not read, synced or recreated by state changes", async () => {
  const root = await workspace();
  await put(
    root,
    "work/WORK-1/.gitignore",
    "overview.md\nplan.md\nreferences/\n",
  );
  await put(root, "work/WORK-1/overview.md", "custom overview");
  await put(root, "work/WORK-1/plan.md", "custom plan");
  const read = vi.mocked(fs.readFile).mockClear();
  await expect(syncWorkOverview(root, "WORK-1")).rejects.toMatchObject({
    code: "AIO-PATH-IGNORED",
  });
  await moveWork(root, "WORK-1", "active");
  await moveWork(root, "WORK-1", "done");
  expect(await validateWorkspace(root)).toEqual([]);
  expect(
    read.mock.calls.some(([file]) =>
      /work\/WORK-1\/(overview|plan)\.md$/.test(String(file)),
    ),
  ).toBe(false);
  expect(
    await fs.readFile(path.join(root, "work/WORK-1/plan.md"), "utf8"),
  ).toBe("custom plan");
});

test("ignored destinations reject writes and physical Work IDs are not reused", async () => {
  const root = await workspace();
  await createKnowledge(root, { key: "guide" });
  await put(
    root,
    ".gitignore",
    "work/WORK-1/\nknowledge/private/\nwork/WORK-3/\n",
  );
  expect((await createWork(root, "Next work")).id).toBe("WORK-2");
  await expect(createWork(root, "Excluded next ID")).rejects.toMatchObject({
    code: "AIO-PATH-IGNORED",
  });
  await expect(
    createKnowledge(root, { key: "private", path: "private/secret.md" }),
  ).rejects.toMatchObject({ code: "AIO-PATH-IGNORED" });
  await expect(
    moveKnowledge(root, "guide", "private/guide.md"),
  ).rejects.toMatchObject({ code: "AIO-PATH-IGNORED" });
  await put(root, "knowledge/private/existing.md", "preserve");
  await expect(
    createKnowledge(root, { key: "existing", path: "private/existing.md" }),
  ).rejects.toMatchObject({ code: "AIO-KNOWLEDGE-CREATE-CONFLICT" });
  expect(
    await fs.readFile(path.join(root, "knowledge/private/existing.md"), "utf8"),
  ).toBe("preserve");
  await expect(fs.stat(path.join(root, "work/WORK-3"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("discard preview and recoverable move preserve ignored physical files", async () => {
  const root = await workspace();
  await put(root, "work/WORK-1/.gitignore", "node_modules/\n");
  await put(root, "work/WORK-1/node_modules/pkg/data.bin", "preserve");
  const preview = await previewDiscard(root, "WORK-1");
  expect(preview.files).toContain("work/WORK-1/node_modules/pkg/data.bin");
  expect(preview.files).toContain("work/WORK-1/.gitignore");
  const result = await discardWork(root, "WORK-1", "WORK-1");
  expect(
    await fs.readFile(
      path.join(root, result, "node_modules/pkg/data.bin"),
      "utf8",
    ),
  ).toBe("preserve");
});

test("managed references to ignored Work IDs and Knowledge keys remain errors", async () => {
  const root = await workspace();
  await createWork(root, "Dependent");
  await createKnowledge(root, { key: "guide" });
  await put(root, "knowledge/index.md", "[Guide](guide.md)\n");
  await addWorkDependency(root, "WORK-2", "WORK-1");
  await moveWork(root, "WORK-1", "done");
  await moveWork(root, "WORK-2", "done");
  await addWorkKnowledge(root, "WORK-2", "guide");
  await put(root, ".gitignore", "work/WORK-1/\nknowledge/guide.md\n");
  const codes = (await validateWorkspace(root)).map((issue) => issue.code);
  expect(codes).toContain("AIO-DEPENDENCY-MISSING");
  expect(codes).toContain("AIO-WORK-KNOWLEDGE-MISSING");
});

test("ignored index and supporting folders are not required; required included paths still are", async () => {
  const root = await workspace();
  await put(root, ".gitignore", "index.md\nevidence/\n");
  await createKnowledge(root, { key: "guide", path: "nested/guide.md" });
  await fs.rm(path.join(root, "work/WORK-1/evidence"), { recursive: true });
  expect(await validateWorkspace(root)).toEqual([]);
  await expect(
    fs.stat(path.join(root, "knowledge/nested/index.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await put(root, ".gitignore", "");
  const codes = (await validateWorkspace(root)).map((issue) => issue.code);
  expect(codes).toContain("AIO-KNOWLEDGE-INDEX-MISSING");
  expect(codes).toContain("AIO-STRUCTURE-EVIDENCE");
});

test("new Work omits ignored companion files and init preserves ignored data", async () => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), "aiongside-gitignore-init-"),
  );
  roots.push(root);
  await put(
    root,
    ".gitignore",
    "overview.md\nplan.md\nevidence/\nviews/\nknowledge/index.md\n.aiongside/\n",
  );
  await put(root, "knowledge/index.md", "custom index");
  await put(root, "views/open.md", "custom view");
  await initializeWorkspace(root);
  await createWork(root, "New work");
  await moveWork(root, "WORK-1", "active");
  expect(await validateWorkspace(root)).toEqual([]);
  for (const file of ["overview.md", "plan.md", "evidence"])
    await expect(
      fs.stat(path.join(root, "work/WORK-1", file)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(root, "knowledge/index.md"), "utf8")).toBe(
    "custom index",
  );
  expect(await fs.readFile(path.join(root, "views/open.md"), "utf8")).toBe(
    "custom view",
  );
});

test("does not follow a symlink used as an ignore file", async () => {
  const root = await workspace();
  await put(root, "rules.txt", "*.md\n");
  await fs.symlink(path.join(root, "rules.txt"), path.join(root, ".gitignore"));
  const read = vi.mocked(fs.readFile).mockClear();
  await expect(workMarkdownDocuments(root)).rejects.toMatchObject({
    code: "AIO-IGNORE-READ",
  });
  expect(
    read.mock.calls.some(
      (args) => String(args[0]) === path.join(root, ".gitignore"),
    ),
  ).toBe(false);
});
