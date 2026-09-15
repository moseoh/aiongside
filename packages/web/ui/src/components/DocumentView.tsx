import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, type Document, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
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

/** Copies the displayed document path and shows a check mark briefly after success. */
function CopyPathButton({ path }: { path: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted"
          size="icon-sm"
          aria-label={copied ? t("copiedPath") : t("copyPath")}
          data-testid="copy-path"
          onClick={() => {
            void copyText(path).then((ok) => setCopied(ok));
          }}
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-primary" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {copied ? t("copiedPath") : t("copyPath")}
      </TooltipContent>
    </Tooltip>
  );
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
  const [fullscreen, setFullscreen] = useState(false);
  const documentRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({
    loading: true,
    document: null,
    error: null,
  });
  const changedEvent = live.changed.has(path)
    ? live.recent.find((event) => event.path === path)
    : undefined;
  const document = state.document;
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

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(
        globalThis.document.fullscreenElement === documentRef.current,
      );
    };
    globalThis.document.addEventListener(
      "fullscreenchange",
      onFullscreenChange,
    );
    return () =>
      globalThis.document.removeEventListener(
        "fullscreenchange",
        onFullscreenChange,
      );
  }, []);

  useEffect(() => {
    if (!fullscreen || globalThis.document.fullscreenElement) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  useEffect(() => {
    if (document?.kind !== "html") setFullscreen(false);
  }, [document?.kind]);

  const toggleFullscreen = async () => {
    const target = documentRef.current;
    if (!target) return;
    if (globalThis.document.fullscreenElement === target) {
      await globalThis.document.exitFullscreen();
      return;
    }
    if (globalThis.document.fullscreenElement) {
      await globalThis.document.exitFullscreen();
    }
    try {
      await target.requestFullscreen();
    } catch {
      // HTTP local hosts may not expose the native Fullscreen API.
      setFullscreen(true);
    }
  };

  const kindLabel = document
    ? document.kind === "markdown"
      ? t("markdown")
      : document.kind === "html"
        ? t("html")
        : document.kind === "text"
          ? t("text")
          : t("file")
    : null;
  return (
    <div
      className={`flex flex-col overflow-hidden border bg-card ${
        fullscreen ? "fixed inset-0 z-50 m-0 rounded-none" : "rounded-lg"
      }`}
      ref={documentRef}
      data-testid="document"
    >
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b bg-background px-4 text-xs text-muted-foreground">
        <span
          className="min-w-0 truncate font-mono text-foreground"
          data-testid="document-path"
        >
          {path}
        </span>
        <CopyPathButton path={path} />
        {document ? (
          <span className="shrink-0">
            {kindLabel} · {size(document.size)}
          </span>
        ) : null}
        {document?.kind === "html" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="muted"
                size="icon-sm"
                aria-label={
                  fullscreen ? t("exitFullscreen") : t("enterFullscreen")
                }
                data-testid="toggle-html-fullscreen"
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? (
                  <Minimize2Icon className="size-3.5" />
                ) : (
                  <Maximize2Icon className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {fullscreen ? t("exitFullscreen") : t("enterFullscreen")}
            </TooltipContent>
          </Tooltip>
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
        ) : document.kind === "html" ? (
          <iframe
            className={`${fullscreen ? "h-[calc(100vh-40px)]" : "h-[720px]"} w-full border-0 bg-white`}
            data-testid="html-preview"
            title={document.path}
            srcDoc={document.source}
          />
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
