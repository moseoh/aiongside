import { useEffect, useSyncExternalStore } from "react";
import {
  api,
  errorMessage,
  type KnowledgeNode,
  type KnowledgeResponse,
} from "./api";
import { useWorks } from "./works";

export interface KnowledgeState {
  status: "idle" | "loading" | "ready" | "error";
  data: KnowledgeResponse | null;
  error: string | null;
  generation: number;
}

let state: KnowledgeState = {
  status: "idle",
  data: null,
  error: null,
  generation: -1,
};
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(patch: Partial<KnowledgeState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function load(generation: number): Promise<void> {
  if (inflight) return inflight;
  set({ status: "loading", error: null, generation });
  inflight = api
    .knowledge()
    .then((data) => set({ status: "ready", data }))
    .catch((error) => set({ status: "error", error: errorMessage(error) }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Loads the Knowledge tree on first use and again after every Work refresh. */
export function useKnowledge(): KnowledgeState {
  const { generation } = useWorks();
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  useEffect(() => {
    if (generation > 0 && state.generation !== generation)
      void load(generation);
  }, [generation]);
  return value;
}

export interface KnowledgeDocument {
  key: string;
  title: string;
  path: string;
}

export function flattenDocuments(nodes: KnowledgeNode[]): KnowledgeDocument[] {
  const out: KnowledgeDocument[] = [];
  const visit = (items: KnowledgeNode[]) => {
    for (const node of items) {
      if (node.kind === "directory") visit(node.children);
      else if (node.kind === "document" && node.key && node.title)
        out.push({ key: node.key, title: node.title, path: node.path });
    }
  };
  visit(nodes);
  return out;
}

export function findNode(
  nodes: KnowledgeNode[],
  path: string,
): KnowledgeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "directory") {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}
