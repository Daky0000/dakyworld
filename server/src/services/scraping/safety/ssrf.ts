import ipaddr from "ipaddr.js";

/**
 * SSRF and Network Safety Guardrails.
 *
 * Ensures any URL provided by a user or discovered on the web does not target
 * private subnets, loopback addresses, or cloud metadata endpoints.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
]);

export function isSafeUrl(
  rawUrl: string,
  options: { allowLoopback?: boolean } = {},
): { safe: boolean; reason?: string; url?: URL } {
  const allowLoopback = options.allowLoopback || process.env.DEV_ALLOW_LOOPBACK === "true";

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { safe: false, reason: "Malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Cloud metadata endpoint is ALWAYS blocked, unconditionally
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
    return { safe: false, reason: "Cloud metadata endpoint blocked" };
  }

  if (!allowLoopback && (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal"))) {
    return { safe: false, reason: `Blocked local or internal hostname: ${hostname}` };
  }

  // Check for raw IP address in hostname
  if (ipaddr.isValid(hostname)) {
    try {
      const addr = ipaddr.parse(hostname);
      const range = addr.range();

      if (range === "loopback") {
        if (!allowLoopback) {
          return { safe: false, reason: `Forbidden loopback address: ${hostname}` };
        }
      } else if (
        range === "private" ||
        range === "linkLocal" ||
        range === "uniqueLocal" ||
        range === "carrierGradeNat"
      ) {
        return { safe: false, reason: `Forbidden IP address range: ${range}` };
      }
    } catch {
      return { safe: false, reason: "Invalid IP address syntax" };
    }
  }

  return { safe: true, url: parsed };
}
