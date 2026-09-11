# Changelog

## Unreleased

## 0.6.2 - 2026-09-11

### Added

- `aiongside view web --json` and `aiongside view web stop --json` return the URL, workspace, and stop command as JSON, matching the command listed in managed instructions.

## 0.6.1 - 2026-09-11

### Changed

- After moving a Work to done, agents now report their Knowledge decision in one line: the updated key and what was added, or why no update is needed.
- Managed instructions list the Web View command (`aiongside view web --background --json`) among common commands.

### Existing workspaces

Run `aiongside workspace upgrade` in each existing workspace to update managed instructions.

## 0.6.0 - 2026-09-10

### Added

- Live updates in the Web View: the server watches `work/` and `knowledge/` and pushes changes, so lists, board, metadata, relations, and file trees refresh in place.
- Live button in the header with a recent changes list, pause and resume, and connection state.
- Open documents keep their body when the file changes on disk and show a Reload link; file trees mark files changed since you last opened them.
- Toast notifications in the bottom-left corner for status transitions and new Work outside the current page.
- Status history tab on the Work detail page.
- Copy Work ID button in the detail header.
- Brand mark and favicon set.

### Changed

- The header Refresh button is replaced by the Live button. It returns only where folder watching is unavailable.

### Fixed

- Document width no longer shifts when a page scrollbar appears or disappears.

### Existing workspaces

No data or hook changes. Restart running Web View servers to get live updates.

## 0.5.1 - 2026-09-09

### Changed

- Web View documents scroll with the page; the header and file tree stay pinned, and long file trees scroll inside their own panel.
- Managed agent instructions list common commands directly instead of routine `--help` traversal.

### Existing workspaces

Run `aiongside workspace upgrade` in each existing workspace to update managed instructions. Restart running Web View servers.

## 0.5.0 - 2026-09-08

### Added

- Read-only Web View for Work and Knowledge: search, filters, board, relations, file browsing, and Markdown previews.
- Port and host configuration, background execution, and stop control.
- Keyboard navigation, language/theme persistence, and smoother file switching.

### Fixed

- Knowledge `index.md` links now open the folder route.
- Agent hooks pass workspace roots explicitly: `CLAUDE_PROJECT_DIR` for Claude, `PWD` for Codex. The adapter defaults to its working directory when `--root` is omitted.
- Removed the session-binding cache dependency and the requirement to start a new conversation.

### Existing workspaces

Run `aiongside workspace upgrade` in each existing workspace to update managed hooks, instructions, and integration metadata. Custom edits to `.aiongside/instructions.md` are replaced; Work, Knowledge, templates, other hooks, and user agent instructions are preserved. Reload agent hook settings and restart running Web View servers.

## 0.4.2 - 2026-09-08

### Changed

- Share workspace and nested `.gitignore` selection across Work, Knowledge, indexes, Views, and completion hashes.
- Skip ignored directory traversal and content reads, including dependency files in completion hashes.
- Preserve physical collision checks, link-target safety, and recoverable discard contents.
- Treat `.gitignore` as configuration, excluding its bytes from completion hashes and index coverage.

### Existing workspaces

Changing the selected file set can invalidate completion hashes created with the previous scope. Review affected completed Work and explicitly reopen and complete it again. No automatic resealing or workspace data migration is performed.

## 0.4.1 - 2026-09-07

### Fixed

- Completed prerequisites no longer appear as unresolved inputs in Work completion previews or successful completion responses.
- Cancelled prerequisites still block completion. Guidance now explains explicit relationship removal only when no longer needed, or reopening and completing the prerequisite when still required.
- Human-readable completion previews now include recovery hints, consistent with JSON guidance.

## 0.4.0 - 2026-09-07

### Breaking changes

- Knowledge now uses individual Markdown documents with stable, globally unique frontmatter keys and recursive `index.md` routing. Registry files, Knowledge Overview hashes, and Knowledge sync are removed.
- Agent integration uses minimal instructions and a separate `aiongside-agent-adapter`. Bundled Skills and separate rules files are removed.

### Changed

- Work completion guides AI to compare existing Knowledge, incorporate reusable results, and then record actual contributions. Reference-only Knowledge is excluded.
- Mechanical checks report duplicate or missing keys, index coverage, broken internal links, and actionable Work hash recovery steps.
- Work sync updates only the selected Record body hash after validating its configuration and document identity. Unrelated state, dependency, seal, or document errors no longer block recovery; check still reports them.
- Knowledge move preserves keys and reports affected routing and links. Contribution removal preserves content and requests user approval before content removal.
- Global CLI update and workspace integration upgrade are separate. SessionStart provides version notices with version-specific dismissal preferences.
- Templates use HTML writing hints and document the roles of Record, Overview, deliverables, references, and evidence.

### Existing workspaces

Existing 0.3.x and earlier workspaces are not automatically migrated. Back up existing data and initialize a new workspace. `workspace upgrade` updates managed instructions and hooks only, not document formats.

## 0.3.0 - 2026-09-05

### Breaking changes

- Existing registered Knowledge Overviews remain unchanged but report stale until each key is explicitly reviewed and synced.

### Added

- `Knowledge registry` with stable keys, nested paths, optional parents, and required Overviews; internal content stays user-defined.
- `work knowledge add/remove` and Knowledge review targets in `done` dry-runs.
- Namespaced Knowledge Overview metadata and deterministic owned-content digests.
- Nearest-topic ownership boundaries that isolate nested registered topic content.
- `knowledge list`, `tree`, `show`, and target-only `sync` with human and JSON output.
- `AIO-KNOWLEDGE-STALE` validation, Stop Hook reporting, and linked Knowledge freshness gates for `done`.
- `knowledge new` for new topics and byte-preserving registration of existing directories.
- Dry-run and atomic subtree movement through `knowledge move` while preserving keys and Work relationships.
- Leaf-only, reference-safe `knowledge discard` with content and recovery metadata stored under `.aiongside/trash/knowledge/`.
- Managed Agent procedures for Knowledge creation, move approval, discard approval, and direct-edit avoidance.

### Changed

- Replaced the previous classification heading with the product-neutral `Knowledge registry`.
- Legacy two-column Registry rows stay readable as top-level key paths.
- Shared Knowledge stays outside individual work completion seals and automatic rewrites.
- Unrelated Work mutations stay available while Knowledge review is in progress.

## 0.2.1 - 2026-08-30

### Added

- TTY-aware CLI colors with plain-text output for pipes, captured output, and `NO_COLOR`.

### Changed

- Standardized human-readable CLI output around shared result, status row, warning, error, summary, and next-action primitives.
- Initialization explains the workspace root, ID prefix, managed Agent integration, Hook approval, and first work command in one consistent result.
- Hook and transition JSON stay undecorated machine output.

## 0.2.0 - 2026-08-30

### Breaking changes

- New workspaces use `WORK` as the default work ID prefix.
- Work IDs use unpadded positive integers such as `WORK-1` and `WORK-10`.
- Padded IDs such as `AIO-001` are not supported or migrated automatically. Reinitialize a pre-release workspace or migrate every directory, Record, Overview, dependency, and generated View reference together.

### Added

- Project-local Agent Skills for Claude Code and Codex CLI.
- Managed session-start and stop Hooks that load workspace rules and enforce validation.
- `aiongside skill sync` for offline Agent integration repair.
- `aiongside update` for approved global CLI updates followed by workspace integration sync.
- Overview freshness tracking based only on the normalized Record Markdown body.
- `aiongside work sync <id>` for recording an explicit Overview review.
- `AIO-OVERVIEW-STALE` validation for missing or outdated review digests.

## 0.1.0 - 2026-08-30

### Added

- Workspace initialization with Work directories, Records, Overviews, and generated Views.
- Work dependency commands with dependency and state-gate validation.
- Simplified Work status transitions.
- Structure validation for deliverables, references, and evidence.
- Generated View drift validation.
- npm packaging for the `aiongside` CLI with packaged version reporting.
