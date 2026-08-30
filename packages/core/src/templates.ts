import { formatMarkdownDocument } from "./frontmatter.js";
import type { WorkMetadata } from "./model.js";

export const TEMPLATE_NAMES = ["record", "overview", "plan"] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface TemplateDefinition {
  file: `${TemplateName}.md`;
  contents: string;
  requiredPlaceholders: readonly string[];
}

export const TEMPLATE_DEFINITIONS: Record<TemplateName, TemplateDefinition> = {
  record: {
    file: "record.md",
    requiredPlaceholders: ["title"],
    contents: `# {{title}}

Machine-owned status, transition history, and completion seals are stored in frontmatter. Keep the work narrative below.

## Context

Describe the confirmed context.

## Scope

- Included work

## Completion criteria

- [ ] A verifiable outcome

## Progress

Record confirmed facts and decisions.

## Verification

Record the verification method and observed result.

## Outcome

Record the result and remaining work.

## Knowledge review

Record what persistent knowledge changed, or why no update was needed.
`,
  },
  overview: {
    file: "overview.md",
    requiredPlaceholders: ["title"],
    contents: `# {{title}}

## Purpose

Explain what this work item is and why it matters.

Keep status, progress, decisions, and outcomes in \`record.md\`.
`,
  },
  plan: {
    file: "plan.md",
    requiredPlaceholders: [],
    contents: `# Execution plan

## Assumptions

- A fact that must remain true for this plan to work

## Current execution

1. Planned change
2. Verification method

## Stop conditions

- A condition that requires stopping or reverting the work
`,
  },
};

export function validateTemplate(name: TemplateName, source: string): string[] {
  const definition = TEMPLATE_DEFINITIONS[name];
  const issues: string[] = [];
  const placeholders = [...source.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(
    (match) => match[1] ?? "",
  );

  for (const required of definition.requiredPlaceholders) {
    if (!placeholders.includes(required)) {
      issues.push(`Missing required placeholder: {{${required}}}`);
    }
  }
  for (const placeholder of new Set(placeholders)) {
    if (placeholder !== "title") {
      issues.push(`Unsupported placeholder: {{${placeholder}}}`);
    }
  }
  return issues;
}

export function renderTemplate(
  source: string,
  variables: { title?: string } = {},
): string {
  let rendered = source.replaceAll("\r\n", "\n");
  if (variables.title !== undefined) {
    rendered = rendered.replace(
      /\{\{\s*title\s*\}\}/g,
      () => variables.title ?? "",
    );
  }
  return rendered;
}

export function createRecordDocument(
  metadata: WorkMetadata,
  template = TEMPLATE_DEFINITIONS.record.contents,
): string {
  return formatMarkdownDocument(
    metadata,
    renderTemplate(template, { title: metadata.title }),
  );
}

export function createOverviewDocument(
  metadata: WorkMetadata,
  recordBodyDigest: string,
  template = TEMPLATE_DEFINITIONS.overview.contents,
): string {
  return formatMarkdownDocument(
    {
      schema: 1,
      id: metadata.id,
      title: metadata.title,
      recordBodyDigest,
    },
    renderTemplate(template, { title: metadata.title }),
  );
}

export function createPlanDocument(
  template = TEMPLATE_DEFINITIONS.plan.contents,
  title?: string,
): string {
  return `${renderTemplate(template, { ...(title ? { title } : {}) }).trimEnd()}\n`;
}

export function createRulesDocument(): string {
  return `# Workspace rules

Add workspace-specific instructions below. AIongside preserves this file during sync and update.
`;
}
