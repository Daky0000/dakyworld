import type { EmailPurpose } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * The letters Dakyworld sends often enough to be worth having written down.
 *
 * These ship with the app and are copied into the database the first time the
 * templates are read, so they can be edited like any other. Once copied they
 * are never overwritten — a deploy must not undo an edit Dan made to the words
 * that go out under his own name.
 *
 * They are deliberately short and specific rather than fill-in-the-blank
 * scaffolding: a template that needs six edits before it can be sent gets
 * rewritten from scratch every time instead, which is the same as having none.
 */

export interface BuiltinTemplate {
  slug: string;
  name: string;
  purpose: EmailPurpose;
  description: string;
  subject: string;
  body: string;
  /** Extra steer when this template is handed to the drafter rather than sent as-is. */
  aiBrief?: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    slug: "cold-no-website",
    name: "Cold — no website found",
    purpose: "COLD_OUTREACH",
    description: "For a scraped business with no website. The clearest reason to write to anyone.",
    subject: "{{company}} online",
    body: `Hi {{first_name}},

I came across {{company}} while looking at {{category}} businesses in {{city}}, and couldn't find a website for you — just the Google listing.

That's usually costing more than it looks. People check before they call, and when there's nothing to check they call whoever they can find instead.

I build and then look after the whole thing for businesses here — site, email, backups, the lot — so it isn't a project you have to manage.

Worth a short call to see whether it's worth doing for you?`,
    aiBrief: "Lead with the missing website. Keep it under 110 words. One ask: a short call.",
  },
  {
    slug: "cold-outdated-site",
    name: "Cold — site exists but is weak",
    purpose: "COLD_OUTREACH",
    description: "For a business whose site is a page-builder template or clearly neglected.",
    subject: "your site, {{first_name}}",
    body: `Hi {{first_name}},

I had a look at {{website}} while going through {{category}} businesses in {{city}}. The business behind it reads as far more established than the site does.

That gap matters mostly at the moment someone is deciding whether to trust you with money.

I run the whole digital side for businesses like yours — the site, the email, security, the backups — as one arrangement rather than a project you have to chase.

Would a short call be useful?`,
    aiBrief: "Name the specific gap between the business and its site. Do not insult the site directly.",
  },
  {
    slug: "follow-up-one",
    name: "Follow-up — first",
    purpose: "FOLLOW_UP",
    description: "Sent a few days after a first email with no reply.",
    subject: "re: {{company}}",
    body: `Hi {{first_name}},

Following up on my note last week — I know how these land in a busy week.

If it's useful, I can send over what I'd actually do for {{company}}, priced, before you commit to a call. No obligation either way.

Just say the word, or tell me to stop and I won't write again.`,
    aiBrief: "Add one new offer of value. Make it easy to decline. Never guilt them.",
  },
  {
    slug: "meeting-request",
    name: "Call request",
    purpose: "MEETING_REQUEST",
    description: "Asking for the thirty-minute consultation.",
    subject: "thirty minutes, {{first_name}}?",
    body: `Hi {{first_name}},

Could we put thirty minutes in the diary this week or next?

I'd go through what {{company}} has now — site, email, backups, who has access to what — and tell you plainly where the risks are. You get that whether or not you work with me.

What suits you? I'll work around your day.`,
  },
  {
    slug: "proposal-cover",
    name: "Proposal cover note",
    purpose: "PROPOSAL_COVER",
    description: "The note that carries the proposal PDF.",
    subject: "proposal for {{company}}",
    body: `Hi {{first_name}},

The proposal is attached — scope, timeline and price on two pages.

The one decision it asks for is which tier fits. Everything else we can settle once we start.

I'll follow up on Thursday if I haven't heard from you. If anything in it doesn't read right, tell me and I'll change it.`,
    aiBrief: "Two or three sentences. Do not re-argue the proposal — it argues for itself.",
  },
  {
    slug: "deliverable-handover",
    name: "Deliverable handover",
    purpose: "DELIVERABLE_HANDOVER",
    description: "Handing over finished work, with the files attached.",
    subject: "{{company}} — it's live",
    body: `Hi {{first_name}},

This is done and live. Everything is attached.

A few things worth knowing:

- Backups run nightly and I hold the restore points.
- Anything you want changed, send it to me rather than editing it yourself — that's what the arrangement is for.
- Nothing here needs anything from you today.

Anything at all, reply to this.`,
    aiBrief: "Confident and plain. Say what is delivered, what needs them, and who to ask.",
  },
  {
    slug: "project-update",
    name: "Weekly project update",
    purpose: "PROJECT_UPDATE",
    description: "The Friday note while work is live.",
    subject: "{{company}} — this week",
    body: `Hi {{first_name}},

Where things stand:

Done this week:
-

Next week:
-

Nothing needed from you. If that changes I'll say so directly rather than burying it here.`,
  },
  {
    slug: "invoice-delivery",
    name: "Invoice",
    purpose: "INVOICE_DELIVERY",
    description: "Sends the invoice PDF. Neutral and administrative.",
    subject: "invoice for {{company}}",
    body: `Hi {{first_name}},

Invoice attached, covering this month's care plan.

Payment details are on the invoice. Anything that looks wrong, tell me and I'll reissue it.`,
  },
  {
    slug: "invoice-reminder",
    name: "Payment reminder",
    purpose: "INVOICE_REMINDER",
    description: "For an invoice past its due date.",
    subject: "invoice reminder",
    body: `Hi {{first_name}},

A gentle nudge — the invoice I sent is past its due date. I'm assuming it slipped past rather than anything else.

If it's easier, I can resend it or set up a payment link. Just say which.`,
    aiBrief: "Name the amount and how many days late. Assume it was overlooked. No threats, no apology for asking.",
  },
  {
    slug: "care-plan-review",
    name: "Care plan review",
    purpose: "CARE_PLAN_REVIEW",
    description: "Booking the periodic review that the retainer promises.",
    subject: "your quarterly review",
    body: `Hi {{first_name}},

We're due a review on the care plan.

It's half an hour: what we've done this quarter, what's changed on your side, and what's worth doing next. It's also the right moment to tell me if anything isn't working.

Any time in the next couple of weeks — what suits?`,
  },
  {
    slug: "onboarding",
    name: "Welcome / onboarding",
    purpose: "ONBOARDING",
    description: "Sent when a proposal is accepted and the project opens.",
    subject: "welcome — here's what happens next",
    body: `Hi {{first_name}},

Good to be starting.

What happens now:

1. I take stock of what {{company}} has already — domains, email, hosting, who holds what.
2. Anything I take over, I move onto staging first. Nothing changes on a live system without you knowing.
3. You'll get a short note from me every Friday, whether or not there's news.

To begin I need access to your domain and hosting. Send what you have and I'll tell you what's missing.`,
  },
  {
    slug: "reactivation",
    name: "Reactivation",
    purpose: "REACTIVATION",
    description: "For a client whose work ended a while ago, or a lead that went quiet.",
    subject: "checking in on {{company}}",
    body: `Hi {{first_name}},

It's been a while since we worked together on {{company}}.

No agenda — I mostly wanted to know whether the site and everything around it is still holding up, and whether anyone is looking after it.

If it's all fine, ignore this. If it isn't, I'm here.`,
    aiBrief: "Acknowledge the gap without awkwardness. Give a real reason for writing now. Very small ask.",
  },
  {
    slug: "thank-you",
    name: "Thank you",
    purpose: "THANK_YOU",
    description: "After a referral, a testimonial, or a project closing well.",
    subject: "thank you",
    body: `Hi {{first_name}},

Thank you — genuinely.

It made a difference, and I wanted to say so properly rather than in passing.`,
    aiBrief: "Three sentences at most. No upsell of any kind.",
  },
];

/**
 * Copies anything new into the database and returns the live set. Existing
 * rows are left exactly as they are: `builtin` marks where a template came
 * from, not who owns it now.
 */
export async function ensureBuiltinTemplates() {
  const existing = await prisma.emailTemplate.findMany({ select: { slug: true } });
  const known = new Set(existing.map((row) => row.slug));
  const missing = BUILTIN_TEMPLATES.filter((template) => !known.has(template.slug));
  if (missing.length === 0) return;

  await prisma.emailTemplate.createMany({
    data: missing.map((template) => ({
      slug: template.slug,
      name: template.name,
      purpose: template.purpose,
      description: template.description,
      subject: template.subject,
      bodyHtml: template.body,
      aiBrief: template.aiBrief ?? null,
      builtin: true,
    })),
    skipDuplicates: true,
  });
  console.log(`[email] added ${missing.length} built-in template(s)`);
}
