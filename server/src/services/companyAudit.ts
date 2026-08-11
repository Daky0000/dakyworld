import dns from "node:dns/promises";
import net from "node:net";

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
  findings: AuditFinding[];
  /** What was examined. Lets the writer distinguish "fine" from "not looked at". */
  checked: string[];
  /** Things that stopped a check running, in plain words. Not failures. */
  notes: string[];
}

// --- Fetching, carefully ---------------------------------------------------

const FETCH_TIMEOUT_MS = 12_000;
/** Enough of the page to read head and footer; not enough to be a memory problem. */
const MAX_BYTES = 600_000;

/**
 * These URLs come from scraped data, which means an attacker who can get a row
 * into a scrape can choose what this server fetches. Refusing anything that
 * isn't a public http(s) host closes the obvious door.
 */
async function isPubliclyRoutable(hostname: string): Promise<boolean> {
  const literal = net.isIP(hostname) ? hostname : null;
  let addresses: string[];
  if (literal) {
    addresses = [literal];
  } else {
    try {
      const looked = await dns.lookup(hostname, { all: true });
      addresses = looked.map((entry) => entry.address);
    } catch {
      return false;
    }
  }
  if (addresses.length === 0) return false;

  return addresses.every((address) => {
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
  });
}

interface Fetched {
  finalUrl: string;
  status: number;
  headers: Headers;
  html: string;
  responseMs: number;
}

async function fetchPage(url: string): Promise<Fetched | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!(await isPubliclyRoutable(parsed.hostname))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(parsed, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Identifying the crawler is the polite thing and costs nothing.
        "User-Agent": "DakyworldOS-SiteCheck/1.0 (+https://dakyworld.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const responseMs = Date.now() - startedAt;

    // Read at most MAX_BYTES rather than trusting Content-Length.
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

    return { finalUrl: response.url || parsed.toString(), status: response.status, headers: response.headers, html, responseMs };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    const page = await fetchPage(subject.website);
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
      add({
        id: "site-unreachable",
        area: "WEBSITE",
        severity: "CRITICAL",
        observed: `Their website did not load at all. A customer who looks them up finds a dead address on the business's own name.`,
        evidence: `${subject.website} did not respond within ${FETCH_TIMEOUT_MS / 1000} seconds.`,
        service: "website-build",
      });
      notes.push("The site did not load, so nothing else about it could be checked — it may be down temporarily rather than gone.");
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
