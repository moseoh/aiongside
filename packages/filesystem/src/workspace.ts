import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  briefMetadataSchema,
  createAgentEntryDocument,
  createBriefDocument,
  createPlanDocument,
  createRecordDocument,
  createRulesDocument,
  formatMarkdownDocument,
  idNumber,
  isMovableStatus,
  parseMarkdownDocument,
  renderViews,
  TEMPLATE_DEFINITIONS,
  TEMPLATE_NAMES,
  type TemplateName,
  type ValidationIssue,
  validateTemplate,
  type WorkRecord,
  type WorkspaceConfig,
  workRecordSchema,
  workspaceConfigSchema,
} from "@aiongside/core";
import * as lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { WorkspaceError } from "./errors.js";

const CONFIG_PATH = path.join(".aiongside", "config.yaml");
const WORK_DIR = "work";
const BRIEF_NAME = "brief.md";
const RECORD_NAME = "record.md";
const AGENT_MARKER = ".aiongside/rules.md";
const TEMPLATE_DIR = path.join(".aiongside", "templates");

export interface LoadedWork {
  directory: string;
  record: WorkRecord;
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
      const result = workRecordSchema.safeParse(document.metadata);
      if (result.success) {
        works.push({ directory: entry.name, record: result.data, source });
      }
    } catch {
      // Full validation reports these errors. Listing returns readable Work only.
    }
  }
  return works.sort(
    (left, right) => idNumber(left.record.id) - idNumber(right.record.id),
  );
}

export async function createWork(
  root: string,
  title: string,
): Promise<WorkRecord> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const config = await loadConfig(root);
    const works = await listWorks(root);
    const next = await nextWorkNumber(root, config.idPrefix);
    const id = `${config.idPrefix}-${String(next).padStart(3, "0")}`;
    const cleanTitle = title.trim();
    if (!cleanTitle || /[\r\n]/.test(cleanTitle)) {
      throw new WorkspaceError(
        "Work title must be a non-empty single line.",
        "AIO-WORK-TITLE",
      );
    }
    const today = isoToday();
    const record = workRecordSchema.parse({
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
    const [recordTemplate, briefTemplate] = await Promise.all([
      readWorkspaceTemplate(root, "record"),
      readWorkspaceTemplate(root, "brief"),
    ]);
    await mkdir(staging, { recursive: true });
    let moved = false;
    try {
      await Promise.all([
        atomicWrite(
          path.join(staging, RECORD_NAME),
          createRecordDocument(record, recordTemplate),
        ),
        atomicWrite(
          path.join(staging, BRIEF_NAME),
          createBriefDocument(record, briefTemplate),
        ),
        ...["decisions", "evidence", "references", "deliverables", "tools"].map(
          (name) => mkdir(path.join(staging, name), { recursive: true }),
        ),
      ]);
      await rename(staging, destination);
      moved = true;
      await writeViews(root, [...works.map((work) => work.record), record]);
      return record;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (moved) {
        await rm(destination, { recursive: true, force: true });
        await writeViews(
          root,
          works.map((work) => work.record),
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
): Promise<WorkRecord> {
  if (!isMovableStatus(targetStatus)) {
    throw new WorkspaceError(
      targetStatus === "cancelled"
        ? "Use `aiongside work cancel <id>` to cancel Work."
        : `Cannot move Work to status: ${targetStatus}`,
      "AIO-WORK-STATUS",
    );
  }
  return updateWork(root, id, (record) => {
    if (record.status === "cancelled") {
      throw new WorkspaceError(
        "Cancelled Work cannot be moved.",
        "AIO-WORK-TERMINAL",
      );
    }
    return { ...record, status: targetStatus };
  });
}

export async function cancelWork(
  root: string,
  id: string,
): Promise<WorkRecord> {
  return updateWork(root, id, (record) => {
    if (record.status === "done") {
      throw new WorkspaceError(
        "Completed Work cannot be cancelled.",
        "AIO-WORK-TERMINAL",
      );
    }
    return { ...record, status: "cancelled" };
  });
}

export async function previewDiscard(
  root: string,
  id: string,
): Promise<DiscardPreview> {
  const normalizedId = id.trim().toUpperCase();
  const works = await listWorks(root);
  const target = works.find((work) => work.record.id === normalizedId);
  if (!target) {
    throw new WorkspaceError(
      `Cannot find Work: ${normalizedId}`,
      "AIO-WORK-NOT-FOUND",
    );
  }
  const referencedBy = works
    .filter((work) => work.record.needs.includes(normalizedId))
    .map((work) => work.record.id);
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
        `Cannot discard Work because it is referenced by: ${preview.referencedBy.join(", ")}`,
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
      const remaining = (await listWorks(root)).map((work) => work.record);
      await writeViews(root, remaining);
    } catch (error) {
      await rename(target, source);
      throw error;
    }
    return relative(root, target);
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
  for (const view of ["views/open.md", "views/closed.md"]) {
    if (!(await pathExists(path.join(root, view)))) {
      issues.push({
        code: "AIO-STRUCTURE-VIEW",
        path: view,
        message: "Missing default View.",
        hint: "Run a Work mutation command to regenerate Views.",
      });
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      issues.push({
        code: "AIO-STRUCTURE-WORK-ENTRY",
        path: relative(root, path.join(workRoot, entry.name)),
        message: "Only Work directories are allowed directly under work.",
      });
      continue;
    }
    const directoryPath = path.join(workRoot, entry.name);
    const recordPath = path.join(directoryPath, RECORD_NAME);
    const briefPath = path.join(directoryPath, BRIEF_NAME);
    const hasBrief = await pathExists(briefPath);
    if (!hasBrief) {
      issues.push({
        code: "AIO-STRUCTURE-BRIEF",
        path: relative(root, briefPath),
        message: "Missing human-readable brief.md.",
      });
    }

    let document: ReturnType<typeof parseMarkdownDocument>;
    try {
      document = parseMarkdownDocument(await readFile(recordPath, "utf8"));
    } catch (error) {
      issues.push({
        code: "AIO-STRUCTURE-RECORD",
        path: relative(root, recordPath),
        message: errorMessage(error),
      });
      continue;
    }
    const result = workRecordSchema.safeParse(document.metadata);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          code: "AIO-SCHEMA-RECORD",
          path: `${relative(root, recordPath)}#${issue.path.join(".")}`,
          message: issue.message,
        });
      }
      continue;
    }
    const record = result.data;
    if (hasBrief) {
      issues.push(...(await validateBrief(root, briefPath, record)));
    }
    if (!record.id.startsWith(`${config.idPrefix}-`)) {
      issues.push({
        code: "AIO-IDENTITY-PREFIX",
        path: relative(root, recordPath),
        message: `ID does not start with configured prefix ${config.idPrefix}: ${record.id}`,
      });
    }
    if (entry.name !== record.id) {
      issues.push({
        code: "AIO-IDENTITY-DIRECTORY",
        path: relative(root, directoryPath),
        message: `Directory name does not match Record ID: ${entry.name} != ${record.id}`,
      });
    }
    if (seen.has(record.id)) {
      issues.push({
        code: "AIO-IDENTITY-DUPLICATE",
        path: relative(root, recordPath),
        message: `Duplicate ID: ${record.id}`,
      });
    }
    seen.add(record.id);
  }
  return issues;
}

async function updateWork(
  root: string,
  id: string,
  update: (record: WorkRecord) => WorkRecord,
): Promise<WorkRecord> {
  return withWorkspaceLock(root, async () => {
    await assertMutationSafe(root);
    const normalizedId = id.trim().toUpperCase();
    const works = await listWorks(root);
    const loaded = works.find((work) => work.record.id === normalizedId);
    if (!loaded) {
      throw new WorkspaceError(
        `Cannot find Work: ${normalizedId}`,
        "AIO-WORK-NOT-FOUND",
      );
    }
    const record = workRecordSchema.parse({
      ...update(loaded.record),
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
          work.record.id === normalizedId ? record : work.record,
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
        works.map((work) => work.record),
      );
      throw error;
    }
  });
}

async function validateBrief(
  root: string,
  briefPath: string,
  expected: WorkRecord,
): Promise<ValidationIssue[]> {
  try {
    const document = parseMarkdownDocument(await readFile(briefPath, "utf8"));
    const result = briefMetadataSchema.safeParse(document.metadata);
    if (!result.success) {
      return result.error.issues.map((issue) => ({
        code: "AIO-SCHEMA-BRIEF",
        path: `${relative(root, briefPath)}#${issue.path.join(".")}`,
        message: issue.message,
      }));
    }
    const issues: ValidationIssue[] = [];
    if (result.data.id !== expected.id) {
      issues.push({
        code: "AIO-IDENTITY-BRIEF",
        path: relative(root, briefPath),
        message: `Brief ID does not match Record ID: ${result.data.id} != ${expected.id}`,
      });
    }
    if (result.data.title !== expected.title) {
      issues.push({
        code: "AIO-IDENTITY-BRIEF-TITLE",
        path: relative(root, briefPath),
        message: `Brief title does not match Record title: ${result.data.title} != ${expected.title}`,
      });
    }
    return issues;
  } catch (error) {
    return [
      {
        code: "AIO-STRUCTURE-BRIEF",
        path: relative(root, briefPath),
        message: errorMessage(error),
      },
    ];
  }
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

async function writeViews(root: string, records: WorkRecord[]): Promise<void> {
  const views = renderViews(records);
  for (const [name, contents] of Object.entries(views)) {
    await atomicWrite(path.join(root, name), contents);
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
    (issue) => issue.code !== "AIO-STRUCTURE-VIEW",
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
