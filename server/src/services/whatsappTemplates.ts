import type { WhatsAppTemplate } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WhatsAppError, countVariables, createTemplate, deleteTemplate, listTemplates, whatsappTemplatesConfigured } from "../lib/whatsapp.js";

/**
 * The templates a cold WhatsApp is actually sent as.
 *
 * A scraped lead has never messaged us, so the 24-hour free-form window has
 * never been open, so **every first WhatsApp is a template** and every one of
 * those has to be approved by Meta before it can carry a single message. That
 * is the whole reason this file exists, and it is the part of the module that
 * cannot be made to go faster: approval takes minutes to a day and there is no
 * way round it. The wa.me path in lib/phone.ts is what covers that gap.
 *
 * **This table mirrors Meta and never leads it.** `syncTemplates` is the only
 * thing that writes a status, because Meta is the only thing that knows one:
 * a template can be approved, then paused a week later because recipients
 * blocked it, with nothing happening on our side at all. A local copy that
 * decides for itself what is approved is a copy that sends into a hard error.
 */

/** Meta's rule: lower-case letters, digits and underscores only, and it is permanent. */
export function templateNameFrom(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export interface TemplateProblem {
  field: string;
  message: string;
}

/**
 * The refusals Meta gives, checked before submitting rather than after.
 *
 * Every one of these comes back from the Graph API as a generic "invalid
 * parameter", hours after submission in the worst case, with no indication of
 * which rule was broken. Checking here turns a day's delay into a sentence in
 * the composer.
 */
export function checkTemplate(input: { name: string; body: string; header?: string | null; footer?: string | null; category: string }): TemplateProblem[] {
  const problems: TemplateProblem[] = [];

  if (!/^[a-z0-9_]{1,512}$/.test(input.name)) {
    problems.push({ field: "name", message: "A template name may only contain lower-case letters, numbers and underscores." });
  }

  const body = input.body.trim();
  if (!body) problems.push({ field: "body", message: "A template needs a body." });
  if (body.length > 1024) problems.push({ field: "body", message: `The body is ${body.length} characters; Meta's limit is 1024.` });

  // Meta refuses a body that starts or ends on a variable, and refuses two
  // variables with nothing between them. Both are about the reviewer being
  // able to tell what the message actually says.
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(body)) {
    problems.push({ field: "body", message: "A template can't begin with a variable — Meta rejects it. Put some words in front of it." });
  }
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(body)) {
    problems.push({ field: "body", message: "A template can't end with a variable. Put some words after it." });
  }
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(body)) {
    problems.push({ field: "body", message: "Two variables can't sit next to each other with nothing between them." });
  }

  // The numbering has to be 1..n with no gaps; {{1}} and {{3}} is a refusal.
  const numbers = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => Number(match[1]));
  const distinct = [...new Set(numbers)].sort((a, b) => a - b);
  if (distinct.length && (distinct[0] !== 1 || distinct.some((value, index) => value !== index + 1))) {
    problems.push({ field: "body", message: `Variables must run {{1}}, {{2}}, {{3}} with no gaps — this one has ${distinct.map((n) => `{{${n}}}`).join(", ")}.` });
  }

  if (input.header && input.header.length > 60) problems.push({ field: "header", message: "A header is limited to 60 characters." });
  if (input.footer && input.footer.length > 60) problems.push({ field: "footer", message: "A footer is limited to 60 characters." });

  // Not Meta's rule — ours. A marketing template with no way out is what gets
  // a number reported, and a reported number loses the ability to start
  // conversations at all. Cheaper to catch here than to learn from a quality
  // rating going red.
  if (input.category === "MARKETING" && !/\bstop\b/i.test(`${body} ${input.footer ?? ""}`)) {
    problems.push({
      field: "footer",
      message: 'A marketing template needs a way out — put "Reply STOP to opt out" in the footer. Without one, recipients block the number instead, and a blocked number stops being able to message anybody.',
    });
  }

  return problems;
}

/**
 * Pulls every template from Meta and makes this table match.
 *
 * A template that has disappeared from Meta is marked `DELETED` here rather
 * than removed, because messages already sent point at it and an outbox that
 * cannot say what was sent is not an outbox.
 */
export async function syncTemplates(): Promise<{ synced: number; approved: number; removed: number }> {
  if (!(await whatsappTemplatesConfigured())) {
    throw new WhatsAppError("WhatsApp templates need the Business Account ID as well as the token. Add it under Settings → Messaging.", 503);
  }

  const remote = await listTemplates();
  const now = new Date();

  for (const template of remote) {
    await prisma.whatsAppTemplate.upsert({
      where: { name_language: { name: template.name, language: template.language } },
      update: {
        metaId: template.metaId,
        category: template.category,
        status: template.status,
        rejectionReason: template.rejectionReason,
        body: template.body,
        header: template.header,
        footer: template.footer,
        buttons: template.buttons as never,
        variableCount: template.variableCount,
        syncedAt: now,
      },
      create: {
        metaId: template.metaId,
        name: template.name,
        language: template.language,
        category: template.category,
        status: template.status,
        rejectionReason: template.rejectionReason,
        body: template.body,
        header: template.header,
        footer: template.footer,
        buttons: template.buttons as never,
        variableCount: template.variableCount,
        syncedAt: now,
      },
    });
  }

  const seen = new Set(remote.map((template) => `${template.name}:${template.language}`));
  const stale = await prisma.whatsAppTemplate.findMany({ where: { status: { not: "DELETED" } } });
  let removed = 0;
  for (const template of stale) {
    if (seen.has(`${template.name}:${template.language}`)) continue;
    // A template that was never submitted has no Meta id and is a local draft,
    // not something that has vanished. Leave those alone.
    if (!template.metaId) continue;
    await prisma.whatsAppTemplate.update({ where: { id: template.id }, data: { status: "DELETED", syncedAt: now } });
    removed += 1;
  }

  return { synced: remote.length, approved: remote.filter((template) => template.status === "APPROVED").length, removed };
}

/** Submits a template to Meta and records it locally as PENDING. */
export async function submitTemplate(input: {
  name: string;
  language?: string;
  category?: "MARKETING" | "UTILITY";
  body: string;
  header?: string | null;
  footer?: string | null;
  examples?: string[];
}): Promise<WhatsAppTemplate> {
  const name = templateNameFrom(input.name);
  const language = input.language ?? "en";
  const category = input.category ?? "MARKETING";

  const problems = checkTemplate({ name, body: input.body, header: input.header, footer: input.footer, category });
  if (problems.length) throw new WhatsAppError(problems.map((problem) => problem.message).join(" "), 400);

  const created = await createTemplate({ name, language, category, body: input.body, header: input.header, footer: input.footer, examples: input.examples });

  return prisma.whatsAppTemplate.upsert({
    where: { name_language: { name, language } },
    update: {
      metaId: created.metaId,
      category,
      status: created.status,
      rejectionReason: null,
      body: input.body,
      header: input.header ?? null,
      footer: input.footer ?? null,
      variableCount: countVariables(input.body),
      variableHints: hintsFor(input.body),
      syncedAt: new Date(),
    },
    create: {
      metaId: created.metaId,
      name,
      language,
      category,
      status: created.status,
      body: input.body,
      header: input.header ?? null,
      footer: input.footer ?? null,
      variableCount: countVariables(input.body),
      variableHints: hintsFor(input.body),
      syncedAt: new Date(),
    },
  });
}

export async function removeTemplate(id: string): Promise<void> {
  const template = await prisma.whatsAppTemplate.findUnique({ where: { id } });
  if (!template) throw new WhatsAppError("Template not found", 404);
  // A local draft that was never submitted is simply deleted; one that exists
  // at Meta has to be removed there first or the sync puts it straight back.
  if (template.metaId) await deleteTemplate(template.name);
  await prisma.whatsAppTemplate.delete({ where: { id } });
}

/**
 * What each `{{n}}` is for, guessed from the words around it.
 *
 * A template is written once and then filled in for every send, so by the time
 * somebody uses it "what goes in {{2}}?" is a real question with no answer
 * anywhere. This is a guess and is labelled as one in the UI — a wrong hint
 * costs nothing, a missing one costs somebody re-reading the template body.
 */
function hintsFor(body: string): string[] {
  const count = countVariables(body);
  const hints: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const match = body.match(new RegExp(`(.{0,40})\\{\\{\\s*${index}\\s*\\}\\}`));
    const before = match?.[1]?.trim() ?? "";
    hints.push(before ? `after "…${before}"` : `variable ${index}`);
  }
  return hints;
}

/**
 * Templates that ship with the app, ready to submit.
 *
 * Not seeded into the database — a row here that Meta has never seen would
 * appear in the composer as something sendable, which is the one thing this
 * table must never contain. They are offered on the Messaging screen as
 * one-click submissions.
 *
 * All four are written to the cold email playbook, adapted for a phone: the
 * sender is named in the first line, the observation is followed by what it
 * makes *harder* rather than what it has cost, there is no price, and the ask
 * offers something instead of requesting time. Each carries the opt-out in the
 * footer, which is both Meta's expectation for a marketing template and the
 * thing that stops a number being reported.
 *
 * The variables are deliberately few. Every `{{n}}` is a chance to send "Hi ,"
 * to somebody, and Meta rejects an empty variable outright — so the ones here
 * are values that are always present on a lead that got this far.
 */
export interface StarterTemplate {
  label: string;
  name: string;
  category: "MARKETING" | "UTILITY";
  purpose: string;
  body: string;
  footer: string;
  examples: string[];
  /** What each variable should be filled with, for the composer. */
  variables: string[];
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    label: "No website — offer an outline",
    name: "no_site_outline",
    category: "MARKETING",
    purpose: "COLD_OUTREACH",
    body:
      "Hi {{1}}, Daky here from Dakyworld — we build websites for businesses in Ghana. I was looking up {{2}} and couldn't find a website for you, only the listing. That means anyone who hears about you and searches has nothing to look at before deciding whether to call.\n\nWould it help if I sent over a one-page outline of what yours could cover? No cost and nothing needed from you.",
    footer: "Reply STOP to opt out",
    examples: ["Kwame", "Accra Dental Centre"],
    variables: ["Their first name", "The business name"],
  },
  {
    label: "Site is hard to use on a phone",
    name: "mobile_site_check",
    category: "MARKETING",
    purpose: "COLD_OUTREACH",
    body:
      "Hi {{1}}, Daky here from Dakyworld. I opened {{2}} on my phone before messaging and the page is hard to use at that size — the text needs zooming and the number isn't tappable, so anyone wanting to call has to type it out by hand.\n\nWant me to send you the screenshot of what it looks like? Takes me a minute and it's yours either way.",
    footer: "Reply STOP to opt out",
    examples: ["Ama", "amaskitchen.com"],
    variables: ["Their first name", "Their website address"],
  },
  {
    label: "Certificate warning on their site",
    name: "site_security_warning",
    category: "MARKETING",
    purpose: "COLD_OUTREACH",
    body:
      "Hi {{1}}, Daky here from Dakyworld. I tried to open {{2}} and the browser showed a security warning before letting me through — most people who see that close the tab rather than continue.\n\nHappy to send you the exact wording of the warning and what causes it, so whoever looks after the site can sort it. Want me to?",
    footer: "Reply STOP to opt out",
    examples: ["Kofi", "kofimotors.com"],
    variables: ["Their first name", "Their website address"],
  },
  {
    // **The one that can carry what was actually found.** The other three name
    // a fault in their fixed wording, so each is only sendable to a business
    // with that exact fault — and a cold WhatsApp is always a template, because
    // the free-form window has never been open. The consequence was that the
    // drafter could write a message argued from a four-reviewer review and the
    // only way to send it through the API was to pick whichever of three
    // stock faults came closest. This one leaves the observation as a variable,
    // so the evidence reaches the person.
    //
    // Three variables is the ceiling worth trying: Meta's reviewer has to be
    // able to tell what the message says, and a body that is mostly `{{n}}` is
    // a body that gets refused. Fill {{3}} with one short clause in the
    // owner's own terms — "the page is hard to read on a phone" — never a
    // paragraph and never anything the facts did not establish.
    label: "Something noticed — carries the finding",
    name: "site_observation",
    category: "MARKETING",
    purpose: "COLD_OUTREACH",
    body:
      "Hi {{1}}, Daky here from Dakyworld — we look after IT and websites for businesses in Ghana. I had a look at {{2}} before messaging and noticed {{3}}, which makes it harder for anyone trying to reach you.\n\nHappy to send you what I saw so whoever looks after it can sort it. Want me to?",
    footer: "Reply STOP to opt out",
    examples: ["Kwame", "accradental.com", "the phone number isn't tappable on a phone"],
    variables: ["Their first name", "Their website address", "The one thing noticed, as a short clause"],
  },
  {
    label: "Invoice reminder",
    name: "invoice_reminder",
    category: "UTILITY",
    purpose: "INVOICE_REMINDER",
    body:
      "Hi {{1}}, a reminder from Dakyworld that invoice {{2}} for GHS {{3}} is now past its due date. If it's already been paid, please ignore this — it may have crossed with your payment.\n\nYou can settle it here or reply and I'll send the details again.",
    footer: "Dakyworld",
    examples: ["Kwame", "DW-2026-014", "4,500"],
    variables: ["Their first name", "The invoice number", "The amount"],
  },
];
