import { z } from "zod";
import { DocumentFormatError, parseMarkdownDocument } from "./frontmatter.js";

export const AGENT_SKILL_NAME = "aiongside";
export const CURRENT_AGENT_SKILL_VERSION = 4;

const agentSkillMetadataSchema = z
  .object({
    name: z.literal(AGENT_SKILL_NAME),
    description: z.string().trim().min(1),
    license: z.literal("MIT"),
    metadata: z
      .object({
        "aiongside-version": z.string().regex(/^[1-9]\d*$/),
      })
      .passthrough(),
  })
  .passthrough();

export interface AgentSkillInfo {
  name: typeof AGENT_SKILL_NAME;
  description: string;
  license: "MIT";
  version: number;
}

export function parseAgentSkill(source: string): AgentSkillInfo {
  const document = parseMarkdownDocument(source);
  const result = agentSkillMetadataSchema.safeParse(document.metadata);
  if (!result.success) {
    throw new DocumentFormatError(
      `Invalid Agent Skill metadata: ${result.error.issues
        .map((issue) => issue.message)
        .join(", ")}`,
    );
  }

  return {
    name: result.data.name,
    description: result.data.description,
    license: result.data.license,
    version: Number.parseInt(result.data.metadata["aiongside-version"], 10),
  };
}

export function isExactAgentSkillSource(
  actual: string,
  expected: string,
): boolean {
  return actual === expected;
}
