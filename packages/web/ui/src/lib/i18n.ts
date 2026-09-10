import type { WorkStatus, WorkType } from "./api";
import { messagesKo, statusLabelsKo, typeLabelsKo } from "./messages.ko";
import { type Lang, useSettings } from "./settings";

const en = {
  appName: "AIongside",
  readOnly: "READ ONLY",
  navWork: "Work",
  navKnowledge: "Knowledge",
  footer:
    "Local files are the source of truth. This view does not edit, sync, or check your workspace.",
  refresh: "Refresh",
  live: "Live",
  paused: "Paused",
  offline: "Reconnecting",
  liveHint: "Connected. Changes apply automatically.",
  pausedHint: "Paused. Changes queue up until you resume.",
  offlineHint: "Connection lost. Reconnecting…",
  recentChanges: "Recent changes",
  noRecentChanges: "No changes yet.",
  pause: "Pause",
  resume: "Resume",
  clear: "Clear",
  changed: "changed",
  changedSinceOpened: "Changed since you last opened it",
  reload: "Reload",
  createdEvent: "created",
  deletedEvent: "deleted",
  updatedEvent: "updated",
  toggleTheme: "Toggle dark mode",
  language: "Language",
  viewList: "List",
  viewBoard: "Board",
  searchWork: "Search by ID or title",
  sort: "Sort",
  sortStatus: "Status / ID",
  sortId: "ID",
  sortUpdated: "Recently updated",
  itemsCount: "{shown} of {total} items",
  tabAll: "All",
  colId: "ID",
  colTitle: "Title",
  colStatus: "Status",
  colUpdated: "Updated",
  emptyWorks: "No matching Work items.",
  noWorks: "No Work items in this workspace.",
  issuesTitle: "Some Records could not be read",
  loading: "Loading…",
  error: "Error",
  retry: "Retry",
  breadcrumbWork: "Work",
  copyId: "Copy ID",
  copiedId: "Copied",
  tabDetail: "Details",
  tabHistory: "History",
  historyTime: "Time",
  historyTransition: "Transition",
  historyReason: "Reason",
  noHistory: "No status changes recorded.",
  reopenReason: "Reopened",
  waitingReason: "Waiting",
  resumeWhen: "Resume when",
  waitingResolution: "Resolved",
  cancellationReason: "Cancelled",
  completionInvalidated: "Completion invalidated",
  type: "Type",
  created: "Created",
  updated: "Updated",
  needs: "NEEDS",
  neededBy: "NEEDED BY",
  linkedKnowledge: "KNOWLEDGE",
  linkedWork: "LINKED WORK",
  files: "FILES",
  ignoredCount: "{count} ignored",
  showIgnored: "Show ignored files",
  hideIgnored: "Hide ignored files",
  ignoredTag: "ignored",
  download: "Download",
  downloadOnly:
    "No preview for this file. Download it to open with another application.",
  fileTooLarge: "This file is larger than 1 MiB.",
  noOverview: "This Work has no Overview yet. Open the Record instead.",
  openRecord: "Open Record",
  unsupportedLink: "Outside supported browsing",
  externalImage: "External image (not loaded)",
  workNotFound: "Work not found or cannot be read.",
  backToList: "Back to Work list",
  fileNotFound: "File not found or cannot be read. Reload to retry.",
  relationError: "Cannot read this Work.",
  knowledgeMissing: "Knowledge key not found",
  knowledgeTree: "KNOWLEDGE",
  searchKnowledge: "Search knowledge",
  knowledgeEmpty: "No Knowledge documents.",
  knowledgeIndex: "Folder index",
  knowledgeNoIndex: "This folder has no index.md.",
  knowledgeNotFound: "Document not found.",
  knowledgeInvalid: "Invalid Knowledge document",
  key: "key",
  size: "{size}",
  sizeKb: "{n} KB",
  sizeMb: "{n} MB",
  sizeB: "{n} B",
  markdown: "Markdown",
  text: "Text",
  file: "File",
  today: "Today",
  yesterday: "Yesterday",
};
export type MessageKey = keyof typeof en;

const dictionaries: Record<Lang, Record<MessageKey, string>> = {
  en,
  ko: messagesKo,
};

const statusLabels: Record<Lang, Record<WorkStatus, string>> = {
  en: {
    inbox: "Inbox",
    active: "Active",
    waiting: "Waiting",
    done: "Done",
    cancelled: "Cancelled",
  },
  ko: statusLabelsKo,
};

const typeLabels: Record<Lang, Record<WorkType, string>> = {
  en: {
    delivery: "Delivery",
    discovery: "Discovery",
    decision: "Decision",
    maintenance: "Maintenance",
  },
  ko: typeLabelsKo,
};

export function translate(
  lang: Lang,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = dictionaries[lang][key] ?? en[key];
  return params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match,
      )
    : template;
}

export function statusLabel(lang: Lang, status: WorkStatus): string {
  return statusLabels[lang][status] ?? status;
}

export function typeLabel(lang: Lang, type: string): string {
  return typeLabels[lang][type as WorkType] ?? type;
}

const DAY = 86_400_000;

/** ISO date (YYYY-MM-DD) or timestamp → relative within a week, else a date. */
export function formatDate(lang: Lang, iso: string, now = Date.now()): string {
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso,
  );
  if (Number.isNaN(date.getTime())) return iso;
  const locale = lang === "ko" ? "ko-KR" : "en-US";
  const days = Math.round((startOfDay(now) - startOfDay(date.getTime())) / DAY);
  if (days === 0) return translate(lang, "today");
  if (days === 1) return translate(lang, "yesterday");
  if (days > 1 && days < 7)
    return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(
      -days,
      "day",
    );
  return new Intl.DateTimeFormat(locale, {
    year:
      new Date(now).getFullYear() === date.getFullYear()
        ? undefined
        : "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatFullDate(lang: Lang, iso: string): string {
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso,
  );
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/** ISO timestamp → local date and time, e.g. 2026-09-04 15:30. */
export function formatDateTime(lang: Lang, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatElapsed(
  lang: Lang,
  from: number,
  now = Date.now(),
): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  const locale = lang === "ko" ? "ko-KR" : "en-US";
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 60) return format.format(-seconds, "second");
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  return format.format(-Math.round(seconds / 3600), "hour");
}

export function formatSize(lang: Lang, bytes: number): string {
  if (bytes >= 1024 * 1024)
    return translate(lang, "sizeMb", { n: (bytes / 1024 / 1024).toFixed(1) });
  if (bytes >= 1024)
    return translate(lang, "sizeKb", { n: (bytes / 1024).toFixed(1) });
  return translate(lang, "sizeB", { n: bytes });
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function useT() {
  const { lang } = useSettings();
  return {
    lang,
    t: (key: MessageKey, params?: Record<string, string | number>) =>
      translate(lang, key, params),
    status: (status: WorkStatus) => statusLabel(lang, status),
    type: (type: string) => typeLabel(lang, type),
    date: (iso: string) => formatDate(lang, iso),
    fullDate: (iso: string) => formatFullDate(lang, iso),
    dateTime: (iso: string) => formatDateTime(lang, iso),
    size: (bytes: number) => formatSize(lang, bytes),
  };
}
