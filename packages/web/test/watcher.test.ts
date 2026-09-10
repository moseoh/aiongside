import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { formatMarkdownDocument } from "../../core/src/index.js";
import { type ChangeEvent, WorkspaceWatcher } from "../src/watcher.js";

const roots: string[] = [];
const watchers: WorkspaceWatcher[] = [];
afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function put(root: string, file: string, source: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), source);
}
function record(id: string, status: string, title = `Work ${id}`) {
  return formatMarkdownDocument(
    {
      schema: 1,
      id,
      title,
      status,
      type: "delivery",
      created: "2026-09-10",
      updated: "2026-09-10",
      needs: [],
    },
    "Body.",
  );
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiongside-watch-"));
  roots.push(root);
  await put(
    root,
    ".aiongside/config.yaml",
    "schema: 1\nname: Watch\nidPrefix: WORK\n",
  );
  await put(root, "work/WORK-1/record.md", record("WORK-1", "active"));
  await put(root, "knowledge/index.md", "# Knowledge\n");
  return root;
}
async function watch(root: string) {
  const watcher = await WorkspaceWatcher.start(root, { debounceMs: 50 });
  watchers.push(watcher);
  return watcher;
}
/** Collect the next batch, or every batch until `count` events arrived. */
function nextBatch(watcher: WorkspaceWatcher, count = 1) {
  return new Promise<ChangeEvent[]>((resolve, reject) => {
    const collected: ChangeEvent[] = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out with ${JSON.stringify(collected)}`));
    }, 3000);
    const unsubscribe = watcher.subscribe((events) => {
      collected.push(...events);
      if (collected.length >= count) {
        clearTimeout(timer);
        unsubscribe();
        resolve(collected);
      }
    });
  });
}

test("batches rapid writes to one Work file into a single updated event", async () => {
  const root = await fixture();
  const watcher = await watch(root);
  const batch = nextBatch(watcher);
  for (let n = 0; n < 5; n++)
    await put(root, "work/WORK-1/deliverables/note.md", `draft ${n}\n`);
  const events = await batch;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    scope: "work",
    work: "WORK-1",
    path: "work/WORK-1/deliverables/note.md",
    kind: "updated",
  });
  expect(events[0]?.id).toBe(1);
  expect(events[0]?.status).toBeUndefined();
});

test("ignores changes to .gitignore-excluded paths", async () => {
  const root = await fixture();
  await put(root, ".gitignore", "*.tmp\n");
  const watcher = await watch(root);
  const batch = nextBatch(watcher);
  await put(root, "work/WORK-1/scratch.tmp", "hidden");
  await put(root, "work/WORK-1/visible.md", "shown");
  const events = await batch;
  expect(events.map((event) => event.path)).toEqual(["work/WORK-1/visible.md"]);
});

test("reports Record status transitions with previous and next status", async () => {
  const root = await fixture();
  const watcher = await watch(root);
  const batch = nextBatch(watcher);
  await put(root, "work/WORK-1/record.md", record("WORK-1", "waiting"));
  const [event] = await batch;
  expect(event).toMatchObject({
    scope: "work",
    work: "WORK-1",
    title: "Work WORK-1",
    path: "work/WORK-1/record.md",
    kind: "updated",
    status: { from: "active", to: "waiting" },
  });
  const again = nextBatch(watcher);
  await put(
    root,
    "work/WORK-1/record.md",
    record("WORK-1", "waiting", "Renamed"),
  );
  const [second] = await again;
  expect(second?.status).toBeUndefined();
  expect(second?.title).toBe("Renamed");
});

test("reports Record creation and deletion", async () => {
  const root = await fixture();
  const watcher = await watch(root);
  const created = nextBatch(watcher);
  await put(root, "work/WORK-2/record.md", record("WORK-2", "inbox"));
  expect((await created)[0]).toMatchObject({
    work: "WORK-2",
    kind: "created",
    title: "Work WORK-2",
    status: { from: "", to: "inbox" },
  });
  const deleted = nextBatch(watcher);
  await fs.rm(path.join(root, "work/WORK-2"), { recursive: true });
  const events = await deleted;
  expect(
    events.find((event) => event.path === "work/WORK-2/record.md"),
  ).toMatchObject({
    work: "WORK-2",
    kind: "deleted",
    title: "Work WORK-2",
  });
});

test("reports unreadable Record frontmatter as an error and keeps the last status", async () => {
  const root = await fixture();
  const watcher = await watch(root);
  const broken = nextBatch(watcher);
  await put(root, "work/WORK-1/record.md", "not frontmatter");
  const [event] = await broken;
  expect(event).toMatchObject({ work: "WORK-1", kind: "updated" });
  expect(event?.error).toBeTruthy();
  expect(event?.status).toBeUndefined();
  const fixed = nextBatch(watcher);
  await put(root, "work/WORK-1/record.md", record("WORK-1", "done"));
  expect((await fixed)[0]?.status).toEqual({ from: "active", to: "done" });
});

test("reports Knowledge changes with the knowledge scope", async () => {
  const root = await fixture();
  const watcher = await watch(root);
  const batch = nextBatch(watcher);
  await put(
    root,
    "knowledge/web/api.md",
    "---\naiongside:\n  schema: 1\n  key: web.api\n---\n# API\n",
  );
  const [event] = await batch;
  expect(event).toMatchObject({
    scope: "knowledge",
    path: "knowledge/web/api.md",
    kind: "updated",
  });
  expect(event?.work).toBeUndefined();
});

test("replays events after a known id and reports ids outside the buffer", async () => {
  const root = await fixture();
  const watcher = await watch(root);
  const first = nextBatch(watcher);
  await put(root, "work/WORK-1/a.md", "a");
  await first;
  const second = nextBatch(watcher);
  await put(root, "work/WORK-1/b.md", "b");
  await second;
  expect(watcher.since(0)?.map((event) => event.path)).toEqual([
    "work/WORK-1/a.md",
    "work/WORK-1/b.md",
  ]);
  expect(watcher.since(1)?.map((event) => event.path)).toEqual([
    "work/WORK-1/b.md",
  ]);
  expect(watcher.since(2)).toEqual([]);
  expect(watcher.since(99)).toBeUndefined();
});

test("drops the oldest events once the replay buffer is full", async () => {
  const root = await fixture();
  const watcher = await WorkspaceWatcher.start(root, {
    debounceMs: 50,
    bufferSize: 2,
  });
  watchers.push(watcher);
  for (const name of ["a", "b", "c"]) {
    const batch = nextBatch(watcher);
    await put(root, `work/WORK-1/${name}.md`, name);
    await batch;
  }
  expect(watcher.since(0)).toBeUndefined();
  expect(watcher.since(1)?.map((event) => event.path)).toEqual([
    "work/WORK-1/b.md",
    "work/WORK-1/c.md",
  ]);
});

test("reports unsupported recursive watching instead of silently emitting nothing", async () => {
  const root = await fixture();
  const watcher = await WorkspaceWatcher.start(root, {
    watch: () => {
      throw Object.assign(new Error("recursive watch unavailable"), {
        code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      });
    },
  });
  watchers.push(watcher);
  expect(watcher.supported).toBe(false);
  const supported = await watch(root);
  expect(supported.supported).toBe(true);
});
