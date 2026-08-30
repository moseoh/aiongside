import { spawn } from "node:child_process";
import { WorkspaceError } from "@aiongside/filesystem";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const REGISTRY_URL = "https://registry.npmjs.org/aiongside/latest";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export interface UpdateOptions {
  root: string;
  currentVersion: string;
  yes?: boolean;
}

export interface UpdateRuntime {
  getLatestVersion: () => Promise<string>;
  interactive: boolean;
  confirm: () => Promise<boolean>;
  runProcess: (command: string, args: string[]) => Promise<number>;
  syncCurrent: (root: string) => Promise<void>;
  report: (event: UpdateEvent) => void;
}

export type UpdateEvent =
  | { type: "current"; version: string }
  | {
      type: "available";
      currentVersion: string;
      latestVersion: string;
      command: string;
    }
  | { type: "cancelled" }
  | { type: "installed"; version: string }
  | { type: "complete" };

export function parseSemanticVersion(version: string): ParsedVersion {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new WorkspaceError(
      `Invalid semantic version: ${version}`,
      "AIO-UPDATE-CHECK",
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareSemanticVersions(left: string, right: string): number {
  const first = parseSemanticVersion(left);
  const second = parseSemanticVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (first[key] !== second[key]) {
      return first[key] > second[key] ? 1 : -1;
    }
  }
  if (first.prerelease.length === 0 || second.prerelease.length === 0) {
    if (first.prerelease.length === second.prerelease.length) {
      return 0;
    }
    return first.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(first.prerelease.length, second.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = first.prerelease[index];
    const rightPart = second.prerelease[index];
    if (leftPart === rightPart) {
      continue;
    }
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart.localeCompare(rightPart) > 0 ? 1 : -1;
  }
  return 0;
}

export async function fetchLatestVersion(
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string> {
  try {
    const response = await fetcher(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as { version?: unknown };
    if (typeof data.version !== "string") {
      throw new Error("npm registry response has no version string");
    }
    parseSemanticVersion(data.version);
    return data.version;
  } catch (error) {
    throw new WorkspaceError(
      `Cannot check the latest npm version: ${errorMessage(error)}. Run \`aiongside skill sync\` for an offline skill repair.`,
      "AIO-UPDATE-CHECK",
    );
  }
}

export async function performUpdate(
  options: UpdateOptions,
  runtime: UpdateRuntime,
): Promise<void> {
  parseSemanticVersion(options.currentVersion);
  let latestVersion: string;
  try {
    latestVersion = await runtime.getLatestVersion();
    parseSemanticVersion(latestVersion);
  } catch (error) {
    throw new WorkspaceError(
      `Cannot check the latest npm version: ${errorMessage(error)}. Run \`aiongside skill sync\` for an offline skill repair.`,
      "AIO-UPDATE-CHECK",
    );
  }

  if (compareSemanticVersions(latestVersion, options.currentVersion) <= 0) {
    runtime.report({ type: "current", version: options.currentVersion });
    await runtime.syncCurrent(options.root);
    return;
  }

  const packageTarget = `aiongside@${latestVersion}`;
  runtime.report({
    type: "available",
    currentVersion: options.currentVersion,
    latestVersion,
    command: `npm install --global ${packageTarget}`,
  });
  let approved = options.yes === true;
  if (!approved) {
    if (!runtime.interactive) {
      throw new WorkspaceError(
        "Update approval is required in a non-interactive terminal. Review the preview and run `aiongside update --yes`.",
        "AIO-UPDATE-APPROVAL",
      );
    }
    approved = await runtime.confirm();
  }
  if (!approved) {
    runtime.report({ type: "cancelled" });
    return;
  }

  let installStatus: number;
  try {
    installStatus = await runtime.runProcess("npm", [
      "install",
      "--global",
      packageTarget,
    ]);
  } catch (error) {
    throw new WorkspaceError(
      `Global npm installation failed: ${errorMessage(error)}`,
      "AIO-UPDATE-INSTALL",
    );
  }
  if (installStatus !== 0) {
    throw new WorkspaceError(
      `Global npm installation failed with exit status ${installStatus}.`,
      "AIO-UPDATE-INSTALL",
    );
  }

  runtime.report({ type: "installed", version: latestVersion });
  let syncStatus: number;
  try {
    syncStatus = await runtime.runProcess("aiongside", [
      "--root",
      options.root,
      "skill",
      "sync",
    ]);
  } catch (error) {
    throw updateSyncError(options.root, errorMessage(error));
  }
  if (syncStatus !== 0) {
    throw updateSyncError(options.root, `exit status ${syncStatus}`);
  }
  runtime.report({ type: "complete" });
}

export function defaultRunProcess(
  command: string,
  args: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function updateSyncError(root: string, detail: string): WorkspaceError {
  return new WorkspaceError(
    `AIongside was updated globally, but workspace skill sync failed (${detail}). Run \`aiongside skill sync --root ${root}\` manually.`,
    "AIO-UPDATE-SYNC",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
