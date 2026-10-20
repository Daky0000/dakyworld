/**
 * The DakyX edge bridge (Route B of the publish router).
 *
 * A Cloudflare Worker in front of a customer's own host, reached through
 * Cloudflare for SaaS: the customer points one DNS record at us, and every
 * request for their site passes through here on its way to their host. Almost
 * always it passes straight through. The exception is the minute or so after a
 * publish, while the host is still rebuilding: then the files that publish
 * changed are served from here, so the change is live in under a second.
 *
 * **It fails open.** Anything that goes wrong here (a bug, a storage error, a
 * missing config) passes the request to the host untouched. The worst this can
 * do is be no faster than the host on its own.
 *
 * Each hostname has one Durable Object holding its config (where the host
 * serves the site) and the bridged files. A Durable Object rather than Workers
 * KV, which the plan first named: KV is eventually consistent and may keep
 * serving an old answer, including "nothing here", for up to a minute in other
 * locations. That is exactly the window this exists to close. A Durable Object
 * answers from one place, consistently.
 *
 * The OS writes to it through the admin hostname with a bearer token. A file
 * expires after a day unless renewed; the OS renews files whose host has not
 * caught up, for up to seven days, and deletes them once it has. The OS checks
 * that by sending the bypass header, which skips the bridged files, so it sees
 * what the host itself serves rather than its own copy.
 *
 * Deploy: see ../README.md.
 */

/* --------------------------------------------- the platform, as much as is used */

export interface DurableStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string | string[]): Promise<boolean | number>;
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  setAlarm?(at: number): Promise<void>;
  getAlarm?(): Promise<number | null>;
}
export interface DurableState { storage: DurableStorage }
interface DurableStub { fetch(input: string | Request, init?: RequestInit): Promise<Response> }
interface DurableNamespace { idFromName(name: string): unknown; get(id: unknown): DurableStub }

export interface Env {
  BRIDGE: DurableNamespace;
  /** Bearer token the OS sends to the admin hostname. */
  ADMIN_TOKEN: string;
  /** The hostname the OS talks to, e.g. bridge-admin.dakyxsites.com. */
  ADMIN_HOST: string;
  /** Header value that skips bridged files, so the OS can see the host's own copy. */
  BYPASS_TOKEN: string;
}

/* ---------------------------------------------------------------- the shapes */

export type BridgeConfig = { hostname: string; origin: string; siteId: string; updatedAt: number };
export type BridgeObject = { body: string; encoding: "base64"; contentType: string; commit: string; expiresAt: number; storedAt: number };

export const DAY_MS = 24 * 60 * 60_000;
/** The largest file kept here; Durable Object storage takes up to 2 MB a value. */
export const MAX_OBJECT_BYTES = 1_900_000;

/** The stored names a request path could be served from, most specific first. */
export function candidatePaths(pathname: string): string[] {
  let path = pathname || "/";
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Leave it as it came. */
  }
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.endsWith("/")) return [`${path}index.html`, path];
  if (/\.[a-z0-9]{1,8}$/i.test(path)) return [path];
  return [path, `${path}.html`, `${path}/index.html`];
}

/** The host's own address for a request: the origin plus the path and query. */
export function originUrl(origin: string, request: URL): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}${request.pathname}${request.search}`;
}

const isHtml = (contentType: string | null) => Boolean(contentType && /text\/html/i.test(contentType));

/** Headers for a bridged file: always revalidated, so the host's copy takes over the moment it is cleared. */
export function bridgedHeaders(object: BridgeObject): Headers {
  const headers = new Headers({
    "content-type": object.contentType,
    "cache-control": isHtml(object.contentType) ? "no-cache" : "public, max-age=60",
    "x-dakyx-bridge": "hit",
    "x-dakyx-commit": object.commit,
  });
  return headers;
}

/* ------------------------------------------------------- one hostname's store */

/**
 * The Durable Object for one hostname. Its fetch() is called by the Worker
 * below, never by the public, on a few internal paths.
 */
export class SiteBridge {
  private config: BridgeConfig | null | undefined;
  constructor(private state: DurableState) {}

  private async loadConfig(): Promise<BridgeConfig | null> {
    if (this.config === undefined) this.config = (await this.state.storage.get<BridgeConfig>("config")) ?? null;
    return this.config;
  }

  private async scheduleSweep(at: number): Promise<void> {
    if (!this.state.storage.setAlarm || !this.state.storage.getAlarm) return;
    const current = await this.state.storage.getAlarm();
    if (current === null || current > at) await this.state.storage.setAlarm(at);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const path = url.searchParams.get("path") ?? "/";

    if (url.pathname === "/lookup") {
      const config = await this.loadConfig();
      if (!config) return new Response(null, { status: 404 });
      if (url.searchParams.get("bypass") !== "1" && ["GET", "HEAD"].includes(url.searchParams.get("method") ?? "GET")) {
        for (const candidate of candidatePaths(path)) {
          const object = await this.state.storage.get<BridgeObject>(`obj:${candidate}`);
          if (object && object.expiresAt > now) {
            return new Response(Uint8Array.from(atob(object.body), (char) => char.charCodeAt(0)), { status: 200, headers: bridgedHeaders(object) });
          }
        }
      }
      return new Response(null, { status: 204, headers: { "x-origin": config.origin } });
    }

    if (url.pathname === "/config" && request.method === "PUT") {
      const body = (await request.json()) as Partial<BridgeConfig>;
      if (!body.origin || !/^https?:\/\//.test(body.origin) || !body.hostname) return Response.json({ error: "origin and hostname are required" }, { status: 400 });
      this.config = { hostname: body.hostname, origin: body.origin, siteId: body.siteId ?? "", updatedAt: now };
      await this.state.storage.put("config", this.config);
      return Response.json({ ok: true, config: this.config });
    }

    if (url.pathname === "/config" && request.method === "DELETE") {
      const keys = [...(await this.state.storage.list({ prefix: "obj:" })).keys()];
      if (keys.length) await this.state.storage.delete(keys);
      await this.state.storage.delete("config");
      this.config = null;
      return Response.json({ ok: true, cleared: keys.length });
    }

    if (url.pathname === "/object" && request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_OBJECT_BYTES) return Response.json({ error: "too large" }, { status: 413 });
      const ttl = Math.min(Number(url.searchParams.get("ttl") ?? DAY_MS) || DAY_MS, 7 * DAY_MS);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      const object: BridgeObject = { body: btoa(binary), encoding: "base64", contentType: request.headers.get("content-type") ?? "application/octet-stream", commit: request.headers.get("x-dakyx-commit") ?? "", expiresAt: now + ttl, storedAt: now };
      await this.state.storage.put(`obj:${path}`, object);
      await this.scheduleSweep(object.expiresAt);
      return Response.json({ ok: true, path, expiresAt: object.expiresAt });
    }

    if (url.pathname === "/object" && request.method === "DELETE") {
      await this.state.storage.delete(`obj:${path}`);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/renew" && request.method === "POST") {
      const body = (await request.json()) as { paths?: string[]; ttl?: number };
      const ttl = Math.min(body.ttl ?? DAY_MS, 7 * DAY_MS);
      let renewed = 0;
      for (const entry of body.paths ?? []) {
        const object = await this.state.storage.get<BridgeObject>(`obj:${entry}`);
        if (!object) continue;
        object.expiresAt = now + ttl;
        await this.state.storage.put(`obj:${entry}`, object);
        renewed++;
      }
      await this.scheduleSweep(now + ttl);
      return Response.json({ ok: true, renewed });
    }

    if (url.pathname === "/status") {
      const objects = await this.state.storage.list<BridgeObject>({ prefix: "obj:" });
      return Response.json({
        config: await this.loadConfig(),
        objects: [...objects.entries()].map(([key, object]) => ({ path: key.slice(4), commit: object.commit, expiresAt: object.expiresAt, bytes: Math.floor((object.body.length * 3) / 4) })),
      });
    }

    return new Response("Not found", { status: 404 });
  }

  /** Deletes expired files and schedules the next sweep. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const objects = await this.state.storage.list<BridgeObject>({ prefix: "obj:" });
    const expired = [...objects.entries()].filter(([, object]) => object.expiresAt <= now).map(([key]) => key);
    if (expired.length) await this.state.storage.delete(expired);
    const next = [...objects.values()].filter((object) => object.expiresAt > now).map((object) => object.expiresAt).sort((a, b) => a - b)[0];
    if (next && this.state.storage.setAlarm) await this.state.storage.setAlarm(next);
  }
}

/* ------------------------------------------------------------------ the Worker */

/** Fetches from the host. A redirect back to this very hostname would loop, so it is answered as it came. */
async function passThrough(request: Request, origin: string, fetcher: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const target = originUrl(origin, url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", url.hostname);
  const response = await fetcher(target, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "manual" });
  const location = response.headers.get("location");
  if (location) {
    // The host redirecting to its own address (github.io, netlify.app) is
    // rewritten onto the customer's hostname, so a visitor never leaves it.
    try {
      const moved = new URL(location, target);
      const originHost = new URL(origin).hostname;
      if (moved.hostname === originHost) {
        const originPath = new URL(origin).pathname.replace(/\/+$/, "");
        const rewritten = new URL(request.url);
        rewritten.pathname = originPath && moved.pathname.startsWith(originPath) ? moved.pathname.slice(originPath.length) || "/" : moved.pathname;
        rewritten.search = moved.search;
        const copy = new Response(response.body, response);
        copy.headers.set("location", rewritten.toString());
        return copy;
      }
    } catch {
      /* Not a URL; pass it on. */
    }
  }
  if (!isHtml(response.headers.get("content-type"))) return response;
  // A page is always revalidated, so a visitor's browser picks up the host's
  // rebuild as soon as it lands rather than after the host's own cache time.
  const copy = new Response(response.body, response);
  copy.headers.set("cache-control", "no-cache");
  return copy;
}

/** The admin API: the OS's only way in. */
async function admin(request: Request, env: Env, fetcher: typeof fetch): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}` || !env.ADMIN_TOKEN) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  // /v1/probe?origin=…: what the host answers from Cloudflare's side, without following redirects.
  if (url.pathname === "/v1/probe") {
    const origin = url.searchParams.get("origin") ?? "";
    if (!/^https?:\/\//.test(origin)) return Response.json({ error: "origin is required" }, { status: 400 });
    const response = await fetcher(origin, { redirect: "manual" }).catch((error: Error) => ({ status: 0, headers: new Headers(), statusText: error.message } as unknown as Response));
    return Response.json({ status: response.status, location: response.headers.get("location"), server: response.headers.get("server") });
  }
  const match = /^\/v1\/hosts\/([a-z0-9.-]+)\/(config|object|renew|status)$/i.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const [, hostname, action] = match;
  const stub = env.BRIDGE.get(env.BRIDGE.idFromName(hostname!.toLowerCase()));
  const inner = new URL(`https://bridge/${action}`);
  url.searchParams.forEach((value, key) => inner.searchParams.set(key, value));
  return stub.fetch(new Request(inner.toString(), { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() }));
}

/**
 * Each hostname's host address, as last seen by this isolate. If the Durable
 * Object cannot be reached, the request still goes to the customer's host
 * rather than anywhere else.
 */
const knownOrigins = new Map<string, string>();

/** One public request: a bridged file if there is one, the host otherwise, and the host on any error. */
export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === env.ADMIN_HOST) return admin(request, env, fetcher);
  const hostname = url.hostname.toLowerCase();
  let origin: string | null = knownOrigins.get(hostname) ?? null;
  try {
    const stub = env.BRIDGE.get(env.BRIDGE.idFromName(hostname));
    const bypass = Boolean(env.BYPASS_TOKEN) && request.headers.get("x-dakyx-bridge-bypass") === env.BYPASS_TOKEN;
    const lookup = await stub.fetch(`https://bridge/lookup?path=${encodeURIComponent(url.pathname)}&method=${request.method}&bypass=${bypass ? 1 : 0}`);
    if (lookup.status === 200) return lookup;
    origin = lookup.headers.get("x-origin") ?? origin;
    if (origin) knownOrigins.set(hostname, origin);
    if (lookup.status === 404) knownOrigins.delete(hostname);
  } catch {
    /* Fail open, below, to the host if it is known. */
  }
  if (origin) {
    try {
      return await passThrough(request, origin, fetcher);
    } catch {
      /* The host itself did not answer; let Cloudflare's own path try. */
    }
  }
  return fetcher(request);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
