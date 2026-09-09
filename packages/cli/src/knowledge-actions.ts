import type {
  KnowledgeMutationResult,
  MoveKnowledgeResult,
} from "@aiongside/filesystem";
import { ui } from "./ui.js";

export interface KnowledgeAction {
  kind:
    | "knowledge-removal-question"
    | "knowledge-move-review"
    | "knowledge-routing-review";
  message: string;
  paths: string[];
  commands: string[];
}

export function workKnowledgeMessage(result: KnowledgeMutationResult): string {
  const target = `${result.id} → ${result.key}${result.path ? ` (knowledge/${result.path})` : ""}`;
  const state =
    result.action === "add"
      ? result.changed
        ? "Recorded Knowledge contribution"
        : "Knowledge contribution already recorded"
      : result.changed
        ? "Removed Knowledge contribution record"
        : "Knowledge contribution record already absent";
  return `${state} — ${target}. Knowledge content was not changed.`;
}

export function workKnowledgeActions(
  result: KnowledgeMutationResult,
): KnowledgeAction[] {
  if (!result.changed || result.action === "add") return [];
  const record = `work/${result.id}/record.md`;
  const topic = result.path
    ? `knowledge/${result.path}`
    : `Knowledge key ${result.key}`;
  const followUp =
    "After approved edits, update affected index.md routing links if paths changed and check internal links with aiongside check --json.";
  return [
    {
      kind: "knowledge-removal-question",
      paths: [record, ...(result.path ? [topic] : [])],
      commands: ["aiongside check --json"],
      message: `The contribution record was removed; existing Knowledge content in ${topic} was preserved. Ask the user whether the content contributed by ${record} should also be removed. Present the exact content and impact and obtain approval before editing. Do not delete the entire topic or content whose origin is unclear. ${followUp}`,
    },
  ];
}

export function knowledgeMoveActions(
  result: MoveKnowledgeResult,
): KnowledgeAction[] {
  if (!result.applied) return [];
  return [
    {
      kind: "knowledge-move-review",
      paths: [
        `knowledge/${result.sourcePath}`,
        `knowledge/${result.destinationPath}`,
        ...result.indexPaths,
      ],
      commands: ["aiongside check --json"],
      message: `Knowledge moved from knowledge/${result.sourcePath} to knowledge/${result.destinationPath}. The key and Work relationships were preserved; document links were not rewritten. Update affected routing indexes: ${result.indexPaths.join(", ")}. Repair incoming links using this old/new path mapping and review relative links inside the moved document. If editing a done Work body, reopen it first and complete it again afterward. Run aiongside check --json. No Knowledge sync is required.`,
    },
  ];
}

export function knowledgeRoutingActions(
  paths: string[],
  reason: string,
): KnowledgeAction[] {
  return [
    {
      kind: "knowledge-routing-review",
      paths,
      commands: ["aiongside check --json"],
      message: `${reason} Update routing links and descriptions in ${paths.join(", ")} so every direct file and folder is covered. Keep knowledge content in documents, not indexes. Repair affected internal links; reopen done Work before editing its body. Run aiongside check --json.`,
    },
  ];
}

export function writePostActions(actions: KnowledgeAction[]): void {
  for (const action of actions) ui.hint(action.message);
}
