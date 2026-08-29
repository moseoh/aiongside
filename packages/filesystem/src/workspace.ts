import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  createAgentEntryDocument,
  createOverviewDocument,
  createPlanDocument,
  createRecordDocument,
  createRulesDocument,
  formatMarkdownDocument,
  idNumber,
  isMovableStatus,
  overviewMetadataSchema,
  parseMarkdownDocument,
  renderViews,
  TEMPLATE_DEFINITIONS,
  TEMPLATE_NAMES,
  type TemplateName,
  type ValidationIssue,
  validateTemplate,
  type WorkMetadata,
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
): Promise<WorkMetadata> {
  if (!isMovableStatus(targetStatus)) {
    throw new WorkspaceError(
      targetStatus === "cancelled"
        ? "Use `aiongside work cancel <id>` to cancel a work item."
        : `Cannot move work item to status: ${targetStatus}`,
      "AIO-WORK-STATUS",
    );
  }
  return updateWork(root, id, (metadata) => {
    if (metadata.status === "cancelled") {
      throw new WorkspaceError(
        "Cancelled work items cannot be moved.",
        "AIO-WORK-TERMINAL",
      );
    }
    return { ...metadata, status: targetStatus };
  });
}

export async function cancelWork(
  root: string,
  id: string,
): Promise<WorkMetadata> {
  return updateWork(root, id, (metadata) => {
    if (metadata.status === "done") {
      throw new WorkspaceError(
        "Completed work items cannot be cancelled.",
        "AIO-WORK-TERMINAL",
      );
    }
    return { ...metadata, status: "cancelled" };
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
  let canCompareViews = true;
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
    if (hasOverview) {
      issues.push(...(await validateOverview(root, overviewPath, metadata)));
    }
    if (!metadata.id.startsWith(`${config.idPrefix}-`)) {
      issues.push({
        code: "AIO-IDENTITY-PREFIX",
        path: relative(root, recordPath),
        message: `ID does not start with configured prefix ${config.idPrefix}: ${metadata.id}`,
      });
    }
    if (entry.name !== metadata.id) {
      issues.push({
        code: "AIO-IDENTITY-DIRECTORY",
        path: relative(root, directoryPath),
        message: `Directory name does not match Record ID: ${entry.name} != ${metadata.id}`,
      });
    }
    if (seen.has(metadata.id)) {
      issues.push({
        code: "AIO-IDENTITY-DUPLICATE",
        path: relative(root, recordPath),
        message: `Duplicate ID: ${metadata.id}`,
      });
    }
    seen.add(metadata.id);
  }
  issues.push(...(await validateViews(root, viewMetadata, canCompareViews)));
  return issues;
}

async function updateWork(
  root: string,
  id: string,
  update: (record: WorkMetadata) => WorkMetadata,
): Promise<WorkMetadata> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
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

async function assertMutationSafe(root: string): Promise<void> {
  const blocking = (await validateWorkspace(root)).filter(
    (issue) =>
      issue.code !== "AIO-STRUCTURE-VIEW" && issue.code !== "AIO-VIEW-DRIFT",
  );
  const first = blocking[0];
  if (first) {
    throw new WorkspaceError(
      `Fix workspace validation first. [${first.code}] ${first.path}: ${first.message}`,
      "AIO-WORKSPACE-INVALID",
    );
  }
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
