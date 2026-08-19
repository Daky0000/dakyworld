import type { CompanyAudit } from "../companyAudit.js";
import type { AuditEvidence } from "./evidence.js";
import { DISCIPLINE_AGENTS, scoreFindings, sortBySeverity, type AuditFindingDetail, type DisciplineReport } from "./types.js";

/**
 * The security review, and the one reviewer on the team with no model in it.
 *
 * That is deliberate and it is the most important decision in this module. A
 * language model asked to review a stranger's website for security will find
 * something, because that is what it was asked to do — and what it finds will
 * be a plausible-sounding vulnerability that may not exist. This report goes
 * out under Dakyworld's name, about somebody else's business, and gets
 * forwarded to whoever built their site. A fabricated security finding in it
 * is not an embarrassment, it is a false accusation.
 *
 * So every finding here is a fact read off a header, a tag, a cookie or a DNS
 * record that `evidence.ts` and `companyAudit.ts` already fetched. If the check
 * did not run, there is no finding — there is a note saying nobody looked.
 *
 * The other half of the rule: **this is a review of what is visible from
 * outside, and it says so.** Nothing here probes, scans ports, tries a login or
 * touches anything. "We could not see X from the outside" is never written as
 * "X is missing" — see the `checked` list, which is what makes "nothing found"
 * mean something.
 */

export function reviewSecurity(evidence: AuditEvidence, audit: CompanyAudit | null): DisciplineReport {
  const findings: AuditFindingDetail[] = [];
  const checked: string[] = [];
  const notes: string[] = [];
  const add = (finding: Omit<AuditFindingDetail, "discipline" | "region" | "marker">) =>
    findings.push({ ...finding, discipline: "SECURITY", region: null, marker: null });

  const security = evidence.security;

  if (!security) {
    notes.push(
      evidence.fetch.domainDoesNotResolve
        ? "There is no site at that address, so nothing about the site itself could be checked. The mail domain was still examined."
        : "Their site could not be retrieved, so its certificate, headers and cookies were not examined. Only the mail domain was.",
    );
  } else {
    // --- The certificate, and whether it is actually used -------------------
    checked.push("Whether the site is served over HTTPS");
    if (!security.https) {
      add({
        id: "sec-no-https",
        severity: "CRITICAL",
        title: "The site has no certificate",
        observed: `${evidence.finalUrl} is served over plain HTTP. Every current browser marks it "Not secure" in the address bar, beside the business name.`,
        evidence: `Final URL after redirects: ${evidence.finalUrl}`,
        impact:
          "A visitor sees a warning before they see the business. Anything typed into a form on the page — a phone number, an enquiry, a card detail — travels in the clear, and Google has ranked unencrypted pages below encrypted ones for years.",
        plainly: "Their website shows a “Not secure” warning in the browser. Most people leave when they see it, and it is a half-day fix.",
        recommendation: "Install a certificate (free through Let's Encrypt on almost all hosting) and redirect every http address to https.",
      });
    } else {
      add({
        id: "sec-https-good",
        severity: "GOOD",
        title: "Served over HTTPS",
        observed: "The site has a working certificate and answers over https.",
        evidence: `Final URL after redirects: ${evidence.finalUrl}`,
        impact: "No browser warning, and the baseline every other check assumes.",
        plainly: "Their site is encrypted, which is the basic thing to get right and they have it.",
        recommendation: null,
      });

      checked.push("Whether the plain http address upgrades to https");
      if (security.redirectsToHttps === false) {
        add({
          id: "sec-no-upgrade",
          severity: "HIGH",
          title: "The unencrypted address still answers",
          observed: `http://${new URL(evidence.finalUrl!).host}/ does not redirect to the secure address — it serves the site as it is.`,
          evidence: `Plain-http request followed redirects and ended on an http address.`,
          impact:
            "Anybody who types the address without the s, or follows an old link, gets the unencrypted site and the browser warning with it. The certificate exists and is doing nothing for those visitors.",
          plainly: "If somebody types their address without “https”, they still land on the unsafe version with the warning on it.",
          recommendation: "Add a permanent redirect from http to https at the server or CDN, then turn on HSTS.",
        });
      } else if (security.redirectsToHttps === null && security.httpNote) {
        notes.push(security.httpNote);
      }
    }

    // --- Mixed content ------------------------------------------------------
    if (security.https) {
      checked.push("Whether an encrypted page loads unencrypted files");
      if (security.mixedContent.length) {
        add({
          id: "sec-mixed-content",
          severity: "HIGH",
          title: "Unencrypted files on an encrypted page",
          observed: `The page loads ${security.mixedContent.length} file${security.mixedContent.length === 1 ? "" : "s"} over plain http, which browsers block or downgrade.`,
          evidence: security.mixedContent.slice(0, 4).join(", "),
          impact:
            "Whatever those files are — an image, a script, a stylesheet — a modern browser refuses to load them on a secure page. The visitor sees a broken layout or a missing picture, and the padlock is compromised.",
          plainly: "Parts of the page are loaded insecurely, so browsers block them and the page comes out broken for some visitors.",
          recommendation: "Change every http:// reference in the markup to https:// (or a relative path).",
        });
      }
    }

    // --- The headers --------------------------------------------------------
    checked.push("The security headers the site sends");
    const headers = security.headers;

    if (security.https && !headers.strictTransportSecurity) {
      add({
        id: "sec-no-hsts",
        severity: "LOW",
        title: "No HSTS header",
        observed: "The site does not send Strict-Transport-Security, so a browser will try the unencrypted address first on a return visit.",
        evidence: "No `Strict-Transport-Security` response header on the homepage.",
        impact: "A small but real window in which a return visitor's first request goes out unencrypted.",
        plainly: "Browsers are not being told to always use the secure version — a one-line setting on the server.",
        recommendation: "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` once http reliably redirects.",
      });
    }

    const framingProtected = Boolean(headers.xFrameOptions) || /frame-ancestors/i.test(headers.contentSecurityPolicy ?? "");
    if (!framingProtected) {
      add({
        id: "sec-framing",
        severity: "MEDIUM",
        title: "The page can be embedded in somebody else's site",
        observed: "Neither an X-Frame-Options header nor a CSP frame-ancestors rule is sent, so any site may load this one inside a frame.",
        evidence: "No `X-Frame-Options` header and no `frame-ancestors` in any Content-Security-Policy.",
        impact:
          "Their page can be framed inside someone else's — invisibly, over a different set of buttons. It is how a visitor is tricked into clicking something they cannot see, and it is trivially prevented.",
        plainly: "Anyone can load their website inside their own, which is how visitors get tricked. It is a one-line server setting.",
        recommendation: "Send `X-Frame-Options: SAMEORIGIN`, or a Content-Security-Policy with `frame-ancestors 'self'`.",
      });
    }

    if (!headers.contentSecurityPolicy) {
      add({
        id: "sec-no-csp",
        severity: "LOW",
        title: "No Content-Security-Policy",
        observed: "The site sends no Content-Security-Policy, so the browser will run any script that reaches the page from anywhere.",
        evidence: "No `Content-Security-Policy` response header on the homepage.",
        impact:
          "If anything ever injects a script — a compromised plugin, a hijacked third-party tag — nothing in the browser stops it running against their visitors.",
        plainly: "There is no rule stopping the browser running code from anywhere, which matters if a plugin is ever compromised.",
        recommendation: "Add a Content-Security-Policy, starting in report-only mode so nothing breaks while it is tuned.",
      });
    }

    if (!headers.xContentTypeOptions) {
      add({
        id: "sec-no-nosniff",
        severity: "LOW",
        title: "No nosniff header",
        observed: "X-Content-Type-Options is not sent, so a browser may guess a file's type rather than trusting the server.",
        evidence: "No `X-Content-Type-Options: nosniff` response header.",
        impact: "An uploaded file can be made to run as a script in the visitor's browser. One header, and every hosting platform can send it.",
        plainly: "A missing one-line setting that lets browsers misread an uploaded file as program code.",
        recommendation: "Send `X-Content-Type-Options: nosniff`.",
      });
    }

    // --- What the server tells anyone who asks -----------------------------
    checked.push("What the server discloses about itself");
    const banner = [security.serverBanner, security.poweredBy].filter(Boolean).join("; ");
    const versioned = /\d+\.\d+/.test(banner);
    if (banner && versioned) {
      add({
        id: "sec-version-banner",
        severity: "MEDIUM",
        title: "The server announces its exact version",
        observed: `The server names its own software and version in every response: ${banner}.`,
        evidence: `Response headers: ${banner}`,
        impact:
          "That string is the first thing an automated scanner reads. It turns “try everything” into “try the four things that work on this version”, and there is no benefit to publishing it.",
        plainly: "Their server tells anyone who asks exactly which software version it runs, which is what attack tools look for first.",
        recommendation: "Turn off server tokens (`server_tokens off` in nginx, `ServerTokens Prod` in Apache) and remove `X-Powered-By`.",
      });
    }

    if (security.generator && /\d+\.\d+/.test(security.generator)) {
      add({
        id: "sec-generator-version",
        severity: "MEDIUM",
        title: "The page publishes its CMS version",
        observed: `The homepage carries a generator tag naming the exact version: ${security.generator}.`,
        evidence: `<meta name="generator" content="${security.generator}">`,
        impact:
          "Anybody can read which release they are on, and therefore which published vulnerabilities apply to them. It is in the page source of every page on the site.",
        plainly: "Their website publishes which version of its software it runs, so anyone can look up the known ways in.",
        recommendation: "Remove the generator meta tag, and check the version named is actually current.",
      });
    }

    if (security.exposedAdminLinks.length) {
      add({
        id: "sec-admin-link",
        severity: "LOW",
        title: "The login page is linked from the homepage",
        observed: `The homepage links to ${security.exposedAdminLinks.join(", ")}.`,
        evidence: `Links found in the homepage markup: ${security.exposedAdminLinks.join(", ")}`,
        impact: "It tells an automated login-guessing tool exactly where to point itself. Nothing on a public homepage needs to link to the back office.",
        plainly: "The staff login is linked from the front page, which is an invitation to password-guessing software.",
        recommendation: "Remove the link, and put rate limiting and two-factor on the login itself.",
      });
    }

    // --- Cookies ------------------------------------------------------------
    if (security.cookies.length) {
      checked.push("The cookies the homepage sets, and their flags");
      const loose = security.cookies.filter((cookie) => !cookie.secure || !cookie.httpOnly);
      if (loose.length && security.https) {
        add({
          id: "sec-cookie-flags",
          severity: "MEDIUM",
          title: "Cookies set without their protective flags",
          observed: `${loose.length} of ${security.cookies.length} cookie${security.cookies.length === 1 ? "" : "s"} the homepage sets (${loose.map((cookie) => cookie.name).join(", ")}) lack Secure, HttpOnly or both.`,
          evidence: loose.map((cookie) => `${cookie.name}: secure=${cookie.secure}, httpOnly=${cookie.httpOnly}, sameSite=${cookie.sameSite ?? "unset"}`).join("; "),
          impact:
            "A cookie without Secure can be sent over an unencrypted connection; one without HttpOnly can be read by any script on the page. If either is a session cookie, that is an account takeover.",
          plainly: "Some of the cookies their site sets are not locked down, which is how a logged-in session gets stolen.",
          recommendation: "Set `Secure`, `HttpOnly` and `SameSite=Lax` on every cookie that is not read by their own JavaScript.",
        });
      }
    }

    // --- Forms --------------------------------------------------------------
    if (evidence.page?.forms.length) {
      checked.push("Where the forms on the page send what is typed into them");
      const insecure = evidence.page.forms.filter((form) => !form.secure);
      if (insecure.length) {
        add({
          id: "sec-form-insecure",
          severity: "CRITICAL",
          title: "A form sends what is typed into it unencrypted",
          observed: `${insecure.length} form on the homepage posts to a plain http address.`,
          evidence: insecure.map((form) => `${form.method.toUpperCase()} ${form.action ?? "(the page itself)"}`).join("; "),
          impact:
            "Everything a customer types into that form — name, phone number, message, and anything worse — crosses the network readable by anyone in between. Browsers now warn about it as the visitor types.",
          plainly: "Their contact form sends what customers type across the internet unencrypted, and browsers warn people while they are filling it in.",
          recommendation: "Point the form at an https address on their own domain, and check the handler behind it.",
        });
      }
    }
  }

  // --- The mail domain, from the audit that already asked DNS ---------------
  if (audit?.domain) {
    checked.push("Whether their domain can be used to send email in their name (SPF, DMARC)");
    const domain = audit.domain;
    if (!domain.hasSpf) {
      add({
        id: "sec-no-spf",
        severity: "HIGH",
        title: "Anyone can send email as them",
        observed: `${domain.name} publishes no SPF record, so no receiving mail server has any way to tell a real message from a forged one.`,
        evidence: `DNS TXT lookup for ${domain.name}: no v=spf1 record.`,
        impact:
          "An invoice with changed bank details, sent from their own address to their own customer, arrives and passes every check the customer's mail server makes. This is the single most common way a small business's clients lose money.",
        plainly: "Anyone in the world can send email that looks exactly like it came from their address — including a fake invoice to their customers.",
        recommendation: "Publish an SPF record naming their real mail provider, then DKIM, then a DMARC policy.",
      });
    }
    if (!domain.hasDmarc) {
      add({
        id: "sec-no-dmarc",
        severity: domain.hasSpf ? "MEDIUM" : "HIGH",
        title: "No DMARC policy",
        observed: `${domain.name} publishes no DMARC record, so nobody is told what to do with a message that fails the checks — and nobody reports the attempts.`,
        evidence: `DNS TXT lookup for _dmarc.${domain.name}: no record.`,
        impact: "Forged mail in their name is delivered rather than rejected, and they never find out it happened.",
        plainly: "There is no rule telling mail systems to reject fake email sent in their name, and no report when someone tries.",
        recommendation: "Publish `_dmarc` starting at `p=none` with a reporting address, then tighten to quarantine and reject.",
      });
    }
    if (domain.hasSpf && domain.hasDmarc) {
      add({
        id: "sec-mail-good",
        severity: "GOOD",
        title: "Mail authentication is in place",
        observed: `${domain.name} publishes both SPF and DMARC.`,
        evidence: `DNS TXT records for ${domain.name} and _dmarc.${domain.name}.`,
        impact: "Forged email in their name is far harder to deliver, which is most of the protection available.",
        plainly: "They have already set up the records that stop people faking email from their address.",
        recommendation: null,
      });
    }
  } else {
    // Deliberately not "they have no mail domain". Two very different things
    // land here — nothing to derive a domain from, and a resolver that would
    // not answer — and only the DNS check itself knows which. Asserting the
    // first when the second happened is exactly the failure this codebase
    // learned from the "your website did not load" email: a failed question is
    // not an answer.
    const explained = (audit?.notes ?? []).find((note) => /DNS|mail/i.test(note));
    notes.push(
      explained ??
        "Their mail records were not checked, so nothing here says anything about whether somebody can send email in their name. That is not the same as it being safe.",
    );
  }

  const sorted = sortBySeverity(findings);
  const score = scoreFindings(sorted);

  return {
    discipline: "SECURITY",
    reviewer: DISCIPLINE_AGENTS.SECURITY.name,
    // No model wrote a word of this section, and the document says so rather
    // than leaving the reader to assume one did.
    reviewedBy: "Checked directly, no model",
    score,
    // Every check here is arithmetic on a header, a tag or a DNS record, so
    // this section is scored whenever any of them ran. There is no model to
    // fail.
    scored: checked.length > 0,
    headline: headlineFor(sorted, evidence),
    summary: summaryFor(sorted, checked, evidence),
    findings: sorted,
    checked,
    notes,
    costUsd: 0,
  };
}

function headlineFor(findings: AuditFindingDetail[], evidence: AuditEvidence): string {
  const worst = findings.find((finding) => finding.severity === "CRITICAL") ?? findings.find((finding) => finding.severity === "HIGH");
  if (worst) return worst.title;
  if (!evidence.reachable) return "The site could not be reached, so only the mail domain was checked";
  const problems = findings.filter((finding) => finding.severity !== "GOOD");
  return problems.length ? `${problems.length} thing${problems.length === 1 ? "" : "s"} worth tightening, none of them urgent` : "Nothing found that puts them or their customers at risk";
}

function summaryFor(findings: AuditFindingDetail[], checked: string[], evidence: AuditEvidence): string {
  const counts = {
    critical: findings.filter((finding) => finding.severity === "CRITICAL").length,
    high: findings.filter((finding) => finding.severity === "HIGH").length,
    other: findings.filter((finding) => finding.severity === "MEDIUM" || finding.severity === "LOW").length,
  };

  const scope = `This is what is visible from outside: ${checked.length ? checked.map((entry) => entry.toLowerCase()).join(", ") : "nothing could be checked"}. Nothing was probed, no login was tried, and nothing on their server was touched.`;

  if (!evidence.reachable) {
    return `Their site could not be retrieved, so its certificate, headers and cookies were not examined. ${scope}`;
  }

  if (counts.critical + counts.high === 0 && counts.other === 0) {
    return `Nothing was found that puts them or their customers at risk. ${scope} A clean result here means the checks that could be made passed — not that the site has been penetration tested.`;
  }

  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} serious problem${counts.critical === 1 ? "" : "s"}`);
  if (counts.high) parts.push(`${counts.high} that matter${counts.high === 1 ? "s" : ""}`);
  if (counts.other) parts.push(`${counts.other} smaller one${counts.other === 1 ? "" : "s"}`);

  return `${parts.join(", ")}. ${scope}`;
}
