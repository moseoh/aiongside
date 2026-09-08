import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FolderIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  api,
  type DirectoryEntry,
  errorMessage,
  type KnowledgeNode,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { routeForPath } from "@/lib/links";
import { cn } from "@/lib/utils";

/** Folder paths above a selected file, so a direct URL shows it in the tree. */
function ancestors(selected: string, root: string): string[] {
  const parts = selected.split("/");
  const out: string[] = [];
  for (let depth = root.split("/").length + 1; depth < parts.length; depth++)
    out.push(parts.slice(0, depth).join("/"));
  return out;
}

interface Row {
  key: string;
  name: string;
  depth: number;
  kind: "directory" | "file";
  path: string;
  to: string | null;
  selected: boolean;
  open: boolean;
  ignored: boolean;
  error?: string | null;
}

function TreeRow({
  row,
  onToggle,
}: {
  row: Row;
  onToggle?: (() => void) | undefined;
}) {
  const { t } = useT();
  const className = cn(
    "flex h-[30px] items-center gap-2 rounded-md pr-2 text-[13px] hover:bg-accent",
    row.kind === "directory" && "text-muted-foreground",
    row.selected && "bg-muted font-medium text-foreground",
    row.error && "text-destructive",
  );
  const style = { paddingLeft: 8 + row.depth * 16 };
  const content = (
    <>
      {row.kind === "directory" ? (
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            row.open && "rotate-90",
          )}
        />
      ) : (
        <span className="size-3 shrink-0" />
      )}
      {row.kind === "directory" ? (
        <FolderIcon className="size-4 shrink-0" />
      ) : (
        <FileIcon className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
      {row.ignored ? (
        <span className="shrink-0 rounded-sm border px-1 text-[10px] text-muted-foreground">
          {t("ignoredTag")}
        </span>
      ) : null}
    </>
  );
  if (row.kind === "directory" && onToggle && row.to)
    return (
      <div
        className={cn(className, "pl-0")}
        style={{ paddingLeft: 0 }}
        data-tree-path={row.path}
      >
        <button
          type="button"
          className="flex h-full shrink-0 cursor-pointer items-center pr-2"
          style={style}
          onClick={onToggle}
          aria-expanded={row.open}
          aria-label={row.name}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 transition-transform",
              row.open && "rotate-90",
            )}
          />
        </button>
        <Link
          to={row.to}
          className="flex h-full min-w-0 flex-1 items-center gap-2 pr-2"
          aria-current={row.selected ? "page" : undefined}
        >
          <FolderIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
        </Link>
      </div>
    );
  if (row.kind === "directory" && onToggle)
    return (
      <button
        type="button"
        className={cn(className, "w-full cursor-pointer text-left")}
        style={style}
        onClick={onToggle}
        aria-expanded={row.open}
        data-tree-path={row.path}
      >
        {content}
      </button>
    );
  if (row.to)
    return (
      <Link
        to={row.to}
        className={className}
        style={style}
        aria-current={row.selected ? "page" : undefined}
        data-tree-path={row.path}
        title={row.error ?? undefined}
      >
        {content}
      </Link>
    );
  return (
    <div className={className} style={style} data-tree-path={row.path}>
      {content}
    </div>
  );
}

/**
 * Lazily loaded Work file tree. Folders fetch their direct children only when
 * expanded; excluded entries stay hidden until the eye toggle reveals them.
 */
export function WorkFileTree({
  root,
  selected,
  expanded,
  onExpandedChange,
  showIgnored,
  onShowIgnoredChange,
  generation,
}: {
  root: string;
  selected: string;
  expanded: string[];
  onExpandedChange: (paths: string[]) => void;
  showIgnored: boolean;
  onShowIgnoredChange: (value: boolean) => void;
  generation: number;
}) {
  const { t } = useT();
  const [folders, setFolders] = useState<
    Record<string, { entries?: DirectoryEntry[]; error?: string }>
  >({});
  const open = [
    ...new Set([
      ...expanded.filter((path) => path.startsWith(`${root}/`)),
      ...ancestors(selected, root),
    ]),
  ];
  const wanted = [root, ...open];
  const signature = `${generation}:${wanted.join("\n")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature covers wanted + generation
  useEffect(() => {
    let cancelled = false;
    setFolders({});
    for (const path of wanted) {
      api
        .directory(path)
        .then((entries) => {
          if (!cancelled)
            setFolders((prev) => ({ ...prev, [path]: { entries } }));
        })
        .catch((error) => {
          if (!cancelled)
            setFolders((prev) => ({
              ...prev,
              [path]: { error: errorMessage(error) },
            }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [signature]);

  const rows: Row[] = [];
  let hidden = 0;
  const visit = (path: string, depth: number) => {
    const folder = folders[path];
    if (!folder?.entries) {
      if (folder?.error)
        rows.push({
          key: `${path}#error`,
          name: folder.error,
          depth,
          kind: "file",
          path,
          to: null,
          selected: false,
          open: false,
          ignored: false,
          error: folder.error,
        });
      return;
    }
    for (const entry of folder.entries) {
      if (entry.ignored && !showIgnored) {
        hidden += 1;
        continue;
      }
      const isOpen = entry.kind === "directory" && open.includes(entry.path);
      rows.push({
        key: entry.path,
        name: entry.name,
        depth,
        kind: entry.kind,
        path: entry.path,
        to: entry.kind === "file" ? routeForPath(entry.path) : null,
        selected: entry.path === selected,
        open: isOpen,
        ignored: entry.ignored,
      });
      if (isOpen) visit(entry.path, depth + 1);
    }
  };
  visit(root, 0);

  const toggle = (path: string) =>
    onExpandedChange(
      open.includes(path)
        ? open.filter((item) => item !== path && !item.startsWith(`${path}/`))
        : [...open, path],
    );

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="file-tree">
      <div className="flex h-6 items-center pl-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
          {t("files")}
        </span>
        {hidden > 0 || showIgnored ? (
          <span className="ml-1.5 text-[11px] text-muted-foreground">
            · {t("ignoredCount", { count: hidden })}
          </span>
        ) : null}
        <Button
          variant="muted"
          size="icon-sm"
          className="ml-auto"
          title={showIgnored ? t("hideIgnored") : t("showIgnored")}
          aria-label={showIgnored ? t("hideIgnored") : t("showIgnored")}
          aria-pressed={showIgnored}
          onClick={() => onShowIgnoredChange(!showIgnored)}
          data-testid="toggle-ignored"
        >
          {showIgnored ? (
            <EyeIcon className="size-3.5" />
          ) : (
            <EyeOffIcon className="size-3.5" />
          )}
        </Button>
      </div>
      <nav
        className="flex min-h-0 flex-col gap-px overflow-auto"
        aria-label={t("files")}
      >
        {rows.map((row) => (
          <TreeRow
            key={row.key}
            row={row}
            onToggle={
              row.kind === "directory" ? () => toggle(row.path) : undefined
            }
          />
        ))}
      </nav>
    </div>
  );
}

/** Knowledge tree from one API response; folders navigate to their index. */
export function KnowledgeTree({
  nodes,
  selected,
  expanded,
  onExpandedChange,
  filter,
}: {
  nodes: KnowledgeNode[];
  selected: string;
  expanded: string[];
  onExpandedChange: (paths: string[]) => void;
  filter: string;
}) {
  const { t } = useT();
  const query = filter.trim().toLowerCase();
  const opened = [
    ...new Set([...expanded, ...ancestors(selected, "knowledge")]),
  ];
  const rows: Row[] = [];
  const matches = (node: KnowledgeNode): boolean => {
    if (!query) return true;
    if (node.kind === "directory") return node.children.some(matches);
    const label =
      node.kind === "document" ? (node.title ?? node.name) : node.name;
    return (
      label.toLowerCase().includes(query) ||
      (node.kind === "document" && !!node.key && node.key.includes(query))
    );
  };
  const visit = (items: KnowledgeNode[], depth: number) => {
    for (const node of items) {
      if (!matches(node)) continue;
      if (node.kind === "directory") {
        const open = !!query || opened.includes(node.path);
        rows.push({
          key: node.path,
          name: node.name,
          depth,
          kind: "directory",
          path: node.path,
          to: routeForPath(node.path),
          selected: node.path === selected,
          open,
          ignored: false,
        });
        if (open) visit(node.children, depth + 1);
      } else {
        rows.push({
          key: node.path,
          name:
            node.kind === "document" ? (node.title ?? node.name) : node.name,
          depth,
          kind: "file",
          path: node.path,
          to: routeForPath(node.path),
          selected: node.path === selected,
          open: false,
          ignored: false,
          error: node.kind === "document" ? node.error : null,
        });
      }
    }
  };
  visit(nodes, 0);
  const toggle = (path: string) =>
    onExpandedChange(
      opened.includes(path)
        ? opened.filter((item) => item !== path)
        : [...opened, path],
    );
  return (
    <nav
      className="flex min-h-0 flex-col gap-px overflow-auto"
      aria-label={t("knowledgeTree")}
      data-testid="knowledge-tree"
    >
      {rows.length ? (
        rows.map((row) => (
          <TreeRow
            key={row.key}
            row={row}
            onToggle={
              row.kind === "directory" ? () => toggle(row.path) : undefined
            }
          />
        ))
      ) : (
        <p className="px-2 py-3 text-[13px] text-muted-foreground">
          {t("knowledgeEmpty")}
        </p>
      )}
    </nav>
  );
}
