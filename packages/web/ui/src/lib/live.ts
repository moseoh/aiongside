import { useEffect, useSyncExternalStore } from "react";
import type { ChangeEvent } from "./api";
import { getSettings, updateSettings } from "./settings";

export type LiveStatus = "live" | "paused" | "offline" | "unsupported";

export interface LiveState {
  status: LiveStatus;
  /** Newest first, capped at QUEUE_LIMIT. */
  recent: ChangeEvent[];
  /** Changes received since the user last opened the recent list. */
  unseen: number;
  /** Paths changed after they were last opened in this tab. */
  changed: ReadonlySet<string>;
  /** Bumped when the server asks for a full reload. */
  resyncs: number;
}

export const QUEUE_LIMIT = 100;
const APPLY_DEBOUNCE_MS = 500;

export interface ApplyMeta {
  /** True for the batch released by Resume; toasts stay quiet for it. */
  resumed: boolean;
}
type Handler = (events: ChangeEvent[], meta: ApplyMeta) => void;

let state: LiveState = {
  status: getSettings().live ? "live" : "paused",
  recent: [],
  unseen: 0,
  changed: new Set(),
  resyncs: 0,
};
const listeners = new Set<() => void>();
const handlers = new Set<Handler>();
/** Events held back while paused, oldest first. */
let held: ChangeEvent[] = [];
/** Events waiting for the apply debounce, oldest first. */
let pendingApply: ChangeEvent[] = [];
let applyTimer: ReturnType<typeof setTimeout> | undefined;
const opened = new Map<string, number>();
let source: EventSource | null = null;

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function dispatch(events: ChangeEvent[]) {
  pendingApply.push(...events);
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = undefined;
    const batch = pendingApply;
    pendingApply = [];
    for (const handler of handlers) handler(batch, { resumed: false });
  }, APPLY_DEBOUNCE_MS);
}

function receive(event: ChangeEvent) {
  const changed = new Set(state.changed);
  const openedAt = opened.get(event.path);
  if (openedAt === undefined || Date.parse(event.at) > openedAt)
    changed.add(event.path);
  set({
    recent: [event, ...state.recent].slice(0, QUEUE_LIMIT),
    unseen: state.unseen + 1,
    changed,
  });
  if (state.status === "paused") held.push(event);
  else dispatch([event]);
}

function connect() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  source.addEventListener("state", (message) => {
    const data = JSON.parse((message as MessageEvent).data) as {
      state: "live" | "unsupported";
      resync?: boolean;
    };
    if (data.state === "unsupported") {
      set({ status: "unsupported" });
      source?.close();
      source = null;
      return;
    }
    set({
      status: getSettings().live ? "live" : "paused",
      ...(data.resync ? { resyncs: state.resyncs + 1 } : {}),
    });
  });
  source.addEventListener("change", (message) => {
    receive(JSON.parse((message as MessageEvent).data) as ChangeEvent);
  });
  source.onerror = () => {
    if (state.status !== "unsupported") set({ status: "offline" });
  };
}

/** Opens the event stream once per tab. */
export function useLiveConnection() {
  useEffect(() => {
    connect();
  }, []);
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Receives applied change batches; paused changes arrive together on resume. */
export function useLiveSubscription(handler: Handler) {
  useEffect(() => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }, [handler]);
}

export function pauseLive() {
  updateSettings({ live: false });
  if (state.status === "live") set({ status: "paused" });
}

export function resumeLive() {
  updateSettings({ live: true });
  if (state.status !== "paused") return;
  set({ status: source ? "live" : "offline" });
  const batch = held;
  held = [];
  if (batch.length)
    for (const handler of handlers) handler(batch, { resumed: true });
}

export function markSeen() {
  if (state.unseen) set({ unseen: 0 });
}

export function clearRecent() {
  set({ recent: [], unseen: 0 });
}

/** Records that a path is on screen with fresh content, clearing its mark. */
export function markOpened(path: string) {
  opened.set(path, Date.now());
  if (!state.changed.has(path)) return;
  const changed = new Set(state.changed);
  changed.delete(path);
  set({ changed });
}
