# Changelog

## Unreleased

### Changed

- Replaced the previous classification heading with the product-neutral `Knowledge registry`.
- Added Registry-managed stable keys, nested paths, optional parents, and required Overviews while leaving internal content user-defined.
- Added `work knowledge add/remove` and Knowledge review targets to `done` dry-runs.
- Kept legacy two-column Registry rows readable as top-level key paths.
- Kept shared Knowledge outside individual work completion seals and automatic rewrites.
- Added namespaced Knowledge Overview metadata and deterministic owned-content digests.
- Added nearest-topic ownership boundaries that isolate nested registered topic content.
- Added `knowledge list`, `tree`, `show`, and target-only `sync` with human and JSON output.
- Added `AIO-KNOWLEDGE-STALE` validation, Stop Hook reporting, and linked Knowledge freshness gates for `done`.
- Kept unrelated Work mutations available while Knowledge review is in progress.

### Breaking changes

- Existing registered Knowledge Overviews remain unchanged but report stale until each key is explicitly reviewed and synced.

## 0.2.1 - 2026-08-30

### Changed

- Standardized human-readable CLI output around shared result, status row, warning, error, summary, and next-action primitives.
- Made initialization explain the workspace root, ID prefix, managed Agent integration, Hook approval, and first work command in one consistent result.
- Preserved Hook and transition JSON as undecorated machine output.

### Added

- TTY-aware CLI colors with plain-text output for pipes, captured output, and `NO_COLOR`.

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
