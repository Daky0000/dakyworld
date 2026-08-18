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
  const [tab, setTab] = useState<"write" | "preview">("write");
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

      {/* Two halves of the same job: write it, then look at it. The preview is
          the server's own render, so what is shown here is what leaves — see
          EmailPreviewPane. */}
      {hasRecipient && (
        <div className="mb-5 flex gap-1.5 border-b border-ink/10">
          {(["write", "preview"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTab(option)}
              className={`-mb-px border-b-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] transition ${
                tab === option ? "border-ink text-ink" : "border-transparent text-ink/40 hover:text-ink/70"
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

          <AttachmentPanel attachments={attachments} onChange={setAttachments} />
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
  return "attachment";
}

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
 */
function AttachmentPanel({
  attachments,
  onChange,
}: {
  attachments: EmailAttachment[];
  onChange: (next: EmailAttachment[]) => void;
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

  return (
    <div className="mt-5 border-t border-ink/10 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
          Attachments{attachments.length > 0 ? ` (${attachments.length})` : ""}
        </span>
        <button
          type="button"
          onClick={() => setShowLink(!showLink)}
          className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/40 transition hover:text-ink"
        >
          {showLink ? "Hide link form" : "Attach a link instead"}
        </button>
      </div>

      {attachments.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {attachments.map((attachment, index) => {
            const size = "size" in attachment ? formatBytes(attachment.size) : null;
            const kind = "kind" in attachment && attachment.kind ? attachment.kind : "file";
            return (
              <div key={index} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <Badge tone="muted">{kind === "stored" ? "file" : kind}</Badge>
                  <span className="truncate">{attachmentLabel(attachment)}</span>
                  {size && <span className="shrink-0 text-xs text-ink/40">{size}</span>}
                  {(kind === "invoice" || kind === "proposal") && (
                    <span className="shrink-0 text-xs text-ink/40">rendered when it sends</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="shrink-0 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40 transition hover:text-ink"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}

      {uploading.map((name) => (
        <div key={name} className="mb-1.5 flex items-center gap-2 rounded-xl border border-blue/30 bg-blue/[.04] px-3 py-2 text-sm text-ink/60">
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
          dragging ? "border-blue bg-blue/[.06] text-ink" : "border-ink/20 text-ink/50 hover:border-ink/40 hover:text-ink/70"
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
          <span className="block text-xs text-ink/35">Up to {MAX_ATTACHMENT_MB} MB each</span>
        </span>
      </label>

      {error && <p className="mt-2 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

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
    return <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{(error as Error).message}</p>;
  }
  if (!data) return <p className="text-sm text-ink/50">Rendering…</p>;

  return (
    <div className="space-y-4">
      {/* The envelope: what the inbox row will say before anything is opened. */}
      <div className="rounded-2xl border border-line bg-white">
        <dl className="divide-y divide-ink/5 text-sm">
          <Row label="From">
            {data.from.name} <span className="text-ink/45">&lt;{data.from.email}&gt;</span>
          </Row>
          <Row label="To">
            {data.toName ? `${data.toName} ` : ""}
            <span className="text-ink/45">&lt;{data.toEmail}&gt;</span>
          </Row>
          <Row label="Subject">
            <span className="font-medium">{data.subject || <span className="text-ink/35">no subject</span>}</span>
          </Row>
          {data.attachments.length > 0 && (
            <Row label="Attached">
              <span className="flex flex-wrap gap-1.5">
                {data.attachments.map((attachment, index) => (
                  <span
                    key={index}
                    title={attachment.note ?? undefined}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-0.5 text-xs ${
                      attachment.missing ? "border-red-200 bg-red-50 text-red-700" : "border-line bg-cream text-ink/60"
                    }`}
                  >
                    {attachment.name}
                    {formatBytes(attachment.size) && <span className="text-ink/35">{formatBytes(attachment.size)}</span>}
                    {attachment.missing && <span>· missing</span>}
                  </span>
                ))}
              </span>
            </Row>
          )}
        </dl>
      </div>

      {data.unresolved.length > 0 && (
        <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Nothing fills {data.unresolved.map((name) => `{{${name}}}`).join(", ")} for this recipient — it will go out with the braces
          showing. Check the spelling, or write the words in.
        </p>
      )}

      {data.suppressed && (
        <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {data.toEmail} has unsubscribed ({data.suppressed}). Nothing will send to this address.
        </p>
      )}

      {data.historical && (
        <p className="border border-line bg-cream px-3 py-2 text-xs text-ink/55">
          This is the message exactly as it was sent, not a fresh render — a sent email is the record that it was sent.
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
          {isFetching ? "Rendering…" : "As it will arrive"}
        </span>
        <div className="flex gap-1.5">
          {(["desktop", "mobile"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setWidth(option)}
              className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.1em] transition ${
                width === option ? "border-ink bg-ink text-cream" : "border-ink/15 text-ink/50 hover:border-ink/40"
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
          className="h-[640px] rounded-xl border border-ink/10 bg-white transition-[width]"
          style={{ width: width === "mobile" ? 400 : "100%" }}
        />
      </div>

      <details className="rounded-2xl border border-line bg-white px-4 py-3">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
          The plain-text half
        </summary>
        <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-ink/60">{data.text}</p>
      </details>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 px-4 py-2">
      <dt className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
