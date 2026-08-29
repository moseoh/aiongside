import path from "node:path";
import {
  cancelWork,
  createWork,
  discardWork,
  findWorkspaceRoot,
  initializeWorkspace,
  moveWork,
  previewDiscard,
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
    .option("--prefix <prefix>", "Work ID prefix", "AIO")
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
    .description("Create Work and manage its status");

  work
    .command("new")
    .description("Create Work in inbox")
    .argument("<title>", "Work title")
    .action(async (title: string) => {
      const root = await commandRoot(program);
      const record = await createWork(root, title);
      process.stdout.write(
        `Created: ${record.id} ${record.title}\nStatus: ${record.status}\n`,
      );
    });

  work
    .command("move")
    .description("Move Work to another status")
    .argument("<id>", "Work ID")
    .argument("<status>", "Target status")
    .action(async (id: string, status: string) => {
      const root = await commandRoot(program);
      const record = await moveWork(root, id, status.toLowerCase());
      process.stdout.write(`Moved: ${record.id} -> ${record.status}\n`);
    });

  work
    .command("cancel")
    .description("Cancel Work and preserve its record")
    .argument("<id>", "Work ID")
    .action(async (id: string) => {
      const root = await commandRoot(program);
      const record = await cancelWork(root, id);
      process.stdout.write(`Cancelled: ${record.id}\nRecord preserved.\n`);
    });

  work
    .command("discard")
    .description("Discard Work from the workspace")
    .argument("<id>", "Work ID")
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

  program
    .command("check")
    .description("Validate workspace structure and Records without writing")
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
