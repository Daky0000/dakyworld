/**
 * Who Dakyworld is and what it sells, in one place.
 *
 * The email drafter and the proposal writer both have to describe the company,
 * and two descriptions of the same company is how a brand voice dies — so this
 * is the only copy of it. The service catalogue is here for a second reason:
 * the proposal writer is not allowed to invent a price, so what it may quote
 * has to be a fixed list rather than a paragraph it can read creatively.
 */

export const BRAND = `About the sender — Dakyworld:

- An outsourced IT department for established businesses in Ghana and West Africa. Based in Kumasi. The founder is Dan Kwame Ayipah, who writes and signs these himself.
- The offer, in one line: hire one IT company instead of building a whole team.
- What it covers: websites, security and backups, email/workspace and cloud, automation and AI, integrations, branding and design, training and consulting.
- Entirely digital and remote. No on-site visits, no hardware, no printers, no office networking. Never imply otherwise.
- Most clients arrive through a one-off project — usually a website build — and move onto a monthly care plan afterwards.
- Real numbers that may be used because they are true: 70%+ of manual admin burden cut for clients, a 4-hour response on priority-one security incidents, zero data-loss incidents. Do not invent statistics beyond these.
- Prices, when relevant: website builds from GHS 35,000; care plans at GHS 5,000 (SME Essentials), GHS 12,500 (Growth), GHS 25,000+ (Enterprise Concierge) a month. Only mention a price if the brief asks for one.`;

export const VOICE = `How Dakyworld writes:

- Plain, direct English. Short sentences. No consultant vocabulary — no "leverage", "solutions", "synergy", "cutting-edge", "in today's fast-paced world", "I hope this email finds you well".
- Calm and specific, never breathless. No exclamation marks. No emoji.
- Say the useful thing first. The reader decides in one line whether to keep reading.
- British spelling. Currency as "GHS 12,500".
- Sign off as Dan, not as a company.`;

// --- What can actually be sold ---------------------------------------------

/**
 * The details that go on anything a client keeps — the letterhead of every
 * PDF, the Word cut of a proposal, and the header and footer of every email.
 *
 * One copy, for the same reason the voice above has one copy: three versions
 * of a phone number is how a client ends up with the wrong one. The uppercase
 * spellings are the printed forms; the documents letterspace them.
 */
export const COMPANY = {
  name: "DAKYWORLD",
  /** The wordmark as it is written in a sentence. */
  displayName: "Dakyworld",
  tagline: "ONE IT COMPANY. EVERYTHING YOUR BUSINESS NEEDS.",
  footerLine: "ONE PARTNER. ALL YOUR IT.",
  /** The same promise where caps would read as shouting — plain-text email. */
  promise: "One partner. All your IT.",
  location: "Kumasi, Ghana",
  email: "info@dakyworld.com",
  phone: "+233 545 950 611",
  web: "dakyworld.com",
  /** What the company is, in the one sentence the website leads its footer with. */
  positioning: "Your outsourced IT department for growing businesses in Ghana and West Africa.",
} as const;

/**
 * One sellable line. `anchorPrice` is a price Dakyworld genuinely publishes;
 * where there isn't one, it stays null and the writer must say the number
 * comes after the discovery call rather than make one up.
 */
export interface ServiceLine {
  id: string;
  name: string;
  /** What this line is, in a sentence a buyer would recognise. */
  what: string;
  /** The problem it exists to fix — matched against audit findings. */
  fixes: string[];
  anchorPrice: number | null;
  /** ONE_OFF for project work, MONTHLY for anything retained. */
  billing: "ONE_OFF" | "MONTHLY";
  priceNote: string;
}

export const SERVICE_LINES: ServiceLine[] = [
  {
    id: "website-build",
    name: "Website build",
    what: "A new website: design, build, content structure, mobile, hosting set-up and handover.",
    fixes: ["no website", "page-builder or free-subdomain site", "site that cannot be used on a phone", "site nobody has touched in years"],
    anchorPrice: 35_000,
    billing: "ONE_OFF",
    priceNote: "From GHS 35,000. Scope drives the final number — page count, content writing, and whether they need e-commerce or bookings.",
  },
  {
    id: "website-rescue",
    name: "Website repair and hardening",
    what: "Taking an existing site that works but is unsafe or slow, and fixing it in place rather than rebuilding.",
    fixes: ["site served over plain HTTP", "out-of-date CMS", "no backups", "slow site"],
    anchorPrice: null,
    billing: "ONE_OFF",
    priceNote: "Quoted after a look at the site. Usually a fraction of a rebuild, and worth saying so.",
  },
  {
    id: "email-workspace",
    name: "Business email and workspace",
    what: "Email on their own domain, shared drives, calendars, and the accounts and access rules behind them.",
    fixes: ["business running on a free Gmail or Yahoo address", "domain with no mail set up", "staff sharing one mailbox"],
    anchorPrice: null,
    billing: "ONE_OFF",
    priceNote: "Set-up quoted per mailbox count; the licences are paid to Google or Microsoft directly, not to Dakyworld. Say that plainly — it is a trust-builder.",
  },
  {
    id: "security-backups",
    name: "Security and backups",
    what: "Domain and email authentication, backups that are tested, access control, and a response plan when something goes wrong.",
    fixes: ["no SPF or DMARC — anyone can send email in their name", "no backups", "no HTTPS", "exposed admin surface"],
    anchorPrice: null,
    billing: "MONTHLY",
    priceNote: "Normally part of a care plan rather than sold alone.",
  },
  {
    id: "automation",
    name: "Automation and AI",
    what: "Cutting manual admin — quotes, invoices, bookings, reporting, follow-ups — with automation and, where it fits, AI.",
    fixes: ["everything runs on paper, WhatsApp and spreadsheets", "same data typed into two systems", "manual follow-up"],
    anchorPrice: null,
    billing: "ONE_OFF",
    priceNote: "Quoted per workflow after a discovery call. The honest claim is 70%+ of the manual burden cut, which is a Dakyworld result, not a projection for them.",
  },
  {
    id: "integrations",
    name: "Integrations",
    what: "Making the systems they already pay for talk to each other.",
    fixes: ["same data typed into two systems", "no link between the website and the way enquiries are handled"],
    anchorPrice: null,
    billing: "ONE_OFF",
    priceNote: "Quoted per integration.",
  },
  {
    id: "branding",
    name: "Branding and design",
    what: "Identity, logo, colour and type, and the templates that keep everything looking like one company.",
    fixes: ["no consistent identity", "logo that only exists as a low-resolution image", "link previews that look broken when shared"],
    anchorPrice: null,
    billing: "ONE_OFF",
    priceNote: "Quoted per scope.",
  },
  {
    id: "training",
    name: "Training and consulting",
    what: "Getting staff genuinely able to use the tools — digital skills, AI adoption, and the working habits around them.",
    fixes: ["tools bought and never used", "one person is the single point of failure for everything technical"],
    anchorPrice: null,
    billing: "ONE_OFF",
    priceNote: "Quoted per workshop or per cohort.",
  },
];

/** The retainer tiers, which are where a one-off project is meant to lead. */
export const CARE_PLANS = [
  {
    tier: "SME Essentials",
    monthly: 5_000,
    for: "A single site and a handful of mailboxes. Monitoring, backups, updates, and someone to call.",
  },
  {
    tier: "Growth",
    monthly: 12_500,
    for: "Several systems and staff. Everything in Essentials plus proactive work, integrations and a monthly review.",
  },
  {
    tier: "Enterprise Concierge",
    monthly: 25_000,
    for: "Businesses where downtime costs money by the hour. Priority response, named contact, planned roadmap.",
  },
];

/** The catalogue as the writer sees it — prices included, so it need never guess. */
export function catalogueForPrompt(): string {
  const lines = SERVICE_LINES.map((service) => {
    const price = service.anchorPrice
      ? `GHS ${service.anchorPrice.toLocaleString("en-GB")}${service.billing === "MONTHLY" ? "/month" : ""}`
      : "no published price";
    return [
      `- ${service.name} (id: ${service.id}) — ${price}`,
      `  What it is: ${service.what}`,
      `  Sold when: ${service.fixes.join("; ")}`,
      `  Pricing: ${service.priceNote}`,
    ].join("\n");
  });

  const plans = CARE_PLANS.map(
    (plan) => `- ${plan.tier} — GHS ${plan.monthly.toLocaleString("en-GB")}/month. ${plan.for}`,
  );

  return `Services Dakyworld sells:\n\n${lines.join("\n\n")}\n\nCare plan tiers (monthly retainers):\n\n${plans.join("\n")}`;
}
