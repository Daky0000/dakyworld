import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AgentDetail, CompiledPrompt, ShippedPrompt } from "../lib/types";
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
        <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Its system prompt</h3>
        {compiled?.overridden && (
          <span className="font-mono text-[9px] uppercase tracking-[.1em] text-blue" title="Written here, replacing the ten shipped sections">
            rewritten
          </span>
        )}
        {compiled && (
          <span className="font-mono text-[9px] uppercase tracking-[.1em] text-ink/30" title="Roughly what this costs to send before the task itself">
            ~{compiled.approxTokens.toLocaleString()} tokens
          </span>
        )}
        <span className="flex-1" />
        {mode === "read" ? (
          <>
            <button
              type="button"
              onClick={() => setMode("layers")}
              className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45 transition hover:text-ink"
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

      {isLoading && <p className="text-sm text-ink/45">Assembling what it is told…</p>}

      {mode === "read" && compiled && (
        <div className="space-y-3">
          <p className="border border-line bg-cream px-3 py-2 text-xs text-ink/55">
            This is the whole of what {agent.name} is told before every task. Only the first block is written by you — the rest is
            assembled when it runs, from the company profile, what it remembers, and what it is allowed to do.
          </p>

          {compiled.regions.map((region) => (
            <div key={region.key} className={region.editable ? "" : "border-l-2 border-line pl-3"}>
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">{region.label}</p>
                {!region.editable && (
                  <span className="font-mono text-[9px] uppercase tracking-[.1em] text-ink/25">assembled when it runs</span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-ink/35">{region.source}</p>
              <pre
                className={`mt-1 whitespace-pre-wrap break-words font-sans text-sm ${region.editable ? "text-ink/75" : "text-ink/50"}`}
              >
                {region.text}
              </pre>
            </div>
          ))}
        </div>
      )}

      {mode === "prose" && compiled && (
        <div className="space-y-4">
          <p className="border border-blue/25 bg-blue/5 px-3 py-2 text-sm text-ink/70">
            {compiled.overridden
              ? "You have written this agent's instruction yourself. The ten shipped sections are still underneath, untouched — Reset brings them back."
              : "This is the ten shipped sections, run together. Saving an edit here replaces them with what you write; the sections stay underneath so Reset can restore them."}{" "}
            A change takes effect on its next task. Nothing here can widen what the agent is allowed to reach.
          </p>

          <Field label="The instruction" full hint="Everything above the assembled blocks. Write it as you would brief a person.">
            <textarea rows={22} className="input font-mono text-[13px] leading-relaxed" value={prose} onChange={(event) => setProse(event.target.value)} />
          </Field>

          {notice && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}
          {saved && !proseDirty && <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{saved}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-ink/10 pt-3">
            <Button disabled={saveProse.isPending || !proseDirty} onClick={() => saveProse.mutate()}>
              {saveProse.isPending ? "Saving…" : "Save the instruction"}
            </Button>
            {proseDirty && (
              <button
                type="button"
                onClick={() => setProse(compiled.instruction)}
                className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45 transition hover:text-ink"
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
          <p className="border border-blue/25 bg-blue/5 px-3 py-2 text-sm text-ink/70">
            The ten sections the shipped agents are built from. Saving here makes them the instruction again
            {compiled?.overridden ? ", replacing the prose you wrote" : ""}. A change takes effect on the agent's next task.
          </p>

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

          {notice && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}
          {saved && !layersDirty && <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{saved}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-ink/10 pt-3">
            <Button disabled={saveLayers.isPending || !layersDirty} onClick={() => saveLayers.mutate()}>
              {saveLayers.isPending ? "Saving…" : "Save sections"}
            </Button>
            <span className="flex-1" />
            {agent.resettable && (
              <>
                <button
                  type="button"
                  onClick={() => setComparing((current) => !current)}
                  className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45 transition hover:text-ink"
                >
                  {comparing ? "Hide shipped" : "Show shipped"}
                </button>
                <ResetButton pending={reset.isPending} onReset={() => reset.mutate()} />
              </>
            )}
          </div>

          {comparing && shipped && (
            <div className="space-y-3 border border-line bg-cream p-3">
              <p className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">The wording this agent shipped with</p>
              {shipped.layers
                .filter((layer) => shipped.prompt[layer]?.trim())
                .map((layer) => {
                  const changed = (shipped.prompt[layer] ?? "") !== (draft[layer] ?? "");
                  return (
                    <div key={layer} className={changed ? "border-l-2 border-blue pl-2" : ""}>
                      <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">
                        {layer}
                        {changed && <span className="ml-2 text-blue">changed</span>}
                      </p>
                      <p className="mt-0.5 text-sm text-ink/60">{shipped.prompt[layer]}</p>
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
      className="font-mono text-[10px] uppercase tracking-[.14em] text-red-600/70 transition hover:text-red-600"
    >
      Reset to shipped
    </button>
  );
}
