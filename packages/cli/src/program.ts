import path from "node:path";
import {
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
  rebuildViews,
  validateWorkspace,
  WorkspaceError,
} from "@aiongside/filesystem";
import { Command, Option } from "commander";

interface GlobalOptions {
  root?: string;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("aiongside")
    .description("A local-first workspace for people and AI")
    .version("0.0.0")
    .option("--root <path>", "AIongside workspace path");

  program
    .command("init")
    .description("Create an AIongside workspace")
    .argument("[path]", "Directory to initialize", ".")
    .option("--name <name>", "Workspace name")
    .option("--prefix <prefix>", "Work item ID prefix", "AIO")
    .action(async (target, options: { name?: string; prefix: string }) => {
      const root = path.resolve(target);
      const config = await initializeWorkspace(root, {
        ...(options.name ? { name: options.name } : {}),
        idPrefix: options.prefix,
      });
      process.stdout.write(
        `Initialized: ${root}\nID prefix: ${config.idPrefix}\n`,
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
      process.stdout.write(
        `Created: ${metadata.id} ${metadata.title}\nStatus: ${metadata.status}\n`,
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
      process.stdout.write(
        `Confirmed: ${metadata.id} ${checks.map((check) => check.toLowerCase()).join(", ")}\n`,
      );
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
          process.stdout.write(`Discard preview: ${preview.id}\n`);
          for (const file of preview.files) {
            process.stdout.write(`- ${file}\n`);
          }
          if (preview.referencedBy.length > 0) {
            process.stdout.write(
              `Referenced by: ${preview.referencedBy.join(", ")}\n`,
            );
          }
          process.stdout.write(
            `Trash target: ${preview.trashTarget}\nNo changes made.\n`,
          );
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
        process.stdout.write(
          `Discarded: ${id.toUpperCase()}\nRecovery location: ${trashPath}\n`,
        );
      },
    );

  const view = program.command("view").description("Manage generated Views");

  view
    .command("rebuild")
    .description("Rebuild Views from work Records")
    .action(async () => {
      const root = await commandRoot(program);
      await rebuildViews(root);
      process.stdout.write("Views rebuilt\n");
    });

  program
    .command("check")
    .description("Validate workspace structure without writing")
    .action(async () => {
      const root = await commandRoot(program);
      const issues = await validateWorkspace(root);
      if (issues.length === 0) {
        process.stdout.write("Check passed\n");
        return;
      }
      for (const issue of issues) {
        process.stderr.write(
          `[${issue.code}] ${issue.path}: ${issue.message}\n`,
        );
        if (issue.hint) {
          process.stderr.write(`  Fix: ${issue.hint}\n`);
        }
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
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${options.dryRun ? "Move preview" : "Moved"}: ${result.id} ${result.from} -> ${result.to}\n`,
  );
  if (result.missingInputs.length > 0) {
    process.stdout.write("Questions:\n");
    for (const input of result.missingInputs) {
      const option = input.option ? `${input.option}: ` : "";
      process.stdout.write(`- ${option}${input.question}\n`);
    }
  }
  if (result.changes.length > 0) {
    process.stdout.write("Changes:\n");
    for (const change of result.changes) {
      process.stdout.write(`- ${change}\n`);
    }
  }
  if (result.warnings.length > 0) {
    process.stdout.write("Warnings:\n");
    for (const warning of result.warnings) {
      process.stdout.write(`- ${warning}\n`);
    }
  }
  if (options.dryRun) {
    process.stdout.write("No changes made.\n");
  }
}

export async function run(argv = process.argv): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      process.stderr.write(`[${error.code}] ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[AIO-UNEXPECTED] ${message}\n`);
    process.exitCode = 2;
  }
}

async function commandRoot(program: Command): Promise<string> {
  const options = program.opts<GlobalOptions>();
  return findWorkspaceRoot(
    options.root ? path.resolve(options.root) : process.cwd(),
  );
}
