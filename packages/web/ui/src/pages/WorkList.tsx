import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Header } from "@/components/Header";
import { StatusBadge, StatusDot } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  STATUS_ORDER,
  WORK_STATUSES,
  type Work,
  type WorkStatus,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import {
  type SortKey,
  updateSettings,
  useSettings,
  type ViewMode,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useWorks } from "@/lib/works";

const byId = (a: Work, b: Work) =>
  a.id.localeCompare(b.id, undefined, { numeric: true });

export function sortWorks(works: Work[], sort: SortKey): Work[] {
  return [...works].sort(
    (a, b) =>
      (sort === "updated"
        ? b.updated.localeCompare(a.updated)
        : sort === "status"
          ? STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
          : 0) || byId(a, b),
  );
}

export function filterWorks(works: Work[], query: string): Work[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return works;
  return works.filter((work) =>
    `${work.id} ${work.title}`.toLowerCase().includes(needle),
  );
}

function ViewToggle({ view }: { view: ViewMode }) {
  const { t } = useT();
  const item = (mode: ViewMode, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      className={cn(
        "flex h-[26px] cursor-pointer items-center gap-1.5 rounded px-2.5 text-xs font-medium",
        view === mode
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={view === mode}
      onClick={() => updateSettings({ view: mode })}
      data-testid={`view-${mode}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <div className="ml-2 flex h-8 items-center gap-0.5 rounded-md border bg-card p-0.5">
      {item("list", t("viewList"), <ListIcon className="size-[13px]" />)}
      {item(
        "board",
        t("viewBoard"),
        <LayoutGridIcon className="size-[13px]" />,
      )}
    </div>
  );
}

function SortMenu({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (value: SortKey) => void;
}) {
  const { t } = useT();
  const labels: Record<SortKey, string> = {
    status: t("sortStatus"),
    id: t("sortId"),
    updated: t("sortUpdated"),
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-testid="sort-menu">
          <ArrowUpDownIcon className="size-3.5" />
          <span>{t("sort")}</span>
          <span className="text-muted-foreground">{labels[value]}</span>
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("sort")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as SortKey)}
        >
          {(["status", "id", "updated"] as const).map((key) => (
            <DropdownMenuRadioItem
              key={key}
              value={key}
              data-testid={`sort-${key}`}
            >
              {labels[key]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkListPage() {
  const { t, date, type, status: statusLabel } = useT();
  const settings = useSettings();
  const works = useWorks();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const all = works.data?.works ?? [];
  const searched = filterWorks(all, query);
  const sort =
    settings.view === "board" ? settings.sortBoard : settings.sortList;
  const setSort = (value: SortKey) =>
    updateSettings(
      settings.view === "board" ? { sortBoard: value } : { sortList: value },
    );
  const counts = Object.fromEntries(
    WORK_STATUSES.map((status) => [
      status,
      searched.filter((work) => work.status === status).length,
    ]),
  ) as Record<WorkStatus, number>;
  const tabbed =
    settings.view === "list" && settings.statusTab !== "all"
      ? searched.filter((work) => work.status === settings.statusTab)
      : searched;
  const shown = sortWorks(tabbed, sort);

  return (
    <>
      <Header>
        <h1 className="text-[15px] font-semibold tracking-tight">
          {t("navWork")}
        </h1>
        <ViewToggle view={settings.view} />
        {works.data ? (
          <span className="ml-1 truncate font-mono text-xs text-muted-foreground">
            {works.data.name}
          </span>
        ) : null}
      </Header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 pt-5 pb-6">
        <div className="flex items-center gap-2">
          <div className="relative w-80">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchWork")}
              aria-label={t("searchWork")}
              className="pl-8"
              data-testid="search"
            />
          </div>
          <SortMenu value={sort} onChange={setSort} />
          <span
            className="ml-auto text-[13px] text-muted-foreground"
            data-testid="count"
          >
            {t("itemsCount", { shown: shown.length, total: all.length })}
          </span>
        </div>

        {works.data?.issues.length ? (
          <div
            className="rounded-md border border-destructive/40 bg-card px-4 py-3 text-[13px]"
            role="alert"
            data-testid="issues"
          >
            <p className="font-medium text-destructive">{t("issuesTitle")}</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              {works.data.issues.map((issue) => (
                <li key={issue.path}>
                  <span className="font-mono text-foreground">
                    {issue.path}
                  </span>{" "}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {works.status === "error" ? (
          <div className="rounded-md border bg-card p-6 text-sm" role="alert">
            <p className="text-destructive">{works.error}</p>
          </div>
        ) : settings.view === "list" ? (
          <>
            <Tabs
              value={settings.statusTab}
              onValueChange={(value) =>
                updateSettings({ statusTab: value as WorkStatus | "all" })
              }
            >
              <TabsList>
                <TabsTrigger value="all" data-testid="tab-all">
                  <span>{t("tabAll")}</span>
                  <Badge variant="count">{searched.length}</Badge>
                </TabsTrigger>
                {STATUS_ORDER.map((status) => (
                  <TabsTrigger
                    key={status}
                    value={status}
                    data-testid={`tab-${status}`}
                  >
                    <span>{statusLabel(status)}</span>
                    <Badge variant="count">{counts[status]}</Badge>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
              <Table>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="hover:bg-background">
                    <TableHead className="w-[110px]">{t("colId")}</TableHead>
                    <TableHead>{t("colTitle")}</TableHead>
                    <TableHead className="w-[130px]">
                      {t("colStatus")}
                    </TableHead>
                    <TableHead className="w-[150px]">
                      {t("colUpdated")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((work) => (
                    <TableRow
                      key={work.id}
                      className="cursor-pointer"
                      data-testid="work-row"
                      data-work-id={work.id}
                      onClick={() => navigate(`/work/${work.id}`)}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {work.id}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "max-w-0 truncate font-medium",
                          (work.status === "done" ||
                            work.status === "cancelled") &&
                            "text-muted-foreground",
                          work.status === "cancelled" && "line-through",
                        )}
                      >
                        <Link
                          to={`/work/${work.id}`}
                          className="outline-none focus-visible:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {work.title}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={work.status} />
                      </TableCell>
                      <TableCell className="text-[13px] text-muted-foreground">
                        {date(work.updated)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {works.status === "ready" && !shown.length ? (
                <p
                  className="p-6 text-[13px] text-muted-foreground"
                  data-testid="empty"
                >
                  {all.length ? t("emptyWorks") : t("noWorks")}
                </p>
              ) : null}
              {works.status === "loading" && !works.data ? (
                <p className="p-6 text-[13px] text-muted-foreground">
                  {t("loading")}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div
            className="grid min-h-0 flex-1 grid-cols-5 gap-4 overflow-x-auto"
            data-testid="board"
          >
            {STATUS_ORDER.map((status) => {
              const items = shown.filter((work) => work.status === status);
              return (
                <section
                  key={status}
                  className="flex min-w-0 flex-col gap-2.5"
                  data-testid={`column-${status}`}
                >
                  <h2 className="flex items-center gap-2 px-1 text-[13px] font-medium">
                    <StatusDot status={status} className="size-2" />
                    <span>{statusLabel(status)}</span>
                    <Badge variant="count">{items.length}</Badge>
                  </h2>
                  <div className="flex min-h-[200px] flex-1 flex-col gap-2 overflow-auto rounded-[10px] bg-muted p-2">
                    {items.map((work) => (
                      <Link
                        key={work.id}
                        to={`/work/${work.id}`}
                        className="flex shrink-0 flex-col gap-2 rounded-lg border bg-card p-3 hover:border-ring"
                        data-testid="work-card"
                        data-work-id={work.id}
                      >
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="font-mono">{work.id}</span>
                          <span className="ml-auto rounded border px-1.5">
                            {type(work.type)}
                          </span>
                        </div>
                        <div
                          className={cn(
                            "text-[13px] leading-[18px] font-medium",
                            (work.status === "done" ||
                              work.status === "cancelled") &&
                              "text-muted-foreground",
                            work.status === "cancelled" && "line-through",
                          )}
                        >
                          {work.title}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {date(work.updated)}
                        </div>
                      </Link>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
