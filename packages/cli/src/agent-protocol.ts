import type { ValidationIssue } from "@aiongside/core";

export interface AgentEvent {
  session_id: string;
  cwd: string;
  source?: "startup" | "resume" | "clear" | "compact";
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
    !("session_id" in event) ||
    typeof event.session_id !== "string" ||
    !event.session_id.trim() ||
    event.session_id.length > 1024 ||
    !("cwd" in event) ||
    typeof event.cwd !== "string" ||
    !event.cwd.trim() ||
    (expected === "SessionStart" &&
      (!("source" in event) ||
        typeof event.source !== "string" ||
        !["startup", "resume", "clear", "compact"].includes(event.source))) ||
    !("hook_event_name" in event) ||
    event.hook_event_name !== expected ||
    ("stop_hook_active" in event && typeof event.stop_hook_active !== "boolean")
  ) {
    throw new Error(
      "Invalid hook input: expected session_id, cwd, matching hook_event_name and a valid SessionStart source.",
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

export function formatHookScope(root: string): string {
  const quoted = `'${root.replaceAll("'", "'\\''")}'`;
  return `AIongside session workspace: ${JSON.stringify(root)}\nResolve all document paths below against this workspace, regardless of the current shell directory. For every AIongside command below, use the prefix aiongside --root ${quoted} instead of bare aiongside. Example: aiongside --root ${quoted} check --json. Do not repair another workspace in response to this Hook.`;
}

export function createStopHookOutput(
  issues: ValidationIssue[],
  stopHookActive: boolean,
  root?: string,
): Record<string, unknown> {
  if (!issues.length) return {};
  const details = [root ? formatHookScope(root) : "", formatHookIssues(issues)]
    .filter(Boolean)
    .join("\n\n");
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
