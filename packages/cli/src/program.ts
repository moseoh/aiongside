import { createRequire } from "node:module";
import path from "node:path";
import {
  addWorkDependency,
  addWorkKnowledge,
  createKnowledge,
  createWork,
  type DiscardKnowledgePreview,
  discardKnowledge,
  discardWork,
  findWorkspaceRoot,
  getKnowledgeTree,
  initializeWorkspace,
  type KnowledgeTreeNode,
  listKnowledge,
  type MoveWorkOptions,
  type MoveWorkResult,
  moveKnowledge,
  moveWork,
  previewDiscard,
  previewDiscardKnowledge,
  previewMoveKnowledge,
  previewMoveWork,
  readWorkspaceContext,
  rebuildViews,
  removeWorkDependency,
  removeWorkKnowledge,
  showKnowledge,
  syncAgentIntegration,
  syncWorkOverview,
  validateAgentIntegration,
  validateWorkspace,
  WorkspaceError,
} from "@aiongside/filesystem";
import { Command, CommanderError, Option } from "commander";
import {
  knowledgeMoveActions,
  knowledgeRoutingActions,
  workKnowledgeActions,
  workKnowledgeMessage,
  writePostActions,
} from "./knowledge-actions.js";
import { ui } from "./ui.js";
import {
  defaultRunProcess,
  fetchLatestVersion,
  performUpdate,
  type UpdateEvent,
} from "./update.js";
import {
  projectUpdatePreferences,
  skipUpdateVersion,
  userUpdatePaths,
} from "./update-notices.js";

const cliVersion = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

interface GlobalOptions {
  root?: string;
}

const HOOK_TRUST_NOTICE =
  "Approve project Hooks in Claude Code or Codex CLI when prompted. AIongside does not change user trust settings.";

function writeIntegrationSyncResult(
  result: Awaited<ReturnType<typeof syncAgentIntegration>>,
): void {
  if (result.changes.length === 0) {
    ui.success(`Agent integration is current (version ${result.version})`);
    ui.warning(HOOK_TRUST_NOTICE);
    return;
  }
  ui.success(`Agent workspace upgraded (version ${result.version})`);
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
      ui.success("CLI updated; workspace integrations were not changed");
  }
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("aiongside")
    .exitOverride()
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
    .description("Update the global CLI from any directory")
    .option("--yes", "Approve the displayed global npm update")
    .addOption(
      new Option(
        "--skip-version <version>",
        "Stop notices for this CLI release in all workspaces",
      ).conflicts("yes"),
    )
    .action(async (options: { yes?: boolean; skipVersion?: string }) => {
      if (options.skipVersion !== undefined) {
        const result = await skipUpdateVersion(
          userUpdatePaths().preferences,
          options.skipVersion,
          "user",
        );
        ui.success(
          `CLI release ${result.version} notices skipped (${result.scope}) — ${result.path}. No installation performed.`,
        );
        return;
      }
      await performUpdate(
        {
          currentVersion: cliVersion,
          ...(options.yes ? { yes: true } : {}),
        },
        {
          getLatestVersion: fetchLatestVersion,
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          confirm: () => ui.confirm("Install this update?"),
          runProcess: defaultRunProcess,
          report: writeUpdateEvent,
        },
      );
    });

  const integration = program
    .command("workspace")
    .description("Manage the agent integration bundle");

  integration
    .command("upgrade")
    .description("Restore managed agent integration from the installed CLI")
    .option(
      "--skip-version <version>",
      "Stop notices for this integration version in this workspace",
    )
    .action(async (options: { skipVersion?: string }) => {
      const root = await commandRoot(program);
      if (options.skipVersion !== undefined) {
        const result = await skipUpdateVersion(
          projectUpdatePreferences(root),
          options.skipVersion,
          "project",
        );
        ui.success(
          `Integration ${result.version} notices skipped (${result.scope}) — ${result.path}. No upgrade performed.`,
        );
        return;
      }
      const result = await syncAgentIntegration(root);
      writeIntegrationSyncResult(result);
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
      .argument(
        "<status>",
        "Target status: inbox, active, waiting, done, cancelled",
      ),
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

  const workKnowledge = work
    .command("knowledge")
    .description(
      "Record which Knowledge incorporates a completed Work's results",
    );

  workKnowledge
    .command("add")
    .description(
      "Record that this completed Work's results were incorporated into Knowledge",
    )
    .addHelpText(
      "after",
      "\nIncorporate the Work results into Knowledge before running add. This records a contribution, not a reference or a request to update content. Do not add topics that were only consulted. The CLI records your assertion; it does not edit content or verify incorporation. Repeating add makes no changes.",
    )
    .argument("<id>", "Work item ID")
    .argument("<key>", "Knowledge document key")
    .option("--json", "Print the relationship result and follow-up actions")
    .action(async (id: string, key: string, options: { json?: boolean }) => {
      const root = await commandRoot(program);
      const result = await addWorkKnowledge(root, id, key);
      const output = {
        ...result,
        record: `work/${result.id}/record.md`,
        message: workKnowledgeMessage(result),
        postActions: workKnowledgeActions(result),
      };
      if (options.json) {
        ui.json(output, true);
        return;
      }
      ui.success(output.message);
    });

  workKnowledge
    .command("remove")
    .description(
      "Remove a Work's contribution record without deleting Knowledge content",
    )
    .argument("<id>", "Work item ID")
    .argument("<key>", "Knowledge key")
    .option("--json", "Print the relationship result and follow-up actions")
    .action(async (id: string, key: string, options: { json?: boolean }) => {
      const root = await commandRoot(program);
      const result = await removeWorkKnowledge(root, id, key);
      const output = {
        ...result,
        record: `work/${result.id}/record.md`,
        message: workKnowledgeMessage(result),
        postActions: workKnowledgeActions(result),
      };
      if (options.json) {
        ui.json(output, true);
        return;
      }
      ui.success(output.message);
      writePostActions(output.postActions);
    });

  work
    .command("sync")
    .description(
      "Record the current Record body hash after comparing the Overview",
    )
    .argument("<id>", "Work item ID")
    .action(async (id: string) => {
      const root = await commandRoot(program);
      const result = await syncWorkOverview(root, id);
      if (!result.changed) {
        ui.success(
          `Record body hash already matches for ${result.id} — ${result.path}; no files changed`,
        );
        return;
      }
      ui.success(
        `Recorded current Record body hash for ${result.id} — ${result.path}; Overview body unchanged`,
      );
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

  const knowledge = program
    .command("knowledge")
    .description("Manage Knowledge documents and routing");

  knowledge
    .command("new")
    .description("Create a Knowledge document with a unique frontmatter key")
    .argument("<key>", "Globally unique Knowledge key")
    .option("--display-name <name>", "Human-readable document title")
    .option(
      "--path <path>",
      "Markdown file path relative to knowledge/; defaults to <key>.md",
    )
    .option("--json", "Print a structured creation result")
    .action(
      async (
        key: string,
        options: { displayName?: string; path?: string; json?: boolean },
      ) => {
        const root = await commandRoot(program);
        const result = await createKnowledge(root, { key, ...options });
        const postActions = knowledgeRoutingActions(
          result.indexPaths,
          `Created knowledge/${result.path}. Write the reusable knowledge in this document.`,
        );
        if (options.json) {
          ui.json({ ...result, postActions }, true);
          return;
        }
        ui.success(`Created Knowledge — ${result.key}`);
        ui.rows([{ label: "Path", detail: result.document }]);
        writePostActions(postActions);
      },
    );

  knowledge
    .command("move")
    .description(
      "Move one Knowledge document; preserve its key and Work relationships",
    )
    .argument("<key>", "Knowledge document key")
    .requiredOption(
      "--path <path>",
      "New Markdown file path relative to knowledge/",
    )
    .option("--dry-run", "Show move effects without writing")
    .option("--json", "Print a structured move result")
    .action(
      async (
        key: string,
        options: { path: string; dryRun?: boolean; json?: boolean },
      ) => {
        const root = await commandRoot(program);
        const result = options.dryRun
          ? await previewMoveKnowledge(root, key, options.path)
          : await moveKnowledge(root, key, options.path);
        const postActions = knowledgeMoveActions(result);
        if (options.json) {
          ui.json({ ...result, postActions }, true);
          return;
        }
        ui[result.applied ? "success" : "info"](
          `${result.applied ? "Moved Knowledge" : "Move preview / no change"} — ${result.key}`,
        );
        ui.rows([
          { label: "Source", detail: result.sourcePath },
          { label: "Destination", detail: result.destinationPath },
        ]);
        for (const warning of result.warnings) ui.warning(warning);
        writePostActions(postActions);
        if (!result.applied) ui.summary("No changes made");
      },
    );

  knowledge
    .command("discard")
    .description(
      "Move one unreferenced Knowledge document to recoverable trash",
    )
    .argument("<key>", "Knowledge document key")
    .option("--dry-run", "Show discard effects without writing")
    .option("--confirm <key>", "Confirm the exact normalized key")
    .option("--json", "Print a structured discard result")
    .action(
      async (
        key: string,
        options: { dryRun?: boolean; confirm?: string; json?: boolean },
      ) => {
        const root = await commandRoot(program);
        if (options.dryRun) {
          const result = await previewDiscardKnowledge(root, key);
          if (options.json) {
            ui.json({ ...result, applied: false, postActions: [] }, true);
            return;
          }
          ui.info(`Discard preview — ${result.key}`);
          writeKnowledgeDiscardRows(result);
          ui.summary("No changes made");
          return;
        }
        if (!options.confirm)
          throw new WorkspaceError(
            `Run \`aiongside knowledge discard ${key} --dry-run\`, review the result, then use --confirm ${key.trim().toLowerCase()}.`,
            "AIO-KNOWLEDGE-DISCARD-CONFIRM",
          );
        const result = await discardKnowledge(root, key, options.confirm);
        const postActions = knowledgeRoutingActions(
          result.indexPaths,
          `Discarded knowledge/${result.path}; other documents and attachments were preserved. Remove or repair links to this path; do not guess a replacement.`,
        );
        if (options.json) {
          ui.json({ ...result, postActions }, true);
          return;
        }
        ui.success(`Discarded Knowledge — ${result.key}`);
        writeKnowledgeDiscardRows(result);
        writePostActions(postActions);
      },
    );

  knowledge
    .command("list")
    .description("Scan Knowledge document keys and current paths")
    .option("--json", "Print structured Knowledge data")
    .action(async (options: { json?: boolean }) => {
      const items = await listKnowledge(await commandRoot(program));
      if (options.json) {
        ui.json(items, true);
        return;
      }
      if (items.length === 0) {
        ui.info("No Knowledge documents");
        return;
      }
      ui.section("Knowledge");
      ui.rows(
        items.map((item) => ({
          label: item.key,
          detail: `${item.displayName} — ${item.path}`,
        })),
      );
    });

  knowledge
    .command("tree")
    .description("Show Knowledge folders and documents")
    .option("--json", "Print structured Knowledge data")
    .action(async (options: { json?: boolean }) => {
      const tree = await getKnowledgeTree(await commandRoot(program));
      if (options.json) {
        ui.json(tree, true);
        return;
      }
      if (tree.length === 0) {
        ui.info("No Knowledge documents");
        return;
      }
      ui.section("Knowledge tree");
      ui.rows(flattenKnowledgeTree(tree));
    });

  knowledge
    .command("show")
    .description("Resolve a Knowledge document key to its current path")
    .argument("<key>", "Knowledge document key")
    .option("--json", "Print structured Knowledge data")
    .action(async (key: string, options: { json?: boolean }) => {
      const item = await showKnowledge(await commandRoot(program), key);
      if (options.json) {
        ui.json(item, true);
        return;
      }
      ui.section(item.displayName);
      ui.rows([
        { label: "Key", detail: item.key },
        { label: "Path", detail: item.document },
        { label: "Index", detail: item.index },
      ]);
    });

  const view = program.command("view").description("Manage generated Views");

  view
    .command("sync")
    .description("Rebuild Views from work Records")
    .action(async () => {
      const root = await commandRoot(program);
      await rebuildViews(root);
      ui.success("Views synced");
    });

  for (const name of ["context", "check", "doctor"] as const) {
    program
      .command(name)
      .description(
        name === "context"
          ? "Read managed AIongside instructions"
          : name === "check"
            ? "Check document hashes and mechanical integrity without writing"
            : "Check installed agent integration without writing",
      )
      .option("--json", "Print a versioned machine-readable result")
      .action(async (options: { json?: boolean }) => {
        const root = await commandRoot(program);
        const result =
          name === "context"
            ? await readWorkspaceContext(root)
            : await (async () => {
                const issues = await (name === "check"
                  ? validateWorkspace(root)
                  : validateAgentIntegration(root));
                return { version: 1, root, ok: issues.length === 0, issues };
              })();
        if (options.json) ui.json(result);
        else {
          if ("instructions" in result) {
            process.stdout.write(`${result.instructions ?? ""}\n`);
          }
          for (const issue of result.issues) ui.error(issue);
          if (result.ok && name !== "context")
            ui.success(
              `${name.charAt(0).toUpperCase()}${name.slice(1)} passed`,
            );
        }
        process.exitCode = result.ok ? 0 : 1;
      });
  }

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

function flattenKnowledgeTree(
  nodes: KnowledgeTreeNode[],
  depth = 0,
): Array<{ label: string; detail: string }> {
  return nodes.flatMap((node) => [
    {
      label: `${"  ".repeat(depth)}${node.key ?? node.displayName}`,
      detail: node.path,
    },
    ...flattenKnowledgeTree(node.children, depth + 1),
  ]);
}

function writeKnowledgeDiscardRows(result: DiscardKnowledgePreview): void {
  ui.rows([
    { label: "Path", detail: result.path },
    {
      status: result.referencedBy.length > 0 ? "warning" : "info",
      label: "Referenced by",
      detail: result.referencedBy.join(", ") || "—",
    },
    { label: "Recovery", detail: result.trashTarget },
  ]);
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
    ...(result.postActions ? { postActions: result.postActions } : {}),
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
  for (const action of result.postActions ?? []) {
    ui.hint(action.message);
    ui.rows(
      action.targets.map((target) => ({
        label: target.key,
        detail: `knowledge/${target.path}`,
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
    if (error instanceof CommanderError && error.exitCode === 0) return;
    if (
      argv.includes("--json") &&
      ["context", "check", "doctor"].includes(program.args[0] ?? "")
    ) {
      ui.json({
        version: 1,
        root: program.opts<GlobalOptions>().root ?? process.cwd(),
        ok: false,
        issues: [
          {
            code:
              error instanceof WorkspaceError ? error.code : "AIO-UNEXPECTED",
            path: "",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
      process.exitCode = 2;
      return;
    }
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
