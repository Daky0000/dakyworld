import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AgentDetail, CompiledPrompt, OrganisedPrompt, ShippedPrompt, WriterBrief } from "../lib/types";
import { Button, Field } from "./ui";

/**
 * The instruction, as the model actually receives it.
 *
 * This screen used to draw the ten stored layers — ROLE, MISSION, SCOPE and the
 * rest — which is what the database holds and *not* what the agent is told. The
 * gap between those two was most of the prompt: who Dakyworld is, the company's
 * contact details, how to write, what the agent recalled about this client, and
 * the whole passage about tools, dry run and asking colleagues. None of it
 * authored here, all of it in front of the model.
 *
 * Worse, one of the ten layers is headed MEMORY and contains the sentence
 * "retain decisions, their reasons and their outcomes". That is an instruction
 * about memory, not a memory, and reading it as one makes the agent look like
 * it has a memory that cannot be seen or changed. The real memories are on the
 * panel below this.
 *
 * So the default view is the assembled prompt, in labelled regions, from the
 * same function the runner calls. One region is editable and the rest say where
 * they come from — which is the honest answer to "can I change this".
 *
 * Three things still make editing safe rather than reckless:
 *
 * 1. **The shipped wording is one click away.** Reset clears the prose written
 *    here and the ten layers underneath — never overwritten — take over again.
 * 2. **A deploy never overwrites it.** `ensureAgents()` only ever creates.
 * 3. **Nothing about permissions is in here.** The toolkit, the autonomy level
 *    and the dry-run flag are untouched by any edit or reset: what an agent is
 *    told to do and what it may reach are different decisions.
 */

/** What each layer is for, in the Owner's terms rather than the blueprint's. */
const LAYER_HELP: Record<string, string> = {
  role: "Who it is. One or two sentences — the job title and the business it works in.",
  mission: "What it is for. The outcome it exists to produce.",
  scope: "Where it stops. What it does not touch, and what goes back to its manager instead.",
  dataRules: "What it may treat as true, and how it separates what it observed from what it inferred.",
  tools: "How it should use what it has been granted.",
  policy: "The lines it must not cross, whatever it concludes.",
  process: "How it works through a job, in order. The most useful layer to edit.",
  escalateWhen: "What makes it stop and ask a person rather than continue.",
  output: "The shape of what it hands back, so every result is comparable to the last.",
  memory: "How it should decide what to keep between tasks. Not the memories themselves — those are below.",
};

export function AgentPromptEditor({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"read" | "prose" | "layers">("read");
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [toOrganise, setToOrganise] = useState("");
  const [organised, setOrganised] = useState<OrganisedPrompt | null>(null);

  const { data: compiled, isLoading } = useQuery({
    queryKey: ["agent-prompt", agent.key],
    queryFn: () => api.get<CompiledPrompt>(`/agents/${agent.key}/prompt/compiled`),
  });

  const [prose, setProse] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [mission, setMission] = useState(agent.mission);
  const [policy, setPolicy] = useState(agent.escalationPolicy ?? "");

  // Reload when the agent changes underneath — a reset returns fresh wording,
  // and the boxes must not keep showing the edit that was just undone. The
  // drawer stays mounted between agents, so this is a sentinel rather than a
  // remount.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!compiled) return;
    const stamp = `${agent.key}:${agent.promptEditedAt ?? ""}:${compiled.instruction.length}`;
    if (loadedFor === stamp) return;
    setLoadedFor(stamp);
    setProse(compiled.instruction);
    setDraft(compiled.prompt ?? {});
    setMission(agent.mission);
    setPolicy(agent.escalationPolicy ?? "");
  }, [compiled, agent.key, agent.mission, agent.escalationPolicy, agent.promptEditedAt, loadedFor]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["agent", agent.key] });
    void qc.invalidateQueries({ queryKey: ["agent-prompt", agent.key] });
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };

  const saveProse = useMutation({
    mutationFn: () => api.patch<{ appliesFrom?: string }>(`/agents/${agent.key}`, { promptText: prose.trim() || null }),
    onSuccess: (result) => {
      setNotice(null);
      setSaved(result.appliesFrom ? `Saved. It takes effect on ${result.appliesFrom}.` : "Saved.");
      setMode("read");
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const saveLayers = useMutation({
    mutationFn: () =>
      api.patch<{ appliesFrom?: string }>(`/agents/${agent.key}`, {
        prompt: draft,
        mission: mission.trim(),
        escalationPolicy: policy.trim() || null,
        // Writing the sections means the sections are the instruction again.
        // Leaving prose in place would silently ignore everything just typed.
        promptText: null,
      }),
    onSuccess: (result) => {
      setNotice(null);
      setSaved(result.appliesFrom ? `Saved. It takes effect on ${result.appliesFrom}.` : "Saved.");
      setMode("read");
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const reset = useMutation({
    mutationFn: () => api.post(`/agents/${agent.key}/prompt/reset`),
    onSuccess: () => {
      setNotice(null);
      setSaved("Put back to the wording this agent shipped with.");
      setMode("read");
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  // Fills the section boxes from what came back; nothing reaches the server
  // until Save is pressed, so a bad split is undone by not saving it.
  const organise = useMutation({
    mutationFn: () => api.post<OrganisedPrompt>(`/agents/${agent.key}/prompt/organise`, { text: toOrganise }),
    onSuccess: (result) => {
      setNotice(null);
      setOrganised(result);
      setDraft((current) => ({ ...current, ...result.layers }));
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const { data: shipped } = useQuery({
    queryKey: ["agent-shipped", agent.key],
    queryFn: () => api.get<ShippedPrompt>(`/agents/${agent.key}/prompt/shipped`),
    enabled: comparing && agent.resettable,
  });

  const layers = compiled?.layers ?? agent.promptLayers ?? [];
  const proseDirty = compiled ? prose.trim() !== compiled.instruction.trim() : false;
  const layersDirty =
    layers.some((layer) => (draft[layer] ?? "") !== (compiled?.prompt?.[layer] ?? "")) ||
    mission.trim() !== agent.mission ||
    policy.trim() !== (agent.escalationPolicy ?? "");

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Its system prompt</h3>
        {compiled?.overridden && (
          <span className="font-mono text-[9px] uppercase tracking-[.1em] text-blue" title="Written here, replacing the ten shipped sections">
            rewritten
          </span>
        )}
        {compiled && (
          <span className="font-mono text-[9px] uppercase tracking-[.1em] text-muted" title="Roughly what this costs to send before the task itself">
            ~{compiled.approxTokens.toLocaleString()} tokens
          </span>
        )}
        <span className="flex-1" />
        {mode === "read" ? (
          <>
            <button
              type="button"
              onClick={() => setMode("layers")}
              className="font-mono text-[10px] uppercase tracking-[.14em] text-muted transition hover:text-ink"
            >
              Edit as sections
            </button>
            <button
              type="button"
              onClick={() => setMode("prose")}
              className="font-mono text-[10px] uppercase tracking-[.14em] text-blue transition hover:underline"
            >
              Edit
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setMode("read")}
            className="font-mono text-[10px] uppercase tracking-[.14em] text-blue transition hover:underline"
          >
            Done
          </button>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted">Assembling what it is told…</p>}

      {mode === "read" && compiled && (
        <div className="space-y-3">
          <p className="rounded-xl border border-line bg-cream px-3 py-2 text-xs text-muted">
            This is the whole of what {agent.name} is told before every task. Only the first block is written by you — the rest is
            assembled when it runs, from the company profile, what it remembers, and what it is allowed to do.
          </p>

          {/*
            Where these words go, beyond this agent's own tasks.

            The panel exists because the screen used to answer only half the
            question. An agent's prompt governed its task runs; the cold email,
            the proposal and the audit sections were written by constants in the
            server that nothing here displayed — so a rewritten Cold Lead Writer
            showed new wording on this page and sent the old letter.

            `active` is the part worth being precise about. Until somebody edits
            this agent, the shipped doctrine is still what writes the
            deliverable, and the row says so rather than implying an authority
            the wording does not yet have.
          */}
          {compiled.writes && compiled.writes.length > 0 && (
            <div className="rounded-xl border border-line bg-white px-3 py-2">
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">What this wording writes</p>
              <p className="mt-0.5 text-[11px] text-muted">
                Not only {agent.name}'s own tasks. These are written elsewhere in the app, and this instruction is what writes them.
              </p>
              <ul className="mt-2 space-y-1">
                {compiled.writes.map((entry) => (
                  <li key={entry.job}>
                    <WriterBriefRow agentKey={agent.key} job={entry.job} label={entry.label} what={entry.what} outward={entry.outward} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {compiled.regions.map((region) => (
            <div key={region.key} className={region.editable ? "" : "border-l-2 border-line pl-3"}>
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">{region.label}</p>
                {!region.editable && (
                  <span className="font-mono text-[9px] uppercase tracking-[.1em] text-muted">assembled when it runs</span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-muted">{region.source}</p>
              <pre
                className={`mt-1 whitespace-pre-wrap break-words font-sans text-sm ${region.editable ? "text-ink" : "text-muted"}`}
              >
                {region.text}
              </pre>
            </div>
          ))}
        </div>
      )}

      {mode === "prose" && compiled && (
        <div className="space-y-4">
          <p className="rounded-xl border border-blue/25 bg-blue/5 px-3 py-2 text-sm text-ink">
            {compiled.overridden
              ? "You have written this agent's instruction yourself. The ten shipped sections are still underneath, untouched — Reset brings them back."
              : "This is the ten shipped sections, run together. Saving an edit here replaces them with what you write; the sections stay underneath so Reset can restore them."}{" "}
            A change takes effect on its next task. Nothing here can widen what the agent is allowed to reach.
          </p>

          <Field label="The instruction" full hint="Everything above the assembled blocks. Write it as you would brief a person.">
            <textarea rows={22} className="input font-mono text-[13px] leading-relaxed" value={prose} onChange={(event) => setProse(event.target.value)} />
          </Field>

          {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}
          {saved && !proseDirty && <p className="rounded-xl border border-positive-line bg-positive-surface px-3.5 py-2.5 text-sm text-positive-text">{saved}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <Button disabled={saveProse.isPending || !proseDirty} onClick={() => saveProse.mutate()}>
              {saveProse.isPending ? "Saving…" : "Save the instruction"}
            </Button>
            {proseDirty && (
              <button
                type="button"
                onClick={() => setProse(compiled.instruction)}
                className="font-mono text-[10px] uppercase tracking-[.14em] text-muted transition hover:text-ink"
              >
                Discard changes
              </button>
            )}
            <span className="flex-1" />
            {agent.resettable && <ResetButton pending={reset.isPending} onReset={() => reset.mutate()} />}
          </div>
        </div>
      )}

      {mode === "layers" && (
        <div className="space-y-4">
          <p className="rounded-xl border border-blue/25 bg-blue/5 px-3 py-2 text-sm text-ink">
            The ten sections the shipped agents are built from. Saving here makes them the instruction again
            {compiled?.overridden ? ", replacing the prose you wrote" : ""}. A change takes effect on the agent's next task.
          </p>

          {/*
            Paste doctrine, get sections.

            Without this the realistic outcome is everything going into
            `process`, because it is the only section big enough to take a page
            — which leaves a prompt that is one wall of text with nine empty
            headings above it. The model files the writing and changes not one
            word of it; nothing is saved until the founder reads the result and
            presses Save, because an organiser that wrote straight to the agent
            would be a model editing a prompt with nobody looking.
          */}
          <div className="rounded-xl border border-line bg-white px-3 py-3">
            <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">Paste an instruction and have it sorted</p>
            <p className="mt-0.5 text-[11px] text-muted">
              Write the doctrine however you write it — a playbook, a page of rules, a paste out of a document — and a model files it
              under the headings below. It copies your sentences and never rewrites them. Nothing is saved until you press Save sections.
            </p>
            <textarea
              rows={4}
              className="input mt-2"
              placeholder="Paste the instruction here…"
              value={toOrganise}
              onChange={(event) => setToOrganise(event.target.value)}
            />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button
                disabled={organise.isPending || !toOrganise.trim()}
                onClick={() => organise.mutate()}
              >
                {organise.isPending ? "Sorting…" : "Sort it into sections"}
              </Button>
              {organised && <span className="text-[11px] text-muted">Sorted by {organised.organisedBy}. Read it below, then save.</span>}
            </div>
            {organised?.note && <p className="mt-2 text-[11px] text-warn-text">{organised.note}</p>}
            {organised && organised.unplaced.length > 0 && (
              <div className="mt-2 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5">
                <p className="text-[11px] font-medium text-warn-text">It could not place these, so they were left out. Put them somewhere by hand:</p>
                <ul className="mt-1 space-y-0.5">
                  {organised.unplaced.map((line, index) => (
                    <li key={index} className="text-[11px] text-warn-text">
                      “{line}”
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <Field label="Mission" full hint="One sentence. Shown on the roster and put at the top of every brief.">
            <textarea rows={2} className="input" value={mission} onChange={(event) => setMission(event.target.value)} />
          </Field>

          {layers.map((layer) => (
            <Field key={layer} label={layer} full hint={LAYER_HELP[layer]}>
              <textarea
                rows={layer === "process" || layer === "role" ? 4 : 3}
                className="input"
                value={draft[layer] ?? ""}
                placeholder="Left blank, this section is skipped."
                onChange={(event) => setDraft((current) => ({ ...current, [layer]: event.target.value }))}
              />
            </Field>
          ))}

          <Field label="When it must stop and ask" full hint="Read by a person as much as by the agent — this is the promise about what it will never do alone.">
            <textarea rows={3} className="input" value={policy} onChange={(event) => setPolicy(event.target.value)} />
          </Field>

          {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}
          {saved && !layersDirty && <p className="rounded-xl border border-positive-line bg-positive-surface px-3.5 py-2.5 text-sm text-positive-text">{saved}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <Button disabled={saveLayers.isPending || !layersDirty} onClick={() => saveLayers.mutate()}>
              {saveLayers.isPending ? "Saving…" : "Save sections"}
            </Button>
            <span className="flex-1" />
            {agent.resettable && (
              <>
                <button
                  type="button"
                  onClick={() => setComparing((current) => !current)}
                  className="font-mono text-[10px] uppercase tracking-[.14em] text-muted transition hover:text-ink"
                >
                  {comparing ? "Hide shipped" : "Show shipped"}
                </button>
                <ResetButton pending={reset.isPending} onReset={() => reset.mutate()} />
              </>
            )}
          </div>

          {comparing && shipped && (
            <div className="rounded-xl space-y-3 border border-line bg-cream p-3">
              <p className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">The wording this agent shipped with</p>
              {shipped.layers
                .filter((layer) => shipped.prompt[layer]?.trim())
                .map((layer) => {
                  const changed = (shipped.prompt[layer] ?? "") !== (draft[layer] ?? "");
                  return (
                    <div key={layer} className={changed ? "border-l-2 border-blue pl-2" : ""}>
                      <p className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                        {layer}
                        {changed && <span className="ml-2 text-blue">changed</span>}
                      </p>
                      <p className="mt-0.5 text-sm text-muted">{shipped.prompt[layer]}</p>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ResetButton({ pending, onReset }: { pending: boolean; onReset: () => void }) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (confirm("Put this agent's instruction back to what it shipped with? Anything you have written here is lost. Its tools, autonomy and dry-run setting are not touched.")) {
          onReset();
        }
      }}
      className="font-mono text-[10px] uppercase tracking-[.14em] text-danger-text/70 transition hover:text-danger-text"
    >
      Reset to shipped
    </button>
  );
}

/**
 * The prompt that writes one deliverable — shown, and editable.
 *
 * This is the half the screen was missing. An agent's ten sections govern how
 * it *reasons through a task*; this governs what the cold email, the proposal
 * or an audit section actually says, which for most of this app is the only
 * part anybody outside ever reads. Both used to be called "the prompt" and
 * only one of them was on screen.
 *
 * It opens on the wording that is running right now — the founder's if they
 * have written one, the shipped default otherwise — rather than on a blank
 * box, because an editor that starts empty and silently replaces a doctrine
 * the moment you type into it is the same lie in a new place.
 *
 * Fetched only when opened. Fifteen briefs on one screen is fifteen requests
 * for text nobody has asked to read.
 */
function WriterBriefRow({
  agentKey,
  job,
  label,
  what,
  outward,
}: {
  agentKey: string;
  job: string;
  label: string;
  what: string;
  outward: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { data: brief, isLoading } = useQuery({
    queryKey: ["writer-brief", agentKey, job],
    queryFn: () => api.get<WriterBrief>(`/agents/${agentKey}/writes/${job}`),
    enabled: open,
  });

  useEffect(() => {
    if (!brief) return;
    const stamp = `${job}:${brief.source}:${brief.text.length}`;
    if (loadedFor === stamp) return;
    setText(brief.text);
    setLoadedFor(stamp);
  }, [brief, job, loadedFor]);

  const save = useMutation({
    mutationFn: () => api.put<{ appliesFrom?: string }>(`/agents/${agentKey}/writes/${job}`, { text }),
    onSuccess: (result) => {
      setNote(result.appliesFrom ?? "Saved.");
      setLoadedFor(null);
      qc.invalidateQueries({ queryKey: ["writer-brief", agentKey, job] });
      qc.invalidateQueries({ queryKey: ["agent-prompt", agentKey] });
    },
    onError: (err: Error) => setNote(err.message),
  });

  const dirty = brief ? text.trim() !== brief.text.trim() : false;

  return (
    <div className={open ? "rounded-xl border border-line bg-cream/40 px-3 py-2" : ""}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="text-left text-sm text-ink underline decoration-line underline-offset-4 transition hover:text-ink"
        >
          {label}
        </button>
        {outward && (
          <span className="font-mono text-[9px] uppercase tracking-[.1em] text-blue" title="Somebody outside Dakyworld reads this">
            goes outside
          </span>
        )}
        {brief && (
          <span
            className={`font-mono text-[9px] uppercase tracking-[.1em] ${brief.edited ? "text-blue" : "text-muted"}`}
            title={brief.explains}
          >
            {brief.edited ? "your wording" : "shipped wording"}
          </span>
        )}
        {!open && <span className="w-full text-[11px] text-muted">{what}</span>}
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-muted">{what}</p>
          {isLoading && <p className="text-sm text-muted">Reading what writes it…</p>}
          {brief && (
            <>
              <p className="text-[11px] text-muted">
                This is what the model is given, word for word. The format it has to return — the fields, the length, the rules that keep
                it honest — is kept separately and is never affected by anything you write here.
              </p>
              <textarea rows={14} className="input font-mono text-[12px]" value={text} onChange={(event) => setText(event.target.value)} />
              {note && <p className="rounded-xl border border-positive-line bg-positive-surface px-3.5 py-2.5 text-sm text-positive-text">{note}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <Button disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
                  {save.isPending ? "Saving…" : "Save this prompt"}
                </Button>
                {dirty && (
                  <button
                    type="button"
                    onClick={() => setText(brief.text)}
                    className="font-mono text-[10px] uppercase tracking-[.14em] text-muted transition hover:text-ink"
                  >
                    Undo
                  </button>
                )}
                <span className="flex-1" />
                {brief.edited && (
                  <button
                    type="button"
                    onClick={() => setText(brief.shipped)}
                    className="font-mono text-[10px] uppercase tracking-[.14em] text-muted transition hover:text-ink"
                    title="Loads the shipped wording into the box. Nothing changes until you save."
                  >
                    Put the shipped wording back
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
