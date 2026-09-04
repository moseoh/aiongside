import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_AGENT_SKILL_VERSION,
  calculateMarkdownBodyDigest,
  compareWorkIds,
  createOverviewDocument,
  createPlanDocument,
  createRecordDocument,
  createRulesDocument,
  evaluateTransition,
  formatMarkdownDocument,
  isExactAgentSkillSource,
  isMovableStatus,
  isWorkCheck,
  type KnowledgeEntry,
  KnowledgeRegistryFormatError,
  knowledgeEntriesByKey,
  overviewMetadataSchema,
  parseAgentSkill,
  parseKnowledgeRegistry,
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
  validateKnowledgeRegistryEntries,
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
import {
  AGENT_HOOK_PATHS,
  AGENT_INSTRUCTIONS_PATH,
  agentHookSettingsAreCurrent,
  mergeAgentHookSettings,
} from "./agent-integration.js";
import { WorkspaceError } from "./errors.js";

const CONFIG_PATH = path.join(".aiongside", "config.yaml");
const WORK_DIR = "work";
const OVERVIEW_NAME = "overview.md";
const RECORD_NAME = "record.md";
const TEMPLATE_DIR = path.join(".aiongside", "templates");
const AGENT_SKILL_PATHS = [
  path.join(".agents", "skills", "aiongside", "SKILL.md"),
  path.join(".claude", "skills", "aiongside", "SKILL.md"),
] as const;
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
  knowledgeReview?: KnowledgeReview;
}

export interface KnowledgeReviewTarget {
  key: string;
  path: string;
  overview: string;
}

export interface KnowledgeReview {
  confirmed: boolean;
  targets: KnowledgeReviewTarget[];
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

export interface SyncOverviewResult {
  id: string;
  changed: boolean;
  path: string;
}

export interface AgentSkillChange {
  path: string;
  action: "created" | "updated";
}

export interface AgentSkillSyncResult {
  version: number;
  changes: AgentSkillChange[];
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

  const agentSkillSource = await loadAgentSkillSource();
  const agentSkill = requireCurrentAgentSkill(agentSkillSource);
  const agentInstructionsSource = await loadAgentInstructionsSource();
  const skillPlan = await planAgentSkillTargets(root, agentSkillSource);
  const instructionsPlan = await planAgentInstructionsTarget(
    root,
    agentInstructionsSource,
    false,
  );
  const hookPlan = await planAgentHookTargets(root);
  const integrationPlan = [...skillPlan, instructionsPlan, ...hookPlan];

  const config = workspaceConfigSchema.parse({
    schema: 1,
    name: options.name?.trim() || path.basename(root),
    idPrefix: options.idPrefix?.trim().toUpperCase() || "WORK",
    agentSkillVersion: agentSkill.version,
  });

  await mkdir(path.join(root, ".aiongside", "trash"), { recursive: true });
  await mkdir(path.join(root, TEMPLATE_DIR), { recursive: true });
  await mkdir(path.join(root, WORK_DIR), { recursive: true });
  await mkdir(path.join(root, "views"), { recursive: true });
  await mkdir(path.join(root, "knowledge"), { recursive: true });
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
    "# Knowledge registry\n\n| Key | Path | Parent | Display name |\n| --- | --- | --- | --- |\n",
  );
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

export async function loadAgentSkillSource(): Promise<string> {
  const candidates = [
    new URL("../skills/aiongside/SKILL.md", import.meta.url),
    new URL("../../../skills/aiongside/SKILL.md", import.meta.url),
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
    "Cannot read the Agent Skill included with this CLI.",
    "AIO-SKILL-FORMAT",
  );
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

export async function readAgentSessionContext(root: string): Promise<string> {
  const sections = [
    {
      heading: "AIongside managed instructions",
      relativePath: AGENT_INSTRUCTIONS_PATH,
      recovery: "Run `aiongside skill sync` to restore this managed file.",
    },
    {
      heading: "Workspace rules",
      relativePath: path.join(".aiongside", "rules.md"),
      recovery: "Restore this user-owned file or add workspace rules manually.",
    },
  ];
  const output: string[] = [];
  for (const section of sections) {
    output.push(`# ${section.heading}`);
    const target = path.join(root, section.relativePath);
    try {
      output.push((await readFile(target, "utf8")).trimEnd());
    } catch (error) {
      output.push(
        `Cannot read ${relative(root, target)}: ${errorMessage(error)}\n${section.recovery}`,
      );
    }
  }
  return `${output.join("\n\n")}\n`;
}

export async function syncAgentSkills(
  root: string,
): Promise<AgentSkillSyncResult> {
  return withWorkspaceLock(root, async () => {
    const source = await loadAgentSkillSource();
    const skill = requireCurrentAgentSkill(source);
    const instructionsSource = await loadAgentInstructionsSource();
    const config = await loadConfig(root);
    if (
      config.agentSkillVersion !== undefined &&
      config.agentSkillVersion > skill.version
    ) {
      throw new WorkspaceError(
        `Workspace Agent Skill version ${config.agentSkillVersion} is newer than this CLI supports (${skill.version}). Update the CLI before syncing.`,
        "AIO-SKILL-VERSION",
      );
    }

    const skillPlan = await planAgentSkillTargets(root, source);
    const instructionsPlan = await planAgentInstructionsTarget(
      root,
      instructionsSource,
      config.agentSkillVersion !== undefined,
    );
    const hookPlan = await planAgentHookTargets(root);
    const plan = [...skillPlan, instructionsPlan, ...hookPlan];
    const configPath = path.join(root, CONFIG_PATH);
    const previousConfig = await readFile(configPath, "utf8");
    const nextConfig = workspaceConfigSchema.parse({
      ...config,
      agentSkillVersion: skill.version,
    });
    const writeConfig = config.agentSkillVersion !== skill.version;
    await applyAgentIntegrationState(
      root,
      plan,
      previousConfig,
      stringifyYaml(nextConfig, { lineWidth: 0 }),
      writeConfig,
    );

    const changes: AgentSkillChange[] = plan
      .filter((target) => target.write)
      .map((target) => ({
        path: relative(root, target.target),
        action: target.previous === undefined ? "created" : "updated",
      }));
    if (writeConfig) {
      changes.push({ path: CONFIG_PATH, action: "updated" });
    }
    return { version: skill.version, changes };
  });
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
    const recordSource = createRecordDocument(metadata, recordTemplate);
    const recordBodyDigest = calculateMarkdownBodyDigest(recordSource);
    await mkdir(staging, { recursive: true });
    let moved = false;
    try {
      await Promise.all([
        atomicWrite(path.join(staging, RECORD_NAME), recordSource),
        atomicWrite(
          path.join(staging, OVERVIEW_NAME),
          createOverviewDocument(metadata, recordBodyDigest, overviewTemplate),
        ),
        ...SUPPORTING_CONTENT_DIRECTORIES.map(({ name }) =>
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
      context.knowledgeEntries,
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
  return buildMoveResult(
    context.works,
    context.loaded,
    context.knowledgeEntries,
    targetStatus,
    options,
  );
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

export async function syncWorkOverview(
  root: string,
  id: string,
): Promise<SyncOverviewResult> {
  return withWorkspaceLock(root, async () => {
    const normalizedId = id.trim().toUpperCase();
    await assertMutationSafe(
      root,
      ["AIO-OVERVIEW-STALE"],
      (issue) =>
        issue.code === "AIO-DONE-INVALIDATED" &&
        issueTouchesWork(issue, normalizedId),
    );
    const loaded = requireWork(await listWorks(root), normalizedId);
    const overviewPath = path.join(root, WORK_DIR, normalizedId, OVERVIEW_NAME);
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
    const recordBodyDigest = calculateMarkdownBodyDigest(loaded.source);
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
        ...overview,
        recordBodyDigest,
      }),
    );
    return result;
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
      checks: { ...loaded.metadata.checks, knowledge: false },
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
      checks: { ...loaded.metadata.checks, knowledge: false },
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
  if (config.agentSkillVersion !== undefined) {
    issues.push(...(await validateManagedAgentSkills(root, config)));
  }
  const knowledge = await validateKnowledgeStructure(root);
  issues.push(...knowledge.issues);

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
    issues.push(
      ...(await validateWorkSupportingStructure(root, directoryPath)),
    );
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
        { includeKnowledge: hasOwnField(document.metadata, "knowledge") },
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

function buildMoveResult(
  works: LoadedWork[],
  loaded: LoadedWork,
  knowledgeEntries: KnowledgeEntry[],
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
    const knowledgeQuestion =
      loaded.metadata.knowledge.length === 0
        ? "Has it been confirmed that this work has no lasting Knowledge impact?"
        : "Have the linked Knowledge topics been reviewed and updated where needed?";
    const checkQuestions: Record<WorkCheck, string> = {
      scope: "Has the current work scope been reviewed?",
      completion: "Have the completion criteria been met?",
      verification: "What verification was performed and what was observed?",
      outcome: "Has the outcome been recorded?",
      knowledge: knowledgeQuestion,
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

  const knowledgeReview =
    (rule.requirements.includes("D") || legacySealMigration) &&
    !(rule.noOp && !legacySealMigration)
      ? resolveKnowledgeReview(loaded.metadata, knowledgeEntries)
      : undefined;

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
    ...(knowledgeReview ? { knowledgeReview } : {}),
  };
}

function resolveKnowledgeReview(
  metadata: WorkMetadata,
  entries: KnowledgeEntry[],
): KnowledgeReview {
  const byKey = knowledgeEntriesByKey(entries);
  const targets = metadata.knowledge.map((key) => {
    const entry = byKey.get(key);
    if (!entry) {
      throw new WorkspaceError(
        `Knowledge key does not exist: ${key}`,
        "AIO-WORK-KNOWLEDGE-MISSING",
      );
    }
    return {
      key,
      path: entry.path,
      overview: `knowledge/${entry.path}/${OVERVIEW_NAME}`,
    };
  });
  return { confirmed: metadata.checks.knowledge, targets };
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
  options: { includeKnowledge?: boolean } = { includeKnowledge: true },
): Promise<string> {
  const hash = createHash("sha256");
  const stableMetadata = {
    schema: metadata.schema,
    id: metadata.id,
    title: metadata.title,
    type: metadata.type,
    created: metadata.created,
    needs: metadata.needs,
    ...(options.includeKnowledge === false
      ? {}
      : { knowledge: metadata.knowledge }),
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
    if (isSupportingContentFile(file, id)) {
      hash.update(await readFile(path.join(root, file)));
    } else {
      hash.update(
        normalizeCompletionText(await readFile(path.join(root, file), "utf8")),
      );
    }
  }
  return hash.digest("hex");
}

function hasOwnField(value: unknown, field: string): boolean {
  return (
    typeof value === "object" && value !== null && Object.hasOwn(value, field)
  );
}

function isSupportingContentFile(file: string, id: string): boolean {
  return SUPPORTING_CONTENT_DIRECTORIES.some(({ name }) =>
    file.startsWith(`${WORK_DIR}/${id}/${name}/`),
  );
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

function assertKnowledgeMutable(metadata: WorkMetadata): void {
  if (metadata.status === "done") {
    throw new WorkspaceError(
      `Reopen ${metadata.id} before changing Knowledge relationships.`,
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

async function loadKnowledgeEntries(root: string): Promise<KnowledgeEntry[]> {
  const registryPath = path.join(root, "knowledge", "registry.md");
  let entries: KnowledgeEntry[];
  try {
    entries = parseKnowledgeRegistry(
      await readFile(registryPath, "utf8"),
    ).entries;
  } catch (error) {
    throw new WorkspaceError(
      `Cannot read Knowledge Registry: ${errorMessage(error)}`,
      "AIO-STRUCTURE-KNOWLEDGE-REGISTRY",
    );
  }
  const problem = validateKnowledgeRegistryEntries(entries)[0];
  if (problem) {
    throw new WorkspaceError(problem.message, problem.code);
  }
  return entries;
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

interface KnowledgeValidationResult {
  issues: ValidationIssue[];
  entries?: KnowledgeEntry[];
}

async function validateKnowledgeStructure(
  root: string,
): Promise<KnowledgeValidationResult> {
  const knowledgePath = path.join(root, "knowledge");
  let knowledgeStat: Awaited<ReturnType<typeof stat>>;
  try {
    knowledgeStat = await stat(knowledgePath);
  } catch (error) {
    return {
      issues: [
        {
          code: "AIO-STRUCTURE-KNOWLEDGE",
          path: relative(root, knowledgePath),
          message: `Cannot read required knowledge directory: ${errorMessage(error)}`,
          hint: "Restore the knowledge directory.",
        },
      ],
    };
  }
  if (!knowledgeStat.isDirectory()) {
    return {
      issues: [
        {
          code: "AIO-STRUCTURE-KNOWLEDGE",
          path: relative(root, knowledgePath),
          message: "Required knowledge path is not a directory.",
          hint: "Replace it with a knowledge directory.",
        },
      ],
    };
  }

  const registryPath = path.join(knowledgePath, "registry.md");
  try {
    const registryStat = await stat(registryPath);
    if (!registryStat.isFile()) {
      return {
        issues: [
          {
            code: "AIO-STRUCTURE-KNOWLEDGE-REGISTRY",
            path: relative(root, registryPath),
            message: "Knowledge Registry is not a regular file.",
            hint: "Restore knowledge/registry.md as a regular file.",
          },
        ],
      };
    }
    const source = await readFile(registryPath, "utf8");
    const registry = parseKnowledgeRegistry(source);
    const issues: ValidationIssue[] = validateKnowledgeRegistryEntries(
      registry.entries,
    ).map((problem) => ({
      code: problem.code,
      path: `${relative(root, registryPath)}#line-${problem.line}.${problem.field}`,
      message: problem.message,
      hint: "Fix the managed table in knowledge/registry.md.",
    }));
    const validPaths = new Set(
      registry.entries
        .filter(
          (entry) =>
            !issues.some(
              (issue) =>
                issue.path.includes(`#line-${entry.line}.`) &&
                (issue.code === "AIO-KNOWLEDGE-PATH" ||
                  issue.code === "AIO-KNOWLEDGE-KEY"),
            ),
        )
        .map((entry) => entry.path),
    );
    for (const entry of registry.entries) {
      if (!validPaths.has(entry.path)) {
        continue;
      }
      issues.push(...(await validateKnowledgeEntrypoint(root, entry)));
    }
    return { issues, entries: registry.entries };
  } catch (error) {
    return {
      issues: [
        {
          code: "AIO-STRUCTURE-KNOWLEDGE-REGISTRY",
          path: relative(root, registryPath),
          message:
            error instanceof KnowledgeRegistryFormatError
              ? error.message
              : `Cannot read Knowledge Registry: ${errorMessage(error)}`,
          hint: "Restore a readable Registry with Key, Path, Parent, and Display name columns.",
        },
      ],
    };
  }
}

async function validateKnowledgeEntrypoint(
  root: string,
  entry: KnowledgeEntry,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const knowledgeRoot = path.join(root, "knowledge");
  let current = knowledgeRoot;
  for (const segment of entry.path.split("/")) {
    current = path.join(current, segment);
    try {
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink()) {
        issues.push({
          code: "AIO-KNOWLEDGE-PATH",
          path: relative(root, current),
          message: `Registered Knowledge path uses a symbolic link: ${entry.path}`,
          hint: "Use regular directories inside knowledge/.",
        });
        return issues;
      }
      if (!currentStat.isDirectory()) {
        issues.push({
          code: "AIO-KNOWLEDGE-ENTRYPOINT",
          path: relative(root, current),
          message: `Registered Knowledge path is not a directory: ${entry.path}`,
          hint: `Create knowledge/${entry.path}/overview.md as a regular file.`,
        });
        return issues;
      }
    } catch (error) {
      issues.push({
        code: "AIO-KNOWLEDGE-ENTRYPOINT",
        path: relative(root, current),
        message: `Cannot read registered Knowledge path ${entry.path}: ${errorMessage(error)}`,
        hint: `Create knowledge/${entry.path}/overview.md as a regular file.`,
      });
      return issues;
    }
  }

  const overviewPath = path.join(current, OVERVIEW_NAME);
  try {
    const overviewStat = await lstat(overviewPath);
    if (!overviewStat.isFile() || overviewStat.isSymbolicLink()) {
      throw new Error("Knowledge Overview is not a regular file.");
    }
  } catch (error) {
    issues.push({
      code: "AIO-KNOWLEDGE-ENTRYPOINT",
      path: relative(root, overviewPath),
      message: `Cannot read Knowledge Overview for ${entry.key}: ${errorMessage(error)}`,
      hint: `Create knowledge/${entry.path}/overview.md as a regular file.`,
    });
  }
  return issues;
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
          hint: "Register the key or remove the Work relationship.",
        });
      }
    }
  }
  return issues;
}

async function validateWorkSupportingStructure(
  root: string,
  workPath: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const definition of SUPPORTING_CONTENT_DIRECTORIES) {
    const target = path.join(workPath, definition.name);
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
            ? "Overview has not been reviewed against the current Record body."
            : "Overview was reviewed against a different Record body.",
        hint: `Review the Record and Overview, then run \`aiongside work sync ${expected.id}\`.`,
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

function requireCurrentAgentSkill(source: string) {
  let skill: ReturnType<typeof parseAgentSkill>;
  try {
    skill = parseAgentSkill(source);
  } catch (error) {
    throw new WorkspaceError(
      `Invalid bundled Agent Skill: ${errorMessage(error)}`,
      "AIO-SKILL-FORMAT",
    );
  }
  if (skill.version !== CURRENT_AGENT_SKILL_VERSION) {
    throw new WorkspaceError(
      `Bundled Agent Skill version ${skill.version} does not match the CLI contract ${CURRENT_AGENT_SKILL_VERSION}.`,
      "AIO-SKILL-FORMAT",
    );
  }
  return skill;
}

async function planAgentSkillTargets(
  root: string,
  expectedSource: string,
): Promise<ManagedFilePlan[]> {
  const expected = requireCurrentAgentSkill(expectedSource);
  const result: ManagedFilePlan[] = [];
  for (const relativePath of AGENT_SKILL_PATHS) {
    await assertSafeManagedParents(root, relativePath, agentSkillConflict);
    const target = path.join(root, relativePath);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        result.push({
          relativePath,
          target,
          previous: undefined,
          next: expectedSource,
          write: true,
        });
        continue;
      }
      throw error;
    }
    if (!metadata.isFile()) {
      throw agentSkillConflict(root, target);
    }

    const previous = await readFile(target, "utf8");
    if (isExactAgentSkillSource(previous, expectedSource)) {
      result.push({
        relativePath,
        target,
        previous,
        next: expectedSource,
        write: false,
      });
      continue;
    }
    let installed: ReturnType<typeof parseAgentSkill>;
    try {
      installed = parseAgentSkill(previous);
    } catch {
      throw agentSkillConflict(root, target);
    }
    if (installed.version > expected.version) {
      throw new WorkspaceError(
        `${relative(root, target)} uses Agent Skill version ${installed.version}, newer than this CLI supports (${expected.version}). Update the CLI before syncing.`,
        "AIO-SKILL-VERSION",
      );
    }
    result.push({
      relativePath,
      target,
      previous,
      next: expectedSource,
      write: true,
    });
  }
  return result;
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
      next = mergeAgentHookSettings(previous);
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

function agentSkillConflict(root: string, target: string): WorkspaceError {
  return new WorkspaceError(
    `Cannot manage ${relative(root, target)} because it is not an AIongside-managed Agent Skill. Move it to a different name and run the command again.`,
    "AIO-SKILL-CONFLICT",
  );
}

function instructionsConflict(root: string, target: string): WorkspaceError {
  return new WorkspaceError(
    `Cannot manage ${relative(root, target)} because it contains user-owned content. Move custom instructions to .aiongside/rules.md and run the command again.`,
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

async function validateManagedAgentSkills(
  root: string,
  config: WorkspaceConfig,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  let expectedSource: string;
  let expectedInstructions: string;
  let expected: ReturnType<typeof parseAgentSkill>;
  try {
    expectedSource = await loadAgentSkillSource();
    expectedInstructions = await loadAgentInstructionsSource();
    expected = requireCurrentAgentSkill(expectedSource);
  } catch (error) {
    return [
      {
        code:
          error instanceof WorkspaceError
            ? error.code
            : "AIO-INSTRUCTIONS-FORMAT",
        path:
          error instanceof WorkspaceError &&
          error.code === "AIO-INSTRUCTIONS-FORMAT"
            ? "instructions/aiongside.md"
            : "skills/aiongside/SKILL.md",
        message: errorMessage(error),
        hint: "Reinstall the AIongside CLI package.",
      },
    ];
  }

  if (config.agentSkillVersion !== expected.version) {
    issues.push({
      code: "AIO-SKILL-OUTDATED",
      path: `${CONFIG_PATH}#agentSkillVersion`,
      message: `Configured Agent Skill version ${config.agentSkillVersion} does not match CLI version ${expected.version}.`,
      hint: "Run `aiongside skill sync`.",
    });
  }

  for (const relativePath of AGENT_SKILL_PATHS) {
    const target = path.join(root, relativePath);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        issues.push({
          code: "AIO-SKILL-MISSING",
          path: relative(root, target),
          message: "Managed Agent Skill is missing.",
          hint: "Run `aiongside skill sync`.",
        });
        continue;
      }
      throw error;
    }
    if (!metadata.isFile()) {
      issues.push({
        code: "AIO-SKILL-MISSING",
        path: relative(root, target),
        message: "Managed Agent Skill must be a regular file.",
        hint: "Move the conflicting entry and run `aiongside skill sync`.",
      });
      continue;
    }

    let source: string;
    try {
      source = await readFile(target, "utf8");
    } catch (error) {
      issues.push({
        code: "AIO-SKILL-FORMAT",
        path: relative(root, target),
        message: `Cannot read managed Agent Skill: ${errorMessage(error)}`,
        hint: "Fix file access and run `aiongside skill sync`.",
      });
      continue;
    }
    let installed: ReturnType<typeof parseAgentSkill>;
    try {
      installed = parseAgentSkill(source);
    } catch (error) {
      issues.push({
        code: "AIO-SKILL-FORMAT",
        path: relative(root, target),
        message: errorMessage(error),
        hint: "Move the conflicting file and run `aiongside skill sync`.",
      });
      continue;
    }
    if (
      installed.version !== expected.version ||
      installed.version !== config.agentSkillVersion
    ) {
      issues.push({
        code: "AIO-SKILL-OUTDATED",
        path: relative(root, target),
        message: `Managed Agent Skill version ${installed.version} does not match the configured CLI contract.`,
        hint: "Run `aiongside skill sync`.",
      });
      continue;
    }
    if (!isExactAgentSkillSource(source, expectedSource)) {
      issues.push({
        code: "AIO-SKILL-DRIFT",
        path: relative(root, target),
        message: "Managed Agent Skill differs from the CLI source.",
        hint: "Move custom instructions to .aiongside/rules.md and run `aiongside skill sync`.",
      });
    }
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
      hint: "Run `aiongside skill sync`.",
    });
  } else {
    const instructions = await readFile(instructionsPath, "utf8");
    if (instructions !== expectedInstructions) {
      issues.push({
        code: "AIO-INSTRUCTIONS-DRIFT",
        path: AGENT_INSTRUCTIONS_PATH,
        message: "Managed AIongside instructions differ from the CLI source.",
        hint: "Move custom instructions to .aiongside/rules.md and run `aiongside skill sync`.",
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
        hint: "Run `aiongside skill sync`.",
      });
      continue;
    }
    const hookSource = await readFile(target, "utf8");
    if (!agentHookSettingsAreCurrent(hookSource)) {
      issues.push({
        code: "AIO-HOOK-DRIFT",
        path: relativePath,
        message: "Managed AIongside Hooks are missing, invalid, or outdated.",
        hint: "Fix conflicting Hook settings and run `aiongside skill sync`.",
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
