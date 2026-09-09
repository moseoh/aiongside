import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { DocumentView } from "@/components/DocumentView";
import { WorkFileTree } from "@/components/FileTree";
import { Header } from "@/components/Header";
import { type Relation, RelationList } from "@/components/RelationList";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  api,
  errorMessage,
  WORK_ID,
  type WorkDetail,
  type WorkTransition,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { flattenDocuments, useKnowledge } from "@/lib/knowledge";
import { routeForPath, workFilePath } from "@/lib/links";
import { setExpanded, updateSettings, useSettings } from "@/lib/settings";
import { neededBy, useWorks, workById } from "@/lib/works";

type State =
  | { status: "loading" }
  | { status: "ready"; work: WorkDetail }
  | { status: "error"; message: string };

/** Clipboard API needs a secure context; plain-HTTP hosts fall back to execCommand. */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

/** Copies the Work ID to the clipboard; shows a check mark briefly after success. */
function CopyIdButton({ id }: { id: string }) {
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
          aria-label={t("copyId")}
          data-testid="copy-id"
          onClick={() => {
            void copyText(id).then((ok) => setCopied(ok));
          }}
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-primary" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? t("copiedId") : t("copyId")}</TooltipContent>
    </Tooltip>
  );
}

const REASON_KEYS = [
  "reopenReason",
  "waitingReason",
  "resumeWhen",
  "waitingResolution",
  "cancellationReason",
] as const;

/** Status changes newest first; free-text reasons are shown as label: value. */
function HistoryTable({ transitions }: { transitions: WorkTransition[] }) {
  const { t, dateTime } = useT();
  if (!transitions.length)
    return (
      <p className="text-sm text-muted-foreground" data-testid="no-history">
        {t("noHistory")}
      </p>
    );
  const rows = transitions.map((item, index) => ({ item, index })).reverse();
  return (
    <div className="rounded-lg border bg-card" data-testid="history-table">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("historyTime")}</TableHead>
            <TableHead>{t("historyTransition")}</TableHead>
            <TableHead className="w-full">{t("historyReason")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ item, index }) => {
            const reasons = REASON_KEYS.filter((key) => item[key]);
            return (
              <TableRow
                key={`${index}-${item.at}`}
                className="hover:bg-transparent"
              >
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {dateTime(item.at)}
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={item.from} />
                    <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                    <StatusBadge status={item.to} />
                  </span>
                </TableCell>
                <TableCell className="text-[13px] whitespace-normal">
                  {reasons.length || item.completionInvalidated ? (
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      {reasons.map((key) => (
                        <span key={key}>
                          <span className="text-muted-foreground">
                            {t(key)}
                          </span>{" "}
                          {item[key]}
                        </span>
                      ))}
                      {item.completionInvalidated ? (
                        <span className="rounded-sm border px-1.5 text-[11px] text-destructive">
                          {t("completionInvalidated")}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

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
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") === "history" ? "history" : "detail";
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
    // Only blank the page when the Work changes; a Refresh keeps the current one.
    setState((prev) =>
      prev.status === "ready" && prev.work.id === id
        ? prev
        : { status: "loading" },
    );
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
        {valid ? <CopyIdButton id={id} /> : null}
      </Header>
      <div className="flex flex-col gap-5 px-6 pt-6 pb-6">
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
            <Tabs
              value={tab}
              onValueChange={(value) => {
                const next = new URLSearchParams(search);
                if (value === "history") next.set("tab", "history");
                else next.delete("tab");
                setSearch(next, { replace: true });
              }}
              className="gap-4"
            >
              <TabsList>
                <TabsTrigger value="detail" data-testid="tab-detail">
                  {t("tabDetail")}
                </TabsTrigger>
                <TabsTrigger value="history" data-testid="tab-history">
                  {t("tabHistory")}
                  <span className="font-mono text-xs">
                    {work.transitions.length}
                  </span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="history">
                <HistoryTable transitions={work.transitions} />
              </TabsContent>
              <TabsContent
                value="detail"
                className="grid items-start grid-cols-[minmax(0,1fr)_240px] gap-5"
              >
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
                <div className="sticky top-20 flex max-h-[calc(100vh-104px)] flex-col gap-5">
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
                              className="flex h-[30px] shrink-0 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-accent"
                            >
                              <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">
                                {document.title}
                              </span>
                            </Link>
                          ) : (
                            <div
                              key={key}
                              className="flex h-[30px] shrink-0 items-center gap-2 px-2 text-[13px] text-muted-foreground"
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
              </TabsContent>
            </Tabs>
          </>
        ) : state.status === "loading" ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : null}
      </div>
    </>
  );
}
