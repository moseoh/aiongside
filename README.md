# AIongside

A local-first workspace where people and AI share everyday work context, Records, Overviews, and rules.

The first goal is simple local work management. The second goal is a validation layer that turns damaged Records, missed updates, and inconsistent generated Views into mechanical failures.

## Status

- MVP CLI implemented.
- Workspace initialization, work item creation, status movement, dependency management, cancellation, safe discard, and validation implemented.
- Editable workspace templates implemented.
- Published on npm as `aiongside`.
- TypeScript monorepo managed with Bun.
- Project-local Agent Skills, managed instructions, and lifecycle Hooks installed and validated by the CLI.
- Record-body freshness tracking for human-readable Overviews implemented.
- Nested Knowledge lifecycle, topic creation, movement, recoverable discard, freshness validation, exploration, sync, and Work completion gates implemented.
- Local Web UI reserved for the distant future.
- TUI excluded from product scope.

## Quick start

Install AIongside with Node.js 22 or later:

```sh
npm install --global aiongside
aiongside --help
aiongside init ./example
aiongside --root ./example check
```

The installed CLI runs on Node.js without requiring Bun. Node.js 22 and 24 are tested for every release candidate.

To run from source:

```sh
bun install
bun run build
node packages/cli/dist/bin.js init ./example
node packages/cli/dist/bin.js --root ./example work new "First Work"
node packages/cli/dist/bin.js --root ./example check
```

## CLI output

The default output is designed for people. Commands use the same small status vocabulary: `✓` success, `•` information, `+` creation, `~` update, `!` warning, `×` error, and `→` next action. A successful initialization starts with the result, groups the created integration files, and ends with the next command:

```text
✓ Workspace initialized
  • Root          /path/to/workspace
  • ID prefix     WORK
  + Agent Skills  .agents/skills/aiongside/SKILL.md · .claude/skills/aiongside/SKILL.md
  + Instructions  .aiongside/instructions.md
  + Hooks         .claude/settings.json · .codex/hooks.json
! Approve project Hooks in Claude Code or Codex CLI when prompted. AIongside does not change user trust settings.
→ Create your first work: aiongside --root "/path/to/workspace" work new "First Work"
```

Colors are used only in a terminal and never carry meaning by themselves. Pipes, captured output, and `NO_COLOR` receive the same text without ANSI codes. Automation should use documented `--json` output, Hook JSON, and exit codes instead of parsing human-readable prose. JSON output never includes headings, symbols, colors, or hints.

## Agent integration

Claude Code and Codex CLI are the official MVP agent integrations. Other products may discover the generic Agent Skill, but AIongside does not guarantee their Hook execution or full workflow compliance. Support for other agents is only a possible later scope.

`aiongside init` installs the same managed Agent Skill in both supported project paths:

```text
.agents/skills/aiongside/SKILL.md
.claude/skills/aiongside/SKILL.md
```

These files are generated from the skill included with the installed CLI. Do not edit them directly. Put workspace-specific instructions in `.aiongside/rules.md` and create separately named skills for unrelated procedures.

The CLI also copies its always-on instructions to `.aiongside/instructions.md` and registers project-local `SessionStart` and `Stop` Hooks in `.claude/settings.json` and `.codex/hooks.json`. Session start injects the managed instructions and user rules without preloading all Work or Knowledge content. Session stop runs the same read-only validation as `aiongside check`; the first failure, including stale Knowledge, blocks completion and one retry reports remaining problems without blocking again.

Claude Code or Codex CLI may ask you to approve project Hooks. Review and approve the two `aiongside hook` commands in the agent product. AIongside does not change user trust settings or user-home configuration. If `aiongside` is no longer on `PATH`, reinstall the global CLI; Hooks never install or update packages automatically.

Use `aiongside skill sync` to restore the managed integration without a network connection. Use `aiongside update` to check npm, preview and approve a global CLI update, and then sync the current workspace with the newly installed CLI. Existing `AGENTS.md` and `CLAUDE.md` files are never created or modified. Older workspaces may retain an AIongside block previously added to either file; after approving the project Hooks, remove that old block manually if desired.

See [MVP agent integration](docs/mvp.md) for the support and ownership boundaries.

## Templates

`aiongside init` creates editable Markdown templates:

```text
.aiongside/templates/
  record.md
  overview.md
  plan.md
```

Edit these files with any text editor. New work items use the current workspace templates. AIongside generates YAML frontmatter separately, so template customization cannot remove machine-owned metadata.

`record.md` and `overview.md` must retain the `{{title}}` placeholder. `aiongside check` reports missing template files and invalid placeholders. Initialization never overwrites an existing template file.

## Workspace files

```text
work/<ID>/
  record.md
  overview.md
  plan.md              # Created when the work item moves to active
  references/
  deliverables/
  evidence/
views/
  open.md
  closed.md
knowledge/
  registry.md
  operations/                   # Registered key: operations
    overview.md
    incident-response/          # Registered key: incident-response
      overview.md
      ...                       # User-defined internal content
```

`record.md` is the canonical work document. It owns status, progress, decisions, and outcomes. `overview.md` is the short human-readable entry point and does not duplicate dynamic state. Its machine-owned `recordBodyDigest` records which Record Markdown body was last reviewed. `plan.md` is optional and is created when a work item moves to `active`.

After editing a Record Markdown body, review the Overview and update its human-readable content when needed. Then record that review explicitly:

```sh
aiongside work sync WORK-1
```

`aiongside check` reports `AIO-OVERVIEW-STALE` when the digest is missing or no longer matches. Record frontmatter and LF/CRLF differences do not affect this digest. Sync never generates or approves Overview prose.

New workspaces use `WORK` as the default ID prefix. IDs start at `WORK-1`, have no leading zero, and are sorted by their numeric suffix in generated Views. A custom prefix remains available through `aiongside init --prefix <prefix>`. Padded IDs such as `AIO-001` are not supported or migrated automatically; see [Unreleased changes](CHANGELOG.md).

Each new work item includes three user-owned content directories:

- `references/`: material received from outside the work, such as official documents, vendor replies, source files, and links.
- `deliverables/`: outputs produced for delivery, such as reports, instructions, presentations, spreadsheets, and exports.
- `evidence/`: results observed directly in the current environment, such as logs, query results, screenshots, measurements, and command output.

AIongside requires these directories but does not constrain their file names, formats, or nested structure. Their contents are never rewritten automatically. File paths and exact bytes in all three directories are covered by the completion seal, so changing them while work remains `done` fails validation. Direct edits do not update Record metadata or generated Views.

Older workspaces may contain `reports/` instead of `deliverables/` and may not contain `evidence/`. AIongside does not move or delete those files automatically. Review the existing content, move delivery outputs into a new `deliverables/` directory, and create `evidence/` before running further mutations.

`knowledge/registry.md` is the entry point for persistent Knowledge shared across work items. Its managed table has `Key`, `Path`, `Parent`, and `Display name` columns. A key is a stable, globally unique relationship identifier. A path locates the topic below `knowledge/`, an optional parent names another registered key, and the display name is for people. New workspaces start with an empty Registry and no default Knowledge keys.

Registered topics can use paths at any depth and each registered path must contain `overview.md`. Explore only what the current task needs:

```sh
aiongside knowledge list
aiongside knowledge tree
aiongside knowledge show incident-response
```

Create a new topic, or register an existing unregistered directory with the same command:

```sh
aiongside knowledge new operations --display-name "Operations"
aiongside knowledge new incident-response --parent operations
aiongside knowledge new handbook --path company/handbook
```

A new empty path receives a minimal English Overview and starts fresh. Existing files are preserved byte-for-byte. An existing Overview is never rewritten; a missing Overview receives only a minimal heading. Adopted content remains stale until a person reviews it and runs `knowledge sync`.

Moving a topic preserves its key, Work relationships, nested registered paths, and all user content. Preview first because Markdown links are reported but never rewritten:

```sh
aiongside knowledge move incident-response \
  --path reliability/incident-response \
  --no-parent \
  --dry-run --json
aiongside knowledge move incident-response \
  --path reliability/incident-response \
  --no-parent
```

Discard is limited to a leaf topic with no Work references. It removes the Registry row and moves the directory plus recovery metadata under `.aiongside/trash/knowledge/`; restoration remains manual:

```sh
aiongside knowledge discard incident-response --dry-run
aiongside knowledge discard incident-response --confirm incident-response
```

Each Overview stores machine-owned freshness metadata under one namespace while preserving its Markdown body and other frontmatter:

```yaml
aiongside:
  schema: 1
  key: incident-response
  contentDigest: <sha256>
```

A topic owns the content below its registered path except its own Overview and every physically nested registered topic. Unregistered files and directories belong to the nearest registered topic. A nested topic's content changes only its own digest. Changes to a direct child's Registry tuple make only its parent stale so the parent routing can be reviewed.

Markdown line endings are normalized for the digest. Other files use exact bytes. Symlinks contribute their path and target string without being followed. AIongside does not impose names, formats, or internal structure and does not rewrite shared Knowledge automatically. Shared Knowledge is outside individual work completion seals.

After changing owned content, review the Overview and update its scope or navigation when needed. Record that review explicitly:

```sh
aiongside knowledge sync incident-response
```

Sync updates only the managed metadata. It never writes Overview prose and must not be run automatically without review. Missing or mismatched metadata and changed owned content produce `AIO-KNOWLEDGE-STALE`. Existing Overviews without metadata remain unchanged and stale until their first explicit sync.

The legacy two-column `Key` and `Display name` table remains readable: each key resolves to the same top-level path with no parent. AIongside does not rewrite an existing Registry automatically. Once a legacy row is present, its `knowledge/<key>/overview.md` entry point must exist.

Work Records store related Knowledge keys rather than paths, so a registered path can move without breaking Work relationships. Use the most specific registered key and do not add its parents automatically:

```sh
aiongside work knowledge add WORK-1 incident-response
aiongside work knowledge remove WORK-1 incident-response
```

The `done` dry-run returns a `knowledgeReview` object with each target's current path, Overview, and freshness. When it lists targets, review each target Overview and update only the smallest relevant internal documents. Update an Overview only when its scope or navigation changed, then sync it. Stale linked topics block `done`; unrelated stale topics do not. When there are no targets, explicitly confirm that the work has no lasting Knowledge impact. Then record the existing `knowledge` confirmation before moving to `done`. Reopening preserves the candidate keys but resets that confirmation for the next completion cycle. Later Knowledge changes do not invalidate historical Work completion seals.

Views are generated from Record metadata and must not be edited directly. `aiongside check` compares each View with a deterministic rendering of current Records. Missing, stale, manually modified, or line-ending-converted Views fail validation without changing files. Run `aiongside view rebuild` for explicit recovery.

## Work status

AIongside uses five statuses:

- `inbox`: captured but not currently being worked.
- `active`: work, review, or verification that can proceed now.
- `waiting`: no action can proceed until an external response or condition changes.
- `done`: completion requirements were reviewed and sealed.
- `cancelled`: intentionally stopped while retaining the Record.

Every status can move to every other status. Preview a move before applying it:

```sh
aiongside work move WORK-1 waiting --dry-run --json
aiongside work move WORK-1 waiting \
  --waiting-reason "Waiting for approval" \
  --resume-when "Approval is received"
```

The JSON preview lists stable `requiredInputs`, questions, CLI options, changes, and warnings. Transition answers are written to machine-owned Record frontmatter, not the customizable template body.

Moving to `done` validates review signals stored in Record frontmatter. Confirm them after reviewing the corresponding Record content:

```sh
aiongside work confirm WORK-1 scope completion
aiongside work confirm WORK-1 verification
aiongside work confirm WORK-1 outcome knowledge
```

- Only `done` requires `scope`, `completion`, `verification`, `outcome`, and `knowledge`.
- Only `done` requires every ID in `needs` to be `done`.
- Leaving `done` requires `--reopen-reason` or `--cancellation-reason`, invalidates the completion seal, and resets verification, outcome, and knowledge confirmations.
- Changing completion-relevant content while the status remains `done` fails `aiongside check`.

`needs` contains stable work item IDs in Record frontmatter. Manage it through the CLI instead of editing frontmatter directly:

```sh
aiongside work needs add WORK-2 WORK-1
aiongside work needs remove WORK-2 WORK-1
```

Adding a dependency rejects missing, duplicate, self-referencing, and cyclic relationships. Removing an absent relationship succeeds without changing files. Reopen `done` work before changing its dependencies. Confirmations are mechanical review signals; they do not prove that prose is true or complete.

`knowledge` contains stable Registry keys in Record frontmatter. Manage it through `work knowledge add/remove` instead of editing frontmatter directly. Adding or removing a relationship resets the Knowledge confirmation. Reopen `done` work before changing these relationships.

## Commands

```text
aiongside init
aiongside update
aiongside skill sync
aiongside hook session-start
aiongside hook stop
aiongside work new <title>
aiongside work confirm <id> <checks...>
aiongside work sync <id>
aiongside work move <id> <status> --dry-run --json
aiongside work move <id> <status> [transition options]
aiongside work needs add <id> <dependency-id>
aiongside work needs remove <id> <dependency-id>
aiongside work knowledge add <id> <key>
aiongside work knowledge remove <id> <key>
aiongside knowledge new <key> [--display-name <name>] [--path <path>] [--parent <key>] [--json]
aiongside knowledge move <key> --path <path> [--parent <key> | --no-parent] [--dry-run] [--json]
aiongside knowledge discard <key> [--dry-run | --confirm <key>] [--json]
aiongside knowledge list [--json]
aiongside knowledge tree [--json]
aiongside knowledge show <key> [--json]
aiongside knowledge sync <key> [--json]
aiongside work cancel <id> --cancellation-reason <text>
aiongside work discard <id> --dry-run
aiongside view rebuild
aiongside check
```

## Development

```sh
bun run check
bun run package:check
```

Node.js 22 and 24 are supported. Development uses Node.js 24.

Publishing requires an npm owner for `aiongside` and an npm Trusted Publisher restricted to `moseoh/aiongside` and `.github/workflows/publish.yml`. A published GitHub Release must use a tag that exactly matches `v<package-version>`. The release workflow rejects version mismatches, existing npm versions, package validation failures, and Node.js 22 or 24 smoke-test failures before publishing.

## License

[MIT](LICENSE)
