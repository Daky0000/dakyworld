import type { EmailKind, EmailPurpose, LeadSource, Message, MessageChannel, MessageRoute, MessageThread } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { defaultCallingCode, displayPhone, smsCost, toE164, waLink, type ParsedNumber } from "../lib/phone.js";
import { HubtelError, hubtelSmsConfigured, sendSms } from "../lib/hubtel.js";
import { SERVICE_WINDOW_MS, WhatsAppError, sendTemplate, sendText, whatsappConfigured } from "../lib/whatsapp.js";
import { resolveContext } from "./emailContext.js";
import { fillPlaceholders } from "./emailRender.js";
import { privacyPolicyUrl, shortSourceNotice } from "./dataSourceNotice.js";

/**
 * Sending on the phone channels.
 *
 * Everything that decides whether a WhatsApp or an SMS actually leaves is
 * here, in one place, for the same reason `emailSender.ts` exists: "why did
 * that go out?" and "why didn't that go out?" are the only two questions
 * anybody ever asks of an outbox.
 *
 * It follows `emailSender`'s two disciplines exactly —
 *
 *  - **Suppression is checked at send, not at compose.** Somebody can reply
 *    STOP between a draft being written and its scheduled time; the check that
 *    matters is the last one before the socket opens.
 *  - **Status moves before the network call.** A message goes SENDING first,
 *    so a crash mid-send leaves evidence rather than a message that looks
 *    unsent and gets sent again — to a phone, where a duplicate is far more
 *    intrusive than a duplicate email.
 *
 * — and adds two of its own that email has no equivalent for:
 *
 *  - **The window decides the shape of the message, not just whether it goes.**
 *    Inside 24 hours of their last inbound message, WhatsApp carries whatever
 *    was written. Outside it, only an approved template, with variables. Those
 *    are two different sends and the choice is made here rather than at the
 *    composer, because the window can close between the two.
 *  - **A LINK message is never marked sent by this code.** The whole honesty
 *    of the wa.me path is that the app does not claim credit for a message a
 *    person still has to press send on. It reads READY until somebody says
 *    otherwise — see `markSentByHand`.
 */

export class MessagingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

/**
 * The purposes that carry an opt-out.
 *
 * Same list as email's `COLD_PURPOSES` and for the same reason: a message
 * somebody asked for does not need an unsubscribe line, and one they did not
 * ask for always does. Kept as its own copy rather than imported, because on
 * this channel the rule is stronger — a WhatsApp with no way out is not an
 * unsubscribe problem, it is how a sending number is reported and banned.
 */
const COLD_PURPOSES = new Set<EmailPurpose>(["COLD_OUTREACH", "FOLLOW_UP", "MEETING_REQUEST", "REACTIVATION", "ANNOUNCEMENT"]);

/**
 * The opt-out, appended in code.
 *
 * Never asked of the model, for the reason `emailRender` gives about the
 * unsubscribe footer: a rule that must hold on every single message cannot
 * depend on a writer remembering it. Kept short because on SMS it is billed by
 * the character, and worded as an instruction the recipient can actually
 * follow — `recordInbound` below watches for exactly this word.
 */
const OPT_OUT: Record<MessageChannel, string> = {
  WHATSAPP: "Reply STOP and I won't message again.",
  SMS: "Reply STOP to opt out.",
};

/** The words that mean "never contact me again", in the forms people actually send. */
const STOP_WORDS = /^\s*(stop|stopp?|unsubscribe|opt\s*-?\s*out|optout|cancel|end|quit|remove|no|don'?t|leave me alone)\b/i;

// --- Reachability ----------------------------------------------------------

export interface Reachability {
  email: string | null;
  /** Parsed and normalised, or null when what is on the record is not dialable. */
  phone: ParsedNumber | null;
  /** The best channel to reach this person on, or null when there is none. */
  channel: "EMAIL" | "WHATSAPP" | "SMS" | null;
  /** Why that channel, in a sentence — this is shown next to the button. */
  why: string;
}

/**
 * Which channel to reach somebody on.
 *
 * The order is not a preference, it is a cost and intrusion ranking. Email is
 * free, asynchronous and expected. WhatsApp costs a conversation fee and lands
 * on a phone. An SMS costs money per segment, cannot carry a link that renders,
 * and cannot be replied to conversationally. So each one is only reached for
 * when the one above it is genuinely unavailable — which, for most of this
 * database, it is.
 *
 * **A landline is not "no phone", and the difference matters.** Sending an SMS
 * to a Ghanaian 030 number is money spent on a message that arrives nowhere,
 * and starting a WhatsApp conversation with one is a fee for the same. So a
 * non-mobile number reports as unreachable with a reason rather than being
 * quietly tried.
 */
export async function reachabilityOf(input: { email?: string | null; phone?: string | null }): Promise<Reachability> {
  const email = input.email?.trim() || null;
  const parsed = toE164(input.phone, await defaultCallingCode());

  if (email) {
    return { email, phone: parsed, channel: "EMAIL", why: "They have an email address, which is the cheapest and least intrusive way in." };
  }
  if (!parsed) {
    return {
      email: null,
      phone: null,
      channel: null,
      why: input.phone
        ? `There is no email address, and "${input.phone}" could not be read as a phone number.`
        : "There is no email address and no phone number on this record — there is no way to reach them.",
    };
  }
  if (!parsed.mobile) {
    return {
      email: null,
      phone: parsed,
      channel: null,
      why: `${parsed.display} looks like a landline, so neither a text nor a WhatsApp would arrive. It is a number to call.`,
    };
  }

  const whatsapp = await whatsappConfigured();
  if (whatsapp) {
    return { email: null, phone: parsed, channel: "WHATSAPP", why: "No email address, but a mobile number — and WhatsApp is what a small business here actually reads." };
  }

  const sms = await hubtelSmsConfigured();
  if (sms) {
    return {
      email: null,
      phone: parsed,
      channel: "SMS",
      why: "No email address and WhatsApp isn't connected, so a text is the way in. It costs money per message and cannot be replied to properly — connecting WhatsApp is the better answer.",
    };
  }

  return {
    email: null,
    phone: parsed,
    channel: null,
    why: `${parsed.display} is reachable, but neither WhatsApp nor SMS is connected. Add one under Settings → Messaging, or send it as a wa.me link by hand.`,
  };
}

/** The same question, asked of a lead. */
export async function leadReachability(leadId: string): Promise<Reachability> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { contactEmail: true, contactPhone: true } });
  if (!lead) throw new MessagingError("Lead not found", 404);
  return reachabilityOf({ email: lead.contactEmail, phone: lead.contactPhone });
}

// --- Threads and the window ------------------------------------------------

/**
 * The conversation with one number on one channel, created if it is new.
 *
 * `lead`/`client` are filled on creation and then *only ever filled in*, never
 * changed: a thread that has been attached to a lead stays attached to it, so
 * a second capture of the same business under a new row cannot silently move a
 * conversation somebody has been having.
 */
export async function resolveThread(
  channel: MessageChannel,
  phone: string,
  link: { leadId?: string | null; clientId?: string | null; name?: string | null } = {},
): Promise<MessageThread> {
  const existing = await prisma.messageThread.findUnique({ where: { channel_phone: { channel, phone } } });
  if (existing) {
    const fill: Record<string, unknown> = {};
    if (!existing.leadId && link.leadId) fill.leadId = link.leadId;
    if (!existing.clientId && link.clientId) fill.clientId = link.clientId;
    if (!existing.name && link.name) fill.name = link.name;
    if (Object.keys(fill).length === 0) return existing;
    return prisma.messageThread.update({ where: { id: existing.id }, data: fill });
  }

  return prisma.messageThread.create({
    data: { channel, phone, name: link.name ?? null, leadId: link.leadId ?? null, clientId: link.clientId ?? null },
  });
}

/**
 * Whether WhatsApp will carry a written message to this thread right now.
 *
 * SMS has no such rule and is always open — which is not a licence, it is why
 * SMS is the channel most capable of getting a sender id revoked.
 */
export function windowOpen(thread: Pick<MessageThread, "channel" | "lastInboundAt">, now = new Date()): boolean {
  if (thread.channel !== "WHATSAPP") return true;
  if (!thread.lastInboundAt) return false;
  return now.getTime() - thread.lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

/** How long is left of the free-form window, in minutes. Null when it is shut. */
export function windowRemainingMinutes(thread: Pick<MessageThread, "channel" | "lastInboundAt">, now = new Date()): number | null {
  if (!windowOpen(thread, now) || thread.channel !== "WHATSAPP" || !thread.lastInboundAt) return null;
  return Math.max(0, Math.round((SERVICE_WINDOW_MS - (now.getTime() - thread.lastInboundAt.getTime())) / 60_000));
}

export async function isPhoneSuppressed(phone: string): Promise<string | null> {
  const row = await prisma.messageSuppression.findUnique({ where: { phone } });
  return row ? row.reason : null;
}

export async function suppressPhone(phone: string, reason: string, source = "MANUAL"): Promise<void> {
  await prisma.messageSuppression.upsert({
    where: { phone },
    update: { reason, source },
    create: { phone, reason, source },
  });
}

// --- Composing -------------------------------------------------------------

export interface ComposeArgs {
  channel: MessageChannel;
  purpose: EmailPurpose;
  kind: EmailKind;
  /** Free text. Required unless a template is named. */
  body?: string | null;
  /** Send as an approved WhatsApp template instead of free text. */
  templateName?: string | null;
  templateLanguage?: string | null;
  templateVariables?: string[];
  route?: MessageRoute;
  toPhone?: string | null;
  toName?: string | null;
  leadId?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  proposalId?: string | null;
  invoiceId?: string | null;
  carePlanId?: string | null;
  createdById?: string | null;
  scheduledFor?: Date | null;
  status?: Message["status"];
}

/**
 * Builds a sendable message from written content or from a template.
 *
 * One path, used by the composer, by the agents and by the automations — so a
 * message an agent prepared and one a person typed are rendered, normalised
 * and suppression-checked by exactly the same code.
 */
export async function composeMessage(args: ComposeArgs): Promise<Message> {
  const context = await resolveContext({
    leadId: args.leadId,
    clientId: args.clientId,
    toPhone: args.toPhone,
    toName: args.toName,
  });

  const raw = args.toPhone ?? context.phone ?? null;
  const parsed = toE164(raw, await defaultCallingCode());
  if (!parsed) {
    throw new MessagingError(
      raw
        ? `"${raw}" is not a phone number this can send to. Check it on the record, or type it in full with the country code.`
        : "No phone number on file for this recipient — add one, or type a number.",
      400,
    );
  }
  if (!parsed.mobile) {
    throw new MessagingError(`${parsed.display} looks like a landline. Neither a text nor a WhatsApp would arrive there.`, 400);
  }

  const thread = await resolveThread(args.channel, parsed.e164, {
    leadId: args.leadId,
    clientId: args.clientId,
    name: args.toName ?? context.name,
  });

  const body = await renderBody(args, context.variables, thread);

  return prisma.message.create({
    data: {
      channel: args.channel,
      direction: "OUTBOUND",
      route: args.route ?? "API",
      status: args.status ?? (args.scheduledFor ? "SCHEDULED" : "DRAFT"),
      toPhone: parsed.e164,
      toName: args.toName ?? context.name,
      body,
      kind: args.kind,
      purpose: args.purpose,
      templateName: args.templateName ?? null,
      templateLanguage: args.templateName ? (args.templateLanguage ?? "en") : null,
      templateVariables: args.templateVariables ?? [],
      segments: args.channel === "SMS" ? smsCost(body).segments : null,
      scheduledFor: args.scheduledFor ?? null,
      threadId: thread.id,
      leadId: args.leadId ?? null,
      clientId: args.clientId ?? null,
      projectId: args.projectId ?? null,
      proposalId: args.proposalId ?? null,
      invoiceId: args.invoiceId ?? null,
      carePlanId: args.carePlanId ?? null,
      createdById: args.createdById ?? null,
    },
  });
}

/**
 * The words as the recipient will see them.
 *
 * **A template body is never modified**, which is the one rule here that is
 * not a style choice: Meta approved an exact string, and appending an opt-out
 * line to it would send something it did not approve. Templates carry their
 * own opt-out wording, which is why `whatsappTemplates.ts` puts one in every
 * marketing template it proposes.
 */
async function renderBody(args: ComposeArgs, variables: Record<string, string>, thread: MessageThread): Promise<string> {
  if (args.templateName) {
    const template = await prisma.whatsAppTemplate.findFirst({
      where: { name: args.templateName, language: args.templateLanguage ?? "en" },
    });
    if (!template) {
      throw new MessagingError(`No template called "${args.templateName}" is synced. Sync the template list under Settings → Messaging.`, 404);
    }
    if (template.status !== "APPROVED") {
      throw new MessagingError(
        `The template "${template.name}" is ${template.status.toLowerCase()}, not approved, so WhatsApp will not deliver it.${
          template.rejectionReason ? ` Meta's reason: ${template.rejectionReason}` : ""
        }`,
        409,
      );
    }
    const values = args.templateVariables ?? [];
    if (values.length !== template.variableCount) {
      throw new MessagingError(
        `"${template.name}" takes ${template.variableCount} variable${template.variableCount === 1 ? "" : "s"} and ${values.length} ${
          values.length === 1 ? "was" : "were"
        } supplied. WhatsApp refuses a mismatch outright.`,
        400,
      );
    }
    // Stored as the recipient will read it, so the outbox is legible. What is
    // actually sent is the name plus the variables — see `sendPhoneMessage`.
    return values.reduce((text, value, index) => text.replaceAll(`{{${index + 1}}}`, value), template.body);
  }

  const written = args.body?.trim();
  if (!written) throw new MessagingError("There is nothing to send — write a message, or pick a template.", 400);

  // The same `{{placeholder}}` vocabulary as the email templates, filled from
  // the recipient's own record. One vocabulary across all three channels.
  let body = fillPlaceholders(written, variables);

  if (COLD_PURPOSES.has(args.purpose) && !STOP_WORDS.test(body) && !/\bstop\b/i.test(body)) {
    body = `${body}\n\n${OPT_OUT[args.channel]}`;
  }

  // Where we found them — Art 14(2)(f) GDPR, and s.18 of Ghana's Act 843, both
  // of which require telling somebody the source of data that did not come
  // from them.
  //
  // **Only on the first message, unlike the email footer.** Art 14(3)(b) sets
  // the obligation at "the first communication", and here that distinction is
  // worth making: the notice is about a hundred characters, and on a
  // 160-character SMS segment that is a second segment bought on every message
  // of a sequence to repeat something already said. The email footer repeats it
  // because a footer costs nothing.
  //
  // A template carries none of this, and that is not a shortcut — see the note
  // on renderBody. Meta approved an exact string, so appending to it would send
  // something it did not approve. A cold WhatsApp template has to carry the
  // notice inside the wording Meta approved; whatsappTemplates.ts is where that
  // belongs, exactly as the opt-out already does.
  if (COLD_PURPOSES.has(args.purpose) && (await isFirstOutbound(thread.id))) {
    const notice = shortSourceNotice({
      source: await leadSourceFor(args.leadId),
      privacyUrl: await privacyPolicyUrl(),
    });
    if (!body.includes(notice)) body = `${body}\n\n${notice}`;
  }

  // A written WhatsApp is capped by Meta at 4096; Hubtel truncates a text at
  // 1000. Both are cut here rather than at the provider, so what is stored is
  // what was sent — an outbox showing words the recipient never received is
  // worse than no outbox.
  const limit = args.channel === "WHATSAPP" ? 4096 : 1000;
  if (body.length > limit) body = `${body.slice(0, limit - 1)}…`;

  return body;
}

/**
 * Whether anything has actually gone out on this thread before.
 *
 * OUTBOUND rows only, and only ones that really went: an inbound message means
 * they wrote to *us*, at which point Art 13 takes over from Art 14, and a draft
 * that was written and discarded told nobody anything. Counting a draft would
 * mean a message composed, deleted and composed again silently loses the
 * notice — and erring towards telling somebody twice is the safe direction
 * here, where erring the other way is the omission this exists to prevent.
 */
async function isFirstOutbound(threadId: string): Promise<boolean> {
  const alreadySent = await prisma.message.count({
    where: { threadId, direction: "OUTBOUND", status: { in: ["SENT", "DELIVERED", "READ"] } },
  });
  return alreadySent === 0;
}

/**
 * The lead's recorded source, or null when there is no lead behind the number.
 *
 * Null is a real answer rather than a failure: `shortSourceNotice` turns it
 * into an honest general phrase, which is the right thing to say about a number
 * somebody typed in by hand.
 */
async function leadSourceFor(leadId: string | null | undefined): Promise<LeadSource | null> {
  if (!leadId) return null;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { source: true } });
  return lead?.source ?? null;
}

// --- Sending ---------------------------------------------------------------

export interface SendResult {
  sent: boolean;
  reason?: string;
  providerMessageId?: string;
  /** Set on the LINK route: where a person goes to send it by hand. */
  link?: string;
}

/**
 * Sends one stored message.
 *
 * Safe to call twice: a message already SENT returns without doing anything,
 * which is what makes the scheduler and the Send button unable to collide.
 */
export async function sendPhoneMessage(id: string): Promise<SendResult> {
  const message = await prisma.message.findUnique({ where: { id }, include: { thread: true } });
  if (!message) throw new MessagingError("Message not found", 404);
  if (message.direction === "INBOUND") throw new MessagingError("That is a message we received, not one to send.", 400);
  if (message.status === "SENT" || message.status === "DELIVERED" || message.status === "READ") {
    return { sent: false, reason: "already-sent", providerMessageId: message.providerMessageId ?? undefined };
  }
  if (message.status === "SENDING") return { sent: false, reason: "in-flight" };
  if (message.status === "CANCELLED") return { sent: false, reason: "cancelled" };

  const suppressed = await isPhoneSuppressed(message.toPhone);
  if (suppressed) {
    await prisma.message.update({
      where: { id },
      data: { status: "CANCELLED", error: `Not sent — ${displayPhone(message.toPhone)} has opted out (${suppressed}).` },
    });
    return { sent: false, reason: "suppressed" };
  }

  // The wa.me path. Nothing is sent and nothing pretends to have been: the
  // message is made ready and a person presses send from their own WhatsApp.
  if (message.route === "LINK") {
    const link = waLink(message.toPhone, message.body);
    if (message.status !== "READY") await prisma.message.update({ where: { id }, data: { status: "READY", error: null } });
    return { sent: false, reason: "hand-off", link };
  }

  // Claim it before the network call, so a crash leaves a SENDING row to
  // investigate rather than a DRAFT that looks safe to send again.
  await prisma.message.update({ where: { id }, data: { status: "SENDING", attempts: { increment: 1 } } });

  try {
    const result =
      message.channel === "WHATSAPP" ? await sendOnWhatsApp(message) : await sendOnSms(message);

    await prisma.message.update({
      where: { id },
      data: { status: "SENT", sentAt: new Date(), provider: result.provider, providerMessageId: result.id, error: null },
    });
    await prisma.messageThread.update({ where: { id: message.threadId }, data: { lastOutboundAt: new Date() } });
    await logCommunication(message);
    return { sent: true, providerMessageId: result.id ?? undefined };
  } catch (err) {
    const reason =
      err instanceof WhatsAppError || err instanceof HubtelError || err instanceof MessagingError
        ? err.message
        : (err as Error).message;
    await prisma.message.update({ where: { id }, data: { status: "FAILED", failedAt: new Date(), error: reason } });
    return { sent: false, reason };
  }
}

async function sendOnWhatsApp(message: Message & { thread: MessageThread }): Promise<{ id: string | null; provider: string }> {
  // The window is re-read here rather than trusted from the composer, because
  // 24 hours is long enough for it to have closed since the draft was written
  // — and the failure is a hard 131047 at the moment of sending to a real
  // prospect, not something the outbox would show afterwards.
  const open = windowOpen(message.thread);

  if (message.templateName) {
    const sent = await sendTemplate({
      to: message.toPhone,
      name: message.templateName,
      language: message.templateLanguage ?? "en",
      variables: message.templateVariables,
    });
    return { id: sent.id, provider: "meta" };
  }

  if (!open) {
    throw new MessagingError(
      `${displayPhone(message.toPhone)} hasn't messaged us in the last 24 hours, so WhatsApp will only carry an approved template — not a written message. Pick a template, or send this one as a wa.me link instead.`,
      409,
    );
  }

  const sent = await sendText(message.toPhone, message.body);
  return { id: sent.id, provider: "meta" };
}

async function sendOnSms(message: Message): Promise<{ id: string | null; provider: string }> {
  const sent = await sendSms(message.toPhone, message.body);
  return { id: sent.messageId, provider: "hubtel" };
}

/**
 * Records that a person sent a LINK message from their own WhatsApp.
 *
 * Deliberately a separate, explicit action rather than something the Copy
 * Link button does on the way past. Copying a link is not sending a message —
 * people copy one and get distracted — and an outbox that marks messages sent
 * on the strength of a click is an outbox nobody can trust about anything.
 */
export async function markSentByHand(id: string, userId?: string | null): Promise<Message> {
  const message = await prisma.message.findUnique({ where: { id }, include: { thread: true } });
  if (!message) throw new MessagingError("Message not found", 404);
  if (message.route !== "LINK") throw new MessagingError("That message was sent by the app, so it doesn't need marking by hand.", 400);
  if (message.status === "SENT") return message;

  const updated = await prisma.message.update({
    where: { id },
    data: { status: "SENT", sentAt: new Date(), provider: "manual", createdById: message.createdById ?? userId ?? null },
  });
  await prisma.messageThread.update({ where: { id: message.threadId }, data: { lastOutboundAt: new Date() } });
  await logCommunication(message);
  return updated;
}

/**
 * A sent message is a contact, and the lead's own history is where anybody
 * looks for "when did we last speak to them" — so it is written there too
 * rather than living only in this module's outbox.
 */
async function logCommunication(message: Message) {
  if (!message.leadId && !message.clientId && !message.projectId) return;
  await prisma.communication.create({
    data: {
      type: "MESSAGE",
      summary: `${message.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}: ${message.body.slice(0, 140)}${message.body.length > 140 ? "…" : ""}`,
      outcome: `Sent to ${displayPhone(message.toPhone)}`,
      occurredAt: new Date(),
      leadId: message.leadId,
      clientId: message.clientId,
      projectId: message.projectId,
      loggedById: message.createdById,
    },
  });
}

/** The scheduler's half: anything scheduled whose time has come. */
export async function dispatchDueMessages(now = new Date()): Promise<number> {
  const due = await prisma.message.findMany({
    where: { status: "SCHEDULED", direction: "OUTBOUND", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: 25,
    select: { id: true },
  });
  if (due.length === 0) return 0;

  let sent = 0;
  for (const message of due) {
    const result = await sendPhoneMessage(message.id);
    if (result.sent) sent += 1;
  }
  if (sent > 0) console.log(`[messaging] sent ${sent} scheduled message(s)`);
  return sent;
}

// --- Inbound ---------------------------------------------------------------

export interface InboundResult {
  message: Message;
  /** True when this reply opted them out. */
  optedOut: boolean;
  /** The thread it landed in, after the window was reopened. */
  thread: MessageThread;
}

/**
 * Files a reply.
 *
 * Three things happen and all three matter:
 *
 *  1. **The window reopens.** `lastInboundAt` is the only thing that decides
 *     whether a written WhatsApp can be sent, so this write is what turns a
 *     template-only conversation into an ordinary one for the next 24 hours.
 *  2. **STOP is honoured immediately and across both channels.** Somebody who
 *     says stop on WhatsApp has not asked to keep getting texts. See
 *     `MessageSuppression` — it is keyed on the number, not the channel.
 *  3. **A reply stops any email sequence they are in.** A prospect who answered
 *     on WhatsApp has answered. A day-3 follow-up email arriving after that is
 *     the single most obvious way to look like software.
 */
export async function recordInbound(input: {
  channel: MessageChannel;
  from: string;
  text: string | null;
  providerMessageId?: string | null;
  name?: string | null;
  at?: Date;
}): Promise<InboundResult> {
  const parsed = toE164(`+${input.from.replace(/\D/g, "")}`);
  const phone = parsed?.e164 ?? input.from.replace(/\D/g, "");
  const at = input.at ?? new Date();

  // Attach it to whoever it is. A number that matches a lead is the common
  // case — it is the number we wrote to — but a reply from a number nobody has
  // ever recorded is a real inbound enquiry and must not be dropped.
  const existing = await prisma.messageThread.findUnique({ where: { channel_phone: { channel: input.channel, phone } } });
  const lead = existing?.leadId ? null : await findLeadByPhone(phone);

  const thread = await resolveThread(input.channel, phone, {
    leadId: existing?.leadId ?? lead?.id ?? null,
    name: existing?.name ?? input.name ?? lead?.contactName ?? null,
  });

  const text = input.text?.trim() ?? "";
  const message = await prisma.message.create({
    data: {
      channel: input.channel,
      direction: "INBOUND",
      status: "DELIVERED",
      route: "API",
      toPhone: phone,
      toName: thread.name,
      body: text || "(no text — a photo, a voice note or an attachment)",
      kind: "MANUAL",
      purpose: "CUSTOM",
      provider: input.channel === "WHATSAPP" ? "meta" : "hubtel",
      providerMessageId: input.providerMessageId ?? null,
      sentAt: at,
      threadId: thread.id,
      leadId: thread.leadId,
      clientId: thread.clientId,
    },
  });

  const updated = await prisma.messageThread.update({
    where: { id: thread.id },
    data: {
      lastInboundAt: at,
      lastInboundText: text.slice(0, 500) || null,
      unreadCount: { increment: 1 },
      name: thread.name ?? input.name ?? null,
    },
  });

  const optedOut = STOP_WORDS.test(text);
  if (optedOut) {
    await suppressPhone(phone, `Replied "${text.slice(0, 60)}" on ${input.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}`, "STOPPED");
    // Everything queued for them, on either channel, is pulled. An opt-out
    // that only stops the next message is not an opt-out.
    await prisma.message.updateMany({
      where: { toPhone: phone, direction: "OUTBOUND", status: { in: ["DRAFT", "SCHEDULED", "READY"] } },
      data: { status: "CANCELLED", error: "Cancelled — they asked not to be contacted again." },
    });
  }

  await stopSequencesFor(thread, text, optedOut);

  if (thread.leadId || thread.clientId) {
    await prisma.communication.create({
      data: {
        type: "MESSAGE",
        summary: `Reply on ${input.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}: ${text.slice(0, 140) || "(no text)"}`,
        outcome: optedOut ? "They asked not to be contacted again" : "Awaiting a response from us",
        occurredAt: at,
        leadId: thread.leadId,
        clientId: thread.clientId,
      },
    });
  }

  return { message, optedOut, thread: updated };
}

/** A lead whose recorded number normalises to this one. */
async function findLeadByPhone(phone: string): Promise<{ id: string; contactName: string } | null> {
  // Stored numbers are whatever a scrape or a person wrote, so the match cannot
  // be done in SQL. The last nine digits are the discriminating part of every
  // number this app deals with, which narrows it to a handful to parse.
  const tail = phone.slice(-9);
  const candidates = await prisma.lead.findMany({
    where: { contactPhone: { contains: tail } },
    select: { id: true, contactName: true, contactPhone: true },
    take: 25,
  });
  const code = await defaultCallingCode();
  for (const candidate of candidates) {
    if (toE164(candidate.contactPhone, code)?.e164 === phone) return { id: candidate.id, contactName: candidate.contactName };
  }
  return null;
}

/**
 * A reply on any channel stops the email sequences too.
 *
 * The cross-channel half is the point. `emailSequences.stopOnReply` is keyed
 * on an email address; a lead reached by WhatsApp because they have no email
 * has none, so their reply could never have stopped anything. This closes it
 * by the record rather than by the address.
 */
async function stopSequencesFor(thread: MessageThread, text: string, optedOut: boolean) {
  if (!thread.leadId && !thread.clientId) return;

  const reason = optedOut
    ? "They asked not to be contacted again."
    : `They replied on ${thread.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}${text ? `: "${text.slice(0, 80)}"` : ""}`;

  await prisma.emailEnrollment.updateMany({
    where: {
      status: "ACTIVE",
      ...(thread.leadId ? { leadId: thread.leadId } : { clientId: thread.clientId }),
    },
    data: { status: "STOPPED", stopReason: reason, completedAt: new Date() },
  });
}

/**
 * A delivery receipt from the provider.
 *
 * Only ever moves a message *forward* — sent → delivered → read. Receipts
 * arrive out of order often enough that treating them as authoritative would
 * show a message as merely sent after somebody had already read it.
 */
export async function applyDeliveryStatus(input: {
  providerMessageId: string;
  status: string;
  at?: Date;
  error?: string | null;
}): Promise<Message | null> {
  const message = await prisma.message.findFirst({ where: { providerMessageId: input.providerMessageId } });
  if (!message) return null;

  const at = input.at ?? new Date();
  const rank: Record<string, number> = { DRAFT: 0, SCHEDULED: 0, READY: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4 };

  switch (input.status.toLowerCase()) {
    case "delivered":
      if ((rank[message.status] ?? 0) >= 3) return message;
      return prisma.message.update({ where: { id: message.id }, data: { status: "DELIVERED", deliveredAt: at } });
    case "read":
      return prisma.message.update({
        where: { id: message.id },
        data: { status: "READ", readAt: at, deliveredAt: message.deliveredAt ?? at },
      });
    case "sent":
      if ((rank[message.status] ?? 0) >= 2) return message;
      return prisma.message.update({ where: { id: message.id }, data: { status: "SENT", sentAt: message.sentAt ?? at } });
    case "failed":
    case "undelivered":
      return prisma.message.update({
        where: { id: message.id },
        data: { status: "FAILED", failedAt: at, error: input.error ?? "The provider could not deliver it." },
      });
    default:
      return message;
  }
}
