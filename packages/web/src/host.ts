import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { WorkspaceError } from "@aiongside/filesystem";

export function normalizeWebHost(input = "127.0.0.1"): string {
  const host =
    input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (
    !host ||
    host.length > 253 ||
    (!isIP(host) &&
      !host
        .split(".")
        .every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part)))
  ) {
    throw new WorkspaceError(
      "Host must be an IP address or hostname, without a scheme, port or path.",
      "AIO-WEB-HOST",
    );
  }
  const normalized = new URL(
    `http://${isIP(host) === 6 ? `[${host}]` : host}`,
  ).hostname.replace(/^\[|\]$/g, "");
  if (["0.0.0.0", "::", "::ffff:0:0"].includes(normalized))
    throw new WorkspaceError(
      "Use a specific interface address, not a wildcard host.",
      "AIO-WEB-HOST",
    );
  return normalized;
}

export function webUrl(host: string, port: number): string {
  return new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`)
    .origin;
}

export function isLoopback(host: string): boolean {
  return (
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127.")) ||
    /^::ffff:7f[\da-f]{2}:/i.test(host)
  );
}

export function isLocalAddress(host: string): boolean {
  if (!isIP(host)) return false;
  return (
    isLoopback(host) ||
    Object.values(networkInterfaces())
      .flat()
      .some((entry) => entry && normalizeWebHost(entry.address) === host)
  );
}

export async function resolveWebHost(input?: string) {
  const host = normalizeWebHost(input);
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  const address = normalizeWebHost(
    (addresses.find((item) => item.family === 4) ?? addresses[0])?.address ??
      "",
  );
  return { host, address };
}

export function parseWebUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin !== value
  )
    throw new WorkspaceError("Invalid Web View server URL.", "AIO-WEB-RUNTIME");
  normalizeWebHost(url.hostname);
  return url;
}
