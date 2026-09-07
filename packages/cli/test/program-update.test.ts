import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createProgram } from "../src/program.js";
import { defaultRunProcess, fetchLatestVersion } from "../src/update.js";

vi.mock("../src/update.js", async (original) => ({
  ...(await original<typeof import("../src/update.js")>()),
  fetchLatestVersion: vi.fn(async () => "99.0.0"),
  defaultRunProcess: vi.fn(async () => 0),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("global update ignores missing and damaged workspace roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aiongside-global-update-"));
  roots.push(root);
  await createProgram().parseAsync(
    ["--root", path.join(root, "absent"), "update", "--yes"],
    { from: "user" },
  );
  await mkdir(path.join(root, ".aiongside"));
  const config = path.join(root, ".aiongside", "config.yaml");
  await writeFile(config, "broken");
  await createProgram().parseAsync(["--root", root, "update", "--yes"], {
    from: "user",
  });
  expect(fetchLatestVersion).toHaveBeenCalledTimes(2);
  expect(vi.mocked(defaultRunProcess).mock.calls).toEqual([
    ["npm", ["install", "--global", "aiongside@99.0.0"]],
    ["npm", ["install", "--global", "aiongside@99.0.0"]],
  ]);
  expect(await readFile(config, "utf8")).toBe("broken");
});
