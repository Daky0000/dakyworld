/**
 * Calls to a host's API (Netlify, Vercel, Cloudflare), with a time limit and an
 * error that keeps the status, so a route can tell "the token stopped working"
 * (pause the route, tell the customer to reconnect) from "the host is having a
 * bad minute" (fall back this once, try again next publish).
 */

export class HostApiError extends Error {
  status: number;
  host: string;
  constructor(host: string, status: number, message: string) {
    super(message);
    this.name = "HostApiError";
    this.status = status;
    this.host = host;
  }
  /** The token is no good any more: a reconnect, not a retry, fixes it. */
  get revoked(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type HostRequest = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string;
  json?: unknown;
  body?: Buffer | string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

/** The fetch to use; replaced by the checks with a recorded host. */
export const hostFetch: { fn: typeof fetch } = { fn: (input, init) => fetch(input, init) };

export async function hostCall<T>(host: string, url: string, options: HostRequest = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "DakyXTech-Publish", ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    headers["Content-Type"] ??= "application/octet-stream";
    body = typeof options.body === "string" ? options.body : new Uint8Array(options.body);
  }
  let response: Response;
  try {
    response = await hostFetch.fn(url, { method: options.method ?? "GET", headers, body, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
  } catch (error) {
    throw new HostApiError(host, 502, `${host} could not be reached: ${error instanceof Error ? error.message : "no answer"}`);
  }
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = typeof parsed === "object" && parsed
      ? ((parsed as { message?: string; error?: { message?: string; code?: string } | string; errors?: Array<{ message?: string }> }).message
        ?? (typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : (parsed as { error?: { message?: string } }).error?.message)
        ?? (parsed as { errors?: Array<{ message?: string }> }).errors?.[0]?.message)
      : typeof parsed === "string" ? parsed.slice(0, 200) : undefined;
    const error = new HostApiError(host, response.status, `${host} answered ${response.status}${detail ? `: ${detail}` : ""}`);
    (error as HostApiError & { body?: unknown }).body = parsed;
    throw error;
  }
  return parsed as T;
}

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
