# AIongside

A local-first workspace for people and AI. The CLI owns metadata and mechanical checks; people and AI own document content and decisions.

## Quick start

Requires Node.js 22 or later. Bun is needed only for source development.

Version 0.4.0 changes the workspace and Knowledge format. Workspaces from 0.3.x and earlier are not automatically migrated. Keep existing data backed up and initialize a new workspace for this format. `workspace upgrade` updates agent integration only; it does not migrate documents.

```sh
npm install --global aiongside
aiongside init ./example
aiongside --root ./example work new "Book a venue"
aiongside --root ./example work move WORK-1 done --json
aiongside --root ./example check --json
```

An actual move to done tells AI to read the Work Record and deliverables, follow relevant Knowledge index links, and compare their content. Incorporate reusable additions or corrections first. Repair affected indexes and internal links when paths change. Then use `work knowledge add` to record the contribution if the relationship is absent. If no update is needed, do nothing; do not add reference-only documents. There is no review status, approval, or review-closing command.

## Commands

- Workspace: `init`, `update`, `context`, `check`, `doctor`, `workspace upgrade`.
- Work: `work new`, `move`, `sync`, `discard`, `needs add/remove`, `knowledge add/remove`.
- Knowledge: `knowledge new`, `move`, `discard`, `list`, `tree`, `show`.
- Views: `view sync`, `view web`, `view web stop`.

Use command-specific `--help` for options. Work statuses are inbox, active, waiting, done, and cancelled. Waiting, reopening, and cancellation require their documented reason options. Done requires valid mechanical state and completed dependencies, not body checkboxes or confirmations.

Work Knowledge links record that a completed Work's results were incorporated into Knowledge. They survive reopening and are excluded from the completion seal. Do not record documents that were only consulted or are awaiting an update. The CLI records the assertion without checking content meaning or command order. Knowledge can also be created and updated independently of Work.

Discard commands preview affected files and references with `--dry-run`, then require the exact identifier through `--confirm`. Discard moves content into recoverable workspace trash.

## Read-only Web View

```sh
aiongside view web
aiongside view web --port 3000
aiongside view web --host workstation --port 3000
aiongside view web --background
aiongside view web stop
```

The default command prints a local URL and stays in the foreground; stop with Ctrl+C. `--port` selects a port, otherwise an available port is assigned. `--background` returns after the server is ready; `view web stop` stops that workspace's background server. Use the global `--root <workspace>` option from another directory. Repeated background starts return the existing URL. Stopping an absent server is a no-op.

Browse all Work items, search by ID or title, filter by status, and sort by ID or update date. Select a Work to read its Overview, then expand folders to open Record, Plan, and supporting files. Refresh to pick up external edits. Markdown and UTF-8 text up to 1 MiB are previewed; other files are offered as downloads. HTML and SVG are never executed. Remote images are not loaded automatically. Knowledge and legacy browsing are not included in this first stage.

The default bind address is `127.0.0.1`. Use `--host <IP-or-hostname>` for a specific network interface; hostnames are resolved once, preferring IPv4. The displayed URL preserves the hostname. Wildcard addresses (`0.0.0.0` and `::`) are rejected. There is no login: anyone allowed to reach the server can read managed Work documents. Use only a trusted network and its access controls. No network or Tailscale settings are changed. An explicit host or port different from an existing background server requires stopping it first.

The Web View uses the shared nested `.gitignore` selection and rejects symlinks and paths outside managed Work. It does not run check, sync, or repair, and does not modify workspace files. Stale summaries and completion errors do not block reading. Background server records are private files under `$XDG_CACHE_HOME/aiongside/web` (default `~/.cache/aiongside/web`), separate from workspace data. Stop authenticates the server at its saved local IP instead of resolving the hostname again or terminating an arbitrary saved PID. No agent integration upgrade is required.

For source development, run `bun run build` and `bun run test:web-browser` (install Chromium once with `bunx playwright install chromium`). Browser tooling is development-only; the installed CLI includes its UI and needs no Bun, browser automation package, CDN, or source checkout.

## Documents and templates

```text
.aiongside/
  config.yaml
  instructions.md
  templates/{record,overview,plan}.md
  internal/
    integration.json
    update-preferences.json
    staging/
    trash/
work/<ID>/
  record.md
  overview.md
  plan.md
  references/
  deliverables/
  evidence/
knowledge/
  index.md
  policy.md
  events/
    index.md
    venue-selection.md
views/{open,closed}.md
```

File roles and default names are fixed. Templates control body text, headings, language, and layout. The optional `{{title}}` placeholder is expanded; other placeholders remain literal. No sections or checkboxes are required. Editing a template does not rewrite existing documents. A missing template affects only operations that need to create that document. The plan is created when Work first becomes active.

The CLI writes Work frontmatter, transition history, completion seals, initial Knowledge keys, and generated Views. Edit document bodies directly. Reopen done Work before changing sealed content, including links to moved Knowledge. The seal includes Record body and Work supporting content, not Overview, shared Knowledge, or Knowledge relationships.

Knowledge consists of individual Markdown documents. Every document except `index.md` requires `aiongside: { schema: 1, key: unique-key }` in YAML frontmatter; optional `aiongside.title` supplies a display name. Keys are globally unique and remain stable when files move. CLI commands scan files to resolve current paths; no Registry is stored.

Each folder, including `knowledge/`, has an `index.md` with descriptions and Markdown links to its direct files and folders, excluding itself. A folder link or its index link covers that folder. Attachments need routing links but no key. Knowledge body text belongs in documents, not indexes. Filenames and classification folders are customizable.

`knowledge new <key> [--path folder/file.md]` defaults to `<key>.md`. It creates missing parent folders and blank indexes without rewriting existing routing. `knowledge move <key> --path folder/file.md` moves only the document and preserves its key. Results identify affected indexes and old/new paths for AI to repair incoming links and the moved document's relative links. Neither command rewrites existing document bodies. There is no Knowledge Overview, hash, or sync command.

## Mechanical checks

Work and Knowledge discovery, checks, index coverage, Views and completion seals share `.gitignore` selection at the workspace root and in traversed subdirectories. Add `node_modules/` to exclude dependency files from both link checks and completion hashes. Ignored directories are not traversed; lower-level rules and negations apply only within reachable directories. Rules are case-sensitive, read once per directory per selection, and refreshed on the next operation. Git installation, tracked-file status, global excludes and rules outside the workspace are not used. No dependency folder is excluded by default.

Ignored Records are absent from managed Work discovery; ignored Knowledge documents are absent from key lookup and index coverage. References from included Work to those IDs or keys are still unresolved-reference errors. Ignored Overview, Plan, supporting folders, indexes and Views are not read, required or automatically written. Explicit writes such as Work sync or Knowledge creation/movement into excluded paths are rejected. A link from an included document into an ignored path still requires a safe existing target; its body is not followed.

`.gitignore` is configuration, not content: its own bytes are excluded from completion hashes and Knowledge index coverage. Adding a pattern for a nonexistent folder leaves the hash unchanged. Excluding or re-including actual sealed content changes the hash and invalidates the old seal. Check never rewrites seals; use the existing explicit reopen and complete flow after reviewing the scope change. Changes inside excluded files do not invalidate a seal created with that selection.

Physical collision protection, Work ID allocation and discard previews still account for actual files, including ignored ones. Discard moves the entire Work directory to recoverable trash. Runtime configuration, templates, hooks, locks and internal recovery files remain operational inputs, not managed document discovery. Unreadable or non-regular ignore files fail the scan instead of silently disabling rules.

`check --json` reads Work hashes, structure, metadata, identifiers, references, dependencies, completion seals, and generated Views. It recursively checks Knowledge keys, index coverage, and Work/Knowledge local Markdown links. It does not judge whether work is meaningful, approved, complete in prose, or awaiting an answer. It does not inspect templates or agent integration.

When a stored Work hash differs or is missing, each issue explains the reason and identifies the Record and Overview paths. Compare those documents, update the Overview if needed, then run `work sync <ID>`. If the Overview body is still accurate, leave it unchanged and sync after comparison. Sync records a hash; it does not approve content.

Work sync validates the configuration and the selected Record/Overview paths, schemas, and identity, then updates only the stored body hash. Other workspace errors do not block this operation. Check continues to report unresolved state, dependency, seal, and document issues. Sync does not change Work state, completion seals, document bodies, or Views.

Index and link issues identify missing entries or targets and ask AI to repair them, then run `check --json`. Inline and reference Markdown links and images are checked; code, comments, frontmatter, HTML links, external URLs, outside-workspace paths, and fragment meaning are excluded. Symlinks inside the workspace are rejected without following them. Routing errors remain visible in check and Stop but do not prevent mutations needed for repair. Duplicate or invalid keys block mutations.

`context --json` reads only managed instructions and returns `version`, `root`, `ok`, `instructions`, and `issues`. It does not create, load, or return a separate rules file. User instructions stay in the agent's own instruction files. `doctor --json` checks integration independently. Check and doctor return `version`, `root`, `ok`, and `issues`; each issue has `code`, `path`, `message`, and an optional `hint`. Exit codes: 0 success, 1 reported problems, 2 execution failure. JSON is one stdout object; human output remains separate.

## Agent integration

Initialization installs minimal instructions and project SessionStart/Stop settings for Claude Code and Codex. No Skill or plugin is installed.

The separate `aiongside-agent-adapter` executable calls the installed ordinary CLI with `context --json` or `check --json`. It translates responses without adding domain rules. Stop blocks the first mechanical failure, preserves its complete reason and recovery steps, and reports unresolved issues without repeatedly blocking.

The adapter accepts `aiongside-agent-adapter <session-start|stop> [--root <path>]`. An explicit root takes precedence; without it, the adapter uses its actual working directory. Relative paths resolve from that directory. It finds the nearest workspace from the selected directory. Invalid explicit paths fail instead of falling back to another directory. The event's `cwd` does not select the workspace.

Managed Claude hooks pass `--root "$CLAUDE_PROJECT_DIR"`; managed Codex hooks pass `--root "$PWD"` from the hook process, which runs in the session working directory. Product-specific path selection stays in hook settings, without product-detection flags or Git commands. Recovery output identifies the workspace and the safely quoted `aiongside --root '<workspace>'` prefix. Ordinary CLI path selection is unchanged.

There is no session binding cache or startup prerequisite: resume, compaction, and Stop work without a previous SessionStart. Old `aiongside/hook-sessions` cache files are not read, written, or deleted. After reinstalling, run `aiongside workspace upgrade` in each workspace to update the managed hook commands; doctor reports outdated integration. The agent may require hook reload or renewed trust approval, but creating a new conversation is not a binding requirement. Doctor checks installed integration files, not whether a running agent has reloaded them.

Approve project hooks in the agent product when prompted. AIongside does not edit trust settings. `workspace upgrade` repairs managed instructions, hooks, and integration version offline; it preserves AGENTS.md, CLAUDE.md, and unrelated files and settings. `update` works from any directory and updates only the global CLI after approval. It never upgrades workspaces automatically. Running `init` again is rejected. Legacy workspace files are not automatically moved or deleted.

SessionStart checks npm for a new CLI release with a two-second limit and a one-hour cache. It separately compares local integration versions. Lookup failures do not block session startup. Stop and ordinary `context` do not check npm or write update settings.

After the user explicitly declines further notices for a version, run `aiongside update --skip-version <release>` for all workspaces, or `aiongside workspace upgrade --skip-version <integration-version>` for this workspace. Silence and postponing one session do not count as version refusals. New versions are announced again; explicit updates remain available.

User preferences default to `~/.config/aiongside/update-preferences.json`; the lookup cache defaults to `~/.cache/aiongside/update-check.json`. `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` override their base directories. Project preferences are stored in `.aiongside/internal/update-preferences.json` and do not change integration metadata.

Knowledge move and Work Knowledge add/remove return matching result meanings in text and `--json`. Add reports the contribution record and unchanged Knowledge content, with no new update or sync action. Remove preserves Knowledge content and asks AI to show the contributed content and impact and obtain user approval before removing it. Relationships do not identify individual source sentences. The CLI never tracks whether these actions or approvals happened.

See [integration boundaries](docs/mvp.md).

## Development

```sh
bun install
bun run build
bun run check
bun run package:check
```

CI runs Node.js 22 and 24 package checks. Local verification limitations are recorded separately; publishing is not part of implementation validation.

## Web View UI

The browser UI lives in `packages/web/ui` (React + Vite). `bun run build` builds it and embeds the output into the CLI bundle. For hot reload run a server on a fixed port and `bun run dev:ui`; see `packages/web/ui/README.md`.
