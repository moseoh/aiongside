import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  INTEGRATION_PATH,
  INTEGRATION_VERSION,
  PROJECT_UPDATE_PREFERENCES_PATH,
  WorkspaceError,
} from "@aiongside/filesystem";
import {
  compareSemanticVersions,
  fetchLatestVersion,
  parseSemanticVersion,
} from "./update.js";

const CACHE_AGE_MS = 60 * 60 * 1000;
const NOTICE_TIMEOUT_MS = 2000;

export function userUpdatePaths() {
  return {
    preferences: path.join(
      process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
      "aiongside",
      "update-preferences.json",
    ),
    cache: path.join(
      process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
      "aiongside",
      "update-check.json",
    ),
  };
}

export function projectUpdatePreferences(root: string): string {
  return path.join(root, PROJECT_UPDATE_PREFERENCES_PATH);
}

function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function safePath(file: string): Promise<void> {
  let current = path.resolve(file);
  let leaf = true;
  while (true) {
    try {
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (leaf ? !info.isFile() : !info.isDirectory())
      ) {
        throw new Error(`Unsafe update settings path: ${current}`);
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    leaf = false;
  }
}

async function readJson(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  await safePath(file);
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid settings: ${file}`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await safePath(file);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.close();
    await rename(temporary, file);
  } finally {
    await handle.close();
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

function validateVersion(version: string, scope: "user" | "project") {
  if (scope === "user") parseSemanticVersion(version);
  else if (
    !/^[1-9]\d*$/.test(version) ||
    !Number.isSafeInteger(Number(version))
  )
    throw new Error("Invalid integration version");
}

async function preferences(file: string, scope: "user" | "project") {
  const data = await readJson(file);
  if (!data) return { schema: 1, skippedVersions: [] as string[] };
  if (
    data.schema !== 1 ||
    !Array.isArray(data.skippedVersions) ||
    !data.skippedVersions.every((v) => typeof v === "string")
  )
    throw new Error(`Invalid preferences: ${file}`);
  const versions = data.skippedVersions as string[];
  for (const version of versions) validateVersion(version, scope);
  return { ...data, schema: 1, skippedVersions: versions };
}

export async function skipUpdateVersion(
  file: string,
  version: string,
  scope: "user" | "project",
) {
  try {
    validateVersion(version, scope);
    await safePath(file);
    await mkdir(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const handle = await open(lock, "wx", 0o600);
    try {
      const data = await preferences(file, scope);
      const changed = !data.skippedVersions.includes(version);
      if (changed)
        await writeJson(file, {
          ...data,
          skippedVersions: [...data.skippedVersions, version],
        });
      return { scope, version, path: file, changed };
    } finally {
      await handle.close();
      await unlink(lock);
    }
  } catch (error) {
    throw new WorkspaceError(
      `Cannot save update preference at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      "AIO-UPDATE-PREFERENCE",
    );
  }
}

export interface UpdateNotice {
  kind: "cli-update" | "workspace-upgrade" | "integration-check";
  currentVersion: string | null;
  targetVersion: string | null;
  message: string;
  command: string;
  skipCommand?: string;
}

export interface NoticeOptions {
  root: string;
  cliVersion: string;
  integrationVersion?: number;
  userPreferences?: string;
  cache?: string;
  now?: number;
  timeoutMs?: number;
  getLatestVersion?: () => Promise<string>;
}

async function latestVersion(options: NoticeOptions): Promise<string> {
  const now = options.now ?? Date.now();
  const file = options.cache ?? userUpdatePaths().cache;
  const cached = await readJson(file);
  if (cached) {
    if (
      cached.schema !== 1 ||
      typeof cached.version !== "string" ||
      typeof cached.checkedAt !== "number" ||
      !Number.isFinite(cached.checkedAt)
    )
      throw new Error("Invalid update cache");
    parseSemanticVersion(cached.version);
    if (now >= cached.checkedAt && now - cached.checkedAt < CACHE_AGE_MS)
      return cached.version;
  }
  const timeout = options.timeoutMs ?? NOTICE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const version = await Promise.race([
      options.getLatestVersion
        ? options.getLatestVersion()
        : fetchLatestVersion(globalThis.fetch, timeout),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Update check timed out")),
          timeout,
        );
      }),
    ]);
    parseSemanticVersion(version);
    await writeJson(file, { schema: 1, version, checkedAt: now });
    return version;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectUpdateNotices(
  options: NoticeOptions,
): Promise<UpdateNotice[]> {
  const rootArg = `--root '${options.root.replaceAll("'", "'\\''")}'`;
  const workspace = (async (): Promise<UpdateNotice[]> => {
    try {
      const installed = options.integrationVersion ?? INTEGRATION_VERSION;
      const metadata = await readJson(
        path.join(options.root, INTEGRATION_PATH),
      );
      if (
        metadata?.schema !== 1 ||
        typeof metadata.version !== "number" ||
        !Number.isSafeInteger(metadata.version) ||
        metadata.version < 1
      )
        throw new Error("Invalid integration metadata");
      if (metadata.version === installed) return [];
      if (metadata.version > installed)
        return [
          {
            kind: "integration-check",
            currentVersion: String(metadata.version),
            targetVersion: String(installed),
            message:
              "Workspace integration is newer than this CLI. Check the CLI version; do not downgrade the workspace.",
            command: "aiongside update",
          },
        ];
      const data = await preferences(
        projectUpdatePreferences(options.root),
        "project",
      );
      if (data.skippedVersions.includes(String(installed))) return [];
      return [
        {
          kind: "workspace-upgrade",
          currentVersion: String(metadata.version),
          targetVersion: String(installed),
          message: "Workspace integration upgrade is available.",
          command: `aiongside ${rootArg} workspace upgrade`,
          skipCommand: `aiongside ${rootArg} workspace upgrade --skip-version ${installed}`,
        },
      ];
    } catch {
      return [
        {
          kind: "integration-check",
          currentVersion: null,
          targetVersion: null,
          message: `Could not compare workspace integration or read its update preferences. Inspect with doctor, then run aiongside ${rootArg} workspace upgrade if appropriate; no files were repaired.`,
          command: `aiongside ${rootArg} doctor --json`,
        },
      ];
    }
  })();
  const cli = (async (): Promise<UpdateNotice[]> => {
    try {
      const data = await preferences(
        options.userPreferences ?? userUpdatePaths().preferences,
        "user",
      );
      const latest = await latestVersion(options);
      if (
        compareSemanticVersions(latest, options.cliVersion) <= 0 ||
        data.skippedVersions.includes(latest)
      )
        return [];
      return [
        {
          kind: "cli-update",
          currentVersion: options.cliVersion,
          targetVersion: latest,
          message: "A new AIongside CLI release is available.",
          command: "aiongside update",
          skipCommand: `aiongside update --skip-version ${latest}`,
        },
      ];
    } catch {
      return [];
    }
  })();
  const [cliNotices, workspaceNotices] = await Promise.all([cli, workspace]);
  return [...cliNotices, ...workspaceNotices];
}

export function formatUpdateNotices(notices: UpdateNotice[]): string {
  if (!notices.length) return "";
  return [
    "# AIongside update notices",
    ...notices.flatMap((notice) => [
      `${notice.message} (${notice.currentVersion ?? "unknown"} -> ${notice.targetVersion ?? "unknown"})`,
      `Update/check command: ${notice.command}`,
      ...(notice.skipCommand
        ? [
            `Only if the user explicitly declines further notices for this version, run: ${notice.skipCommand}`,
          ]
        : []),
    ]),
    "Tell the user; do not install or upgrade automatically. Silence or postponing this session is not a version refusal. Do not edit preference files directly.",
  ].join("\n");
}
