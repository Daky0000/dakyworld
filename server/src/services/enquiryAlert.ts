import { slackConfigured } from "../lib/slack.js";
import { appUrl } from "./emailSender.js";
import { emailOwner, type OwnerEmail } from "./opsAlert.js";
import { postNotification } from "./slack/notify.js";

/**
 * Telling the Owner that somebody has asked to talk.
 *
 * The contact form is how every retainer is bought: each plan on the pricing
 * page links to it. An enquiry used to become a QUALIFYING lead and nothing
 * else, so the only way to know a prospect had written was to open the Leads
 * screen and look. Now each one is emailed to the Owner as it arrives, with
 * Reply-To set to the person who wrote, and posted to Slack too when Slack is
 * connected.
 */

export interface Enquiry {
  leadId: string;
  /** False when the enquiry was added to a lead that already existed. */
  created: boolean;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  service: string | null;
  message: string | null;
  /** Sent by somebody's AI assistant through the door in llms.txt. */
  viaAgent: boolean;
}

/** At most this many enquiry emails an hour from one process; a flood of real-looking spam must not bury the inbox. */
export const ENQUIRY_ALERTS_PER_HOUR = 30;
const sentAt: number[] = [];

/** Whether another alert fits in the hourly allowance, counting it if so. */
export function takeEnquiryAllowance(now = Date.now()): boolean {
  while (sentAt.length && sentAt[0]! < now - 3_600_000) sentAt.shift();
  if (sentAt.length >= ENQUIRY_ALERTS_PER_HOUR) return false;
  sentAt.push(now);
  return true;
}

/** For the check: start from an empty hour. */
export function resetEnquiryAllowance(): void {
  sentAt.length = 0;
}

function oneLine(value: string | null, max = 200): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/** The email, built from the enquiry alone, so it can be checked without sending anything. */
export function enquiryEmail(enquiry: Enquiry, leadUrl: string): OwnerEmail {
  const who = oneLine(enquiry.name) ?? oneLine(enquiry.company) ?? oneLine(enquiry.email) ?? oneLine(enquiry.phone) ?? "Somebody";
  const company = oneLine(enquiry.company);
  const subject = `New enquiry: ${who}${company && company !== who ? `, ${company}` : ""}`.slice(0, 150);
  const details = [
    enquiry.email ? `Email: ${oneLine(enquiry.email)}` : null,
    enquiry.phone ? `Phone: ${oneLine(enquiry.phone)}` : null,
    enquiry.website ? `Website: ${oneLine(enquiry.website)}` : null,
    enquiry.service ? `Interested in: ${oneLine(enquiry.service)}` : null,
  ].filter((line): line is string => Boolean(line));
  const message = enquiry.message?.trim().slice(0, 4000) || null;
  return {
    subject,
    paragraphs: [
      // The same door takes the website's form, an assistant and a signed
      // integration, so the sentence does not name one of them.
      enquiry.created
        ? `${who} has just sent an enquiry.`
        : `${who} has written again. The message has been added to the lead they already had.`,
      ...(enquiry.viaAgent ? ["This was sent by an AI assistant acting for them, through the door described in llms.txt. You will be replying to the assistant's user, not the assistant."] : []),
      ...details,
      ...(message ? ["Their message:", message] : ["They did not leave a message."]),
    ],
    action: { label: "Open the lead", url: leadUrl },
    footnotes: [enquiry.email ? "Replying to this email writes to them directly." : "They left no email address, so reply by phone or from the lead."],
    category: "ops:enquiry",
    replyTo: enquiry.email,
  };
}

/**
 * Sends the enquiry to the Owner. Never throws and never delays the form: the
 * caller does not wait for it, and a mail failure is logged, not raised. The
 * lead exists either way.
 */
export async function notifyEnquiry(enquiry: Enquiry): Promise<void> {
  try {
    if (!takeEnquiryAllowance()) {
      console.warn(`[enquiry] more than ${ENQUIRY_ALERTS_PER_HOUR} enquiries this hour; lead ${enquiry.leadId} was not emailed.`);
      return;
    }
    const leadUrl = `${(await appUrl()).replace(/\/+$/, "")}/leads?lead=${encodeURIComponent(enquiry.leadId)}`;
    const email = enquiryEmail(enquiry, leadUrl);
    await emailOwner(email);
    if (await slackConfigured().catch(() => false)) {
      await postNotification({
        idempotencyKey: `enquiry:${enquiry.leadId}:${Date.now()}`,
        text: `${email.subject}\n${leadUrl}`,
      }).catch((error) => console.error("[enquiry] could not post to Slack:", (error as Error).message));
    }
  } catch (error) {
    console.error(`[enquiry] could not tell the Owner about lead ${enquiry.leadId}:`, (error as Error).message);
  }
}
