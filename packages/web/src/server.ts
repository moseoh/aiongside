import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { WorkReader } from "@aiongside/filesystem";
import { webAssets } from "./assets.generated.js";
import { isLoopback, resolveWebHost, webUrl } from "./host.js";

export async function startWebServer(
  root: string,
  options: {
    host?: string;
    port?: number;
    token?: string;
    onStop?: () => Promise<void>;
  } = {},
) {
  const canonical = (await WorkReader.create(root)).root;
  const binding = await resolveWebHost(options.host);
  const allowedOrigins = new Set<string>();
  let url = "";
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      timer.unref();
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
    return closing;
  };
  const server = createServer(async (request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const json = (code: number, data: unknown) => {
      response.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(data));
    };
    try {
      const requestOrigin = `http://${request.headers.host}`;
      if (
        !allowedOrigins.has(requestOrigin) ||
        (request.headers.origin && request.headers.origin !== requestOrigin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        json(403, {
          error: "Only requests from this Web View address are allowed.",
        });
        return;
      }
      const target = new URL(request.url ?? "/", requestOrigin);
      if (target.origin !== requestOrigin) {
        json(403, { error: "Invalid request origin." });
        return;
      }
      if (target.pathname === "/_control") {
        const supplied = request.headers["x-aiongside-token"];
        if (
          !options.token ||
          typeof supplied !== "string" ||
          supplied.length !== options.token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(options.token))
        ) {
          json(403, { error: "Invalid server control token." });
          return;
        }
        if (request.method === "GET") {
          json(200, { root: canonical, pid: process.pid });
          return;
        }
        if (request.method === "POST") {
          json(200, { stopped: true });
          await close();
          await options.onStop?.();
          return;
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(405, { error: "Work documents are read-only." });
        return;
      }
      if (!target.pathname.startsWith("/api/")) {
        // Exact asset match, else the SPA entry for every other page route.
        const asset = Object.hasOwn(webAssets, target.pathname)
          ? webAssets[target.pathname]
          : target.pathname.startsWith("/assets/")
            ? undefined
            : webAssets["/index.html"];
        if (!asset) {
          json(404, { error: "Not found." });
          return;
        }
        const body = Buffer.from(asset.content, asset.encoding);
        response.writeHead(200, {
          "Content-Type": asset.type,
          "Content-Length": body.length,
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      const reader = new WorkReader(canonical);
      const file = target.searchParams.get("path") ?? "";
      if (target.pathname === "/api/works") {
        json(200, await reader.list());
        return;
      }
      const single = /^\/api\/works\/([^/]+)$/.exec(target.pathname);
      if (single) {
        json(200, await reader.work(decodeURIComponent(single[1] ?? "")));
        return;
      }
      if (target.pathname === "/api/knowledge") {
        json(200, await reader.knowledge());
        return;
      }
      if (target.pathname === "/api/directory") {
        json(200, await reader.directory(file));
        return;
      }
      if (target.pathname === "/api/document") {
        json(200, await reader.document(file));
        return;
      }
      if (target.pathname === "/api/download") {
        const { handle, size } = await reader.open(file);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.split("/").at(-1) ?? "file").replaceAll("'", "%27")}`,
          "Content-Length": size,
        });
        if (request.method === "HEAD") {
          await handle.close();
          response.end();
        } else await pipeline(handle.createReadStream(), response);
        return;
      }
      json(404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent)
        json(400, {
          error: error instanceof Error ? error.message : String(error),
        });
      else response.destroy();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, binding.address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot resolve Web View address.");
  url = webUrl(binding.host, address.port);
  const controlUrl = webUrl(binding.address, address.port);
  allowedOrigins.add(url);
  allowedOrigins.add(controlUrl);
  return {
    url,
    controlUrl,
    root: canonical,
    close,
    network: !isLoopback(binding.address),
  };
}
