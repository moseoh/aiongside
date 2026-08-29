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

## Commands

```text
aiongside init
aiongside work new <title>
aiongside work move <id> <status>
aiongside work cancel <id>
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
