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

## Agent integration

Claude Code and Codex CLI are the official MVP agent integrations. Other products may discover the generic Agent Skill, but AIongside does not guarantee their Hook execution or full workflow compliance. Support for other agents is only a possible later scope.

`aiongside init` installs the same managed Agent Skill in both supported project paths:

```text
.agents/skills/aiongside/SKILL.md
.claude/skills/aiongside/SKILL.md
```

These files are generated from the skill included with the installed CLI. Do not edit them directly. Put workspace-specific instructions in `.aiongside/rules.md` and create separately named skills for unrelated procedures.

The CLI also copies its always-on instructions to `.aiongside/instructions.md` and registers project-local `SessionStart` and `Stop` Hooks in `.claude/settings.json` and `.codex/hooks.json`. Session start injects the managed instructions and user rules. Session stop runs the same read-only validation as `aiongside check`; the first failure blocks completion and one retry reports remaining problems without blocking again.

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
