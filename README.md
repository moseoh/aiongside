# AIongside

A local-first workspace where people and AI share everyday work context, Records, Overviews, and rules.

The first goal is simple local work management. The second goal is a validation layer that turns damaged Records, missed updates, and inconsistent generated Views into mechanical failures.

## Status

- MVP CLI implemented.
- Workspace initialization, work item creation, status movement, cancellation, safe discard, and validation implemented.
- Editable workspace templates implemented.
- npm publishing not started.
- TypeScript monorepo managed with Bun.
- Shared Claude and Codex plugin source included.
- Local Web UI reserved for the distant future.
- TUI excluded from product scope.

## Quick start

```sh
bun install
bun run build
node packages/cli/dist/bin.js init ./example
node packages/cli/dist/bin.js --root ./example work new "First Work"
node packages/cli/dist/bin.js --root ./example check
```

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
  reports/
  references/
views/
  open.md
  closed.md
```

`record.md` is the canonical work document. It owns status, progress, decisions, and outcomes. `overview.md` is the short human-readable entry point and does not duplicate dynamic state. `plan.md` is optional and is created when a work item moves to `active`.

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
aiongside work move AIO-001 waiting --dry-run --json
aiongside work move AIO-001 waiting \
  --waiting-reason "Waiting for approval" \
  --resume-when "Approval is received"
```

The JSON preview lists stable `requiredInputs`, questions, CLI options, changes, and warnings. Transition answers are written to machine-owned Record frontmatter, not the customizable template body.

Moving to `done` validates review signals stored in Record frontmatter. Confirm them after reviewing the corresponding Record content:

```sh
aiongside work confirm AIO-001 scope completion
aiongside work confirm AIO-001 verification
aiongside work confirm AIO-001 outcome knowledge
```

- Only `done` requires `scope`, `completion`, `verification`, `outcome`, and `knowledge`.
- Only `done` requires every ID in `needs` to be `done`.
- Leaving `done` requires `--reopen-reason` or `--cancellation-reason`, invalidates the completion seal, and resets verification, outcome, and knowledge confirmations.
- Changing completion-relevant content while the status remains `done` fails `aiongside check`.

`needs` contains stable work item IDs in Record frontmatter. `aiongside check` rejects missing, duplicate, self-referencing, and cyclic dependencies. Confirmations are mechanical review signals; they do not prove that prose is true or complete.

## Commands

```text
aiongside init
aiongside work new <title>
aiongside work confirm <id> <checks...>
aiongside work move <id> <status> --dry-run --json
aiongside work move <id> <status> [transition options]
aiongside work cancel <id> --cancellation-reason <text>
aiongside work discard <id> --dry-run
aiongside view rebuild
aiongside check
```

## Development

```sh
bun run check
```

Node.js 22 and 24 are supported. Development uses Node.js 24.

## License

[MIT](LICENSE)
