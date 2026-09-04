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
10. Do not preload all Knowledge. Use `aiongside knowledge list`, `tree`, and `show` to explore only relevant registered topics.
11. Use `aiongside knowledge new` to create a topic or register existing content. Do not directly add Registry rows or registered directories.
12. Preview every Knowledge move with `aiongside knowledge move <key> --path <path> --dry-run --json`. Show moved and stale keys, stop for explicit approval, then apply the same options. Do not rewrite links automatically.
13. Preview every Knowledge discard with `aiongside knowledge discard <key> --dry-run`. Show children, Work references, and recovery target, stop for explicit approval, then pass the exact key through `--confirm`.
14. Add the most specific Work Knowledge key only when the Work changes persistent Knowledge or requires revalidation. Do not add topics that were merely consulted. Ask the user when impact is unclear.
15. After changing content owned by a registered topic, review its Overview and relevant content, update navigation when needed, then run `aiongside knowledge sync <key>`. Never sync automatically or without review.
16. Before `done`, inspect every dry-run `knowledgeReview` target and freshness value, resolve stale topics, or confirm no lasting impact, then confirm the Knowledge gate.
17. Reopen `done` work before changing its dependencies or Knowledge relationships.
18. Treat Work discard as destructive: show `aiongside work discard <ID> --dry-run`, stop, and wait for explicit approval before `--confirm`.
19. Run `aiongside check` before finishing. Report every remaining issue with its code and path.

Use the installed `aiongside` Agent Skill for detailed command procedures and edge cases.
