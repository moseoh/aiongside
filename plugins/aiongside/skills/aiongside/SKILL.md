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
- Move: `aiongside work move <ID> <status>`
- Cancel and retain history: `aiongside work cancel <ID>`
- Preview discard: `aiongside work discard <ID> --dry-run`
- Rebuild generated Views: `aiongside view rebuild`
- Validate: `aiongside check`

Use CLI commands for metadata and status changes. Do not hand-create IDs or rewrite generated View files.

## Discard

Discard is always a two-step operation.

1. Run `aiongside work discard <ID> --dry-run` and show the exact files, references, and trash target.
2. Stop. Run `aiongside work discard <ID> --confirm <ID>` only after the user explicitly says to proceed.

Cancellation is the default. Discard only when the work item has no history value and no incoming references.

## Finish

Run `aiongside check`. Report every remaining validation error with its path and code.
