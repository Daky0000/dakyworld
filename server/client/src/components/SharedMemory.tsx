import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AgentMemory, AgentMemoryKind, SharedMemoryList } from "../lib/types";
import { Button, Field } from "./ui";

/**
 * The company's memory — written once, read by every agent.
 *
 * Per-agent memory answered "what has this one worked out", and left a hole
 * where the obvious thing should have been: telling the whole workforce
 * something. "We do not take on unregistered businesses." "Always quote in
 * cedis." "Never promise a delivery date in December." Each of those had to be
 * typed into nineteen agents one at a time, and the agent hired next month
 * would never have heard any of them.
 *
 * **Sharing widens who sees a memory, never when it comes up.** Recall is still
 * by subject, so a shared note filed against one client surfaces on tasks about
 * that client and nowhere else. `company` is the subject for anything that
 * applies to all work — it is to shared memory what `self` is to an agent's own,
 * and it is the right choice nearly every time.
 */

const KINDS: { value: AgentMemoryKind; label: string; when: string }[] = [
  { value: "PREFERENCE", label: "How we work", when: "A standing instruction. The usual choice." },
  { value: "FACT", label: "A fact", when: "Something true about the business, a client or the market." },
  { value: "LESSON", label: "A lesson", when: "Something learnt the hard way that should not be repeated." },
  { value: "DECISION", label: "A decision", when: "A choice that was made, and why." },
  { value: "OUTCOME", label: "An outcome", when: "What came of something — the half that makes a decision worth keeping." },
];

export function SharedMemoryPanel() {
  const qc = useQueryClient();
  const [writing, setWriting] = useState(false);
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<AgentMemoryKind>("PREFERENCE");
  const [subject, setSubject] = useState("company");
  const [importance, setImportance] = useState(4);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["shared-memory"],
    queryFn: () => api.get<SharedMemoryList>("/agents/memory/shared"),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["shared-memory"] });
    // Every agent's drawer shows these too, so its list is stale as well.
    void qc.invalidateQueries({ queryKey: ["agent-memory"] });
  };

  const add = useMutation({
    mutationFn: () => api.post<AgentMemory>("/agents/memory/shared", { content: content.trim(), kind, subject: subject.trim() || "company", importance }),
    onSuccess: () => {
      setContent("");
      setNotice(null);
      setWriting(false);
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/agents/memory/shared/${id}`, body),
    onSuccess: () => {
      setEditing(null);
      setNotice(null);
      refresh();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/agents/memory/shared/${id}`),
    onSuccess: refresh,
    onError: (err: Error) => setNotice(err.message),
  });

  const memories = data?.memories ?? [];

  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-2xl">What every agent knows</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/60">
            Written once here and put in front of every agent, alongside whatever that one has worked out for itself. This is where a
            house rule goes — the thing you would otherwise have to tell each of them separately. An agent can add to it too, when it
            concludes something about how Dakyworld works rather than about its own way of working.
          </p>
        </div>
        <Button size="sm" onClick={() => setWriting((open) => !open)}>
          {writing ? "Cancel" : "Add one"}
        </Button>
      </div>

      {data && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[.14em] text-ink/35">
          {data.summary.total} shared · {data.summary.standing} on every task
          {data.summary.total - data.summary.standing > 0 && ` · ${data.summary.total - data.summary.standing} about a specific record`}
          {data.summary.neverUsed > 0 && ` · ${data.summary.neverUsed} never recalled`}
        </p>
      )}

      {writing && (
        <div className="mt-4 space-y-3 border border-blue/25 bg-blue/5 p-3">
          <Field label="What every agent should know" full>
            <textarea
              rows={3}
              className="input"
              placeholder="Quote every price in cedis. If a client asks for dollars, prepare it and hand it to a person."
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Kind" hint={KINDS.find((entry) => entry.value === kind)?.when}>
              <select value={kind} onChange={(event) => setKind(event.target.value as AgentMemoryKind)} className="input">
                {KINDS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="When it comes up" hint="Leave as company for a rule that applies to everything.">
              <input value={subject} onChange={(event) => setSubject(event.target.value)} className="input font-mono text-xs" placeholder="company" />
            </Field>
            <Field label="Importance" hint="5 for a rule that must never be crowded out of a prompt.">
              <select value={importance} onChange={(event) => setImportance(Number(event.target.value))} className="input">
                {[1, 2, 3, 4, 5].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <p className="text-xs text-ink/45">
            Never write a password, a token or an API key here — a memory is re-read into a prompt every time its subject comes up, and
            anything credential-shaped is refused.
          </p>

          <Button disabled={content.trim().length < 8 || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? "Saving…" : "Tell every agent"}
          </Button>
        </div>
      )}

      {notice && <p className="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}

      <div className="mt-5 space-y-1.5">
        {memories.length === 0 && !writing && (
          <p className="border border-line bg-cream px-3 py-2.5 text-sm text-ink/55">
            Nothing shared yet. Anything you would otherwise have to tell all of them one at a time belongs here.
          </p>
        )}

        {memories.map((memory) =>
          editing === memory.id ? (
            <EditRow
              key={memory.id}
              memory={memory}
              pending={update.isPending}
              onSave={(body) => update.mutate({ id: memory.id, body })}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div key={memory.id} className="flex items-start justify-between gap-3 border border-line bg-white px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-relaxed text-ink/75">{memory.content}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-[.1em] text-ink/35">
                  <span>{memory.kind.toLowerCase()}</span>
                  <code className="text-ink/40">{memory.subject}</code>
                  <span>importance {memory.importance}</span>
                  {memory.authorKey && memory.authorKey !== "owner" && <span>from {memory.authorKey}</span>}
                  <span className={memory.useCount === 0 ? "text-amber-700" : ""}>
                    {memory.useCount === 0 ? "never recalled" : `recalled ${memory.useCount}×`}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setEditing(memory.id)}
                  className="font-mono text-[10px] uppercase tracking-[.1em] text-ink/35 transition hover:text-ink"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("Delete this? Every agent stops being told it.")) remove.mutate(memory.id);
                  }}
                  className="font-mono text-[10px] uppercase tracking-[.1em] text-red-600/60 transition hover:text-red-600"
                >
                  Forget
                </button>
              </span>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

/**
 * Editing rather than deleting-and-retyping.
 *
 * A memory that has gone stale used to have one fix — delete it — which also
 * threw away the fact that it had ever been held and how often it had been
 * recalled. Correcting the wording keeps both.
 */
function EditRow({
  memory,
  pending,
  onSave,
  onCancel,
}: {
  memory: AgentMemory;
  pending: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState(memory.content);
  const [importance, setImportance] = useState(memory.importance);

  return (
    <div className="space-y-2 border border-blue/30 bg-blue/5 px-3 py-2.5">
      <textarea rows={3} className="input" value={content} onChange={(event) => setContent(event.target.value)} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/45">
          Importance
          <select value={importance} onChange={(event) => setImportance(Number(event.target.value))} className="input w-16">
            {[1, 2, 3, 4, 5].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={pending || content.trim().length < 8}
          onClick={() => onSave({ content: content.trim(), importance })}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        <button type="button" onClick={onCancel} className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/45">
          Cancel
        </button>
      </div>
      <p className="font-mono text-[9px] uppercase tracking-[.1em] text-ink/35">
        Applies to every agent, on their next task.
      </p>
    </div>
  );
}
