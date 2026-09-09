import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { api, type Document, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface State {
  loading: boolean;
  document: Document | null;
  error: string | null;
}

/** Fetches one workspace file when its path or the refresh generation changes. */
export function DocumentView({
  path,
  generation,
  meta,
}: {
  path: string;
  generation: number;
  meta?: React.ReactNode;
}) {
  const { t, size } = useT();
  const [state, setState] = useState<State>({
    loading: true,
    document: null,
    error: null,
  });
  // Keep the previous document on screen while the next one loads, so
  // switching files replaces content instead of flashing a loading state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation forces a re-read after Refresh
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    api
      .document(path)
      .then((document) => {
        if (!cancelled) setState({ loading: false, document, error: null });
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
  }, [path, generation]);

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
        <a
          href={api.downloadUrl(path)}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 hover:text-foreground"
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
