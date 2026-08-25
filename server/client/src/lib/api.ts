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

/**
 * What to say when the server said nothing.
 *
 * `body.error ?? res.statusText` reads like a fallback and is not one. A
 * failure that never reached the app — a restart under load, a proxy timeout,
 * a body refused at the edge — answers with HTML or with nothing, so there is
 * no `body.error` to find; and over HTTP/2, which is what a browser gets from
 * the deployed app, `statusText` is *always* the empty string. The two
 * together rendered a red bar with nothing written in it, which is how
 * importing a large spreadsheet reported itself for a while: press Analyse,
 * get a blank.
 *
 * A status on its own is not much, but it is the difference between "it broke"
 * and "it broke, here is which half of it".
 */
function statusMessage(status: number, statusText: string): string {
  if (statusText) return statusText;
  switch (status) {
    case 0:
      return "The connection to the server dropped before it answered. Check the network and try again.";
    case 413:
      return "The server refused that upload as too large. Split the file, or import it from Google Drive instead.";
    case 429:
      return "Too many requests at once. Wait a moment and try again.";
    case 502:
    case 503:
      return `The server didn't answer (${status}). It may have restarted while it was working — wait a moment and try again.`;
    case 504:
      return "The server took too long to answer (504). Try one tab or a smaller file at a time.";
    default:
      return `The server answered ${status} and gave no reason. If it keeps happening, the server log has it.`;
  }
}

/** The server's sentence when there is one, and something honest when there isn't. */
function failureMessage(body: { error?: unknown; reference?: unknown }, res: Response): string {
  const said = typeof body.error === "string" ? body.error.trim() : "";
  return withReference(said || statusMessage(res.status, res.statusText), body.reference);
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
    const body: { error?: unknown; reference?: unknown } = await res.json().catch(() => ({}));
    // A 401 on /auth/me is just "not logged in yet" — the provider handles it.
    if (res.status === 401 && path !== "/auth/me") onUnauthorized?.();
    throw new ApiError(res.status, failureMessage(body, res));
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
    const detail: { error?: unknown; reference?: unknown } = await res.json().catch(() => ({}));
    throw new ApiError(res.status, failureMessage(detail, res));
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
