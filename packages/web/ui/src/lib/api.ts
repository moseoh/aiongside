export const WORK_STATUSES = [
  "inbox",
  "active",
  "waiting",
  "done",
  "cancelled",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const WORK_TYPES = [
  "delivery",
  "discovery",
  "decision",
  "maintenance",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

/** Status order used by the default list sort and the board columns. */
export const STATUS_ORDER: readonly WorkStatus[] = [
  "active",
  "waiting",
  "inbox",
  "done",
  "cancelled",
];

export interface Work {
  id: string;
  title: string;
  status: WorkStatus;
  type: WorkType;
  created: string;
  updated: string;
  needs: string[];
  knowledge: string[];
}

export interface WorkDetail extends Work {
  overview: string | null;
}

export interface WorksResponse {
  root: string;
  name: string;
  works: Work[];
  issues: { path: string; message: string }[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  ignored: boolean;
}

export type Document =
  | { path: string; size: number; kind: "markdown" | "text"; source: string }
  | { path: string; size: number; kind: "download" };

export type KnowledgeNode =
  | {
      kind: "directory";
      name: string;
      path: string;
      index: string | null;
      children: KnowledgeNode[];
    }
  | {
      kind: "document";
      name: string;
      path: string;
      key: string | null;
      title: string | null;
      error: string | null;
    }
  | { kind: "file"; name: string; path: string };

export interface KnowledgeResponse {
  index: string | null;
  nodes: KnowledgeNode[];
  references: Record<string, string[]>;
  issues: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(route: string, params?: Record<string, string>) {
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const response = await fetch(`/api/${route}${query}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError("Unexpected server response.", response.status);
  }
  if (!response.ok) {
    const error = (value as { error?: string }).error;
    throw new ApiError(error ?? "Request failed.", response.status);
  }
  return value as T;
}

export const api = {
  works: () => call<WorksResponse>("works"),
  work: (id: string) => call<WorkDetail>(`works/${encodeURIComponent(id)}`),
  directory: (path: string) => call<DirectoryEntry[]>("directory", { path }),
  document: (path: string) => call<Document>("document", { path }),
  knowledge: () => call<KnowledgeResponse>("knowledge"),
  downloadUrl: (path: string) =>
    `/api/download?path=${encodeURIComponent(path)}`,
};

export const WORK_ID = /^[A-Z][A-Z0-9]{1,7}-[1-9]\d*$/;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
