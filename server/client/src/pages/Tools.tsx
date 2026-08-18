import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Card, EmptyState, PageHeader, StatTile, StatusDot } from "../components/ui";
import type { CatalogueResponse, CatalogueTool, ToolState, ToolStatus, ToolsResponse } from "../lib/types";

/**
 * What the agents can actually reach.
 *
 * Two halves, because they answer different questions. **Connections** is
 * "have I pasted the key" — one row per integration, and the only place a red
 * dot means work for you. **Tools** is "what can an agent do with it" — the
 * catalogue, which is what a grant on the Agents screen actually names.
 *
 * The third state this screen used to have, "not built yet", is gone: Slack,
 * Calendar, GitHub and inbound webhooks were the four things in it, and all
 * four are built. It survives in the type in case something is ever named
 * before it works again, and the section only renders if anything is in it.
 */

const GROUPS: Array<{ state: ToolState; heading: string; note: string }> = [
  { state: "NEEDS_KEY", heading: "Waiting on you", note: "Built and working — they just need a key or an account connected." },
  { state: "READY", heading: "Ready", note: "Configured and usable right now." },
  { state: "PLANNED", heading: "Not built yet", note: "Named in the blueprint. No code behind them, so no key will turn them on." },
];

const DOT: Record<ToolState, "ok" | "warn" | "idle"> = { READY: "ok", NEEDS_KEY: "warn", PLANNED: "idle" };

export function Tools() {
  const { data, isLoading } = useQuery({
    queryKey: ["tools"],
    queryFn: () => api.get<ToolsResponse>("/tools"),
  });
  const { data: catalogue } = useQuery({
    queryKey: ["tools", "catalogue"],
    queryFn: () => api.get<CatalogueResponse>("/tools/catalogue"),
  });

  const tools = data?.tools ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Agents"
        title="Tools"
        subtitle="Everything an agent can be given access to. Add a key here and every agent granted that tool can use it — nothing is switched on for them automatically."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Connections ready" value={data?.summary.ready ?? "—"} />
        <StatTile
          label="Waiting on a key"
          value={data?.summary.needsKey ?? "—"}
          sub={data?.summary.needsKey ? "you can fix these now" : undefined}
        />
        <StatTile
          label="Tools callable"
          value={data ? `${data.summary.callable} / ${data.summary.total}` : "—"}
          sub="what an agent could run right now"
        />
      </div>

      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : tools.length === 0 ? (
        <EmptyState message="No tools reported. That usually means the API is still starting." />
      ) : (
        GROUPS.map((group) => {
          const list = tools.filter((t) => t.state === group.state);
          if (list.length === 0) return null;
          return (
            <section key={group.state} className="space-y-3">
              <div>
                <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">{group.heading}</h2>
                <p className="mt-1 text-sm text-ink/50">{group.note}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {list.map((tool) => <ToolCard key={tool.key} tool={tool} />)}
              </div>
            </section>
          );
        })
      )}

      {catalogue && <Catalogue catalogue={catalogue} />}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolStatus }) {
  return (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={DOT[tool.state]} />
          <span className="font-display text-lg tracking-[-.02em]">{tool.name}</span>
        </div>
        {/* Spending money is the one property worth seeing before you read anything else. */}
        {tool.spends && <Badge>costs money</Badge>}
      </div>

      <p className="mt-2 text-sm text-ink/60">{tool.purpose}</p>

      {tool.needs && (
        <p className={`mt-3 px-3 py-2 text-sm ${
          tool.state === "NEEDS_KEY"
            ? "border border-amber-200 bg-amber-50 text-amber-800"
            : "border border-line bg-ink/[.02] text-ink/55"
        }`}>
          {tool.needs}
        </p>
      )}

      {tool.tools.length > 0 && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
          {tool.tools.length} tool{tool.tools.length === 1 ? "" : "s"}
          {tool.outwardTools > 0 && ` · ${tool.outwardTools} reach outside`}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {tool.scopes.map((scope) => (
            <Badge key={scope} tone="muted">{scope}</Badge>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* The quick way in, when a tool has one — Hostinger's mailbox is a
              token where SMTP is five fields. */}
          {tool.shortcut && tool.state !== "PLANNED" && (
            <Link to={tool.shortcut.to} className="font-mono text-[10px] uppercase tracking-[.12em] text-blue hover:underline">
              {tool.shortcut.label}
            </Link>
          )}
          {tool.settingsTab && tool.state !== "PLANNED" && (
            <Link
              to={`/settings?tab=${tool.settingsTab}`}
              className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/45 hover:text-ink hover:underline"
            >
              {tool.state === "NEEDS_KEY" ? "Set it up ↗" : "Change ↗"}
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * The catalogue: the individual things an agent calls, grouped the way the
 * work is grouped rather than by which vendor happens to provide them.
 */
function Catalogue({ catalogue }: { catalogue: CatalogueResponse }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">The catalogue</h2>
          <p className="mt-1 text-sm text-ink/50">
            {catalogue.summary.total} tools an agent can be granted. {catalogue.summary.outward} of them reach outside the company and{" "}
            {catalogue.summary.spending} spend money — those stay behind dry run until an agent is explicitly trusted with them.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 font-mono text-[10px] uppercase tracking-[.12em] text-blue hover:underline"
        >
          {open ? "Hide" : "Show all"}
        </button>
      </div>

      {open && (
        <div className="space-y-5">
          {catalogue.groups.map((group) => {
            const list = catalogue.tools.filter((tool) => tool.group === group);
            if (list.length === 0) return null;
            return (
              <div key={group}>
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-ink/35">{group}</h3>
                <div className="grid gap-2 md:grid-cols-2">
                  {list.map((tool) => <CatalogueRow key={tool.key} tool={tool} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CatalogueRow({ tool }: { tool: CatalogueTool }) {
  return (
    <div className="border border-line bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot tone={tool.ready ? "ok" : "warn"} />
            <span className="truncate text-sm font-medium">{tool.name}</span>
          </div>
          <code className="mt-0.5 block font-mono text-[10px] text-ink/40">{tool.key}</code>
        </div>
        <div className="flex shrink-0 gap-1">
          {tool.spends && <Badge>$</Badge>}
          {/* The property that decides whether dry run matters for this tool. */}
          {tool.outward && <Badge tone="muted">outward</Badge>}
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink/55">{tool.purpose}</p>
      {!tool.ready && tool.blockedReason && (
        <p className="mt-1.5 text-xs text-amber-700">{tool.blockedReason}</p>
      )}
    </div>
  );
}
