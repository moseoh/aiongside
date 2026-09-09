import type { WorkStatus } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const tone: Record<WorkStatus, string> = {
  active: "text-s-active bg-s-active-bg",
  waiting: "text-s-waiting bg-s-waiting-bg",
  inbox: "text-s-inbox bg-s-inbox-bg",
  done: "text-s-done bg-s-done-bg",
  cancelled: "text-s-cancelled bg-s-cancelled-bg",
};

export const statusDot: Record<WorkStatus, string> = {
  active: "bg-s-active",
  waiting: "bg-s-waiting",
  inbox: "bg-s-inbox",
  done: "bg-s-done",
  cancelled: "bg-s-cancelled",
};

export function StatusBadge({
  status,
  className,
}: {
  status: WorkStatus;
  className?: string;
}) {
  const { status: label } = useT();
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium",
        tone[status],
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", statusDot[status])} />
      <span>{label(status)}</span>
    </span>
  );
}

export function StatusDot({
  status,
  className,
}: {
  status: WorkStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        statusDot[status],
        className,
      )}
    />
  );
}
