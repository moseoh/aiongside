import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { formatMarkdownDocument } from "../../core/src/index.js";
import {
  readWorkFrontmatter,
  WorkReader,
} from "../../filesystem/src/work-reader.js";
import {
  normalizeWebHost,
  parseWebUrl,
  resolveWebHost,
  webUrl,
} from "../src/host.js";
import { startWebServer } from "../src/server.js";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startWebServer>>[] = [];
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function put(root: string, file: string, source: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), source);
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiongside-web-"));
  roots.push(root);
  await put(
    root,
    ".aiongside/config.yaml",
    "schema: 1\nname: Work browser\nidPrefix: WORK\n",
  );
  for (let n = 1; n <= 2; n++) {
    const metadata = {
      schema: 1,
      id: `WORK-${n}`,
      title: `Work ${n}`,
      status: n === 1 ? "done" : "waiting",
      type: "delivery",
      created: "2026-09-08",
      updated: "2026-09-08",
      needs: ["WORK-99"],
      completionSeal: {
        completedAt: "2026-09-08T00:00:00Z",
        digest: "0".repeat(64),
      },
    };
    await put(
      root,
      `work/WORK-${n}/record.md`,
      formatMarkdownDocument(metadata, "Changed sealed content."),
    );
    await put(
      root,
      `work/WORK-${n}/overview.md`,
      "# Overview\n\nStale but readable.\n",
    );
  }
  await put(
    root,
    "work/WORK-1/deliverables/guide.md",
    "# Guide\n\n[Other work](../../WORK-2/overview.md)\n",
  );
  return root;
}
async function serve(root: string) {
  const server = await startWebServer(root);
  servers.push(server);
  return server.url;
}
async function get(url: string, route: string, file?: string) {
  const response = await fetch(
    `${url}/api/${route}${file ? `?path=${encodeURIComponent(file)}` : ""}`,
  );
  return { status: response.status, value: await response.json() };
}
async function snapshot(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(folder: string) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const target = path.join(folder, item.name);
      if (item.isDirectory()) await walk(target);
      else if (item.isFile())
        entries.push(
          `${path.relative(root, target)}:${createHash("sha256")
            .update(await fs.readFile(target))
            .digest("hex")}`,
        );
    }
  }
  await walk(root);
  return entries.sort().join("\n");
}

test("lists metadata without loading Record bodies, support files or seals", async () => {
  const root = await fixture();
  const target = path.join(root, "work/WORK-1/record.md");
  await fs.appendFile(target, "x".repeat(5 * 1024 * 1024));
  const actualOpen = vi.mocked(fs.open).getMockImplementation();
  let bytes = 0;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actualOpen?.(...args);
    if (!handle) throw new Error("Missing file handle");
    if (args[0] === target) {
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        bytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
    }
    return handle;
  });
  const reader = await WorkReader.create(root);
  const result = await reader.list();
  expect(result.works).toHaveLength(2);
  expect(result.issues).toEqual([]);
  expect(bytes).toBeLessThan(4096);
  expect(bytes).toBeGreaterThan(0);
  expect(
    vi
      .mocked(fs.readFile)
      .mock.calls.some(([file]) => String(file).endsWith("record.md")),
  ).toBe(false);
  expect(
    vi
      .mocked(fs.readdir)
      .mock.calls.some(([file]) => String(file).includes("deliverables")),
  ).toBe(false);
});

test("reports malformed Records without hiding valid Work and rejects oversized metadata", async () => {
  const root = await fixture();
  await put(root, "work/WORK-3/record.md", "broken");
  const result = await (await WorkReader.create(root)).list();
  expect(result.works).toHaveLength(2);
  expect(result.issues[0]?.path).toBe("work/WORK-3/record.md");
  await put(
    root,
    "work/WORK-3/record.md",
    `---\n${"x".repeat(1024 * 1024 + 1)}`,
  );
  await expect(
    readWorkFrontmatter(path.join(root, "work/WORK-3/record.md")),
  ).rejects.toThrow("1 MiB");
});

test("lists excluded entries with a flag, keeps managed Work selection for lists", async () => {
  const root = await fixture();
  await put(root, ".gitignore", "node_modules/\n*.tmp\n");
  await put(root, "work/WORK-1/.gitignore", "!keep.tmp\n");
  await put(root, "work/WORK-1/drop.tmp", "hidden");
  await put(root, "work/WORK-1/keep.tmp", "visible");
  await put(root, "work/WORK-1/UPPER.TMP", "visible");
  await put(root, "work/WORK-1/node_modules/.gitignore", "!README.md\n");
  await put(
    root,
    "work/WORK-1/node_modules/README.md",
    "inside excluded parent",
  );
  await put(root, "work/WORK-1/Zeta.md", "z");
  await put(root, "work/WORK-1/alpha.md", "a");
  const url = await serve(root);
  const listed = await get(url, "directory", "work/WORK-1");
  const byName = Object.fromEntries(
    listed.value.map((entry: { name: string; ignored: boolean }) => [
      entry.name,
      entry.ignored,
    ]),
  );
  expect(byName).toEqual({
    deliverables: false,
    node_modules: true,
    ".gitignore": false,
    "UPPER.TMP": false,
    "Zeta.md": false,
    "alpha.md": false,
    "drop.tmp": true,
    "keep.tmp": false,
    "overview.md": false,
    "record.md": false,
  });
  expect(listed.value.map((entry: { name: string }) => entry.name)).toEqual([
    "deliverables",
    "node_modules",
    ".gitignore",
    "alpha.md",
    "drop.tmp",
    "keep.tmp",
    "overview.md",
    "record.md",
    "UPPER.TMP",
    "Zeta.md",
  ]);
  const inside = await get(url, "directory", "work/WORK-1/node_modules");
  expect(
    inside.value.map((entry: { ignored: boolean }) => entry.ignored),
  ).toEqual([true, true]);
  for (const file of ["drop.tmp", ".gitignore", "node_modules/README.md"])
    expect((await get(url, "document", `work/WORK-1/${file}`)).status).toBe(
      200,
    );
  expect(
    (await get(url, "document", "work/WORK-1/node_modules/README.md")).value
      .source,
  ).toBe("inside excluded parent");
  await put(root, ".gitignore", "work/WORK-2/record.md\n");
  expect((await get(url, "works")).value.works).toHaveLength(1);
  expect((await get(url, "document", "work/WORK-2/overview.md")).status).toBe(
    400,
  );
  expect((await get(url, "works/WORK-2")).status).toBe(400);
});

test("returns one Work with its Overview path and rejects unknown IDs", async () => {
  const root = await fixture();
  const url = await serve(root);
  const one = await get(url, "works/WORK-1");
  expect(one.status).toBe(200);
  expect(one.value.id).toBe("WORK-1");
  expect(one.value.needs).toEqual(["WORK-99"]);
  expect(one.value.overview).toBe("work/WORK-1/overview.md");
  await fs.unlink(path.join(root, "work/WORK-1/overview.md"));
  expect((await get(url, "works/WORK-1")).value.overview).toBeNull();
  expect((await get(url, "works/WORK-3")).status).toBe(400);
  expect((await get(url, "works/../secret")).status).toBe(404);
});

test("reads a Knowledge tree with keys, index files, duplicates and Work references", async () => {
  const root = await fixture();
  await put(root, "knowledge/index.md", "# Index\n");
  await put(
    root,
    "knowledge/b-doc.md",
    "---\naiongside:\n  schema: 1\n  key: beta\n  title: Beta doc\n---\n\nBody\n",
  );
  await put(root, "knowledge/arch/index.md", "# Arch\n");
  await put(
    root,
    "knowledge/arch/one.md",
    "---\naiongside:\n  schema: 1\n  key: dup\n---\n\nOne\n",
  );
  await put(
    root,
    "knowledge/arch/two.md",
    "---\naiongside:\n  schema: 1\n  key: dup\n---\n\nTwo\n",
  );
  await put(root, "knowledge/arch/broken.md", "no frontmatter");
  await put(root, "knowledge/arch/diagram.png", Buffer.from([137, 80, 78, 71]));
  await put(root, ".gitignore", "*.tmp\n");
  await put(root, "knowledge/hidden.tmp", "x");
  await put(
    root,
    "work/WORK-2/record.md",
    formatMarkdownDocument(
      {
        schema: 1,
        id: "WORK-2",
        title: "Work 2",
        status: "waiting",
        type: "delivery",
        created: "2026-09-08",
        updated: "2026-09-08",
        knowledge: ["beta", "missing-key"],
      },
      "Body",
    ),
  );
  const url = await serve(root);
  const result = await get(url, "knowledge");
  expect(result.status).toBe(200);
  expect(result.value.index).toBe("knowledge/index.md");
  expect(result.value.nodes.map((node: { name: string }) => node.name)).toEqual(
    ["arch", "b-doc.md"],
  );
  const arch = result.value.nodes[0];
  expect(arch.index).toBe("knowledge/arch/index.md");
  expect(
    arch.children.map((node: { name: string; kind: string }) => [
      node.name,
      node.kind,
    ]),
  ).toEqual([
    ["broken.md", "document"],
    ["diagram.png", "file"],
    ["one.md", "document"],
    ["two.md", "document"],
  ]);
  expect(arch.children[0].error).toContain("Invalid Knowledge frontmatter");
  expect(arch.children[2].error).toContain("Duplicate Knowledge key dup");
  expect(result.value.nodes[1]).toMatchObject({
    key: "beta",
    title: "Beta doc",
    error: null,
  });
  expect(result.value.references).toEqual({
    beta: ["WORK-2"],
    "missing-key": ["WORK-2"],
  });
  expect(
    result.value.issues.map((issue: { path: string }) => issue.path),
  ).toEqual(
    expect.arrayContaining([
      "knowledge/arch/broken.md",
      "knowledge/arch/one.md",
      "knowledge/arch/two.md",
    ]),
  );
  expect((await get(url, "document", "knowledge/b-doc.md")).value.source).toBe(
    "Body\n",
  );
  expect((await get(url, "document", "knowledge/hidden.tmp")).status).toBe(400);
  expect((await get(url, "directory", "knowledge/arch")).value).toHaveLength(5);
});

test("serves assets and safe documents without changing an invalid workspace", async () => {
  const root = await fixture();
  const before = await snapshot(root);
  const url = await serve(root);
  const shell = await fetch(`${url}/`);
  expect(shell.status).toBe(200);
  expect(shell.headers.get("content-type")).toContain("text/html");
  const html = await shell.text();
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(script).toBeDefined();
  expect((await fetch(url + script)).headers.get("content-type")).toContain(
    "text/javascript",
  );
  for (const route of ["/work", "/work/WORK-1/file/record.md", "/knowledge/x"])
    expect(await (await fetch(url + route)).text()).toBe(html);
  expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
  expect((await fetch(`${url}/api/missing`)).status).toBe(404);
  expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  expect((await get(url, "works")).value.works).toHaveLength(2);
  const overview = await get(url, "document", "work/WORK-1/overview.md");
  expect(overview.value.source).toContain("Stale but readable");
  expect(overview.value.html).toBeUndefined();
  expect(
    (await get(url, "document", "work/WORK-1/record.md")).value.source,
  ).toBe("Changed sealed content.\n");
  expect(
    (
      await fetch(`${url}/api/download?path=work/WORK-1/record.md`, {
        method: "HEAD",
      })
    ).headers.get("content-disposition"),
  ).toContain("attachment");
  expect((await fetch(`${url}/api/works`, { method: "POST" })).status).toBe(
    405,
  );
  expect(await snapshot(root)).toBe(before);
  await put(root, "work/WORK-1/overview.md", "# Refreshed\n");
  expect(
    (await get(url, "document", "work/WORK-1/overview.md")).value.source,
  ).toContain("Refreshed");
  await fs.unlink(path.join(root, "work/WORK-1/overview.md"));
  expect((await get(url, "document", "work/WORK-1/overview.md")).status).toBe(
    400,
  );
  expect((await get(url, "document", "work/WORK-1/record.md")).status).toBe(
    200,
  );
});

test("limits previews and sends active formats as attachment downloads", async () => {
  const root = await fixture();
  const url = await serve(root);
  for (const [name, value, kind] of [
    ["limit.txt", "x".repeat(1024 * 1024), "text"],
    ["large.txt", "x".repeat(1024 * 1024 + 1), "download"],
    ["page.html", "<script>alert(1)</script>", "download"],
    ["image.svg", '<svg onload="alert(1)"></svg>', "download"],
    ["binary.dat", Buffer.from([0, 255, 2]), "download"],
  ] as const) {
    await put(root, `work/WORK-1/${name}`, value);
    expect((await get(url, "document", `work/WORK-1/${name}`)).value.kind).toBe(
      kind,
    );
    const download = await fetch(
      `${url}/api/download?path=work/WORK-1/${name}`,
    );
    expect(download.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(downloaded.equals(Buffer.from(value))).toBe(true);
  }
});

test("rejects foreign origins, rebinding hosts and unauthenticated control", async () => {
  const root = await fixture();
  const url = await serve(root);
  expect(
    (await fetch(url, { headers: { Origin: "https://evil.example" } })).status,
  ).toBe(403);
  expect(
    (await fetch(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
  ).toBe(403);
  expect((await fetch(`${url}/_control`, { method: "POST" })).status).toBe(403);
  const status = await new Promise<number | undefined>((resolve) => {
    const req = request(
      url,
      { headers: { host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.end();
  });
  expect(status).toBe(403);
  expect((await fetch(url)).headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
});

test("explicit hostname and resolved IP accept only matching request origins", async () => {
  const root = await fixture();
  const server = await startWebServer(root, { host: "localhost" });
  servers.push(server);
  expect(server.url).toMatch(/^http:\/\/localhost:/);
  expect(server.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  for (const url of [server.url, server.controlUrl]) {
    expect(
      (await fetch(`${url}/api/works`, { headers: { Origin: url } })).status,
    ).toBe(200);
  }
  expect(
    (await fetch(server.url, { headers: { Origin: server.controlUrl } }))
      .status,
  ).toBe(403);
  expect(server.network).toBe(false);
});

test.each(["127.0.0.2", "::1"])(
  "binds the requested IP %s and formats its URL",
  async (host) => {
    const server = await startWebServer(await fixture(), { host });
    servers.push(server);
    expect(server.url).toContain(host === "::1" ? "[::1]" : host);
    expect((await fetch(server.url)).status).toBe(200);
    expect(server.network).toBe(false);
  },
);

test("validates hosts without accepting wildcard interfaces or URL components", async () => {
  expect(await resolveWebHost()).toEqual({
    host: "127.0.0.1",
    address: "127.0.0.1",
  });
  expect(normalizeWebHost("Dev-Tailscale")).toBe("dev-tailscale");
  expect(webUrl("::1", 3000)).toBe("http://[::1]:3000");
  for (const host of [
    "",
    "0.0.0.0",
    "::",
    "[::]",
    "0",
    "http://localhost",
    "localhost:3000",
    "localhost/path",
    "a@localhost",
    " host",
    "*.example.com",
  ])
    expect(() => normalizeWebHost(host)).toThrow();
  for (const url of [
    "https://localhost:3000",
    "http://user:pass@localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000?x=1",
  ])
    expect(() => parseWebUrl(url)).toThrow();
});

/** Minimal SSE client: yields parsed events from /api/events. */
async function sse(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/events`, {
    headers: { Accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const queue: { event: string; id?: string; data: unknown }[] = [];
  let done = false;
  async function pump() {
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let index = buffered.indexOf("\n\n");
      while (index >= 0) {
        const block = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
        }
        if (fields.data !== undefined)
          queue.push({
            event: fields.event ?? "message",
            ...(fields.id !== undefined ? { id: fields.id } : {}),
            data: JSON.parse(fields.data),
          });
        index = buffered.indexOf("\n\n");
      }
    }
    done = true;
  }
  const pumping = pump().catch(() => {
    done = true;
  });
  async function next(timeout = 3000) {
    const started = Date.now();
    while (!queue.length) {
      if (done) throw new Error("Stream ended.");
      if (Date.now() - started > timeout) throw new Error("Timed out.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return queue.shift() as { event: string; id?: string; data: unknown };
  }
  return {
    response,
    next,
    ended: () => pumping.then(() => done),
    close: () => controller.abort(),
  };
}

test("streams a live state event then change events over /api/events", async () => {
  const root = await fixture();
  const server = await startWebServer(root, { watchDebounceMs: 50 });
  servers.push(server);
  const stream = await sse(server.url);
  expect(stream.response.headers.get("content-type")).toContain(
    "text/event-stream",
  );
  expect(stream.response.headers.get("cache-control")).toBe("no-store");
  expect(await stream.next()).toMatchObject({
    event: "state",
    data: { state: "live" },
  });
  await put(
    root,
    "work/WORK-2/record.md",
    formatMarkdownDocument(
      {
        schema: 1,
        id: "WORK-2",
        title: "Work 2",
        status: "active",
        type: "delivery",
        created: "2026-09-08",
        updated: "2026-09-10",
        needs: [],
      },
      "Moved on.",
    ),
  );
  const change = await stream.next();
  expect(change.event).toBe("change");
  expect(change.id).toBe("1");
  expect(change.data).toMatchObject({
    work: "WORK-2",
    path: "work/WORK-2/record.md",
    status: { from: "waiting", to: "active" },
  });
  stream.close();
});

test("replays after Last-Event-ID and asks for a resync when the id is unknown", async () => {
  const root = await fixture();
  const server = await startWebServer(root, { watchDebounceMs: 50 });
  servers.push(server);
  const first = await sse(server.url);
  await first.next();
  await put(root, "work/WORK-1/a.md", "a");
  await first.next();
  await put(root, "work/WORK-1/b.md", "b");
  await first.next();
  first.close();
  const replay = await sse(server.url, { "Last-Event-ID": "1" });
  expect(await replay.next()).toMatchObject({
    event: "state",
    data: { state: "live", resync: false },
  });
  expect(await replay.next()).toMatchObject({
    id: "2",
    data: { path: "work/WORK-1/b.md" },
  });
  replay.close();
  const stale = await sse(server.url, { "Last-Event-ID": "99" });
  expect(await stale.next()).toMatchObject({
    data: { state: "live", resync: true },
  });
  stale.close();
});

test("rejects event streams from other origins and non-GET methods", async () => {
  const root = await fixture();
  const url = await serve(root);
  const foreign = await fetch(`${url}/api/events`, {
    headers: { Origin: "http://evil.example" },
  });
  expect(foreign.status).toBe(403);
  const post = await fetch(`${url}/api/events`, { method: "POST" });
  expect(post.status).toBe(405);
});

test("ends open event streams when the server closes", async () => {
  const root = await fixture();
  const server = await startWebServer(root, { watchDebounceMs: 50 });
  const stream = await sse(server.url);
  await stream.next();
  const started = Date.now();
  await server.close();
  expect(await stream.ended()).toBe(true);
  expect(Date.now() - started).toBeLessThan(900);
});

test("tells clients when watching is unsupported and closes the stream", async () => {
  const root = await fixture();
  const server = await startWebServer(root, {
    watch: () => {
      throw new Error("unsupported");
    },
  });
  servers.push(server);
  const stream = await sse(server.url);
  expect(await stream.next()).toMatchObject({ data: { state: "unsupported" } });
  expect(await stream.ended()).toBe(true);
});
