import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  collectUpdateNotices,
  formatUpdateNotices,
  projectUpdatePreferences,
  skipUpdateVersion,
} from "../src/update-notices.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(version = 1) {
  const root = await mkdtemp(path.join(tmpdir(), "aiongside-notices-"));
  roots.push(root);
  await mkdir(path.join(root, ".aiongside/internal"), { recursive: true });
  await writeFile(
    path.join(root, ".aiongside", "internal", "integration.json"),
    JSON.stringify({ schema: 1, version }),
  );
  return {
    root,
    cliVersion: "0.3.0",
    integrationVersion: 2,
    userPreferences: path.join(root, "user", "preferences.json"),
    cache: path.join(root, "cache.json"),
    now: 10000,
    getLatestVersion: vi.fn(async () => "0.4.0"),
  };
}

describe("update notices", () => {
  test("reports two independent versions with explicit commands and caches the lookup", async () => {
    const options = await fixture();
    const notices = await collectUpdateNotices(options);
    expect(notices.map((x) => x.kind)).toEqual([
      "cli-update",
      "workspace-upgrade",
    ]);
    expect(notices[0]?.skipCommand).toBe(
      "aiongside update --skip-version 0.4.0",
    );
    expect(notices[1]?.skipCommand).toContain(
      "workspace upgrade --skip-version 2",
    );
    expect(formatUpdateNotices(notices)).toContain("Silence or postponing");
    await collectUpdateNotices(options);
    expect(options.getLatestVersion).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(options.cache, "utf8"))).toEqual({
      schema: 1,
      version: "0.4.0",
      checkedAt: 10000,
    });
  });

  test("skips exactly one version and retains existing preferences", async () => {
    const options = await fixture();
    await skipUpdateVersion(options.userPreferences, "0.4.0", "user");
    expect(
      (await skipUpdateVersion(options.userPreferences, "0.4.0", "user"))
        .changed,
    ).toBe(false);
    await skipUpdateVersion(
      projectUpdatePreferences(options.root),
      "2",
      "project",
    );
    expect(await collectUpdateNotices(options)).toEqual([]);
    const next = await collectUpdateNotices({
      ...options,
      integrationVersion: 3,
      now: 4000000,
      getLatestVersion: async () => "0.5.0",
    });
    expect(next.map((x) => x.targetVersion)).toEqual(["0.5.0", "3"]);
    expect(JSON.parse(await readFile(options.userPreferences, "utf8"))).toEqual(
      { schema: 1, skippedVersions: ["0.4.0"] },
    );
  });

  test("shares user refusals but isolates project refusals", async () => {
    const first = await fixture();
    const second = await fixture();
    await skipUpdateVersion(first.userPreferences, "0.4.0", "user");
    await skipUpdateVersion(
      projectUpdatePreferences(first.root),
      "2",
      "project",
    );
    expect(
      (
        await collectUpdateNotices({
          ...second,
          userPreferences: first.userPreferences,
        })
      ).map((x) => x.kind),
    ).toEqual(["workspace-upgrade"]);
  });

  test("does not infer an integration upgrade from CLI releases", async () => {
    const options = await fixture(2);
    expect((await collectUpdateNotices(options)).map((x) => x.kind)).toEqual([
      "cli-update",
    ]);
    const newer = await fixture(3);
    const notices = await collectUpdateNotices(newer);
    expect(notices[1]?.message).toContain("do not downgrade");
    expect(notices[1]?.skipCommand).toBeUndefined();
  });

  test("offline and timeout failures do not lose local integration notices", async () => {
    const options = await fixture();
    for (const getLatestVersion of [
      async () => {
        throw new Error("offline");
      },
      () => new Promise<string>(() => {}),
    ]) {
      const notices = await collectUpdateNotices({
        ...options,
        getLatestVersion,
        timeoutMs: 10,
      });
      expect(notices.map((x) => x.kind)).toEqual(["workspace-upgrade"]);
    }
  });

  test("ignores invalid registry responses and preserves corrupt caches", async () => {
    const options = await fixture();
    expect(
      (
        await collectUpdateNotices({
          ...options,
          getLatestVersion: async () => "latest",
        })
      ).map((x) => x.kind),
    ).toEqual(["workspace-upgrade"]);
    await writeFile(options.cache, "broken");
    expect((await collectUpdateNotices(options)).map((x) => x.kind)).toEqual([
      "workspace-upgrade",
    ]);
    expect(await readFile(options.cache, "utf8")).toBe("broken");
  });

  test("does not overwrite damaged settings or follow a settings symlink", async () => {
    const options = await fixture();
    const file = projectUpdatePreferences(options.root);
    await writeFile(file, "broken");
    await expect(skipUpdateVersion(file, "2", "project")).rejects.toMatchObject(
      { code: "AIO-UPDATE-PREFERENCE" },
    );
    expect(await readFile(file, "utf8")).toBe("broken");
    await symlink(file, path.join(options.root, "link.json"));
    await expect(
      skipUpdateVersion(path.join(options.root, "link.json"), "2", "project"),
    ).rejects.toMatchObject({ code: "AIO-UPDATE-PREFERENCE" });
    expect((await collectUpdateNotices(options))[1]?.kind).toBe(
      "integration-check",
    );
  });

  test("rejects invalid versions without creating preferences", async () => {
    const options = await fixture();
    for (const value of ["0", "-1", "2.0", "latest", "9007199254740992"])
      await expect(
        skipUpdateVersion(options.userPreferences, value, "project"),
      ).rejects.toMatchObject({ code: "AIO-UPDATE-PREFERENCE" });
    await expect(
      skipUpdateVersion(options.userPreferences, "latest", "user"),
    ).rejects.toMatchObject({ code: "AIO-UPDATE-PREFERENCE" });
    await expect(readFile(options.userPreferences)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("preserves unrelated preference fields and previously skipped versions", async () => {
    const options = await fixture();
    const file = projectUpdatePreferences(options.root);
    await writeFile(
      file,
      JSON.stringify({ schema: 1, skippedVersions: ["1"], custom: "keep" }),
    );
    await skipUpdateVersion(file, "2", "project");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schema: 1,
      skippedVersions: ["1", "2"],
      custom: "keep",
    });
  });
});
