import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentEvent } from "../src/agent-protocol.js";
import { hookSessionPath, resolveHookSession } from "../src/hook-session.js";

let directory: string;
let root: string;
const start = (
  cwd: string,
  session_id = "session",
  source: AgentEvent["source"] = "startup",
): AgentEvent => ({ cwd, session_id, source, hook_event_name: "SessionStart" });
const stop = (cwd: string, session_id = "session"): AgentEvent => ({
  cwd,
  session_id,
  hook_event_name: "Stop",
});

async function workspace(target: string) {
  await mkdir(path.join(target, ".aiongside"), { recursive: true });
  await writeFile(
    path.join(target, ".aiongside/config.yaml"),
    "name: fixture\n",
  );
  return target;
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aiongside-hook-session-"));
  vi.stubEnv("XDG_CACHE_HOME", path.join(directory, "cache"));
  root = await workspace(path.join(directory, "workspace"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test("binds from a nested folder and preserves the root for all later sources and cwd values", async () => {
  const nested = path.join(root, "work/WORK-1");
  await mkdir(nested, { recursive: true });
  expect(await resolveHookSession(start(nested))).toBe(root);
  const file = hookSessionPath("session");
  const before = await readFile(file);
  const beforeStat = await stat(file);
  const legacy = await workspace(path.join(root, ".legacy"));
  for (const cwd of [legacy, directory, path.join(directory, "not-present")]) {
    expect(await resolveHookSession(stop(cwd))).toBe(root);
    for (const source of ["resume", "compact", "startup", "clear"] as const)
      expect(await resolveHookSession(start(cwd, "session", source))).toBe(
        root,
      );
  }
  expect(await readFile(file)).toEqual(before);
  expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
  expect(beforeStat.mode & 0o777).toBe(0o600);
});

test("isolates session ids and hashes them instead of treating them as paths", async () => {
  const other = await workspace(path.join(directory, "other"));
  expect(await resolveHookSession(start(root, "../../first"))).toBe(root);
  expect(await resolveHookSession(start(other, "second", "clear"))).toBe(other);
  expect(await resolveHookSession(stop(other, "../../first"))).toBe(root);
  expect(await resolveHookSession(stop(root, "second"))).toBe(other);
  expect(path.basename(hookSessionPath("../../first"))).toMatch(
    /^[a-f0-9]{64}\.json$/,
  );
});

test("rejects Stop and resume or compact without a binding without creating cache files", async () => {
  for (const event of [
    stop(root),
    start(root, "session", "resume"),
    start(root, "session", "compact"),
  ])
    await expect(resolveHookSession(event)).rejects.toThrow(
      "Start a new agent session",
    );
  await expect(stat(path.join(directory, "cache"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("does not rediscover a parent workspace after the bound root is lost", async () => {
  const nested = await workspace(path.join(root, "nested"));
  await resolveHookSession(start(nested));
  await rename(
    path.join(nested, ".aiongside/config.yaml"),
    path.join(nested, ".aiongside/config.saved"),
  );
  await expect(resolveHookSession(stop(root))).rejects.toThrow(
    "no longer available",
  );
  await expect(
    resolveHookSession(start(root, "session", "resume")),
  ).rejects.toThrow("no longer available");
});

test("rejects malformed, oversized and mismatched bindings without overwriting them", async () => {
  await resolveHookSession(start(root));
  const file = hookSessionPath("session");
  for (const content of [
    "{",
    "x".repeat(16_385),
    JSON.stringify({ schema: 1, sessionId: "other", root }),
    JSON.stringify({ schema: 1, sessionId: "session", root: "." }),
  ]) {
    await writeFile(file, content);
    for (const event of [start(root), stop(root)])
      await expect(resolveHookSession(event)).rejects.toThrow(
        "Start a new agent session",
      );
    expect(await readFile(file, "utf8")).toBe(content);
  }
});

test("rejects symlink binding files and directories", async () => {
  await resolveHookSession(start(root));
  const file = hookSessionPath("session");
  const moved = path.join(directory, "saved.json");
  await rename(file, moved);
  await symlink(moved, file);
  await expect(resolveHookSession(stop(root))).rejects.toThrow(
    "Start a new agent session",
  );
  const sessions = path.dirname(file);
  const savedDirectory = path.join(directory, "saved-sessions");
  await rename(sessions, savedDirectory);
  await symlink(savedDirectory, sessions);
  await expect(resolveHookSession(start(root, "new"))).rejects.toThrow(
    "Unsafe session binding directory",
  );
});

test("does not overwrite another root during simultaneous startup", async () => {
  const other = await workspace(path.join(directory, "other"));
  const results = await Promise.allSettled([
    resolveHookSession(start(root)),
    resolveHookSession(start(other)),
  ]);
  const bound = await resolveHookSession(stop(directory));
  expect([root, other]).toContain(bound);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  for (const result of results)
    if (result.status === "fulfilled") expect(result.value).toBe(bound);
});

test("reports cache write failure instead of switching to cwd-only behavior", async () => {
  await writeFile(path.join(directory, "cache"), "not a directory");
  await expect(resolveHookSession(start(root))).rejects.toThrow(
    "Start a new agent session",
  );
  expect(await readFile(path.join(directory, "cache"), "utf8")).toBe(
    "not a directory",
  );
});
