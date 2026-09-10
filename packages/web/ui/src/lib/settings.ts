import { useSyncExternalStore } from "react";
import type { WorkStatus } from "./api";

export type Lang = "en" | "ko";
export type Theme = "light" | "dark";
export type ViewMode = "list" | "board";
export type SortKey = "status" | "id" | "updated";

export interface Settings {
  lang: Lang;
  theme: Theme;
  view: ViewMode;
  sortList: SortKey;
  sortBoard: SortKey;
  statusTab: WorkStatus | "all";
  showIgnored: boolean;
  /** Expanded folder paths per Work, newest Work last; capped at EXPANDED_LIMIT. */
  expanded: Record<string, string[]>;
  knowledgeExpanded: string[];
  /** False while the user paused live updates. */
  live: boolean;
}

const KEY = "aiongside.web.v1";
export const EXPANDED_LIMIT = 50;

function systemLang(): Lang {
  const language =
    typeof navigator === "undefined" ? "en" : navigator.language || "en";
  return language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function systemTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function defaults(): Settings {
  return {
    lang: systemLang(),
    theme: systemTheme(),
    view: "list",
    sortList: "status",
    sortBoard: "updated",
    statusTab: "all",
    showIgnored: false,
    expanded: {},
    knowledgeExpanded: [],
    live: true,
  };
}

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown, fallback: T): T =>
    values.includes(value as T) ? (value as T) : fallback;
const lang = oneOf<Lang>(["en", "ko"]);
const theme = oneOf<Theme>(["light", "dark"]);
const view = oneOf<ViewMode>(["list", "board"]);
const sort = oneOf<SortKey>(["status", "id", "updated"]);
const tab = oneOf<Settings["statusTab"]>([
  "all",
  "inbox",
  "active",
  "waiting",
  "done",
  "cancelled",
]);

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Every field is validated independently so one bad value never drops the rest. */
function sanitize(raw: unknown): Settings {
  const base = defaults();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Record<string, unknown>;
  const expanded: Record<string, string[]> = {};
  if (value.expanded && typeof value.expanded === "object") {
    for (const [id, paths] of Object.entries(
      value.expanded as Record<string, unknown>,
    ))
      expanded[id] = stringList(paths);
  }
  return {
    lang: lang(value.lang, base.lang),
    theme: theme(value.theme, base.theme),
    view: view(value.view, base.view),
    sortList: sort(value.sortList, base.sortList),
    sortBoard: sort(value.sortBoard, base.sortBoard),
    statusTab: tab(value.statusTab, base.statusTab),
    showIgnored: value.showIgnored === true,
    expanded,
    knowledgeExpanded: stringList(value.knowledgeExpanded),
    live: value.live !== false,
  };
}

function load(): Settings {
  try {
    const stored = localStorage.getItem(KEY);
    return stored ? sanitize(JSON.parse(stored)) : defaults();
  } catch {
    return defaults();
  }
}

let current: Settings = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Private mode or quota: keep the in-memory value. */
  }
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  persist();
  for (const listener of listeners) listener();
}

export function setExpanded(workId: string, paths: string[]) {
  const next = { ...current.expanded };
  delete next[workId];
  next[workId] = paths;
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - EXPANDED_LIMIT)))
    delete next[id];
  updateSettings({ expanded: next });
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function getSettings(): Settings {
  return current;
}
