import { prisma } from "../lib/prisma.js";
import { COMPANY } from "./dakyworld.js";

/**
 * The company's own details, in one editable place.
 *
 * `dakyworld.ts` holds these as constants because a phone number written in
 * four files is a phone number that will be wrong in three of them. That
 * solved the duplication and left a second problem: changing one still needed
 * a code edit and a deploy, which is not how a business changes its address.
 *
 * So the constants became the **defaults** and this became the value. A
 * profile is read from `AppSetting`, merged over `COMPANY`, and handed to
 * every surface that describes the company — the email letterhead, the PDF
 * letterhead, the Word cut of a proposal, the plain-text footer, the
 * unsubscribe page and the prompts the drafter and the proposal writer work
 * from. Change the phone number on the System settings screen and every one of
 * them says the new number on the next render. Nothing caches it beyond one
 * process, and saving clears that cache.
 *
 * **Blank means "use the default".** An empty field is not an instruction to
 * print nothing; it is an untouched field. The genuinely optional details — a
 * second phone line, a VAT number — have no default, so blank there means what
 * it looks like. A letterhead with no email address on it is never what
 * somebody meant, which is why the required fields fall back instead.
 */

export interface CompanyProfile {
  /** The printed form, letterspaced on documents. Usually the name in caps. */
  name: string;
  /** The wordmark as it is written in a sentence. */
  displayName: string;
  /** The registered entity, for invoices and terms. Falls back to displayName. */
  legalName: string;
  tagline: string;
  footerLine: string;
  /** The same promise where caps would read as shouting — plain-text email. */
  promise: string;
  positioning: string;

  location: string;
  /** The full postal address, one line per line. Empty when there isn't one. */
  addressLines: string[];
  email: string;
  phone: string;
  /** A second line — WhatsApp, a landline. Empty when there isn't one. */
  phoneAlt: string;
  web: string;

  /** Where a client is sent to find us. Empty strings are simply not shown. */
  social: { linkedin: string; x: string; instagram: string; facebook: string; youtube: string };

  /** What money is quoted in by default. */
  currency: string;
  registrationNumber: string;
  vatNumber: string;
}

/** The four brand images, any of which may be absent. */
export type BrandSlot = "logoLight" | "logoDark" | "mark" | "favicon";

export const BRAND_SLOTS: { slot: BrandSlot; label: string; what: string }[] = [
  { slot: "logoLight", label: "Logo on light", what: "The lock-up used on white — the email header, the PDF letterhead, the app's own nav." },
  { slot: "logoDark", label: "Logo on dark", what: "The on-dark cut, for the ink footer band at the bottom of every email." },
  { slot: "mark", label: "Mark", what: "The symbol on its own, where the full lock-up doesn't fit." },
  { slot: "favicon", label: "Favicon", what: "The browser tab icon, for the app and the unsubscribe page." },
];

const PROFILE_KEY = "system.profile";
const brandKey = (slot: BrandSlot) => `system.brand.${slot}`;

/** Everything a profile can carry, with the shipped constants as the floor. */
export const DEFAULT_PROFILE: CompanyProfile = {
  name: COMPANY.name,
  displayName: COMPANY.displayName,
  legalName: COMPANY.displayName,
  tagline: COMPANY.tagline,
  footerLine: COMPANY.footerLine,
  promise: COMPANY.promise,
  positioning: COMPANY.positioning,
  location: COMPANY.location,
  addressLines: [],
  email: COMPANY.email,
  phone: COMPANY.phone,
  phoneAlt: "",
  web: COMPANY.web,
  social: { linkedin: "", x: "", instagram: "", facebook: "", youtube: "" },
  currency: "GHS",
  registrationNumber: "",
  vatNumber: "",
};

// One process, one cache — the same contract lib/settings.ts keeps. A render
// path may ask for this several times per document, and it changes only when a
// person presses Save, which is the moment the cache is cleared.
let cached: CompanyProfile | null = null;
const brandCache = new Map<BrandSlot, string | null>();

export function clearSystemProfileCache() {
  cached = null;
  brandCache.clear();
}

function merge(stored: unknown): CompanyProfile {
  if (!stored || typeof stored !== "object") return DEFAULT_PROFILE;
  const raw = stored as Partial<CompanyProfile>;

  const text = (value: unknown, fallback: string): string => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed || fallback;
  };
  const optional = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

  return {
    name: text(raw.name, DEFAULT_PROFILE.name),
    displayName: text(raw.displayName, DEFAULT_PROFILE.displayName),
    legalName: text(raw.legalName, text(raw.displayName, DEFAULT_PROFILE.legalName)),
    tagline: text(raw.tagline, DEFAULT_PROFILE.tagline),
    footerLine: text(raw.footerLine, DEFAULT_PROFILE.footerLine),
    promise: text(raw.promise, DEFAULT_PROFILE.promise),
    positioning: text(raw.positioning, DEFAULT_PROFILE.positioning),
    location: text(raw.location, DEFAULT_PROFILE.location),
    addressLines: Array.isArray(raw.addressLines)
      ? raw.addressLines.map((line) => String(line).trim()).filter(Boolean).slice(0, 6)
      : [],
    email: text(raw.email, DEFAULT_PROFILE.email),
    phone: text(raw.phone, DEFAULT_PROFILE.phone),
    phoneAlt: optional(raw.phoneAlt),
    // Stored bare, so every caller can decide whether it wants a link or a
    // label. A pasted "https://dakyworld.com/" would otherwise print in full
    // across the bottom of every email.
    web: text(raw.web, DEFAULT_PROFILE.web).replace(/^https?:\/\//, "").replace(/\/$/, ""),
    social: {
      linkedin: optional(raw.social?.linkedin),
      x: optional(raw.social?.x),
      instagram: optional(raw.social?.instagram),
      facebook: optional(raw.social?.facebook),
      youtube: optional(raw.social?.youtube),
    },
    currency: text(raw.currency, DEFAULT_PROFILE.currency).toUpperCase().slice(0, 6),
    registrationNumber: optional(raw.registrationNumber),
    vatNumber: optional(raw.vatNumber),
  };
}

/**
 * The company as it currently stands. Every renderer calls this rather than
 * importing `COMPANY` directly — that is the whole point of the file.
 */
export async function companyProfile(): Promise<CompanyProfile> {
  if (cached) return cached;
  const row = await prisma.appSetting.findUnique({ where: { key: PROFILE_KEY } });
  let parsed: unknown = null;
  if (row) {
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // A profile that won't parse is a profile nobody can fix from the UI, so
      // it degrades to the shipped defaults rather than taking every document
      // down with it.
      console.error("[system] the stored company profile isn't valid JSON — using the shipped defaults.");
    }
  }
  cached = merge(parsed);
  return cached;
}

/** Replaces the profile wholesale. The form sends every field, so a patch would only hide typos. */
export async function saveCompanyProfile(input: unknown): Promise<CompanyProfile> {
  const next = merge(input);
  await prisma.appSetting.upsert({
    where: { key: PROFILE_KEY },
    update: { value: JSON.stringify(next), secret: false },
    create: { key: PROFILE_KEY, value: JSON.stringify(next), secret: false },
  });
  cached = next;
  return next;
}

// --- Brand artwork ----------------------------------------------------------

/**
 * Logos live in the database as data URLs rather than as files on disk.
 *
 * Railway's filesystem is ephemeral: a logo written into `server/assets/` at
 * runtime survives until the next deploy and then silently reverts, which is
 * the worst of both worlds because it looks like it worked. The artwork on
 * disk stays as the shipped fallback, and anything uploaded here wins over it.
 */
export async function brandImage(slot: BrandSlot): Promise<string | null> {
  if (brandCache.has(slot)) return brandCache.get(slot) ?? null;
  const row = await prisma.appSetting.findUnique({ where: { key: brandKey(slot) } });
  const value = row?.value ?? null;
  brandCache.set(slot, value);
  return value;
}

/** Every uploaded slot in one read — the renderers want two or three at a time. */
export async function brandImages(): Promise<Record<BrandSlot, string | null>> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: BRAND_SLOTS.map((entry) => brandKey(entry.slot)) } } });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const result = {} as Record<BrandSlot, string | null>;
  for (const { slot } of BRAND_SLOTS) {
    const value = byKey.get(brandKey(slot)) ?? null;
    brandCache.set(slot, value);
    result[slot] = value;
  }
  return result;
}

export async function saveBrandImage(slot: BrandSlot, dataUrl: string) {
  await prisma.appSetting.upsert({
    where: { key: brandKey(slot) },
    update: { value: dataUrl, secret: false },
    create: { key: brandKey(slot), value: dataUrl, secret: false },
  });
  brandCache.set(slot, dataUrl);
}

export async function deleteBrandImage(slot: BrandSlot) {
  await prisma.appSetting.deleteMany({ where: { key: brandKey(slot) } });
  brandCache.delete(slot);
}

/** A data URL split into what an email attachment and a PDF both need. */
export function decodeDataUrl(dataUrl: string): { buffer: Buffer; contentType: string } | null {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  return buffer.length > 0 ? { buffer, contentType: match[1] } : null;
}

// --- What the writers are told ----------------------------------------------

/**
 * The company's contact details, as one block for a prompt.
 *
 * The drafter and the proposal writer are told who they are writing for in
 * `dakyworld.BRAND`, which is prose and stays prose. This is the part of it
 * that must never be stale — if the Owner changes the phone number, an email
 * offering the old one is worse than an email offering none.
 */
export function contactBlock(profile: CompanyProfile): string {
  const lines = [
    `- Company: ${profile.displayName}${profile.legalName !== profile.displayName ? ` (registered as ${profile.legalName})` : ""}`,
    `- Based in ${profile.location}.`,
    `- Email ${profile.email}. Phone ${profile.phone}${profile.phoneAlt ? ` (also ${profile.phoneAlt})` : ""}. Website ${profile.web}.`,
    `- In one line: ${profile.positioning}`,
  ];
  return `Current contact details — use these exactly, never an older one:\n\n${lines.join("\n")}`;
}
