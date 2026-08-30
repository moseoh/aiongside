import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  createAgentEntryDocument,
  createOverviewDocument,
  createPlanDocument,
  createRecordDocument,
  createRulesDocument,
  evaluateTransition,
  formatMarkdownDocument,
  idNumber,
  isMovableStatus,
  isWorkCheck,
  overviewMetadataSchema,
  parseMarkdownDocument,
  renderViews,
  TEMPLATE_DEFINITIONS,
  TEMPLATE_NAMES,
  type TemplateName,
  type TransitionInputValues,
  type TransitionRequiredInput,
  type TransitionResult,
  type ValidationIssue,
  validateTemplate,
  type WorkCheck,
  type WorkMetadata,
  type WorkStatus,
  type WorkspaceConfig,
  workMetadataSchema,
  workspaceConfigSchema,
} from "@aiongside/core";
import * as lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { WorkspaceError } from "./errors.js";

const CONFIG_PATH = path.join(".aiongside", "config.yaml");
const WORK_DIR = "work";
const OVERVIEW_NAME = "overview.md";
const RECORD_NAME = "record.md";
const AGENT_MARKER = ".aiongside/rules.md";
const TEMPLATE_DIR = path.join(".aiongside", "templates");
const VIEW_PATHS = ["views/open.md", "views/closed.md"] as const;
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
}

export interface DependencyMutationResult {
  id: string;
  dependencyId: string;
  action: "add" | "remove";
  changed: boolean;
  needs: string[];
  metadata: WorkMetadata;
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

  const config = workspaceConfigSchema.parse({
    schema: 1,
    name: options.name?.trim() || path.basename(root),
    idPrefix: options.idPrefix?.trim().toUpperCase() || "AIO",
  });

  await mkdir(path.join(root, ".aiongside", "trash"), { recursive: true });
  await mkdir(path.join(root, TEMPLATE_DIR), { recursive: true });
  await mkdir(path.join(root, WORK_DIR), { recursive: true });
  await mkdir(path.join(root, "views"), { recursive: true });
  await mkdir(path.join(root, "knowledge"), { recursive: true });
  await atomicWrite(configPath, stringifyYaml(config, { lineWidth: 0 }));
  await atomicWrite(
    path.join(root, ".aiongside", "rules.md"),
    createRulesDocument(),
  );
  for (const name of TEMPLATE_NAMES) {
    const definition = TEMPLATE_DEFINITIONS[name];
    await writeIfMissing(
      path.join(root, TEMPLATE_DIR, definition.file),
      definition.contents,
    );
  }
  await atomicWrite(
    path.join(root, "knowledge", "registry.md"),
    "# Knowledge areas\n\n| Key | Display name |\n| --- | --- |\n",
  );
  await writeViews(root, []);
  await ensureAgentEntry(root, "AGENTS.md", config);
  await ensureAgentEntry(root, "CLAUDE.md", config);
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

export async function listWorks(root: string): Promise<LoadedWork[]> {
  const workRoot = path.join(root, WORK_DIR);
  const entries = await readdir(workRoot, { withFileTypes: true });
  const works: LoadedWork[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const recordPath = path.join(workRoot, entry.name, RECORD_NAME);
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
  return works.sort(
    (left, right) => idNumber(left.metadata.id) - idNumber(right.metadata.id),
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
    const id = `${config.idPrefix}-${String(next).padStart(3, "0")}`;
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
      checks: {
        scope: false,
        completion: false,
        verification: false,
        outcome: false,
        knowledge: false,
      },
    });

    const staging = path.join(
      root,
      ".aiongside",
      "staging",
      `${id}-${randomUUID()}`,
    );
    const destination = path.join(root, WORK_DIR, id);
    const [recordTemplate, overviewTemplate] = await Promise.all([
      readWorkspaceTemplate(root, "record"),
      readWorkspaceTemplate(root, "overview"),
    ]);
    await mkdir(staging, { recursive: true });
    let moved = false;
    try {
      await Promise.all([
        atomicWrite(
          path.join(staging, RECORD_NAME),
          createRecordDocument(metadata, recordTemplate),
        ),
        atomicWrite(
          path.join(staging, OVERVIEW_NAME),
          createOverviewDocument(metadata, overviewTemplate),
        ),
        ...["reports", "references"].map((name) =>
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
      `Cannot move work item to status: ${targetStatus}`,
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
    const preview = buildMoveResult(
      context.works,
      context.loaded,
      targetStatus,
      options,
    );
    const legacySealMigration =
      preview.from === "done" &&
      preview.to === "done" &&
      preview.metadata.completionSeal === null;
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
    if (preview.from === preview.to && !legacySealMigration) {
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
      updated: legacySealMigration
        ? context.loaded.metadata.updated
        : isoToday(),
      checks: preview.invalidatesCompletion
        ? {
            ...context.loaded.metadata.checks,
            verification: false,
            outcome: false,
            knowledge: false,
          }
        : context.loaded.metadata.checks,
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
    const previousPlan = await readOptionalFile(planPath);
    try {
      await atomicWrite(
        recordPath,
        formatMarkdownDocument(record, document.body),
      );
      if (record.status === "active" && previousPlan === undefined) {
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
      if (previousPlan === undefined) {
        await rm(planPath, { force: true });
      } else {
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
      changes: legacySealMigration
        ? ["Create the initial completion seal."]
        : preview.changes,
      canMove: true,
      applied: true,
      metadata: record,
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
      `Cannot move work item to status: ${targetStatus}`,
      "AIO-WORK-STATUS",
    );
  }
  const context = await loadMoveContext(root, id);
  return buildMoveResult(context.works, context.loaded, targetStatus, options);
}

export async function confirmWork(
  root: string,
  id: string,
  checks: string[],
): Promise<WorkMetadata> {
  const normalized = [...new Set(checks.map((check) => check.toLowerCase()))];
  if (normalized.length === 0) {
    throw new WorkspaceError("Confirm at least one check.", "AIO-WORK-CHECK");
  }
  for (const check of normalized) {
    if (!isWorkCheck(check)) {
      throw new WorkspaceError(
        `Unknown work check: ${check}`,
        "AIO-WORK-CHECK",
      );
    }
  }

  return updateWork(root, id, (metadata) => {
    const nextChecks = { ...metadata.checks };
    for (const check of normalized as WorkCheck[]) {
      nextChecks[check] = true;
    }
    return { ...metadata, checks: nextChecks };
  });
}

export async function cancelWork(
  root: string,
  id: string,
  options: MoveWorkOptions = {},
): Promise<MoveWorkResult> {
  return moveWork(root, id, "cancelled", options);
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
    await writeDependencyMutation(root, works, loaded, record);
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

    await writeDependencyMutation(root, works, loaded, record);
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
    trashTarget: `.aiongside/trash/${normalizedId}-<timestamp>`,
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
    const target = path.join(
      root,
      ".aiongside",
      "trash",
      `${normalizedId}-${timestamp}`,
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

  issues.push(...(await validateWorkspaceTemplates(root)));

  const workRoot = path.join(root, WORK_DIR);
  let entries: Dirent[];
  try {
    entries = await readdir(workRoot, { withFileTypes: true });
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
    const overviewPath = path.join(directoryPath, OVERVIEW_NAME);
    const hasOverview = await pathExists(overviewPath);
    if (!hasOverview) {
      issues.push({
        code: "AIO-STRUCTURE-OVERVIEW",
        path: relative(root, overviewPath),
        message: "Missing human-readable overview.md.",
      });
    }

    let document: ReturnType<typeof parseMarkdownDocument>;
    try {
      document = parseMarkdownDocument(await readFile(recordPath, "utf8"));
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
          code: "AIO-SCHEMA-RECORD",
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
      source: formatMarkdownDocument(metadata, document.body),
    });
    if (hasOverview) {
      issues.push(...(await validateOverview(root, overviewPath, metadata)));
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
          hint: `Run \`aiongside work move ${loaded.metadata.id} done\` to create the initial seal after reviewing the work.`,
        });
        continue;
      }
      const document = parseMarkdownDocument(loaded.source);
      const digest = await calculateCompletionDigest(
        root,
        loaded.metadata.id,
        loaded.metadata,
        document.body,
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
  issues.push(...(await validateViews(root, viewMetadata, canCompareViews)));
  return issues;
}

async function loadMoveContext(
  root: string,
  id: string,
): Promise<{ works: LoadedWork[]; loaded: LoadedWork }> {
  const normalizedId = id.trim().toUpperCase();
  const works = await listWorks(root);
  const loaded = works.find((work) => work.metadata.id === normalizedId);
  if (!loaded) {
    throw new WorkspaceError(
      `Cannot find work item: ${normalizedId}`,
      "AIO-WORK-NOT-FOUND",
    );
  }
  return { works, loaded };
}

function buildMoveResult(
  works: LoadedWork[],
  loaded: LoadedWork,
  targetStatus: WorkStatus,
  options: MoveWorkOptions,
): MoveWorkResult {
  const rule = evaluateTransition(loaded.metadata.status, targetStatus);
  const requiredInputs: TransitionRequiredInput[] = rule.requiredInputs.map(
    (input) => ({
      ...input,
      source: "option",
      code: "AIO-TRANSITION-INPUT",
    }),
  );
  const legacySealMigration =
    loaded.metadata.status === "done" &&
    targetStatus === "done" &&
    loaded.metadata.completionSeal === null;

  if (rule.requirements.includes("D") || legacySealMigration) {
    const checkQuestions: Record<WorkCheck, string> = {
      scope: "Has the current work scope been reviewed?",
      completion: "Have the completion criteria been met?",
      verification: "What verification was performed and what was observed?",
      outcome: "Has the outcome been recorded?",
      knowledge: "Has the persistent knowledge impact been reviewed?",
    };
    for (const check of [
      "scope",
      "completion",
      "verification",
      "outcome",
      "knowledge",
    ] as const) {
      requiredInputs.push({
        key: `checks.${check}`,
        source: "record",
        question: checkQuestions[check],
        code: "AIO-STATE-GATE",
        hint: `Run \`aiongside work confirm ${loaded.metadata.id} ${check}\` after reviewing the Record.`,
      });
    }
    const byId = new Map(
      works.map((work) => [work.metadata.id, work.metadata]),
    );
    for (const dependencyId of loaded.metadata.needs) {
      const dependency = byId.get(dependencyId);
      requiredInputs.push({
        key: `needs.${dependencyId}`,
        source: "record",
        question: dependency
          ? `Dependency ${dependencyId} is ${dependency.status}. How should it be resolved before completion?`
          : `Dependency ${dependencyId} is missing. How should it be resolved before completion?`,
        code: "AIO-DEPENDENCY-BLOCKED",
        hint: "Complete the dependency, remove the relationship, or explicitly revise the work record.",
      });
    }
  }

  const missingInputs = requiredInputs.filter((input) => {
    if (input.source === "option") {
      const value = options[input.key as keyof TransitionInputValues];
      return !value?.trim();
    }
    if (input.key.startsWith("checks.")) {
      const check = input.key.slice("checks.".length) as WorkCheck;
      return !loaded.metadata.checks[check];
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
  if (legacySealMigration) {
    changes.push("Create the initial completion seal.");
  }
  if (rule.invalidatesCompletion) {
    changes.push("Invalidate the existing completion seal.");
    changes.push("Reset verification, outcome, and knowledge confirmations.");
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
): Promise<string> {
  const hash = createHash("sha256");
  const stableMetadata = {
    schema: metadata.schema,
    id: metadata.id,
    title: metadata.title,
    type: metadata.type,
    created: metadata.created,
    needs: metadata.needs,
    checks: metadata.checks,
  };
  hash.update("record-metadata\0");
  hash.update(JSON.stringify(stableMetadata));
  hash.update("\0record-body\0");
  hash.update(normalizeCompletionText(recordBody));

  const workPath = path.join(root, WORK_DIR, id);
  const recordPath = `${WORK_DIR}/${id}/${RECORD_NAME}`;
  const files = await listRelativeFiles(root, workPath);
  for (const file of files.sort()) {
    if (file === recordPath) {
      continue;
    }
    hash.update(`\0${file}\0`);
    hash.update(
      normalizeCompletionText(await readFile(path.join(root, file), "utf8")),
    );
  }
  return hash.digest("hex");
}

function normalizeCompletionText(source: string): string {
  return `${source.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

async function updateWork(
  root: string,
  id: string,
  update: (record: WorkMetadata) => WorkMetadata,
  options: { enforceState?: boolean } = {},
): Promise<WorkMetadata> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root, [
      "AIO-STATE-GATE",
      "AIO-DEPENDENCY-BLOCKED",
      "AIO-DONE-INVALIDATED",
    ]);
    const normalizedId = id.trim().toUpperCase();
    const works = await listWorks(root);
    const loaded = works.find((work) => work.metadata.id === normalizedId);
    if (!loaded) {
      throw new WorkspaceError(
        `Cannot find work item: ${normalizedId}`,
        "AIO-WORK-NOT-FOUND",
      );
    }
    const record = workMetadataSchema.parse({
      ...update(loaded.metadata),
      updated: isoToday(),
    });
    if (options.enforceState) {
      const byId = new Map(
        works.map((work) => [work.metadata.id, work.metadata]),
      );
      byId.set(record.id, record);
      const issue = validateWorkState(record, byId)[0];
      if (issue) {
        throw new WorkspaceError(
          `${issue.message}${issue.hint ? ` ${issue.hint}` : ""}`,
          issue.code,
        );
      }
    }
    const document = parseMarkdownDocument(loaded.source);
    const recordPath = path.join(root, WORK_DIR, normalizedId, RECORD_NAME);
    await atomicWrite(
      recordPath,
      formatMarkdownDocument(record, document.body),
    );
    let createdPlan = false;
    if (record.status === "active") {
      const planPath = path.join(root, WORK_DIR, normalizedId, "plan.md");
      if (!(await pathExists(planPath))) {
        const planTemplate = await readWorkspaceTemplate(root, "plan");
        await atomicWrite(
          planPath,
          createPlanDocument(planTemplate, record.title),
        );
        createdPlan = true;
      }
    }
    try {
      await writeViews(
        root,
        works.map((work) =>
          work.metadata.id === normalizedId ? record : work.metadata,
        ),
      );
      return record;
    } catch (error) {
      await atomicWrite(recordPath, loaded.source);
      if (createdPlan) {
        await rm(path.join(root, WORK_DIR, normalizedId, "plan.md"), {
          force: true,
        });
      }
      await writeViews(
        root,
        works.map((work) => work.metadata),
      );
      throw error;
    }
  });
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

async function writeDependencyMutation(
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

  const requireCheck = (check: WorkCheck, description: string): void => {
    if (!metadata.checks[check]) {
      issues.push({
        code: "AIO-STATE-GATE",
        path: workFieldPath(metadata.id, `checks.${check}`),
        message: `Status ${metadata.status} requires confirmed ${description}.`,
        hint: `Run \`aiongside work confirm ${metadata.id} ${check}\` after reviewing the Record.`,
      });
    }
  };

  if (metadata.status === "done") {
    requireCheck("scope", "scope");
    requireCheck("completion", "completion criteria");
    requireCheck("verification", "verification");
    requireCheck("outcome", "outcome");
    requireCheck("knowledge", "knowledge review");
  }

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

async function validateOverview(
  root: string,
  overviewPath: string,
  expected: WorkMetadata,
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
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const expected = renderViews(metadata);
  for (const viewPath of VIEW_PATHS) {
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
        hint: "Run `aiongside view rebuild`.",
      });
      continue;
    }
    if (canCompare && actual !== expected[viewPath]) {
      issues.push({
        code: "AIO-VIEW-DRIFT",
        path: viewPath,
        message: "Generated View does not match current Records.",
        hint: "Run `aiongside view rebuild`.",
      });
    }
  }
  return issues;
}

async function validateWorkspaceTemplates(
  root: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const name of TEMPLATE_NAMES) {
    const definition = TEMPLATE_DEFINITIONS[name];
    const templatePath = path.join(root, TEMPLATE_DIR, definition.file);
    let source: string;
    try {
      source = await readFile(templatePath, "utf8");
    } catch (error) {
      issues.push({
        code: "AIO-STRUCTURE-TEMPLATE",
        path: relative(root, templatePath),
        message: `Cannot read template: ${errorMessage(error)}`,
        hint: `Restore ${definition.file} or initialize a new workspace to copy the default.`,
      });
      continue;
    }
    for (const message of validateTemplate(name, source)) {
      issues.push({
        code: "AIO-TEMPLATE-PLACEHOLDER",
        path: relative(root, templatePath),
        message,
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
  const previous = new Map<string, string | undefined>();
  for (const name of VIEW_PATHS) {
    previous.set(name, await readOptionalFile(path.join(root, name)));
  }
  try {
    for (const name of VIEW_PATHS) {
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

async function ensureAgentEntry(
  root: string,
  name: string,
  config: WorkspaceConfig,
): Promise<void> {
  const target = path.join(root, name);
  if (!(await pathExists(target))) {
    await atomicWrite(target, createAgentEntryDocument(config));
    return;
  }
  const current = await readFile(target, "utf8");
  if (current.includes(AGENT_MARKER)) {
    return;
  }
  await atomicWrite(
    target,
    `${current.trimEnd()}\n\n## AIongside\n\nRead [.aiongside/rules.md](.aiongside/rules.md) first.\n`,
  );
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
    `Fix workspace validation first. [${issue.code}] ${issue.path}: ${issue.message}`,
    "AIO-WORKSPACE-INVALID",
  );
}

async function nextWorkNumber(root: string, prefix: string): Promise<number> {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const entries = await readdir(path.join(root, WORK_DIR), {
    withFileTypes: true,
  });
  const numbers = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => pattern.exec(entry.name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1] ?? "", 10));
  return Math.max(0, ...numbers) + 1;
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
