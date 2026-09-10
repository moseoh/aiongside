import { BookOpenIcon, ListIcon } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function Logo() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden
    >
      <rect x="17" y="15" width="12" height="34" rx="6" fill="var(--foreground)" />
      <rect x="35" y="15" width="12" height="34" rx="6" fill="#fbbf24" />
    </svg>
  );
}

export function Layout() {
  const { t } = useT();
  const item = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] hover:bg-accent",
      isActive
        ? "bg-muted font-medium text-foreground"
        : "text-muted-foreground",
    );
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 bg-background text-foreground">
        <aside className="flex w-60 shrink-0 flex-col border-r">
          <div className="flex h-14 items-center gap-2.5 border-b px-4">
            <Logo />
            <span className="text-sm font-semibold tracking-tight">
              {t("appName")}
            </span>
            <span className="ml-auto rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wider text-muted-foreground">
              {t("readOnly")}
            </span>
          </div>
          <nav className="flex flex-col gap-0.5 p-2 pt-3" aria-label="Main">
            <NavLink to="/work" className={item}>
              <ListIcon className="size-4" />
              <span>{t("navWork")}</span>
            </NavLink>
            <NavLink to="/knowledge" className={item}>
              <BookOpenIcon className="size-4" />
              <span>{t("navKnowledge")}</span>
            </NavLink>
          </nav>
          <p className="mt-auto border-t px-4 py-3 text-[11px] leading-4 text-muted-foreground">
            {t("footer")}
          </p>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
          <Outlet />
        </main>
      </div>
    </TooltipProvider>
  );
}
