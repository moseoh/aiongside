import { ChevronRightIcon } from "lucide-react";
import { Link } from "react-router";
import { StatusDot } from "@/components/StatusBadge";
import type { Work } from "@/lib/api";
import { useT } from "@/lib/i18n";

export type Relation =
  | { kind: "work"; work: Work }
  | { kind: "missing"; id: string; message: string };

/** ID + title rows that navigate to another Work; unreadable targets show their error. */
export function RelationList({
  label,
  items,
  testId,
}: {
  label: string;
  items: Relation[];
  testId?: string;
}) {
  const { t } = useT();
  if (!items.length) return null;
  return (
    <section className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <h2 className="px-3 text-[11px] font-medium tracking-wide text-muted-foreground">
        {label} <span className="font-mono">{items.length}</span>
      </h2>
      <div className="flex flex-col gap-px rounded-lg border bg-card p-1">
        {items.map((item) =>
          item.kind === "work" ? (
            <Link
              key={item.work.id}
              to={`/work/${item.work.id}`}
              className="flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-[13px] hover:bg-accent"
            >
              <StatusDot status={item.work.status} />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {item.work.id}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.work.title}</span>
              <ChevronRightIcon className="size-3.5 text-muted-foreground" />
            </Link>
          ) : (
            <div
              key={item.id}
              className="flex h-9 shrink-0 items-center gap-2.5 px-3 text-[13px] text-muted-foreground"
              title={item.message}
            >
              <span className="size-1.5 shrink-0 rounded-full border border-destructive" />
              <span className="shrink-0 font-mono text-xs">{item.id}</span>
              <span className="min-w-0 flex-1 truncate text-destructive">
                {t("relationError")}
              </span>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
