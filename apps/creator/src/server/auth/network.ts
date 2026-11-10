/**
 * Who can reach this server, decided from the environment and the bind address: pure functions,
 * no I/O.
 *
 * - `HOST` is the address `npm start` and `npm run dev` bind to (`127.0.0.1` when unset). Next.js
 *   puts the bind address in the request URL, so a server started some other way on a
 *   non-loopback address is caught too.
 * - `STUDIO_ALLOWED_HOSTS` is a comma-separated list of hostnames the Host header may carry besides
 *   localhost, 127.0.0.1 and ::1: the LAN name or address people type, or the name a reverse proxy
 *   serves. Any such name means people on other machines reach the app.
 *
 * The app is network-exposed when either says so, and then the app password is required.
 * @packageDocumentation
 */
import { publicHost } from "@/server/demo";

type Env = Record<string, string | undefined>;

export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** Normalizes a hostname (or host:port) to the form `URL.hostname` uses; undefined if unparseable. */
export function normalizeHostname(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  // A bare IPv6 address (two or more colons, no brackets) is bracketed the way URL.hostname is.
  const candidate = !trimmed.startsWith("[") && (trimmed.match(/:/g)?.length ?? 0) > 1 ? `[${trimmed}]` : trimmed;
  try {
    const hostname = new URL(`http://${candidate}`).hostname;
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a hostname only ever means this machine: localhost (and *.localhost), 127.0.0.0/8, ::1. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function isWildcardHostname(hostname: string): boolean {
  return WILDCARD_HOSTS.has(hostname.trim().toLowerCase());
}

/** The bind address from `HOST`; `127.0.0.1` when unset or blank. */
export function bindHost(env: Env = process.env): string {
  return env.HOST?.trim() || "127.0.0.1";
}

/** Hostnames from `STUDIO_ALLOWED_HOSTS`, normalized; unparseable entries are dropped. */
export function configuredHosts(env: Env = process.env): string[] {
  return (env.STUDIO_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => normalizeHostname(entry))
    .filter((host): host is string => !!host);
}

/**
 * Whether people on other machines can reach this server: a non-loopback `HOST`, a non-loopback
 * name in `STUDIO_ALLOWED_HOSTS`, or a non-loopback bind address in the request URL.
 */
export function isNetworkExposed(env: Env = process.env, urlHostname?: string): boolean {
  if (!isLoopbackHostname(bindHost(env))) return true;
  if (configuredHosts(env).some((host) => !isLoopbackHostname(host))) return true;
  return urlHostname !== undefined && !isLoopbackHostname(urlHostname);
}

/**
 * Whether `X-Forwarded-Proto` is believed. Yes when a proxy is named (a non-loopback host in
 * `STUDIO_ALLOWED_HOSTS`, or a hosted copy's public host), and on a loopback-only server, where only
 * this machine can send it. A server exposed directly through `HOST`, with no proxy named, ignores
 * it: any client there could send it.
 */
export function trustsForwardedProto(env: Env = process.env, urlHostname?: string): boolean {
  if (configuredHosts(env).some((host) => !isLoopbackHostname(host)) || publicHost(env)) return true;
  return !isNetworkExposed(env, urlHostname);
}

/**
 * The scheme the browser used. Next.js builds the request URL's scheme from `X-Forwarded-Proto`
 * too, so when the header is not trusted the URL's scheme is not either.
 */
export function requestProtocol(request: Request, env: Env = process.env): "http:" | "https:" {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return trustsForwardedProto(env, url.hostname) && forwarded === "https" ? "https:" : "http:";
  return url.protocol === "https:" ? "https:" : "http:";
}

/**
 * The startup hint for a server listening on every interface with no names to accept: other
 * computers would get a 403 for the address they type. Null when there is nothing to say.
 */
export function allowedHostsHint(env: Env = process.env, addresses: string[] = []): string | null {
  if (!isWildcardHostname(bindHost(env))) return null;
  if (configuredHosts(env).some((host) => !isLoopbackHostname(host)) || publicHost(env)) return null;
  const example = addresses[0] ?? "192.168.1.20";
  const found = addresses.length ? ` This machine's addresses: ${addresses.join(", ")}.` : "";
  return `[auth] Only localhost is accepted as a host name, so other computers will be refused. Set STUDIO_ALLOWED_HOSTS to the names or addresses they type (for example STUDIO_ALLOWED_HOSTS=${example}) and restart.${found}`;
}

/** Every hostname the Host header may carry: loopback names, `STUDIO_ALLOWED_HOSTS`, a specific `HOST`, and a hosted copy's public host. */
export function acceptedHosts(env: Env = process.env): string[] {
  const hosts = new Set<string>(LOOPBACK_HOSTS);
  for (const host of configuredHosts(env)) hosts.add(host);
  const bind = bindHost(env);
  if (!isWildcardHostname(bind)) {
    const normalized = normalizeHostname(bind);
    if (normalized) hosts.add(normalized);
  }
  const hosted = publicHost(env);
  if (hosted) hosts.add(hosted);
  return [...hosts];
}
