import { createHmac, timingSafeEqual } from "node:crypto";
import { SETTING, getSetting } from "./settings.js";

/**
 * WhatsApp, through Meta's Cloud API.
 *
 * **Read this before writing anything that sends.** WhatsApp is not email with
 * a different address field, and treating it as one produces a module that
 * typechecks and delivers nothing.
 *
 * ## The rule that shapes everything
 *
 * A business may send whatever it likes to a person **for 24 hours after that
 * person's last message to it**, and outside that window may send only a
 * template Meta approved in advance. There is no third option. A cold approach
 * — the whole reason this module exists, since a scraped lead has never
 * written to us — is therefore *always* a template, and always in the
 * MARKETING category, which is the one Meta prices highest and polices
 * hardest.
 *
 * So the composer cannot simply write a message. It writes a template, submits
 * it, waits (minutes to a day), and then sends it with variables filled in.
 * That latency is not a bug in this code and cannot be engineered away.
 *
 * ## Which is why `wa.me` is a first-class path and not a fallback
 *
 * A link that opens the founder's own WhatsApp with the message typed in needs
 * no Business account, no template review and no per-conversation fee, and it
 * arrives from a person rather than from a brand — which is what a small
 * business owner in Accra actually replies to. See `waLink` in lib/phone.ts.
 * The API path here is what makes that scale later; it is not what makes the
 * first hundred messages possible.
 *
 * ## What this file will and will not do
 *
 * It talks to Meta and nothing else: no database, no policy, no deciding
 * whether a message *should* go. That is services/messageSender.ts, which is
 * where suppression, the window check and the audit trail live.
 */

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";
const GRAPH_BASE = process.env.WHATSAPP_BASE_URL ?? "https://graph.facebook.com";

/** How long the free-form window stays open after their last inbound message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    /** Meta's own numeric code, when there was one. See `explain`. */
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }
}

export async function whatsappConfigured(): Promise<boolean> {
  const [token, phoneId] = await Promise.all([getSetting(SETTING.WHATSAPP_TOKEN), getSetting(SETTING.WHATSAPP_PHONE_NUMBER_ID)]);
  return Boolean(token && phoneId);
}

/** Templates need the WhatsApp Business Account id as well as the sending number. */
export async function whatsappTemplatesConfigured(): Promise<boolean> {
  const [ready, waba] = await Promise.all([whatsappConfigured(), getSetting(SETTING.WHATSAPP_BUSINESS_ID)]);
  return Boolean(ready && waba);
}

async function credentials(): Promise<{ token: string; phoneId: string }> {
  const [token, phoneId] = await Promise.all([getSetting(SETTING.WHATSAPP_TOKEN), getSetting(SETTING.WHATSAPP_PHONE_NUMBER_ID)]);
  if (!token || !phoneId) {
    throw new WhatsAppError("WhatsApp isn't connected. Add the access token and phone number ID under Settings → Messaging.", 503);
  }
  return { token, phoneId };
}

async function wabaId(): Promise<string> {
  const id = await getSetting(SETTING.WHATSAPP_BUSINESS_ID);
  if (!id) throw new WhatsAppError("No WhatsApp Business Account ID is set, so templates can't be read. Add it under Settings → Messaging.", 503);
  return id;
}

/**
 * Meta's errors in plain words.
 *
 * This mapping is the most useful thing in the file. The Graph API answers a
 * refused send with a numeric code and a sentence written for a Facebook
 * platform engineer — "(#131047) Re-engagement message" — and every one of
 * them has a completely different fix, several of which are not code at all.
 * Passing the raw text through means the Owner reads a number and goes looking
 * for a bug in this app, when the answer was "they have not written to you in
 * a day, so send a template".
 */
function explain(code: number | null, subcode: number | null, fallback: string): string {
  switch (code) {
    case 131047:
      return "They haven't messaged us in the last 24 hours, so WhatsApp will only carry an approved template to them — not a written message. Pick a template, or send this one as a wa.me link instead.";
    case 131026:
      return "WhatsApp can't deliver to that number. It usually means the number has no WhatsApp account, or it's a landline.";
    case 131051:
      return "That message type isn't supported on this account.";
    case 132000:
      return "The template was sent the wrong number of variables. Check how many {{1}} placeholders it has against what was filled in.";
    case 132001:
      return "No approved template with that name and language exists on this account. Sync the template list, and check the language code — Meta matches on name and language together.";
    case 132005:
      return "Meta rejected the variable values: a template variable can't be empty, can't contain a newline, and can't be more than four times the length of the rest of the template.";
    case 132007:
      return "That template is paused or disabled because of how recipients reacted to it. Meta pauses a template that gets blocked or reported; it has to be edited and resubmitted.";
    case 133010:
      return "This phone number isn't registered for the Cloud API yet. Finish registration in the Meta dashboard before sending.";
    case 131031:
      return "The WhatsApp Business account is restricted or has been disabled. Check the account's status in the Meta Business Suite — this is not something the app can retry past.";
    case 131056:
      return "Too many messages to that same number in a short window. Meta is pacing us; try again shortly.";
    case 190:
      return "The WhatsApp access token has expired or been revoked. Generate a new permanent token for the system user and paste it under Settings → Messaging.";
    case 200:
    case 10:
      return "The access token doesn't carry the permissions this needs (whatsapp_business_messaging, and whatsapp_business_management for templates).";
    case 4:
    case 80007:
      return "Meta is rate-limiting this account. Nothing is wrong with the message; it has to wait.";
    case 100:
      return subcode === 33
        ? "Meta doesn't recognise that phone number ID or business account ID. Check both under Settings → Messaging."
        : `Meta refused that request as malformed: ${fallback}`;
    default:
      return fallback;
  }
}

async function graph<T>(path: string, init: { method?: string; body?: unknown; token: string }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${init.token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new WhatsAppError(`Could not reach WhatsApp: ${(err as Error).message}`);
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new WhatsAppError(`WhatsApp answered ${response.status} with something that wasn't JSON.`);
  }

  const error = (parsed as { error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } } } | null)?.error;
  if (error || !response.ok) {
    const code = typeof error?.code === "number" ? error.code : null;
    // `error_data.details` is nearly always more specific than `message` — it
    // is where "expected 2 parameters, got 1" actually lives.
    const raw = error?.error_data?.details || error?.message || `WhatsApp answered ${response.status}.`;
    throw new WhatsAppError(explain(code, error?.error_subcode ?? null, raw), response.status === 401 ? 401 : 502, code);
  }

  return parsed as T;
}

// --- Sending ---------------------------------------------------------------

export interface SentMessage {
  /** Meta's `wamid.…`, which every delivery receipt quotes back. */
  id: string;
  /** The number Meta actually resolved it to. Not always what was asked for. */
  waId: string | null;
}

function readSendResult(data: { messages?: { id?: string }[]; contacts?: { wa_id?: string }[] }, to: string): SentMessage {
  const id = data.messages?.[0]?.id;
  if (!id) throw new WhatsAppError("WhatsApp accepted the request but returned no message id, so there is nothing to track it by.");
  return { id, waId: data.contacts?.[0]?.wa_id ?? to };
}

/**
 * A written message. **Only valid inside the 24-hour window** — outside it
 * Meta answers 131047 and nothing is delivered. The caller is expected to have
 * checked; this does not, because the only honest check is against the thread
 * in the database and this file has no database.
 */
export async function sendText(to: string, body: string, previewUrl = false): Promise<SentMessage> {
  const { token, phoneId } = await credentials();
  const data = await graph<{ messages?: { id?: string }[]; contacts?: { wa_id?: string }[] }>(`/${phoneId}/messages`, {
    method: "POST",
    token,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      // Off by default. A link preview in a first message to a stranger makes
      // it look like an ad, which is exactly what it must not look like.
      text: { body: body.slice(0, 4096), preview_url: previewUrl },
    },
  });
  return readSendResult(data, to);
}

/**
 * An approved template, with its `{{1}}`-style variables filled in.
 *
 * The variable values are positional and Meta is strict about them: the count
 * must match the template exactly, none may be empty, and none may contain a
 * newline or a tab. Those three refusals all arrive as 132000/132005 and are
 * translated above.
 */
export async function sendTemplate(input: {
  to: string;
  name: string;
  language: string;
  variables?: string[];
}): Promise<SentMessage> {
  const { token, phoneId } = await credentials();
  const variables = input.variables ?? [];

  const data = await graph<{ messages?: { id?: string }[]; contacts?: { wa_id?: string }[] }>(`/${phoneId}/messages`, {
    method: "POST",
    token,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template: {
        name: input.name,
        language: { code: input.language },
        // A template with no variables must send no components at all — an
        // empty parameters array is itself a 132000.
        components: variables.length
          ? [{ type: "body", parameters: variables.map((value) => ({ type: "text", text: value })) }]
          : undefined,
      },
    },
  });
  return readSendResult(data, input.to);
}

/**
 * Marks their message read — the blue ticks.
 *
 * Worth doing, and not only manners: an unread conversation on their side that
 * never shows as read is a business that looks absent, and the whole argument
 * for reaching people this way is that it does not.
 */
export async function markRead(messageId: string): Promise<void> {
  const { token, phoneId } = await credentials();
  await graph(`/${phoneId}/messages`, {
    method: "POST",
    token,
    body: { messaging_product: "whatsapp", status: "read", message_id: messageId },
  });
}

// --- Templates -------------------------------------------------------------

export interface MetaTemplate {
  metaId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectionReason: string | null;
  body: string;
  header: string | null;
  footer: string | null;
  buttons: { type: string; text?: string; url?: string }[];
  variableCount: number;
}

interface TemplateComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: { type?: string; text?: string; url?: string }[];
}

/** How many distinct `{{n}}` a body carries. Sending a different count is a hard error. */
export function countVariables(body: string): number {
  const seen = new Set<number>();
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) seen.add(Number(match[1]));
  return seen.size;
}

function readTemplate(row: {
  id?: string;
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  rejected_reason?: string;
  components?: TemplateComponent[];
}): MetaTemplate {
  const components = row.components ?? [];
  const body = components.find((component) => component.type === "BODY")?.text ?? "";
  const header = components.find((component) => component.type === "HEADER");
  const footer = components.find((component) => component.type === "FOOTER");
  const buttons = components.find((component) => component.type === "BUTTONS")?.buttons ?? [];

  return {
    metaId: row.id ?? null,
    name: row.name ?? "",
    language: row.language ?? "en",
    category: row.category ?? "MARKETING",
    status: row.status ?? "PENDING",
    // Meta sends "NONE" rather than omitting it when a template was not rejected.
    rejectionReason: row.rejected_reason && row.rejected_reason !== "NONE" ? row.rejected_reason : null,
    body,
    // A media header has a format and no text; only a text header is usable here.
    header: header?.format === "TEXT" ? (header.text ?? null) : null,
    footer: footer?.text ?? null,
    buttons: buttons.map((button) => ({ type: button.type ?? "QUICK_REPLY", text: button.text, url: button.url })),
    variableCount: countVariables(body),
  };
}

/**
 * Every template on the account, paged through.
 *
 * Paged rather than taking the first hundred because the status is the point:
 * a template that has been paused sits wherever Meta puts it in the list, and
 * a sync that quietly stops at page one leaves this app believing an unusable
 * template is fine.
 */
export async function listTemplates(): Promise<MetaTemplate[]> {
  const { token } = await credentials();
  const waba = await wabaId();

  const templates: MetaTemplate[] = [];
  let path: string | null =
    `/${waba}/message_templates?limit=50&fields=id,name,language,category,status,rejected_reason,components`;

  // A cap rather than `while (true)`: a paging cursor that never terminates is
  // a hang inside a request somebody is waiting on.
  for (let page = 0; page < 20 && path; page += 1) {
    const data: { data?: unknown[]; paging?: { next?: string } } = await graph(path, { token });
    for (const row of data.data ?? []) templates.push(readTemplate(row as never));

    const next = data.paging?.next;
    // Meta returns an absolute URL for the next page; strip the base and the
    // version back off so `graph` can prepend its own.
    path = next ? next.replace(`${GRAPH_BASE}/${GRAPH_VERSION}`, "").replace(/^https?:\/\/[^/]+\/v\d+\.\d+/, "") : null;
  }
  return templates;
}

/**
 * Submits a template for approval.
 *
 * Meta reviews it — usually minutes, occasionally a day — and nothing can be
 * sent with it until that comes back APPROVED. The name has to be lower-case
 * with underscores, and is permanent: a template is edited by submitting a new
 * one, and the old name stays taken.
 */
export async function createTemplate(input: {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  body: string;
  header?: string | null;
  footer?: string | null;
  /** Example values for each `{{n}}`, in order. Meta rejects a variable template without them. */
  examples?: string[];
}): Promise<{ metaId: string | null; status: string }> {
  const { token } = await credentials();
  const waba = await wabaId();

  const components: Record<string, unknown>[] = [];
  if (input.header?.trim()) components.push({ type: "HEADER", format: "TEXT", text: input.header.trim() });

  const variables = countVariables(input.body);
  const body: Record<string, unknown> = { type: "BODY", text: input.body };
  if (variables > 0) {
    // Meta refuses a template with placeholders and no worked example — it is
    // how the reviewer sees what the message actually reads like. Filling in a
    // blank here is not optional and the refusal does not say so clearly.
    const examples = Array.from({ length: variables }, (_, index) => input.examples?.[index]?.trim() || `Example ${index + 1}`);
    body.example = { body_text: [examples] };
  }
  components.push(body);

  if (input.footer?.trim()) components.push({ type: "FOOTER", text: input.footer.trim() });

  const data = await graph<{ id?: string; status?: string }>(`/${waba}/message_templates`, {
    method: "POST",
    token,
    body: { name: input.name, language: input.language, category: input.category, components },
  });
  return { metaId: data.id ?? null, status: data.status ?? "PENDING" };
}

/** Removes a template from the account. Meta deletes every language of that name. */
export async function deleteTemplate(name: string): Promise<void> {
  const { token } = await credentials();
  const waba = await wabaId();
  await graph(`/${waba}/message_templates?name=${encodeURIComponent(name)}`, { method: "DELETE", token });
}

// --- The account itself ----------------------------------------------------

export interface WhatsAppNumber {
  displayNumber: string | null;
  verifiedName: string | null;
  /** GREEN, YELLOW, RED — Meta's read on how recipients are reacting to us. */
  qualityRating: string | null;
  /** How many business-initiated conversations a day this number may start. */
  messagingLimit: string | null;
}

/**
 * What Meta thinks of the sending number.
 *
 * `qualityRating` is the number worth watching and there is nowhere else to
 * see it: it falls when recipients block or report, and a number that reaches
 * RED has its sending limit cut and then loses the ability to start
 * conversations at all. For cold outreach that is the single most consequential
 * piece of feedback in the system, so it is surfaced on the Settings screen
 * rather than left in a dashboard nobody opens.
 */
export async function describeNumber(): Promise<WhatsAppNumber> {
  const { token, phoneId } = await credentials();
  const data = await graph<{
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    messaging_limit_tier?: string;
  }>(`/${phoneId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`, { token });

  return {
    displayNumber: data.display_phone_number ?? null,
    verifiedName: data.verified_name ?? null,
    qualityRating: data.quality_rating ?? null,
    messagingLimit: data.messaging_limit_tier ?? null,
  };
}

/** Confirms a token and phone number ID work together, before either is stored. */
export async function verifyWhatsAppKeys(token: string, phoneId: string): Promise<WhatsAppNumber> {
  const data = await graph<{
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    messaging_limit_tier?: string;
  }>(`/${phoneId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`, { token });

  return {
    displayNumber: data.display_phone_number ?? null,
    verifiedName: data.verified_name ?? null,
    qualityRating: data.quality_rating ?? null,
    messagingLimit: data.messaging_limit_tier ?? null,
  };
}

// --- Inbound ---------------------------------------------------------------

/**
 * Meta signs every webhook delivery with the **app secret**, over the exact
 * bytes it sent. Same discipline as Stripe and Slack: the router is mounted
 * above the JSON parser, and this is handed the raw buffer.
 *
 * With no app secret configured this returns false and the intake stores the
 * event without acting on it. That is the deliberate choice — an unverified
 * inbound message that could open a 24-hour free-form window, or opt somebody
 * out, is a way to make this app send to a stranger or stop sending to a real
 * prospect, and neither should be available to anyone who can guess the URL.
 */
export async function verifyWebhookSignature(header: string | undefined, raw: Buffer | string): Promise<boolean> {
  const secret = await getSetting(SETTING.WHATSAPP_APP_SECRET);
  if (!secret || !header) return false;

  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  // timingSafeEqual throws on a length mismatch rather than returning false,
  // and a truncated header is exactly the shape of a probe.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The GET handshake Meta performs once when the webhook URL is saved. */
export async function verifyTokenMatches(token: string | undefined): Promise<boolean> {
  const expected = await getSetting(SETTING.WHATSAPP_VERIFY_TOKEN);
  return Boolean(expected && token && expected === token);
}

export interface InboundMessage {
  /** Meta's id for their message — what `markRead` takes. */
  id: string;
  from: string;
  /** Their WhatsApp profile name. Often the only name we ever learn. */
  profileName: string | null;
  timestamp: Date;
  /** "text", "image", "button", "interactive", "audio"… */
  type: string;
  /** The words, where there were any. A photo with no caption has none. */
  text: string | null;
}

export interface StatusUpdate {
  messageId: string;
  /** sent · delivered · read · failed */
  status: string;
  timestamp: Date;
  recipient: string | null;
  error: string | null;
}

export interface WebhookPayload {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

function readTimestamp(value: unknown): Date {
  // Meta sends unix seconds as a string. A missing or unparseable one becomes
  // now rather than 1970, because the window maths keys off it.
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/**
 * Pulls the parts worth acting on out of Meta's envelope.
 *
 * The payload is four levels of nesting deep (`entry[].changes[].value`) and
 * carries both directions at once — their replies and the delivery receipts
 * for ours — so both are read in one pass.
 */
export function parseWebhook(payload: unknown): WebhookPayload {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  const entries = (payload as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return { messages, statuses };

  for (const entry of entries) {
    for (const change of (entry as { changes?: unknown[] }).changes ?? []) {
      const value = (change as { value?: Record<string, unknown> }).value;
      if (!value) continue;

      const contacts = (value.contacts as { wa_id?: string; profile?: { name?: string } }[] | undefined) ?? [];
      const profileFor = (waId: string) => contacts.find((contact) => contact.wa_id === waId)?.profile?.name ?? null;

      for (const raw of (value.messages as Record<string, unknown>[] | undefined) ?? []) {
        const from = String(raw.from ?? "");
        if (!from || !raw.id) continue;
        messages.push({
          id: String(raw.id),
          from,
          profileName: profileFor(from),
          timestamp: readTimestamp(raw.timestamp),
          type: String(raw.type ?? "unknown"),
          text: readText(raw),
        });
      }

      for (const raw of (value.statuses as Record<string, unknown>[] | undefined) ?? []) {
        if (!raw.id) continue;
        const errors = raw.errors as { title?: string; message?: string; code?: number }[] | undefined;
        const first = errors?.[0];
        statuses.push({
          messageId: String(raw.id),
          status: String(raw.status ?? "unknown"),
          timestamp: readTimestamp(raw.timestamp),
          recipient: raw.recipient_id ? String(raw.recipient_id) : null,
          error: first ? explain(first.code ?? null, null, first.message || first.title || "WhatsApp could not deliver it.") : null,
        });
      }
    }
  }

  return { messages, statuses };
}

/**
 * The words out of whichever shape the message came in.
 *
 * A tapped quick-reply button is a reply — often *the* reply, since a button is
 * the easiest thing in the world to press — and it arrives under a completely
 * different key from typed text. Reading only `text.body` loses it, and the
 * conversation then looks unanswered.
 */
function readText(raw: Record<string, unknown>): string | null {
  const text = (raw.text as { body?: string } | undefined)?.body;
  if (text) return text;

  const button = (raw.button as { text?: string } | undefined)?.text;
  if (button) return button;

  const interactive = raw.interactive as
    | { button_reply?: { title?: string }; list_reply?: { title?: string } }
    | undefined;
  const reply = interactive?.button_reply?.title ?? interactive?.list_reply?.title;
  if (reply) return reply;

  // A photo or a voice note, which people genuinely do send back. The caption
  // when there is one, otherwise a note of what arrived so the thread reads.
  const caption = (raw.image as { caption?: string } | undefined)?.caption ?? (raw.video as { caption?: string } | undefined)?.caption;
  if (caption) return caption;

  return null;
}
