/**
 * Tells a bot from an enquiry, for the one endpoint on this system an
 * anonymous caller may write to.
 *
 * `/api/webhooks/website-form` is public and unsigned by design — a static
 * GitHub Pages site has nowhere to keep a secret, and routes/webhooks.ts
 * explains why losing real enquiries to that is the worse trade. The rate
 * limiter in front of it caps the volume; this decides which of what gets
 * through becomes a lead.
 *
 * **No CAPTCHA, deliberately.** A CAPTCHA is a third-party key, a script on
 * every page, a cookie that the privacy policy would then have to describe, and
 * a measurable share of real people who give up on the form. A honeypot and a
 * clock cost nothing, are invisible to a human, and stop the overwhelming
 * majority of what actually hits a small business's contact form — which is
 * scripted, not targeted.
 *
 * **Nothing is deleted.** A flagged post is still recorded as a `WebhookEvent`
 * exactly like every other; it just does not become a lead. That matters
 * because the failure mode of a spam filter is the enquiry it eats, and a
 * filter whose mistakes are invisible cannot be corrected.
 */

/**
 * A field no person can see and no person will fill in. Named for what a
 * naive form-filler would take it for.
 *
 * Underscore-prefixed so it cannot collide with the real field names
 * `intakeFormLead` reads — `website` is a genuine field on this form, so a
 * honeypot called `website_url` would be a live grenade.
 */
export const HONEYPOT_FIELD = "_dw_confirm_email";

/** Milliseconds since the form was rendered, stamped by the page. */
export const TIMESTAMP_FIELD = "_dw_started";

/**
 * Under three seconds is a script. The slowest realistic human — landing on
 * the page with the text already in their clipboard — is still several seconds
 * away from a submit, and a form filled in 200ms was not filled in by hand.
 */
const MIN_FILL_MS = 3_000;

/** A form open for over a day is a stale tab, not a fresh enquiry; the stamp tells us nothing useful. */
const MAX_FILL_MS = 24 * 60 * 60 * 1000;

/** More links than this in an enquiry is an advert, not a question. */
const MAX_LINKS = 2;

const LINK_PATTERN = /\bhttps?:\/\/|\bwww\.|\[url[=\]]|<a\s+href/gi;

/** The words that only ever appear in the same piece of scripted spam. */
const SPAM_PHRASES = [
  "seo services",
  "guest post",
  "backlink",
  "buy followers",
  "crypto investment",
  "increase your ranking",
  "first page of google",
  "bitcoin",
  "viagra",
  "casino",
  "loan offer",
  "telegram me",
];

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export interface BotVerdict {
  /** Null when the submission looks like a person. */
  reason: string | null;
}

export function looksAutomated(payload: Record<string, unknown>): BotVerdict {
  // 1. The honeypot. A person never sees this field, so anything in it is a
  //    script filling in every input it found.
  if (text(payload[HONEYPOT_FIELD]).trim()) {
    return { reason: "A hidden field was filled in, which only an automated submission does." };
  }

  // 2. The clock. Absent is fine — a partner posting to this endpoint directly
  //    has no form to stamp one, and refusing them would be a worse mistake
  //    than accepting a fast bot.
  const stamped = Number(payload[TIMESTAMP_FIELD]);
  if (Number.isFinite(stamped) && stamped > 0) {
    const elapsed = Date.now() - stamped;
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) {
      return { reason: `The form was submitted ${Math.round(elapsed)}ms after it loaded, which is faster than a person types.` };
    }
    if (elapsed > MAX_FILL_MS) {
      return { reason: "That form was loaded more than a day before it was submitted." };
    }
  }

  // 3. What is in it. Only the free-text fields — a real enquiry from a web
  //    agency might legitimately mention one URL, and `website` is a field of
  //    its own that is supposed to hold one.
  const body = [payload.message, payload.notes, payload.enquiry, payload.details, payload.comments]
    .map(text)
    .join("\n")
    .slice(0, 5000);

  const links = body.match(LINK_PATTERN)?.length ?? 0;
  if (links > MAX_LINKS) {
    return { reason: `That message carries ${links} links, which is an advert rather than an enquiry.` };
  }

  const lower = body.toLowerCase();
  const phrase = SPAM_PHRASES.find((entry) => lower.includes(entry));
  if (phrase) {
    return { reason: `That message reads as bulk marketing (“${phrase}”).` };
  }

  // 4. Header injection. A newline in a field that ends up in an email header
  //    is somebody trying to add their own Bcc.
  for (const field of ["name", "email", "subject", "company"]) {
    if (/[\r\n]/.test(text(payload[field]))) {
      return { reason: `The ${field} field contained a line break, which is a mail-header injection attempt.` };
    }
  }

  return { reason: null };
}
