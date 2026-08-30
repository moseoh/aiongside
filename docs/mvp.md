# MVP agent integration

## Official support

AIongside officially supports Claude Code and Codex CLI for the MVP. Both integrations use project-local Agent Skills and lifecycle Hooks installed by the CLI.

Other Agent Skills-compatible products may find `.agents/skills/aiongside/SKILL.md`. This does not guarantee that their sessions load the always-on instructions, run the final workspace check, or follow the complete workflow. Additional agent support is uncommitted later scope.

## Managed and user-owned files

AIongside manages these files as one versioned integration bundle:

```text
.agents/skills/aiongside/SKILL.md
.claude/skills/aiongside/SKILL.md
.aiongside/instructions.md
.claude/settings.json       # AIongside Hook entries only
.codex/hooks.json           # AIongside Hook entries only
.aiongside/config.yaml      # Managed bundle version only
```

AIongside preserves unrelated keys and Hook entries in the two JSON settings files. It also preserves these user-owned files:

```text
.aiongside/rules.md
AGENTS.md
CLAUDE.md
```

Write workspace-specific rules only in `.aiongside/rules.md`. Run `aiongside skill sync` to restore managed files from the installed CLI without network access.

## Lifecycle Hooks

The installed settings register two commands:

```text
aiongside hook session-start
aiongside hook stop
```

`SessionStart` injects `.aiongside/instructions.md` and `.aiongside/rules.md`. It does not preload every work Record or supporting file.

`Stop` runs the same read-only workspace validation as `aiongside check`. A first failure blocks the agent response and returns every issue. A retry marked by the agent as an active Stop Hook reports remaining issues without blocking again.

After changing a work Record Markdown body, the managed instructions require the agent to compare and update the human-readable Overview, then run `aiongside work sync <ID>`. Sync records the reviewed Record body digest and does not generate Overview content. A stale or missing digest fails the final check.

Review and approve the project Hooks when Claude Code or Codex CLI prompts for trust. AIongside does not edit agent trust stores, user-home configuration, or global agent settings. Hooks do not access npm, install packages, update the CLI, or invoke an agent CLI.

## Existing workspaces

Install the current CLI, enter the workspace, and run:

```sh
aiongside skill sync
aiongside check
```

Earlier AIongside versions may have appended a rules reference to `AGENTS.md` or `CLAUDE.md`. The current CLI leaves that user-owned text unchanged. After the new project Hooks are approved, remove the old AIongside block manually if it is redundant.

The current work ID grammar uses an unpadded positive integer, such as `WORK-1`. Padded IDs such as `AIO-001` are not accepted or migrated automatically. Reinitialize pre-release workspaces or migrate their directories, Record metadata, Overview metadata, dependencies, and generated Views together before running mutations.
