import type { ValidationIssue } from "@aiongside/core";

export interface AgentEvent {
  cwd: string;
  hook_event_name: "SessionStart" | "Stop";
  stop_hook_active?: boolean;
}

export function parseAgentHookEvent(
  source: string,
  expected: AgentEvent["hook_event_name"],
): AgentEvent {
  const event: unknown = JSON.parse(source);
  if (
    !event ||
    typeof event !== "object" ||
    !("cwd" in event) ||
    typeof event.cwd !== "string" ||
    !event.cwd.trim() ||
    !("hook_event_name" in event) ||
    event.hook_event_name !== expected ||
    ("stop_hook_active" in event && typeof event.stop_hook_active !== "boolean")
  ) {
    throw new Error(
      "Invalid hook input: expected cwd and matching hook_event_name.",
    );
  }
  return event as AgentEvent;
}

export function formatHookIssues(issues: ValidationIssue[]): string {
  return issues
    .flatMap((issue) => [
      `[${issue.code}] ${issue.path}: ${issue.message}`,
      ...(issue.hint ? [issue.hint] : []),
    ])
    .join("\n");
}

export function createSessionStartHookOutput(additionalContext: string) {
  return {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  };
}

export function createStopHookOutput(
  issues: ValidationIssue[],
  stopHookActive: boolean,
): Record<string, unknown> {
  if (!issues.length) return {};
  const details = formatHookIssues(issues);
  return stopHookActive
    ? {
        systemMessage: `AIongside check remains unresolved after one recovery turn. Report these issues:\n${details}`,
      }
    : { decision: "block", reason: `AIongside check failed:\n${details}` };
}

export interface CliResult {
  version: number;
  root: string;
  ok: boolean;
  issues: ValidationIssue[];
  instructions?: string | null;
}

export function parseCliResult(source: string, code: number): CliResult {
  const result = JSON.parse(source) as CliResult;
  if (
    result?.version !== 1 ||
    typeof result.root !== "string" ||
    typeof result.ok !== "boolean" ||
    !Array.isArray(result.issues) ||
    !result.issues.every(
      (issue) =>
        issue &&
        typeof issue.code === "string" &&
        typeof issue.path === "string" &&
        typeof issue.message === "string" &&
        (issue.hint === undefined || typeof issue.hint === "string"),
    ) ||
    ![0, 1].includes(code) ||
    result.ok !== (code === 0) ||
    result.ok !== (result.issues.length === 0)
  ) {
    throw new Error(`Invalid CLI result or execution failure (exit ${code}).`);
  }
  return result;
}
