import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  calculateMarkdownBodyDigest,
  compareWorkIds,
  createKnowledgeDocument,
  createOverviewDocument,
  createPlanDocument,
  createRecordDocument,
  evaluateTransition,
  formatMarkdownDocument,
  isMovableStatus,
  type KnowledgeCreateInput,
  type KnowledgeEntry,
  KnowledgeMutationError,
  knowledgeEntriesByKey,
  normalizeKnowledgeKey,
  normalizeKnowledgePath,
  overviewMetadataSchema,
  parseMarkdownDocument,
  renderViews,
  replaceMarkdownMetadata,
  TEMPLATE_DEFINITIONS,
  TEMPLATE_NAMES,
  type TemplateName,
  type TransitionInputValues,
  type TransitionRequiredInput,
  type TransitionResult,
  type ValidationIssue,
  type WorkMetadata,
  type WorkStatus,
  type WorkspaceConfig,
  workMetadataSchema,
  workspaceConfigSchema,
} from "@aiongside/core";
import * as lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AGENT_HOOK_PATHS,
  AGENT_INSTRUCTIONS_PATH,
  agentHookSettingsAreCurrent,
  mergeAgentHookSettings,
} from "./agent-integration.js";
import { WorkspaceError } from "./errors.js";
import { ManagedFiles } from "./gitignore.js";
import {
  INDEX_SOURCE,
  ROUTING_CODES,
  safePathKind,
  scanKnowledge,
  validateDocumentLinks,
  workMarkdownDocuments,
} from "./knowledge-files.js";

const CONFIG_PATH = path.join(".aiongside", "config.yaml");
const WORK_DIR = "work";
const OVERVIEW_NAME = "overview.md";
const RECORD_NAME = "record.md";
const TEMPLATE_DIR = path.join(".aiongside", "templates");
export const WORKSPACE_INTERNAL_DIR = ".aiongside/internal";
export const INTEGRATION_PATH = `${WORKSPACE_INTERNAL_DIR}/integration.json`;
export const PROJECT_UPDATE_PREFERENCES_PATH = `${WORKSPACE_INTERNAL_DIR}/update-preferences.json`;
const STAGING_DIR = `${WORKSPACE_INTERNAL_DIR}/staging`;
const TRASH_DIR = `${WORKSPACE_INTERNAL_DIR}/trash`;
export const INTEGRATION_VERSION = 6;
const VIEW_PATHS = ["views/open.md", "views/closed.md"] as const;
const SUPPORTING_CONTENT_DIRECTORIES = [
  { name: "references", code: "AIO-STRUCTURE-REFERENCES" },
  { name: "deliverables", code: "AIO-STRUCTURE-DELIVERABLES" },
  { name: "evidence", code: "AIO-STRUCTURE-EVIDENCE" },
] as const;
const DEPENDENCY_RELATION_CODES = new Set([
  "AIO-DEPENDENCY-MISSING",
  "AIO-DEPENDENCY-SELF",
  "AIO-DEPENDENCY-DUPLICATE",
  "AIO-DEPENDENCY-CYCLE",
]);

export interface LoadedWork {
  directory: string;
  metadata: WorkMetadata;
  source: string;
}

export interface DiscardPreview {
  id: string;
  files: string[];
  referencedBy: string[];
  trashTarget: string;
}

export interface MoveWorkOptions extends TransitionInputValues {}

export interface MoveWorkResult extends TransitionResult {
  metadata: WorkMetadata;
  postActions?: {
    kind: "knowledge-update";
    workId: string;
    message: string;
    targets: { key: string; path: string }[];
  }[];
}

export interface DependencyMutationResult {
  id: string;
  dependencyId: string;
  action: "add" | "remove";
  changed: boolean;
  needs: string[];
  metadata: WorkMetadata;
}

export interface KnowledgeMutationResult {
  id: string;
  key: string;
  path?: string;
  action: "add" | "remove";
  changed: boolean;
  knowledge: string[];
  metadata: WorkMetadata;
}

export interface KnowledgeInfo extends KnowledgeEntry {
  document: string;
  index: string;
}

export interface KnowledgeTreeNode {
  type: "directory" | "document";
  path: string;
  key?: string;
  displayName: string;
  children: KnowledgeTreeNode[];
}

export interface CreateKnowledgeResult extends KnowledgeInfo {
  changes: string[];
  indexPaths: string[];
}

export interface MoveKnowledgeResult {
  key: string;
  sourcePath: string;
  destinationPath: string;
  indexPaths: string[];
  warnings: string[];
  applied: boolean;
}

export interface DiscardKnowledgePreview {
  key: string;
  path: string;
  referencedBy: string[];
  trashTarget: string;
  indexPaths: string[];
}

export interface DiscardKnowledgeResult extends DiscardKnowledgePreview {
  applied: true;
}

export interface SyncOverviewResult {
  id: string;
  changed: boolean;
  path: string;
}

export interface IntegrationChange {
  path: string;
  action: "created" | "updated";
}

export interface IntegrationSyncResult {
  version: number;
  changes: IntegrationChange[];
}

interface ManagedFilePlan {
  relativePath: string;
  target: string;
  previous: string | undefined;
  next: string;
  write: boolean;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function findWorkspaceRoot(
  start = process.cwd(),
): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await pathExists(path.join(current, CONFIG_PATH))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new WorkspaceError(
        "Cannot find an AIongside workspace. Run `aiongside init` first.",
        "AIO-WORKSPACE-NOT-FOUND",
      );
    }
    current = parent;
  }
}

export async function initializeWorkspace(
  target: string,
  options: { name?: string; idPrefix?: string } = {},
): Promise<WorkspaceConfig> {
  const root = path.resolve(target);
  const configPath = path.join(root, CONFIG_PATH);
  if (await pathExists(configPath)) {
    throw new WorkspaceError(
      `AIongside workspace already exists: ${root}`,
      "AIO-WORKSPACE-EXISTS",
    );
  }

  const agentInstructionsSource = await loadAgentInstructionsSource();
  const versionPlan = await planIntegrationVersion(root);
  const instructionsPlan = await planAgentInstructionsTarget(
    root,
    agentInstructionsSource,
    false,
  );
  const hookPlan = await planAgentHookTargets(root);
  const integrationPlan = [versionPlan, instructionsPlan, ...hookPlan];

  const config = workspaceConfigSchema.parse({
    schema: 1,
    name: options.name?.trim() || path.basename(root),
    idPrefix: options.idPrefix?.trim().toUpperCase() || "WORK",
  });

  await mkdir(path.join(root, TRASH_DIR), { recursive: true });
  await mkdir(path.join(root, TEMPLATE_DIR), { recursive: true });
  await mkdir(path.join(root, WORK_DIR), { recursive: true });
  await mkdir(path.join(root, "views"), { recursive: true });
  await mkdir(path.join(root, "knowledge"), { recursive: true });
  for (const name of TEMPLATE_NAMES) {
    const definition = TEMPLATE_DEFINITIONS[name];
    await writeIfMissing(
      path.join(root, TEMPLATE_DIR, definition.file),
      definition.contents,
    );
  }
  if (await new ManagedFiles(root).includes("knowledge/index.md"))
    await atomicWrite(path.join(root, "knowledge", "index.md"), INDEX_SOURCE);
  await writeViews(root, []);
  await applyAgentIntegrationState(
    root,
    integrationPlan,
    undefined,
    stringifyYaml(config, { lineWidth: 0 }),
    true,
  );
  return config;
}

export async function loadConfig(root: string): Promise<WorkspaceConfig> {
  const configPath = path.join(root, CONFIG_PATH);
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new WorkspaceError(
      `Cannot read configuration: ${relative(root, configPath)} (${errorMessage(error)})`,
      "AIO-CONFIG-READ",
    );
  }

  let rawConfig: unknown;
  try {
    rawConfig = parseYaml(source);
  } catch (error) {
    throw new WorkspaceError(
      `Invalid configuration YAML: ${errorMessage(error)}`,
      "AIO-CONFIG-YAML",
    );
  }
  const result = workspaceConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    throw new WorkspaceError(
      `Invalid configuration: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
      "AIO-CONFIG-SCHEMA",
    );
  }
  return result.data;
}

export async function loadAgentInstructionsSource(): Promise<string> {
  const candidates = [
    new URL("../instructions/aiongside.md", import.meta.url),
    new URL("../../../instructions/aiongside.md", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new WorkspaceError(
    "Cannot read the managed instructions included with this CLI.",
    "AIO-INSTRUCTIONS-FORMAT",
  );
}

export async function readWorkspaceContext(root: string) {
  const issues: ValidationIssue[] = [];
  const read = async (relativePath: string) => {
    try {
      return await readFile(path.join(root, relativePath), "utf8");
    } catch (error) {
      issues.push({
        code: "AIO-CONTEXT-READ",
        path: relativePath,
        message: errorMessage(error),
        hint: "Run `aiongside workspace upgrade`.",
      });
      return null;
    }
  };
  const instructions = await read(AGENT_INSTRUCTIONS_PATH);
  return {
    version: 1,
    root,
    ok: issues.length === 0,
    instructions,
    issues,
  };
}

async function planIntegrationVersion(root: string): Promise<ManagedFilePlan> {
  await assertSafeManagedParents(root, INTEGRATION_PATH, instructionsConflict);
  const target = path.join(root, INTEGRATION_PATH);
  let previous: string | undefined;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw instructionsConflict(root, target);
    previous = await readFile(target, "utf8");
    let metadata: { schema?: unknown; version?: unknown } | null;
    try {
      metadata = JSON.parse(previous);
    } catch {
      throw new WorkspaceError(
        `Invalid JSON in ${INTEGRATION_PATH}.`,
        "AIO-INTEGRATION-FORMAT",
      );
    }
    if (
      metadata?.schema !== 1 ||
      typeof metadata.version !== "number" ||
      !Number.isInteger(metadata.version) ||
      metadata.version < 1
    ) {
      throw new WorkspaceError(
        "Invalid integration metadata.",
        "AIO-INTEGRATION-FORMAT",
      );
    }
    if (metadata.version > INTEGRATION_VERSION) {
      throw new WorkspaceError(
        "Integration is newer than this CLI. Update the CLI before syncing.",
        "AIO-INTEGRATION-VERSION",
      );
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const next = `${JSON.stringify({ schema: 1, version: INTEGRATION_VERSION }, null, 2)}\n`;
  return {
    relativePath: INTEGRATION_PATH,
    target,
    previous,
    next,
    write: previous !== next,
  };
}

export async function syncAgentIntegration(
  root: string,
): Promise<IntegrationSyncResult> {
  return withWorkspaceLock(root, async () => {
    await loadConfig(root);
    const versionPlan = await planIntegrationVersion(root);
    const instructionsPlan = await planAgentInstructionsTarget(
      root,
      await loadAgentInstructionsSource(),
      versionPlan.previous !== undefined,
    );
    const plan = [
      versionPlan,
      instructionsPlan,
      ...(await planAgentHookTargets(root)),
    ];
    await applyAgentIntegrationState(root, plan, undefined, "", false);
    return {
      version: INTEGRATION_VERSION,
      changes: plan
        .filter((item) => item.write)
        .map((item) => ({
          path: item.relativePath,
          action:
            item.previous === undefined
              ? ("created" as const)
              : ("updated" as const),
        })),
    };
  });
}

export async function listWorks(
  root: string,
  files = new ManagedFiles(root),
): Promise<LoadedWork[]> {
  const workRoot = path.join(root, WORK_DIR);
  const entries = await files.entries(workRoot);
  const works: LoadedWork[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const recordPath = path.join(workRoot, entry.name, RECORD_NAME);
    if (!(await files.includes(recordPath))) continue;
    try {
      const source = await readFile(recordPath, "utf8");
      const document = parseMarkdownDocument(source);
      const result = workMetadataSchema.safeParse(document.metadata);
      if (result.success) {
        works.push({ directory: entry.name, metadata: result.data, source });
      }
    } catch {
      // Full validation reports these errors. Listing returns readable work items only.
    }
  }
  return works.sort((left, right) =>
    compareWorkIds(left.metadata.id, right.metadata.id),
  );
}

export async function createWork(
  root: string,
  title: string,
): Promise<WorkMetadata> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const config = await loadConfig(root);
    const works = await listWorks(root);
    const next = await nextWorkNumber(root, config.idPrefix);
    const id = `${config.idPrefix}-${next}`;
    const cleanTitle = title.trim();
    if (!cleanTitle || /[\r\n]/.test(cleanTitle)) {
      throw new WorkspaceError(
        "Work item title must be a non-empty single line.",
        "AIO-WORK-TITLE",
      );
    }
    const today = isoToday();
    const metadata = workMetadataSchema.parse({
      schema: 1,
      id,
      title: cleanTitle,
      status: "inbox",
      type: "delivery",
      created: today,
      updated: today,
      needs: [],
    });

    const staging = path.join(root, STAGING_DIR, `${id}-${randomUUID()}`);
    const destination = path.join(root, WORK_DIR, id);
    const files = new ManagedFiles(root);
    await files.assertIncluded(path.join(destination, RECORD_NAME));
    const includeOverview = await files.includes(
      path.join(destination, OVERVIEW_NAME),
    );
    const supportingDirectories = [];
    for (const { name } of SUPPORTING_CONTENT_DIRECTORIES)
      if (await files.includes(path.join(destination, name), true))
        supportingDirectories.push(name);
    const [recordTemplate, overviewTemplate] = await Promise.all([
      readWorkspaceTemplate(root, "record"),
      includeOverview
        ? readWorkspaceTemplate(root, "overview")
        : Promise.resolve(""),
    ]);
    const recordSource = createRecordDocument(metadata, recordTemplate);
    const recordBodyDigest = calculateMarkdownBodyDigest(recordSource);
    await assertSafeManagedParents(
      root,
      relative(root, staging),
      internalConflict,
    );
    await mkdir(staging, { recursive: true });
    let moved = false;
    try {
      await Promise.all([
        atomicWrite(path.join(staging, RECORD_NAME), recordSource),
        ...(includeOverview
          ? [
              atomicWrite(
                path.join(staging, OVERVIEW_NAME),
                createOverviewDocument(
                  metadata,
                  recordBodyDigest,
                  overviewTemplate,
                ),
              ),
            ]
          : []),
        ...supportingDirectories.map((name) =>
          mkdir(path.join(staging, name), { recursive: true }),
        ),
      ]);
      await rename(staging, destination);
      moved = true;
      await writeViews(root, [...works.map((work) => work.metadata), metadata]);
      return metadata;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (moved) {
        await rm(destination, { recursive: true, force: true });
        await writeViews(
          root,
          works.map((work) => work.metadata),
        );
      }
      throw error;
    }
  });
}

export async function moveWork(
  root: string,
  id: string,
  targetStatus: string,
  options: MoveWorkOptions = {},
): Promise<MoveWorkResult> {
  if (!isMovableStatus(targetStatus)) {
    throw new WorkspaceError(
      `Cannot move work item to status: ${targetStatus}. Allowed: inbox, active, waiting, done, cancelled.`,
      "AIO-WORK-STATUS",
    );
  }
  return withWorkspaceLock(root, async () => {
    const normalizedId = id.trim().toUpperCase();
    await assertMutationSafe(
      root,
      ["AIO-STATE-GATE", "AIO-DEPENDENCY-BLOCKED", "AIO-DONE-INVALIDATED"],
      (issue) =>
        targetStatus !== "done" &&
        DEPENDENCY_RELATION_CODES.has(issue.code) &&
        issueTouchesWork(issue, normalizedId),
    );
    const context = await loadMoveContext(root, id);
    const preview = await buildMoveResult(
      context.works,
      context.loaded,
      targetStatus,
      options,
    );
    if (preview.missingInputs.length > 0) {
      const missing = preview.missingInputs[0];
      if (!missing) {
        throw new WorkspaceError(
          "Transition requirements are incomplete.",
          "AIO-TRANSITION-INPUT",
        );
      }
      throw new WorkspaceError(
        `${missing.question}${missing.hint ? ` ${missing.hint}` : ""}`,
        missing.code,
      );
    }
    if (preview.from === preview.to) {
      return preview;
    }

    const timestamp = new Date().toISOString();
    const document = parseMarkdownDocument(context.loaded.source);
    const transition =
      preview.from === preview.to
        ? undefined
        : {
            at: timestamp,
            from: preview.from,
            to: preview.to,
            ...(options.reopenReason
              ? { reopenReason: options.reopenReason.trim() }
              : {}),
            ...(options.waitingReason
              ? { waitingReason: options.waitingReason.trim() }
              : {}),
            ...(options.resumeWhen
              ? { resumeWhen: options.resumeWhen.trim() }
              : {}),
            ...(options.waitingResolution
              ? { waitingResolution: options.waitingResolution.trim() }
              : {}),
            ...(options.cancellationReason
              ? { cancellationReason: options.cancellationReason.trim() }
              : {}),
            ...(preview.invalidatesCompletion
              ? { completionInvalidated: true }
              : {}),
          };
    let record = workMetadataSchema.parse({
      ...context.loaded.metadata,
      status: targetStatus,
      updated: isoToday(),
      transitions: transition
        ? [...context.loaded.metadata.transitions, transition]
        : context.loaded.metadata.transitions,
      completionSeal: preview.invalidatesCompletion
        ? null
        : context.loaded.metadata.completionSeal,
    });
    if (targetStatus === "done") {
      record = workMetadataSchema.parse({
        ...record,
        completionSeal: {
          completedAt: timestamp,
          digest: await calculateCompletionDigest(
            root,
            context.loaded.metadata.id,
            record,
            document.body,
          ),
        },
      });
    }

    const recordPath = path.join(
      root,
      WORK_DIR,
      context.loaded.metadata.id,
      RECORD_NAME,
    );
    const planPath = path.join(
      root,
      WORK_DIR,
      context.loaded.metadata.id,
      "plan.md",
    );
    const includePlan = await new ManagedFiles(root).includes(planPath);
    const previousPlan = includePlan
      ? await readOptionalFile(planPath)
      : undefined;
    try {
      await atomicWrite(
        recordPath,
        formatMarkdownDocument(record, document.body),
      );
      if (
        includePlan &&
        record.status === "active" &&
        previousPlan === undefined
      ) {
        const planTemplate = await readWorkspaceTemplate(root, "plan");
        await atomicWrite(
          planPath,
          createPlanDocument(planTemplate, record.title),
        );
      }
      await writeViews(
        root,
        context.works.map((work) =>
          work.metadata.id === record.id ? record : work.metadata,
        ),
      );
    } catch (error) {
      await atomicWrite(recordPath, context.loaded.source);
      if (includePlan && previousPlan === undefined) {
        await rm(planPath, { force: true });
      } else if (includePlan && previousPlan !== undefined) {
        await atomicWrite(planPath, previousPlan);
      }
      await writeViews(
        root,
        context.works.map((work) => work.metadata),
      );
      throw error;
    }

    return {
      ...preview,
      canMove: true,
      applied: true,
      metadata: record,
      ...(targetStatus === "done"
        ? {
            postActions: [
              {
                kind: "knowledge-update" as const,
                workId: record.id,
                message: `Work completed. Read work/${record.id}/record.md and its deliverables. Read knowledge/index.md and follow only relevant paths. Use aiongside knowledge list or show to resolve document keys when needed. Compare the Work results with existing Knowledge. If reusable results need to be added or corrected, update an existing document or create one with aiongside knowledge new <key>, then write the content without duplicating existing material. If files or folders were added, moved, or removed, update the affected index.md routing links and related document links. Keep knowledge content in individual documents, not indexes. After incorporating the Work results, record the contribution with aiongside work knowledge add ${record.id} <key> only if that relationship is absent. Do not add relationships for reference-only topics. If no update is needed, no further action is required; do not add relationships merely to mark the Work complete. The CLI does not edit Knowledge content or verify incorporation.`,
                targets: context.knowledgeEntries
                  .filter((entry) => record.knowledge.includes(entry.key))
                  .map((entry) => ({
                    key: entry.key,
                    path: entry.path,
                  })),
              },
            ],
          }
        : {}),
    };
  });
}

export async function previewMoveWork(
  root: string,
  id: string,
  targetStatus: string,
  options: MoveWorkOptions = {},
): Promise<MoveWorkResult> {
  if (!isMovableStatus(targetStatus)) {
    throw new WorkspaceError(
      `Cannot move work item to status: ${targetStatus}. Allowed: inbox, active, waiting, done, cancelled.`,
      "AIO-WORK-STATUS",
    );
  }
  const context = await loadMoveContext(root, id);
  return buildMoveResult(context.works, context.loaded, targetStatus, options);
}

export async function syncWorkOverview(
  root: string,
  id: string,
): Promise<SyncOverviewResult> {
  return withWorkspaceLock(root, async () => {
    const normalizedId = id.trim().toUpperCase();
    // Sync records one body digest; workspace health remains check's responsibility.
    if (!workMetadataSchema.shape.id.safeParse(normalizedId).success) {
      throw new WorkspaceError(
        `Invalid work ID: ${normalizedId}`,
        "AIO-IDENTITY-FORMAT",
      );
    }
    const configPath = path.join(root, CONFIG_PATH);
    await assertSyncFile(root, configPath, "AIO-CONFIG-READ");
    const config = await loadConfig(root);
    const directory = path.join(root, WORK_DIR, normalizedId);
    if ((await safePathKind(root, directory)) === "missing") {
      throw new WorkspaceError(
        `Work not found: ${normalizedId}`,
        "AIO-WORK-NOT-FOUND",
      );
    }
    const recordPath = path.join(directory, RECORD_NAME);
    await assertSyncFile(root, recordPath, "AIO-STRUCTURE-RECORD");
    const files = new ManagedFiles(root);
    await files.assertIncluded(recordPath);
    await files.assertIncluded(path.join(directory, OVERVIEW_NAME));
    const source = await readFile(recordPath, "utf8");
    let record: WorkMetadata;
    try {
      record = workMetadataSchema.parse(parseMarkdownDocument(source).metadata);
    } catch (error) {
      throw new WorkspaceError(
        `Invalid Record metadata: ${errorMessage(error)}`,
        "AIO-SCHEMA-RECORD",
      );
    }
    if (record.id !== normalizedId) {
      throw new WorkspaceError(
        `Record ID does not match directory: ${normalizedId}`,
        "AIO-IDENTITY-DIRECTORY",
      );
    }
    if (!record.id.startsWith(`${config.idPrefix}-`)) {
      throw new WorkspaceError(
        `Record ID does not match workspace prefix: ${record.id}`,
        "AIO-IDENTITY-PREFIX",
      );
    }
    const overviewPath = path.join(root, WORK_DIR, normalizedId, OVERVIEW_NAME);
    await assertSyncFile(root, overviewPath, "AIO-STRUCTURE-OVERVIEW");
    let overviewSource: string;
    let document: ReturnType<typeof parseMarkdownDocument>;
    try {
      overviewSource = await readFile(overviewPath, "utf8");
      document = parseMarkdownDocument(overviewSource);
    } catch (error) {
      throw new WorkspaceError(
        `Cannot read Overview: ${errorMessage(error)}`,
        "AIO-STRUCTURE-OVERVIEW",
      );
    }
    const parsedOverview = overviewMetadataSchema.safeParse(document.metadata);
    if (!parsedOverview.success) {
      throw new WorkspaceError(
        `Invalid Overview metadata: ${parsedOverview.error.issues.map((issue) => issue.message).join(", ")}`,
        "AIO-SCHEMA-OVERVIEW",
      );
    }
    const overview = parsedOverview.data;
    if (overview.id !== record.id) {
      throw new WorkspaceError(
        `Overview ID does not match Record: ${record.id}`,
        "AIO-IDENTITY-OVERVIEW",
      );
    }
    if (overview.title !== record.title) {
      throw new WorkspaceError(
        `Overview title does not match Record: ${record.id}`,
        "AIO-IDENTITY-OVERVIEW-TITLE",
      );
    }
    const recordBodyDigest = calculateMarkdownBodyDigest(source);
    const result = {
      id: normalizedId,
      changed: overview.recordBodyDigest !== recordBodyDigest,
      path: relative(root, overviewPath),
    };
    if (!result.changed) {
      return result;
    }
    await atomicWrite(
      overviewPath,
      replaceMarkdownMetadata(overviewSource, {
        ...(document.metadata as Record<string, unknown>),
        recordBodyDigest,
      }),
    );
    return result;
  });
}

async function assertSyncFile(
  root: string,
  target: string,
  code: string,
): Promise<void> {
  if ((await safePathKind(root, target)) !== "file") {
    throw new WorkspaceError(
      `Sync requires a safe regular file: ${relative(root, target)}`,
      code,
    );
  }
}

export async function addWorkDependency(
  root: string,
  id: string,
  dependencyId: string,
): Promise<DependencyMutationResult> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const normalizedId = id.trim().toUpperCase();
    const normalizedDependencyId = dependencyId.trim().toUpperCase();
    const works = await listWorks(root);
    const loaded = requireWork(works, normalizedId);
    const dependency = works.find(
      (work) => work.metadata.id === normalizedDependencyId,
    );
    if (!dependency) {
      throw new WorkspaceError(
        `Dependency does not exist: ${normalizedDependencyId}`,
        "AIO-DEPENDENCY-MISSING",
      );
    }
    assertDependencyMutable(loaded.metadata);
    if (normalizedId === normalizedDependencyId) {
      throw new WorkspaceError(
        "A work item cannot depend on itself.",
        "AIO-DEPENDENCY-SELF",
      );
    }
    if (loaded.metadata.needs.includes(normalizedDependencyId)) {
      throw new WorkspaceError(
        `Duplicate dependency: ${normalizedDependencyId}`,
        "AIO-DEPENDENCY-DUPLICATE",
      );
    }

    const record = workMetadataSchema.parse({
      ...loaded.metadata,
      updated: isoToday(),
      needs: [...loaded.metadata.needs, normalizedDependencyId],
    });
    const nextMetadata = replaceWorkMetadata(works, record);
    const issue = validateDependencies(nextMetadata)[0];
    if (issue) {
      throw new WorkspaceError(issue.message, issue.code);
    }
    await writeWorkMetadataMutation(root, works, loaded, record);
    return {
      id: normalizedId,
      dependencyId: normalizedDependencyId,
      action: "add",
      changed: true,
      needs: [...record.needs],
      metadata: record,
    };
  });
}

export async function removeWorkDependency(
  root: string,
  id: string,
  dependencyId: string,
): Promise<DependencyMutationResult> {
  return withWorkspaceLock(root, async () => {
    const normalizedId = id.trim().toUpperCase();
    const normalizedDependencyId = dependencyId.trim().toUpperCase();
    const workspaceIssues = await validateWorkspace(root);
    const blocking = workspaceIssues.find(
      (issue) =>
        issue.code !== "AIO-STRUCTURE-VIEW" &&
        issue.code !== "AIO-VIEW-DRIFT" &&
        !ROUTING_CODES.some((code) => code === issue.code) &&
        !DEPENDENCY_RELATION_CODES.has(issue.code),
    );
    if (blocking) {
      throw workspaceInvalidError(blocking);
    }

    const works = await listWorks(root);
    const loaded = requireWork(works, normalizedId);
    assertDependencyMutable(loaded.metadata);
    const beforeDependencyIssues = validateDependencies(
      works.map((work) => work.metadata),
    );
    if (!loaded.metadata.needs.includes(normalizedDependencyId)) {
      const existingIssue = beforeDependencyIssues[0];
      if (existingIssue) {
        throw workspaceInvalidError(existingIssue);
      }
      return {
        id: normalizedId,
        dependencyId: normalizedDependencyId,
        action: "remove",
        changed: false,
        needs: [...loaded.metadata.needs],
        metadata: loaded.metadata,
      };
    }

    const record = workMetadataSchema.parse({
      ...loaded.metadata,
      updated: isoToday(),
      needs: loaded.metadata.needs.filter(
        (dependency) => dependency !== normalizedDependencyId,
      ),
    });
    const nextMetadata = replaceWorkMetadata(works, record);
    const afterDependencyIssues = validateDependencies(nextMetadata);
    if (
      beforeDependencyIssues.length > 0 &&
      !isDependencyRepair(beforeDependencyIssues, afterDependencyIssues)
    ) {
      const existingIssue = beforeDependencyIssues[0];
      if (existingIssue) {
        throw workspaceInvalidError(existingIssue);
      }
    }
    if (
      beforeDependencyIssues.length === 0 &&
      afterDependencyIssues.length > 0
    ) {
      const issue = afterDependencyIssues[0];
      if (issue) {
        throw new WorkspaceError(issue.message, issue.code);
      }
    }

    await writeWorkMetadataMutation(root, works, loaded, record);
    return {
      id: normalizedId,
      dependencyId: normalizedDependencyId,
      action: "remove",
      changed: true,
      needs: [...record.needs],
      metadata: record,
    };
  });
}

export async function addWorkKnowledge(
  root: string,
  id: string,
  key: string,
): Promise<KnowledgeMutationResult> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const normalizedId = id.trim().toUpperCase();
    const normalizedKey = key.trim().toLowerCase();
    const works = await listWorks(root);
    const loaded = requireWork(works, normalizedId);
    assertKnowledgeMutable(loaded.metadata);
    const entry = (await loadKnowledgeEntries(root)).find(
      (candidate) => candidate.key === normalizedKey,
    );
    if (!entry) {
      throw new WorkspaceError(
        `Knowledge key does not exist: ${normalizedKey}`,
        "AIO-WORK-KNOWLEDGE-MISSING",
      );
    }
    if (loaded.metadata.knowledge.includes(normalizedKey)) {
      return {
        id: normalizedId,
        key: normalizedKey,
        path: entry.path,
        action: "add",
        changed: false,
        knowledge: [...loaded.metadata.knowledge],
        metadata: loaded.metadata,
      };
    }

    const record = workMetadataSchema.parse({
      ...loaded.metadata,
      updated: isoToday(),
      knowledge: [...loaded.metadata.knowledge, normalizedKey],
    });
    await writeWorkMetadataMutation(root, works, loaded, record);
    return {
      id: normalizedId,
      key: normalizedKey,
      path: entry.path,
      action: "add",
      changed: true,
      knowledge: [...record.knowledge],
      metadata: record,
    };
  });
}

export async function removeWorkKnowledge(
  root: string,
  id: string,
  key: string,
): Promise<KnowledgeMutationResult> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const normalizedId = id.trim().toUpperCase();
    const normalizedKey = key.trim().toLowerCase();
    const works = await listWorks(root);
    const loaded = requireWork(works, normalizedId);
    assertKnowledgeMutable(loaded.metadata);
    if (!loaded.metadata.knowledge.includes(normalizedKey)) {
      return {
        id: normalizedId,
        key: normalizedKey,
        action: "remove",
        changed: false,
        knowledge: [...loaded.metadata.knowledge],
        metadata: loaded.metadata,
      };
    }

    const entry = (await loadKnowledgeEntries(root)).find(
      (candidate) => candidate.key === normalizedKey,
    );
    const record = workMetadataSchema.parse({
      ...loaded.metadata,
      updated: isoToday(),
      knowledge: loaded.metadata.knowledge.filter(
        (candidate) => candidate !== normalizedKey,
      ),
    });
    await writeWorkMetadataMutation(root, works, loaded, record);
    return {
      id: normalizedId,
      key: normalizedKey,
      ...(entry ? { path: entry.path } : {}),
      action: "remove",
      changed: true,
      knowledge: [...record.knowledge],
      metadata: record,
    };
  });
}

export async function previewDiscard(
  root: string,
  id: string,
): Promise<DiscardPreview> {
  const normalizedId = id.trim().toUpperCase();
  const works = await listWorks(root);
  const target = works.find((work) => work.metadata.id === normalizedId);
  if (!target) {
    throw new WorkspaceError(
      `Cannot find work item: ${normalizedId}`,
      "AIO-WORK-NOT-FOUND",
    );
  }
  const referencedBy = works
    .filter((work) => work.metadata.needs.includes(normalizedId))
    .map((work) => work.metadata.id);
  const workPath = path.join(root, WORK_DIR, normalizedId);
  return {
    id: normalizedId,
    files: await listRelativeFiles(root, workPath),
    referencedBy,
    trashTarget: `${TRASH_DIR}/${normalizedId}-<timestamp>`,
  };
}

export async function discardWork(
  root: string,
  id: string,
  confirmation: string,
): Promise<string> {
  const normalizedId = id.trim().toUpperCase();
  if (confirmation !== normalizedId) {
    throw new WorkspaceError(
      `Confirmation does not match. Use --confirm ${normalizedId}.`,
      "AIO-DISCARD-CONFIRM",
    );
  }
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const preview = await previewDiscard(root, normalizedId);
    if (preview.referencedBy.length > 0) {
      throw new WorkspaceError(
        `Cannot discard work item because it is referenced by: ${preview.referencedBy.join(", ")}`,
        "AIO-DISCARD-REFERENCED",
      );
    }
    const source = path.join(root, WORK_DIR, normalizedId);
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const target = path.join(root, TRASH_DIR, `${normalizedId}-${timestamp}`);
    await assertSafeManagedParents(
      root,
      relative(root, target),
      internalConflict,
    );
    await rename(source, target);
    try {
      const remaining = (await listWorks(root)).map((work) => work.metadata);
      await writeViews(root, remaining);
    } catch (error) {
      await rename(target, source);
      throw error;
    }
    return relative(root, target);
  });
}

export async function rebuildViews(root: string): Promise<void> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const metadata = (await listWorks(root)).map((work) => work.metadata);
    await writeViews(root, metadata);
  });
}

export async function validateWorkspace(
  root: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  let config: WorkspaceConfig | undefined;
  try {
    config = await loadConfig(root);
  } catch (error) {
    issues.push({
      code: error instanceof WorkspaceError ? error.code : "AIO-CONFIG-UNKNOWN",
      path: CONFIG_PATH.replaceAll(path.sep, "/"),
      message: errorMessage(error),
      hint: "Fix the configuration or run `aiongside init` in a new directory.",
    });
    return issues;
  }

  const files = new ManagedFiles(root);
  const knowledge = await validateKnowledgeStructure(root, files);
  issues.push(...knowledge.issues);

  const workRoot = path.join(root, WORK_DIR);
  let entries: Dirent[];
  try {
    entries = await files.entries(workRoot);
  } catch (error) {
    issues.push({
      code: "AIO-STRUCTURE-WORK-DIR",
      path: WORK_DIR,
      message: `Cannot read work directory: ${errorMessage(error)}`,
    });
    return issues;
  }

  const seen = new Set<string>();
  const viewMetadata: WorkMetadata[] = [];
  const loadedRecords: LoadedWork[] = [];
  let canCompareViews = true;
  let canValidateRelations = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      issues.push({
        code: "AIO-STRUCTURE-WORK-ENTRY",
        path: relative(root, path.join(workRoot, entry.name)),
        message: "Only work item directories are allowed directly under work.",
      });
      continue;
    }
    const directoryPath = path.join(workRoot, entry.name);
    const recordPath = path.join(directoryPath, RECORD_NAME);
    if (!(await files.includes(recordPath))) continue;
    issues.push(
      ...(await validateWorkSupportingStructure(root, directoryPath, files)),
    );
    const overviewPath = path.join(directoryPath, OVERVIEW_NAME);
    const includeOverview = await files.includes(overviewPath);
    const hasOverview = includeOverview && (await pathExists(overviewPath));
    if (includeOverview && !hasOverview) {
      issues.push({
        code: "AIO-STRUCTURE-OVERVIEW",
        path: relative(root, overviewPath),
        message: "Missing human-readable overview.md.",
      });
    }

    let document: ReturnType<typeof parseMarkdownDocument>;
    let recordSource: string;
    try {
      recordSource = await readFile(recordPath, "utf8");
      document = parseMarkdownDocument(recordSource);
    } catch (error) {
      canCompareViews = false;
      canValidateRelations = false;
      issues.push({
        code: "AIO-STRUCTURE-RECORD",
        path: relative(root, recordPath),
        message: errorMessage(error),
      });
      continue;
    }
    const result = workMetadataSchema.safeParse(document.metadata);
    if (!result.success) {
      canCompareViews = false;
      canValidateRelations = false;
      for (const issue of result.error.issues) {
        issues.push({
          code:
            issue.path.length === 1 && issue.path[0] === "id"
              ? "AIO-IDENTITY-FORMAT"
              : "AIO-SCHEMA-RECORD",
          path: `${relative(root, recordPath)}#${issue.path.join(".")}`,
          message: issue.message,
        });
      }
      continue;
    }
    const metadata = result.data;
    viewMetadata.push(metadata);
    loadedRecords.push({
      directory: entry.name,
      metadata,
      source: recordSource,
    });
    if (hasOverview) {
      issues.push(
        ...(await validateOverview(
          root,
          overviewPath,
          metadata,
          calculateMarkdownBodyDigest(recordSource),
        )),
      );
    }
    if (!metadata.id.startsWith(`${config.idPrefix}-`)) {
      canValidateRelations = false;
      issues.push({
        code: "AIO-IDENTITY-PREFIX",
        path: relative(root, recordPath),
        message: `ID does not start with configured prefix ${config.idPrefix}: ${metadata.id}`,
      });
    }
    if (entry.name !== metadata.id) {
      canValidateRelations = false;
      issues.push({
        code: "AIO-IDENTITY-DIRECTORY",
        path: relative(root, directoryPath),
        message: `Directory name does not match Record ID: ${entry.name} != ${metadata.id}`,
      });
    }
    if (seen.has(metadata.id)) {
      canValidateRelations = false;
      issues.push({
        code: "AIO-IDENTITY-DUPLICATE",
        path: relative(root, recordPath),
        message: `Duplicate ID: ${metadata.id}`,
      });
    }
    seen.add(metadata.id);
  }
  if (canValidateRelations) {
    issues.push(...validateDependencies(viewMetadata));
    if (knowledge.entries) {
      issues.push(...validateWorkKnowledge(viewMetadata, knowledge.entries));
    }
    const byId = new Map(viewMetadata.map((item) => [item.id, item]));
    for (const metadata of viewMetadata) {
      issues.push(...validateWorkState(metadata, byId));
    }
    for (const loaded of loadedRecords) {
      if (loaded.metadata.status !== "done") {
        continue;
      }
      if (loaded.metadata.completionSeal === null) {
        issues.push({
          code: "AIO-DONE-INVALIDATED",
          path: workFieldPath(loaded.metadata.id, "completionSeal"),
          message: "Done work is missing a completion seal.",
          hint: `Run \`aiongside work move ${loaded.metadata.id} active --reopen-reason <reason>\`, then complete it again to create a new seal.`,
        });
        continue;
      }
      const document = parseMarkdownDocument(loaded.source);
      const digest = await calculateCompletionDigest(
        root,
        loaded.metadata.id,
        loaded.metadata,
        document.body,
        files,
      );
      if (digest !== loaded.metadata.completionSeal.digest) {
        issues.push({
          code: "AIO-DONE-INVALIDATED",
          path: workFieldPath(loaded.metadata.id, "completionSeal"),
          message: "Done work changed after completion was verified.",
          hint: `Run \`aiongside work move ${loaded.metadata.id} active --reopen-reason <reason>\` before updating and completing it again.`,
        });
      }
    }
  }
  issues.push(
    ...(await validateDocumentLinks(
      root,
      await workMarkdownDocuments(root, files),
    )),
  );
  issues.push(
    ...(await validateViews(root, viewMetadata, canCompareViews, files)),
  );
  return issues;
}

async function loadMoveContext(
  root: string,
  id: string,
): Promise<{
  works: LoadedWork[];
  loaded: LoadedWork;
  knowledgeEntries: KnowledgeEntry[];
}> {
  const normalizedId = id.trim().toUpperCase();
  const works = await listWorks(root);
  const loaded = works.find((work) => work.metadata.id === normalizedId);
  if (!loaded) {
    throw new WorkspaceError(
      `Cannot find work item: ${normalizedId}`,
      "AIO-WORK-NOT-FOUND",
    );
  }
  return { works, loaded, knowledgeEntries: await loadKnowledgeEntries(root) };
}

async function buildMoveResult(
  works: LoadedWork[],
  loaded: LoadedWork,
  targetStatus: WorkStatus,
  options: MoveWorkOptions,
): Promise<MoveWorkResult> {
  const rule = evaluateTransition(loaded.metadata.status, targetStatus);
  const requiredInputs: TransitionRequiredInput[] = rule.requiredInputs.map(
    (input) => ({
      ...input,
      source: "option",
      code: "AIO-TRANSITION-INPUT",
    }),
  );
  if (
    rule.noOp &&
    targetStatus === "done" &&
    loaded.metadata.completionSeal === null
  ) {
    requiredInputs.push({
      key: "completionSeal",
      source: "record",
      code: "AIO-DONE-INVALIDATED",
      question: "Done work is missing a completion seal.",
      hint: `Run aiongside work move ${loaded.metadata.id} active --reopen-reason <reason>, then complete it again.`,
    });
  }
  if (rule.requirements.includes("D")) {
    const byId = new Map(
      works.map((work) => [work.metadata.id, work.metadata]),
    );
    for (const dependencyId of loaded.metadata.needs) {
      const dependency = byId.get(dependencyId);
      if (dependency?.status === "done") continue;
      requiredInputs.push({
        key: `needs.${dependencyId}`,
        source: "record",
        question: dependency
          ? `Dependency ${dependencyId} is ${dependency.status}. How should it be resolved before completion?`
          : `Dependency ${dependencyId} is missing. How should it be resolved before completion?`,
        code: "AIO-DEPENDENCY-BLOCKED",
        hint:
          dependency?.status === "cancelled"
            ? `Cancellation does not satisfy this prerequisite. If this prerequisite is no longer required, run aiongside work needs remove ${loaded.metadata.id} ${dependencyId}. Otherwise, explicitly reopen and complete the prerequisite before completing this work.`
            : "Complete the dependency, remove the relationship, or explicitly revise the work record.",
      });
    }
  }

  const missingInputs = requiredInputs.filter((input) => {
    if (input.source === "option") {
      const value = options[input.key as keyof TransitionInputValues];
      return !value?.trim();
    }
    if (input.key.startsWith("needs.")) {
      const dependencyId = input.key.slice("needs.".length);
      const dependency = works.find(
        (work) => work.metadata.id === dependencyId,
      );
      return dependency?.metadata.status !== "done";
    }
    return true;
  });
  const dependentDone = rule.invalidatesCompletion
    ? findDependentDoneIds(works, loaded.metadata.id)
    : [];
  const warnings = dependentDone.map(
    (id) =>
      `Completed work ${id} depends on ${loaded.metadata.id}; review whether its completion remains valid.`,
  );
  const changes: string[] = [];
  if (!rule.noOp) {
    changes.push(`Change status from ${rule.from} to ${rule.to}.`);
    changes.push("Append a transition history entry.");
    changes.push("Rebuild generated Views.");
  }
  if (targetStatus === "active" && rule.from !== "active") {
    changes.push("Create plan.md if it does not exist.");
  }
  if (targetStatus === "done" && rule.from !== "done") {
    changes.push("Create a completion seal for the current work content.");
  }
  if (rule.invalidatesCompletion) {
    changes.push("Invalidate the existing completion seal.");
  }

  return {
    id: loaded.metadata.id,
    from: rule.from,
    to: rule.to,
    requirements: rule.requirements,
    requiredInputs,
    missingInputs,
    warnings,
    changes,
    invalidatesCompletion: rule.invalidatesCompletion,
    canMove: missingInputs.length === 0,
    applied: false,
    metadata: loaded.metadata,
  };
}

function findDependentDoneIds(
  works: LoadedWork[],
  dependencyId: string,
): string[] {
  const affected = new Set([dependencyId]);
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const work of works) {
      if (
        !affected.has(work.metadata.id) &&
        work.metadata.needs.some((id) => affected.has(id))
      ) {
        affected.add(work.metadata.id);
        if (work.metadata.status === "done") {
          result.add(work.metadata.id);
        }
        changed = true;
      }
    }
  }
  return [...result].sort();
}

async function calculateCompletionDigest(
  root: string,
  id: string,
  metadata: WorkMetadata,
  recordBody: string,
  selection = new ManagedFiles(root),
): Promise<string> {
  const hash = createHash("sha256");
  const stableMetadata = {
    schema: metadata.schema,
    id: metadata.id,
    title: metadata.title,
    type: metadata.type,
    needs: metadata.needs,
  };
  hash.update("record-metadata\0");
  hash.update(JSON.stringify(stableMetadata));
  hash.update("\0record-body\0");
  hash.update(normalizeCompletionText(recordBody));

  const workPath = path.join(root, WORK_DIR, id);
  const recordPath = `${WORK_DIR}/${id}/${RECORD_NAME}`;
  const files = await selection.files(workPath);
  for (const file of files.sort()) {
    if (file === recordPath || file === `${WORK_DIR}/${id}/${OVERVIEW_NAME}`) {
      continue;
    }
    hash.update(`\0${file}\0`);
    hash.update(await readFile(path.join(root, file)));
  }
  return hash.digest("hex");
}

function normalizeCompletionText(source: string): string {
  return `${source.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

function requireWork(works: LoadedWork[], id: string): LoadedWork {
  const loaded = works.find((work) => work.metadata.id === id);
  if (!loaded) {
    throw new WorkspaceError(
      `Cannot find work item: ${id}`,
      "AIO-WORK-NOT-FOUND",
    );
  }
  return loaded;
}

function assertDependencyMutable(metadata: WorkMetadata): void {
  if (metadata.status === "done") {
    throw new WorkspaceError(
      `Reopen ${metadata.id} before changing dependencies.`,
      "AIO-DONE-SEALED",
    );
  }
}

function assertKnowledgeMutable(metadata: WorkMetadata): void {
  if (metadata.status !== "done") {
    throw new WorkspaceError(
      `Complete ${metadata.id} before changing Knowledge relationships.`,
      "AIO-WORK-KNOWLEDGE-STATUS",
    );
  }
}

function replaceWorkMetadata(
  works: LoadedWork[],
  record: WorkMetadata,
): WorkMetadata[] {
  return works.map((work) =>
    work.metadata.id === record.id ? record : work.metadata,
  );
}

function isDependencyRepair(
  before: ValidationIssue[],
  after: ValidationIssue[],
): boolean {
  if (after.length >= before.length) {
    return false;
  }
  const existing = new Set(before.map(dependencyIssueKey));
  return after.every((issue) => existing.has(dependencyIssueKey(issue)));
}

function dependencyIssueKey(issue: ValidationIssue): string {
  return `${issue.code}\0${issue.message}`;
}

export async function createKnowledge(
  root: string,
  input: KnowledgeCreateInput,
): Promise<CreateKnowledgeResult> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const entries = await loadKnowledgeEntries(root);
    const key = normalizeKnowledgeKey(input.key);
    const filePath = normalizeKnowledgePath(input.path ?? `${key}.md`);
    if (entries.some((entry) => entry.key === key))
      throw new WorkspaceError(
        `Knowledge key already exists: ${key}. Choose a unique key; existing documents were not changed.`,
        "AIO-KNOWLEDGE-CREATE-CONFLICT",
      );
    const source = createKnowledgeDocument({ ...input, key });
    await assertKnowledgeFilePath(root, filePath, true);
    const target = path.join(root, "knowledge", filePath);
    const createdDirectories = await missingDirectoryChain(
      path.join(root, "knowledge"),
      path.dirname(target),
    );
    const createdIndexes: string[] = [];
    let written = false;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await createMissingIndexes(root, filePath, createdIndexes);
      await atomicWrite(target, source);
      written = true;
      return {
        ...knowledgeInfo({
          key,
          path: filePath,
          displayName: input.displayName?.trim() || key,
        }),
        changes: [
          ...createdDirectories.reverse().map((item) => relative(root, item)),
          ...createdIndexes.map((item) => relative(root, item)),
          `knowledge/${filePath}`,
        ],
        indexPaths: knowledgeIndexPaths(filePath),
      };
    } catch (error) {
      if (written) await rm(target, { force: true });
      for (const index of createdIndexes) await rm(index, { force: true });
      await removeEmptyDirectories(
        createdDirectories.sort((a, b) => b.length - a.length),
      );
      throw error;
    }
  });
}

export async function previewMoveKnowledge(
  root: string,
  key: string,
  destination: string,
): Promise<MoveKnowledgeResult> {
  await assertMutationSafe(root);
  const entry = await showKnowledge(root, key);
  const destinationPath = normalizeKnowledgePath(destination);
  await assertKnowledgeFilePath(root, entry.path, false);
  if (entry.path !== destinationPath)
    await assertKnowledgeFilePath(root, destinationPath, true);
  return {
    key: entry.key,
    sourcePath: entry.path,
    destinationPath,
    indexPaths: [
      ...new Set([
        ...knowledgeIndexPaths(entry.path),
        ...knowledgeIndexPaths(destinationPath),
      ]),
    ],
    warnings: [
      "Document links and indexes are not rewritten. Work key relationships are preserved.",
    ],
    applied: false,
  };
}

export async function moveKnowledge(
  root: string,
  key: string,
  destination: string,
): Promise<MoveKnowledgeResult> {
  return withWorkspaceLock(root, async () => {
    const result = await previewMoveKnowledge(root, key, destination);
    if (result.sourcePath === result.destinationPath) return result;
    const source = path.join(root, "knowledge", result.sourcePath);
    const target = path.join(root, "knowledge", result.destinationPath);
    const createdDirectories = await missingDirectoryChain(
      path.join(root, "knowledge"),
      path.dirname(target),
    );
    const createdIndexes: string[] = [];
    let moved = false;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await createMissingIndexes(root, result.destinationPath, createdIndexes);
      await rename(source, target);
      moved = true;
      return { ...result, applied: true };
    } catch (error) {
      if (moved) await rename(target, source);
      for (const index of createdIndexes) await rm(index, { force: true });
      await removeEmptyDirectories(createdDirectories);
      throw error;
    }
  });
}

export async function previewDiscardKnowledge(
  root: string,
  key: string,
): Promise<DiscardKnowledgePreview> {
  await assertMutationSafe(root);
  const entry = await showKnowledge(root, key);
  return {
    key: entry.key,
    path: entry.path,
    referencedBy: (await listWorks(root))
      .filter((work) => work.metadata.knowledge.includes(entry.key))
      .map((work) => work.metadata.id),
    trashTarget: `${TRASH_DIR}/knowledge/${entry.key}-<timestamp>/`,
    indexPaths: knowledgeIndexPaths(entry.path),
  };
}

export async function discardKnowledge(
  root: string,
  key: string,
  confirmation: string,
): Promise<DiscardKnowledgeResult> {
  const normalized = normalizeKnowledgeKey(key);
  if (confirmation !== normalized)
    throw new WorkspaceError(
      "Confirm the exact Knowledge key after inspecting --dry-run.",
      "AIO-KNOWLEDGE-DISCARD-CONFIRM",
    );
  return withWorkspaceLock(root, async () => {
    const preview = await previewDiscardKnowledge(root, normalized);
    if (preview.referencedBy.length)
      throw new WorkspaceError(
        `Cannot discard Knowledge referenced by Work: ${preview.referencedBy.join(", ")}`,
        "AIO-KNOWLEDGE-DISCARD-REFERENCED",
      );
    await assertKnowledgeFilePath(root, preview.path, false);
    const trash = `${TRASH_DIR}/knowledge/${normalized}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
    await assertSafeManagedParents(
      root,
      `${trash}/content.md`,
      internalConflict,
    );
    const destination = path.join(root, trash);
    const source = path.join(root, "knowledge", preview.path);
    let created = false;
    let moved = false;
    try {
      await mkdir(destination, { recursive: true });
      created = true;
      await atomicWrite(
        path.join(destination, "recovery.yaml"),
        stringifyYaml({ key: normalized, path: preview.path }),
      );
      await rename(source, path.join(destination, "content.md"));
      moved = true;
      return { ...preview, trashTarget: trash, applied: true };
    } catch (error) {
      if (moved) await rename(path.join(destination, "content.md"), source);
      if (created) await rm(destination, { recursive: true, force: true });
      throw error;
    }
  });
}

function knowledgeIndexPaths(filePath: string): string[] {
  const parts = filePath.split("/");
  parts.pop();
  return [
    "knowledge/index.md",
    ...parts.map(
      (_, i) => `knowledge/${parts.slice(0, i + 1).join("/")}/index.md`,
    ),
  ];
}

async function createMissingIndexes(
  root: string,
  filePath: string,
  created: string[],
): Promise<void> {
  const files = new ManagedFiles(root);
  for (const index of knowledgeIndexPaths(filePath)) {
    if (!(await files.includes(index))) continue;
    const target = path.join(root, index);
    const kind = await safePathKind(root, target);
    if (kind === "missing") {
      await atomicWrite(target, INDEX_SOURCE);
      created.push(target);
    } else if (kind !== "file")
      throw new WorkspaceError(
        `Index must be a regular file: ${index}`,
        "AIO-KNOWLEDGE-PATH",
      );
  }
}

async function assertKnowledgeFilePath(
  root: string,
  filePath: string,
  creating: boolean,
): Promise<void> {
  normalizeKnowledgePath(filePath);
  const target = path.join(root, "knowledge", filePath);
  const kind = await safePathKind(root, target);
  if ((creating && kind !== "missing") || (!creating && kind !== "file"))
    throw new WorkspaceError(
      `Knowledge path ${creating ? "already exists or is unsafe" : "is not a regular file"}: knowledge/${filePath}`,
      creating ? "AIO-KNOWLEDGE-CREATE-CONFLICT" : "AIO-KNOWLEDGE-PATH",
    );
  await new ManagedFiles(root).assertIncluded(target);
}

async function writeWorkMetadataMutation(
  root: string,
  works: LoadedWork[],
  loaded: LoadedWork,
  record: WorkMetadata,
): Promise<void> {
  const document = parseMarkdownDocument(loaded.source);
  const recordPath = path.join(root, WORK_DIR, record.id, RECORD_NAME);
  try {
    await atomicWrite(
      recordPath,
      formatMarkdownDocument(record, document.body),
    );
    await writeViews(root, replaceWorkMetadata(works, record));
  } catch (error) {
    await atomicWrite(recordPath, loaded.source);
    await writeViews(
      root,
      works.map((work) => work.metadata),
    );
    throw error;
  }
}

export async function listKnowledge(root: string): Promise<KnowledgeInfo[]> {
  return (await loadKnowledgeEntries(root)).map(knowledgeInfo);
}

export async function showKnowledge(
  root: string,
  key: string,
): Promise<KnowledgeInfo> {
  const normalized = normalizeKnowledgeKey(key);
  const entry = (await loadKnowledgeEntries(root)).find(
    (item) => item.key === normalized,
  );
  if (!entry)
    throw new WorkspaceError(
      `Knowledge key does not exist: ${normalized}. Run aiongside knowledge list to find current document keys.`,
      "AIO-KNOWLEDGE-NOT-FOUND",
    );
  return knowledgeInfo(entry);
}

export async function getKnowledgeTree(
  root: string,
): Promise<KnowledgeTreeNode[]> {
  const files = new ManagedFiles(root);
  const scan = await scanKnowledge(root, files);
  const blocking = scan.issues.find(
    (issue) => !ROUTING_CODES.some((code) => code === issue.code),
  );
  if (blocking) throw workspaceInvalidError(blocking);
  const byPath = new Map(scan.entries.map((entry) => [entry.path, entry]));
  const visit = async (directory: string): Promise<KnowledgeTreeNode[]> => {
    const nodes: KnowledgeTreeNode[] = [];
    for (const item of (await files.entries(directory)).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(directory, item.name);
      const filePath = relative(path.join(root, "knowledge"), absolute);
      if (item.isDirectory())
        nodes.push({
          type: "directory",
          path: filePath,
          displayName: item.name,
          children: await visit(absolute),
        });
      else {
        const entry = byPath.get(filePath);
        if (entry) nodes.push({ type: "document", ...entry, children: [] });
      }
    }
    return nodes;
  };
  return visit(path.join(root, "knowledge"));
}

function knowledgeInfo(entry: KnowledgeEntry): KnowledgeInfo {
  return {
    ...entry,
    document: `knowledge/${entry.path}`,
    index: knowledgeIndexPaths(entry.path).at(-1) as string,
  };
}

async function loadKnowledgeEntries(root: string): Promise<KnowledgeEntry[]> {
  const scan = await scanKnowledge(root);
  const issue = scan.issues.find(
    (item) => !ROUTING_CODES.some((code) => code === item.code),
  );
  if (issue) throw workspaceInvalidError(issue);
  return scan.entries;
}

type ExistingPathKind = "missing" | "directory" | "file" | "symlink" | "other";

async function inspectPath(target: string): Promise<ExistingPathKind> {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isDirectory()) return "directory";
    if (metadata.isFile()) return "file";
    return "other";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function missingDirectoryChain(
  boundary: string,
  target: string,
): Promise<string[]> {
  const relativeTarget = path.relative(boundary, target);
  if (!relativeTarget || relativeTarget === ".") return [];
  const missing: string[] = [];
  let current = boundary;
  let foundMissing = false;
  for (const segment of relativeTarget.split(path.sep)) {
    current = path.join(current, segment);
    if (foundMissing || (await inspectPath(current)) === "missing") {
      foundMissing = true;
      missing.unshift(current);
    }
  }
  return missing;
}

async function removeEmptyDirectories(directories: string[]): Promise<void> {
  for (const directory of directories) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (
        !isNodeError(error) ||
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")
      ) {
        throw error;
      }
    }
  }
}

function validateDependencies(metadata: WorkMetadata[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(metadata.map((item) => [item.id, item]));
  const sorted = [...metadata].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  for (const item of sorted) {
    const seen = new Set<string>();
    for (const [index, dependency] of item.needs.entries()) {
      const issuePath = workFieldPath(item.id, `needs.${index}`);
      if (dependency === item.id) {
        issues.push({
          code: "AIO-DEPENDENCY-SELF",
          path: issuePath,
          message: "A work item cannot depend on itself.",
        });
      }
      if (seen.has(dependency)) {
        issues.push({
          code: "AIO-DEPENDENCY-DUPLICATE",
          path: issuePath,
          message: `Duplicate dependency: ${dependency}`,
        });
      }
      seen.add(dependency);
      if (!byId.has(dependency)) {
        issues.push({
          code: "AIO-DEPENDENCY-MISSING",
          path: issuePath,
          message: `Dependency does not exist: ${dependency}`,
        });
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);
    const item = byId.get(id);
    const dependencies = [...new Set(item?.needs ?? [])].sort();
    for (const dependency of dependencies) {
      if (dependency === id || !byId.has(dependency)) {
        continue;
      }
      const dependencyState = state.get(dependency);
      if (dependencyState === undefined) {
        visit(dependency);
        continue;
      }
      if (dependencyState === "visiting") {
        const start = stack.indexOf(dependency);
        const cycle = [...stack.slice(start), dependency];
        const key = [...new Set(cycle)].sort().join("|");
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({
            code: "AIO-DEPENDENCY-CYCLE",
            path: workFieldPath(dependency, "needs"),
            message: `Dependency cycle: ${cycle.join(" -> ")}`,
          });
        }
      }
    }
    stack.pop();
    state.set(id, "visited");
  };

  for (const item of sorted) {
    if (state.get(item.id) === undefined) {
      visit(item.id);
    }
  }
  return issues;
}

function validateWorkState(
  metadata: WorkMetadata,
  byId: Map<string, WorkMetadata>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (metadata.status === "done") {
    for (const [index, dependencyId] of metadata.needs.entries()) {
      const dependency = byId.get(dependencyId);
      if (dependency && dependency.status !== "done") {
        issues.push({
          code: "AIO-DEPENDENCY-BLOCKED",
          path: workFieldPath(metadata.id, `needs.${index}`),
          message: `Status ${metadata.status} requires dependency ${dependencyId} to be done; current status is ${dependency.status}.`,
          hint: `Complete ${dependencyId} or resolve the dependency before completing this work item.`,
        });
      }
    }
  }
  return issues;
}

function workFieldPath(id: string, field: string): string {
  return `${WORK_DIR}/${id}/${RECORD_NAME}#${field}`;
}

async function validateKnowledgeStructure(
  root: string,
  files: ManagedFiles,
): Promise<{ issues: ValidationIssue[]; entries: KnowledgeEntry[] }> {
  const { issues, entries } = await scanKnowledge(root, files);
  return { issues, entries };
}

function validateWorkKnowledge(
  metadata: WorkMetadata[],
  entries: KnowledgeEntry[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byKey = knowledgeEntriesByKey(entries);
  for (const work of metadata) {
    const seen = new Set<string>();
    for (const [index, key] of work.knowledge.entries()) {
      const issuePath = workFieldPath(work.id, `knowledge.${index}`);
      if (seen.has(key)) {
        issues.push({
          code: "AIO-WORK-KNOWLEDGE-DUPLICATE",
          path: issuePath,
          message: `Duplicate Knowledge relationship: ${key}`,
        });
      }
      seen.add(key);
      if (!byKey.has(key)) {
        issues.push({
          code: "AIO-WORK-KNOWLEDGE-MISSING",
          path: issuePath,
          message: `Knowledge key does not exist: ${key}`,
          hint: "Restore the intended document key or remove the invalid Work relationship. Run aiongside knowledge list to see current keys.",
        });
      }
    }
  }
  return issues;
}

async function validateWorkSupportingStructure(
  root: string,
  workPath: string,
  files: ManagedFiles,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const definition of SUPPORTING_CONTENT_DIRECTORIES) {
    const target = path.join(workPath, definition.name);
    if (!(await files.includes(target, true))) continue;
    try {
      const targetStat = await stat(target);
      if (targetStat.isDirectory()) {
        continue;
      }
      issues.push({
        code: definition.code,
        path: relative(root, target),
        message: `Required ${definition.name} path is not a directory.`,
        hint: supportingDirectoryHint(definition.name),
      });
    } catch (error) {
      issues.push({
        code: definition.code,
        path: relative(root, target),
        message: `Cannot read required ${definition.name} directory: ${errorMessage(error)}`,
        hint: supportingDirectoryHint(definition.name),
      });
    }
  }
  return issues;
}

function supportingDirectoryHint(
  name: (typeof SUPPORTING_CONTENT_DIRECTORIES)[number]["name"],
): string {
  if (name === "deliverables") {
    return "Create the deliverables directory and move report outputs from reports if needed.";
  }
  return `Restore the ${name} directory.`;
}

async function validateOverview(
  root: string,
  overviewPath: string,
  expected: WorkMetadata,
  recordBodyDigest: string,
): Promise<ValidationIssue[]> {
  try {
    const document = parseMarkdownDocument(
      await readFile(overviewPath, "utf8"),
    );
    const result = overviewMetadataSchema.safeParse(document.metadata);
    if (!result.success) {
      return result.error.issues.map((issue) => ({
        code: "AIO-SCHEMA-OVERVIEW",
        path: `${relative(root, overviewPath)}#${issue.path.join(".")}`,
        message: issue.message,
      }));
    }
    const issues: ValidationIssue[] = [];
    if (result.data.id !== expected.id) {
      issues.push({
        code: "AIO-IDENTITY-OVERVIEW",
        path: relative(root, overviewPath),
        message: `Overview ID does not match Record ID: ${result.data.id} != ${expected.id}`,
      });
    }
    if (result.data.title !== expected.title) {
      issues.push({
        code: "AIO-IDENTITY-OVERVIEW-TITLE",
        path: relative(root, overviewPath),
        message: `Overview title does not match Record title: ${result.data.title} != ${expected.title}`,
      });
    }
    if (result.data.recordBodyDigest !== recordBodyDigest) {
      issues.push({
        code: "AIO-OVERVIEW-STALE",
        path: `${relative(root, overviewPath)}#recordBodyDigest`,
        message:
          result.data.recordBodyDigest === undefined
            ? `Missing recordBodyDigest in ${relative(root, overviewPath)}; no hash is recorded for work/${expected.id}/record.md.`
            : `Stored recordBodyDigest in ${relative(root, overviewPath)} does not match the current body of work/${expected.id}/record.md.`,
        hint: `Compare work/${expected.id}/record.md with ${relative(root, overviewPath)}. Update ${relative(root, overviewPath)} if its summary needs changes; otherwise leave its body unchanged. Then run \`aiongside work sync ${expected.id}\`.`,
      });
    }
    return issues;
  } catch (error) {
    return [
      {
        code: "AIO-STRUCTURE-OVERVIEW",
        path: relative(root, overviewPath),
        message: errorMessage(error),
      },
    ];
  }
}

async function validateViews(
  root: string,
  metadata: WorkMetadata[],
  canCompare: boolean,
  files: ManagedFiles,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const expected = renderViews(metadata);
  for (const viewPath of VIEW_PATHS) {
    if (!(await files.includes(viewPath))) continue;
    const target = path.join(root, viewPath);
    let actual: string;
    try {
      actual = await readFile(target, "utf8");
    } catch (error) {
      issues.push({
        code: "AIO-STRUCTURE-VIEW",
        path: viewPath,
        message:
          isNodeError(error) && error.code === "ENOENT"
            ? "Missing generated View."
            : `Cannot read View: ${errorMessage(error)}`,
        hint: "Run `aiongside view sync`.",
      });
      continue;
    }
    if (canCompare && actual !== expected[viewPath]) {
      issues.push({
        code: "AIO-VIEW-DRIFT",
        path: viewPath,
        message: "Generated View does not match current Records.",
        hint: "Run `aiongside view sync`.",
      });
    }
  }
  return issues;
}

async function readWorkspaceTemplate(
  root: string,
  name: TemplateName,
): Promise<string> {
  const templatePath = path.join(
    root,
    TEMPLATE_DIR,
    TEMPLATE_DEFINITIONS[name].file,
  );
  try {
    return await readFile(templatePath, "utf8");
  } catch (error) {
    throw new WorkspaceError(
      `Cannot read template ${relative(root, templatePath)}: ${errorMessage(error)}`,
      "AIO-TEMPLATE-READ",
    );
  }
}

async function writeViews(
  root: string,
  metadata: WorkMetadata[],
): Promise<void> {
  const views = renderViews(metadata);
  const files = new ManagedFiles(root);
  const paths = [];
  for (const name of VIEW_PATHS)
    if (await files.includes(name)) paths.push(name);
  const previous = new Map<string, string | undefined>();
  for (const name of paths) {
    previous.set(name, await readOptionalFile(path.join(root, name)));
  }
  try {
    for (const name of paths) {
      const contents = views[name];
      if (contents === undefined) {
        throw new Error(`View renderer omitted ${name}`);
      }
      await atomicWrite(path.join(root, name), contents);
    }
  } catch (error) {
    for (const [name, contents] of previous) {
      const target = path.join(root, name);
      if (contents === undefined) {
        await rm(target, { force: true });
      } else {
        await atomicWrite(target, contents);
      }
    }
    throw error;
  }
}

async function planAgentInstructionsTarget(
  root: string,
  expectedSource: string,
  managed: boolean,
): Promise<ManagedFilePlan> {
  await assertSafeManagedParents(
    root,
    AGENT_INSTRUCTIONS_PATH,
    instructionsConflict,
  );
  const target = path.join(root, AGENT_INSTRUCTIONS_PATH);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        relativePath: AGENT_INSTRUCTIONS_PATH,
        target,
        previous: undefined,
        next: expectedSource,
        write: true,
      };
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw instructionsConflict(root, target);
  }
  const previous = await readFile(target, "utf8");
  if (previous === expectedSource) {
    return {
      relativePath: AGENT_INSTRUCTIONS_PATH,
      target,
      previous,
      next: expectedSource,
      write: false,
    };
  }
  if (!managed) {
    throw instructionsConflict(root, target);
  }
  return {
    relativePath: AGENT_INSTRUCTIONS_PATH,
    target,
    previous,
    next: expectedSource,
    write: true,
  };
}

async function planAgentHookTargets(root: string): Promise<ManagedFilePlan[]> {
  const result: ManagedFilePlan[] = [];
  for (const relativePath of AGENT_HOOK_PATHS) {
    await assertSafeManagedParents(root, relativePath, hookConflict);
    const target = path.join(root, relativePath);
    let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
      throw hookConflict(root, target);
    }
    const previous = metadata ? await readFile(target, "utf8") : undefined;
    let next: string;
    try {
      next = mergeAgentHookSettings(previous, relativePath);
    } catch (error) {
      throw hookConflict(root, target, errorMessage(error));
    }
    result.push({
      relativePath,
      target,
      previous,
      next,
      write: previous !== next,
    });
  }
  return result;
}

async function assertSafeManagedParents(
  root: string,
  relativePath: string,
  conflict: (root: string, target: string) => WorkspaceError,
): Promise<void> {
  const parts = relativePath.split(path.sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw conflict(root, current);
    }
  }
}

function internalConflict(root: string, target: string): WorkspaceError {
  return new WorkspaceError(
    `Internal workspace path must be a directory, not a symbolic link: ${relative(root, target)}`,
    "AIO-INTERNAL-CONFLICT",
  );
}

function instructionsConflict(root: string, target: string): WorkspaceError {
  return new WorkspaceError(
    `Cannot manage ${relative(root, target)} because it contains user-owned content. Preserve custom instructions in your agent's instruction files and resolve this conflict before retrying.`,
    "AIO-INSTRUCTIONS-CONFLICT",
  );
}

function hookConflict(
  root: string,
  target: string,
  detail?: string,
): WorkspaceError {
  return new WorkspaceError(
    `Cannot merge AIongside Hooks into ${relative(root, target)}${detail ? `: ${detail}` : "."}`,
    "AIO-HOOK-CONFLICT",
  );
}

async function applyAgentIntegrationState(
  root: string,
  plan: ManagedFilePlan[],
  previousConfig: string | undefined,
  nextConfig: string,
  writeConfig: boolean,
): Promise<void> {
  const configPath = path.join(root, CONFIG_PATH);
  try {
    for (const target of plan) {
      if (target.write) {
        await atomicWrite(target.target, target.next);
      }
    }
    if (writeConfig) {
      await atomicWrite(configPath, nextConfig);
    }
  } catch (error) {
    try {
      for (const target of plan) {
        if (!target.write) {
          continue;
        }
        if (target.previous === undefined) {
          await rm(target.target, { force: true });
        } else {
          await atomicWrite(target.target, target.previous);
        }
      }
      if (writeConfig) {
        if (previousConfig === undefined) {
          await rm(configPath, { force: true });
        } else {
          await atomicWrite(configPath, previousConfig);
        }
      }
    } catch (rollbackError) {
      throw new WorkspaceError(
        `Agent integration write failed and rollback also failed: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
        "AIO-WRITE",
      );
    }
    throw new WorkspaceError(
      `Agent integration write failed: ${errorMessage(error)}`,
      "AIO-WRITE",
    );
  }
}

export async function validateAgentIntegration(
  root: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const expectedInstructions = await loadAgentInstructionsSource();
  const adapterCandidates = [
    new URL("./agent-adapter.js", import.meta.url),
    new URL("../../cli/dist/agent-adapter.js", import.meta.url),
  ];
  if (
    !(
      await Promise.all(
        adapterCandidates.map(async (candidate) => {
          try {
            return (await stat(candidate)).isFile();
          } catch {
            return false;
          }
        }),
      )
    ).some(Boolean)
  ) {
    issues.push({
      code: "AIO-ADAPTER-MISSING",
      path: "aiongside-agent-adapter",
      message: "Installed adapter entrypoint is unavailable.",
      hint: "Reinstall the AIongside CLI package.",
    });
  }
  try {
    const version = await planIntegrationVersion(root);
    if (version.write)
      issues.push({
        code: "AIO-INTEGRATION-OUTDATED",
        path: INTEGRATION_PATH,
        message:
          "Integration metadata is missing or differs from the installed CLI.",
        hint: "Run `aiongside workspace upgrade`.",
      });
  } catch (error) {
    issues.push({
      code:
        error instanceof WorkspaceError ? error.code : "AIO-INTEGRATION-FORMAT",
      path: INTEGRATION_PATH,
      message: errorMessage(error),
      hint: "Resolve the metadata conflict before running `aiongside workspace upgrade`.",
    });
  }

  const instructionsPath = path.join(root, AGENT_INSTRUCTIONS_PATH);
  let instructionsMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    instructionsMetadata = await lstat(instructionsPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (
    !instructionsMetadata?.isFile() ||
    instructionsMetadata.isSymbolicLink()
  ) {
    issues.push({
      code: "AIO-INSTRUCTIONS-MISSING",
      path: AGENT_INSTRUCTIONS_PATH,
      message:
        "Managed AIongside instructions are missing or not a regular file.",
      hint: "Run `aiongside workspace upgrade`.",
    });
  } else {
    const instructions = await readFile(instructionsPath, "utf8");
    if (instructions !== expectedInstructions) {
      issues.push({
        code: "AIO-INSTRUCTIONS-DRIFT",
        path: AGENT_INSTRUCTIONS_PATH,
        message: "Managed AIongside instructions differ from the CLI source.",
        hint: "Preserve custom instructions in your agent's instruction files, then run `aiongside workspace upgrade`.",
      });
    }
  }

  for (const relativePath of AGENT_HOOK_PATHS) {
    const target = path.join(root, relativePath);
    let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      issues.push({
        code: "AIO-HOOK-MISSING",
        path: relativePath,
        message: "Managed AIongside Hooks are missing or not a regular file.",
        hint: "Run `aiongside workspace upgrade`.",
      });
      continue;
    }
    const hookSource = await readFile(target, "utf8");
    if (!agentHookSettingsAreCurrent(hookSource, relativePath)) {
      issues.push({
        code: "AIO-HOOK-DRIFT",
        path: relativePath,
        message: "Managed AIongside Hooks are missing, invalid, or outdated.",
        hint: "Fix conflicting Hook settings and run `aiongside workspace upgrade`.",
      });
    }
  }
  return issues;
}

async function withWorkspaceLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockTarget = path.join(root, ".aiongside");
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      retries: { retries: 5, minTimeout: 25, maxTimeout: 200 },
    });
    return await action();
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    if (error instanceof KnowledgeMutationError) {
      throw new WorkspaceError(error.message, error.code);
    }
    throw new WorkspaceError(
      `Workspace mutation failed: ${errorMessage(error)}`,
      "AIO-WRITE",
    );
  } finally {
    await release?.();
  }
}

async function assertMutationSafe(
  root: string,
  allowedCodes: readonly string[] = [],
  allowedIssue?: (issue: ValidationIssue) => boolean,
): Promise<void> {
  const allowed = new Set([
    "AIO-STRUCTURE-VIEW",
    "AIO-VIEW-DRIFT",
    ...ROUTING_CODES,
    ...allowedCodes,
  ]);
  const blocking = (await validateWorkspace(root)).filter(
    (issue) => !allowed.has(issue.code) && !allowedIssue?.(issue),
  );
  const first = blocking[0];
  if (first) {
    throw workspaceInvalidError(first);
  }
}

function issueTouchesWork(issue: ValidationIssue, id: string): boolean {
  const recordPath = `${WORK_DIR}/${id}/${RECORD_NAME}`;
  return issue.path.startsWith(recordPath) || issue.message.includes(id);
}

function workspaceInvalidError(issue: ValidationIssue): WorkspaceError {
  return new WorkspaceError(
    `Fix workspace validation first. [${issue.code}] ${issue.path}: ${issue.message}${issue.hint ? `\n${issue.hint}` : ""}`,
    "AIO-WORKSPACE-INVALID",
  );
}

async function nextWorkNumber(root: string, prefix: string): Promise<bigint> {
  const pattern = new RegExp(`^${prefix}-([1-9]\\d*)$`);
  const entries = await readdir(path.join(root, WORK_DIR), {
    withFileTypes: true,
  });
  const numbers = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => pattern.exec(entry.name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => BigInt(match[1] ?? "0"));
  return (
    numbers.reduce(
      (largest, value) => (value > largest ? value : largest),
      0n,
    ) + 1n
  );
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, contents, { encoding: "utf8" });
}

async function readOptionalFile(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeIfMissing(target: string, contents: string): Promise<void> {
  if (!(await pathExists(target))) {
    await atomicWrite(target, contents);
  }
}

async function listRelativeFiles(
  root: string,
  directory: string,
): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listRelativeFiles(root, target)));
    } else {
      result.push(relative(root, target));
    }
  }
  return result;
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
