import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Demo, DemoStatus } from "../lib/types";
import { Badge, Button, PageHeader, RelativeTime } from "../components/ui";

/**
 * Every page built for a prospect.
 *
 * A demo is the argument a cold email cannot make in words: a business with no
 * website, looking at a page with their own name and their own services on it,
 * on their own phone. This is where those live — what was built, whether the
 * link has gone out, and whether they opened it.
 *
 * The last column is the one that changes what you do next. A demo sent four
 * days ago and never opened is a follow-up about the link; one opened three
 * times is a phone call.
 */

const STATUS_LABEL: Record<DemoStatus, string> = {
  DRAFT: "Draft",
  READY: "Ready to send",
  SENT: "Link sent",
  ACCEPTED: "They said yes",
  DECLINED: "Declined",
  ARCHIVED: "Archived",
};

const STATUS_TONE: Record<DemoStatus, "default" | "positive" | "muted" | "warn"> = {
  DRAFT: "muted",
  READY: "default",
  SENT: "default",
  ACCEPTED: "positive",
  DECLINED: "warn",
  ARCHIVED: "muted",
};

const STATUSES: DemoStatus[] = ["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"];

export function Demos() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<DemoStatus | "">("");

  const { data, isLoading } = useQuery({
    queryKey: ["demos", filter],
    queryFn: () => api.get<{ demos: Demo[]; base: string }>(`/demos${filter ? `?status=${filter}` : ""}`),
  });

  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DemoStatus }) => api.patch<Demo>(`/demos/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["demos"] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/demos/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["demos"] }),
  });

  const demos = data?.demos ?? [];

  return (
    <div>
      <PageHeader
        title="Demos"
        subtitle="Landing pages built for prospects. Each one lives at a public link you can send — unlisted, so only the people you give it to will find it."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter("")}
          className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] ${
            filter === "" ? "border-ink bg-ink text-cream" : "border-ink/20 text-ink/60 hover:border-ink/40"
          }`}
        >
          All
        </button>
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(status)}
            className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] ${
              filter === status ? "border-ink bg-ink text-cream" : "border-ink/20 text-ink/60 hover:border-ink/40"
            }`}
          >
            {STATUS_LABEL[status]}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-ink/50">Loading…</p>
      ) : demos.length === 0 ? (
        <div className="rounded-2xl border border-line bg-white p-6">
          <p className="text-sm text-ink/60">
            Nothing built yet. Open a lead with no website — or one whose site is the problem — and use <strong>Build a demo</strong>. It
            researches a design direction from real published work first, so the page is not the one every model produces.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {demos.map((demo) => (
            <div key={demo.id} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base">{demo.businessName}</h3>
                    <Badge tone={STATUS_TONE[demo.status]}>{STATUS_LABEL[demo.status]}</Badge>
                    {demo.version > 1 && <Badge tone="muted">v{demo.version}</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-ink/50">
                    {demo.title}
                    {demo.builtBy && <> · built by {demo.builtBy}</>}
                    {demo.lead && (
                      <>
                        {" · "}
                        <Link to={`/leads?lead=${demo.lead.id}`} className="text-blue hover:underline">
                          {demo.lead.contactName}
                        </Link>
                      </>
                    )}
                  </p>
                  <a href={demo.url} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all text-sm text-blue hover:underline">
                    {demo.url.replace(/^https?:\/\//, "")}
                  </a>
                </div>

                <div className="text-right text-xs text-ink/50">
                  {/* The number that decides the next move. */}
                  <div className={demo.views > 0 ? "text-ink" : ""}>
                    {demo.views > 0 ? `Opened ${demo.views} time${demo.views === 1 ? "" : "s"}` : "Not opened"}
                  </div>
                  {demo.lastViewedAt && (
                    <div>
                      last <RelativeTime value={demo.lastViewedAt} />
                    </div>
                  )}
                  {demo.sentAt && (
                    <div>
                      sent <RelativeTime value={demo.sentAt} />
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink/10 pt-3">
                <select
                  value={demo.status}
                  onChange={(event) => update.mutate({ id: demo.id, status: event.target.value as DemoStatus })}
                  className="border border-ink/20 bg-white px-2 py-1.5 font-mono text-[10px] uppercase tracking-[.08em]"
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
                <a href={demo.url} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="secondary">
                    Open it
                  </Button>
                </a>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(demo.url)}
                  className="font-mono text-[10px] uppercase tracking-[.12em] text-blue hover:underline"
                >
                  Copy link
                </button>
                <span className="flex-1" />
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Delete the demo for ${demo.businessName}? The link stops working immediately.`)) remove.mutate(demo.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
