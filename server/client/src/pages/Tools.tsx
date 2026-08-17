import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Card, EmptyState, PageHeader, StatTile, StatusDot } from "../components/ui";
import type { ToolState, ToolStatus, ToolsResponse } from "../lib/types";

/**
 * What the agents can actually reach.
 *
 * Three states rather than two, deliberately. "Needs a key" is something you
 * fix in a minute; "not built yet" is something I fix in a week. Collapsing
 * them into one red dot would have you hunting Settings for a Slack box that
 * doesn't exist.
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

  const tools = data?.tools ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Agents"
        title="Tools"
        subtitle="Everything an agent can be given access to. Add a key here and every agent granted that tool can use it — nothing is switched on for them automatically."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Ready" value={data?.summary.ready ?? "—"} />
        <StatTile
          label="Waiting on a key"
          value={data?.summary.needsKey ?? "—"}
          sub={data?.summary.needsKey ? "you can fix these now" : undefined}
        />
        <StatTile label="Not built yet" value={data?.summary.planned ?? "—"} sub="no key will help" />
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
