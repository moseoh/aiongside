# Agent integration boundaries

## Ownership

- Domain: Work state, relationships, hashes, completion seals, and deterministic Views.
- Filesystem: safe reads, transactional writes, workspace layout, and recovery.
- CLI: ordinary commands, human output, versioned JSON, and recovery guidance.
- Managed instructions: CLI usage, help, command results, document and folder roles, and local writing hints.
- Adapter: product events, ordinary CLI invocation, response conversion, and bounded Stop retries.

AIongside does not distribute an agent Skill. The CLI does not judge document meaning, template conformance, Knowledge impact, approvals, or whether an agent is waiting for the user.

## Product hooks

Both supported products use project SessionStart and Stop command hooks. SessionStart reads context only. Stop calls check and forwards every issue without shortening its recovery steps to a sync command.

Official protocol references:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks).
- [Claude Code hooks](https://code.claude.com/docs/en/hooks).

The adapter accepts the shared event fields, ignores additional product fields, and uses the documented SessionStart context and Stop decision envelopes. A retry signaled by `stop_hook_active` reports unresolved issues without another block. CLI absence, timeout, malformed output, or inconsistent exit status is an execution failure, not a passed check.

## Installation

The npm package contains ordinary CLI and adapter executables plus managed instructions. Initialization writes project hook settings and `.aiongside/internal/integration.json`. Integration synchronization preflights conflicts and future versions before changing files, preserves unrelated hooks and settings, and rolls back failed managed writes.

The workspace root configuration, managed instructions, and editable templates remain directly under `.aiongside/`. Integration metadata, project notification preferences, staging, and recoverable trash live under `.aiongside/internal/`. Separate rules files are not created or loaded; existing user files are not automatically migrated or deleted.

Agent trust approval remains user-owned. SessionStart may check npm within two seconds and store a one-hour result cache under the user's cache directory. It reads version-specific user/project notification preferences but never records refusals automatically. Lookup failures do not block instruction loading. Stop remains offline and read-only. No hook installs packages, upgrades a workspace, or modifies trust settings.

## Work completion

An actual move to done saves state, history, seal, and Views before returning one-time Knowledge guidance: read the Work Record and deliverables, follow relevant index paths and compare Knowledge, incorporate reusable results, repair affected indexes and links, then record the contribution with add if absent. Reference-only documents are excluded. A dry-run, failed move, or no-op does not create this guidance. No update means no follow-up command. Add records prior incorporation without issuing another content update or checking semantic evidence or command order. Remove retains content and requests user approval before any content removal.

Knowledge keys live in individual Markdown frontmatter. The CLI scans keys and paths, not a Registry. Folders are classification only; each index links direct children. Check validates coverage and internal links recursively, not their meaning. Move preserves keys and bytes and reports old/new paths. AI repairs links; done Work content still requires reopening. Knowledge has no Overview/hash/sync; Work hashes and sync remain.
