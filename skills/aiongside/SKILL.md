---
name: aiongside
description: Manage local AIongside work records and generated views. Use when a workspace contains .aiongside/config.yaml or the user asks to initialize or operate an AIongside workspace.
license: MIT
metadata:
  aiongside-version: "5"
---

# AIongside

## Start

1. Find the workspace root containing `.aiongside/config.yaml`.
2. Read `.aiongside/instructions.md` and `.aiongside/rules.md` completely.
3. Read the relevant `work/<ID>/record.md` before changing a work item.

Do not check for updates automatically. Run `aiongside update` only when the user explicitly asks to update AIongside.

## Commands

- Initialize: `aiongside init`
- Update the CLI and current workspace skill: `aiongside update`
- Restore the managed agent integration from the installed CLI: `aiongside skill sync`
- Create: `aiongside work new "<title>"`
- Confirm reviewed gates: `aiongside work confirm <ID> <checks...>`
- Confirm Overview review: `aiongside work sync <ID>`
- Preview move: `aiongside work move <ID> <status> --dry-run --json`
- Apply move: `aiongside work move <ID> <status> <required-options>`
- Add dependency: `aiongside work needs add <ID> <dependency-ID>`
- Remove dependency: `aiongside work needs remove <ID> <dependency-ID>`
- Cancel alias: `aiongside work cancel <ID> --cancellation-reason "<reason>"`
- Preview discard: `aiongside work discard <ID> --dry-run`
- Rebuild generated views: `aiongside view rebuild`
- Validate: `aiongside check`

Use CLI commands for creation, status changes, confirmations, dependencies, and discard. Do not edit `needs` in record frontmatter directly. Edit other record metadata only when no command exists. Do not hand-create IDs or rewrite generated view files.

Before every status change, run the JSON dry-run. Read every entry in `missingInputs`, ask the user its `question`, and pass the answer through the listed `option`. Do not write transition reasons into the customizable record body. The CLI stores them in machine-owned frontmatter.

Before moving to `done`, confirm `scope`, `completion`, `verification`, `outcome`, and `knowledge`. Dependencies in `needs` must be `done` only when the work item becomes `done`. Reopen `done` work before adding or removing a dependency.

## Record and Overview

`record.md` is the current source of work facts. `overview.md` is the short, stable entry point a person reads first.

After changing the Markdown body of `record.md`:

1. Read `overview.md` and compare it with the current Record.
2. Update the Overview body when its purpose or stable summary is no longer accurate.
3. Run `aiongside work sync <ID>` only after completing that review.

Do not run sync without reviewing the Overview. Sync records the current Record body digest; it does not generate or approve Overview content.

## Supporting content

- Store material received from outside the work in `references/`.
- Store reports, instructions, presentations, spreadsheets, exports, and other delivery outputs in `deliverables/`.
- Store logs, query results, screenshots, measurements, command output, and other direct observations in `evidence/`.

Do not impose file names, formats, or a nested structure inside these directories. Do not rewrite their contents automatically. Reopen `done` work before changing supporting content because file paths and exact bytes are covered by the completion seal.

For an older workspace, review any `reports/` content and move delivery outputs into `deliverables/`. Create `evidence/` if it is missing. Never move or delete legacy files without the user's approval.

## Knowledge

`knowledge/registry.md` is the workspace entry point for persistent Knowledge. Each registered kebab-case `Key` maps to `knowledge/<key>/overview.md`; the Registry keeps the separate human-readable `Display name`.

Treat `overview.md` as the entry point for that Knowledge. Users may add any files and nested directories below `knowledge/<key>/`; do not impose names, formats, or a fixed internal structure. Do not create default Knowledge keys or automatically rewrite, merge, or reorganize shared Knowledge. Shared Knowledge is outside every individual work completion seal.

## Discard

Discard is always a two-step operation.

1. Run `aiongside work discard <ID> --dry-run` and show the exact files, references, and trash target.
2. Stop. Run `aiongside work discard <ID> --confirm <ID>` only after the user explicitly says to proceed.

Cancellation is the default. Discard only when the work item has no history value and no incoming references.

## Finish

Run `aiongside check`. Report every remaining validation error with its path and code.
