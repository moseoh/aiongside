import { z } from "zod";

export const WORK_STATUSES = [
  "inbox",
  "active",
  "waiting",
  "done",
  "cancelled",
] as const;

export const MOVABLE_STATUSES = WORK_STATUSES;

export const WORK_TYPES = [
  "delivery",
  "discovery",
  "decision",
  "maintenance",
] as const;

export const WORK_CHECKS = [
  "scope",
  "completion",
  "verification",
  "outcome",
  "knowledge",
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must use YYYY-MM-DD format")
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return (
        !Number.isNaN(parsed.valueOf()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    },
    { message: "Must be a valid date" },
  );

const isoTimestamp = z.string().datetime({ offset: true });
const workId = z.string().regex(/^[A-Z][A-Z0-9]{1,7}-[1-9]\d*$/);
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const workspaceConfigSchema = z.object({
  schema: z.literal(1),
  name: z.string().trim().min(1),
  idPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/),
  agentSkillVersion: z.number().int().positive().optional(),
});

export const workChecksSchema = z.object({
  scope: z.boolean(),
  completion: z.boolean(),
  verification: z.boolean(),
  outcome: z.boolean(),
  knowledge: z.boolean(),
});

export const workTransitionSchema = z.object({
  at: isoTimestamp,
  from: z.enum(WORK_STATUSES),
  to: z.enum(WORK_STATUSES),
  reopenReason: z.string().trim().min(1).optional(),
  waitingReason: z.string().trim().min(1).optional(),
  resumeWhen: z.string().trim().min(1).optional(),
  waitingResolution: z.string().trim().min(1).optional(),
  cancellationReason: z.string().trim().min(1).optional(),
  completionInvalidated: z.boolean().optional(),
});

export const completionSealSchema = z.object({
  completedAt: isoTimestamp,
  digest: sha256Digest,
});

export const workMetadataSchema = z.object({
  schema: z.literal(1),
  id: workId,
  title: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), {
      message: "Title must not contain a line break",
    }),
  status: z.enum(WORK_STATUSES),
  type: z.enum(WORK_TYPES),
  created: isoDate,
  updated: isoDate,
  needs: z.array(workId).default([]),
  checks: workChecksSchema,
  transitions: z.array(workTransitionSchema).default([]),
  completionSeal: completionSealSchema.nullable().default(null),
});

export const overviewMetadataSchema = z.object({
  schema: z.literal(1),
  id: workId,
  title: z.string().trim().min(1),
  recordBodyDigest: sha256Digest.optional(),
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type WorkMetadata = z.infer<typeof workMetadataSchema>;
export type WorkStatus = WorkMetadata["status"];
export type MovableStatus = (typeof MOVABLE_STATUSES)[number];
export type WorkType = WorkMetadata["type"];
export type WorkCheck = (typeof WORK_CHECKS)[number];
export type WorkTransition = z.infer<typeof workTransitionSchema>;
export type CompletionSeal = z.infer<typeof completionSealSchema>;

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  hint?: string;
}

export function isMovableStatus(value: string): value is MovableStatus {
  return (MOVABLE_STATUSES as readonly string[]).includes(value);
}

export function isWorkCheck(value: string): value is WorkCheck {
  return (WORK_CHECKS as readonly string[]).includes(value);
}

export function idNumber(id: string): bigint {
  const match = /-([1-9]\d*)$/.exec(id);
  return match ? BigInt(match[1] ?? "0") : 0n;
}

export function compareWorkIds(left: string, right: string): number {
  const leftNumber = idNumber(left);
  const rightNumber = idNumber(right);
  if (leftNumber < rightNumber) {
    return -1;
  }
  if (leftNumber > rightNumber) {
    return 1;
  }
  return left.localeCompare(right);
}
