---
name: aiongside
description: Manage local AIongside work Records and generated Views. Use when a workspace contains .aiongside/config.yaml or the user asks to initialize or operate an AIongside workspace.
---

# AIongside

## Start

1. Find the workspace root containing `.aiongside/config.yaml`.
2. Read `.aiongside/rules.md` completely.
3. Read the relevant `work/<ID>/record.md` before changing a work item.

## Commands

- Initialize: `aiongside init`
- Create: `aiongside work new "<title>"`
- Confirm reviewed gates: `aiongside work confirm <ID> <checks...>`
- Preview move: `aiongside work move <ID> <status> --dry-run --json`
- Apply move: `aiongside work move <ID> <status> <required-options>`
- Add dependency: `aiongside work needs add <ID> <dependency-ID>`
- Remove dependency: `aiongside work needs remove <ID> <dependency-ID>`
- Cancel alias: `aiongside work cancel <ID> --cancellation-reason "<reason>"`
- Preview discard: `aiongside work discard <ID> --dry-run`
- Rebuild generated Views: `aiongside view rebuild`
- Validate: `aiongside check`

Use CLI commands for creation, status changes, confirmations, dependencies, and discard. Do not edit `needs` in Record frontmatter directly. Edit other Record metadata only when no command exists. Do not hand-create IDs or rewrite generated View files.

Before every status change, run the JSON dry-run. Read every entry in `missingInputs`, ask the user its `question`, and pass the answer through the listed `option`. Do not write transition reasons into the customizable Record body; the CLI stores them in machine-owned frontmatter.

Before moving to `done`, confirm `scope`, `completion`, `verification`, `outcome`, and `knowledge`. Dependencies in `needs` must be `done` only when the work item becomes `done`. Reopen `done` work before adding or removing a dependency.

## Supporting content

- Store material received from outside the work in `references/`.
- Store reports, instructions, presentations, spreadsheets, exports, and other delivery outputs in `deliverables/`.
- Store logs, query results, screenshots, measurements, command output, and other direct observations in `evidence/`.

Do not impose file names, formats, or a nested structure inside these directories. Do not rewrite their contents automatically. Reopen `done` work before changing supporting content because file paths and exact bytes are covered by the completion seal.

For an older workspace, review any `reports/` content and move delivery outputs into `deliverables/`. Create `evidence/` if it is missing. Never move or delete legacy files without the user's approval.

## Discard

Discard is always a two-step operation.

1. Run `aiongside work discard <ID> --dry-run` and show the exact files, references, and trash target.
2. Stop. Run `aiongside work discard <ID> --confirm <ID>` only after the user explicitly says to proceed.

Cancellation is the default. Discard only when the work item has no history value and no incoming references.

## Finish

Run `aiongside check`. Report every remaining validation error with its path and code.
