import { DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { api, type Document, errorMessage } from "@/lib/api";
import { useT } from "@/lib/i18n";

type State =
  | { status: "loading" }
  | { status: "ready"; document: Document }
  | { status: "error"; message: string };

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
  const [state, setState] = useState<State>({ status: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation forces a re-read after Refresh
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api
      .document(path)
      .then((document) => {
        if (!cancelled) setState({ status: "ready", document });
      })
      .catch((error) => {
        if (!cancelled)
          setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, generation]);

  const document = state.status === "ready" ? state.document : null;
  const kindLabel = document
    ? document.kind === "markdown"
      ? t("markdown")
      : document.kind === "text"
        ? t("text")
        : t("file")
    : null;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
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
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" ? (
          <p className="p-6 text-sm text-muted-foreground">{t("loading")}</p>
        ) : state.status === "error" ? (
          <p className="p-6 text-sm text-destructive" role="alert">
            {t("fileNotFound")}
            <span className="mt-1 block text-xs text-muted-foreground">
              {state.message}
            </span>
          </p>
        ) : state.document.kind === "markdown" ? (
          <article className="max-w-[760px] px-8 py-7">
            <Markdown source={state.document.source} path={path} />
          </article>
        ) : state.document.kind === "text" ? (
          <pre className="max-w-[760px] whitespace-pre-wrap px-8 py-7 font-mono text-[12.5px] leading-relaxed">
            {state.document.source}
          </pre>
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            <p>
              {state.document.size > 1024 * 1024
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
