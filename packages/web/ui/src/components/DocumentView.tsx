import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { api, type Document, errorMessage } from "@/lib/api";
import { formatElapsed, useT } from "@/lib/i18n";
import { markOpened, useLive } from "@/lib/live";

/** "changed · 12s ago" that keeps counting while the pill is visible. */
function ChangedSince({ at }: { at: string }) {
  const { lang, t } = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {t("changed")} · {formatElapsed(lang, Date.parse(at), now)}
    </>
  );
}

interface State {
  loading: boolean;
  document: Document | null;
  error: string | null;
}

/**
 * Fetches one workspace file when its path changes. Live changes to the open
 * file only show a Reload prompt; the body stays until the reader asks.
 */
export function DocumentView({
  path,
  meta,
}: {
  path: string;
  meta?: React.ReactNode;
}) {
  const { t, size } = useT();
  const live = useLive();
  const [reloads, setReloads] = useState(0);
  const [state, setState] = useState<State>({
    loading: true,
    document: null,
    error: null,
  });
  const changedEvent = live.changed.has(path)
    ? live.recent.find((event) => event.path === path)
    : undefined;
  // Keep the previous document on screen while the next one loads, so
  // switching files replaces content instead of flashing a loading state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads forces a re-read on Reload
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    api
      .document(path)
      .then((document) => {
        if (cancelled) return;
        markOpened(path);
        setState({ loading: false, document, error: null });
      })
      .catch((error) => {
        if (!cancelled)
          setState({
            loading: false,
            document: null,
            error: errorMessage(error),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloads]);

  const document = state.document;
  const kindLabel = document
    ? document.kind === "markdown"
      ? t("markdown")
      : document.kind === "text"
        ? t("text")
        : t("file")
    : null;
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border bg-card"
      data-testid="document"
    >
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b bg-background px-4 text-xs text-muted-foreground">
        <span
          className="truncate font-mono text-foreground"
          data-testid="document-path"
        >
          {path}
        </span>
        {document ? (
          <span className="shrink-0">
            {kindLabel} · {size(document.size)}
          </span>
        ) : null}
        {meta}
        <span className="flex-1" />
        {changedEvent || state.error ? (
          <span
            className="inline-flex shrink-0 items-center gap-2 text-s-active"
            data-testid="document-changed"
          >
            {changedEvent ? (
              <>
                <span className="size-1.5 rounded-full bg-s-active" />
                <ChangedSince at={changedEvent.at} />
              </>
            ) : null}
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 font-medium text-foreground underline decoration-ring underline-offset-3 hover:text-muted-foreground"
              onClick={() => setReloads((n) => n + 1)}
              data-testid="document-reload"
            >
              <RefreshCwIcon className="size-3" />
              <span>{t("reload")}</span>
            </button>
          </span>
        ) : null}
        <a
          href={api.downloadUrl(path)}
          className="ml-3 inline-flex shrink-0 items-center gap-1.5 hover:text-foreground"
          download
        >
          <DownloadIcon className="size-3.5" />
          <span>{t("download")}</span>
        </a>
      </div>
      <div
        className="transition-opacity"
        style={{ opacity: state.loading && document ? 0.6 : 1 }}
        aria-busy={state.loading}
      >
        {state.error ? (
          <p className="p-6 text-sm text-destructive" role="alert">
            {t("fileNotFound")}
            <span className="mt-1 block text-xs text-muted-foreground">
              {state.error}
            </span>
          </p>
        ) : !document ? (
          <p className="p-6 text-sm text-muted-foreground">{t("loading")}</p>
        ) : document.kind === "markdown" ? (
          <article className="max-w-[760px] px-8 py-7">
            <Markdown source={document.source} path={document.path} />
          </article>
        ) : document.kind === "text" ? (
          <pre className="max-w-[760px] whitespace-pre-wrap px-8 py-7 font-mono text-[12.5px] leading-relaxed">
            {document.source}
          </pre>
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            <p>
              {document.size > 1024 * 1024
                ? t("fileTooLarge")
                : t("downloadOnly")}
            </p>
            <a
              href={api.downloadUrl(path)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-accent"
              download
            >
              <DownloadIcon className="size-3.5" />
              {t("download")}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
