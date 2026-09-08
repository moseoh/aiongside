import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findWorkspaceRoot } from "@aiongside/filesystem";
import type { AgentEvent } from "./agent-protocol.js";

export class HookSessionError extends Error {
  constructor(message: string) {
    super(
      `${message} Start a new agent session in the intended AIongside workspace. No other workspace was selected.`,
    );
  }
}

export function hookSessionPath(sessionId: string): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.resolve(
    cache,
    "aiongside",
    "hook-sessions",
    `${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
}

async function readBinding(
  file: string,
  sessionId: string,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    if (!(await lstat(path.dirname(file))).isDirectory())
      throw new Error("Unsafe session binding directory.");
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384)
      throw new Error("Unsafe session binding file.");
    const value = JSON.parse(await handle.readFile("utf8"));
    if (
      value?.schema !== 1 ||
      value.sessionId !== sessionId ||
      typeof value.root !== "string" ||
      !path.isAbsolute(value.root) ||
      value.root.includes("\0")
    )
      throw new Error("Invalid session binding.");
    return value.root;
  } finally {
    await handle.close();
  }
}

export async function assertHookRoot(root: string): Promise<void> {
  try {
    if (
      (await realpath(root)) !== root ||
      !(await lstat(path.join(root, ".aiongside"))).isDirectory() ||
      !(await lstat(path.join(root, ".aiongside/config.yaml"))).isFile()
    )
      throw new Error("Invalid root.");
  } catch {
    throw new HookSessionError("The bound workspace is no longer available.");
  }
}

export async function resolveHookSession(event: AgentEvent): Promise<string> {
  try {
    const file = hookSessionPath(event.session_id);
    let root = await readBinding(file, event.session_id);
    if (root === undefined) {
      if (
        event.hook_event_name !== "SessionStart" ||
        !["startup", "clear"].includes(event.source ?? "")
      )
        throw new Error("No workspace binding exists for this session.");
      const candidate = await realpath(await findWorkspaceRoot(event.cwd));
      await assertHookRoot(candidate);
      const directory = path.dirname(file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory())
        throw new Error("Unsafe session binding directory.");
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(file, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (handle) {
        try {
          await handle.writeFile(
            JSON.stringify({
              schema: 1,
              sessionId: event.session_id,
              root: candidate,
            }),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      root = await readBinding(file, event.session_id);
      if (root === undefined)
        throw new Error("Session binding could not be saved.");
    }
    await assertHookRoot(root);
    return root;
  } catch (error) {
    if (error instanceof HookSessionError) throw error;
    throw new HookSessionError(
      `Cannot establish the session workspace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
