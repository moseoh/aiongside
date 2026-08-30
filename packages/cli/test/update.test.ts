import { describe, expect, test, vi } from "vitest";
import {
  compareSemanticVersions,
  fetchLatestVersion,
  performUpdate,
  type UpdateEvent,
  type UpdateRuntime,
} from "../src/update.js";

function runtime(
  overrides: Partial<UpdateRuntime> = {},
): UpdateRuntime & { events: UpdateEvent[] } {
  const events: UpdateEvent[] = [];
  return {
    events,
    getLatestVersion: async () => "0.2.0",
    interactive: true,
    confirm: async () => true,
    runProcess: async () => 0,
    syncCurrent: async () => undefined,
    report: (event) => events.push(event),
    ...overrides,
  };
}

describe("CLI update", () => {
  test("validates and compares release and prerelease versions", () => {
    expect(compareSemanticVersions("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemanticVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemanticVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareSemanticVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(() => compareSemanticVersions("latest", "1.0.0")).toThrow(
      "Invalid semantic version",
    );
  });

  test("validates npm latest responses and network failures", async () => {
    const valid = await fetchLatestVersion(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 }),
      ) as typeof fetch,
    );
    expect(valid).toBe("0.2.0");

    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response(JSON.stringify({ version: "latest" }), { status: 200 }),
      new Response(JSON.stringify({}), { status: 200 }),
    ]) {
      await expect(
        fetchLatestVersion(vi.fn(async () => response) as typeof fetch),
      ).rejects.toMatchObject({
        code: "AIO-UPDATE-CHECK",
        message: expect.stringContaining("aiongside skill sync"),
      });
    }
    await expect(
      fetchLatestVersion(
        vi.fn(async () => {
          throw new Error("offline");
        }) as typeof fetch,
      ),
    ).rejects.toMatchObject({
      code: "AIO-UPDATE-CHECK",
      message: expect.stringContaining("aiongside skill sync"),
    });
  });

  test("syncs locally without installation when the CLI is current or newer", async () => {
    for (const latest of ["0.1.0", "0.0.9"]) {
      const syncCurrent = vi.fn(async () => undefined);
      const runProcess = vi.fn(async () => 0);
      const testRuntime = runtime({
        getLatestVersion: async () => latest,
        syncCurrent,
        runProcess,
      });

      await performUpdate(
        { root: "/workspace", currentVersion: "0.1.0" },
        testRuntime,
      );
      expect(syncCurrent).toHaveBeenCalledWith("/workspace");
      expect(runProcess).not.toHaveBeenCalled();
      expect(testRuntime.events).toEqual([
        { type: "current", version: "0.1.0" },
      ]);
    }
  });

  test("previews and preserves state when an interactive update is declined", async () => {
    const confirm = vi.fn(async () => false);
    const runProcess = vi.fn(async () => 0);
    const syncCurrent = vi.fn(async () => undefined);
    const testRuntime = runtime({ confirm, runProcess, syncCurrent });

    await performUpdate(
      { root: "/workspace", currentVersion: "0.1.0" },
      testRuntime,
    );
    expect(testRuntime.events).toEqual([
      {
        type: "available",
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        command: "npm install --global aiongside@0.2.0",
      },
      { type: "cancelled" },
    ]);
    expect(runProcess).not.toHaveBeenCalled();
    expect(syncCurrent).not.toHaveBeenCalled();
  });

  test("requires explicit approval in a non-interactive terminal", async () => {
    const runProcess = vi.fn(async () => 0);
    const testRuntime = runtime({ interactive: false, runProcess });

    await expect(
      performUpdate(
        { root: "/workspace", currentVersion: "0.1.0" },
        testRuntime,
      ),
    ).rejects.toMatchObject({ code: "AIO-UPDATE-APPROVAL" });
    expect(runProcess).not.toHaveBeenCalled();
  });

  test("installs the exact approved version and re-resolves the CLI from PATH", async () => {
    const confirm = vi.fn(async () => true);
    const runProcess = vi.fn(async () => 0);
    const testRuntime = runtime({ confirm, runProcess });

    await performUpdate(
      { root: "/workspace", currentVersion: "0.1.0" },
      testRuntime,
    );
    expect(runProcess.mock.calls).toEqual([
      ["npm", ["install", "--global", "aiongside@0.2.0"]],
      ["aiongside", ["--root", "/workspace", "skill", "sync"]],
    ]);
    expect(testRuntime.events).toEqual([
      {
        type: "available",
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        command: "npm install --global aiongside@0.2.0",
      },
      { type: "installed", version: "0.2.0" },
      { type: "complete" },
    ]);
  });

  test("accepts --yes without prompting", async () => {
    const confirm = vi.fn(async () => false);
    const runProcess = vi.fn(async () => 0);
    await performUpdate(
      { root: "/workspace", currentVersion: "0.1.0", yes: true },
      runtime({ interactive: false, confirm, runProcess }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(runProcess).toHaveBeenCalledTimes(2);
  });

  test("distinguishes install failure from post-install sync failure", async () => {
    await expect(
      performUpdate(
        { root: "/workspace", currentVersion: "0.1.0", yes: true },
        runtime({ runProcess: async () => 17 }),
      ),
    ).rejects.toMatchObject({
      code: "AIO-UPDATE-INSTALL",
      message: expect.stringContaining("17"),
    });

    let call = 0;
    await expect(
      performUpdate(
        { root: "/workspace", currentVersion: "0.1.0", yes: true },
        runtime({
          runProcess: async () => {
            call += 1;
            return call === 1 ? 0 : 9;
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "AIO-UPDATE-SYNC",
      message: expect.stringContaining(
        "aiongside skill sync --root /workspace",
      ),
    });
  });
});
