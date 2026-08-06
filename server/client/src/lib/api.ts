const BASE = import.meta.env.VITE_API_BASE ?? "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
    throw new ApiError(res.status, body.error ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
