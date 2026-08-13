import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  Client,
  EmailAttachment,
  EmailContext,
  EmailDraft,
  EmailMessage,
  EmailPurpose,
  EmailTemplate,
  Lead,
} from "../lib/types";
import { Badge, Button, Drawer, Field, StatusDot } from "./ui";

/**
 * Writing one email.
 *
 * The panel is arranged around the one thing that makes an email worth
 * sending: **what we actually know about this person**. The facts the drafter
 * would use are shown to the writer, in the same words, above the box they
 * type into — so the difference between a tailored email and a mail merge is
 * visible before anything is written, not discovered after it is sent.
 *
 * Nothing the AI produces goes anywhere on its own. It fills the two boxes; a
 * person reads them and presses Send.
 */

export const PURPOSES: { value: EmailPurpose; label: string; hint: string }[] = [
  { value: "COLD_OUTREACH", label: "Cold approach", hint: "First contact with someone who has never heard of us." },
  { value: "FOLLOW_UP", label: "Follow-up", hint: "They didn't reply to the last one." },
  { value: "MEETING_REQUEST", label: "Ask for a call", hint: "The thirty-minute consultation." },
  { value: "PROPOSAL_COVER", label: "Proposal cover", hint: "The note that carries the proposal." },
  { value: "DELIVERABLE_HANDOVER", label: "Hand over work", hint: "Finished work, with the files attached." },
  { value: "PROJECT_UPDATE", label: "Project update", hint: "Where things stand on live work." },
  { value: "INVOICE_DELIVERY", label: "Send an invoice", hint: "Attaches the invoice PDF." },
  { value: "INVOICE_REMINDER", label: "Payment reminder", hint: "An invoice past its due date." },
  { value: "CARE_PLAN_REVIEW", label: "Book a review", hint: "The periodic care plan review." },
  { value: "ONBOARDING", label: "Welcome", hint: "A proposal was accepted — what happens next." },
  { value: "REACTIVATION", label: "Reactivation", hint: "Someone who went quiet." },
  { value: "THANK_YOU", label: "Thank you", hint: "A referral, a testimonial, a project closing well." },
  { value: "ANNOUNCEMENT", label: "Announcement", hint: "Something new, to people who already know us." },
  { value: "CUSTOM", label: "Something else", hint: "Describe it in the brief." },
];

export interface ComposerTarget {
  leadId?: string;
  clientId?: string;
  toEmail?: string;
  toName?: string;
  purpose?: EmailPurpose;
  /** Pre-attached deliverables — an invoice being sent, a proposal going out. */
  attachments?: EmailAttachment[];
  invoiceId?: string;
  proposalId?: string;
  projectId?: string;
  carePlanId?: string;
  /** Opening an existing draft to finish it. */
  message?: EmailMessage;
}

export function EmailComposer({ target, open, onClose }: { target: ComposerTarget | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [purpose, setPurpose] = useState<EmailPurpose>("CUSTOM");
  const [brief, setBrief] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [showFacts, setShowFacts] = useState(true);
  const [pickingRecipient, setPickingRecipient] = useState(false);
  const [manual, setManual] = useState<{ leadId?: string; clientId?: string; toEmail?: string; toName?: string } | null>(null);

  const recipient = manual ?? target ?? {};
  const hasRecipient = Boolean(recipient.leadId || recipient.clientId || recipient.toEmail);

  // Reset the whole panel whenever it is opened on something new.
  const key = `${target?.leadId ?? ""}|${target?.clientId ?? ""}|${target?.toEmail ?? ""}|${target?.message?.id ?? ""}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!open || key === loadedKey) return;
    setLoadedKey(key);
    setSubject(target?.message?.subject ?? "");
    setBody(target?.message?.bodyText ?? "");
    setPurpose(target?.message?.purpose ?? target?.purpose ?? "CUSTOM");
    setToEmail(target?.message?.toEmail ?? target?.toEmail ?? "");
    setAttachments(target?.message?.attachments ?? target?.attachments ?? []);
    setBrief("");
    setNotice(null);
    setRationale(null);
    setManual(null);
    setScheduleAt("");
    setPickingRecipient(!target?.leadId && !target?.clientId && !target?.toEmail && !target?.message);
  }, [open, key, loadedKey, target]);

  const { data: context } = useQuery({
    queryKey: ["email-context", recipient.leadId, recipient.clientId, recipient.toEmail],
    queryFn: () =>
      api.get<EmailContext>(
        `/emails/context/lookup?${new URLSearchParams({
          ...(recipient.leadId ? { leadId: recipient.leadId } : {}),
          ...(recipient.clientId ? { clientId: recipient.clientId } : {}),
          ...(recipient.toEmail ? { email: recipient.toEmail } : {}),
          ...(recipient.toName ? { name: recipient.toName } : {}),
        }).toString()}`,
      ),
    enabled: open && hasRecipient,
  });

  const { data: templateData } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => api.get<{ templates: EmailTemplate[] }>("/emails/templates/all"),
    enabled: open,
  });

  const relevantTemplates = useMemo(
    () => (templateData?.templates ?? []).filter((template) => template.active && (purpose === "CUSTOM" || template.purpose === purpose)),
    [templateData, purpose],
  );

  useEffect(() => {
    if (context?.email && !toEmail) setToEmail(context.email);
  }, [context, toEmail]);

  const draft = useMutation({
    mutationFn: () =>
      api.post<EmailDraft>("/emails/draft", {
        purpose,
        leadId: recipient.leadId ?? null,
        clientId: recipient.clientId ?? null,
        toEmail: recipient.leadId || recipient.clientId ? null : toEmail || null,
        toName: recipient.toName ?? null,
        brief: brief.trim() || null,
        existingSubject: subject || null,
        existingBody: body || null,
      }),
    onSuccess: (result) => {
      setSubject(result.subject);
      setBody(result.body);
      setRationale(result.rationale);
      setNotice(null);
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const save = useMutation({
    mutationFn: (mode: "send" | "draft" | "schedule") =>
      api.post<{ message: EmailMessage; result: { sent: boolean; reason?: string } }>("/emails", {
        subject,
        body,
        purpose,
        kind: rationale ? "AI_DRAFT" : "MANUAL",
        toEmail: toEmail || null,
        toName: recipient.toName ?? context?.name ?? null,
        leadId: recipient.leadId ?? null,
        clientId: recipient.clientId ?? null,
        projectId: target?.projectId ?? null,
        proposalId: target?.proposalId ?? null,
        invoiceId: target?.invoiceId ?? null,
        carePlanId: target?.carePlanId ?? null,
        attachments,
        scheduledFor: mode === "schedule" && scheduleAt ? new Date(scheduleAt).toISOString() : null,
        send: mode === "send",
      }),
    onSuccess: ({ result }) => {
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["email-status"] });
      if (result.sent) onClose();
      else if (result.reason === "scheduled" || result.reason === "draft") onClose();
      else setNotice(result.reason ?? "The email was saved but not sent.");
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const purposeMeta = PURPOSES.find((option) => option.value === purpose)!;
  const canSend = Boolean(subject.trim() && body.trim() && toEmail.trim()) && !context?.suppressed;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={context?.name ? `Email ${context.name}` : "New email"}
      subtitle={
        context?.suppressed ? (
          <span className="text-red-600">{toEmail} has unsubscribed — nothing will send to this address.</span>
        ) : (
          toEmail || "Pick who this is going to"
        )
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              className="control"
              value={scheduleAt}
              onChange={(event) => setScheduleAt(event.target.value)}
              title="Send later"
            />
            {scheduleAt && (
              <Button variant="secondary" size="sm" onClick={() => save.mutate("schedule")} disabled={!canSend || save.isPending}>
                Schedule
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => save.mutate("draft")} disabled={!subject.trim() || save.isPending}>
              Save draft
            </Button>
            <Button onClick={() => save.mutate("send")} disabled={!canSend || save.isPending}>
              {save.isPending ? "Sending…" : "Send now"}
            </Button>
          </div>
        </div>
      }
    >
      {notice && <div className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</div>}

      {pickingRecipient && !hasRecipient && <RecipientPicker onPick={(picked) => { setManual(picked); setPickingRecipient(false); }} />}

      {hasRecipient && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <Field label="To">
              <input className="input" value={toEmail} onChange={(event) => setToEmail(event.target.value)} placeholder="name@company.com" />
            </Field>
            <Field label="What this email is">
              <select className="input" value={purpose} onChange={(event) => setPurpose(event.target.value as EmailPurpose)}>
                {PURPOSES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="-mt-3 mb-5 text-xs text-ink/45">{purposeMeta.hint}</p>

          {/* What we know. The whole reason this email can be specific. */}
          {context && context.facts.length > 0 && (
            <div className="mb-5 rounded-2xl border border-line bg-white">
              <button
                type="button"
                onClick={() => setShowFacts(!showFacts)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[.12em] text-ink/50 hover:text-ink"
              >
                <span>What we know about them ({context.facts.length})</span>
                <span aria-hidden>{showFacts ? "−" : "+"}</span>
              </button>
              {showFacts && (
                <ul className="space-y-1 border-t border-ink/10 px-4 py-3 text-xs text-ink/65">
                  {context.facts.map((fact, index) => (
                    <li key={index} className="leading-relaxed">
                      · {fact}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* The drafter. */}
          <div className="mb-5 border border-blue/30 bg-blue/[.05] p-4">
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-blue">
              <StatusDot tone="live" /> Draft it with AI
            </div>
            <textarea
              rows={2}
              className="input"
              placeholder={
                purpose === "CUSTOM"
                  ? "What should this email do? e.g. 'tell them the site is live and ask them to check the contact form'"
                  : "Anything specific for this one — a date, a name, a link. Leave blank to write from their record alone."
              }
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[11px] text-ink/45">
                Uses only what's above — it won't invent anything about them.
              </span>
              <Button size="sm" onClick={() => draft.mutate()} disabled={draft.isPending}>
                {draft.isPending ? "Writing…" : body ? "Rewrite" : "Write a draft"}
              </Button>
            </div>
            {rationale && <p className="mt-3 border-t border-blue/20 pt-2 text-[11px] italic text-ink/55">{rationale}</p>}
          </div>

          {relevantTemplates.length > 0 && (
            <div className="mb-5">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">Or start from a template</div>
              <div className="flex flex-wrap gap-2">
                {relevantTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    title={template.description ?? undefined}
                    onClick={() => {
                      setSubject(template.subject);
                      setBody(template.bodyHtml);
                      setPurpose(template.purpose);
                      setRationale(null);
                    }}
                    className="border border-ink/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-ink/60 transition hover:border-ink hover:text-ink"
                  >
                    {template.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <Field label="Subject" full>
            <input className="input" value={subject} onChange={(event) => setSubject(event.target.value)} />
          </Field>

          <div className="mt-4">
            <Field label="Message" hint="Blank line between paragraphs. {{first_name}} and the rest fill in from their record." full>
              <textarea rows={14} className="input font-normal leading-relaxed" value={body} onChange={(event) => setBody(event.target.value)} />
            </Field>
          </div>

          {context && Object.keys(context.variables).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(context.variables).map(([name, value]) => (
                <button
                  key={name}
                  type="button"
                  title={value || "(empty for this recipient)"}
                  onClick={() => setBody((current) => `${current}{{${name}}}`)}
                  className="rounded-lg border border-line bg-white px-1.5 py-0.5 font-mono text-[10px] text-ink/50 transition hover:border-ink/40 hover:text-ink"
                >
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">Attached</div>
              <div className="space-y-1.5">
                {attachments.map((attachment, index) => (
                  <div key={index} className="flex items-center justify-between rounded-xl border border-line bg-white px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <Badge tone="muted">{"kind" in attachment && attachment.kind ? attachment.kind : "file"}</Badge>
                      {"name" in attachment && attachment.name
                        ? attachment.name
                        : "invoiceId" in attachment
                          ? "Invoice PDF — rendered when it sends"
                          : "Proposal PDF — rendered when it sends"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAttachments(attachments.filter((_, position) => position !== index))}
                      className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40 hover:text-ink"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <AttachmentAdder onAdd={(attachment) => setAttachments([...attachments, attachment])} />
        </>
      )}
    </Drawer>
  );
}

/** Picking who to write to, when the composer wasn't opened from a record. */
function RecipientPicker({ onPick }: { onPick: (picked: { leadId?: string; clientId?: string; toEmail?: string; toName?: string }) => void }) {
  const [search, setSearch] = useState("");
  const { data: leads } = useQuery({
    queryKey: ["leads-brief", search],
    queryFn: () => api.get<{ items: Lead[] }>(`/leads?take=50${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}`),
  });
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: () => api.get<Client[]>("/clients") });

  const term = search.trim().toLowerCase();
  const matchingLeads = (leads?.items ?? [])
    .filter((lead) => lead.contactEmail)
    .filter((lead) => !term || `${lead.contactName} ${lead.companyName ?? ""} ${lead.contactEmail}`.toLowerCase().includes(term))
    .slice(0, 8);
  const matchingClients = (clients ?? [])
    .filter((client) => !term || `${client.name} ${client.company ?? ""}`.toLowerCase().includes(term))
    .slice(0, 8);

  return (
    <div>
      <Field label="Who is this going to?" full>
        <input className="input" autoFocus placeholder="Search leads and clients, or type an address" value={search} onChange={(event) => setSearch(event.target.value)} />
      </Field>

      {/^\S+@\S+\.\S+$/.test(search.trim()) && (
        <button
          type="button"
          onClick={() => onPick({ toEmail: search.trim() })}
          className="mt-3 w-full border border-ink/20 px-3 py-2 text-left text-sm transition hover:border-ink"
        >
          Write to <span className="font-medium">{search.trim()}</span> — no record on file
        </button>
      )}

      {matchingClients.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">Clients</div>
          {matchingClients.map((client) => (
            <button
              key={client.id}
              type="button"
              onClick={() => onPick({ clientId: client.id })}
              className="block w-full border-b border-ink/5 px-1 py-2 text-left text-sm transition hover:bg-ink/[.03]"
            >
              {client.name}
              {client.company && <span className="text-ink/45"> · {client.company}</span>}
            </button>
          ))}
        </div>
      )}

      {matchingLeads.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">Leads</div>
          {matchingLeads.map((lead) => (
            <button
              key={lead.id}
              type="button"
              onClick={() => onPick({ leadId: lead.id })}
              className="block w-full border-b border-ink/5 px-1 py-2 text-left text-sm transition hover:bg-ink/[.03]"
            >
              {lead.contactName}
              {lead.companyName && <span className="text-ink/45"> · {lead.companyName}</span>}
              <span className="ml-2 text-xs text-ink/35">{lead.contactEmail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A file by URL. Invoice and proposal PDFs attach themselves from their own pages. */
function AttachmentAdder({ onAdd }: { onAdd: (attachment: EmailAttachment) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");

  return (
    <div className="mt-5 border-t border-ink/10 pt-4">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">Attach a file by link</div>
      <div className="flex flex-wrap gap-2">
        <input className="input flex-1" placeholder="https://… (Drive, Cloudinary, anywhere public)" value={url} onChange={(event) => setUrl(event.target.value)} />
        <input className="input w-40" placeholder="Filename" value={name} onChange={(event) => setName(event.target.value)} />
        <Button
          variant="secondary"
          disabled={!url.trim()}
          onClick={() => {
            onAdd({ name: name.trim() || url.split("/").pop() || "attachment", url: url.trim() });
            setUrl("");
            setName("");
          }}
        >
          Attach
        </Button>
      </div>
    </div>
  );
}
