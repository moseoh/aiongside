import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  AGENT_HOOK_PATHS,
  agentHookSettingsAreCurrent,
  mergeAgentHookSettings,
} from "../src/agent-integration.js";

test.each(AGENT_HOOK_PATHS)(
  "upgrades and deduplicates known hooks for %s while preserving user settings",
  (target) => {
    const current = JSON.parse(mergeAgentHookSettings(undefined, target));
    const source = JSON.stringify({
      permissions: { deny: ["Bash(aws ssm:*)"] },
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "aiongside-agent-adapter session-start",
              },
            ],
          },
          ...current.hooks.SessionStart,
        ],
        Stop: [
          { hooks: [{ type: "command", command: "team stop" }] },
          {
            hooks: [
              { type: "command", command: "aiongside-agent-adapter stop" },
            ],
          },
          ...current.hooks.Stop,
        ],
      },
    });
    expect(agentHookSettingsAreCurrent(source, target)).toBe(false);
    const merged = mergeAgentHookSettings(source, target);
    const value = JSON.parse(merged);
    expect(value.permissions).toEqual({ deny: ["Bash(aws ssm:*)"] });
    expect(value.hooks.SessionStart).toHaveLength(1);
    expect(value.hooks.Stop).toHaveLength(2);
    expect(value.hooks.Stop[0].hooks[0].command).toBe("team stop");
    const variable = target.startsWith(".claude")
      ? "$CLAUDE_PROJECT_DIR"
      : "$PWD";
    expect(value.hooks.Stop[1].hooks[0].command).toBe(
      `aiongside-agent-adapter stop --root "${variable}"`,
    );
    expect(agentHookSettingsAreCurrent(merged, target)).toBe(true);
    expect(mergeAgentHookSettings(merged, target)).toBe(merged);
  },
);

test("rejects custom managed arguments and mixed entries instead of overwriting or duplicating", () => {
  for (const hooks of [
    [
      {
        type: "command",
        command: 'aiongside-agent-adapter stop --root "/custom"',
      },
    ],
    [
      {
        type: "command",
        command: 'aiongside-agent-adapter stop --root "$PWD"',
      },
      { type: "command", command: "team stop" },
    ],
  ])
    expect(() =>
      mergeAgentHookSettings(JSON.stringify({ hooks: { Stop: [{ hooks }] } })),
    ).toThrow("incompatible");
});

test("shell expansion passes project paths as one argument for both products", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "aiongside-hook-shell-"));
  try {
    const root = path.join(fixture, "team's space $literal");
    const legacy = path.join(root, ".legacy");
    await mkdir(legacy, { recursive: true });
    const script = path.join(fixture, "aiongside-agent-adapter");
    await writeFile(script, '#!/bin/sh\nprintf "%s\\n" "$#" "$@"\n');
    await chmod(script, 0o700);
    for (const target of AGENT_HOOK_PATHS) {
      const settings = JSON.parse(mergeAgentHookSettings(undefined, target));
      for (const event of ["SessionStart", "Stop"]) {
        const command = settings.hooks[event][0].hooks[0].command;
        const result = await promisify(execFile)("/bin/sh", ["-c", command], {
          cwd: target.startsWith(".claude") ? legacy : root,
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env.PATH}`,
            CLAUDE_PROJECT_DIR: root,
          },
        });
        expect(result.stdout).toBe(
          `3\n${event === "Stop" ? "stop" : "session-start"}\n--root\n${root}\n`,
        );
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
