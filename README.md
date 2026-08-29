# AIongside

A local-first workspace where people and AI share everyday work context, records, and rules.

The first goal is simple local work management. The second goal is a validation layer that turns damaged records, missed updates, and inconsistent derived documents into mechanical failures.

## Status

- MVP CLI implemented.
- Workspace initialization, Work creation, status movement, cancellation, safe discard, and validation implemented.
- Editable workspace templates implemented.
- npm publishing and remote repository setup not started.
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
  brief.md
  plan.md
```

Edit these files with any text editor. New Work uses the current workspace templates. AIongside generates YAML frontmatter separately, so template customization cannot remove machine-owned Work metadata.

`record.md` and `brief.md` must retain the `{{title}}` placeholder. `aiongside check` reports missing template files and invalid placeholders. Initialization never overwrites an existing template file.

## Commands

```text
aiongside init
aiongside work new <title>
aiongside work move <id> <status>
aiongside work cancel <id>
aiongside work discard <id> --dry-run
aiongside check
```

## Documentation

- [Product scope](docs/product-scope.md)
- [MVP](docs/mvp.md)
- [Technical stack](docs/technical-stack.md)

## Development

```sh
bun run check
```

Node.js 22 and 24 are supported. Development uses Node.js 24.

## License

[MIT](LICENSE)
