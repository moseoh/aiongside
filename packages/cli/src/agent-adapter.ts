#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentEvent,
  createSessionStartHookOutput,
  createStopHookOutput,
  formatHookIssues,
  formatHookScope,
  parseAgentHookEvent,
  parseCliResult,
} from "./agent-protocol.js";
import {
  assertHookRoot,
  HookSessionError,
  resolveHookSession,
} from "./hook-session.js";
import { collectUpdateNotices, formatUpdateNotices } from "./update-notices.js";

async function execute(command: "context" | "check", cwd: string) {
  return new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./bin.js", import.meta.url)),
        "--root",
        path.resolve(cwd),
        command,
        "--json",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: command === "context" ? 7000 : 25000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 10 * 1024 * 1024) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`CLI terminated: ${signal}. ${stderr}`));
      else resolve({ stdout, code: code ?? 2 });
    });
  });
}

let event: AgentEvent | undefined;
let root: string | undefined;
try {
  const expected =
    process.argv[2] === "session-start"
      ? "SessionStart"
      : process.argv[2] === "stop"
        ? "Stop"
        : undefined;
  if (!expected)
    throw new Error("Usage: aiongside-agent-adapter <session-start|stop>");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  event = parseAgentHookEvent(Buffer.concat(chunks).toString("utf8"), expected);
  root = await resolveHookSession(event);
  const executed = await execute(
    expected === "SessionStart" ? "context" : "check",
    root,
  );
  await assertHookRoot(root);
  const result = parseCliResult(executed.stdout, executed.code);
  if (result.root !== root)
    throw new HookSessionError("CLI returned a different workspace root.");
  if (expected === "SessionStart") {
    const notices = await collectUpdateNotices({
      root: result.root,
      cliVersion: (
        createRequire(import.meta.url)("../package.json") as { version: string }
      ).version,
    });
    if (
      result.instructions !== null &&
      typeof result.instructions !== "string"
    ) {
      throw new Error("Invalid context fields.");
    }
    process.stdout.write(
      `${JSON.stringify(
        createSessionStartHookOutput(
          [
            "# AIongside managed instructions",
            formatHookScope(root),
            result.instructions ?? "",
            formatHookIssues(result.issues),
            formatUpdateNotices(notices),
          ].join("\n\n"),
        ),
      )}\n`,
    );
  } else {
    process.stdout.write(
      `${JSON.stringify(createStopHookOutput(result.issues, event.stop_hook_active === true, root))}\n`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (event) {
    const issues = [
      {
        code:
          error instanceof HookSessionError
            ? "AIO-ADAPTER-SESSION"
            : "AIO-ADAPTER-EXECUTION",
        path: root ?? "session",
        message: `AIongside CLI execution failed: ${message}`,
        hint:
          root && !(error instanceof HookSessionError)
            ? "Run aiongside check --json and aiongside doctor --json to inspect the failure."
            : "Start a new agent session in the intended AIongside workspace. Do not repair documents based on this failed Hook.",
      },
    ];
    const output =
      event.hook_event_name === "Stop"
        ? createStopHookOutput(
            issues,
            event.stop_hook_active === true,
            error instanceof HookSessionError ? undefined : root,
          )
        : createSessionStartHookOutput(
            [
              root && !(error instanceof HookSessionError)
                ? formatHookScope(root)
                : "",
              formatHookIssues(issues),
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    process.stderr.write(`AIO-ADAPTER-INPUT: ${message}\n`);
    process.exitCode = 2;
  }
}
