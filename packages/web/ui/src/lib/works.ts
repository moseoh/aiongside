import { useEffect, useSyncExternalStore } from "react";
import { api, errorMessage, type Work, type WorksResponse } from "./api";

export interface WorksState {
  status: "idle" | "loading" | "ready" | "error";
  data: WorksResponse | null;
  error: string | null;
  loadedAt: number | null;
  /** Bumped on every refresh so dependent views re-fetch their documents. */
  generation: number;
}

let state: WorksState = {
  status: "idle",
  data: null,
  error: null,
  loadedAt: null,
  generation: 0,
};
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(patch: Partial<WorksState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function refreshWorks(): Promise<void> {
  if (inflight) return inflight;
  set({ status: "loading", error: null });
  inflight = api
    .works()
    .then((data) =>
      set({
        status: "ready",
        data,
        loadedAt: Date.now(),
        generation: state.generation + 1,
      }),
    )
    .catch((error) =>
      set({
        status: "error",
        error: errorMessage(error),
        generation: state.generation + 1,
      }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useWorks(): WorksState {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
  useEffect(() => {
    if (state.status === "idle") void refreshWorks();
  }, []);
  return value;
}

export function workById(data: WorksResponse | null, id: string): Work | null {
  return data?.works.find((work) => work.id === id) ?? null;
}

export function neededBy(data: WorksResponse | null, id: string): Work[] {
  return data?.works.filter((work) => work.needs.includes(id)) ?? [];
}
