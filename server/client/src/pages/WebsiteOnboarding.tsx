import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, Button } from "../components/ui";
import { useWebsiteSites } from "../components/WebsiteGuard";

/**
 * Getting a client's website ready, in the order it has to happen.
 *
 * Every line is worked out from the site as it actually is rather than ticked by
 * whoever did it, so the list cannot say "done" about something that has since
 * broken — a branch that stopped being readable goes back to blocked on its own.
 *
 * The audience is Dakyworld, not the client. This is the screen somebody works
 * down before handing a website over, and the last line is the handover itself,
 * which is the one thing here nothing can derive.
 */

type Step = {
  key: string;
  title: string;
  detail: string;
  state: "done" | "todo" | "blocked" | "attention";
  href?: string;
  action?: string;
};

type Onboarding = {
  site: { id: string; name: string; publicUrl: string };
  steps: Step[];
  readiness: string;
  readinessLabel: string;
  complete: boolean;
};

const MARK: Record<Step["state"], { glyph: string; className: string; tone: "positive" | "warn" | "muted" | "danger" }> = {
  done: { glyph: "✓", className: "bg-positive-surface text-positive-text", tone: "positive" },
  todo: { glyph: "•", className: "bg-sunken text-muted", tone: "muted" },
  attention: { glyph: "!", className: "bg-warn-surface text-warn-text", tone: "warn" },
  blocked: { glyph: "⚠", className: "bg-danger-surface text-danger-text", tone: "danger" },
};

export function WebsiteOnboarding() {
  const [params, setParams] = useSearchParams();
  const sites = useWebsiteSites();
  const [note, setNote] = useState("");
  const [handedOver, setHandedOver] = useState(false);

  const siteId = params.get("site") ?? sites.data?.[0]?.id ?? "";
  const onboarding = useQuery({
    queryKey: ["website", "onboarding", siteId],
    enabled: Boolean(siteId),
    queryFn: () => api.get<Onboarding>(`/website/sites/${siteId}/onboarding`),
  });

  const handover = useMutation({
    mutationFn: () => api.post(`/website/sites/${siteId}/onboarding/handover`, { note }),
    onSuccess: () => setHandedOver(true),
  });

  const done = onboarding.data?.steps.filter((step) => step.state === "done").length ?? 0;
  const total = onboarding.data?.steps.length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl tracking-[-.02em]">Onboarding</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Everything that has to be true before a client is given a website. Worked out from the site each time you open this, so
            nothing here can claim to be done after it has stopped being true.
          </p>
        </div>
        {(sites.data?.length ?? 0) > 1 && (
          <label className="text-xs text-muted">
            <span className="mb-1 block">Website</span>
            <select className="h-9 rounded-xl border border-line bg-white px-2 text-sm text-ink" value={siteId} onChange={(event) => setParams({ site: event.target.value })}>
              {sites.data?.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {onboarding.isLoading && <p className="text-sm text-muted">Checking the website…</p>}
      {onboarding.isError && (
        <p className="rounded-2xl border border-warn-line bg-warn-surface p-4 text-sm text-warn-text">
          {onboarding.error instanceof ApiError ? onboarding.error.message : "That website could not be checked."}
        </p>
      )}

      {onboarding.data && (
        <>
          <div className="rounded-2xl border border-line bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Badge tone={onboarding.data.complete ? "positive" : "warn"}>{onboarding.data.readinessLabel}</Badge>
                <span className="text-sm text-muted">
                  {done} of {total} done
                </span>
              </div>
              <a href={onboarding.data.site.publicUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
                {onboarding.data.site.publicUrl}
              </a>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-blue transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </div>
          </div>

          <ol className="space-y-2">
            {onboarding.data.steps.map((step, index) => (
              <li key={step.key} className="flex gap-3 rounded-2xl border border-line bg-white p-4">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${MARK[step.state].className}`} aria-hidden>
                  {MARK[step.state].glyph}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {index + 1}. {step.title}
                    </span>
                    {step.state !== "done" && <Badge tone={MARK[step.state].tone}>{step.state === "todo" ? "To do" : step.state === "attention" ? "Look at this" : "Blocked"}</Badge>}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{step.detail}</p>
                </div>
                {step.href && (
                  <Link to={step.href} className="shrink-0 self-center text-xs font-semibold text-blue underline-offset-2 hover:underline">
                    {step.action ?? "Open"}
                  </Link>
                )}
              </li>
            ))}
          </ol>

          <div className="rounded-2xl border border-line bg-white p-5">
            <h2 className="font-display text-base tracking-[-.02em]">Hand it over</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              The one thing on this page nothing can work out for itself: the conversation where the client is shown what they can
              change, what stays with a developer, and what happens when they publish. Record it when it has happened.
            </p>
            {handedOver ? (
              <p className="mt-3 text-sm text-positive-text">Recorded on this site's activity.</p>
            ) : (
              <>
                <textarea
                  className="mt-3 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue"
                  rows={2}
                  placeholder="Who it was handed to, and anything agreed about the developer-managed parts."
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <Button className="mt-2" size="sm" variant="accent" disabled={handover.isPending || !onboarding.data.complete} onClick={() => handover.mutate()}>
                  {handover.isPending ? "Recording…" : "Record the handover"}
                </Button>
                {!onboarding.data.complete && <p className="mt-2 text-xs text-muted">Finish the list above first.</p>}
              </>
            )}
          </div>

          <Button variant="ghost" size="sm" onClick={() => void onboarding.refetch()}>
            Check again
          </Button>
        </>
      )}
    </div>
  );
}
