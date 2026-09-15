/**
 * How long a vendor asked us to wait, when it says.
 *
 * `Retry-After` is either a number of seconds or an HTTP date, and honouring it
 * matters more than any backoff we invent: it is the only number that knows
 * when the window actually resets.
 *
 * This lived inside the model ladder until the Slack delivery queue needed the
 * same answer. Two copies of a parser for a header with two formats is one
 * copy too many — the second would be the one that forgets the date form and
 * silently retries a rate-limited Slack immediately.
 */
export function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
