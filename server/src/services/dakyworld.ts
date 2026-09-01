/**
 * Who Dakyworld is and what it sells, in one place.
 *
 * The email drafter and the proposal writer both have to describe the company,
 * and two descriptions of the same company is how a brand voice dies — so this
 * is the only copy of it. The service catalogue is here for a second reason:
 * the proposal writer is not allowed to invent a price, so what it may quote
 * has to be a fixed list rather than a paragraph it can read creatively.
 *
 * **What is in this file is the floor, not the value.** The company's own
 * website is the thing customers read and the thing that changes — a price
 * comes down, a discount opens, a whole service line is dropped — and until
 * Sep 2026 none of that reached the workforce: every agent went on describing
 * eight services at last year's prices because a constant here said so. So
 * `SHIPPED_OFFER` is the default and `services/context/business.ts` is the
 * value, read from dakyworld.com and refreshed whenever the site changes.
 * Exactly the arrangement `systemProfile.ts` already has for the address and
 * the phone number, and for the same reason: changing what the company sells
 * must never need a redeploy.
 *
 * Keep this constant in step with the site anyway. It is what a deployment
 * with no model key, no GitHub token and no network still tells its agents.
 */

// --- Who the company is -----------------------------------------------------

/**
 * The details that go on anything a client keeps — the letterhead of every
 * PDF, the Word cut of a proposal, and the header and footer of every email.
 *
 * One copy, for the same reason the voice below has one copy: three versions
 * of a phone number is how a client ends up with the wrong one. The uppercase
 * spellings are the printed forms; the documents letterspace them.
 */
export const COMPANY = {
  name: "DAKYWORLD",
  /** The wordmark as it is written in a sentence. */
  displayName: "Dakyworld",
  tagline: "BUILD A BETTER DIGITAL SYSTEM FOR YOUR BUSINESS.",
  footerLine: "ONE PARTNER. BETTER DIGITAL SYSTEMS.",
  /** The same promise where caps would read as shouting — plain-text email. */
  promise: "One partner. Better digital systems.",
  location: "Kumasi, Ghana",
  email: "info@dakyworld.com",
  phone: "+233 545 950 611",
  web: "dakyworld.com",
  /** What the company is, in the one sentence the website leads its footer with. */
  positioning: "Your outsourced digital systems and automation team for growing businesses in Ghana and West Africa.",
} as const;

export const VOICE = `How Dakyworld writes:

- Plain, direct English. Short sentences. No consultant vocabulary — no "leverage", "solutions", "synergy", "cutting-edge", "in today's fast-paced world", "I hope this email finds you well".
- Calm and specific, never breathless. No exclamation marks. No emoji.
- Say the useful thing first. The reader decides in one line whether to keep reading.
- British spelling. Currency as "GHS 12,500".
- Sign off as Dan, not as a company.`;

// --- What can actually be sold ---------------------------------------------

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

/**
 * A retainer tier.
 *
 * `discountedMonthly` is a rate that is genuinely on offer *now* and stops
 * being on offer later, which is why it is a field rather than a rewritten
 * `monthly`. A writer that only ever sees one number cannot say "GHS 3,000 for
 * the first three months, GHS 5,000 after that", and a discount nobody can
 * state is a discount that sells nothing.
 */
export interface CarePlanTier {
  tier: string;
  monthly: number | null;
  discountedMonthly: number | null;
  /** What the discount is and how long it lasts. Empty when there isn't one. */
  discountNote: string;
  for: string;
}

/** A defined piece of project work, as the website lists it. */
export interface ProjectPackage {
  name: string;
  /** The published "from" price. Null where the site does not publish one. */
  from: number | null;
  what: string;
}

/**
 * Everything the workforce is told about what this company sells.
 *
 * Assembled from the website by `services/context/business.ts`, with
 * `SHIPPED_OFFER` below as the floor.
 */
export interface BusinessOffer {
  /** What the company is, in one line. */
  positioning: string;
  /** The lines under it — who it is for, how it works, what it is not. */
  summary: string[];
  /**
   * What Dakyworld does **not** do, in the site's own words.
   *
   * Load-bearing, and the reason this whole sync exists. The previous version
   * of this file had every agent offering "email/workspace and cloud" and "a
   * four-hour response on priority-one security incidents" months after the
   * website said plainly that Dakyworld does not administer business email or
   * run managed cybersecurity. A pitch for work the company will not do is
   * worse than no pitch: it is discovered on the call.
   */
  doesNotDo: string[];
  /** Figures that may be used because the company publishes them. */
  proofPoints: string[];
  services: ServiceLine[];
  plans: CarePlanTier[];
  projects: ProjectPackage[];
  /** Programmes and discounts running now, each as one sentence. */
  offers: string[];
}

/**
 * The offer as it stood when this was last written by hand — 1 Sep 2026,
 * read off dakyworld.com.
 */
export const SHIPPED_OFFER: BusinessOffer = {
  positioning: COMPANY.positioning,
  summary: [
    "An outsourced digital systems and automation partner for growing businesses in Ghana and West Africa. Based in Kumasi. The founder is Dan Kwame Ayipah, who writes and signs these himself.",
    "The offer, in one line: one partner for the website, the workflows, the connections between the tools you already pay for, and the people who have to use them.",
    "Four capabilities, and they are sold as one connected system rather than as four specialisms: websites and web platforms, automation and AI, integrations and business systems, training and consulting.",
    "Entirely remote, worked through structured communication, calls and screen sharing.",
    "Most clients arrive through a defined project — usually a website and digital foundation build — and move onto a monthly partnership afterwards when ongoing improvement is worth paying for.",
  ],
  doesNotDo: [
    "Repair laptops, printers or any physical device.",
    "Install or support office networks and cabling.",
    "Run managed cybersecurity operations.",
    "Administer everyday business email or cloud infrastructure.",
    "Provide general on-site IT support. There are no site visits at all.",
  ],
  proofPoints: [
    "70% of the manual work removed through one automation workflow.",
    "30+ qualified enquiries a month from an improved customer journey.",
    "30+ hours returned every month through automation.",
  ],
  services: [
    {
      id: "websites",
      name: "Websites & web platforms",
      what: "Corporate websites, redesigns, landing pages, e-commerce journeys, customer portals and internal web tools, built around one business outcome — credibility, enquiries, sales, bookings or self-service.",
      fixes: [
        "no website",
        "outdated website",
        "page-builder or free-subdomain site",
        "site that cannot be used on a phone",
        "weak enquiry flow",
        "unclear offer",
        "no forms, analytics or lead capture",
      ],
      anchorPrice: 15_000,
      billing: "ONE_OFF",
      priceNote:
        "Website & Digital Foundation Builds from GHS 15,000. The final number depends on page count, how much content and design work is needed, the lead connections involved, and whether an existing site is being improved or replaced.",
    },
    {
      id: "automation",
      name: "Automation & AI",
      what: "Practical automations and AI-assisted workflows built around how the team already works — lead capture and follow-up, onboarding and handoffs, scheduled reports, internal assistants.",
      fixes: [
        "everything runs on paper, WhatsApp and spreadsheets",
        "manual follow-up",
        "same data typed into two systems",
        "repetitive reporting",
        "slow response to enquiries",
      ],
      anchorPrice: 8_000,
      billing: "ONE_OFF",
      priceNote:
        "Workflow automation and systems-connection projects from GHS 8,000, quoted per workflow after a consultation. The honest claim is 70% of the manual work removed on one workflow, which is a Dakyworld result rather than a projection for them.",
    },
    {
      id: "integrations",
      name: "Integrations & business systems",
      what: "Connecting the website, forms, CRM, WhatsApp, payments, calendars and reporting so information reaches the right place without somebody carrying it there.",
      fixes: [
        "no link between the website and the way enquiries are handled",
        "leads arrive and nobody follows up",
        "customer information copied between tools by hand",
        "no CRM, or a CRM nobody uses",
      ],
      anchorPrice: 8_000,
      billing: "ONE_OFF",
      priceNote: "Quoted per integration, from GHS 8,000 as part of a workflow automation and systems-connection project.",
    },
    {
      id: "training",
      name: "Training & consulting",
      what: "AI-adoption workshops, onboarding onto newly built workflows, website and CRM training, workflow reviews, and advisory on what to improve next.",
      fixes: ["tools bought and never used", "one person is the single point of failure for everything technical", "no plan for what to improve next"],
      anchorPrice: 3_000,
      billing: "ONE_OFF",
      priceNote: "AI, automation and digital-systems advisory from GHS 3,000 per engagement, quoted per workshop or per cohort.",
    },
  ],
  plans: [
    {
      tier: "Foundation",
      monthly: 5_000,
      discountedMonthly: 3_000,
      discountNote: "GHS 3,000 a month as a Founding Partner rate for the first three months, then GHS 5,000.",
      for: "Established small businesses that need a stronger digital presence, a clearer enquiry path and steady improvement without hiring an internal team.",
    },
    {
      tier: "Growth",
      monthly: 12_500,
      discountedMonthly: 7_000,
      discountNote: "GHS 7,000 a month as a Founding Partner rate for the first three months, then GHS 12,500.",
      for: "Growing businesses that need the website, customer journey, CRM, automations and internal processes to improve together. The plan most clients choose.",
    },
    {
      tier: "Transformation",
      monthly: 25_000,
      discountedMonthly: 15_000,
      discountNote: "From GHS 15,000 a month as a Founding Partner rate for the first three months, then from GHS 25,000.",
      for: "Larger businesses, institutions and multi-team operations that need a partner to plan, build and keep improving connected systems.",
    },
  ],
  projects: [
    {
      name: "Website & Digital Foundation Build",
      from: 15_000,
      what: "The customer-facing foundation: build or improve the site so the business looks credible, captures enquiries and supports follow-up.",
    },
    {
      name: "Workflow Automation and Systems Connection",
      from: 8_000,
      what: "A focused build that removes manual work or connects business tools into one smoother process.",
    },
    {
      name: "Connected Growth System Build",
      from: 35_000,
      what: "The larger project: website, customer journey, CRM, integrations and automation designed as one system.",
    },
    {
      name: "AI, Automation and Digital Systems Advisory",
      from: 3_000,
      what: "Guidance for teams using new systems, or deciding which improvement comes next.",
    },
  ],
  offers: [
    "The Founding Partner programme: the first three suitable businesses get a preferred monthly rate for the first three months of an initial three-month engagement, in return for timely access and feedback. Foundation GHS 3,000 instead of 5,000; Growth GHS 7,000 instead of 12,500; Transformation from GHS 15,000 instead of from 25,000.",
    "Every engagement gets a written scope, a monthly capacity allocation and agreed priorities. A Founding Partner rate is not an offer of unlimited work.",
    "Third-party costs — hosting, domains, CRM and automation licences, AI subscriptions, payment fees, advertising — are billed separately unless a written proposal says otherwise.",
  ],
};

// --- How the offer is written into a prompt ---------------------------------

const money = (amount: number) => `GHS ${amount.toLocaleString("en-GB")}`;

/**
 * Who the sender is, as the drafter reads it.
 *
 * Takes the offer rather than reading a constant, because the value is
 * whatever the website currently says — see `services/context/business.ts`.
 */
export function brandFrom(offer: BusinessOffer): string {
  const lines = [
    "About the sender — Dakyworld:",
    "",
    ...offer.summary.map((line) => `- ${line}`),
    `- Prices, when relevant: ${offer.services
      .filter((service) => service.anchorPrice)
      .map((service) => `${service.name.toLowerCase()} from ${money(service.anchorPrice as number)}`)
      .join("; ")}; monthly partnerships at ${offer.plans
      .map((plan) => `${plan.tier} ${plan.monthly ? money(plan.monthly) : "priced on scope"}${plan.discountedMonthly ? ` (${money(plan.discountedMonthly)} now)` : ""}`)
      .join(", ")}. Only mention a price if the brief asks for one.`,
  ];

  if (offer.proofPoints.length) {
    lines.push(`- Real numbers that may be used because they are published: ${offer.proofPoints.join(" ")} Do not invent statistics beyond these.`);
  }
  if (offer.offers.length) {
    lines.push("", "On offer at the moment:", ...offer.offers.map((entry) => `- ${entry}`));
  }
  if (offer.doesNotDo.length) {
    // Last, and stated as a rule rather than as a description. Everything above
    // is what may be said; this is what may not, and a model that reads it as
    // one more capability bullet will cheerfully offer the opposite.
    lines.push(
      "",
      "**What Dakyworld does not do. Never offer any of it, never imply it, and never let a finding about it become the reason to write:**",
      ...offer.doesNotDo.map((entry) => `- ${entry}`),
    );
  }

  return lines.join("\n");
}

/** The catalogue as the writer sees it — prices included, so it need never guess. */
export function catalogueFrom(offer: BusinessOffer): string {
  const lines = offer.services.map((service) => {
    const price = service.anchorPrice ? `${money(service.anchorPrice)}${service.billing === "MONTHLY" ? "/month" : ""}` : "no published price";
    return [
      `- ${service.name} (id: ${service.id}) — ${price}`,
      `  What it is: ${service.what}`,
      `  Sold when: ${service.fixes.join("; ")}`,
      `  Pricing: ${service.priceNote}`,
    ].join("\n");
  });

  const plans = offer.plans.map((plan) => {
    const rate = plan.monthly ? `${money(plan.monthly)}/month` : "priced on scope";
    // The reduced rate is printed as a figure of its own, not left inside the
    // note. A writer that can only see one number cannot say "GHS 3,000 for the
    // first three months, GHS 5,000 after that" — and a discount nobody can
    // state as a number is a discount that sells nothing.
    const now = plan.discountedMonthly && plan.discountedMonthly !== plan.monthly ? ` On offer now at ${money(plan.discountedMonthly)}/month.` : "";
    return `- ${plan.tier} — ${rate}.${now} ${plan.for}${plan.discountNote ? ` ${plan.discountNote}` : ""}`;
  });

  const parts = [`Services Dakyworld sells:\n\n${lines.join("\n\n")}`, `Monthly partnership tiers (retainers):\n\n${plans.join("\n")}`];

  if (offer.projects.length) {
    parts.push(
      `Defined projects, as the website lists them:\n\n${offer.projects
        .map((project) => `- ${project.name} — ${project.from ? `from ${money(project.from)}` : "priced on scope"}. ${project.what}`)
        .join("\n")}`,
    );
  }
  if (offer.doesNotDo.length) {
    parts.push(`Never sold, however well it would fit what was found:\n\n${offer.doesNotDo.map((entry) => `- ${entry}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

/**
 * The service ids findings were written against before the offer was narrowed.
 *
 * `companyAudit.ts` tags every finding with the service line that addresses it,
 * and those tags were written when this company sold eight. Four of them are
 * now work Dakyworld does not do — a finding about a business running on a free
 * Gmail address used to say "addressed by: email-workspace", and the site now
 * says plainly that Dakyworld does not administer business email. A stale tag
 * is not a cosmetic problem: it is the one line in the prompt that tells a
 * writer this fault is *sellable*.
 *
 * So the mapping is here rather than rewritten across a thousand lines of
 * finding definitions: null means the fault is real and there is nothing to
 * offer for it, which is a perfectly good thing for a letter to say.
 */
const SERVICE_ALIASES: Record<string, string | null> = {
  "website-build": "websites",
  "website-rescue": "websites",
  automation: "automation",
  integrations: "integrations",
  training: "training",
  // Retired with the offer. Kept named rather than deleted, so a finding
  // tagged with one resolves to "not sold" instead of falling through as an
  // unknown id nobody can explain.
  "email-workspace": null,
  "security-backups": null,
  branding: null,
};

/**
 * Which currently-sold service addresses a finding, if any.
 *
 * Resolved against the shipped catalogue rather than the synced one because
 * this runs inside a synchronous prompt builder; the synced catalogue is what
 * decides what may actually be *offered*, and it is in the same prompt.
 */
export function serviceForFinding(id: string | null, offer: BusinessOffer = SHIPPED_OFFER): string | null {
  if (!id) return null;
  const mapped = id in SERVICE_ALIASES ? SERVICE_ALIASES[id] : id;
  if (!mapped) return null;
  return offer.services.find((service) => service.id === mapped)?.name ?? null;
}

/**
 * The shipped renderings.
 *
 * Every caller should be reading `brandBlock()` / `catalogueBlock()` from
 * `services/context/business.ts` instead — these two are what those fall back
 * to, and what the checks compare against.
 */
export const SHIPPED_BRAND = brandFrom(SHIPPED_OFFER);
export const SHIPPED_CATALOGUE = catalogueFrom(SHIPPED_OFFER);

/** @deprecated The service lines of the *shipped* offer. Use `businessOffer()`. */
export const SERVICE_LINES = SHIPPED_OFFER.services;
