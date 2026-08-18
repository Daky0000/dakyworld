import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Lead, LeadFieldDef, LeadGroup, LeadResearch } from "../lib/types";
import { CaptureTag, captureMethodLabel, useLeadFields } from "./LeadColumns";
import { TagChip, TagPicker, useTagLookup } from "./LeadTags";
import { ProposalWriter } from "./ProposalWriter";
import { Badge, Button, Drawer, Field, Money, RelativeTime, ScoreBar } from "./ui";

const STATUSES = ["NEW", "QUALIFYING", "QUALIFIED", "DISQUALIFIED", "CONVERTED", "LOST"];
const COMM_TYPES = ["CALL", "EMAIL", "MESSAGE", "MEETING"];

/**
 * Everything known about one lead. Scraped rows carry far more than the table
 * can show — address, rating, socials, which run found them — and this is
 * where that lands, next to the actions that move the lead forward.
 */
export function LeadDrawer({
  leadId,
  groups,
  onClose,
  onEmail,
}: {
  leadId: string | null;
  groups: LeadGroup[];
  onClose: () => void;
  /** Opens the composer on this lead. Handled by the page so the composer isn't nested inside a drawer. */
  onEmail?: (leadId: string) => void;
}) {
  const qc = useQueryClient();
  const { data: lead, isLoading } = useQuery({
    queryKey: ["lead", leadId],
    queryFn: () => api.get<Lead>(`/leads/${leadId}`),
    enabled: Boolean(leadId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["lead", leadId] });
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: ["lead-stats"] });
  };

  const update = useMutation({
    mutationFn: (body: Partial<Lead>) => api.patch<Lead>(`/leads/${leadId}`, body),
    onSuccess: invalidate,
  });

  const convert = useMutation({
    mutationFn: () => api.post<{ client: { id: string } }>(`/leads/${leadId}/convert`),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/leads/${leadId}`),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const [writing, setWriting] = useState(false);

  return (
    <>
    <Drawer
      open={Boolean(leadId)}
      onClose={onClose}
      title={lead?.contactName ?? (isLoading ? "Loading…" : "Lead")}
      subtitle={
        lead && (
          <span className="flex flex-wrap items-center gap-2">
            <CaptureTag method={lead.captureMethod} />
            <Badge tone="muted">{lead.source.replace(/_/g, " ")}</Badge>
            {lead.category && <span>{lead.category}</span>}
            {lead.city && <span>· {lead.city}</span>}
            <span>· added <RelativeTime value={lead.createdAt} /></span>
          </span>
        )
      }
      footer={
        lead && (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={lead.status}
              onChange={(event) => update.mutate({ status: event.target.value })}
              className="border border-ink/20 bg-white px-2 py-2 font-mono text-xs uppercase tracking-[.08em]"
            >
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            {onEmail && (
              <Button
                onClick={() => onEmail(lead.id)}
                disabled={!lead.contactEmail}
                title={lead.contactEmail ? `Write to ${lead.contactEmail}` : "No email address on this lead"}
              >
                Email
              </Button>
            )}
            {/* Opens the writer against this lead rather than sending the
                Owner to the Proposals page to pick it out of a list again. */}
            <Button variant="secondary" onClick={() => setWriting(true)}>
              Draft proposal
            </Button>
            {lead.client ? (
              <Link to={`/clients/${lead.client.id}`} className="font-mono text-xs uppercase tracking-[.12em] text-blue">
                View client →
              </Link>
            ) : (
              <Button variant="secondary" onClick={() => convert.mutate()} disabled={convert.isPending}>
                {convert.isPending ? "Converting…" : "Convert to client"}
              </Button>
            )}
            <span className="flex-1" />
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (confirm("Delete this lead? Logged communications go with it.")) remove.mutate();
              }}
              disabled={remove.isPending}
            >
              Delete
            </Button>
          </div>
        )
      }
    >
      {isLoading || !lead ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : (
        <div className="space-y-8">
          {convert.isError && <ErrorNote error={convert.error} />}
          {remove.isError && <ErrorNote error={remove.error} />}

          <Section title="Reach them">
            <DetailRow label="Email">
              {lead.contactEmail ? (
                <a className="text-blue hover:underline" href={`mailto:${lead.contactEmail}`}>
                  {lead.contactEmail}
                </a>
              ) : (
                <Missing />
              )}
            </DetailRow>
            <DetailRow label="Phone">
              {lead.contactPhone ? (
                <a className="text-blue hover:underline" href={`tel:${lead.contactPhone.replace(/\s/g, "")}`}>
                  {lead.contactPhone}
                </a>
              ) : (
                <Missing />
              )}
            </DetailRow>
            <DetailRow label="Website">
              {lead.website ? (
                <a className="break-all text-blue hover:underline" href={lead.website} target="_blank" rel="noreferrer">
                  {lead.website.replace(/^https?:\/\//, "")}
                </a>
              ) : (
                // No website is the pitch, not a gap — say so.
                <span className="text-ink/60">None found — a build is the obvious opening</span>
              )}
            </DetailRow>
            {lead.socialLinks && Object.keys(lead.socialLinks).length > 0 && (
              <DetailRow label="Social">
                <span className="flex flex-wrap gap-3">
                  {Object.entries(lead.socialLinks).map(([network, url]) => (
                    <a key={network} href={url} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                      {network}
                    </a>
                  ))}
                </span>
              </DetailRow>
            )}
          </Section>

          <Section title="The business">
            <DetailRow label="Company">{lead.companyName ?? <Missing />}</DetailRow>
            <DetailRow label="Category">{lead.category ?? <Missing />}</DetailRow>
            <DetailRow label="Address">
              {lead.address ? (
                <span>
                  {lead.address}
                  {lead.latitude != null && lead.longitude != null && (
                    <a
                      className="ml-2 text-blue hover:underline"
                      href={`https://www.google.com/maps/search/?api=1&query=${lead.latitude},${lead.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      map ↗
                    </a>
                  )}
                </span>
              ) : (
                <Missing />
              )}
            </DetailRow>
            <DetailRow label="Location">
              {[lead.city, lead.region, lead.country].filter(Boolean).join(", ") || <Missing />}
            </DetailRow>
            <DetailRow label="Reputation">
              {lead.rating ? (
                <span>
                  {Number(lead.rating).toFixed(1)} ★ · {lead.reviewsCount ?? 0} reviews
                </span>
              ) : (
                <Missing />
              )}
            </DetailRow>
            <DetailRow label="Score">
              <ScoreBar score={lead.leadScore} />
            </DetailRow>
            <DetailRow label="Tags">
              <LeadTagsField lead={lead} onSave={(tags) => update.mutate({ tags })} pending={update.isPending} />
            </DetailRow>
          </Section>

          <Section title="Where it came from">
            <DetailRow label="Source">{lead.source.replace(/_/g, " ")}</DetailRow>
            <DetailRow label="How it got in">
              <Link to={`/leads?captureMethod=${lead.captureMethod}`} className="text-blue hover:underline">
                {captureMethodLabel(lead.captureMethod)}
              </Link>
            </DetailRow>
            <DetailRow label="Captured by">
              {lead.scraperSource ? (
                <Link to="/lead-sources" className="text-blue hover:underline">
                  {lead.scraperSource.name}
                </Link>
              ) : (
                <span className="text-ink/60">Added by hand</span>
              )}
            </DetailRow>
            {lead.scraperRun && (
              <DetailRow label="Run">
                <span>
                  {lead.scraperRun.trigger === "SCHEDULED" ? "Scheduled" : "Manual"} ·{" "}
                  <RelativeTime value={lead.scraperRun.startedAt} />
                </span>
              </DetailRow>
            )}
            <DetailRow label="Group">
              <select
                value={lead.groupId ?? ""}
                onChange={(event) => update.mutate({ groupId: event.target.value || null })}
                className="border border-ink/20 bg-white px-2 py-1 text-sm"
              >
                <option value="">Ungrouped</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </DetailRow>
          </Section>

          <ResearchSection lead={lead} onDone={invalidate} />

          <CustomFieldsForm lead={lead} onSave={(customFields) => update.mutate({ customFields })} pending={update.isPending} />

          <QualificationForm lead={lead} onSave={(body) => update.mutate(body)} pending={update.isPending} />

          <CommunicationsSection lead={lead} onLogged={invalidate} />

          {lead.enrichment && (
            <details className="rounded-2xl border border-line bg-white">
              <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">
                Raw scraped record
              </summary>
              <pre className="max-h-72 overflow-auto border-t border-ink/10 bg-ink/[.02] p-4 text-[11px] leading-relaxed text-ink/70">
                {JSON.stringify(lead.enrichment, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </Drawer>
    <ProposalWriter open={writing} lead={lead ?? null} onClose={() => setWriting(false)} />
    </>
  );
}

/**
 * The columns this lead's batch carries that aren't Lead scalars — everything
 * an imported sheet brought with it that the fixed schema has no home for.
 * Shown from the batch's own column set, plus any stray key the lead holds that
 * the set no longer lists, so nothing that was imported can go invisible.
 */
function CustomFieldsForm({
  lead,
  onSave,
  pending,
}: {
  lead: Lead;
  onSave: (values: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const { data: fieldSet } = useLeadFields(lead.groupId ?? null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);

  const defined: LeadFieldDef[] = (fieldSet?.fields ?? []).filter((field) => !field.builtin);
  const strays = Object.keys(lead.customFields ?? {})
    .filter((key) => !defined.some((field) => field.key === key))
    .map<LeadFieldDef>((key) => ({
      id: null,
      key,
      label: key.replace(/_/g, " "),
      type: "TEXT",
      builtin: false,
      hidden: false,
      position: 999,
      width: null,
    }));
  const fields = [...defined, ...strays];

  // Switching leads inside an open drawer must not carry the previous edits.
  useEffect(() => {
    setDraft(null);
  }, [lead.id]);

  if (!fields.length) return null;

  const valueOf = (field: LeadFieldDef) => {
    if (draft && field.key in draft) return draft[field.key];
    const raw = lead.customFields?.[field.key];
    return raw === null || raw === undefined ? "" : String(raw);
  };

  return (
    <Section title={fieldSet?.scope === "group" ? "This batch's own columns" : "Extra columns"}>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <Field key={field.key} label={field.label} full={field.type === "LONG_TEXT"}>
            {field.type === "LONG_TEXT" ? (
              <textarea
                rows={3}
                value={valueOf(field)}
                onChange={(event) => setDraft({ ...(draft ?? {}), [field.key]: event.target.value })}
                className="input"
              />
            ) : (
              <input
                value={valueOf(field)}
                onChange={(event) => setDraft({ ...(draft ?? {}), [field.key]: event.target.value })}
                className="input"
              />
            )}
          </Field>
        ))}
      </div>
      <div className="mt-3">
        <Button
          size="sm"
          disabled={!draft || pending}
          onClick={() => {
            if (draft) onSave(draft);
            setDraft(null);
          }}
        >
          {pending ? "Saving…" : draft ? "Save changes" : "Saved"}
        </Button>
      </div>
    </Section>
  );
}

function QualificationForm({
  lead,
  onSave,
  pending,
}: {
  lead: Lead;
  onSave: (body: Partial<Lead>) => void;
  pending: boolean;
}) {
  const [dealSize, setDealSize] = useState(lead.estimatedDealSize ?? "");
  const [notes, setNotes] = useState(lead.discoveryNotes ?? "");

  // Switching leads inside an open drawer must not carry the previous one's edits.
  useEffect(() => {
    setDealSize(lead.estimatedDealSize ?? "");
    setNotes(lead.discoveryNotes ?? "");
  }, [lead.id, lead.estimatedDealSize, lead.discoveryNotes]);

  const dirty = (lead.estimatedDealSize ?? "") !== dealSize || (lead.discoveryNotes ?? "") !== notes;

  return (
    <Section title="Qualification">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Estimated deal size (GHS)">
          <input
            type="number"
            min="0"
            value={dealSize}
            onChange={(event) => setDealSize(event.target.value)}
            className="input"
          />
        </Field>
        <Field label="Current value">
          <div className="py-2 text-sm">
            {lead.estimatedDealSize ? <Money amount={lead.estimatedDealSize} /> : <Missing />}
          </div>
        </Field>
        <Field label="Discovery notes" full>
          <textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} className="input" />
        </Field>
      </div>
      <div className="mt-3">
        <Button
          size="sm"
          disabled={!dirty || pending}
          onClick={() =>
            onSave({
              estimatedDealSize: dealSize === "" ? null : (Number(dealSize) as unknown as string),
              discoveryNotes: notes || null,
            })
          }
        >
          {pending ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </Button>
      </div>
    </Section>
  );
}

function CommunicationsSection({ lead, onLogged }: { lead: Lead; onLogged: () => void }) {
  const [type, setType] = useState("CALL");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState("");

  const log = useMutation({
    mutationFn: () => api.post(`/leads/${lead.id}/communications`, { type, summary, outcome: outcome || null }),
    onSuccess: () => {
      setSummary("");
      setOutcome("");
      onLogged();
    },
  });

  return (
    <Section title="Contact history">
      <form
        className="mb-4 grid gap-3 rounded-2xl border border-line bg-white p-4 sm:grid-cols-[8rem_1fr]"
        onSubmit={(event) => {
          event.preventDefault();
          if (summary.trim()) log.mutate();
        }}
      >
        <select value={type} onChange={(event) => setType(event.target.value)} className="input">
          {COMM_TYPES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="What happened?"
          className="input"
        />
        <input
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          placeholder="Outcome (optional)"
          className="input sm:col-span-2"
        />
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" disabled={!summary.trim() || log.isPending}>
            {log.isPending ? "Logging…" : "Log contact"}
          </Button>
        </div>
      </form>

      {!lead.communications || lead.communications.length === 0 ? (
        <p className="text-sm text-ink/50">Nothing logged yet.</p>
      ) : (
        <ol className="space-y-3">
          {lead.communications.map((entry) => (
            <li key={entry.id} className="border-l-2 border-ink/10 pl-4">
              <div className="flex items-center gap-2">
                <Badge tone="muted">{entry.type}</Badge>
                <span className="text-xs text-ink/40">
                  <RelativeTime value={entry.occurredAt} />
                  {entry.loggedBy && ` · ${entry.loggedBy.name}`}
                </span>
              </div>
              <p className="mt-1 text-sm">{entry.summary}</p>
              {entry.outcome && <p className="text-xs text-ink/50">→ {entry.outcome}</p>}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/**
 * What was found by going and looking at this business.
 *
 * The em-dashes in "The business" above are the problem this answers. A lead
 * arrives with a name, an email and blanks where the trade, the address and
 * the reputation should be, and an email written from that record can only be
 * generic. This runs the research, fills the blanks from live sources, checks
 * their site, photographs their homepage and shows the lot — with the evidence
 * beside every claim, because the Owner has to be able to check a sentence
 * before it goes out under their name.
 *
 * The screenshot is here rather than only in the composer deliberately. It is
 * the fastest way for a person to disagree with the model: one glance says
 * whether the page really does look ten years old.
 */
function ResearchSection({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const research = lead.research ?? null;
  const [error, setError] = useState<string | null>(null);

  const look = useMutation({
    mutationFn: () => api.post<unknown>(`/leads/${lead.id}/prepare`, {}),
    onMutate: () => setError(null),
    onSuccess: onDone,
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "The look failed"),
  });

  return (
    <Section title="What we found by looking">
      {!research ? (
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-sm text-ink/60">
            Nobody has looked at this business yet. Researching them fills the blanks above from live sources, checks their site and
            mail domain, and — if they have a website — photographs the homepage so a model can say what it looks like.
          </p>
          <p className="mt-2 text-[11px] text-ink/45">
            Nothing already on the record is overwritten. A contact address found by searching is offered, never applied.
          </p>
          <div className="mt-3">
            <Button size="sm" onClick={() => look.mutate()} disabled={look.isPending}>
              {look.isPending ? "Looking…" : "Look at them"}
            </Button>
          </div>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        </div>
      ) : (
        <ResearchDetail
          research={research}
          stale={Boolean(lead.researchStale)}
          strength={lead.caseStrength ?? null}
          onLookAgain={() => look.mutate()}
          pending={look.isPending}
          error={error}
        />
      )}
    </Section>
  );
}

/** What the strength of a case is called where a person reads it. */
const CASE_LABEL: Record<NonNullable<Lead["caseStrength"]>, string> = {
  STRONG: "Strong case",
  MODERATE: "Some case",
  WEAK: "Little to say",
  NONE: "Nothing to say",
};

function ResearchDetail({
  research,
  stale,
  strength,
  onLookAgain,
  pending,
  error,
}: {
  research: LeadResearch;
  stale: boolean;
  strength: Lead["caseStrength"];
  onLookAgain: () => void;
  pending: boolean;
  error: string | null;
}) {
  const findings = (research.audit?.findings ?? []).filter((finding) => finding.severity !== "GOOD");
  const good = (research.audit?.findings ?? []).filter((finding) => finding.severity === "GOOD");
  const filled = Object.entries(research.filled ?? {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink/50">
        <span>
          Looked at <RelativeTime value={research.ranAt} />
        </span>
        {research.research && (
          <Badge tone={research.research.searchedLiveSources ? "muted" : "warn"}>
            {research.research.researchedBy}
            {research.research.searchedLiveSources ? " · live sources" : " · from memory, not live sources"}
          </Badge>
        )}
        {stale && <Badge tone="warn">Out of date</Badge>}
        {strength && <Badge tone={strength === "STRONG" ? "positive" : strength === "MODERATE" ? "muted" : "warn"}>{CASE_LABEL[strength]}</Badge>}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={onLookAgain} disabled={pending}>
          {pending ? "Looking…" : "Look again"}
        </Button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}

      {/* The picture first: it is the fastest way to disagree with the model. */}
      {research.shot && (
        <a
          href={research.shot.imageUrl}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-2xl border border-line bg-white"
          title="Open the full screenshot"
        >
          <img src={research.shot.imageUrl} alt="Their homepage" className="max-h-72 w-full object-cover object-top" loading="lazy" />
          <span className="block border-t border-ink/10 px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
            Their homepage · {research.shot.width}×{research.shot.height}
            {research.shot.cropped ? " · top of page" : ""}
          </span>
        </a>
      )}

      {research.look && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-sm leading-relaxed text-ink/80">{research.look.firstImpression}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone={research.look.offerClear ? "muted" : "warn"}>
              {research.look.offerClear ? "Says what they sell" : "Does not say what they sell"}
            </Badge>
            <Badge tone={research.look.contactClear ? "muted" : "warn"}>
              {research.look.contactClear ? "Contact visible" : "No contact visible"}
            </Badge>
            {research.look.looksDated && <Badge tone="warn">Dated: {research.look.looksDated}</Badge>}
          </div>
          <ul className="mt-3 space-y-2 border-t border-ink/10 pt-3 text-xs text-ink/70">
            {research.look.observations.map((observation, index) => (
              <li key={index} className="leading-relaxed">
                <span className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/40">{observation.severity}</span>{" "}
                {observation.observed} <span className="text-ink/50">— {observation.soWhat}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-ink/10 pt-2 text-[11px] italic text-ink/55">
            Worth saying in the email: “{research.look.theOneThing}”
          </p>
        </div>
      )}

      {(findings.length > 0 || good.length > 0) && (
        <details className="rounded-2xl border border-line bg-white">
          <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">
            Checked on their site and domain ({findings.length} to fix{good.length ? `, ${good.length} already fine` : ""})
          </summary>
          <ul className="space-y-3 border-t border-ink/10 px-4 py-3 text-xs text-ink/70">
            {[...findings, ...good].map((finding) => (
              <li key={finding.id} className="leading-relaxed">
                <span className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/40">{finding.severity}</span>{" "}
                {finding.observed}
                <span className="block text-[11px] text-ink/40">Evidence: {finding.evidence}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {filled.length > 0 && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">Filled in by the scan</div>
          <ul className="space-y-1 text-xs text-ink/70">
            {filled.map(([field, entry]) => (
              <li key={field} className="leading-relaxed">
                <span className="text-ink/45">{field}:</span> {entry.value.slice(0, 160)}
                {entry.source.startsWith("http") && (
                  <a href={entry.source} target="_blank" rel="noreferrer" className="ml-2 text-blue hover:underline">
                    source ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {research.research?.proposedContact && (
        <div className="rounded-2xl border border-blue/30 bg-blue/[.05] p-4 text-xs text-ink/70">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[.12em] text-blue">Contact details found — not applied</div>
          {research.research.proposedContact.email && <div>Email: {research.research.proposedContact.email}</div>}
          {research.research.proposedContact.phone && <div>Phone: {research.research.proposedContact.phone}</div>}
          <p className="mt-1 text-[11px] text-ink/45">
            Copy these into the fields above if they are right. A searched-for address is the one mistake with no reviewer in front of
            it, so nothing writes it for you.
          </p>
        </div>
      )}

      {research.notes.length > 0 && (
        <ul className="space-y-1 text-[11px] text-ink/45">
          {research.notes.map((note, index) => (
            <li key={index}>· {note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The lead's tags, editable in place.
 *
 * Read-only until somebody clicks, because the common case is looking rather
 * than editing and a picker sitting open in a detail row is noise. `tags` on a
 * PATCH replaces the array wholesale, so the draft starts from what is there
 * and is saved whole.
 */
function LeadTagsField({ lead, onSave, pending }: { lead: Lead; onSave: (tags: string[]) => void; pending: boolean }) {
  const lookup = useTagLookup();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(lead.tags ?? []);

  // A bulk retag elsewhere can change these underneath an open drawer.
  const [loadedFor, setLoadedFor] = useState(lead.tags);
  useEffect(() => {
    if (loadedFor === lead.tags) return;
    setLoadedFor(lead.tags);
    if (!editing) setDraft(lead.tags ?? []);
  }, [lead.tags, loadedFor, editing]);

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        {(lead.tags ?? []).map((tag) => (
          <TagChip key={tag} slug={tag} lookup={lookup} />
        ))}
        {(lead.tags ?? []).length === 0 && <span className="text-ink/35">None</span>}
        <button
          type="button"
          onClick={() => {
            setDraft(lead.tags ?? []);
            setEditing(true);
          }}
          className="ml-1 font-mono text-[10px] uppercase tracking-[.14em] text-blue transition hover:underline"
        >
          Edit
        </button>
      </span>
    );
  }

  return (
    <span className="block">
      <TagPicker value={draft} onChange={setDraft} />
      <span className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            onSave(draft);
            setEditing(false);
          }}
        >
          {pending ? "Saving…" : "Save tags"}
        </Button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45"
        >
          Cancel
        </button>
      </span>
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 border-b border-ink/5 py-2 text-sm last:border-0">
      <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Missing() {
  return <span className="text-ink/30">—</span>;
}

function ErrorNote({ error }: { error: unknown }) {
  return (
    <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error instanceof Error ? error.message : "Something went wrong"}
    </p>
  );
}
