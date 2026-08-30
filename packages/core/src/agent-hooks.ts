import { z } from "zod";
import type { ValidationIssue } from "./model.js";

export const AGENT_HOOK_COMMANDS = {
  sessionStart: "aiongside hook session-start",
  stop: "aiongside hook stop",
} as const;

const agentHookEventSchema = z
  .object({
    cwd: z.string().trim().min(1),
    hook_event_name: z.enum(["SessionStart", "Stop"]),
    stop_hook_active: z.boolean().optional(),
  })
  .passthrough();

export type AgentHookEvent = z.infer<typeof agentHookEventSchema>;

export function parseAgentHookEvent(
  source: string,
  expected: AgentHookEvent["hook_event_name"],
): AgentHookEvent {
  const value: unknown = JSON.parse(source);
  const event = agentHookEventSchema.parse(value);
  if (event.hook_event_name !== expected) {
    throw new Error(
      `Expected ${expected} hook input, received ${event.hook_event_name}.`,
    );
  }
  return event;
}

export function createSessionStartHookOutput(additionalContext: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart" as const,
      additionalContext,
    },
  };
}

export function createStopHookOutput(
  issues: ValidationIssue[],
  stopHookActive: boolean,
): Record<string, unknown> {
  if (issues.length === 0) {
    return {};
  }
  const details = formatHookIssues(issues);
  if (stopHookActive) {
    return {
      systemMessage: `AIongside check still fails after one recovery turn. Report these issues to the user:\n${details}`,
    };
  }
  return {
    decision: "block",
    reason: `AIongside check failed. Fix these issues before finishing:\n${details}`,
  };
}

function formatHookIssues(issues: ValidationIssue[]): string {
  return issues
    .flatMap((issue) => [
      `[${issue.code}] ${issue.path}: ${issue.message}`,
      ...(issue.hint ? [`Fix: ${issue.hint}`] : []),
    ])
    .join("\n");
}
