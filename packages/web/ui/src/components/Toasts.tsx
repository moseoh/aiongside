import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { ChangeSummary } from "@/components/LiveMenu";
import { statusDot } from "@/components/StatusBadge";
import type { ChangeEvent, WorkStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { type ApplyMeta, useLiveSubscription } from "@/lib/live";
import { cn } from "@/lib/utils";

const LIMIT = 3;
const TTL_MS = 6000;

/**
 * Bottom-left cards for other Works' status transitions and creations. The
 * Work on screen updates in place instead, and paused batches never toast.
 */
export function Toasts() {
  const { t } = useT();
  const location = useLocation();
  const current = /^\/work\/([^/]+)/.exec(location.pathname)?.[1];
  const [items, setItems] = useState<ChangeEvent[]>([]);
  const handler = useCallback(
    (events: ChangeEvent[], meta: ApplyMeta) => {
      if (meta.resumed) return;
      const fresh = events.filter(
        (event) =>
          event.scope === "work" &&
          event.work !== current &&
          (event.kind === "created" || event.status !== undefined),
      );
      if (fresh.length) setItems((prev) => [...prev, ...fresh].slice(-LIMIT));
    },
    [current],
  );
  useLiveSubscription(handler);
  useEffect(() => {
    if (!items.length) return;
    const timer = setTimeout(() => setItems((prev) => prev.slice(1)), TTL_MS);
    return () => clearTimeout(timer);
  }, [items]);
  if (!items.length) return null;
  const dismiss = (id: number) =>
    setItems((prev) => prev.filter((item) => item.id !== id));
  return (
    <div
      className="fixed bottom-5 left-5 z-40 flex w-[340px] flex-col gap-2"
      aria-live="polite"
    >
      {items.map((event) => (
        <Link
          key={event.id}
          to={`/work/${event.work}`}
          onClick={() => dismiss(event.id)}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] border bg-card px-3 py-2.5 text-foreground shadow-lg"
          data-testid="toast"
        >
          <span
            className={cn(
              "size-2 rounded-full",
              statusDot[(event.status?.to ?? "inbox") as WorkStatus] ??
                "bg-ring",
            )}
          />
          <span className="min-w-0">
            <ChangeSummary event={event} />
          </span>
          <button
            type="button"
            aria-label={t("clear")}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(click) => {
              click.preventDefault();
              click.stopPropagation();
              dismiss(event.id);
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        </Link>
      ))}
    </div>
  );
}
