import { ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { statusDot } from "@/components/StatusBadge";
import type { ChangeEvent, WorkStatus } from "@/lib/api";
import { formatElapsed, useT } from "@/lib/i18n";
import { routeForPath } from "@/lib/links";
import {
  clearRecent,
  markSeen,
  pauseLive,
  resumeLive,
  useLive,
} from "@/lib/live";
import { cn } from "@/lib/utils";

const dotTone = {
  live: "bg-s-active",
  paused: "bg-ring",
  offline: "bg-s-waiting",
  unsupported: "bg-ring",
} as const;

/** Route for an event: its Work, or the Knowledge document it touched. */
function eventRoute(event: ChangeEvent): string {
  if (event.scope === "work" && event.work) return `/work/${event.work}`;
  return routeForPath(event.path) ?? "/knowledge";
}

export function StatusShift({ status }: { status: ChangeEvent["status"] }) {
  const { status: label } = useT();
  if (!status) return null;
  const to = status.to as WorkStatus;
  return (
    <span className="inline-flex items-center gap-1.5">
      {status.from ? (
        <>
          <span className="font-mono text-[11px] text-muted-foreground line-through decoration-ring">
            {label(status.from as WorkStatus)}
          </span>
          <ArrowRightIcon className="size-3 text-muted-foreground" />
        </>
      ) : null}
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className={cn("size-1.5 rounded-full", statusDot[to])} />
        {label(to)}
      </span>
    </span>
  );
}

/** ID · title · file · transition, shared by the recent list and toasts. */
export function ChangeSummary({
  event,
  now,
}: {
  event: ChangeEvent;
  now?: number;
}) {
  const { t, lang } = useT();
  const file = event.path.split("/").slice(2).join("/") || event.path;
  return (
    <>
      <span className="font-mono text-[11px] text-muted-foreground">
        {event.scope === "work" ? event.work : t("navKnowledge")}
      </span>
      <div className="truncate text-[13px] font-medium text-foreground">
        {event.title ?? event.path}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <code className="rounded border bg-muted px-1 font-mono text-[11px]">
          {file}
        </code>
        {event.status ? (
          <StatusShift status={event.status} />
        ) : (
          <span>
            {event.kind === "created"
              ? t("createdEvent")
              : event.kind === "deleted"
                ? t("deletedEvent")
                : t("updatedEvent")}
          </span>
        )}
        {now !== undefined ? (
          <span className="ml-auto whitespace-nowrap text-[11px]">
            {formatElapsed(lang, Date.parse(event.at), now)}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** Header control: connection state, unseen count, and the recent change list. */
export function LiveMenu() {
  const { t } = useT();
  const live = useLive();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    markSeen();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (live.status === "unsupported") return null;
  const label =
    live.status === "offline"
      ? t("offline")
      : live.status === "paused"
        ? t("paused")
        : t("live");
  const hint =
    live.status === "offline"
      ? t("offlineHint")
      : live.status === "paused"
        ? t("pausedHint")
        : t("liveHint");
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex h-8 cursor-pointer items-center gap-2 rounded-md border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent"
        title={hint}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        data-testid="live"
        data-live-status={live.status}
      >
        <span className="relative size-[7px]">
          <span
            className={cn(
              "absolute inset-0 rounded-full",
              dotTone[live.status],
            )}
          />
          {live.status === "live" ? (
            <span className="absolute -inset-1 animate-ping rounded-full border border-s-active opacity-60 [animation-duration:2s]" />
          ) : null}
        </span>
        <span>{label}</span>
        {live.unseen ? (
          <span className="font-mono font-normal" data-testid="live-unseen">
            · {live.unseen}
          </span>
        ) : null}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("recentChanges")}
          className="absolute top-10 right-0 z-30 w-[360px] overflow-hidden rounded-[10px] border bg-card shadow-lg"
          data-testid="recent-changes"
        >
          <div className="flex h-10 items-center gap-2 border-b px-3.5 text-xs font-medium">
            <span>{t("recentChanges")}</span>
            <span className="font-mono font-normal text-muted-foreground">
              {live.recent.length}
            </span>
            <button
              type="button"
              className="ml-auto cursor-pointer rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() =>
                live.status === "paused" ? resumeLive() : pauseLive()
              }
              data-testid="live-pause"
            >
              {live.status === "paused" ? t("resume") : t("pause")}
            </button>
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => clearRecent()}
              data-testid="live-clear"
            >
              {t("clear")}
            </button>
          </div>
          <div className="flex max-h-[380px] flex-col overflow-auto p-1">
            {live.recent.length ? (
              live.recent.map((event) => (
                <Link
                  key={event.id}
                  to={eventRoute(event)}
                  onClick={() => setOpen(false)}
                  className="grid grid-cols-[2px_minmax(0,1fr)] items-start gap-3 rounded-md px-2.5 py-2 hover:bg-accent"
                  data-testid="recent-change"
                >
                  <span
                    className={cn(
                      "h-full min-h-[30px] rounded-sm",
                      Date.parse(event.at) > now - 60_000
                        ? "bg-s-active"
                        : "bg-border",
                    )}
                  />
                  <span className="min-w-0">
                    <ChangeSummary event={event} now={now} />
                  </span>
                </Link>
              ))
            ) : (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("noRecentChanges")}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
