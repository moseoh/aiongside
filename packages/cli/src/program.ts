import path from "node:path";
import {
  cancelWork,
  confirmWork,
  createWork,
  discardWork,
  findWorkspaceRoot,
  initializeWorkspace,
  moveWork,
  previewDiscard,
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

  work
    .command("move")
    .description("Move a work item to another status")
    .argument("<id>", "Work item ID")
    .argument("<status>", "Target status")
    .action(async (id: string, status: string) => {
      const root = await commandRoot(program);
      const metadata = await moveWork(root, id, status.toLowerCase());
      process.stdout.write(`Moved: ${metadata.id} -> ${metadata.status}\n`);
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

  work
    .command("cancel")
    .description("Cancel a work item and preserve its history")
    .argument("<id>", "Work item ID")
    .action(async (id: string) => {
      const root = await commandRoot(program);
      const metadata = await cancelWork(root, id);
      process.stdout.write(`Cancelled: ${metadata.id}\nHistory preserved.\n`);
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
