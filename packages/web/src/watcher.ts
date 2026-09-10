import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { WorkReader } from "@aiongside/filesystem";

export type ChangeKind = "created" | "updated" | "deleted";

export interface ChangeEvent {
  id: number;
  at: string;
  scope: "work" | "knowledge";
  /** Work ID when the path is inside a Work folder. */
  work?: string;
  /** Work title when known from the Record snapshot. */
  title?: string;
  path: string;
  kind: ChangeKind;
  status?: { from: string; to: string };
  error?: string;
}

export type ChangeListener = (events: ChangeEvent[]) => void;

const WATCHED = ["work", "knowledge"] as const;

/**
 * Watches the managed Work and Knowledge folders and turns raw file system
 * notifications into debounced, deduplicated change events. Reads only.
 */
export class WorkspaceWatcher {
  private readonly listeners = new Set<ChangeListener>();
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private nextId = 1;
  private readonly watchers: FSWatcher[] = [];
  private readonly buffer: ChangeEvent[] = [];
  /** Last known Record metadata per Work ID, for status transitions. */
  private readonly records = new Map<
    string,
    { status: string; title: string }
  >();

  private constructor(
    private readonly reader: WorkReader,
    private readonly debounceMs: number,
    private readonly bufferSize: number,
  ) {}

  static async start(
    root: string,
    options: { debounceMs?: number; bufferSize?: number } = {},
  ): Promise<WorkspaceWatcher> {
    const reader = await WorkReader.create(root);
    const watcher = new WorkspaceWatcher(
      reader,
      options.debounceMs ?? 300,
      options.bufferSize ?? 200,
    );
    for (const work of (await reader.list()).works)
      watcher.records.set(work.id, { status: work.status, title: work.title });
    for (const folder of WATCHED) {
      const absolute = path.join(reader.root, folder);
      try {
        const handle = watch(absolute, { recursive: true }, (_, name) => {
          if (typeof name !== "string") return;
          watcher.enqueue(
            path.posix.join(folder, name.split(path.sep).join("/")),
          );
        });
        handle.on("error", () => {});
        watcher.watchers.push(handle);
      } catch {
        // Missing folder: nothing to watch until the server restarts.
      }
    }
    return watcher;
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Events after `id`, or undefined when that point is no longer (or not yet)
   * covered by the replay buffer so the client must reload everything.
   */
  since(id: number): ChangeEvent[] | undefined {
    if (id >= this.nextId) return undefined;
    const oldest = this.buffer[0];
    if (oldest && id < oldest.id - 1) return undefined;
    if (!oldest && id < this.nextId - 1) return undefined;
    return this.buffer.filter((event) => event.id > id);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    for (const handle of this.watchers.splice(0)) handle.close();
    await this.flushing;
    this.listeners.clear();
  }

  private enqueue(relative: string) {
    this.pending.add(relative);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushing = this.flushing.then(() => this.flush());
    }, this.debounceMs);
  }

  private async flush() {
    const paths = [...this.pending].sort();
    this.pending.clear();
    const events: ChangeEvent[] = [];
    for (const relative of paths) {
      const event = await this.describe(relative);
      if (event) events.push(event);
    }
    if (!events.length) return;
    this.buffer.push(...events);
    if (this.buffer.length > this.bufferSize)
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    for (const listener of this.listeners) listener(events);
  }

  private async describe(relative: string): Promise<ChangeEvent | undefined> {
    const segments = relative.split("/");
    const [scope, work] = segments;
    if (scope !== "work" && scope !== "knowledge") return undefined;
    // A Work folder itself changes only through its files; the Record covers it.
    if (scope === "work" && segments.length < 3) return undefined;
    if (!(await this.reader.files.includes(relative))) return undefined;
    let kind: ChangeKind = "updated";
    try {
      // Folder notifications carry no content change; the file inside does.
      if ((await stat(path.join(this.reader.root, relative))).isDirectory())
        return undefined;
    } catch {
      kind = "deleted";
    }
    const event: ChangeEvent = {
      id: 0,
      at: new Date().toISOString(),
      scope,
      ...(scope === "work" && work ? { work } : {}),
      path: relative,
      kind,
    };
    if (
      scope === "work" &&
      work &&
      segments.length === 3 &&
      segments[2] === "record.md"
    )
      await this.describeRecord(event, work);
    else {
      const known = work ? this.records.get(work) : undefined;
      if (known) event.title = known.title;
    }
    event.id = this.nextId++;
    return event;
  }

  private async describeRecord(event: ChangeEvent, work: string) {
    const previous = this.records.get(work);
    if (event.kind === "deleted") {
      if (previous) event.title = previous.title;
      this.records.delete(work);
      return;
    }
    try {
      const metadata = await this.reader.work(work);
      const current = { status: metadata.status, title: metadata.title };
      this.records.set(work, current);
      event.title = current.title;
      if (!previous) {
        event.kind = "created";
        event.status = { from: "", to: current.status };
      } else if (previous.status !== current.status)
        event.status = { from: previous.status, to: current.status };
    } catch (error) {
      // Keep the last known state until the Record becomes readable again.
      if (previous) event.title = previous.title;
      event.error = error instanceof Error ? error.message : String(error);
    }
  }
}
