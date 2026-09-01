import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type {
  EmailPurpose,
  MessageChannel,
  MessageDraftResponse,
  MessageRoute,
  MessageRow,
  Reachability,
  SmsCost,
  StarterTemplate,
  WhatsAppTemplateRow,
} from "../lib/types";
import { Badge, Button, Drawer, Field } from "./ui";

/**
 * Writing one WhatsApp or one text.
 *
 * Deliberately not the email composer with a phone number in it. Three things
 * on this screen have no email equivalent and each of them is the difference
 * between a message that arrives and one that does not:
 *
 *  - **The window.** WhatsApp carries what you wrote only within 24 hours of
 *    their last reply. Outside it, an approved template or nothing. The panel
 *    says which state this conversation is in *before* anything is typed,
 *    because discovering it at the send button means having written the wrong
 *    thing.
 *  - **The route.** A wa.me link that a person opens and sends from their own
 *    WhatsApp needs no approval and no fee, and it is the honest answer while
 *    a template is still being reviewed. It is offered as a peer of the API
 *    send, not as a failure mode.
 *  - **The cost.** A text is billed per 160 characters, and one curly quote
 *    re-encodes the whole message and drops that to 70. The counter is live
 *    and names the character that did it.
 */

export interface MessageTarget {
  leadId?: string | null;
  clientId?: string | null;
  threadId?: string | null;
  toPhone?: string | null;
  toName?: string | null;
  channel?: MessageChannel;
  purpose?: EmailPurpose;
}

const PURPOSES: [EmailPurpose, string][] = [
  ["COLD_OUTREACH", "First approach"],
  ["FOLLOW_UP", "Follow-up"],
  ["MEETING_REQUEST", "Ask for a call"],
  ["DEMO_READY", "Their demo is ready"],
  ["INVOICE_DELIVERY", "Sending an invoice"],
  ["INVOICE_REMINDER", "Chasing a payment"],
  ["PROJECT_UPDATE", "Project update"],
  ["THANK_YOU", "Thank you"],
  ["ONBOARDING", "Getting started"],
  ["REACTIVATION", "Back in touch"],
  ["CUSTOM", "Something else"],
];

export function MessageComposer({ target, open, onClose }: { target: MessageTarget | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();

  const [channel, setChannel] = useState<MessageChannel>("WHATSAPP");
  const [route, setRoute] = useState<MessageRoute>("API");
  const [purpose, setPurpose] = useState<EmailPurpose>("COLD_OUTREACH");
  const [toPhone, setToPhone] = useState("");
  const [body, setBody] = useState("");
  const [brief, setBrief] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [draft, setDraft] = useState<MessageDraftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentLink, setSentLink] = useState<{ id: string; link: string } | null>(null);

  // Reset per target rather than per open, so re-opening the same conversation
  // does not throw away a half-written message.
  useEffect(() => {
    if (!open) return;
    setChannel(target?.channel ?? "WHATSAPP");
    setPurpose(target?.purpose ?? "COLD_OUTREACH");
    setToPhone(target?.toPhone ?? "");
    setBody("");
    setBrief("");
    setDraft(null);
    setTemplateName("");
    setVariables([]);
    setError(null);
    setSentLink(null);
    setRoute("API");
  }, [open, target?.leadId, target?.clientId, target?.toPhone, target?.threadId, target?.channel, target?.purpose]);

  const { data: reach } = useQuery({
    queryKey: ["reachability", target?.leadId, toPhone],
    enabled: open && Boolean(target?.leadId || toPhone),
    queryFn: () =>
      api.get<Reachability>(
        target?.leadId ? `/messages/reachability?leadId=${target.leadId}` : `/messages/reachability?phone=${encodeURIComponent(toPhone)}`,
      ),
  });

  const { data: templateData } = useQuery({
    queryKey: ["whatsapp-templates"],
    enabled: open && channel === "WHATSAPP",
    queryFn: () => api.get<{ templates: WhatsAppTemplateRow[]; starters: StarterTemplate[]; configured: boolean }>("/messages/templates"),
  });
  const approved = (templateData?.templates ?? []).filter((template) => template.status === "APPROVED");
  const template = approved.find((one) => one.name === templateName) ?? null;

  const { data: cost } = useQuery({
    queryKey: ["sms-cost", body],
    enabled: open && channel === "SMS" && body.length > 0,
    queryFn: () => api.post<SmsCost & { gsm7: (SmsCost & { body: string }) | null }>("/messages/cost", { body }),
  });

  const drafting = useMutation({
    mutationFn: () =>
      api.post<MessageDraftResponse>("/messages/draft", {
        channel,
        purpose,
        leadId: target?.leadId ?? null,
        clientId: target?.clientId ?? null,
        toPhone: target?.leadId || target?.clientId ? null : toPhone || null,
        toName: target?.toName ?? null,
        brief: brief.trim() || null,
        existingBody: body.trim() || null,
      }),
    onSuccess: (result) => {
      setDraft(result);
      setBody(result.body);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const sending = useMutation({
    mutationFn: () =>
      api.post<MessageRow & { result?: { sent: boolean; reason?: string; link?: string } }>("/messages", {
        channel,
        purpose,
        route,
        kind: draft ? "AI_DRAFT" : templateName ? "TEMPLATE" : "MANUAL",
        body: templateName ? null : body,
        templateName: templateName || null,
        templateVariables: templateName ? variables : undefined,
        leadId: target?.leadId ?? null,
        clientId: target?.clientId ?? null,
        toPhone: target?.leadId || target?.clientId ? null : toPhone || null,
        toName: target?.toName ?? null,
        send: true,
      }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["message-threads"] });
      void qc.invalidateQueries({ queryKey: ["messaging-status"] });
      void qc.invalidateQueries({ queryKey: ["phone-only"] });
      if (result.result?.link) {
        // The hand-off path. Nothing has been sent, and the panel stays open
        // saying exactly that rather than closing on a false success.
        setSentLink({ id: result.id, link: result.result.link });
        return;
      }
      if (result.result && !result.result.sent) {
        setError(result.result.reason ?? "It was not sent.");
        return;
      }
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const markSent = useMutation({
    mutationFn: (id: string) => api.post(`/messages/${id}/mark-sent`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["message-threads"] });
      void qc.invalidateQueries({ queryKey: ["phone-only"] });
      onClose();
    },
  });

  const blocked = draft?.checks?.blocking ?? [];
  const canSend = Boolean((templateName || body.trim()) && !sending.isPending);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={channel === "WHATSAPP" ? "New WhatsApp message" : "New text message"}
      subtitle={target?.toName ?? reach?.phone?.display ?? "Choose who it goes to"}
      footer={
        sentLink ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted">Nothing has been sent yet — open WhatsApp, check it, and press send there.</div>
            <div className="flex gap-2">
              <a href={sentLink.link} target="_blank" rel="noreferrer">
                <Button variant="accent">Open in WhatsApp</Button>
              </a>
              <Button variant="secondary" onClick={() => markSent.mutate(sentLink.id)} disabled={markSent.isPending}>
                I sent it
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted">
              {route === "LINK"
                ? "Prepares a link. You press send from your own WhatsApp."
                : channel === "SMS"
                  ? `${cost?.segments ?? 0} segment${cost?.segments === 1 ? "" : "s"} · ${cost?.encoding ?? "GSM-7"}`
                  : template
                    ? `Template “${template.name}” · ${template.variableCount} variable${template.variableCount === 1 ? "" : "s"}`
                    : "Sends now."}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => drafting.mutate()} disabled={drafting.isPending}>
                {drafting.isPending ? "Writing…" : draft ? "Rewrite it" : "Write it for me"}
              </Button>
              <Button onClick={() => sending.mutate()} disabled={!canSend}>
                {sending.isPending ? "Sending…" : route === "LINK" ? "Prepare the link" : "Send"}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="space-y-5">
        {error && <div className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error}</div>}

        {/* The window, said before anything is typed. */}
        {channel === "WHATSAPP" && <WindowNotice threadId={target?.threadId ?? null} hasTemplate={Boolean(templateName)} onUseLink={() => setRoute("LINK")} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Channel">
            <select className="input" value={channel} onChange={(event) => setChannel(event.target.value as MessageChannel)}>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="SMS">Text message</option>
            </select>
          </Field>
          <Field label="What it's for">
            <select className="input" value={purpose} onChange={(event) => setPurpose(event.target.value as EmailPurpose)}>
              {PURPOSES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          {!target?.leadId && !target?.clientId && (
            <Field label="Number" hint="Any usual form — 024…, +233…" full>
              <input className="input" value={toPhone} onChange={(event) => setToPhone(event.target.value)} placeholder="024 123 4567" />
            </Field>
          )}
        </div>

        {reach && (
          <div className={`rounded-xl border px-4 py-3 text-sm ${reach.channel ? "border-line bg-white" : "border-warn-line bg-warn-surface"}`}>
            <div className="flex flex-wrap items-center gap-2">
              {reach.phone && <span className="font-mono text-[12px]">{reach.phone.display}</span>}
              {reach.channel && <Badge tone={reach.channel === "EMAIL" ? "muted" : "positive"}>Best reached by {reach.channel.toLowerCase()}</Badge>}
            </div>
            <p className="mt-1.5 text-xs text-muted">{reach.why}</p>
          </div>
        )}

        {channel === "WHATSAPP" && (
          <Field label="Template" hint="Required outside the 24-hour window. Leave blank to write freely.">
            <select
              className="input"
              value={templateName}
              onChange={(event) => {
                setTemplateName(event.target.value);
                const chosen = approved.find((one) => one.name === event.target.value);
                setVariables(chosen ? Array(chosen.variableCount).fill("") : []);
              }}
            >
              <option value="">Write it myself</option>
              {approved.map((one) => (
                <option key={one.id} value={one.name}>
                  {one.name} ({one.language})
                </option>
              ))}
            </select>
          </Field>
        )}

        {template && (
          <div className="rounded-xl border border-line bg-white p-4">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{template.body}</div>
            {template.variableCount > 0 && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {Array.from({ length: template.variableCount }).map((_, index) => (
                  <Field key={index} label={`{{${index + 1}}}`} hint={template.variableHints[index]}>
                    <input
                      className="input"
                      value={variables[index] ?? ""}
                      onChange={(event) => {
                        const next = [...variables];
                        next[index] = event.target.value;
                        setVariables(next);
                      }}
                    />
                  </Field>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-muted">
              A variable cannot be left empty and cannot contain a line break — WhatsApp refuses both outright.
            </p>
          </div>
        )}

        {!template && (
          <>
            <Field label="What should it say?" hint="A sentence for the writer. Skip it and it works from the record alone.">
              <input className="input" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="They've had the audit — ask if they want the screenshot" />
            </Field>

            <Field label="Message" full>
              <textarea
                className="input min-h-[160px] font-mono text-[13px] leading-relaxed"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder={channel === "WHATSAPP" ? "Hi Kwame — Daky here from Dakyworld…" : "Keep it under 160 characters if you can."}
              />
            </Field>
          </>
        )}

        {channel === "SMS" && cost && body.length > 0 && <CostNotice cost={cost} onConvert={(next) => setBody(next)} />}

        {draft && <DraftNotes draft={draft} blocked={blocked} />}
      </div>
    </Drawer>
  );
}

/**
 * Whether WhatsApp will actually carry what is being typed.
 *
 * The single most useful thing on this screen, and the reason it sits at the
 * top rather than beside the send button: a person who learns at the send
 * button that only a template can go has written the wrong message.
 */
function WindowNotice({ threadId, hasTemplate, onUseLink }: { threadId: string | null; hasTemplate: boolean; onUseLink: () => void }) {
  const { data } = useQuery({
    queryKey: ["message-thread", threadId],
    enabled: Boolean(threadId),
    queryFn: () => api.get<{ windowOpen: boolean; windowMinutesLeft: number | null; display: string }>(`/messages/threads/${threadId}`),
  });

  // No thread means nobody has ever written to us from this number, which is
  // the ordinary case for a cold approach and is not an error.
  const open = data?.windowOpen ?? false;
  if (open) {
    return (
      <div className="rounded-xl border border-positive-line bg-positive-surface px-3.5 py-2.5 text-sm text-positive-text">
        They replied recently, so you can write whatever you like for another {data?.windowMinutesLeft ?? 0} minutes. No template needed.
      </div>
    );
  }
  if (hasTemplate) return null;

  return (
    <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
      <div className="font-medium">They haven't messaged us in the last 24 hours.</div>
      <p className="mt-1 text-xs">
        WhatsApp will only deliver an approved template to them — a written message is refused outright. Pick a template above, or send this one
        from your own WhatsApp instead.
      </p>
      <button type="button" onClick={onUseLink} className="mt-2 text-xs font-bold underline underline-offset-2">
        Send it by hand instead
      </button>
    </div>
  );
}

/** What this text will really be billed as, and the one-click fix when it is three times what it should be. */
function CostNotice({ cost, onConvert }: { cost: SmsCost & { gsm7: (SmsCost & { body: string }) | null }; onConvert: (body: string) => void }) {
  if (cost.encoding === "GSM-7") {
    return (
      <div className="text-xs text-muted">
        {cost.characters} characters · {cost.segments} message{cost.segments === 1 ? "" : "s"}.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
      <div className="font-medium">
        This is being sent as Unicode, so it costs {cost.segments} message{cost.segments === 1 ? "" : "s"} instead of {cost.gsm7?.segments ?? 1}.
      </div>
      <p className="mt-1 text-xs">
        {cost.forcedBy ? `The character “${cost.forcedBy}” did it — ` : ""}a curly quote, a long dash or an emoji drops the limit from 160
        characters to 70.
      </p>
      {cost.gsm7 && (
        <button type="button" onClick={() => onConvert(cost.gsm7!.body)} className="mt-2 text-xs font-bold underline underline-offset-2">
          Swap them for plain ones
        </button>
      )}
    </div>
  );
}

/** What the writer used, what the checklist caught, and what it could not establish. */
function DraftNotes({ draft, blocked }: { draft: MessageDraftResponse; blocked: { id: string; label: string; detail: string }[] }) {
  return (
    <div className="space-y-3">
      {draft.caseStrength === "WEAK" || draft.caseStrength === "NONE" ? (
        <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
          There is no strong case here — nothing found is worth writing to a stranger about. Sending anyway is a message about nothing.
        </div>
      ) : null}

      {draft.prepError && (
        <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-xs text-warn-text">
          Nobody could look at this business first: {draft.prepError}
        </div>
      )}

      {blocked.length > 0 && (
        <div className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          <div className="font-medium">The checklist stopped this one.</div>
          <ul className="mt-1.5 space-y-1 text-xs">
            {blocked.map((check) => (
              <li key={check.id}>
                <span className="font-medium">{check.label}</span>
                {check.detail ? ` — ${check.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-xl border border-line bg-white px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Why this angle</div>
        <p className="mt-1.5 text-sm text-ink">{draft.rationale}</p>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted">
          <span>Written by {draft.model}</span>
          <span>·</span>
          <span>Confidence {Math.round(draft.confidence * 100)}%</span>
          {draft.scenario && (
            <>
              <span>·</span>
              <span>Scenario {draft.scenario.number}: {draft.scenario.name}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
