import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";

/**
 * What is actually wrong with a company's setup, observed rather than assumed.
 *
 * This exists because of the difference between two sentences:
 *
 *   "A modern website helps businesses like yours build trust."
 *   "adjeidental.com is served over plain HTTP, so Chrome shows every visitor
 *    'Not secure' before they see your name, and your domain has no DMARC
 *    record, so anyone can send an invoice that appears to come from you."
 *
 * The first is a brochure. The second is a reason to reply, and the only
 * difference is that someone looked. This looks: it fetches the homepage,
 * reads the headers and the markup, and asks DNS what their email is doing.
 *
 * Three rules hold it honest:
 *
 *  - **Every finding is checkable.** Each one carries the evidence it came
 *    from — a URL, a header, a DNS record — so the Owner can verify it before
 *    it goes into a proposal, and so a prospect who checks finds it true.
 *  - **Absence of a finding is not absence of a problem.** `checked` records
 *    what was looked at, so the writer can tell "their backups are fine" from
 *    "nobody looked at their backups". It must never claim the former.
 *  - **Nothing here throws.** A site that is down, a domain that does not
 *    resolve, a timeout — these are findings or notes, never failures. A
 *    proposal must still be draftable for a company with no web presence at
 *    all, which is the most promising case Dakyworld has.
 */

export type AuditArea = "WEBSITE" | "EMAIL" | "SECURITY" | "PRESENCE" | "BRAND" | "OPERATIONS";

/** GOOD findings matter: a proposal that only criticises reads as a sales pitch. */
export type AuditSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "GOOD";

export interface AuditFinding {
  id: string;
  area: AuditArea;
  severity: AuditSeverity;
  /** Literally what was observed, in terms the business owner would recognise. */
  observed: string;
  /** Where it was observed, so it can be verified: a URL, a header, a DNS record. */
  evidence: string;
  /** The `ServiceLine.id` that addresses it, when one does. */
  service: string | null;
}

export interface CompanyAudit {
  ranAt: string;
  /** Null when there was no website to look at — itself the strongest finding. */
  site: {
    requested: string;
    finalUrl: string | null;
    reachable: boolean;
    status: number | null;
    /** Milliseconds to first byte. Slow is a finding; very slow is a problem. */
    responseMs: number | null;
    https: boolean;
    platform: string | null;
    server: string | null;
  } | null;
  domain: {
    name: string;
    hasMx: boolean;
    mailProvider: string | null;
    hasSpf: boolean;
    hasDmarc: boolean;
  } | null;
  /**
   * What the homepage publishes about the business itself.
   *
   * The page was fetched anyway to check it, and a business's own homepage is
   * the best source there is for the things a scrape leaves blank — an address
   * they printed themselves beats one a search inferred. Everything here was
   * read off their own markup, which is why `leadPrep` is willing to write it
   * onto the record.
   */
  published: {
    emails: string[];
    phones: string[];
    /** `{ facebook: url }`, from links on their homepage. */
    socials: Record<string, string>;
  } | null;
  findings: AuditFinding[];
  /** What was examined. Lets the writer distinguish "fine" from "not looked at". */
  checked: string[];
  /** Things that stopped a check running, in plain words. Not failures. */
  notes: string[];
}

// --- Fetching, carefully ---------------------------------------------------

const FETCH_TIMEOUT_MS = 12_000;
/** Hops followed by hand when going past a certificate warning. A browser stops too. */
const MAX_REDIRECTS = 5;
/** Enough of the page to read head and footer; not enough to be a memory problem. */
const MAX_BYTES = 600_000;

/**
 * These URLs come from scraped data, which means an attacker who can get a row
 * into a scrape can choose what this server fetches. Refusing anything that
 * isn't a public http(s) host closes the obvious door.
 */
function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a >= 224) return false;
    return true;
  }
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return false;
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return false;
  return true;
}

interface Fetched {
  finalUrl: string;
  status: number;
  headers: Headers;
  html: string;
  responseMs: number;
}

/**
 * What certificate the site actually presented, read off the connection.
 *
 * Set only when the chain failed to verify and the page was retrieved by going
 * past the warning anyway. It is the difference between "we could not open it"
 * and "it is served under a certificate that expired on 3 March — and here is
 * the rest of the review".
 */
export interface CertificateState {
  /** Node's own reason: CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, … */
  reason: string;
  /** Who it was issued to and by, as a browser would show them. */
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** Whole days since it expired. Null when expiry is not what is wrong. */
  expiredDaysAgo: number | null;
  /** Valid, but not for this hostname. */
  hostMismatch: boolean;
  /** Nobody countersigned it. */
  selfSigned: boolean;
  /** One sentence a business owner can act on. */
  summary: string;
}

/**
 * Why a fetch failed, which is not the same question as whether their site
 * works.
 *
 * This distinction exists because of a real email that went out saying "your
 * website did not load at all" about a site that loads in a browser in just
 * over a second. The address on file was the apex, `ghacem.com`, which has no
 * DNS record; `www.ghacem.com` answers 200. One `catch { return null }` turned
 * "we asked the wrong hostname" into a CRITICAL finding, and the drafter —
 * correctly, because it may only use the facts it is given — put it in a
 * letter to the company as a statement of fact.
 *
 * The rule that comes out of it is the one `probeDns` below already follows
 * for DNS records, applied where it was missing: **an absent answer and a
 * failed question are different things.** Only a failure that genuinely tells
 * us something about their site becomes a finding. Everything else becomes a
 * note, and a note never reaches an email as a claim.
 */
type FetchFailure =
  /** DNS says there is no such host. This one really is about their domain. */
  | "no-such-host"
  /** Something answered and refused, or the connection dropped. */
  | "refused"
  /** TLS would not negotiate — often a chain a browser repairs and Node does not. */
  | "tls"
  | "timeout"
  /** A 403/429 aimed at us, which says nothing about what a visitor would see. */
  | "blocked"
  | "not-public"
  | "unknown";

interface FetchAttempt {
  url: string;
  ok: boolean;
  status: number | null;
  failure: FetchFailure | null;
  detail: string;
}

/** A browser's own UA, for the second attempt at a host that refused ours. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CRAWLER_UA = "DakyworldOS-SiteCheck/1.0 (+https://dakyworld.com)";

/** Node's error codes, grouped by what they actually tell us. */
function classify(err: unknown): { failure: FetchFailure; detail: string } {
  const error = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (error?.name === "AbortError") return { failure: "timeout", detail: `no response within ${FETCH_TIMEOUT_MS / 1000} seconds` };

  const code = error?.cause?.code ?? "";
  const detail = code || error?.cause?.message || error?.message || "unknown error";

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { failure: "no-such-host", detail: code };
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return { failure: "refused", detail: code };
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return { failure: "timeout", detail: code };
  }
  if (/CERT|SSL|TLS|DEPTH_ZERO|SELF_SIGNED|ERR_TLS/i.test(code)) return { failure: "tls", detail: code };
  return { failure: "unknown", detail };
}

async function attempt(url: string, userAgent: string): Promise<{ page: Fetched | null; attempt: FetchAttempt }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { page: null, attempt: { url, ok: false, status: null, failure: "unknown", detail: "not a URL" } };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { page: null, attempt: { url, ok: false, status: null, failure: "unknown", detail: "not http" } };
  }

  const routable = await routability(parsed.hostname);
  if (routable !== "public") {
    return {
      page: null,
      attempt: { url, ok: false, status: null, failure: routable === "no-such-host" ? "no-such-host" : "not-public", detail: routable },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(parsed, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" },
    });
    const responseMs = Date.now() - startedAt;

    const reader = response.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (received >= MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }

    const page = { finalUrl: response.url || parsed.toString(), status: response.status, headers: response.headers, html, responseMs };
    // A 403 or a 429 is a door shut in our face, not a broken website. It is
    // returned as a failure so the caller can retry as a browser, and it never
    // becomes a claim about their site.
    const blocked = response.status === 403 || response.status === 429;
    return {
      page: blocked ? null : page,
      attempt: {
        url,
        ok: !blocked,
        status: response.status,
        failure: blocked ? "blocked" : null,
        detail: blocked ? `HTTP ${response.status}` : "",
      },
    };
  } catch (err) {
    const { failure, detail } = classify(err);
    return { page: null, attempt: { url, ok: false, status: null, failure, detail } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the page the way a person does after clicking **Advanced → Continue**.
 *
 * An expired certificate stops `fetch` dead, and until now that ended the whole
 * review: no look at the page, no speed, no words, no search — a report whose
 * entire content was "we could not open it", about a site every visitor *can*
 * open by clicking through the same warning. That is the wrong answer twice
 * over. The certificate is a real and serious fault and it is **one finding**;
 * everything behind it is still there to be reviewed, and the business needs to
 * hear about both.
 *
 * So a TLS failure gets one more attempt with verification switched off. Four
 * things are true about that attempt, and they are what make it defensible
 * rather than reckless:
 *
 *  - **It is scoped to this one request.** `node:https` with
 *    `rejectUnauthorized: false` on this call only — never
 *    `NODE_TLS_REJECT_UNAUTHORIZED`, which would disable verification for every
 *    outbound call the process makes, including the ones carrying API keys.
 *  - **Nothing of ours is sent.** A GET for a public homepage, with no
 *    credential, no cookie, no token. The risk of an unverified connection is
 *    that somebody could tamper with what comes back; the risk of sending
 *    something to an impostor does not arise, because nothing is sent.
 *  - **It is never silent.** The page is marked as having been read over an
 *    unverified connection, and that travels with it into the report.
 *  - **The certificate is read rather than ignored.** The socket knows exactly
 *    what it was shown, so the finding can say *expired on this date, issued by
 *    this authority* instead of "there was a problem".
 *
 * Redirects are followed by hand because `https.request` does not, and **every
 * hop is re-checked against `routability`** — a redirect is an address somebody
 * else chose, and a loop written to follow them is the easiest place in a
 * codebase to lose an SSRF guard.
 */
async function attemptPastCertificate(
  url: string,
  userAgent: string,
): Promise<{ page: Fetched | null; certificate: CertificateState | null; attempt: FetchAttempt }> {
  const startedAt = Date.now();
  let certificate: CertificateState | null = null;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { page: null, certificate, attempt: { url, ok: false, status: null, failure: "unknown", detail: "not a URL" } };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { page: null, certificate, attempt: { url, ok: false, status: null, failure: "unknown", detail: "not http" } };
    }

    const routable = await routability(parsed.hostname);
    if (routable !== "public") {
      return {
        page: null,
        certificate,
        attempt: {
          url: current,
          ok: false,
          status: null,
          failure: routable === "no-such-host" ? "no-such-host" : "not-public",
          detail: routable,
        },
      };
    }

    let hopResult: InsecureHop;
    try {
      hopResult = await oneUnverifiedHop(parsed, userAgent);
    } catch (err) {
      const { failure, detail } = classify(err);
      return { page: null, certificate, attempt: { url: current, ok: false, status: null, failure, detail } };
    }

    // The first certificate seen is the one the visitor is warned about.
    certificate = certificate ?? hopResult.certificate;

    if (hopResult.status >= 300 && hopResult.status < 400 && hopResult.location) {
      current = new URL(hopResult.location, parsed).toString();
      continue;
    }

    if (hopResult.status === 403 || hopResult.status === 429) {
      return {
        page: null,
        certificate,
        attempt: { url: current, ok: false, status: hopResult.status, failure: "blocked", detail: `HTTP ${hopResult.status}` },
      };
    }

    return {
      page: {
        finalUrl: current,
        status: hopResult.status,
        headers: hopResult.headers,
        html: hopResult.html,
        responseMs: Date.now() - startedAt,
      },
      certificate,
      attempt: { url: current, ok: true, status: hopResult.status, failure: null, detail: "past the certificate warning" },
    };
  }

  return {
    page: null,
    certificate,
    attempt: { url, ok: false, status: null, failure: "unknown", detail: `more than ${MAX_REDIRECTS} redirects` },
  };
}

interface InsecureHop {
  status: number;
  location: string | null;
  headers: Headers;
  html: string;
  certificate: CertificateState | null;
}

/** One request with verification off, and whatever certificate it was shown. */
function oneUnverifiedHop(parsed: URL, userAgent: string): Promise<InsecureHop> {
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(
      parsed,
      {
        method: "GET",
        // The whole point of this function, and deliberately the only place in
        // the codebase where this is set.
        rejectUnauthorized: false,
        headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" },
        timeout: FETCH_TIMEOUT_MS,
      },
      (response) => {
        const socket = response.socket as TLSSocket;
        const certificate =
          parsed.protocol === "https:" && typeof socket?.getPeerCertificate === "function"
            ? readCertificate(socket, parsed.hostname)
            : null;

        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value == null) continue;
          try {
            headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
          } catch {
            /* a header name Headers refuses is one no reviewer needs */
          }
        }

        let html = "";
        let received = 0;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            location: typeof response.headers.location === "string" ? response.headers.location : null,
            headers,
            html,
            certificate,
          });
        };

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          received += Buffer.byteLength(chunk);
          if (received <= MAX_BYTES) html += chunk;
          else response.destroy();
        });
        response.on("end", done);
        // Destroyed by the size cap above: what arrived is what was wanted.
        response.on("close", done);
        response.on("error", (err) => (settled ? undefined : reject(err)));
      },
    );
    request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { name: "AbortError" })));
    request.on("error", reject);
    request.end();
  });
}

/** Turns the socket's certificate into the sentence a business owner needs. */
function readCertificate(socket: TLSSocket, hostname: string): CertificateState | null {
  const peer = socket.getPeerCertificate();
  if (!peer || Object.keys(peer).length === 0) return null;

  const reason = socket.authorizationError ? String(socket.authorizationError) : "UNKNOWN";
  const parsedTo = peer.valid_to ? new Date(peer.valid_to) : null;
  const parsedFrom = peer.valid_from ? new Date(peer.valid_from) : null;
  const validTo = parsedTo && !Number.isNaN(parsedTo.getTime()) ? parsedTo : null;
  const validFrom = parsedFrom && !Number.isNaN(parsedFrom.getTime()) ? parsedFrom : null;
  const expiredDaysAgo = validTo && validTo.getTime() < Date.now() ? Math.floor((Date.now() - validTo.getTime()) / 86_400_000) : null;

  // A certificate may carry several common names; the first is the one a
  // browser puts in the padlock.
  const one = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  const subject = one(peer.subject?.CN);
  const issuer = one(peer.issuer?.CN) ?? one(peer.issuer?.O);
  const selfSigned = /SELF_SIGNED/i.test(reason) || (Boolean(subject) && subject === issuer);
  const hostMismatch = /ALTNAME|HOSTNAME/i.test(reason);

  const summary =
    expiredDaysAgo != null
      ? `The certificate expired ${expiredDaysAgo === 0 ? "today" : `${expiredDaysAgo} day${expiredDaysAgo === 1 ? "" : "s"} ago`}, on ${validTo!.toISOString().slice(0, 10)}.`
      : hostMismatch
        ? `The certificate is valid but was not issued for ${hostname}.`
        : selfSigned
          ? "The certificate signs itself — no authority any browser trusts issued it."
          : `The certificate could not be verified (${reason}).`;

  return {
    reason,
    subject,
    issuer,
    validFrom: validFrom ? validFrom.toISOString() : null,
    validTo: validTo ? validTo.toISOString() : null,
    expiredDaysAgo,
    hostMismatch,
    selfSigned,
    summary,
  };
}

/** `public`, or the reason it is not worth fetching. */
async function routability(hostname: string): Promise<"public" | "no-such-host" | "private"> {
  const literal = net.isIP(hostname) ? hostname : null;
  let addresses: string[];
  if (literal) {
    addresses = [literal];
  } else {
    try {
      const looked = await dns.lookup(hostname, { all: true });
      addresses = looked.map((entry) => entry.address);
    } catch {
      // The resolver said no such name — which is a real fact about their
      // domain, and the one fetch failure that is safe to report as one.
      return "no-such-host";
    }
  }
  if (addresses.length === 0) return "no-such-host";
  return addresses.every(isPublicAddress) ? "public" : "private";
}

export interface SiteFetch {
  /** Null when nothing could be retrieved. */
  page: Fetched | null;
  /** The URL that actually answered, which may not be the one on file. */
  usedUrl: string | null;
  /** Every URL tried, in order, with what each did. */
  attempts: FetchAttempt[];
  /**
   * True only when DNS says none of the hostnames exist. This is the single
   * case where "their site is not there" is a claim the evidence supports.
   */
  domainDoesNotResolve: boolean;
  /** True when we could not tell — a timeout, a TLS error, a WAF, a refusal. */
  inconclusive: boolean;
  /**
   * Set when the page could only be read by going past a certificate warning.
   *
   * Two things depend on it and both matter: the security section turns it into
   * a finding with real dates, and every other section is marked as having been
   * read over a connection nothing verified.
   */
  certificate: CertificateState | null;
  /**
   * The other spelling of their host — www against bare, or the reverse — and
   * whether DNS knows it.
   *
   * Checked even when the first address worked, because which form a scrape
   * recorded is an accident: a business whose bare name has no record is
   * losing everybody who types it, and that stays true whether or not the
   * record we happen to hold is the working one.
   */
  otherHost: { url: string; resolves: boolean } | null;
}

/**
 * Fetches their homepage, trying the obvious alternatives before concluding
 * anything.
 *
 * The www/apex pair is not a nicety: plenty of small-business domains have a
 * record for one and not the other, and which one a scrape recorded is an
 * accident. Asking only the one on file and declaring the business offline on
 * the strength of it is how a false statement reaches a stranger's inbox.
 */
export async function fetchSite(requested: string): Promise<SiteFetch> {
  const attempts: FetchAttempt[] = [];
  const candidates: string[] = [];

  const add = (value: string) => {
    if (!candidates.includes(value)) candidates.push(value);
  };
  add(requested);
  try {
    const parsed = new URL(requested);
    const swapped = new URL(requested);
    swapped.hostname = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : `www.${parsed.hostname}`;
    add(swapped.toString());
  } catch {
    /* a URL we cannot parse is handled by `attempt` */
  }

  for (const candidate of candidates) {
    const first = await attempt(candidate, CRAWLER_UA);
    attempts.push(first.attempt);
    if (first.page) return finish(first.page, candidate, attempts, candidates);

    // Blocked on our own user agent: ask again the way a browser would before
    // saying anything about their site.
    if (first.attempt.failure === "blocked") {
      const retry = await attempt(candidate, BROWSER_UA);
      attempts.push({ ...retry.attempt, detail: `${retry.attempt.detail} (retried as a browser)` });
      if (retry.page) return finish(retry.page, candidate, attempts, candidates);
    }

    // The certificate did not verify. A person facing this screen clicks
    // Advanced and then Continue, and so does this — because everything the
    // review is for is on the other side of it, and the certificate itself
    // becomes the first finding rather than the end of the report.
    if (first.attempt.failure === "tls") {
      const past = await attemptPastCertificate(candidate, BROWSER_UA);
      attempts.push({ ...past.attempt, detail: `${past.attempt.detail || first.attempt.detail} (retried past the certificate warning)` });
      if (past.page) return finish(past.page, candidate, attempts, candidates, past.certificate);
    }
  }

  const real = attempts.filter((entry) => entry.failure !== "not-public");
  return {
    page: null,
    usedUrl: null,
    attempts,
    // Every hostname we know about is unknown to DNS. That is about them.
    domainDoesNotResolve: real.length > 0 && real.every((entry) => entry.failure === "no-such-host"),
    inconclusive: real.some((entry) => entry.failure !== "no-such-host"),
    certificate: null,
    otherHost: null,
  };
}

async function finish(
  page: Fetched,
  usedUrl: string,
  attempts: FetchAttempt[],
  candidates: string[],
  certificate: CertificateState | null = null,
): Promise<SiteFetch> {
  // One DNS lookup, to answer a question the successful fetch cannot: does the
  // *other* spelling of their address work too. Cheap, and it is the difference
  // between finding this fault only when the broken form happens to be the one
  // on file and finding it every time.
  const other = candidates.find((candidate) => candidate !== usedUrl) ?? null;
  let otherHost: SiteFetch["otherHost"] = null;
  if (other) {
    try {
      const hostname = new URL(other).hostname;
      otherHost = { url: other, resolves: (await routability(hostname)) !== "no-such-host" };
    } catch {
      otherHost = null;
    }
  }

  return { page, usedUrl, attempts, domainDoesNotResolve: false, inconclusive: false, certificate, otherHost };
}

// --- Reading the markup ----------------------------------------------------

function head(html: string): string {
  const match = /<head[\s>][\s\S]*?<\/head>/i.exec(html);
  return match ? match[0] : html.slice(0, 40_000);
}

function metaContent(html: string, name: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const reversed = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`,
    "i",
  );
  return pattern.exec(html)?.[1]?.trim() ?? reversed.exec(html)?.[1]?.trim() ?? null;
}

/**
 * The platform a site is built on, which is often the whole argument. A
 * `business.site` or `wixsite.com` address says the owner never bought a real
 * site; an old WordPress says they bought one and nobody has touched it since.
 */
function detectPlatform(html: string, finalUrl: string, headers: Headers): string | null {
  const generator = metaContent(html, "generator");
  const host = (() => {
    try {
      return new URL(finalUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (/business\.site$/.test(host)) return "Google Business Profile page";
  if (/wixsite\.com$/.test(host) || /wix\.com/i.test(generator ?? "")) return "Wix";
  if (/blogspot\.com$/.test(host)) return "Blogger";
  if (/weebly\.com$/.test(host)) return "Weebly";
  if (/godaddysites\.com$/.test(host)) return "GoDaddy Website Builder";
  if (/myshopify\.com$/.test(host) || /shopify/i.test(headers.get("x-shopid") ?? "")) return "Shopify";
  if (/wordpress\.com$/.test(host)) return "WordPress.com";
  if (generator && /wordpress/i.test(generator)) return generator.trim();
  if (/wp-content\/|wp-includes\//i.test(html)) return "WordPress";
  if (/squarespace/i.test(generator ?? "") || /static1\.squarespace\.com/i.test(html)) return "Squarespace";
  if (/webflow/i.test(generator ?? "")) return "Webflow";
  if (generator) return generator.trim();
  return null;
}

/** `https://www.ghacem.com/en` becomes `www.ghacem.com`, for a sentence a person reads. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The most recent four-digit year in a copyright line, which dates the site. */
function copyrightYear(html: string): number | null {
  const tail = html.slice(-20_000);
  const years: number[] = [];
  const pattern = /(?:©|&copy;|copyright)[^<]{0,40}?((?:19|20)\d{2})/gi;
  for (const match of tail.matchAll(pattern)) years.push(Number(match[1]));
  return years.length ? Math.max(...years) : null;
}

const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|live|aol|icloud|ymail)\./i;

// --- Asking DNS, and knowing when it didn't answer -------------------------

/**
 * "No DMARC record" and "the DNS query failed" are the same empty array, and
 * telling a prospect their domain is unprotected when in fact nobody checked
 * is precisely the kind of claim that loses a deal on the first call. So a
 * failed lookup is distinguished from a genuine absence by its error code, and
 * only a genuine absence becomes a finding.
 */
type DnsProbe<T> = { answered: true; value: T } | { answered: false; missing: boolean; code: string };

async function probeDns<T>(query: () => Promise<T>): Promise<DnsProbe<T>> {
  try {
    return { answered: true, value: await query() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    // The resolver answered, and the answer was "there is no such record".
    const missing = code === "ENODATA" || code === "ENOTFOUND";
    return { answered: false, missing, code };
  }
}

// --- The audit ------------------------------------------------------------

export interface AuditSubject {
  companyName: string | null;
  website: string | null;
  contactEmail: string | null;
  /** From the scrape: how visible they already are. */
  rating: number | null;
  reviewsCount: number | null;
  socialLinks: Record<string, string> | null;
  category: string | null;
  city: string | null;
}

export async function auditCompany(subject: AuditSubject): Promise<CompanyAudit> {
  const findings: AuditFinding[] = [];
  const checked: string[] = [];
  const notes: string[] = [];
  const add = (finding: AuditFinding) => findings.push(finding);

  const audit: CompanyAudit = {
    ranAt: new Date().toISOString(),
    site: null,
    domain: null,
    published: null,
    findings,
    checked,
    notes,
  };

  // --- No website at all ---------------------------------------------------
  checked.push("Whether they have a website");
  if (!subject.website) {
    add({
      id: "no-website",
      area: "PRESENCE",
      severity: "CRITICAL",
      observed:
        "They have no website. Everything a customer can find about them is a listing someone else owns and can change.",
      evidence: "No website on their Google listing or anywhere the scrape looked.",
      service: "website-build",
    });

    // Reviews without a website is the sharpest version of this argument:
    // demand already exists and has nowhere to land.
    if (subject.reviewsCount && subject.reviewsCount >= 10) {
      add({
        id: "demand-without-destination",
        area: "PRESENCE",
        severity: "HIGH",
        observed: `${subject.reviewsCount} people have reviewed them${subject.rating ? ` at ${subject.rating} stars` : ""}, and there is nowhere to send any of them.`,
        evidence: "Google listing review count, with no website field set.",
        service: "website-build",
      });
    }
    if (subject.socialLinks && Object.keys(subject.socialLinks).length > 0) {
      add({
        id: "rented-presence",
        area: "PRESENCE",
        severity: "MEDIUM",
        observed: `Their entire online presence is ${Object.keys(subject.socialLinks).join(" and ")} — accounts they do not own and cannot recover if one is lost.`,
        evidence: Object.values(subject.socialLinks).join(", "),
        service: "website-build",
      });
    }
  }

  // --- The site itself -----------------------------------------------------
  if (subject.website) {
    const fetched = await fetchSite(subject.website);
    const page = fetched.page;
    checked.push("Their website: whether it loads, over what, and what it is built on");

    if (!page) {
      audit.site = {
        requested: subject.website,
        finalUrl: null,
        reachable: false,
        status: null,
        responseMs: null,
        https: subject.website.startsWith("https://"),
        platform: null,
        server: null,
      };

      const tried = fetched.attempts.map((entry) => `${entry.url} (${entry.failure ?? "no answer"}${entry.detail ? `: ${entry.detail}` : ""})`).join("; ");

      if (fetched.domainDoesNotResolve) {
        // The only version of this that is a fact about them: DNS has no
        // record for any hostname we know of. Worded as what was actually
        // established — the address does not resolve — rather than as the
        // larger claim that they have no working site, which is not the same
        // thing and is not what was tested.
        add({
          id: "site-unreachable",
          area: "WEBSITE",
          severity: "CRITICAL",
          observed: `The web address on their record does not exist as far as the internet is concerned — there is no DNS record for it. Anyone typing it, or following it from a listing, lands on nothing.`,
          evidence: `No DNS record for ${tried}.`,
          service: "website-build",
        });
        notes.push("Nothing else about the site could be checked, because there was no host to ask.");
      } else {
        // Everything else is a failed question, not an answer. It stays out of
        // the findings entirely, so it can never reach a letter as a claim —
        // this is the exact failure that put "your website did not load" in
        // front of a company whose website loads in a second.
        notes.push(
          `Their website could not be checked from here, and nothing may be claimed about it either way — it may well be working perfectly. Tried: ${tried}. Somebody should open ${subject.website} by hand before any of this is used.`,
        );
      }
    } else {
      const finalUrl = page.finalUrl;
      const https = finalUrl.startsWith("https://");
      const platform = detectPlatform(page.html, finalUrl, page.headers);
      audit.site = {
        requested: subject.website,
        finalUrl,
        reachable: true,
        status: page.status,
        responseMs: page.responseMs,
        https,
        platform,
        server: page.headers.get("server"),
      };

      // Only one spelling of their address works. A real finding in its own
      // right — a domain with a record for www and none for the bare name
      // loses everybody who types it short — and it is found whichever of the
      // two happens to be the one on the record, because which one a scrape
      // caught is an accident.
      checked.push("Whether both the short and the www form of their address work");
      const dead = fetched.otherHost && !fetched.otherHost.resolves ? fetched.otherHost.url : null;
      if (dead && fetched.usedUrl) {
        add({
          id: "one-host-only",
          area: "WEBSITE",
          severity: "MEDIUM",
          observed: `Their site answers at ${hostOf(fetched.usedUrl)} but not at ${hostOf(dead)} — the second has no DNS record at all. Anyone who types the address that way, or follows it from a listing that stored it that way, gets nothing.`,
          evidence: `${dead} does not resolve; ${fetched.usedUrl} answered ${page.status}.`,
          service: "website-rescue",
        });
      }

      if (page.status >= 400) {
        add({
          id: "site-error",
          area: "WEBSITE",
          severity: "CRITICAL",
          observed: `Their website answers with an error (HTTP ${page.status}) rather than a page.`,
          evidence: `${finalUrl} returned ${page.status}.`,
          service: "website-build",
        });
      }

      // HTTPS — the one every visitor sees, in the address bar, before anything else.
      checked.push("Whether the site is served securely (HTTPS)");
      if (!https) {
        add({
          id: "no-https",
          area: "SECURITY",
          severity: "CRITICAL",
          observed:
            "The site is served over plain HTTP, so Chrome and Safari label it “Not secure” in the address bar. That warning is the first thing a visitor reads about them.",
          evidence: `${finalUrl} — no TLS, and http:// does not redirect to https://.`,
          service: "website-rescue",
        });
      } else if (fetched.certificate) {
        // Encrypted and untrusted at once. Worse for a visitor than plain http,
        // which at least loads: this is a full red page they have to dismiss
        // before the business appears, and it names the business while doing
        // it. It has to be a finding here and not only in the audit team's
        // report, because this is the list a cold email argues from — without
        // it the letter would open on something trivial while the site was
        // unreachable to every ordinary visitor.
        const cert = fetched.certificate;
        add({
          id: "cert-untrusted",
          area: "SECURITY",
          severity: "CRITICAL",
          observed: `${cert.summary} Anyone opening the site gets a full-page browser warning — “Your connection is not private” — instead of the business. Reaching the site at all means clicking Advanced and choosing to continue anyway, which almost nobody does.`,
          evidence: `${finalUrl} — ${cert.reason}${cert.validTo ? `, valid until ${cert.validTo.slice(0, 10)}` : ""}${cert.issuer ? `, issued by ${cert.issuer}` : ""}.`,
          service: "website-rescue",
        });
      } else {
        add({
          id: "https-ok",
          area: "SECURITY",
          severity: "GOOD",
          observed: "The site is served over HTTPS, so visitors do not see a browser security warning.",
          evidence: finalUrl,
          service: null,
        });
      }

      // Mobile. In Ghana this is not a refinement, it is the majority case.
      checked.push("Whether the site works on a phone");
      const viewport = metaContent(page.html, "viewport");
      if (!viewport) {
        add({
          id: "not-mobile",
          area: "WEBSITE",
          severity: "CRITICAL",
          observed:
            "The site has no mobile viewport set, which means it renders as a shrunk-down desktop page on a phone — pinch-to-zoom to read anything. Most of their visitors are on a phone.",
          evidence: `No <meta name="viewport"> in the page head of ${finalUrl}.`,
          service: "website-build",
        });
      }

      // Platform — often the strongest single line in the proposal.
      checked.push("What the site is built on");
      if (platform) {
        const builder = /wix|weebly|godaddy|blogger|business profile|wordpress\.com/i.test(platform);
        const wordpressVersion = /wordpress\s*([\d.]+)/i.exec(platform)?.[1];
        if (builder) {
          add({
            id: "page-builder",
            area: "BRAND",
            severity: "HIGH",
            observed: `The site is a ${platform} page. It is rented, not owned: the address, the templates and the data live on someone else's account, and it looks like what it is to anyone comparing suppliers.`,
            evidence: `Detected from ${finalUrl}.`,
            service: "website-build",
          });
        } else if (wordpressVersion) {
          const major = Number(wordpressVersion.split(".")[0]);
          if (major > 0 && major < 6) {
            add({
              id: "outdated-cms",
              area: "SECURITY",
              severity: "CRITICAL",
              observed: `The site runs WordPress ${wordpressVersion}, which is several years behind. Every published vulnerability since then applies to it, and the version is advertised in the page source for anyone scanning.`,
              evidence: `<meta name="generator"> on ${finalUrl} reads "${platform}".`,
              service: "website-rescue",
            });
          } else {
            add({
              id: "cms-version-exposed",
              area: "SECURITY",
              severity: "LOW",
              observed: `The site publishes the exact version of WordPress it runs (${wordpressVersion}), which tells an attacker which exploits to try first.`,
              evidence: `<meta name="generator"> on ${finalUrl}.`,
              service: "website-rescue",
            });
          }
        }
      }

      // Age. A footer frozen in 2019 says more than any argument about design.
      checked.push("When the site was last touched");
      const year = copyrightYear(page.html);
      const thisYear = new Date().getFullYear();
      if (year && thisYear - year >= 2) {
        add({
          id: "stale-site",
          area: "WEBSITE",
          severity: "MEDIUM",
          observed: `The footer still reads ${year}. To anyone checking whether they are still trading, the site looks abandoned — and it is ${thisYear - year} years of prices, staff and services out of date.`,
          evidence: `Copyright line on ${finalUrl}.`,
          service: "website-build",
        });
      }

      // Speed.
      checked.push("How quickly the site responds");
      if (page.responseMs > 3000) {
        add({
          id: "slow-site",
          area: "WEBSITE",
          severity: "MEDIUM",
          observed: `The homepage took ${(page.responseMs / 1000).toFixed(1)} seconds to start responding. On a Ghanaian mobile connection that is the point where visitors leave.`,
          evidence: `Measured on ${finalUrl}.`,
          service: "website-rescue",
        });
      }

      // Can a visitor actually make contact?
      checked.push("Whether a visitor can contact them from the site");
      const hasForm = /<form[\s>]/i.test(page.html);
      const hasMailto = /mailto:/i.test(page.html);
      const hasTel = /tel:\+?\d/i.test(page.html);
      const hasWhatsapp = /wa\.me\/|api\.whatsapp\.com/i.test(page.html);
      audit.published = readPublishedContacts(page.html, finalUrl);
      if (!hasForm && !hasMailto && !hasTel && !hasWhatsapp) {
        add({
          id: "no-contact-route",
          area: "WEBSITE",
          severity: "HIGH",
          observed:
            "There is no way to contact them from the homepage — no form, no clickable phone number, no email link, no WhatsApp. Every visitor who wants to buy has to go and find another way.",
          evidence: `Homepage markup of ${finalUrl}.`,
          service: "website-build",
        });
      } else if (!hasForm && !hasMailto) {
        add({
          id: "no-written-contact",
          area: "WEBSITE",
          severity: "LOW",
          observed:
            "The site offers no way to send a written enquiry — only a phone number. Enquiries that arrive outside working hours are lost rather than queued.",
          evidence: `Homepage markup of ${finalUrl}.`,
          service: "website-build",
        });
      }

      // A free address printed on their own website is the clearest possible
      // opening for the workspace conversation.
      const inPageFreeMail = FREE_MAIL.exec(page.html)?.[0];
      if (inPageFreeMail) {
        add({
          id: "free-mail-on-site",
          area: "EMAIL",
          severity: "HIGH",
          observed: `The contact address printed on their own website is a free ${inPageFreeMail.replace("@", "").split(".")[0]} account, not an address on their domain. On a quote or an invoice that reads as a one-man operation, whatever the business actually is.`,
          evidence: `Found on ${finalUrl}.`,
          service: "email-workspace",
        });
      }

      // How the business looks when a link to it is shared.
      checked.push("How the site looks when shared on WhatsApp or LinkedIn");
      const ogTitle = metaContent(page.html, "og:title");
      const ogImage = metaContent(page.html, "og:image");
      if (!ogTitle || !ogImage) {
        add({
          id: "no-link-preview",
          area: "BRAND",
          severity: "LOW",
          observed:
            "When someone shares their link on WhatsApp or LinkedIn it appears as a bare URL with no title or image, because the preview tags are missing. Most of their referrals travel exactly that way.",
          evidence: `No ${!ogTitle ? "og:title" : ""}${!ogTitle && !ogImage ? " or " : ""}${!ogImage ? "og:image" : ""} on ${finalUrl}.`,
          service: "branding",
        });
      }

      // Are they measuring anything at all?
      checked.push("Whether visits to the site are measured");
      if (!/gtag\(|googletagmanager|google-analytics|fbq\(|plausible|matomo|clarity\.ms/i.test(page.html)) {
        add({
          id: "no-analytics",
          area: "OPERATIONS",
          severity: "LOW",
          observed:
            "Nothing measures the site, so there is no way to know how many people visit, what they look for, or whether anything spent on marketing works.",
          evidence: `No analytics script on ${finalUrl}.`,
          service: "automation",
        });
      }
    }
  }

  // --- Their email, which is where the security argument really lives -------
  const domain = mailDomain(subject);
  if (domain) {
    const [mxProbe, txtProbe, dmarcProbe] = await Promise.all([
      probeDns(() => dns.resolveMx(domain)),
      probeDns(() => dns.resolveTxt(domain)),
      probeDns(() => dns.resolveTxt(`_dmarc.${domain}`)),
    ]);

    // If the resolver itself is unreachable, every answer below is meaningless.
    // Say nothing rather than say something false.
    const resolverWorking = mxProbe.answered || mxProbe.missing || txtProbe.answered || txtProbe.missing;

    if (!resolverWorking) {
      notes.push(
        `Their email set-up could not be checked — the DNS lookup for ${domain} did not complete (${"code" in mxProbe ? mxProbe.code : "no answer"}). Nothing is known about their mail records either way.`,
      );
    } else {
      checked.push("Their email set-up: whether the domain sends mail, and whether it is protected");

      const flat = (records: string[][]) => records.map((parts) => parts.join(""));
      const mx = mxProbe.answered ? mxProbe.value : [];
      const spf = txtProbe.answered ? (flat(txtProbe.value).find((record) => /^v=spf1/i.test(record)) ?? null) : null;
      const dmarcRecord = dmarcProbe.answered
        ? (flat(dmarcProbe.value).find((record) => /^v=DMARC1/i.test(record)) ?? null)
        : null;

      audit.domain = {
        name: domain,
        hasMx: mx.length > 0,
        mailProvider: mailProvider(mx.map((record) => record.exchange)),
        hasSpf: Boolean(spf),
        hasDmarc: Boolean(dmarcRecord),
      };

      // Absent means the resolver said so — either an empty answer or NODATA.
      const noMailRecords = (mxProbe.answered && mx.length === 0) || (!mxProbe.answered && mxProbe.missing);
      if (noMailRecords) {
        add({
          id: "no-business-email",
          area: "EMAIL",
          severity: "HIGH",
          observed: `The domain ${domain} receives no email at all — it has no mail records. Whatever address they give customers, it is not on their own name.`,
          evidence: `No MX records for ${domain}.`,
          service: "email-workspace",
        });
      } else if (mx.length > 0) {
        // SPF and DMARC only mean anything for a domain that sends mail.
        if (!spf && txtProbe.answered) {
          add({
            id: "no-spf",
            area: "SECURITY",
            severity: "HIGH",
            observed: `${domain} has no SPF record, so no receiving mail server can tell a genuine email from them apart from a forged one. Their own mail is also more likely to land in spam.`,
            evidence: `No v=spf1 TXT record on ${domain}.`,
            service: "security-backups",
          });
        }
        if (!dmarcRecord && (dmarcProbe.answered || dmarcProbe.missing)) {
          add({
            id: "no-dmarc",
            area: "SECURITY",
            severity: "CRITICAL",
            observed: `${domain} has no DMARC record. Anyone in the world can send email that appears to come from their domain — to their customers, with their bank details on it — and nothing stops it or tells them it happened.`,
            evidence: `No TXT record at _dmarc.${domain}.`,
            service: "security-backups",
          });
        }
        if (spf && dmarcRecord) {
          add({
            id: "mail-authenticated",
            area: "SECURITY",
            severity: "GOOD",
            observed:
              "Their domain has both SPF and DMARC set up, so their email is authenticated and harder to forge. That is already better than most businesses their size.",
            evidence: `SPF and DMARC records present on ${domain}.`,
            service: null,
          });
        }
      }
    }
  }

  // A free address as the business's contact address, from the lead record.
  if (subject.contactEmail && FREE_MAIL.test(subject.contactEmail)) {
    add({
      id: "free-mail-contact",
      area: "EMAIL",
      severity: "HIGH",
      observed: `The business contact address on file is ${subject.contactEmail} — a free personal account. It cannot be handed over when staff change, it cannot be searched or backed up as a company record, and it undercuts every quote it is attached to.`,
      evidence: "Contact address held on the lead record.",
      service: "email-workspace",
    });
  }

  // --- Standing in the market, from the scrape ------------------------------
  if (subject.reviewsCount != null || subject.rating != null) {
    checked.push("Their Google listing: rating and review count");
    if (subject.rating != null && subject.rating >= 4.3 && (subject.reviewsCount ?? 0) >= 20) {
      add({
        id: "strong-reputation",
        area: "PRESENCE",
        severity: "GOOD",
        observed: `${subject.rating} stars from ${subject.reviewsCount} reviews. The reputation is already there — the gap is between how good they are and how good they look online.`,
        evidence: "Google listing.",
        service: null,
      });
    }
    if (subject.rating != null && subject.rating < 3.5 && (subject.reviewsCount ?? 0) >= 10) {
      add({
        id: "weak-reputation",
        area: "PRESENCE",
        severity: "MEDIUM",
        observed: `Their public rating is ${subject.rating} from ${subject.reviewsCount} reviews, which is the first thing anyone searching their name sees.`,
        evidence: "Google listing.",
        service: "branding",
      });
    }
  }

  return audit;
}

/** The domain their email would live on — from their address if there is one, else their site. */
function mailDomain(subject: AuditSubject): string | null {
  const fromEmail = subject.contactEmail?.split("@")[1]?.trim().toLowerCase();
  if (fromEmail && !FREE_MAIL.test(`@${fromEmail}`)) return fromEmail;
  if (!subject.website) return null;
  try {
    return new URL(subject.website).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function mailProvider(exchanges: string[]): string | null {
  const joined = exchanges.join(" ").toLowerCase();
  if (!joined) return null;
  if (/google|googlemail/.test(joined)) return "Google Workspace";
  if (/outlook|microsoft|office365/.test(joined)) return "Microsoft 365";
  if (/zoho/.test(joined)) return "Zoho";
  if (/hostinger|titan/.test(joined)) return "Hostinger / Titan";
  if (/cpanel|namecheap|privateemail/.test(joined)) return "Shared hosting mail";
  return exchanges[0] ?? null;
}

// --- What the page says about the business --------------------------------

/**
 * The contact details and profiles a business publishes on its own homepage.
 *
 * This is the strongest source in the whole pipeline for the fields a scrape
 * leaves blank. An address a search engine associated with a company is a
 * guess; an address on their own homepage is one they put there. That
 * difference is why `leadPrep` writes these onto the record and holds the
 * researched ones back for a person.
 *
 * Everything is read from markup rather than rendered text, so it finds the
 * `mailto:` behind a "contact us" button as readily as an address printed in
 * the footer.
 */
export function readPublishedContacts(html: string, finalUrl: string): CompanyAudit["published"] {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const socials: Record<string, string> = {};

  for (const match of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    const address = decodeURIComponent(match[1]).trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address)) emails.add(address);
  }
  // Addresses printed as text rather than linked, which is the common case on
  // a page somebody's cousin built.
  for (const match of html.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    const address = match[0].toLowerCase();
    // Tracking pixels, Sentry DSNs and image sprites all look like addresses.
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(address)) continue;
    if (/(sentry|wixpress|example|domain)\./i.test(address)) continue;
    emails.add(address);
  }

  for (const match of html.matchAll(/tel:([+0-9()\-.\s]{7,25})/gi)) {
    const number = match[1].replace(/[^\d+]/g, "");
    if (number.replace(/\D/g, "").length >= 7) phones.add(number);
  }
  for (const match of html.matchAll(/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d{7,15})/gi)) {
    phones.add(`+${match[1]}`);
  }

  const networks: [string, RegExp][] = [
    ["facebook", /https?:\/\/(?:www\.|web\.|m\.)?facebook\.com\/[^"'\s<>]+/gi],
    ["instagram", /https?:\/\/(?:www\.)?instagram\.com\/[^"'\s<>]+/gi],
    ["linkedin", /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[^"'\s<>]+/gi],
    ["x", /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^"'\s<>]+/gi],
    ["tiktok", /https?:\/\/(?:www\.)?tiktok\.com\/@[^"'\s<>]+/gi],
    ["youtube", /https?:\/\/(?:www\.)?youtube\.com\/[^"'\s<>]+/gi],
  ];
  for (const [network, pattern] of networks) {
    // Every match, not the first: a share button points at the *sharer* rather
    // than at the business's own profile, and it is almost always higher up
    // the page than the profile link in the footer. Taking the first match and
    // rejecting it loses the real one.
    for (const match of html.matchAll(pattern)) {
      const url = match[0].replace(/[)\]]+$/, "");
      if (/sharer|share[?/]|intent\/|\/plugins\/|\/tr\?/i.test(url)) continue;
      socials[network] = url;
      break;
    }
  }

  const site = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  })();

  return {
    // Their own domain first: on a page carrying both, that is the one to use.
    emails: [...emails].sort((a, b) => Number(b.endsWith(`@${site}`)) - Number(a.endsWith(`@${site}`))).slice(0, 5),
    phones: [...phones].slice(0, 5),
    socials,
  };
}

// --- What the audit says about a lead, rather than about a letter ----------

/**
 * The findings that are worth being able to filter a list by.
 *
 * Deliberately not every finding: a lead carrying ten tags is a lead nobody
 * can scan, and most findings are an argument for one email rather than a
 * property of the business. These are the ones the Owner would actually build
 * a list from — "show me every business in Kumasi with no website", "everyone
 * still on plain HTTP".
 */
const TAGGABLE: Record<string, string> = {
  "no-website": "No website",
  "site-unreachable": "Site down",
  "one-host-only": "Only one host resolves",
  "site-error": "Site down",
  "no-https": "Not secure",
  // Worth a list of its own: it is the most urgent thing on this map, and the
  // easiest sale in it — the fix is free and takes an afternoon.
  "cert-untrusted": "Certificate warning",
  "not-mobile": "Not mobile",
  "outdated-cms": "Outdated CMS",
  "page-builder": "Page builder site",
  "stale-site": "Stale site",
  "slow-site": "Slow site",
  "no-contact-route": "No contact route",
  "free-mail-on-site": "Free email",
  "free-mail-contact": "Free email",
  "no-business-email": "No business email",
  "no-dmarc": "No DMARC",
  "strong-reputation": "Strong reputation",
  "weak-reputation": "Weak reputation",
  "demand-without-destination": "Demand, no website",
  "rented-presence": "Social only",
};

/** Platform is worth a tag of its own — it is how a rebuild list gets built. */
function platformTag(platform: string | null): string | null {
  if (!platform) return null;
  const known = ["WordPress", "Wix", "Squarespace", "Shopify", "Weebly", "Webflow", "Blogger", "GoDaddy"];
  const hit = known.find((name) => new RegExp(name, "i").test(platform));
  if (hit) return hit;
  return /business profile/i.test(platform) ? "Google page only" : null;
}

export function auditTags(audit: CompanyAudit): string[] {
  const tags = new Set<string>();
  for (const finding of audit.findings) {
    const tag = TAGGABLE[finding.id];
    if (tag) tags.add(tag);
  }
  const platform = platformTag(audit.site?.platform ?? null);
  if (platform) tags.add(platform);
  return [...tags];
}

/**
 * The one finding an email should open on.
 *
 * Left to itself a drafter opens on whatever reads most neatly, which is how a
 * letter ends up leading with missing link-preview tags while the site it is
 * about has been served over plain HTTP since 2019. Severity decides, and
 * within a severity the first one wins — `auditCompany` adds them in the order
 * a person would notice them.
 */
export function headlineFinding(audit: CompanyAudit): AuditFinding | null {
  const real = audit.findings.filter((finding) => finding.severity !== "GOOD");
  return sortFindings(real)[0] ?? null;
}

// --- For the prompt --------------------------------------------------------

const SEVERITY_ORDER: AuditSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "GOOD"];

export function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** The audit as the writer reads it. Evidence included, because it must cite it. */
export function auditForPrompt(audit: CompanyAudit): string {
  if (audit.findings.length === 0) {
    return "The automated check found nothing specific. Say so honestly rather than inventing problems — this proposal should lean on the discovery call instead.";
  }

  const findings = sortFindings(audit.findings).map(
    (finding) =>
      `- [${finding.severity}] [${finding.area}] ${finding.observed}\n  Evidence: ${finding.evidence}\n  Addressed by: ${finding.service ?? "nothing — this one is a strength, not a sale"}`,
  );

  const parts = [
    "What was actually observed about this company just now, by fetching their site and querying DNS:",
    "",
    findings.join("\n"),
    "",
    `Checks that were run: ${audit.checked.join("; ")}.`,
  ];
  if (audit.notes.length) parts.push(`Caveats: ${audit.notes.join(" ")}`);
  parts.push(
    "",
    "Anything not in the list above was NOT checked. You may not claim their backups, their hosting bill, their staff or their internal systems are in any particular state — you have no idea, and a confident wrong claim loses the deal on the first call.",
  );
  return parts.join("\n");
}
