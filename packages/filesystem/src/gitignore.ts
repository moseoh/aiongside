import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { WorkspaceError } from "./errors.js";

export interface IgnoreScope {
  directory: string;
  rules: Ignore;
}

/** Called once on entry to each traversed directory; never reads Git metadata. */
export async function extendIgnoreScopes(
  directory: string,
  parents: readonly IgnoreScope[],
): Promise<readonly IgnoreScope[]> {
  const target = path.join(directory, ".gitignore");
  try {
    const entry = await lstat(target);
    if (!entry.isFile()) {
      throw new WorkspaceError(
        `Cannot read ignore rules from a non-regular file: ${target}`,
        "AIO-IGNORE-READ",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parents;
    throw error;
  }
  return [
    ...parents,
    {
      directory,
      rules: ignore({ ignorecase: false }).add(await readFile(target, "utf8")),
    },
  ];
}

export function isIgnored(
  target: string,
  directory: boolean,
  scopes: readonly IgnoreScope[],
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const relative = path
      .relative(scope.directory, target)
      .split(path.sep)
      .join("/");
    const result = scope.rules.test(relative + (directory ? "/" : ""));
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/** Per-operation selection. Physical collision checks and discard previews do not use it. */
export class ManagedFiles {
  private readonly scopes = new Map<
    string,
    Promise<readonly IgnoreScope[] | undefined>
  >();
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private directoryScopes(
    directory: string,
  ): Promise<readonly IgnoreScope[] | undefined> {
    let pending = this.scopes.get(directory);
    if (!pending) {
      pending = (async () => {
        if (directory === this.root) return extendIgnoreScopes(directory, []);
        const parents = await this.directoryScopes(path.dirname(directory));
        if (!parents || isIgnored(directory, true, parents)) return undefined;
        try {
          if (!(await lstat(directory)).isDirectory())
            throw new WorkspaceError(
              `Cannot read ignore rules through a non-directory path: ${directory}`,
              "AIO-IGNORE-READ",
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return extendIgnoreScopes(directory, parents);
      })();
      this.scopes.set(directory, pending);
    }
    return pending;
  }

  async includes(target: string, directory = false): Promise<boolean> {
    const absolute = path.resolve(this.root, target);
    const relative = path.relative(this.root, absolute);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new WorkspaceError(
        `Managed path is outside the workspace: ${target}`,
        "AIO-PATH-IGNORED",
      );
    if (!relative) return true;
    // Configuration is read for selection, never treated as document content.
    if (path.basename(absolute) === ".gitignore") return false;
    const scopes = await this.directoryScopes(path.dirname(absolute));
    return scopes !== undefined && !isIgnored(absolute, directory, scopes);
  }

  async assertIncluded(target: string, directory = false): Promise<void> {
    if (!(await this.includes(target, directory)))
      throw new WorkspaceError(
        `Path is excluded by .gitignore: ${target}. Change the ignore rules before managing this path.`,
        "AIO-PATH-IGNORED",
      );
  }

  async entries(directory: string) {
    const absolute = path.resolve(this.root, directory);
    if (!(await this.includes(absolute, true))) return [];
    const scopes = await this.directoryScopes(absolute);
    if (!scopes) return [];
    return (await readdir(absolute, { withFileTypes: true })).filter(
      (entry) =>
        entry.name !== ".gitignore" &&
        !isIgnored(
          path.join(absolute, entry.name),
          entry.isDirectory(),
          scopes,
        ),
    );
  }

  /**
   * Directory listing that keeps excluded entries and marks them instead of
   * pruning. Rules are still read at every level, including inside excluded
   * parents, so a browser can reveal ignored content on request.
   */
  async selection(directory: string): Promise<{
    ignored: boolean;
    entries: { entry: Dirent; ignored: boolean }[];
  }> {
    const absolute = path.resolve(this.root, directory);
    const relative = path.relative(this.root, absolute);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new WorkspaceError(
        `Managed path is outside the workspace: ${directory}`,
        "AIO-PATH-IGNORED",
      );
    let scopes = await extendIgnoreScopes(this.root, []);
    let ignored = false;
    let current = this.root;
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      if (!ignored && isIgnored(current, true, scopes)) ignored = true;
      scopes = await extendIgnoreScopes(current, scopes);
    }
    const entries = (await readdir(absolute, { withFileTypes: true })).map(
      (entry) => ({
        entry,
        ignored:
          ignored ||
          isIgnored(
            path.join(absolute, entry.name),
            entry.isDirectory(),
            scopes,
          ),
      }),
    );
    return { ignored, entries };
  }

  async files(directory: string): Promise<string[]> {
    const absolute = path.resolve(this.root, directory);
    const result: string[] = [];
    for (const entry of await this.entries(absolute)) {
      const target = path.join(absolute, entry.name);
      if (entry.isDirectory()) result.push(...(await this.files(target)));
      else if (entry.isFile())
        result.push(path.relative(this.root, target).split(path.sep).join("/"));
      else
        throw new WorkspaceError(
          `Managed content must be a regular file or directory: ${target}`,
          "AIO-CONTENT-PATH",
        );
    }
    return result.sort();
  }
}
