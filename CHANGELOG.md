# Changelog

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
