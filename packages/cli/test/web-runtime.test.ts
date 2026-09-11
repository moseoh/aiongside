import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const exec = promisify(execFile);
const bin = path.resolve(import.meta.dirname, "../dist/bin.js");
const runtime = process.env.AIONGSIDE_TEST_RUNTIME ?? process.execPath;
const fixtures: { root: string; cache: string }[] = [];
const children: ReturnType<typeof spawn>[] = [];
async function fixture() {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "aiongside-web-runtime-"),
  );
  const root = path.join(parent, "workspace");
  const cache = path.join(parent, "cache");
  fixtures.push({ root, cache });
  await mkdir(path.join(root, ".aiongside"), { recursive: true });
  await mkdir(path.join(root, "work"));
  await writeFile(
    path.join(root, ".aiongside/config.yaml"),
    "schema: 1\nname: Runtime\nidPrefix: WORK\n",
  );
  return { root, cache };
}
async function cli(context: { root: string; cache: string }, args: string[]) {
  return exec(runtime, [bin, "--root", context.root, "view", "web", ...args], {
    env: { ...process.env, XDG_CACHE_HOME: context.cache },
    timeout: 15_000,
  });
}
function url(output: string) {
  return /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0] as string;
}
async function state(context: { cache: string }) {
  const directory = path.join(context.cache, "aiongside/web");
  const files = await readdir(directory);
  const file = path.join(directory, files[0] as string);
  return { file, value: JSON.parse(await readFile(file, "utf8")) };
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  for (const context of fixtures.splice(0)) {
    await cli(context, ["stop"]).catch(() => {});
    await rm(path.dirname(context.root), { recursive: true, force: true });
  }
});

test("background readiness, duplicate start, authenticated stop and restart", async () => {
  const context = await fixture();
  const result = await cli(context, ["--background"]);
  const address = url(result.stdout);
  expect(result.stdout).toContain("view web stop");
  expect((await fetch(`${address}/api/works`)).status).toBe(200);
  const saved = await state(context);
  expect(saved.value.root).toBe(context.root);
  expect(result.stdout).not.toContain(saved.value.token);
  expect(
    (
      await fetch(`${address}/_control`, {
        method: "POST",
        headers: { "x-aiongside-token": "0".repeat(64) },
      })
    ).status,
  ).toBe(403);
  expect(url((await cli(context, ["--background"])).stdout)).toBe(address);
  expect((await cli(context, ["stop"])).stdout).toContain("stopped");
  await expect(fetch(address)).rejects.toThrow();
  expect((await cli(context, ["stop"])).stdout).toContain("No background");
  expect(url((await cli(context, ["--background"])).stdout)).toBeTruthy();
}, 20_000);

test("hostname background stop pins its IP even if the saved display name changes", async () => {
  const context = await fixture();
  const result = await cli(context, ["--host", "localhost", "--background"]);
  expect(result.stdout).toMatch(/^http:\/\/localhost:/);
  const saved = await state(context);
  expect(saved.value.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(
    (await cli(context, ["--host", "localhost", "--background"])).stdout,
  ).toBe(result.stdout);
  await expect(
    cli(context, ["--host", "127.0.0.2", "--background"]),
  ).rejects.toMatchObject({ code: 2 });
  await expect(
    cli(context, ["--port", "1", "--background"]),
  ).rejects.toMatchObject({ code: 2 });
  await writeFile(
    saved.file,
    JSON.stringify({
      ...saved.value,
      url: saved.value.url.replace("localhost", "not-resolvable.invalid"),
    }),
  );
  expect((await cli(context, ["stop"])).stdout).toContain("stopped");
}, 20_000);

test("refuses nonlocal control destinations and invalid host options", async () => {
  const context = await fixture();
  for (const host of ["0.0.0.0", "http://localhost", "localhost:3000"])
    await expect(
      cli(context, ["--host", host, "--background"]),
    ).rejects.toMatchObject({ code: 2 });
  await expect(
    cli(context, ["stop", "--host", "localhost"]),
  ).rejects.toMatchObject({ code: 2 });
  await cli(context, ["--background"]);
  const saved = await state(context);
  try {
    await writeFile(
      saved.file,
      JSON.stringify({ ...saved.value, controlUrl: "http://192.0.2.1:3000" }),
    );
    await expect(cli(context, ["stop"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("No request was sent"),
    });
    expect((await fetch(saved.value.url)).status).toBe(200);
  } finally {
    await writeFile(saved.file, JSON.stringify(saved.value));
  }
}, 20_000);

test("workspace isolation and concurrent startup", async () => {
  const first = await fixture();
  const second = await fixture();
  const results = await Promise.allSettled([
    cli(first, ["--background"]),
    cli(first, ["--background"]),
  ]);
  const successes = results.flatMap((result) =>
    result.status === "fulfilled" ? [url(result.value.stdout)] : [],
  );
  expect(successes.length).toBeGreaterThan(0);
  expect(new Set(successes).size).toBe(1);
  const other = url((await cli(second, ["--background"])).stdout);
  await cli(first, ["stop"]);
  expect((await fetch(other)).status).toBe(200);
}, 20_000);

test("startup errors do not report a URL or leave a reservation", async () => {
  const context = await fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) =>
    occupied.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    await expect(
      cli(context, ["--background", "--port", String(address.port)]),
    ).rejects.toMatchObject({ code: 2 });
    expect(await readdir(path.join(context.cache, "aiongside/web"))).toEqual(
      [],
    );
    await expect(cli(context, ["--port", "-1"])).rejects.toMatchObject({
      code: 2,
    });
    await expect(cli(context, ["stop", "--background"])).rejects.toMatchObject({
      code: 2,
    });
    await writeFile(
      path.join(context.root, ".aiongside/config.yaml"),
      "bad config",
    );
    await expect(cli(context, ["--background"])).rejects.toMatchObject({
      code: 2,
    });
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
}, 20_000);

test("foreground returns a URL, holds the terminal and exits on Ctrl+C", async () => {
  const context = await fixture();
  const child = spawn(runtime, [bin, "--root", context.root, "view", "web"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_CACHE_HOME: context.cache },
  });
  children.push(child);
  const output = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("No startup output")),
      5000,
    );
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Ctrl+C")) {
        clearTimeout(timer);
        resolve(output);
      }
    });
  });
  expect(child.exitCode).toBeNull();
  expect((await fetch(url(output))).status).toBe(200);
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGINT");
  await exited;
  await expect(fetch(url(output))).rejects.toThrow();
  await expect(readdir(context.cache)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("stale runtime is recoverable without signalling a PID", async () => {
  const context = await fixture();
  await cli(context, ["--background"]);
  const saved = await state(context);
  await cli(context, ["stop"]);
  // A joined process has exited; its PID is used only for a liveness query.
  const exited = spawn(runtime, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => exited.once("exit", () => resolve()));
  await writeFile(
    saved.file,
    JSON.stringify({ ...saved.value, pid: exited.pid }),
  );
  expect(url((await cli(context, ["--background"])).stdout)).toBeTruthy();
}, 20_000);

test("--json reports the URL, workspace and stop command for background start and stop", async () => {
  const context = await fixture();
  const started = JSON.parse(
    (await cli(context, ["--background", "--json"])).stdout,
  );
  expect(started).toMatchObject({
    version: 1,
    root: context.root,
    background: true,
    network: false,
  });
  expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(started.stop).toContain("view web stop");
  expect(JSON.stringify(started)).not.toContain(
    (await state(context)).value.token,
  );
  const again = JSON.parse(
    (await cli(context, ["--background", "--json"])).stdout,
  );
  expect(again.url).toBe(started.url);
  const stopped = JSON.parse((await cli(context, ["stop", "--json"])).stdout);
  expect(stopped).toEqual({ version: 1, root: context.root, stopped: true });
  const idle = JSON.parse((await cli(context, ["stop", "--json"])).stdout);
  expect(idle).toEqual({ version: 1, root: context.root, stopped: false });
});
