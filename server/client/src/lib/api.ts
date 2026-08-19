const BASE = import.meta.env.VITE_API_BASE ?? "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The server's reference for an unexplained failure, kept on the message.
 *
 * A 500 answers "Something went wrong." on purpose — the real message names
 * tables, hosts and file paths, and it belongs in the log rather than on
 * screen. The reference is what ties the two together, so putting it in front
 * of the person reporting the problem is the difference between "it broke" and
 * a log line somebody can go and read.
 */
function withReference(message: string, reference: unknown): string {
  return typeof reference === "string" && reference && message.startsWith("Something went wrong")
    ? `${message} (reference ${reference})`
    : message;
}

/** Called when the server rejects a session mid-use, so the UI can fall back to the login screen. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  // The session lives in an HTTP-only cookie, so there's no token to attach —
  // it just has to be sent, including on the Vite dev server's proxied origin.
  const res = await fetch(`${BASE}${path}`, { ...options, headers, credentials: "include" });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // A 401 on /auth/me is just "not logged in yet" — the provider handles it.
    if (res.status === 401 && path !== "/auth/me") onUnauthorized?.();
    throw new ApiError(res.status, withReference(body.error ?? res.statusText, body.reference));
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * An absolute path to an API endpoint, for the places the browser fetches on
 * its own — an `<iframe>` showing a PDF, a download link. The session is an
 * HTTP-only cookie on the same origin, so both carry it without any help.
 */
export const apiUrl = (path: string) => `${BASE}${path}`;

/** For endpoints that answer with a file rather than JSON. */
export async function postForBlob(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, withReference(detail.error ?? res.statusText, detail.reference));
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
