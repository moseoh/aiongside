import { z } from "zod";

export const WORK_STATUSES = [
  "inbox",
  "ready",
  "active",
  "verify",
  "waiting",
  "done",
  "cancelled",
] as const;

export const MOVABLE_STATUSES = [
  "inbox",
  "ready",
  "active",
  "verify",
  "waiting",
  "done",
] as const;

export const WORK_TYPES = [
  "delivery",
  "discovery",
  "decision",
  "maintenance",
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

export const workspaceConfigSchema = z.object({
  schema: z.literal(1),
  name: z.string().trim().min(1),
  idPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/),
});

export const workRecordSchema = z.object({
  schema: z.literal(1),
  id: z.string().regex(/^[A-Z][A-Z0-9]{1,7}-\d{3,}$/),
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
  needs: z.array(z.string()).default([]),
});

export const briefMetadataSchema = z.object({
  schema: z.literal(1),
  id: z.string().regex(/^[A-Z][A-Z0-9]{1,7}-\d{3,}$/),
  title: z.string().trim().min(1),
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type WorkRecord = z.infer<typeof workRecordSchema>;
export type WorkStatus = WorkRecord["status"];
export type MovableStatus = (typeof MOVABLE_STATUSES)[number];
export type WorkType = WorkRecord["type"];

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  hint?: string;
}

export function isMovableStatus(value: string): value is MovableStatus {
  return (MOVABLE_STATUSES as readonly string[]).includes(value);
}

export function idNumber(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number.parseInt(match[1] ?? "", 10) : Number.MAX_SAFE_INTEGER;
}
