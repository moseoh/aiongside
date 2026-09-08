import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { findWorkspaceRoot } from "@aiongside/filesystem";

export class HookRootError extends Error {}

export async function assertHookRoot(root: string): Promise<void> {
  try {
    if (
      (await realpath(root)) !== root ||
      !(await lstat(path.join(root, ".aiongside"))).isDirectory() ||
      !(await lstat(path.join(root, ".aiongside/config.yaml"))).isFile()
    )
      throw new Error("Invalid root.");
  } catch {
    throw new HookRootError("The selected workspace is no longer available.");
  }
}

export async function resolveHookRoot(start = process.cwd()): Promise<string> {
  try {
    if (!start.trim() || start.includes("\0"))
      throw new Error("--root must be a non-empty directory path.");
    const directory = await realpath(path.resolve(start));
    if (!(await lstat(directory)).isDirectory())
      throw new Error("--root must point to a directory.");
    const root = await realpath(await findWorkspaceRoot(directory));
    await assertHookRoot(root);
    return root;
  } catch (error) {
    if (error instanceof HookRootError) throw error;
    throw new HookRootError(
      `Cannot resolve the Hook workspace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
