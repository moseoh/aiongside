import { MoonIcon, RefreshCwIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatElapsed, useT } from "@/lib/i18n";
import { type Lang, updateSettings, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { refreshWorks, useWorks } from "@/lib/works";

function Elapsed({ from }: { from: number }) {
  const { lang } = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatElapsed(lang, from, now)}</>;
}

/** Page header: title area on the left, shared Refresh · theme · language on the right. */
export function Header({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const settings = useSettings();
  const works = useWorks();
  const setLang = (lang: Lang) => updateSettings({ lang });
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-6">
      {children}
      <div className="ml-auto flex items-center gap-2">
        {works.loadedAt ? (
          <span
            className="mr-1 text-xs text-muted-foreground"
            data-testid="refreshed-at"
          >
            {works.status === "loading" ? (
              t("refreshing")
            ) : (
              <>
                {t("refreshedAgo", { time: "" }).trim()}{" "}
                <Elapsed from={works.loadedAt} />
              </>
            )}
          </span>
        ) : null}
        <Button
          size="sm"
          onClick={() => void refreshWorks()}
          disabled={works.status === "loading"}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon className="size-3.5" />
          <span>{t("refresh")}</span>
        </Button>
        <Button
          size="icon"
          title={t("toggleTheme")}
          aria-label={t("toggleTheme")}
          aria-pressed={settings.theme === "dark"}
          onClick={() =>
            updateSettings({
              theme: settings.theme === "dark" ? "light" : "dark",
            })
          }
          data-testid="toggle-theme"
        >
          {settings.theme === "dark" ? (
            <SunIcon className="size-[15px]" />
          ) : (
            <MoonIcon className="size-[15px]" />
          )}
        </Button>
        <div className="flex h-8 items-center gap-0.5 rounded-md border bg-card p-0.5">
          {(["en", "ko"] as const).map((lang) => (
            <button
              key={lang}
              type="button"
              className={cn(
                "h-[26px] cursor-pointer rounded px-2 text-xs font-medium",
                settings.lang === lang
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={settings.lang === lang}
              onClick={() => setLang(lang)}
              data-testid={`lang-${lang}`}
            >
              {lang === "en" ? "EN" : "KR"}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
