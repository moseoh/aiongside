import { createRequire } from "node:module";
import path from "node:path";
import {
  createSessionStartHookOutput,
  createStopHookOutput,
  parseAgentHookEvent,
} from "@aiongside/core";
import {
  addWorkDependency,
  cancelWork,
  confirmWork,
  createWork,
  discardWork,
  findWorkspaceRoot,
  initializeWorkspace,
  type MoveWorkOptions,
  type MoveWorkResult,
  moveWork,
  previewDiscard,
  previewMoveWork,
  readAgentSessionContext,
  rebuildViews,
  removeWorkDependency,
  syncAgentSkills,
  syncWorkOverview,
  validateWorkspace,
  WorkspaceError,
} from "@aiongside/filesystem";
import { Command, Option } from "commander";
import { ui } from "./ui.js";
import {
  defaultRunProcess,
  fetchLatestVersion,
  performUpdate,
  type UpdateEvent,
} from "./update.js";

const cliVersion = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

interface GlobalOptions {
  root?: string;
}

const HOOK_TRUST_NOTICE =
  "Approve project Hooks in Claude Code or Codex CLI when prompted. AIongside does not change user trust settings.";

function writeAgentSkillSyncResult(
  result: Awaited<ReturnType<typeof syncAgentSkills>>,
): void {
  if (result.changes.length === 0) {
    ui.success(`Agent integration is current (version ${result.version})`);
    ui.warning(HOOK_TRUST_NOTICE);
    return;
  }
  ui.success(`Agent integration synced (version ${result.version})`);
  ui.rows(
    result.changes.map((change) => ({
      status: change.action === "created" ? "create" : "update",
      label: change.action === "created" ? "Created" : "Updated",
      detail: change.path,
    })),
  );
  ui.warning(HOOK_TRUST_NOTICE);
}

function writeUpdateEvent(event: UpdateEvent): void {
  switch (event.type) {
    case "current":
      ui.success(`AIongside is current (${event.version})`);
      return;
    case "available":
      ui.info(
        `Update available — ${event.currentVersion} → ${event.latestVersion}`,
      );
      ui.rows([{ label: "Command", detail: event.command }]);
      return;
    case "cancelled":
      ui.info("Update cancelled — no changes made");
      return;
    case "installed":
      ui.success(`Installed AIongside ${event.version}`);
      return;
    case "complete":
      ui.success("CLI and workspace agent integration updated");
  }
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("aiongside")
    .description("A local-first workspace for people and AI")
    .version(cliVersion)
    .option("--root <path>", "AIongside workspace path");

  program
    .command("init")
    .description("Create an AIongside workspace")
    .argument("[path]", "Directory to initialize", ".")
    .option("--name <name>", "Workspace name")
    .option("--prefix <prefix>", "Work item ID prefix", "WORK")
    .action(async (target, options: { name?: string; prefix: string }) => {
      const root = path.resolve(target);
      const config = await initializeWorkspace(root, {
        ...(options.name ? { name: options.name } : {}),
        idPrefix: options.prefix,
      });
      ui.success("Workspace initialized");
      ui.rows([
        { label: "Root", detail: root },
        { label: "ID prefix", detail: config.idPrefix },
        {
          status: "create",
          label: "Agent Skills",
          detail:
            ".agents/skills/aiongside/SKILL.md · .claude/skills/aiongside/SKILL.md",
        },
        {
          status: "create",
          label: "Instructions",
          detail: ".aiongside/instructions.md",
        },
        {
          status: "create",
          label: "Hooks",
          detail: ".claude/settings.json · .codex/hooks.json",
        },
      ]);
      ui.warning(HOOK_TRUST_NOTICE);
      ui.hint(
        `Create your first work: aiongside --root ${JSON.stringify(root)} work new "First Work"`,
      );
    });

  program
    .command("update")
    .description("Update the CLI and current workspace agent integration")
    .option("--yes", "Approve the displayed global npm update")
    .action(async (options: { yes?: boolean }) => {
      const root = await commandRoot(program);
      await performUpdate(
        {
          root,
          currentVersion: cliVersion,
          ...(options.yes ? { yes: true } : {}),
        },
        {
          getLatestVersion: fetchLatestVersion,
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          confirm: () => ui.confirm("Install this update?"),
          runProcess: defaultRunProcess,
          syncCurrent: async (workspaceRoot) => {
            writeAgentSkillSyncResult(await syncAgentSkills(workspaceRoot));
          },
          report: writeUpdateEvent,
        },
      );
    });

  const skill = program
    .command("skill")
    .description("Manage the agent integration bundle");

  skill
    .command("sync")
    .description("Restore managed agent integration from the installed CLI")
    .action(async () => {
      const root = await commandRoot(program);
      const result = await syncAgentSkills(root);
      writeAgentSkillSyncResult(result);
    });

  const hook = program
    .command("hook")
    .description("Run project lifecycle Hooks for supported AI agents");

  hook
    .command("session-start")
    .description("Inject AIongside instructions into an agent session")
    .action(async () => {
      const event = parseHookInput(await readStandardInput(), "SessionStart");
      const root = await findWorkspaceRoot(path.resolve(event.cwd));
      const context = await readAgentSessionContext(root);
      writeHookOutput(createSessionStartHookOutput(context));
    });

  hook
    .command("stop")
    .description("Validate the workspace before an agent session stops")
    .action(async () => {
      const event = parseHookInput(await readStandardInput(), "Stop");
      const root = await findWorkspaceRoot(path.resolve(event.cwd));
      const issues = await validateWorkspace(root);
      writeHookOutput(
        createStopHookOutput(issues, event.stop_hook_active === true),
      );
    });

  const work = program
    .command("work")
    .description("Create work items and manage their status");

  work
    .command("new")
    .description("Create a work item in inbox")
    .argument("<title>", "Work item title")
    .action(async (title: string) => {
      const root = await commandRoot(program);
      const metadata = await createWork(root, title);
      ui.success(
        `Created ${metadata.id} — ${metadata.title} (${metadata.status})`,
      );
    });

  addTransitionOptions(
    work
      .command("move")
      .description("Move a work item to another status")
      .argument("<id>", "Work item ID")
      .argument("<status>", "Target status"),
  ).action(async (id: string, status: string, options: MoveCliOptions) => {
    const root = await commandRoot(program);
    const moveOptions = toMoveOptions(options);
    const result = options.dryRun
      ? await previewMoveWork(root, id, status.toLowerCase(), moveOptions)
      : await moveWork(root, id, status.toLowerCase(), moveOptions);
    writeMoveResult(result, options);
  });

  const needs = work
    .command("needs")
    .description("Manage work item dependencies");

  needs
    .command("add")
    .description("Add one dependency to a work item")
    .argument("<id>", "Work item ID")
    .argument("<dependency-id>", "Dependency work item ID")
    .action(async (id: string, dependencyId: string) => {
      const root = await commandRoot(program);
      const result = await addWorkDependency(root, id, dependencyId);
      ui.success(
        `Added dependency — ${result.id} needs ${result.dependencyId}`,
      );
    });

  needs
    .command("remove")
    .description("Remove one dependency from a work item")
    .argument("<id>", "Work item ID")
    .argument("<dependency-id>", "Dependency work item ID")
    .action(async (id: string, dependencyId: string) => {
      const root = await commandRoot(program);
      const result = await removeWorkDependency(root, id, dependencyId);
      if (!result.changed) {
        ui.success(
          `Dependency is already absent — ${result.id} does not need ${result.dependencyId}`,
        );
        return;
      }
      ui.success(
        `Removed dependency — ${result.id} no longer needs ${result.dependencyId}`,
      );
    });

  work
    .command("confirm")
    .description("Confirm work checks required by status gates")
    .argument("<id>", "Work item ID")
    .argument(
      "<checks...>",
      "scope, completion, verification, outcome, knowledge",
    )
    .action(async (id: string, checks: string[]) => {
      const root = await commandRoot(program);
      const metadata = await confirmWork(root, id, checks);
      ui.success(
        `Confirmed ${metadata.id} — ${checks.map((check) => check.toLowerCase()).join(", ")}`,
      );
    });

  work
    .command("sync")
    .description("Confirm Overview review against the current Record body")
    .argument("<id>", "Work item ID")
    .action(async (id: string) => {
      const root = await commandRoot(program);
      const result = await syncWorkOverview(root, id);
      if (!result.changed) {
        ui.success(`Overview is current for ${result.id} — ${result.path}`);
        return;
      }
      ui.success(`Synced ${result.id} — ${result.path}`);
    });

  addTransitionOptions(
    work
      .command("cancel")
      .description("Cancel a work item and preserve its history")
      .argument("<id>", "Work item ID"),
  ).action(async (id: string, options: MoveCliOptions) => {
    const root = await commandRoot(program);
    const moveOptions = toMoveOptions(options);
    const result = options.dryRun
      ? await previewMoveWork(root, id, "cancelled", moveOptions)
      : await cancelWork(root, id, moveOptions);
    writeMoveResult(result, options);
  });

  work
    .command("discard")
    .description("Discard a work item from the workspace")
    .argument("<id>", "Work item ID")
    .addOption(new Option("--dry-run", "Show discard effects without writing"))
    .addOption(
      new Option("--confirm <id>", "Confirm the exact ID and move it to trash"),
    )
    .action(
      async (id: string, options: { dryRun?: boolean; confirm?: string }) => {
        const root = await commandRoot(program);
        if (options.dryRun) {
          const preview = await previewDiscard(root, id);
          ui.info(`Discard preview for ${preview.id}`);
          ui.rows(
            preview.files.map((file) => ({ label: "File", detail: file })),
          );
          if (preview.referencedBy.length > 0) {
            ui.warning(`Referenced by ${preview.referencedBy.join(", ")}`);
          }
          ui.rows([{ label: "Trash target", detail: preview.trashTarget }]);
          ui.summary("No changes made");
          return;
        }
        if (!options.confirm) {
          throw new WorkspaceError(
            `Run \`aiongside work discard ${id} --dry-run\` first.`,
            "AIO-DISCARD-DRY-RUN",
          );
        }
        const trashPath = await discardWork(
          root,
          id,
          options.confirm.toUpperCase(),
        );
        ui.success(`Discarded ${id.toUpperCase()}`);
        ui.rows([{ label: "Recovery", detail: trashPath }]);
      },
    );

  const view = program.command("view").description("Manage generated Views");

  view
    .command("rebuild")
    .description("Rebuild Views from work Records")
    .action(async () => {
      const root = await commandRoot(program);
      await rebuildViews(root);
      ui.success("Views rebuilt");
    });

  program
    .command("check")
    .description("Validate workspace structure without writing")
    .action(async () => {
      const root = await commandRoot(program);
      const issues = await validateWorkspace(root);
      if (issues.length === 0) {
        ui.success("Check passed");
        return;
      }
      for (const issue of issues) {
        ui.error({
          code: issue.code,
          path: issue.path,
          message: issue.message,
          ...(issue.hint ? { hint: issue.hint } : {}),
        });
      }
      process.exitCode = 1;
    });

  return program;
}

interface MoveCliOptions {
  dryRun?: boolean;
  json?: boolean;
  reopenReason?: string;
  waitingReason?: string;
  resumeWhen?: string;
  waitingResolution?: string;
  cancellationReason?: string;
}

function addTransitionOptions(command: Command): Command {
  return command
    .option(
      "--dry-run",
      "Show transition questions and effects without writing",
    )
    .option("--json", "Print a structured transition result")
    .option(
      "--reopen-reason <text>",
      "Reason for reopening or correcting closed work",
    )
    .option("--waiting-reason <text>", "Reason the work is waiting")
    .option(
      "--resume-when <text>",
      "Condition that allows waiting work to resume",
    )
    .option("--waiting-resolution <text>", "Reason the wait ended")
    .option("--cancellation-reason <text>", "Reason the work is cancelled");
}

function toMoveOptions(options: MoveCliOptions): MoveWorkOptions {
  return {
    ...(options.reopenReason ? { reopenReason: options.reopenReason } : {}),
    ...(options.waitingReason ? { waitingReason: options.waitingReason } : {}),
    ...(options.resumeWhen ? { resumeWhen: options.resumeWhen } : {}),
    ...(options.waitingResolution
      ? { waitingResolution: options.waitingResolution }
      : {}),
    ...(options.cancellationReason
      ? { cancellationReason: options.cancellationReason }
      : {}),
  };
}

function writeMoveResult(
  result: MoveWorkResult,
  options: MoveCliOptions,
): void {
  const output = {
    id: result.id,
    from: result.from,
    to: result.to,
    requirements: result.requirements,
    requiredInputs: result.requiredInputs,
    missingInputs: result.missingInputs,
    warnings: result.warnings,
    changes: result.changes,
    invalidatesCompletion: result.invalidatesCompletion,
    canMove: result.canMove,
    applied: result.applied,
  };
  if (options.json) {
    ui.json(output, true);
    return;
  }

  const headline = `${result.id} — ${result.from} → ${result.to}`;
  if (options.dryRun) ui.info(`Move preview for ${headline}`);
  else ui.success(`Moved ${headline}`);
  if (result.missingInputs.length > 0) {
    ui.section("Questions");
    ui.rows(
      result.missingInputs.map((input) => ({
        status: "warning",
        label: input.option ?? "Required",
        detail: input.question,
      })),
    );
  }
  if (result.changes.length > 0) {
    ui.section("Changes");
    ui.rows(
      result.changes.map((change) => ({
        status: "update",
        label: "Change",
        detail: change,
      })),
    );
  }
  if (result.warnings.length > 0) {
    ui.section("Warnings");
    for (const warning of result.warnings) {
      ui.warning(warning);
    }
  }
  if (options.dryRun) {
    ui.summary("No changes made");
  }
}

export async function run(argv = process.argv): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      ui.error({ code: error.code, message: error.message });
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    ui.error({ code: "AIO-UNEXPECTED", message });
    process.exitCode = 2;
  }
}

async function commandRoot(program: Command): Promise<string> {
  const options = program.opts<GlobalOptions>();
  return findWorkspaceRoot(
    options.root ? path.resolve(options.root) : process.cwd(),
  );
}

function parseHookInput(source: string, expected: "SessionStart" | "Stop") {
  try {
    return parseAgentHookEvent(source, expected);
  } catch (error) {
    throw new WorkspaceError(
      `Invalid ${expected} Hook input: ${errorMessage(error)}`,
      "AIO-HOOK-INPUT",
    );
  }
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeHookOutput(output: Record<string, unknown>): void {
  ui.json(output);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
