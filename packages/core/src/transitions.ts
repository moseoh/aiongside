import type { WorkStatus } from "./model.js";

export const TRANSITION_REQUIREMENTS = ["W", "E", "D", "C", "R", "I"] as const;

export type TransitionRequirement = (typeof TRANSITION_REQUIREMENTS)[number];

export type TransitionInputKey =
  | "reopenReason"
  | "waitingReason"
  | "resumeWhen"
  | "waitingResolution"
  | "cancellationReason";

export interface TransitionInputDefinition {
  key: TransitionInputKey;
  option: string;
  question: string;
}

export interface TransitionRule {
  from: WorkStatus;
  to: WorkStatus;
  requirements: TransitionRequirement[];
  requiredInputs: TransitionInputDefinition[];
  invalidatesCompletion: boolean;
  noOp: boolean;
}

export interface TransitionInputValues {
  reopenReason?: string;
  waitingReason?: string;
  resumeWhen?: string;
  waitingResolution?: string;
  cancellationReason?: string;
}

export interface TransitionRequiredInput {
  key: string;
  source: "option" | "record";
  option?: string;
  question: string;
  code: string;
  hint?: string;
}

export interface TransitionResult {
  id: string;
  from: WorkStatus;
  to: WorkStatus;
  requirements: TransitionRequirement[];
  requiredInputs: TransitionRequiredInput[];
  missingInputs: TransitionRequiredInput[];
  warnings: string[];
  changes: string[];
  invalidatesCompletion: boolean;
  canMove: boolean;
  applied: boolean;
}

const INPUTS: Record<
  Exclude<TransitionRequirement, "D" | "I">,
  readonly TransitionInputDefinition[]
> = {
  W: [
    {
      key: "waitingReason",
      option: "--waiting-reason",
      question: "Why is this work waiting?",
    },
    {
      key: "resumeWhen",
      option: "--resume-when",
      question: "What condition will allow this work to resume?",
    },
  ],
  E: [
    {
      key: "waitingResolution",
      option: "--waiting-resolution",
      question: "What ended or resolved the wait?",
    },
  ],
  C: [
    {
      key: "cancellationReason",
      option: "--cancellation-reason",
      question: "Why is this work being cancelled?",
    },
  ],
  R: [
    {
      key: "reopenReason",
      option: "--reopen-reason",
      question:
        "Why is this completed or cancelled work being reopened or corrected?",
    },
  ],
};

export function evaluateTransition(
  from: WorkStatus,
  to: WorkStatus,
): TransitionRule {
  if (from === to) {
    return {
      from,
      to,
      requirements: [],
      requiredInputs: [],
      invalidatesCompletion: false,
      noOp: true,
    };
  }

  const requirements: TransitionRequirement[] = [];
  if (from === "done" && to !== "done" && to !== "cancelled") {
    requirements.push("R");
  }
  if (from === "cancelled" && to !== "cancelled") {
    requirements.push("R");
  }
  if (from === "waiting" && to !== "waiting" && to !== "cancelled") {
    requirements.push("E");
  }
  if (to === "waiting") {
    requirements.push("W");
  }
  if (to === "done") {
    requirements.push("D");
  }
  if (to === "cancelled") {
    requirements.push("C");
  }
  if (from === "done" && to !== "done") {
    requirements.push("I");
  }

  const requiredInputs = requirements.flatMap((requirement) =>
    requirement === "D" || requirement === "I" ? [] : INPUTS[requirement],
  );

  return {
    from,
    to,
    requirements,
    requiredInputs,
    invalidatesCompletion: requirements.includes("I"),
    noOp: false,
  };
}
