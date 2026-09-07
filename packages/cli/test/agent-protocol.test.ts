import { describe, expect, test } from "vitest";
import {
  createSessionStartHookOutput,
  createStopHookOutput,
  parseAgentHookEvent,
  parseCliResult,
} from "../src/agent-protocol.js";

// Protocol fixtures: https://learn.chatgpt.com/docs/hooks and https://code.claude.com/docs/en/hooks
describe("official agent protocol fixtures", () => {
  for (const product of ["Claude Code", "Codex"]) {
    test(`${product}: accepts documented fields without domain decisions`, () => {
      const fixture = {
        session_id: "session",
        cwd: "/workspace with spaces",
        transcript_path: "/transcript",
        hook_event_name: "Stop",
        stop_hook_active: false,
        ...(product === "Codex"
          ? { turn_id: "turn" }
          : { permission_mode: "default" }),
      };
      expect(parseAgentHookEvent(JSON.stringify(fixture), "Stop").cwd).toBe(
        fixture.cwd,
      );
      expect(createStopHookOutput([], false)).toEqual({});
      expect(createSessionStartHookOutput("instructions")).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "instructions",
        },
      });
    });
  }
  test("preserves complete reasons and recovery actions on first failure and retry", () => {
    const issue = {
      code: "AIO-OVERVIEW-STALE",
      path: "work/WORK-1/overview.md",
      message: "Stored recordBodyDigest differs from work/WORK-1/record.md.",
      hint: "Compare the Record and Overview. Update if needed, then run aiongside work sync WORK-1.",
    };
    const first = createStopHookOutput([issue], false);
    const retry = createStopHookOutput([issue], true);
    expect(first.decision).toBe("block");
    expect(retry.decision).toBeUndefined();
    for (const value of Object.values(issue)) {
      expect(first.reason).toContain(value);
      expect(retry.systemMessage).toContain(value);
    }
  });
  test("rejects malformed input and mismatched event types", () => {
    for (const source of [
      "{",
      "{}",
      '{"cwd":"x","hook_event_name":"Stop","stop_hook_active":"false"}',
    ]) {
      expect(() => parseAgentHookEvent(source, "Stop")).toThrow();
    }
    expect(() =>
      parseAgentHookEvent(
        '{"cwd":"x","hook_event_name":"Stop"}',
        "SessionStart",
      ),
    ).toThrow();
  });
  test("rejects execution failures, broken JSON, malformed issues and exit-code contradictions", () => {
    const success = { version: 1, root: "/workspace", ok: true, issues: [] };
    expect(parseCliResult(JSON.stringify(success), 0)).toEqual(success);
    for (const [value, code] of [
      [success, 1],
      [success, 2],
      [success, 3],
      [{ ...success, ok: false }, 1],
      [{ ...success, version: 2 }, 0],
      [{ ...success, ok: false, issues: [{}] }, 1],
    ]) {
      expect(() =>
        parseCliResult(JSON.stringify(value), code as number),
      ).toThrow();
    }
    expect(() => parseCliResult("not JSON", 0)).toThrow();
    const failed = {
      ...success,
      ok: false,
      issues: [
        {
          code: "AIO-VIEW-DRIFT",
          path: "views/open.md",
          message: "View differs.",
        },
      ],
    };
    expect(parseCliResult(JSON.stringify(failed), 1)).toEqual(failed);
  });
});
