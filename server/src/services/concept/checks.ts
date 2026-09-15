/**
 * What must be true about a concept page before anybody is told it exists.
 *
 * The page is served from Dakyworld's own domain, carries somebody else's
 * business name, and the whole pitch is "look what we made you". A page with
 * their phone number wrong on it, or with lorem ipsum two screens down, is
 * worse than no page: it is evidence against us, produced by us, at a link we
 * sent them.
 *
 * So this runs over the finished HTML and answers one question per check, each
 * against something observable in the markup. It is deliberately **not** a
 * model: a model asked "is this page good" will say yes, and what is being
 * checked here — is their own phone number on it, does every anchor land
 * somewhere — is arithmetic.
 *
 * What it cannot check is what a person still has to: whether the services
 * listed are the services they actually offer, whether anything on the page
 * claims something we cannot support, and whether it looks right on a phone.
 * Those are `REVIEWER_CHECKS` below, and they are why a passing run leaves the
 * lead at NEEDS_REVIEW rather than PREVIEW_CHECKED.
 */

export interface PreviewCheck {
  id: string;
  label: string;
  ok: boolean;
  /** What was found, when it was not what was wanted. */
  detail: string | null;
}

export interface PreviewChecks {
  passed: boolean;
  ranAt: string;
  checks: PreviewCheck[];
}

export interface PreviewExpectations {
  businessName: string;
  /** Contact details supplied by the record. Absent ones are not checked for. */
  phone?: string | null;
  email?: string | null;
}

/**
 * What a person has to look at, because no amount of reading the markup
 * answers it. Shown as a checklist in the review queue.
 */
export const REVIEWER_CHECKS = [
  { id: "services-real", label: "The services named on the page are services they actually offer." },
  { id: "no-unsupported-claims", label: "Nothing on the page claims anything we cannot support — no invented awards, years, clients or reviews." },
  { id: "looks-right-desktop", label: "It looks right on a laptop." },
  { id: "looks-right-mobile", label: "It looks right on a phone." },
] as const;

export type ReviewerCheckId = (typeof REVIEWER_CHECKS)[number]["id"];

/** Text with tags, comments, scripts and styles removed — what a visitor reads. */
function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Phone numbers are written a dozen ways; compare the digits. */
function digits(value: string): string {
  return value.replace(/\D+/g, "");
}

const PLACEHOLDERS = [
  "lorem ipsum",
  "dolor sit amet",
  "your text here",
  "your headline here",
  "todo:",
  "tbd",
  "xxx-xxx",
  "123-456-7890",
  "example.com",
  "[business name]",
  "[phone]",
  "[address]",
  "[service]",
];

function check(id: string, label: string, ok: boolean, detail: string | null = null): PreviewCheck {
  return { id, label, ok, detail: ok ? null : detail };
}

export function runPreviewChecks(html: string, expect: PreviewExpectations): PreviewChecks {
  const text = visibleText(html);
  const lower = normalise(text);
  const checks: PreviewCheck[] = [];

  // 1. Their name, as they spell it.
  checks.push(
    check(
      "business-name",
      "The business name appears on the page",
      lower.includes(normalise(expect.businessName)),
      `"${expect.businessName}" does not appear in the page's visible text.`,
    ),
  );

  // 2. The contact details we were given — not ones the model reached for.
  if (expect.phone?.trim()) {
    const wanted = digits(expect.phone);
    const found = wanted.length > 0 && digits(html).includes(wanted);
    checks.push(check("phone", "Their phone number is on the page and matches the record", found, `${expect.phone} does not appear.`));
  }
  if (expect.email?.trim()) {
    const wanted = normalise(expect.email);
    checks.push(check("email", "Their email address is on the page and matches the record", normalise(html).includes(wanted), `${expect.email} does not appear.`));
  }

  // 3. A contact route of some kind. A concept page whose whole argument is
  //    "you are hard to get hold of" has to be easy to get hold of.
  const hasContactRoute = /href\s*=\s*["'](tel:|mailto:|https?:\/\/wa\.me\/)/i.test(html) || /\bcontact\b/i.test(text);
  checks.push(check("contact-route", "There is a way to get in touch", hasContactRoute, "No tel:, mailto: or contact section found."));

  // 4. Every in-page anchor lands somewhere.
  const ids = new Set(Array.from(html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi), (m) => m[1]));
  const names = new Set(Array.from(html.matchAll(/<a\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi), (m) => m[1]));
  const dangling: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']#([^"']+)["']/gi)) {
    const target = match[1];
    if (!ids.has(target) && !names.has(target)) dangling.push(`#${target}`);
  }
  checks.push(check("anchors", "Every in-page link lands on a section that exists", dangling.length === 0, `Nothing to scroll to for: ${dangling.join(", ")}.`));

  // 5. Nothing that goes off to somebody else's site. The page is meant to be
  //    a closed room: every link out of it is a link we did not check.
  const offsite = Array.from(html.matchAll(/<a\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/gi), (m) => m[1]).filter(
    (href) => !/^https?:\/\/(www\.)?dakyworld\.com/i.test(href) && !/^https?:\/\/(wa\.me|maps\.google\.com|www\.google\.com\/maps)/i.test(href),
  );
  checks.push(check("no-offsite-links", "No links off to anywhere we did not put there", offsite.length === 0, `Links out to: ${offsite.slice(0, 5).join(", ")}.`));

  // 6. Placeholders. The model is told to mark what it could not fill; this is
  //    the check that the mark never reaches the prospect.
  const found = PLACEHOLDERS.filter((needle) => lower.includes(needle));
  checks.push(check("no-placeholders", "No placeholder text left on the page", found.length === 0, `Found: ${found.join(", ")}.`));

  // 7. It says what it is. Injected in code rather than asked of the model, so
  //    this failing means the injection failed, which is worth knowing loudly.
  checks.push(
    check(
      "concept-label",
      "The page says it is a concept and not their website",
      html.includes('id="dw-demo-bar"') && /not their website/i.test(html),
      "The concept banner is missing from the page.",
    ),
  );

  // 8. Out of the search index. The response header is the real enforcement;
  //    this is the copy that survives the page being saved or forwarded.
  checks.push(
    check(
      "noindex",
      "The page asks search engines to leave it alone",
      /<meta\b[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["'][^"']*noindex/i.test(html),
      "No robots noindex meta tag in the page.",
    ),
  );

  // 9. Forms. A concept page must not be able to take a visitor's details:
  //    nobody is reading that inbox, and a form that silently swallows an
  //    enquiry costs the business a customer we were trying to win.
  const forms = Array.from(html.matchAll(/<form\b[\s\S]*?<\/form>/gi), (m) => m[0]);
  const live = forms.filter((form) => {
    const fields = Array.from(form.matchAll(/<(input|textarea|select|button)\b[^>]*>/gi), (m) => m[0]);
    return fields.some((field) => !/\bdisabled\b/i.test(field) && !/type\s*=\s*["']hidden["']/i.test(field));
  });
  checks.push(check("forms-inert", "No form on the page can take a visitor's details", live.length === 0, `${live.length} form${live.length === 1 ? "" : "s"} still have enabled fields.`));

  return { passed: checks.every((entry) => entry.ok), ranAt: new Date().toISOString(), checks };
}

/** The failed checks as one line, for a stage reason. */
export function failureSummary(result: PreviewChecks): string {
  const failed = result.checks.filter((entry) => !entry.ok);
  if (!failed.length) return "";
  return failed.map((entry) => `${entry.label}: ${entry.detail ?? "failed"}`).join(" ");
}
