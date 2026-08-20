import { SETTING, getSetting } from "./settings.js";

/**
 * Numbers.
 *
 * A phone number is the worst-behaved field in this database. The same handset
 * arrives as `024 123 4567`, `+233 24 123 4567`, `233241234567`, `24-123-4567`
 * and — from a spreadsheet whose cell format ate the leading zero — `241234567`.
 * Google Maps writes it one way, a contact-page scrape another, a person typing
 * it into the composer a third.
 *
 * Every one of those has to collapse to one string before anything else works,
 * because the number *is* the identity here: it is what a thread is keyed on,
 * what an opt-out is recorded against, and what a delivery receipt quotes back.
 * Two spellings of one number means two threads, and an opt-out on one of them
 * that does not stop the other.
 *
 * **The failure mode is silence, not an error.** A malformed number is accepted
 * by both providers and the message goes to nobody — or, if the digits happen
 * to land on a real handset, to a stranger under Dakyworld's name. That is why
 * this refuses rather than guesses, and why `toE164` returns null instead of
 * its best effort.
 *
 * This supersedes `normaliseGhanaNumber` in lib/hubtel.ts, which is Ghana-only
 * and returns null for every international number. That is correct for Hubtel,
 * whose gateway is domestic; it is wrong for WhatsApp, which is global and is
 * how a diaspora-owned Ghanaian business is most often reached.
 */

/** Digits only, no `+`. What both providers want and what the database stores. */
export type E164 = string;

/**
 * Countries this is confident about, keyed by calling code.
 *
 * Deliberately a short table rather than libphonenumber. The full library is
 * 150kB of metadata to answer a question that, for this business, has one
 * answer nine times out of ten — and the tenth is a number already written in
 * international form, which needs no table at all. `mobile` is the set of
 * prefixes *after* the country code that belong to a handset; a WhatsApp to a
 * landline is a wasted conversation fee, and an SMS to one is money burnt.
 */
const COUNTRIES: Record<string, { iso: string; name: string; nsnLength: number[]; mobile: RegExp; trunk: string }> = {
  // Ghana. MTN 024/054/055/059, Telecel 020/050, AirtelTigo 026/027/056/057,
  // Glo 023/053 — so with the trunk zero dropped, every mobile prefix is 2x or
  // 5x and every 3x is a landline (030 is Accra). That is the whole rule.
  "233": { iso: "GH", name: "Ghana", nsnLength: [9], mobile: /^[25]/, trunk: "0" },
  "234": { iso: "NG", name: "Nigeria", nsnLength: [10], mobile: /^([789])/, trunk: "0" },
  "254": { iso: "KE", name: "Kenya", nsnLength: [9], mobile: /^(1|7)/, trunk: "0" },
  "27": { iso: "ZA", name: "South Africa", nsnLength: [9], mobile: /^(6|7|8)/, trunk: "0" },
  "44": { iso: "GB", name: "United Kingdom", nsnLength: [10], mobile: /^7/, trunk: "0" },
  "1": { iso: "US", name: "United States / Canada", nsnLength: [10], mobile: /^[2-9]/, trunk: "1" },
};

/** The calling codes above, longest first — `233` must beat `23` at matching. */
const CALLING_CODES = Object.keys(COUNTRIES).sort((a, b) => b.length - a.length);

const DEFAULT_CALLING_CODE = "233";

/**
 * The country a bare local number is assumed to belong to.
 *
 * Configurable because the assumption is the whole risk: read `0241234567` as
 * Ghanaian and it is right; read it as British and the message goes to a
 * different continent. Ghana is the default because that is where the leads,
 * the SMS gateway and the company are.
 */
export async function defaultCallingCode(): Promise<string> {
  const configured = (await getSetting(SETTING.PHONE_COUNTRY_CODE))?.replace(/\D/g, "");
  return configured && COUNTRIES[configured] ? configured : DEFAULT_CALLING_CODE;
}

export interface ParsedNumber {
  /** Digits only, no `+`. The canonical form; this is what gets stored. */
  e164: E164;
  /** ISO country, when the calling code is one this knows. */
  country: string | null;
  /** The part after the calling code. */
  national: string;
  /** True when the prefix belongs to a handset rather than a landline. */
  mobile: boolean;
  /** `+233 24 123 4567` — for reading, never for sending. */
  display: string;
}

/**
 * Turns whatever somebody wrote into one canonical number, or null.
 *
 * The order of the checks matters and is not arbitrary:
 *
 *  1. **A leading `+` is believed.** Somebody who wrote the international form
 *     has told us the country and is not to be second-guessed.
 *  2. **A leading trunk `0` means local.** `0241234567` is a Ghanaian number
 *     written the way Ghanaians write it: drop the zero, prepend the code.
 *  3. **An exact calling-code match is believed** — `233241234567` is already
 *     in the form we want.
 *  4. **A bare national-length number gets the default code.** This is the
 *     spreadsheet case, where the cell format ate the leading zero.
 *
 * Anything else is refused. In particular a number of unrecognised length is
 * refused rather than padded or truncated, because both of those produce a
 * number that belongs to somebody.
 */
export function toE164(raw: string | null | undefined, callingCode = DEFAULT_CALLING_CODE): ParsedNumber | null {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  // A "number" carrying letters is a sender id, a note, or a scrape that
  // picked up the wrong element ("Call us today"). None of them are dialable.
  if (/[a-z]{3,}/i.test(trimmed.replace(/^(tel|phone|mobile|whatsapp|call)[:\s]*/i, ""))) return null;

  const explicitlyInternational = /^\+/.test(trimmed) || /^00\d/.test(trimmed);
  let digits = trimmed.replace(/\D/g, "");
  if (/^00\d/.test(trimmed)) digits = digits.slice(2);
  if (!digits) return null;

  // An extension makes the number longer than any country's plan allows and is
  // not dialable from a gateway anyway. Refuse rather than truncate.
  if (digits.length > 15) return null;

  const home = COUNTRIES[callingCode] ?? COUNTRIES[DEFAULT_CALLING_CODE];

  if (!explicitlyInternational && home && digits.startsWith(home.trunk) && home.trunk !== "") {
    const national = digits.slice(home.trunk.length);
    if (home.nsnLength.includes(national.length)) return build(callingCode, national);
  }

  for (const code of CALLING_CODES) {
    if (!digits.startsWith(code)) continue;
    const national = digits.slice(code.length);
    if (COUNTRIES[code].nsnLength.includes(national.length)) return build(code, national);
  }

  // A bare national number with the default country's length. Only when it was
  // not written as international — `+241234567` is a malformed international
  // number, not a Ghanaian one missing its zero.
  if (!explicitlyInternational && home && home.nsnLength.includes(digits.length)) {
    return build(callingCode, digits);
  }

  // An unknown calling code, but a plausible international length. Believed
  // only when the `+` said so — this is how a number in a country not in the
  // table above still reaches WhatsApp.
  if (explicitlyInternational && digits.length >= 8) {
    return { e164: digits, country: null, national: digits, mobile: true, display: `+${digits}` };
  }

  return null;
}

function build(callingCode: string, national: string): ParsedNumber {
  const country = COUNTRIES[callingCode];
  return {
    e164: `${callingCode}${national}`,
    country: country?.iso ?? null,
    national,
    mobile: country ? country.mobile.test(national) : true,
    display: format(callingCode, national),
  };
}

function format(callingCode: string, national: string): string {
  // Ghanaian and most African numbers read as 2-3-4; a 10-digit NANP number as
  // 3-3-4. Nothing depends on this being perfect — it is for eyes only.
  const groups = national.length === 10 ? [3, 3, 4] : national.length === 9 ? [2, 3, 4] : [national.length];
  const parts: string[] = [];
  let index = 0;
  for (const size of groups) {
    parts.push(national.slice(index, index + size));
    index += size;
  }
  return `+${callingCode} ${parts.filter(Boolean).join(" ")}`;
}

/** The same parse, with the configured default country. Async because the default is a setting. */
export async function parsePhone(raw: string | null | undefined): Promise<ParsedNumber | null> {
  return toE164(raw, await defaultCallingCode());
}

/** `+233 24 123 4567` from a stored `233241234567`. Falls back to the digits. */
export function displayPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const parsed = toE164(`+${String(e164).replace(/\D/g, "")}`);
  return parsed?.display ?? `+${e164}`;
}

/**
 * A click-to-chat link.
 *
 * The unglamorous half of this module and, until a template is approved, the
 * only half that can legally carry a cold approach. `wa.me` opens WhatsApp on
 * the sender's own phone or desktop with the message already typed; a person
 * reads it and presses send. No Business API, no template review, no
 * per-conversation fee, and — the part that matters — the message arrives from
 * a human being's number, which is what a stranger is willing to reply to.
 */
export function waLink(e164: string, text?: string | null): string {
  const number = String(e164).replace(/\D/g, "");
  return text ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : `https://wa.me/${number}`;
}

// --- What a text actually costs --------------------------------------------

/**
 * The GSM 03.38 default alphabet. Anything outside it forces the whole message
 * into UCS-2, which more than halves how much fits in one segment.
 */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** These cost two characters each in GSM-7 — they are sent as an escape pair. */
const GSM7_EXTENDED = "^{}\\[~]|€";

export interface SmsCost {
  encoding: "GSM-7" | "UCS-2";
  /** Billable length, counting escaped characters twice. */
  characters: number;
  segments: number;
  /** The character that forced UCS-2, when one did. Worth naming: it is nearly always an emoji or a curly quote. */
  forcedBy: string | null;
}

/**
 * What one text will be billed as.
 *
 * Worth doing in code rather than trusting to a character counter, because the
 * cliff is invisible: 160 GSM-7 characters is one message, 161 is two, and a
 * single emoji — or a curly apostrophe pasted in from a word processor —
 * re-encodes the whole thing as UCS-2 and drops the limit to 70. A 155-character
 * text with one “smart quote” in it costs three times what the same text costs
 * with a straight one.
 */
export function smsCost(text: string): SmsCost {
  let characters = 0;
  let forcedBy: string | null = null;

  for (const character of [...text]) {
    if (GSM7.includes(character)) {
      characters += 1;
    } else if (GSM7_EXTENDED.includes(character)) {
      characters += 2;
    } else {
      forcedBy = forcedBy ?? character;
      characters += 1;
    }
  }

  if (forcedBy) {
    // UCS-2 counts UTF-16 code units, so an emoji outside the basic plane is
    // two. `[...text]` iterates code points, hence the separate measure here.
    const units = text.length;
    return { encoding: "UCS-2", characters: units, segments: units <= 70 ? 1 : Math.ceil(units / 67), forcedBy };
  }

  return { encoding: "GSM-7", characters, segments: characters <= 160 ? 1 : Math.ceil(characters / 153), forcedBy: null };
}

/**
 * Replaces the characters that force UCS-2 with GSM-7 equivalents that read
 * the same. Curly quotes, en-dashes and non-breaking spaces come in from every
 * word processor and every model, and none of them are worth tripling the
 * price of a text over. Offered, never applied silently — the composer shows
 * both the cost and this button.
 */
export function toGsm7(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[\u00a0\u2007\u202f\u2009\u200a]/g, " ")
    .replace(/•/g, "-")
    .replace(/[‹›]/g, "'")
    .replace(/[«»]/g, '"');
}
