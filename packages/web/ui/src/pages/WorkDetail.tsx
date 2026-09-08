import { BookOpenIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { DocumentView } from "@/components/DocumentView";
import { WorkFileTree } from "@/components/FileTree";
import { Header } from "@/components/Header";
import { type Relation, RelationList } from "@/components/RelationList";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { api, errorMessage, WORK_ID, type WorkDetail } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { flattenDocuments, useKnowledge } from "@/lib/knowledge";
import { routeForPath, workFilePath } from "@/lib/links";
import { setExpanded, updateSettings, useSettings } from "@/lib/settings";
import { neededBy, useWorks, workById } from "@/lib/works";

type State =
  | { status: "loading" }
  | { status: "ready"; work: WorkDetail }
  | { status: "error"; message: string };

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[13px]">{children}</span>
    </div>
  );
}

export function WorkDetailPage() {
  const { id = "", "*": splat } = useParams();
  const { t, type, fullDate, date } = useT();
  const settings = useSettings();
  const works = useWorks();
  const knowledge = useKnowledge();
  const [state, setState] = useState<State>({ status: "loading" });
  const valid = WORK_ID.test(id);

  // biome-ignore lint/correctness/useExhaustiveDependencies: works.generation forces a re-read after Refresh
  useEffect(() => {
    if (!valid) {
      setState({ status: "error", message: "Invalid Work ID." });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    api
      .work(id)
      .then((work) => {
        if (!cancelled) setState({ status: "ready", work });
      })
      .catch((error) => {
        if (!cancelled)
          setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [id, valid, works.generation]);

  const work = state.status === "ready" ? state.work : null;
  const filePath = workFilePath(id, splat);
  const isOverview = !splat;
  const relation = (targetId: string): Relation => {
    const target = workById(works.data, targetId);
    if (target) return { kind: "work", work: target };
    const issue = works.data?.issues.find((item) =>
      item.path.startsWith(`work/${targetId}/`),
    );
    return {
      kind: "missing",
      id: targetId,
      message: issue?.message ?? t("relationError"),
    };
  };
  const needs = work ? work.needs.map(relation) : [];
  const dependents = neededBy(works.data, id).map(
    (item): Relation => ({ kind: "work", work: item }),
  );
  const documents = knowledge.data
    ? flattenDocuments(knowledge.data.nodes)
    : [];
  const linkedKnowledge = work
    ? work.knowledge.map((key) => ({
        key,
        document: documents.find((item) => item.key === key) ?? null,
      }))
    : [];

  return (
    <>
      <Header>
        <Link
          to="/work"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {t("breadcrumbWork")}
        </Link>
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-sm font-medium" data-testid="detail-id">
          {id}
        </span>
      </Header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 pt-6 pb-6">
        {state.status === "error" ? (
          <div
            className="rounded-lg border bg-card p-6"
            role="alert"
            data-testid="detail-error"
          >
            <p className="text-sm text-destructive">{t("workNotFound")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {state.message}
            </p>
            <Button asChild size="sm" className="mt-4">
              <Link to="/work">{t("backToList")}</Link>
            </Button>
          </div>
        ) : null}
        {work ? (
          <>
            <div className="flex flex-col gap-3" data-testid="detail-heading">
              <div className="flex items-center gap-3">
                <h1 className="text-[22px] leading-7 font-semibold tracking-tight">
                  {work.title}
                </h1>
                <StatusBadge status={work.status} />
              </div>
              <div className="flex flex-wrap items-start gap-8">
                <Meta label={t("type")}>{type(work.type)}</Meta>
                <Meta label={t("created")}>{fullDate(work.created)}</Meta>
                <Meta label={t("updated")}>
                  {fullDate(work.updated)} · {date(work.updated)}
                </Meta>
              </div>
            </div>
            {needs.length || dependents.length ? (
              <div className="grid grid-cols-2 gap-4">
                <RelationList label={t("needs")} items={needs} testId="needs" />
                <RelationList
                  label={t("neededBy")}
                  items={dependents}
                  testId="needed-by"
                />
              </div>
            ) : null}
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_240px] gap-5">
              {isOverview && !work.overview ? (
                <div
                  className="flex flex-col items-start gap-3 rounded-lg border bg-card p-6 text-sm"
                  data-testid="no-overview"
                >
                  <p className="text-muted-foreground">{t("noOverview")}</p>
                  <Button asChild size="sm">
                    <Link to={routeForPath(`work/${id}/record.md`) ?? "#"}>
                      {t("openRecord")}
                    </Link>
                  </Button>
                </div>
              ) : (
                <DocumentView path={filePath} generation={works.generation} />
              )}
              <div className="flex min-h-0 flex-col gap-5">
                <WorkFileTree
                  root={`work/${id}`}
                  selected={filePath}
                  expanded={settings.expanded[id] ?? []}
                  onExpandedChange={(paths) => setExpanded(id, paths)}
                  showIgnored={settings.showIgnored}
                  onShowIgnoredChange={(showIgnored) =>
                    updateSettings({ showIgnored })
                  }
                  generation={works.generation}
                />
                {linkedKnowledge.length ? (
                  <section
                    className="flex flex-col gap-1.5"
                    data-testid="linked-knowledge"
                  >
                    <h2 className="px-2 text-[11px] font-medium tracking-wide text-muted-foreground">
                      {t("linkedKnowledge")}{" "}
                      <span className="font-mono">
                        {linkedKnowledge.length}
                      </span>
                    </h2>
                    <div className="flex flex-col gap-px">
                      {linkedKnowledge.map(({ key, document }) =>
                        document ? (
                          <Link
                            key={key}
                            to={routeForPath(document.path) ?? "/knowledge"}
                            className="flex h-[30px] items-center gap-2 rounded-md px-2 text-[13px] hover:bg-accent"
                          >
                            <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">
                              {document.title}
                            </span>
                          </Link>
                        ) : (
                          <div
                            key={key}
                            className="flex h-[30px] items-center gap-2 px-2 text-[13px] text-muted-foreground"
                            title={t("knowledgeMissing")}
                          >
                            <BookOpenIcon className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">
                              {key}
                            </span>
                            <span className="text-[11px] text-destructive">
                              {t("knowledgeMissing")}
                            </span>
                          </div>
                        ),
                      )}
                    </div>
                  </section>
                ) : null}
              </div>
            </div>
          </>
        ) : state.status === "loading" ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : null}
      </div>
    </>
  );
}
