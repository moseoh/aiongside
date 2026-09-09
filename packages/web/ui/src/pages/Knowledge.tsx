import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { DocumentView } from "@/components/DocumentView";
import { KnowledgeTree } from "@/components/FileTree";
import { Header } from "@/components/Header";
import { type Relation, RelationList } from "@/components/RelationList";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { findNode, useKnowledge } from "@/lib/knowledge";
import { updateSettings, useSettings } from "@/lib/settings";
import { useWorks, workById } from "@/lib/works";

function decodeSplat(splat: string | undefined): string {
  if (!splat) return "";
  return splat
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

export function KnowledgePage() {
  const { "*": splat } = useParams();
  const { t } = useT();
  const settings = useSettings();
  const works = useWorks();
  const knowledge = useKnowledge();
  const [filter, setFilter] = useState("");
  const relative = decodeSplat(splat).replace(/(?:^|\/)index\.md$/, "");
  const selected = relative ? `knowledge/${relative}` : "knowledge";
  const node = knowledge.data
    ? relative
      ? findNode(knowledge.data.nodes, selected)
      : null
    : null;

  // Folder → its index; document/file → itself; root → root index.
  let documentPath: string | null = null;
  let missing: string | null = null;
  if (knowledge.data) {
    if (!relative) documentPath = knowledge.data.index;
    else if (!node) missing = t("knowledgeNotFound");
    else if (node.kind === "directory") documentPath = node.index;
    else documentPath = node.path;
  }
  const key = node?.kind === "document" ? node.key : null;
  const linked: Relation[] =
    key && knowledge.data
      ? (knowledge.data.references[key] ?? []).map((id) => {
          const work = workById(works.data, id);
          return work
            ? { kind: "work", work }
            : { kind: "missing", id, message: t("relationError") };
        })
      : [];

  return (
    <>
      <Header>
        <h1 className="text-[15px] font-semibold tracking-tight">
          {t("navKnowledge")}
        </h1>
      </Header>
      <div className="grid items-start grid-cols-[minmax(0,1fr)_280px] gap-5 px-6 pt-5 pb-6">
        {knowledge.status === "error" ? (
          <div
            className="rounded-lg border bg-card p-6 text-sm text-destructive"
            role="alert"
          >
            {knowledge.error}
          </div>
        ) : missing ? (
          <div
            className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
            role="alert"
            data-testid="knowledge-missing"
          >
            {missing}
          </div>
        ) : documentPath ? (
          <DocumentView
            path={documentPath}
            generation={works.generation}
            meta={
              key ? (
                <span
                  className="shrink-0 font-mono"
                  data-testid="knowledge-key"
                >
                  {t("key")}: {key}
                </span>
              ) : node?.kind === "document" && node.error ? (
                <span className="shrink-0 text-destructive" title={node.error}>
                  {t("knowledgeInvalid")}
                </span>
              ) : null
            }
          />
        ) : knowledge.status === "ready" ? (
          <div
            className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
            data-testid="knowledge-no-index"
          >
            {t("knowledgeNoIndex")}
          </div>
        ) : (
          <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
            {t("loading")}
          </div>
        )}
        <div className="sticky top-[76px] flex max-h-[calc(100vh-100px)] flex-col gap-5">
          <div className="flex min-h-0 flex-col gap-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t("searchKnowledge")}
                aria-label={t("searchKnowledge")}
                className="h-8 pl-8 text-xs"
                data-testid="knowledge-search"
              />
            </div>
            <div className="flex h-6 items-center pl-2 text-[11px] font-medium tracking-wide text-muted-foreground">
              {t("knowledgeTree")}
            </div>
            <KnowledgeTree
              nodes={knowledge.data?.nodes ?? []}
              selected={selected}
              expanded={settings.knowledgeExpanded}
              onExpandedChange={(knowledgeExpanded) =>
                updateSettings({ knowledgeExpanded })
              }
              filter={filter}
            />
          </div>
          <RelationList
            label={t("linkedWork")}
            items={linked}
            testId="linked-work"
          />
        </div>
      </div>
    </>
  );
}
