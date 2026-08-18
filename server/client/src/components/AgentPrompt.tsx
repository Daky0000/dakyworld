import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AgentDetail, ShippedPrompt } from "../lib/types";
import { Button, Field } from "./ui";

/**
 * The instruction, editable.
 *
 * An agent's prompt is the whole of what it is: ten layers saying who it is,
 * what it is for, where it stops, and what it must hand to a person. It used to
 * be read-only here for the built-in agents, on the grounds that shipped
 * wording is a diff — which left the Owner with two bad options for changing
 * how one of their own agents works: edit a TypeScript file, or hire a
 * duplicate agent and write the job out again.
 *
 * So it is editable, and three things make that safe rather than reckless:
 *
 * 1. **The shipped wording is one click away.** Reset restores every field from
 *    the seed. A change is only comfortable to make if it is comfortable to
 *    undo.
 * 2. **A deploy never overwrites it.** `ensureAgents()` only ever creates, so
 *    an edit survives every future release — the same contract the built-in
 *    email templates have always had.
 * 3. **Nothing about permissions is in here.** The toolkit, the autonomy level
 *    and the dry-run flag are elsewhere and untouched by any edit or reset:
 *    changing what an agent is told to do is a different decision from changing
 *    what it is allowed to reach.
 *
 * An edit takes effect on the agent's **next task** — the runner reads the row
 * rather than a cached copy — which the footer says plainly, because "saved"
 * and "in force" are not the same claim.
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
  memory: "What it keeps between tasks, and what it must never keep.",
};

export function AgentPromptEditor({ agent }: { agent: AgentDetail }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(agent.prompt ?? {});
  const [mission, setMission] = useState(agent.mission);
  const [policy, setPolicy] = useState(agent.escalationPolicy ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  // Reload when the agent changes underneath — a reset returns fresh wording,
  // and the boxes must not keep showing the edit that was just undone.
  const [loadedFor, setLoadedFor] = useState(agent.prompt);
  useEffect(() => {
    if (loadedFor === agent.prompt) return;
    setLoadedFor(agent.prompt);
    setDraft(agent.prompt ?? {});
    setMission(agent.mission);
    setPolicy(agent.escalationPolicy ?? "");
  }, [agent.prompt, agent.mission, agent.escalationPolicy, loadedFor]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["agent", agent.key] });
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ appliesFrom?: string }>(`/agents/${agent.key}`, {
        prompt: draft,
        mission: mission.trim(),
        escalationPolicy: policy.trim() || null,
      }),
    onSuccess: (result) => {
      setNotice(null);
      setSaved(result.appliesFrom ? `Saved. It takes effect on ${result.appliesFrom}.` : "Saved.");
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const reset = useMutation({
    mutationFn: () => api.post(`/agents/${agent.key}/prompt/reset`),
    onSuccess: () => {
      setNotice(null);
      setSaved("Put back to the wording this agent shipped with.");
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const { data: shipped } = useQuery({
    queryKey: ["agent-shipped", agent.key],
    queryFn: () => api.get<ShippedPrompt>(`/agents/${agent.key}/prompt/shipped`),
    enabled: comparing && agent.resettable,
  });

  const layers = agent.promptLayers ?? [];
  const dirty =
    layers.some((layer) => (draft[layer] ?? "") !== (agent.prompt?.[layer] ?? "")) ||
    mission.trim() !== agent.mission ||
    policy.trim() !== (agent.escalationPolicy ?? "");

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Its instructions</h3>
        {agent.promptEditedAt && (
          <span className="font-mono text-[9px] uppercase tracking-[.1em] text-blue" title="Rewritten here rather than shipped">
            edited
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="font-mono text-[10px] uppercase tracking-[.14em] text-blue transition hover:underline"
        >
          {open ? "Done" : "Edit"}
        </button>
      </div>

      {!open ? (
        <div className="space-y-3">
          {layers
            .filter((layer) => draft[layer]?.trim())
            .map((layer) => (
              <div key={layer}>
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/35">{layer}</p>
                <p className="mt-0.5 text-sm text-ink/70">{draft[layer]}</p>
              </div>
            ))}
          {layers.every((layer) => !draft[layer]?.trim()) && (
            <p className="border border-line bg-cream px-3 py-2.5 text-sm text-ink/55">
              No instructions written yet, so it works from its mission alone. Press Edit to give it a proper brief.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="border border-blue/25 bg-blue/5 px-3 py-2 text-sm text-ink/70">
            This is what the agent is told before every task, in this order. A change takes effect on its next task — it does not
            affect one already running. Permissions are separate: nothing here can widen what it is allowed to reach.
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
                placeholder="Left blank, this layer is skipped."
                onChange={(event) => setDraft((current) => ({ ...current, [layer]: event.target.value }))}
              />
            </Field>
          ))}

          <Field label="When it must stop and ask" full hint="Read by a person as much as by the agent — this is the promise about what it will never do alone.">
            <textarea rows={3} className="input" value={policy} onChange={(event) => setPolicy(event.target.value)} />
          </Field>

          {notice && <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}
          {saved && !dirty && <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{saved}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-ink/10 pt-3">
            <Button disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save instructions"}
            </Button>
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  setDraft(agent.prompt ?? {});
                  setMission(agent.mission);
                  setPolicy(agent.escalationPolicy ?? "");
                }}
                className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45 transition hover:text-ink"
              >
                Discard changes
              </button>
            )}
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
                <button
                  type="button"
                  disabled={reset.isPending}
                  onClick={() => {
                    if (confirm("Put this agent's wording back to what it shipped with? Your edits to it are lost.")) reset.mutate();
                  }}
                  className="font-mono text-[10px] uppercase tracking-[.14em] text-red-600/70 transition hover:text-red-600"
                >
                  Reset to shipped
                </button>
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
