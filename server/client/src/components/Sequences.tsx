import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { EmailEnrollment, EmailPurpose, EmailSequence, EmailTemplate, SequenceStep, SequenceTrigger } from "../lib/types";
import { Badge, Button, Card, EmptyState, Field, RelativeTime, StatusDot, Toggle } from "./ui";
import { PURPOSES } from "./EmailComposer";

/**
 * Sequences — the follow-ups that send themselves.
 *
 * The editor is arranged as a timeline rather than a form, because the only
 * question anyone has about a sequence is "what does this person receive, and
 * when" — and a list of rows with a delay field does not answer it at a
 * glance.
 */

const TRIGGERS: { value: SequenceTrigger; label: string; hint: string }[] = [
  { value: "MANUAL", label: "By hand", hint: "You add people to it yourself, from the pipeline." },
  { value: "LEAD_CREATED", label: "New lead arrives", hint: "Every scraped or imported lead that matches the filter below." },
  { value: "LEAD_STATUS_CHANGED", label: "Lead status changes", hint: "Not wired up yet — treat as manual." },
  { value: "PROPOSAL_SENT", label: "Proposal sent", hint: "Not wired up yet — treat as manual." },
  { value: "PROJECT_COMPLETED", label: "Project completed", hint: "Not wired up yet — treat as manual." },
  { value: "INVOICE_OVERDUE", label: "Invoice overdue", hint: "Not wired up yet — treat as manual." },
  { value: "CARE_PLAN_REVIEW_DUE", label: "Review due", hint: "Not wired up yet — treat as manual." },
];

export function Sequences() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EmailSequence | null>(null);
  const [showing, setShowing] = useState<string | null>(null);

  const { data: sequences, isLoading } = useQuery({
    queryKey: ["email-sequences"],
    queryFn: () => api.get<EmailSequence[]>("/emails/sequences/all"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["email-sequences"] });
    qc.invalidateQueries({ queryKey: ["email-status"] });
  };

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/emails/sequences/${id}`, { active }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/emails/sequences/${id}`), onSuccess: refresh });
  const runNow = useMutation({ mutationFn: () => api.post<{ sent: number }>("/emails/sequences/run-now"), onSuccess: refresh });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink/55">
          A sequence sends the follow-ups nobody remembers to send by hand. It stops on its own when someone replies, unsubscribes, or
          moves out of the pipeline.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            {runNow.isPending ? "Running…" : "Run due now"}
          </Button>
          <Button variant="secondary" onClick={() => setEditing(blankSequence())}>
            New sequence
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : !sequences || sequences.length === 0 ? (
        <EmptyState
          message="No sequences yet. The usual first one: three emails to every new scraped lead with no website, three days apart."
          action={<Button onClick={() => setEditing(starterSequence())}>Start with that one</Button>}
        />
      ) : (
        <div className="space-y-3">
          {sequences.map((sequence) => (
            <Card key={sequence.id} className="!p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot tone={sequence.active ? "ok" : "idle"} />
                    <h3 className="font-serif text-lg">{sequence.name}</h3>
                    <Badge tone={sequence.active ? "gold" : "muted"}>{sequence.active ? "Running" : "Paused"}</Badge>
                    <Badge tone="muted">{TRIGGERS.find((option) => option.value === sequence.trigger)?.label ?? sequence.trigger}</Badge>
                    {sequence.requireApproval && <Badge tone="muted">Approval first</Badge>}
                  </div>
                  {sequence.description && <p className="mt-1 text-sm text-ink/55">{sequence.description}</p>}

                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink/50">
                    {sequence.steps.map((step, index) => (
                      <span key={step.id ?? index} className="flex items-center gap-2">
                        {index > 0 && <span className="text-ink/25">→</span>}
                        <span className="border border-ink/10 bg-white px-2 py-1">
                          {index === 0 ? `after ${step.delayDays}d` : `+${step.delayDays}d`}
                          {step.useAi && <span className="ml-1 text-bronze">AI</span>}
                        </span>
                      </span>
                    ))}
                    {sequence.steps.length === 0 && <span className="italic">No steps yet</span>}
                  </div>

                  <div className="mt-3 text-xs text-ink/45">
                    {sequence.activeEnrollments ?? 0} in it now · {sequence._count?.enrollments ?? 0} ever · sends{" "}
                    {sequence.sendWindowStart}:00–{sequence.sendWindowEnd}:00 {sequence.weekdaysOnly ? "on weekdays" : "any day"}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowing(showing === sequence.id ? null : sequence.id)}>
                    {showing === sequence.id ? "Hide people" : "People"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(sequence)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant={sequence.active ? "secondary" : "primary"}
                    onClick={() => toggle.mutate({ id: sequence.id, active: !sequence.active })}
                    disabled={sequence.steps.length === 0}
                    title={sequence.steps.length === 0 ? "Add a step first" : undefined}
                  >
                    {sequence.active ? "Pause" : "Start"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(sequence.id)}>
                    Delete
                  </Button>
                </div>
              </div>

              {showing === sequence.id && <Enrollments sequenceId={sequence.id} />}
            </Card>
          ))}
        </div>
      )}

      {editing && <SequenceEditor sequence={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function blankSequence(): EmailSequence {
  return {
    id: "",
    name: "",
    description: "",
    trigger: "MANUAL",
    active: false,
    stopOnReply: true,
    requireApproval: false,
    sendWindowStart: 8,
    sendWindowEnd: 18,
    weekdaysOnly: true,
    timezone: "Africa/Accra",
    steps: [{ position: 0, delayDays: 0, useAi: true, purpose: "COLD_OUTREACH", aiBrief: "" }],
  };
}

/** The one everybody builds first, pre-filled so it takes a click rather than an afternoon. */
function starterSequence(): EmailSequence {
  return {
    ...blankSequence(),
    name: "New leads — no website",
    description: "Three emails to every new scraped lead that has no website.",
    trigger: "LEAD_CREATED",
    triggerFilter: { noWebsiteOnly: true, minScore: 40 },
    steps: [
      { position: 0, delayDays: 1, useAi: true, purpose: "COLD_OUTREACH", aiBrief: "Lead with the missing website. Ask for a short call." },
      { position: 1, delayDays: 4, useAi: true, purpose: "FOLLOW_UP", aiBrief: "Offer to send what we'd actually do, priced, before any call." },
      { position: 2, delayDays: 7, useAi: true, purpose: "FOLLOW_UP", aiBrief: "Last one. Make it easy to say no and say we won't write again." },
    ],
  };
}

// --- Editor ----------------------------------------------------------------

function SequenceEditor({ sequence, onClose, onSaved }: { sequence: EmailSequence; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<EmailSequence>(sequence);
  const [error, setError] = useState<string | null>(null);
  const { data: templateData } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => api.get<{ templates: EmailTemplate[] }>("/emails/templates/all"),
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        description: form.description || null,
        trigger: form.trigger,
        triggerFilter: form.triggerFilter ?? null,
        active: form.active,
        stopOnReply: form.stopOnReply,
        requireApproval: form.requireApproval,
        sendWindowStart: form.sendWindowStart,
        sendWindowEnd: form.sendWindowEnd,
        weekdaysOnly: form.weekdaysOnly,
        timezone: form.timezone,
        steps: form.steps.map((step, index) => ({
          position: index,
          delayDays: step.delayDays,
          templateId: step.templateId || null,
          subject: step.subject || null,
          bodyHtml: step.bodyHtml || null,
          useAi: step.useAi,
          aiBrief: step.aiBrief || null,
          purpose: step.purpose,
        })),
      };
      return form.id ? api.patch(`/emails/sequences/${form.id}`, body) : api.post("/emails/sequences", body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const filter = (form.triggerFilter ?? {}) as { noWebsiteOnly?: boolean; minScore?: number; status?: string; city?: string };
  const setFilter = (next: typeof filter) => setForm({ ...form, triggerFilter: next });

  const updateStep = (index: number, patch: Partial<SequenceStep>) =>
    setForm({ ...form, steps: form.steps.map((step, position) => (position === index ? { ...step, ...patch } : step)) });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto border border-ink/10 bg-ivory p-6">
        <h3 className="mb-1 font-serif text-2xl">{form.id ? "Edit sequence" : "New sequence"}</h3>
        <p className="mb-5 text-sm text-ink/55">Each step waits its own number of days, then sends inside the window below.</p>

        {error && <div className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" full>
            <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="What it's for" full>
            <input
              className="input"
              placeholder="Three emails to every new scraped lead with no website"
              value={form.description ?? ""}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>

          <Field label="Who goes into it" hint={TRIGGERS.find((option) => option.value === form.trigger)?.hint} full>
            <select className="input" value={form.trigger} onChange={(event) => setForm({ ...form, trigger: event.target.value as SequenceTrigger })}>
              {TRIGGERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          {form.trigger === "LEAD_CREATED" && (
            <div className="sm:col-span-2 grid gap-3 border border-ink/10 bg-white p-4 sm:grid-cols-3">
              <Field label="Minimum score">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="input"
                  value={filter.minScore ?? 0}
                  onChange={(event) => setFilter({ ...filter, minScore: Number(event.target.value) })}
                />
              </Field>
              <Field label="City (optional)">
                <input className="input" placeholder="Kumasi" value={filter.city ?? ""} onChange={(event) => setFilter({ ...filter, city: event.target.value })} />
              </Field>
              <div className="flex items-end pb-2">
                <Toggle
                  checked={Boolean(filter.noWebsiteOnly)}
                  onChange={(next) => setFilter({ ...filter, noWebsiteOnly: next })}
                  label="No website only"
                />
              </div>
            </div>
          )}

          <Field label="Send between" hint="Local hours, so nothing lands at 3am.">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={23}
                className="input"
                value={form.sendWindowStart}
                onChange={(event) => setForm({ ...form, sendWindowStart: Number(event.target.value) })}
              />
              <span className="text-ink/40">and</span>
              <input
                type="number"
                min={1}
                max={23}
                className="input"
                value={form.sendWindowEnd}
                onChange={(event) => setForm({ ...form, sendWindowEnd: Number(event.target.value) })}
              />
            </div>
          </Field>
          <Field label="Timezone">
            <input className="input" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} />
          </Field>

          <div className="sm:col-span-2 flex flex-wrap gap-6 border-t border-ink/10 pt-4">
            <Toggle checked={form.weekdaysOnly} onChange={(next) => setForm({ ...form, weekdaysOnly: next })} label="Weekdays only" />
            <Toggle checked={form.stopOnReply} onChange={(next) => setForm({ ...form, stopOnReply: next })} label="Stop when they reply" />
            <Toggle
              checked={form.requireApproval}
              onChange={(next) => setForm({ ...form, requireApproval: next })}
              label="Draft only — I approve each one"
            />
          </div>
        </div>

        {/* Steps */}
        <div className="mt-7">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="font-serif text-lg">Steps</h4>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setForm({
                  ...form,
                  steps: [...form.steps, { position: form.steps.length, delayDays: 4, useAi: true, purpose: "FOLLOW_UP", aiBrief: "" }],
                })
              }
            >
              Add step
            </Button>
          </div>

          <div className="space-y-3">
            {form.steps.map((step, index) => (
              <div key={index} className="border border-ink/10 bg-white p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">
                    Step {index + 1} · {index === 0 ? "after enrolment" : "after the step before"}
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={365}
                      className="control w-16"
                      value={step.delayDays}
                      onChange={(event) => updateStep(index, { delayDays: Number(event.target.value) })}
                    />
                    <span className="text-xs text-ink/45">days later</span>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, steps: form.steps.filter((_, position) => position !== index) })}
                      className="ml-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/35 hover:text-red-600"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="What this one is">
                    <select
                      className="input"
                      value={step.purpose}
                      onChange={(event) => updateStep(index, { purpose: event.target.value as EmailPurpose })}
                    >
                      {PURPOSES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Template (optional)">
                    <select className="input" value={step.templateId ?? ""} onChange={(event) => updateStep(index, { templateId: event.target.value || null })}>
                      <option value="">Write it here instead</option>
                      {(templateData?.templates ?? []).map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="mt-3">
                  <Toggle
                    checked={step.useAi}
                    onChange={(next) => updateStep(index, { useAi: next })}
                    label="Write each one with AI, from that person's record"
                  />
                </div>

                {step.useAi ? (
                  <div className="mt-3">
                    <Field label="Brief" hint="What this email should do. The recipient's own facts are supplied automatically." full>
                      <textarea
                        rows={2}
                        className="input"
                        placeholder="Lead with the missing website. Ask for a short call."
                        value={step.aiBrief ?? ""}
                        onChange={(event) => updateStep(index, { aiBrief: event.target.value })}
                      />
                    </Field>
                  </div>
                ) : (
                  !step.templateId && (
                    <div className="mt-3 space-y-2">
                      <input
                        className="input"
                        placeholder="Subject"
                        value={step.subject ?? ""}
                        onChange={(event) => updateStep(index, { subject: event.target.value })}
                      />
                      <textarea
                        rows={6}
                        className="input leading-relaxed"
                        placeholder="Body — {{first_name}}, {{company}}, {{city}}…"
                        value={step.bodyHtml ?? ""}
                        onChange={(event) => updateStep(index, { bodyHtml: event.target.value })}
                      />
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-ink/10 pt-5">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!form.name.trim() || form.steps.length === 0 || save.isPending}>
            {save.isPending ? "Saving…" : "Save sequence"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Enrollments -----------------------------------------------------------

function Enrollments({ sequenceId }: { sequenceId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["sequence-enrollments", sequenceId],
    queryFn: () => api.get<EmailEnrollment[]>(`/emails/sequences/${sequenceId}/enrollments`),
  });

  const stop = useMutation({
    mutationFn: (id: string) => api.post(`/emails/enrollments/${id}/stop`, { reason: "Stopped by hand" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequence-enrollments", sequenceId] });
      qc.invalidateQueries({ queryKey: ["email-sequences"] });
    },
  });

  if (isLoading) return <div className="mt-5 border-t border-ink/10 pt-4 text-sm text-ink/50">Loading…</div>;
  if (!data || data.length === 0) {
    return (
      <div className="mt-5 border-t border-ink/10 pt-4 text-sm text-ink/45">
        Nobody is in this sequence yet. Add people from the Leads page, or turn on the trigger above.
      </div>
    );
  }

  return (
    <div className="mt-5 max-h-80 overflow-y-auto border-t border-ink/10 pt-4">
      {data.map((enrollment) => (
        <div key={enrollment.id} className="flex items-center justify-between border-b border-ink/5 py-2 text-sm last:border-0">
          <div className="min-w-0">
            <span className="font-medium">{enrollment.lead?.contactName ?? enrollment.client?.name ?? enrollment.toEmail}</span>
            <span className="ml-2 text-xs text-ink/40">{enrollment.toEmail}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-ink/50">
            <span>{enrollment._count?.messages ?? 0} sent</span>
            {enrollment.status === "ACTIVE" ? (
              <>
                <span>
                  step {enrollment.nextPosition + 1} <RelativeTime value={enrollment.nextSendAt} />
                </span>
                <Button variant="ghost" size="sm" onClick={() => stop.mutate(enrollment.id)}>
                  Stop
                </Button>
              </>
            ) : (
              <Badge tone="muted">{enrollment.stopReason ?? enrollment.status}</Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
