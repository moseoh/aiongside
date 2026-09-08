import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { assertHookRoot, resolveHookRoot } from "../src/hook-root.js";

let directory: string;
let root: string;
async function workspace(target: string) {
  await mkdir(path.join(target, ".aiongside"), { recursive: true });
  await writeFile(
    path.join(target, ".aiongside/config.yaml"),
    "name: fixture\n",
  );
  return target;
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "aiongside-hook-root-"));
  root = await workspace(path.join(directory, "workspace"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test("uses the actual working directory by default, not PWD", async () => {
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("PWD", directory);
  expect(await resolveHookRoot()).toBe(root);
});

test("resolves explicit, relative and nested directories", async () => {
  const nested = path.join(root, "work/WORK-1");
  await mkdir(nested, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  expect(await resolveHookRoot("workspace/work/WORK-1")).toBe(root);
  expect(await resolveHookRoot(nested)).toBe(root);
  const legacy = await workspace(path.join(root, ".legacy"));
  vi.spyOn(process, "cwd").mockReturnValue(legacy);
  expect(await resolveHookRoot(root)).toBe(root);
  expect(await resolveHookRoot()).toBe(legacy);
});

test("does not depend on readable or writable session cache state", async () => {
  const cache = path.join(directory, "cache");
  await writeFile(cache, "not a directory");
  vi.stubEnv("XDG_CACHE_HOME", cache);
  expect(await resolveHookRoot(root)).toBe(root);
  expect(await readFile(cache, "utf8")).toBe("not a directory");
});

test("does not fall back when the explicit path is empty, missing, a file or outside a workspace", async () => {
  vi.spyOn(process, "cwd").mockReturnValue(root);
  for (const invalid of [
    "",
    " ",
    "\0",
    path.join(root, "missing"),
    path.join(root, ".aiongside/config.yaml"),
    directory,
  ])
    await expect(resolveHookRoot(invalid)).rejects.toThrow();
});

test("canonicalizes a symlink directory and rejects unsafe workspace settings", async () => {
  const alias = path.join(directory, "alias");
  await symlink(root, alias);
  expect(await resolveHookRoot(alias)).toBe(root);
  const config = path.join(root, ".aiongside/config.yaml");
  const saved = path.join(directory, "saved.yaml");
  await rename(config, saved);
  await symlink(saved, config);
  await expect(resolveHookRoot(root)).rejects.toThrow("no longer available");
});

test("rejects a selected root lost during execution even with a healthy parent", async () => {
  const nested = await workspace(path.join(root, "nested"));
  expect(await resolveHookRoot(nested)).toBe(nested);
  await rename(
    path.join(nested, ".aiongside/config.yaml"),
    path.join(nested, ".aiongside/saved.yaml"),
  );
  await expect(assertHookRoot(nested)).rejects.toThrow("no longer available");
});
