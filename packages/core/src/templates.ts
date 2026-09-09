import { formatMarkdownDocument } from "./frontmatter.js";
import type { WorkMetadata } from "./model.js";

export const TEMPLATE_NAMES = ["record", "overview", "plan"] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface TemplateDefinition {
  file: `${TemplateName}.md`;
  contents: string;
}

export const TEMPLATE_DEFINITIONS: Record<TemplateName, TemplateDefinition> = {
  record: {
    file: "record.md",
    contents: `# {{title}}

## Context

<!-- Describe the confirmed context. -->

## Scope

<!-- Describe included work and explicit exclusions. -->

## Completion criteria

<!-- Describe the requested, verifiable outcome. -->

## Progress

<!-- Record confirmed facts and decisions. -->

## Verification

<!-- Record the verification method and observed result. -->

## Outcome

<!-- Summarize the result, link to deliverables, and note remaining work. -->

`,
  },
  overview: {
    file: "overview.md",
    contents: `# {{title}}

## Purpose

<!-- Explain what this work item is and why it matters. -->
`,
  },
  plan: {
    file: "plan.md",
    contents: `# Execution plan

## Assumptions

<!-- Record assumptions relevant to the current plan. -->

## Current execution

<!-- Describe the planned actions and how to verify their results. -->

## Stop conditions

<!-- Note conditions that require stopping or revising the plan. -->
`,
  },
};

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
