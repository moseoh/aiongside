import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkReader, WorkspaceError } from "@aiongside/filesystem";
import {
  isLocalAddress,
  isLoopback,
  normalizeWebHost,
  parseWebUrl,
  startWebServer,
} from "@aiongside/web";

interface RuntimeState {
  root: string;
  token: string;
  pid: number;
  url?: string;
  controlUrl?: string;
}

function runtimeError(message: string) {
  return new WorkspaceError(message, "AIO-WEB-RUNTIME");
}

export function webStatePath(root: string): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(
    cache,
    "aiongside",
    "web",
    `${createHash("sha256").update(root).digest("hex")}.json`,
  );
}

async function readState(file: string): Promise<RuntimeState | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16_384)
      throw runtimeError("Unsafe Web View runtime file.");
    const state = JSON.parse(await handle.readFile("utf8")) as RuntimeState;
    if (
      typeof state.root !== "string" ||
      !/^[a-f0-9]{64}$/.test(state.token) ||
      !Number.isSafeInteger(state.pid) ||
      state.pid < 1 ||
      (state.url !== undefined && typeof state.url !== "string") ||
      (state.controlUrl !== undefined && typeof state.controlUrl !== "string")
    )
      throw runtimeError("Invalid Web View runtime file.");
    if (state.url !== undefined) parseWebUrl(state.url);
    if (state.controlUrl !== undefined) parseWebUrl(state.controlUrl);
    return state;
  } finally {
    await handle.close();
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function control(state: RuntimeState, method = "GET") {
  if (!state.url) throw runtimeError("Web View is starting. Retry shortly.");
  const destination = parseWebUrl(state.controlUrl ?? state.url);
  if (!isLocalAddress(normalizeWebHost(destination.hostname)))
    throw runtimeError(
      "Server control requires a saved IP address on this machine. No request was sent.",
    );
  const response = await fetch(`${destination.origin}/_control`, {
    method,
    headers: { "x-aiongside-token": state.token },
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!response.ok)
    throw runtimeError(
      "Cannot authenticate the Web View server. No process was signalled.",
    );
  return response.json() as Promise<{
    root?: string;
    pid?: number;
    stopped?: boolean;
  }>;
}

async function release(file: string, token: string) {
  const current = await readState(file);
  if (current?.token === token) await unlink(file);
}

export async function stopBackgroundWeb(root: string): Promise<boolean> {
  root = await realpath(root);
  const file = webStatePath(root);
  const state = await readState(file);
  if (!state) return false;
  if (state.root !== root)
    throw runtimeError("Web View runtime belongs to another workspace.");
  if (!alive(state.pid)) {
    await release(file, state.token);
    return false;
  }
  const identity = await control(state);
  if (identity.root !== root || identity.pid !== state.pid)
    throw runtimeError("Web View identity changed. No process was signalled.");
  await control(state, "POST");
  // Wait for the worker's own cleanup; do not delete a replacement server's state.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if ((await readState(file))?.token !== state.token) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw runtimeError(
    "Server accepted stop but cleanup is still pending. Retry shortly.",
  );
}

export async function startBackgroundWeb(
  root: string,
  port?: number,
  host?: string,
) {
  if (host !== undefined) host = normalizeWebHost(host);
  root = (await WorkReader.create(root)).root;
  const file = webStatePath(root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!(await lstat(path.dirname(file))).isDirectory())
    throw runtimeError("Unsafe runtime directory.");
  const existing = await readState(file);
  if (existing) {
    if (existing.root !== root)
      throw runtimeError("Web View runtime belongs to another workspace.");
    if (alive(existing.pid)) {
      const previous = existing.url ? parseWebUrl(existing.url) : undefined;
      if (
        previous &&
        ((host !== undefined && host !== normalizeWebHost(previous.hostname)) ||
          (port !== undefined && port !== Number(previous.port || 80)))
      )
        throw runtimeError(
          "A background Web View already uses another host or port. Run view web stop before restarting.",
        );
      const identity = await control(existing);
      if (identity.root !== root || identity.pid !== existing.pid)
        throw runtimeError(
          "Web View identity does not match its runtime record.",
        );
      return {
        url: existing.url as string,
        root,
        existing: true,
        network: !isLoopback(
          normalizeWebHost(
            parseWebUrl(existing.controlUrl ?? (existing.url as string))
              .hostname,
          ),
        ),
      };
    }
    await release(file, existing.token);
  }
  const token = randomBytes(32).toString("hex");
  let reservation: Awaited<ReturnType<typeof open>>;
  try {
    reservation = await open(file, "wx", 0o600);
  } catch {
    throw runtimeError("Another Web View start is in progress. Retry shortly.");
  }
  await reservation.writeFile(
    JSON.stringify({ root, token, pid: process.pid }),
  );
  let child: ReturnType<typeof fork> | undefined;
  try {
    const entry = process.argv[1];
    if (!entry)
      throw runtimeError("Cannot locate the installed CLI entry point.");
    child = fork(entry, ["--root", root, "view", "web"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, AIONGSIDE_WEB_CHILD: "1" },
      execArgv: [],
    });
    const worker = child;
    const ready = await new Promise<{
      url: string;
      controlUrl: string;
      network: boolean;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            runtimeError(
              "Background server did not become ready within 10 seconds.",
            ),
          ),
        10_000,
      );
      const finish = (
        error?: Error,
        value?: { url: string; controlUrl: string; network: boolean },
      ) => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) =>
        finish(
          runtimeError(
            `Background server exited before setup completed (${code}).`,
          ),
        ),
      );
      worker.on(
        "message",
        (message: {
          type?: string;
          url?: string;
          controlUrl?: string;
          network?: boolean;
          error?: string;
        }) => {
          if (message.type === "configure")
            worker.send({ root, port, host, token });
          if (message.type === "ready" && message.url && message.controlUrl)
            finish(undefined, {
              url: message.url,
              controlUrl: message.controlUrl,
              network: message.network === true,
            });
          if (message.type === "error")
            finish(runtimeError(message.error ?? "Background server failed."));
        },
      );
    });
    await reservation.truncate(0);
    await reservation.write(
      JSON.stringify({
        root,
        token,
        pid: worker.pid,
        url: ready.url,
        controlUrl: ready.controlUrl,
      }),
      0,
      "utf8",
    );
    await reservation.sync();
    worker.send({ type: "commit" });
    // The worker must acknowledge ownership before the parent exits.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(runtimeError("Background server could not confirm startup.")),
        3000,
      );
      worker.once("message", (message: { type?: string }) => {
        clearTimeout(timer);
        if (message.type === "committed") resolve();
        else reject(runtimeError("Invalid background startup response."));
      });
    });
    worker.disconnect();
    worker.unref();
    return { url: ready.url, root, existing: false, network: ready.network };
  } catch (error) {
    // Before commit, IPC disconnect makes our own worker close itself.
    if (child?.connected) child.disconnect();
    child?.unref();
    await release(file, token);
    throw error;
  } finally {
    await reservation.close();
  }
}

export async function runWebWorker(): Promise<void> {
  const configuration = new Promise<{
    root: string;
    port?: number;
    host?: string;
    token: string;
  }>((resolve) => process.once("message", resolve));
  process.send?.({ type: "configure" });
  const { root, port, host, token } = await configuration;
  let committed = false;
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
  const cleanup = async () => {
    await server?.close();
    await release(webStatePath(root), token);
  };
  const onDisconnect = () => {
    if (!committed) void cleanup();
  };
  process.on("disconnect", onDisconnect);
  try {
    server = await startWebServer(root, {
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      token,
      onStop: cleanup,
    });
    if (!process.connected) {
      await cleanup();
      return;
    }
    process.once("message", (message: { type?: string }) => {
      if (message.type === "commit") {
        committed = true;
        process.send?.({ type: "committed" });
      }
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void cleanup();
      });
    process.send?.({
      type: "ready",
      url: server.url,
      controlUrl: server.controlUrl,
      network: server.network,
    });
  } catch (error) {
    process.send?.({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup();
    if (process.connected) process.disconnect();
    process.exitCode = 2;
  }
}

export async function runForegroundWeb(
  root: string,
  port?: number,
  host?: string,
) {
  const server = await startWebServer(root, {
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server.close();
    });
  return server;
}
