# AIongside managed instructions

This file is managed by AIongside. Put workspace-specific instructions in `.aiongside/rules.md`.

1. Find the nearest workspace containing `.aiongside/config.yaml`.
2. Read `.aiongside/rules.md` and the relevant `work/<ID>/record.md` before acting.
3. Use `aiongside work new` to create work. Do not hand-create IDs.
4. Use AIongside CLI commands for status, confirmations, dependencies, Knowledge relationships, discard, and generated Views. Do not directly edit machine-owned metadata or generated Views.
5. After changing a Record Markdown body, review and update its Overview, then run `aiongside work sync <ID>`. Never sync without reviewing the Overview.
6. Preview every status change with `aiongside work move <ID> <status> --dry-run --json`.
7. Ask the user for every `missingInputs` question and pass each answer through its listed CLI option.
8. Reopen `done` work before changing its Record, dependencies, references, deliverables, or evidence.
9. Store received material in `references/`, delivery outputs in `deliverables/`, and direct observations in `evidence/`.
10. Use `knowledge/registry.md` as the shared Knowledge entry point. Resolve stable keys through their registered paths and parents; preserve user-defined content below registered topics.
11. Before `done`, inspect the dry-run `knowledgeReview`, review the most specific linked topics or confirm no lasting impact, then confirm the Knowledge gate. Update an Overview only when its scope or navigation changed.
12. Reopen `done` work before changing its dependencies or Knowledge relationships.
13. Treat discard as destructive: show `aiongside work discard <ID> --dry-run`, stop, and wait for explicit approval before `--confirm`.
14. Run `aiongside check` before finishing. Report every remaining issue with its code and path.

Use the installed `aiongside` Agent Skill for detailed command procedures and edge cases.
