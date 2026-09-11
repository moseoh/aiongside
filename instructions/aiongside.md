# AIongside managed instructions

Use `aiongside` for work creation, status, dependencies, Knowledge document creation and contribution records, Work hash sync, and generated Views. Edit document bodies directly; let the CLI own metadata and generated files.

Use known commands directly. Do not read help routinely at session start or traverse parent help commands. If syntax or options are unclear, read only the relevant command's --help.

Common commands:
- Preview status change: aiongside work move <id> <status> --dry-run --json
- Apply status change: aiongside work move <id> <status> --json
- Check document integrity: aiongside check --json
- Check agent integration: aiongside doctor --json
- Open the Web View: aiongside view web --background --json

Follow command results, including reasons and recovery hints. Previewing a change does not authorize applying it; follow applicable approval rules.

After moving a Work to done, decide whether Knowledge needs its results and report the decision to the user in one line before finishing: the updated key and what was added, or why no update is needed. Do not add relationships for reference-only topics.

## Document and folder roles

The CLI creates the fixed Work structure. Write content in these locations:

- `work/<ID>/record.md`: confirmed context, scope, progress, decisions, verification, and outcomes. Summarize deliverables and link to their files.
- `work/<ID>/overview.md`: a short introduction to the Work. Keep detailed progress and outcomes in Record.
- `work/<ID>/plan.md`: the current execution plan. The CLI creates it on entry to active if absent.
- `work/<ID>/references/`: received files, external documents, and source material.
- `work/<ID>/deliverables/`: outputs produced for delivery, such as notices, reports, and presentations. Store the actual deliverable here, not only in Record.
- `work/<ID>/evidence/`: directly observed logs, command output, screenshots, and measurements.
- `knowledge/index.md` and each subfolder's `index.md`: routing descriptions with Markdown links to every direct file and folder, excluding the index itself. Read the root index first, then follow only relevant paths. Link a child folder or its index; keep knowledge content out of indexes.
- `knowledge/**/*.md` except `index.md`: individual reusable Knowledge documents. Each has a globally unique, stable `aiongside.key` in frontmatter. Folders classify documents; they have no key. Attachments need no key.
- `views/open.md` and `views/closed.md`: CLI-generated Work lists.

## Writing hints

Read HTML comments (`<!-- ... -->`) in the document being written as local writing hints. Adapt the body, headings, language, and detail to the task; hints are not required sections or completion checks.

Users can edit `.aiongside/templates/` to change the starting content of future Work documents. Existing documents are not rewritten. Keep fixed paths and CLI-owned metadata intact; file names and subfolders inside references, deliverables, and evidence are free.


Knowledge filenames and classification folders are free; preserve document keys during moves. Directly created Knowledge Markdown documents require `aiongside: { schema: 1, key: unique-key }` frontmatter. When paths change, repair the affected index routing and internal links using command results. Reopen done Work before editing sealed content.
