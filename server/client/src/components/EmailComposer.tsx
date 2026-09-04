import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  Client,
  EmailAttachment,
  EmailContext,
  EmailDraft,
  EmailMessage,
  EmailPreview,
  EmailPurpose,
  EmailTemplate,
  Lead,
  PreviewAttachment,
  StoredFile,
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
  { value: "DEMO_READY", label: "Demo is ready", hint: "The page you built for them is live — send them the link." },
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
  /**
   * Whether the website review still goes with this letter.
   *
   * True is the doctrine and stays the default — a first letter that names one
   * fault out of several carries the rest. This is only ever set false by a
   * person who has looked at the chip and decided this particular email should
   * not have it.
   */
  const [attachReport, setAttachReport] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [draftResult, setDraftResult] = useState<EmailDraft | null>(null);
  const [showingOriginal, setShowingOriginal] = useState(false);
  const [showFacts, setShowFacts] = useState(true);
  const [pickingRecipient, setPickingRecipient] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [manual, setManual] = useState<{ leadId?: string; clientId?: string; toEmail?: string; toName?: string } | null>(null);

  const recipient = manual ?? target ?? {};
  const hasRecipient = Boolean(recipient.leadId || recipient.clientId || recipient.toEmail);

  // Reset the whole panel whenever it is opened on something new.
  const key = `${target?.leadId ?? ""}|${target?.clientId ?? ""}|${target?.toEmail ?? ""}|${target?.message?.id ?? ""}|${target?.invoiceId ?? ""}|${target?.proposalId ?? ""}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!open || key === loadedKey) return;
    setLoadedKey(key);
    setSubject(target?.message?.subject ?? "");
    setBody(target?.message?.bodyText ?? "");
    setPurpose(target?.message?.purpose ?? target?.purpose ?? "CUSTOM");
    setToEmail(target?.message?.toEmail ?? target?.toEmail ?? "");
    // An email opened on an invoice (or a proposal) starts with that document
    // attached — the chip is the visible half of the guarantee the server
    // enforces at send, and seeing it is why nobody wonders whether the PDF
    // will be there.
    setAttachments(
      target?.message?.attachments ??
        target?.attachments ?? [
          ...(target?.invoiceId ? [{ kind: "invoice" as const, invoiceId: target.invoiceId }] : []),
          ...(target?.proposalId ? [{ kind: "proposal" as const, proposalId: target.proposalId }] : []),
        ],
    );
    setAttachReport(true);
    setBrief("");
    setNotice(null);
    setRationale(null);
    setDraftResult(null);
    setShowingOriginal(false);
    setManual(null);
    setScheduleAt("");
    setTab("write");
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

  /**
   * What the server attaches on its own: the invoice this letter is about, the
   * proposal it carries, the website review a first approach leaves with.
   *
   * Asked for from the same function the send uses, and asked again whenever
   * the recipient or the purpose changes, because both decide the answer. A
   * file that turns up on the sent record and appeared nowhere on the screen
   * the sender pressed Send on is a document they are answering for without
   * having seen it — which is what happened before this existed.
   *
   * Deliberately not keyed on `attachReport`: the chip has to stay on screen
   * after the review is taken off, or removing it is a one-way door.
   */
  const { data: planned } = useQuery({
    queryKey: ["email-auto-attachments", recipient.leadId, recipient.clientId, purpose, target?.invoiceId, target?.proposalId],
    queryFn: () =>
      api.get<{ attachments: PreviewAttachment[] }>(
        `/emails/context/attachments?${new URLSearchParams({
          purpose,
          ...(recipient.leadId ? { leadId: recipient.leadId } : {}),
          ...(target?.invoiceId ? { invoiceId: target.invoiceId } : {}),
          ...(target?.proposalId ? { proposalId: target.proposalId } : {}),
        }).toString()}`,
      ),
    enabled: open && hasRecipient,
  });

  /**
   * The automatic ones minus anything already sitting in the picked list — a
   * draft opened to be finished carries them in its own attachments, and the
   * server dedupes on the way out, so drawing both would show one file twice.
   */
  const automatic = useMemo(
    () =>
      (planned?.attachments ?? []).filter(
        (entry) => !attachments.some((listed) => (("kind" in listed && listed.kind) || "file") === entry.kind),
      ),
    [planned, attachments],
  );

  const relevantTemplates = useMemo(
    () => (templateData?.templates ?? []).filter((template) => template.active && (purpose === "CUSTOM" || template.purpose === purpose)),
    [templateData, purpose],
  );

  useEffect(() => {
    if (context?.email && !toEmail) setToEmail(context.email);
  }, [context, toEmail]);

  // Choosing "Send an invoice" — or a payment reminder — attaches the invoice
  // this composer was opened on, even when the panel was opened bare and the
  // purpose was picked afterwards. Removing the chip is still allowed: the
  // owner may be writing about the invoice without sending the document.
  useEffect(() => {
    if (purpose !== "INVOICE_DELIVERY" && purpose !== "INVOICE_REMINDER") return;
    const invoiceId = target?.invoiceId;
    if (!invoiceId) return;
    setAttachments((current) =>
      current.some((entry) => "invoiceId" in entry && entry.invoiceId === invoiceId)
        ? current
        : [...current, { kind: "invoice", invoiceId }],
    );
  }, [purpose, target?.invoiceId]);

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
      setDraftResult(result);
      setShowingOriginal(false);
      setNotice(null);
      // The draft may have filled in half the lead record on its way past.
      if (result.prep?.ranNow) {
        void qc.invalidateQueries({ queryKey: ["lead", recipient.leadId] });
        void qc.invalidateQueries({ queryKey: ["leads"] });
        void qc.invalidateQueries({ queryKey: ["email-context", recipient.leadId] });
      }
    },
    onError: (err: Error) => setNotice(err.message),
  });

  /**
   * Flip the box between the polished version and the draft as written.
   * Keeping both in state rather than re-asking means the choice costs
   * nothing and cannot come back different.
   */
  const togglePolish = () => {
    const before = draftResult?.beforePolish;
    if (!draftResult || !before) return;
    if (showingOriginal) {
      setSubject(draftResult.subject);
      setBody(draftResult.body);
    } else {
      setSubject(before.subject);
      setBody(before.body);
    }
    setShowingOriginal(!showingOriginal);
  };

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
        attachReport,
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
          <span className="text-danger-text">{toEmail} has unsubscribed — nothing will send to this address.</span>
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
      {notice && <div className="mb-4 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</div>}

      {pickingRecipient && !hasRecipient && <RecipientPicker onPick={(picked) => { setManual(picked); setPickingRecipient(false); }} />}

      {/* Two halves of the same job: write it, then look at it. The preview is
          the server's own render, so what is shown here is what leaves — see
          EmailPreviewPane. */}
      {hasRecipient && (
        <div className="mb-5 flex gap-1.5 border-b border-line">
          {(["write", "preview"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTab(option)}
              className={`-mb-px border-b-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] transition ${
                tab === option ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {option === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
      )}

      {hasRecipient && tab === "preview" && (
        <EmailPreviewPane
          enabled={open}
          messageId={target?.message?.status === "SENT" ? target.message.id : undefined}
          request={{
            subject,
            body,
            purpose,
            leadId: recipient.leadId ?? null,
            clientId: recipient.clientId ?? null,
            toEmail: toEmail || null,
            toName: recipient.toName ?? context?.name ?? null,
            attachments,
            // So the envelope lists what actually leaves, not only what was
            // picked by hand.
            invoiceId: target?.invoiceId ?? null,
            proposalId: target?.proposalId ?? null,
            attachReport,
          }}
        />
      )}

      {hasRecipient && tab === "write" && (
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
          <p className="-mt-3 mb-5 text-xs text-muted">{purposeMeta.hint}</p>

          {/* What we know. The whole reason this email can be specific. */}
          {context && context.facts.length > 0 && (
            <div className="mb-5 rounded-2xl border border-line bg-white">
              <button
                type="button"
                onClick={() => setShowFacts(!showFacts)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[.12em] text-muted hover:text-ink"
              >
                <span>What we know about them ({context.facts.length})</span>
                <span aria-hidden>{showFacts ? "−" : "+"}</span>
              </button>
              {showFacts && (
                <ul className="space-y-1 border-t border-line px-4 py-3 text-xs text-muted">
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
          <div className="overflow-hidden rounded-2xl mb-5 border border-blue/30 bg-blue/[.05] p-4">
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
              <span className="text-[11px] text-muted">
                {recipient.leadId && !context?.preparedAt
                  ? "Nobody has looked at this business yet — writing will research them and check their site first, which takes a minute."
                  : "Uses only what's above — it won't invent anything about them, and Perplexity reads it before you do."}
              </span>
              <Button size="sm" onClick={() => draft.mutate()} disabled={draft.isPending}>
                {draft.isPending
                  ? recipient.leadId && !context?.preparedAt
                    ? "Looking at them…"
                    : "Writing…"
                  : body
                    ? "Rewrite"
                    : "Write a draft"}
              </Button>
            </div>
            {rationale && <p className="mt-3 border-t border-blue/20 pt-2 text-[11px] italic text-muted">{rationale}</p>}
          </div>

          {draftResult && <DraftReport result={draftResult} showingOriginal={showingOriginal} onToggle={togglePolish} />}

          {relevantTemplates.length > 0 && (
            <div className="mb-5">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-muted">Or start from a template</div>
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
                    className="rounded-full border border-line-strong px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted transition hover:border-ink hover:text-ink"
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
                  className="rounded-xl border border-line bg-white px-1.5 py-0.5 font-mono text-[10px] text-muted transition hover:border-ink/40 hover:text-ink"
                >
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
          )}

          <AttachmentPanel
            attachments={attachments}
            onChange={setAttachments}
            automatic={automatic}
            attachReport={attachReport}
            onAttachReport={setAttachReport}
          />
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
          className="rounded-xl mt-3 w-full border border-line-strong px-3 py-2 text-left text-sm transition hover:border-ink"
        >
          Write to <span className="font-medium">{search.trim()}</span> — no record on file
        </button>
      )}

      {matchingClients.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-muted">Clients</div>
          {matchingClients.map((client) => (
            <button
              key={client.id}
              type="button"
              onClick={() => onPick({ clientId: client.id })}
              className="block w-full border-b border-line px-1 py-2 text-left text-sm transition hover:bg-sunken"
            >
              {client.name}
              {client.company && <span className="text-muted"> · {client.company}</span>}
            </button>
          ))}
        </div>
      )}

      {matchingLeads.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-muted">Leads</div>
          {matchingLeads.map((lead) => (
            <button
              key={lead.id}
              type="button"
              onClick={() => onPick({ leadId: lead.id })}
              className="block w-full border-b border-line px-1 py-2 text-left text-sm transition hover:bg-sunken"
            >
              {lead.contactName}
              {lead.companyName && <span className="text-muted"> · {lead.companyName}</span>}
              <span className="ml-2 text-xs text-muted">{lead.contactEmail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Attachments -----------------------------------------------------------

const MAX_ATTACHMENT_MB = 10;

function formatBytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number") return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The label on a chip — what this attachment actually is. */
function attachmentLabel(attachment: EmailAttachment): string {
  if ("name" in attachment && attachment.name) return attachment.name;
  if ("invoiceId" in attachment) return "Invoice PDF";
  if ("proposalId" in attachment) return "Proposal PDF";
  if ("auditId" in attachment) return "Website review PDF";
  return "attachment";
}

/** Why this file is going, said in the words the sender would use. */
const AUTOMATIC_BECAUSE: Record<string, string> = {
  invoice: "Goes with the invoice this email is about.",
  proposal: "Goes with the proposal this email carries.",
  audit: "The letter names one fault; more than one was found, so the rest go as a report.",
};

/**
 * Attaching a file, two ways.
 *
 * **Drop it, or pick it.** The bytes go up the moment the file is chosen
 * rather than when Send is pressed, so a 6 MB scan is already on the server
 * while the letter is still being written — and Send stays instant. Ten
 * megabytes is the ceiling per file: providers reject a message over about 25
 * MB once base64 has added its third, and a message carries more than one.
 *
 * **Or link it.** Anything large has a better answer than an inbox, and the
 * link form stays for exactly that.
 *
 * **Or it is already going.** `automatic` is what the server attaches from
 * what this message is *about* — the invoice, the proposal, the website review
 * — listed here beside the picked files, because those are the ones a sender
 * would otherwise find out about from the sent record. Only the review can be
 * taken off: the invoice and the proposal are what the letter is for.
 */
function AttachmentPanel({
  attachments,
  onChange,
  automatic = [],
  attachReport = true,
  onAttachReport,
}: {
  attachments: EmailAttachment[];
  onChange: (next: EmailAttachment[]) => void;
  automatic?: PreviewAttachment[];
  attachReport?: boolean;
  onAttachReport?: (next: boolean) => void;
}) {
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [url, setUrl] = useState("");
  const [linkName, setLinkName] = useState("");

  const upload = async (files: FileList | File[]) => {
    setError(null);
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
        setError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_ATTACHMENT_MB} MB — attach it as a link instead.`);
        continue;
      }
      setUploading((current) => [...current, file.name]);
      try {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });
        const stored = await api.post<StoredFile>("/emails/attachments", {
          filename: file.name,
          contentType: file.type || null,
          dataBase64,
        });
        onChange([
          ...attachments,
          { kind: "stored", fileId: stored.id, name: stored.filename, contentType: stored.contentType, size: stored.size },
        ]);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setUploading((current) => current.filter((name) => name !== file.name));
      }
    }
  };

  // `attachments` is read inside the async loop above, so this component reads
  // it fresh on every call rather than closing over a stale array — which is
  // why each upload appends to the prop rather than to a local queue.
  const remove = (index: number) => onChange(attachments.filter((_, position) => position !== index));

  // What will actually leave: the picked files plus the automatic ones, less
  // the review if it has been taken off. The count in the heading is the whole
  // answer to "what is going with this", so it counts both.
  const going = attachments.length + automatic.filter((entry) => entry.kind !== "audit" || attachReport).length;

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">
          Attachments{going > 0 ? ` (${going})` : ""}
        </span>
        <button
          type="button"
          onClick={() => setShowLink(!showLink)}
          className="font-mono text-[10px] uppercase tracking-[.1em] text-muted transition hover:text-ink"
        >
          {showLink ? "Hide link form" : "Attach a link instead"}
        </button>
      </div>

      {/* The ones nobody picked. Drawn first and marked, because these are the
          files a sender would otherwise never see before pressing Send. */}
      {automatic.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {automatic.map((entry, index) => {
            const off = entry.kind === "audit" && !attachReport;
            const size = formatBytes(entry.size);
            return (
              <div
                key={`auto-${index}`}
                className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm ${
                  off ? "border-line bg-sunken" : entry.missing ? "border-danger-line bg-danger-surface" : "border-info-line bg-info-surface"
                }`}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone={off ? "muted" : "info"}>{off ? "removed" : "automatic"}</Badge>
                    <span className={`truncate ${off ? "text-muted line-through" : ""}`}>{entry.name}</span>
                    {size && <span className="shrink-0 text-xs text-muted">{size}</span>}
                  </span>
                  <span className="text-xs text-muted">
                    {entry.missing
                      ? "The file is missing — it will be left off rather than stopping the send."
                      : off
                        ? "Taken off this email. The letter must not refer to a report it is not carrying."
                        : AUTOMATIC_BECAUSE[entry.kind] ?? entry.note ?? "attached by the system"}
                  </span>
                </span>
                {entry.kind === "audit" && onAttachReport && (
                  <button
                    type="button"
                    onClick={() => onAttachReport(!attachReport)}
                    className="shrink-0 font-mono text-[10px] uppercase tracking-[.12em] text-muted transition hover:text-ink"
                  >
                    {off ? "Attach it again" : "Remove"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {attachments.map((attachment, index) => {
            const size = "size" in attachment ? formatBytes(attachment.size) : null;
            const kind = "kind" in attachment && attachment.kind ? attachment.kind : "file";
            return (
              <div key={index} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone="muted">{kind === "stored" ? "file" : kind === "audit" ? "review" : kind}</Badge>
                  <span className="truncate">{attachmentLabel(attachment)}</span>
                  {size && <span className="shrink-0 text-xs text-muted">{size}</span>}
                  {(kind === "invoice" || kind === "proposal" || kind === "audit") && (
                    <span className="shrink-0 text-xs text-muted">rendered when it sends</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="shrink-0 font-mono text-[10px] uppercase tracking-[.12em] text-muted transition hover:text-ink"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}

      {uploading.map((name) => (
        <div key={name} className="mb-1.5 flex items-center gap-2 rounded-xl border border-blue/30 bg-blue/[.04] px-3 py-2 text-sm text-muted">
          <StatusDot tone="live" />
          <span className="truncate">Uploading {name}…</span>
        </div>
      ))}

      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
        }}
        className={`flex cursor-pointer items-center justify-center rounded-xl border border-dashed px-4 py-5 text-center text-sm transition ${
          dragging ? "border-blue bg-blue/[.06] text-ink" : "border-line-strong text-muted hover:border-ink/40 hover:text-ink"
        }`}
      >
        <input
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) void upload(event.target.files);
            event.target.value = "";
          }}
        />
        <span>
          Drop files here, or <span className="underline underline-offset-2">choose them</span>
          <span className="block text-xs text-muted">Up to {MAX_ATTACHMENT_MB} MB each</span>
        </span>
      </label>

      {error && <p className="mt-2 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error}</p>}

      {showLink && (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            className="input flex-1"
            placeholder="https://… (Drive, Cloudinary, anywhere public)"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <input className="input w-40" placeholder="Filename" value={linkName} onChange={(event) => setLinkName(event.target.value)} />
          <Button
            variant="secondary"
            disabled={!url.trim()}
            onClick={() => {
              onChange([...attachments, { name: linkName.trim() || url.split("/").pop() || "attachment", url: url.trim() }]);
              setUrl("");
              setLinkName("");
            }}
          >
            Attach
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Preview ---------------------------------------------------------------

/**
 * The email as it will land.
 *
 * Rendered by the server through exactly the code a real send runs — the same
 * `renderEmail`, so the letterhead, the signature and the opt-out are the ones
 * that will actually go out, not an approximation drawn in the browser. The
 * one difference is that the logos arrive as data URLs, because an iframe has
 * no message to resolve a `cid:` against.
 *
 * The iframe is sandboxed with nothing granted. Email HTML is inert by
 * definition, but this panel also shows the record of email somebody else
 * wrote, and a preview pane is not the place to find out otherwise.
 */
export function EmailPreviewPane({
  request,
  messageId,
  enabled,
}: {
  request: Record<string, unknown>;
  messageId?: string;
  enabled: boolean;
}) {
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");

  const { data, isFetching, error } = useQuery({
    queryKey: ["email-preview", messageId ?? "compose", JSON.stringify(request)],
    queryFn: () =>
      messageId ? api.get<EmailPreview>(`/emails/${messageId}/preview`) : api.post<EmailPreview>("/emails/preview", request),
    enabled,
    // The composer sends this on every keystroke pause; a stale render for a
    // few seconds is fine and a request per character is not.
    staleTime: 4000,
    // A render that was refused will be refused again — retrying only means
    // the panel says "Rendering…" for ten seconds instead of saying why.
    retry: false,
  });

  if (error) {
    return <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{(error as Error).message}</p>;
  }
  if (!data) return <p className="text-sm text-muted">Rendering…</p>;

  return (
    <div className="space-y-4">
      {/* The envelope: what the inbox row will say before anything is opened. */}
      <div className="rounded-2xl border border-line bg-white">
        <dl className="divide-y divide-ink/5 text-sm">
          <Row label="From">
            {data.from.name} <span className="text-muted">&lt;{data.from.email}&gt;</span>
          </Row>
          <Row label="To">
            {data.toName ? `${data.toName} ` : ""}
            <span className="text-muted">&lt;{data.toEmail}&gt;</span>
          </Row>
          <Row label="Subject">
            <span className="font-medium">{data.subject || <span className="text-muted">no subject</span>}</span>
          </Row>
          {data.attachments.length > 0 && (
            <Row label="Attached">
              <span className="flex flex-wrap gap-1.5">
                {data.attachments.map((attachment, index) => (
                  <span
                    key={index}
                    title={attachment.note ?? undefined}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-1.5 py-0.5 text-xs ${
                      attachment.missing ? "border-danger-line bg-danger-surface text-danger-text" : "border-line bg-cream text-muted"
                    }`}
                  >
                    {attachment.name}
                    {formatBytes(attachment.size) && <span className="text-muted">{formatBytes(attachment.size)}</span>}
                    {/* Which of these nobody picked — same distinction the
                        composer draws, on the screen that shows the envelope. */}
                    {attachment.automatic && !attachment.missing && <span className="text-muted">· automatic</span>}
                    {attachment.missing && <span>· missing</span>}
                  </span>
                ))}
              </span>
            </Row>
          )}
        </dl>
      </div>

      {data.unresolved.length > 0 && (
        <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
          Nothing fills {data.unresolved.map((name) => `{{${name}}}`).join(", ")} for this recipient — it will go out with the braces
          showing. Check the spelling, or write the words in.
        </p>
      )}

      {data.suppressed && (
        <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          {data.toEmail} has unsubscribed ({data.suppressed}). Nothing will send to this address.
        </p>
      )}

      {data.historical && (
        <p className="rounded-xl border border-line bg-cream px-3 py-2 text-xs text-muted">
          This is the message exactly as it was sent, not a fresh render — a sent email is the record that it was sent.
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">
          {isFetching ? "Rendering…" : "As it will arrive"}
        </span>
        <div className="flex gap-1.5">
          {(["desktop", "mobile"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setWidth(option)}
              className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.1em] transition ${
                width === option ? "border-ink bg-ink text-cream" : "border-line-strong text-muted hover:border-ink/40"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-center rounded-2xl border border-line bg-cream p-3">
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={data.html}
          className="h-[640px] rounded-xl border border-line bg-white transition-[width]"
          style={{ width: width === "mobile" ? 400 : "100%" }}
        />
      </div>

      <details className="rounded-2xl border border-line bg-white px-4 py-3">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[.12em] text-muted">
          The plain-text half
        </summary>
        <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-muted">{data.text}</p>
      </details>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 px-4 py-2">
      <dt className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[.12em] text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

/**
 * What happened on the way to the draft in the box.
 *
 * Three models touched it — one went and looked at the business, one wrote it,
 * one made it sound like a person — and a composer that hides that is asking
 * somebody to send a letter under their own name on trust. So this shows the
 * work: what the look found, what the polish changed, and anything the polish
 * put in that the draft did not say, which should always be nothing and is
 * shown loudly when it is not.
 *
 * The toggle back to the unpolished draft is the important control. The polish
 * is usually an improvement and is occasionally not, and the only person who
 * can tell is the one about to send it.
 */
function DraftReport({
  result,
  showingOriginal,
  onToggle,
}: {
  result: EmailDraft;
  showingOriginal: boolean;
  onToggle: () => void;
}) {
  const prep = result.prep;
  const polish = result.polish;
  const weak = result.strength === "WEAK" || result.strength === "NONE";
  // A lead with a site that nobody photographed leaves the drafter with the
  // technical checks alone, and those produce letters about DNS records.
  const unseen = Boolean(prep && !prep.shot && prep.notes.some((note) => note.toLowerCase().includes("screenshot")));

  const checks = result.checks;
  const scenario = result.scenario;

  return (
    <div className="mb-5 space-y-3">
      {/* The playbook's checklist, above everything else it says. A blocking
          failure is not advice — it is an email that must not go out as it is,
          and burying it under the research would mean nobody read it until the
          prospect did. */}
      {checks && checks.blocking.length > 0 && (
        <div className="rounded-2xl border border-danger-line bg-danger-surface p-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-danger-text">
            Do not send this yet — {checks.blocking.length} check{checks.blocking.length === 1 ? "" : "s"} failed
          </div>
          <ul className="space-y-1 text-xs leading-relaxed text-danger-text">
            {checks.blocking.map((check) => (
              <li key={check.id}>
                <span className="font-medium">{check.label}.</span> {check.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {checks && checks.warnings.length > 0 && (
        <div className="rounded-2xl border border-warn-line bg-warn-surface p-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-warn-text">Worth a second look</div>
          <ul className="space-y-1 text-xs leading-relaxed text-warn-text">
            {checks.warnings.map((check) => (
              <li key={check.id}>
                <span className="font-medium">{check.label}.</span> {check.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Which of the eighteen letters this is, and what it deliberately left
          out — so "why is this not about the slow homepage" has an answer. */}
      {scenario && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-muted">
            Playbook scenario {scenario.number}
          </div>
          <p className="text-sm font-medium text-ink">{scenario.name}</p>
          <p className="mt-1 text-xs text-muted">Should reach: {scenario.contact}</p>
          {scenario.guard && <p className="mt-2 text-xs leading-relaxed text-ink">Must not: {scenario.guard}</p>}
          {scenario.alsoAvailable.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              Also found and left for another time: {scenario.alsoAvailable.map((other) => other.name).join("; ")}
            </p>
          )}
        </div>
      )}
      {/* The one thing worth interrupting for: there may be no reason to send
          this at all. A business that is doing fine, told by a stranger that it
          is not, remembers that — so this is louder than the rest. */}
      {weak && (
        <div className="rounded-2xl border border-warn-line bg-warn-surface p-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-warn-text">Nothing serious was found</div>
          <p className="text-xs leading-relaxed text-warn-text">
            Their site and email set-up check out — the worst of it is minor housekeeping. There may be no real reason for this
            business to reply, and a cold email about nothing costs the chance to write to them the year they do need somebody. Read
            the draft below before sending it, or leave this one.
          </p>
        </div>
      )}
      {/* The page built for a business that has none. It is the ask, so whether
          it exists decides what the letter may say — and a note here is the
          difference between a link and a promise of one. */}
      {result.demo && (
        <div className={`rounded-2xl border p-4 ${result.demo.url ? "border-line bg-white" : "border-warn-line bg-warn-surface"}`}>
          <div className={`mb-1 font-mono text-[10px] uppercase tracking-[.12em] ${result.demo.url ? "text-muted" : "text-warn-text"}`}>
            {result.demo.url ? (result.demo.built ? "A demo page was built for them just now" : "They already have a demo page") : "No demo page"}
          </div>
          {result.demo.url ? (
            <a href={result.demo.url} target="_blank" rel="noreferrer" className="break-all text-xs font-medium text-blue underline underline-offset-2">
              {result.demo.url}
            </a>
          ) : (
            <p className="text-xs leading-relaxed text-warn-text">{result.demo.note}</p>
          )}
          {result.demo.url && result.demo.note && <p className="mt-2 text-xs leading-relaxed text-muted">{result.demo.note}</p>}
        </div>
      )}
      {/* Several serious faults: the letter names one, and this is where the
          rest of them go. Shown because "the others are attached" and an email
          that actually carries them are two different things. */}
      {result.willAttachReport && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-muted">The full review goes with this email</div>
          <p className="text-xs leading-relaxed text-ink">
            More than one serious fault was found, so the letter names the strongest one and the rest are attached as a PDF. It is
            on the letter already — see the chip under Attachments, which is also where it can be taken off.
          </p>
        </div>
      )}
      {/* What the look found, when this request went and looked. */}
      {prep && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-muted">
            <span>{prep.ranNow ? "Looked at them just now" : "Read from an earlier look"}</span>
            {prep.researchedBy && (
              <Badge tone={prep.searchedLiveSources ? "muted" : "warn"}>
                {prep.researchedBy}
                {prep.searchedLiveSources ? " · live sources" : " · from memory, not live sources"}
              </Badge>
            )}
          </div>
          {prep.shot && (
            <a href={prep.shot.imageUrl} target="_blank" rel="noreferrer" className="mb-3 block overflow-hidden rounded-xl border border-line">
              <img src={prep.shot.imageUrl} alt="Their homepage" className="max-h-44 w-full object-cover object-top" loading="lazy" />
            </a>
          )}
          {prep.look && <p className="text-xs leading-relaxed text-ink">{prep.look.firstImpression}</p>}
          {Object.keys(prep.filled).length > 0 && (
            <p className="mt-2 text-[11px] text-muted">
              Filled in on their record: {Object.keys(prep.filled).join(", ")}.
            </p>
          )}
          {prep.notes.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
              {prep.notes.map((note, index) => (
                <li key={index}>· {note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {unseen && (
        <div className="rounded-2xl border border-warn-line bg-warn-surface p-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-warn-text">Nobody has seen their page</div>
          <p className="text-xs leading-relaxed text-warn-text">
            Their site was checked by machine but never photographed, so nothing is known about how it looks — the half a business owner
            actually cares about. What is left is technical detail, and an email built on that reads as trivia. Connect Apify under Lead
            Sources → Connection and look again.
          </p>
        </div>
      )}

      {result.prepError && (
        <p className="rounded-2xl border border-warn-line bg-warn-surface px-4 py-3 text-xs text-warn-text">
          Nobody could go and look at this business first, so the draft is working from the record alone: {result.prepError}
        </p>
      )}

      {/* The polish. */}
      {polish && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">Read and polished by {polish.polishedBy}</span>
            <Badge tone={polish.servesPurpose ? "positive" : "warn"}>
              {polish.servesPurpose ? "Does its job" : "Does not do its job yet"}
            </Badge>
            <span className="flex-1" />
            {result.beforePolish && (
              <button type="button" onClick={onToggle} className="font-mono text-[10px] uppercase tracking-[.12em] text-blue hover:underline">
                {showingOriginal ? "Use the polished version" : "Show the unpolished draft"}
              </button>
            )}
          </div>
          {polish.changes.length > 0 && (
            <>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-muted">What it changed</div>
              <ul className="space-y-1 text-xs text-muted">
                {polish.changes.map((change, index) => (
                  <li key={index} className="leading-relaxed">
                    · {change}
                  </li>
                ))}
              </ul>
            </>
          )}
          {polish.concerns.length > 0 && (
            <div className="mt-3 border-t border-line pt-2">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-warn-text">Still weak, before you send it</div>
              <ul className="space-y-1 text-xs text-warn-text">
                {polish.concerns.map((concern, index) => (
                  <li key={index} className="leading-relaxed">
                    · {concern}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {polish.added.length > 0 && (
            <div className="mt-2 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-xs text-danger-text">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em]">Added, and not in the facts — check before sending</div>
              <ul className="space-y-1">
                {polish.added.map((entry, index) => (
                  <li key={index}>· {entry}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {result.polishError && (
        <p className="rounded-2xl border border-warn-line bg-warn-surface px-4 py-3 text-xs text-warn-text">
          The plain-English pass did not run, so this is the draft as written: {result.polishError}
        </p>
      )}
    </div>
  );
}

