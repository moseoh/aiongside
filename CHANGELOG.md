# Changelog

## Unreleased

### Changed

- Replaced the previous classification heading with the product-neutral `Knowledge registry`.
- Defined `knowledge/<key>/overview.md` as the entry point for each registered Knowledge key while leaving nested content user-defined.
- Kept shared Knowledge outside individual work completion seals and automatic rewrites.

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
