import { api, WORK_ID } from "./api";

export type ResolvedLink =
  | { kind: "route"; to: string }
  | { kind: "external"; href: string }
  | { kind: "anchor"; href: string }
  | { kind: "unsupported" };

function normalize(segments: string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(segment);
  }
  return out;
}

/** Workspace-relative target of a Markdown href, or null when it leaves the tree. */
export function resolveLocalPath(
  documentPath: string,
  href: string,
): string | null {
  let raw = href.split(/[?#]/, 1)[0] ?? "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    !raw ||
    raw.includes("\\") ||
    raw.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(raw) ||
    [...raw].some((char) => char.charCodeAt(0) < 32)
  )
    return null;
  const base = raw.startsWith("/") ? [] : documentPath.split("/").slice(0, -1);
  const segments = normalize([...base, ...raw.split("/")]);
  return segments?.length ? segments.join("/") : null;
}

/** Route for a workspace-relative file, or null outside Work and Knowledge. */
export function routeForPath(target: string): string | null {
  const parts = target.split("/");
  if (parts[0] === "work" && WORK_ID.test(parts[1] ?? "")) {
    const rest = parts.slice(2);
    if (!rest.length || rest.join("/") === "overview.md")
      return `/work/${parts[1]}`;
    return `/work/${parts[1]}/file/${rest.map(encodeURIComponent).join("/")}`;
  }
  if (parts[0] === "knowledge") {
    const rest = parts.slice(1);
    return rest.length
      ? `/knowledge/${rest.map(encodeURIComponent).join("/")}`
      : "/knowledge";
  }
  return null;
}

export function resolveLink(documentPath: string, href: string): ResolvedLink {
  if (
    /^https?:\/\//i.test(href) &&
    ![...href].some((char) => char.charCodeAt(0) <= 32)
  )
    return { kind: "external", href };
  if (href.startsWith("#")) return { kind: "anchor", href };
  const target = resolveLocalPath(documentPath, href);
  const to = target ? routeForPath(target) : null;
  return to ? { kind: "route", to } : { kind: "unsupported" };
}

/** Same-origin download URL for a local image, null for anything else. */
export function resolveImage(documentPath: string, src: string): string | null {
  const target = resolveLocalPath(documentPath, src);
  if (!target || !routeForPath(target)) return null;
  return api.downloadUrl(target);
}

/** Workspace path described by a route, used to reverse links. */
export function workFilePath(id: string, splat: string | undefined): string {
  if (!splat) return `work/${id}/overview.md`;
  return `work/${id}/${splat
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/")}`;
}
