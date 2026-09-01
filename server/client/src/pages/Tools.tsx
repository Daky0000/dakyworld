import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, Drawer, EmptyState, Field, PageHeader, StatTile, StatusDot, Toggle } from "../components/ui";
import type {
  CatalogueResponse,
  CatalogueTool,
  McpServerList,
  McpServerRow,
  ToolAgents,
  ToolState,
  ToolStatus,
  ToolsResponse,
} from "../lib/types";

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
  const [granting, setGranting] = useState<string | null>(null);
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
        <div className="text-sm text-muted">Loading…</div>
      ) : tools.length === 0 ? (
        <EmptyState message="No tools reported. That usually means the API is still starting." />
      ) : (
        GROUPS.map((group) => {
          const list = tools.filter((t) => t.state === group.state);
          if (list.length === 0) return null;
          return (
            <section key={group.state} className="space-y-3">
              <div>
                <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-muted">{group.heading}</h2>
                <p className="mt-1 text-sm text-muted">{group.note}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {list.map((tool) => <ToolCard key={tool.key} tool={tool} />)}
              </div>
            </section>
          );
        })
      )}

      <Connections />

      {catalogue && <Catalogue catalogue={catalogue} onAssign={setGranting} />}

      <GrantDrawer toolKey={granting} onClose={() => setGranting(null)} />
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

      <p className="mt-2 text-sm text-muted">{tool.purpose}</p>

      {tool.needs && (
        <p className={`mt-3 px-3 py-2 text-sm ${
          tool.state === "NEEDS_KEY"
            ? "rounded-xl border border-warn-line bg-warn-surface text-warn-text"
            : "border border-line bg-sunken text-muted"
        }`}>
          {tool.needs}
        </p>
      )}

      {tool.tools.length > 0 && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[.12em] text-muted">
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
              className="font-mono text-[10px] uppercase tracking-[.12em] text-muted hover:text-ink hover:underline"
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
function Catalogue({ catalogue, onAssign }: { catalogue: CatalogueResponse; onAssign: (key: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-muted">The catalogue</h2>
          <p className="mt-1 text-sm text-muted">
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
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-muted">{group}</h3>
                <div className="grid gap-2 md:grid-cols-2">
                  {list.map((tool) => <CatalogueRow key={tool.key} tool={tool} onAssign={onAssign} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CatalogueRow({ tool, onAssign }: { tool: CatalogueTool; onAssign: (key: string) => void }) {
  return (
    <div className="rounded-xl border border-line bg-white px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot tone={tool.ready ? "ok" : "warn"} />
            <span className="truncate text-sm font-medium">{tool.name}</span>
          </div>
          <code className="mt-0.5 block font-mono text-[10px] text-muted">{tool.key}</code>
        </div>
        <div className="flex shrink-0 gap-1">
          {tool.spends && <Badge>$</Badge>}
          {/* The property that decides whether dry run matters for this tool. */}
          {tool.outward && <Badge tone="muted">outward</Badge>}
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{tool.purpose}</p>
      {!tool.ready && tool.blockedReason && (
        <p className="mt-1.5 text-xs text-warn-text">{tool.blockedReason}</p>
      )}
      <button
        type="button"
        onClick={() => onAssign(tool.key)}
        className="mt-2 font-mono text-[10px] uppercase tracking-[.1em] text-blue hover:underline"
      >
        Who can use it
      </button>
    </div>
  );
}

/**
 * Who may call this tool.
 *
 * The Agents screen answers "what may this agent do". This answers the same
 * question from the other side — "who can send email", "who can spend on
 * images" — which is the one you actually ask when a capability worries you.
 * Both write the same `toolkit` field: there is one grant and two ways of
 * looking at it, not two grants.
 */
function GrantDrawer({ toolKey, onClose }: { toolKey: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["tool-agents", toolKey],
    queryFn: () => api.get<ToolAgents>(`/tools/${encodeURIComponent(toolKey!)}/agents`),
    enabled: Boolean(toolKey),
  });

  const assign = useMutation({
    mutationFn: ({ agentKey, granted }: { agentKey: string; granted: boolean }) =>
      api.post(`/tools/${encodeURIComponent(toolKey!)}/agents`, { agentKey, granted }),
    onSuccess: () => {
      setNotice(null);
      void qc.invalidateQueries({ queryKey: ["tool-agents", toolKey] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const agents = data?.agents ?? [];
  const granted = agents.filter((agent) => agent.granted);

  return (
    <Drawer
      open={Boolean(toolKey)}
      onClose={() => {
        setNotice(null);
        onClose();
      }}
      title={data?.tool.name ?? "Tool"}
      subtitle={data ? `${granted.length} of ${agents.length} agents can call it` : undefined}
    >
      {!data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted">{data.tool.purpose}</p>

          <div className="flex flex-wrap gap-1.5">
            <Badge tone="muted">{data.tool.scope}</Badge>
            {data.tool.spends && <Badge>costs money</Badge>}
            {data.tool.outward && <Badge tone="muted">reaches outside</Badge>}
          </div>

          {(data.tool.spends || data.tool.outward) && (
            <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
              Granting this is not the same as letting an agent use it unattended — it still needs the autonomy level and dry run to allow
              it. Both are on the agent's own card.
            </p>
          )}

          {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}

          <div className="space-y-1">
            {agents.map((agent) => (
              <label
                key={agent.key}
                className={`flex cursor-pointer items-start gap-2.5 border px-2.5 py-2 transition-colors ${
                  agent.granted ? "border-blue/30 bg-blue/[.04]" : "border-line bg-white hover:bg-sunken"
                }`}
              >
                <input
                  type="checkbox"
                  checked={agent.granted}
                  disabled={assign.isPending}
                  onChange={() => assign.mutate({ agentKey: agent.key, granted: !agent.granted })}
                  className="mt-1 accent-blue"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{agent.name}</span>
                    <span className="text-xs text-muted">{agent.title}</span>
                    {agent.status !== "ACTIVE" && <Badge tone="muted">{agent.status.toLowerCase()}</Badge>}
                  </span>
                  {/* Granted and still unable to act is a different problem
                      from not granted, and needs a different fix.
                      Printed whenever there is a sentence — gated on
                      `mustDryRun` it stayed silent for an outright refusal,
                      which is the case somebody most needs to be told about. */}
                  {agent.granted && agent.permissionNote && (
                    <span className={`mt-0.5 block text-xs ${agent.allowed ? "text-muted" : "text-warn-text"}`}>
                      {agent.allowed ? "" : "Cannot right now — "}
                      {agent.permissionNote}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

// --- Connected tools (MCP) -------------------------------------------------

/**
 * Servers this app has been pointed at.
 *
 * The catalogue is code on purpose — what a tool *does* is behaviour, and
 * behaviour editable at runtime is behaviour nobody can review. This is how a
 * capability gets added without breaking that: a connected server declares its
 * own tools, and each becomes a grantable entry called through the same
 * invoker, the same autonomy gate and the same audit trail as a built-in one.
 * What is configured here is which servers are trusted and how far — a
 * permission, which is exactly the kind of thing that belongs in a screen.
 */
function Connections() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<McpServerRow | null>(null);

  const { data } = useQuery({ queryKey: ["mcp"], queryFn: () => api.get<McpServerList>("/mcp") });

  const refresh = useMutation({
    mutationFn: (id: string) => api.post(`/mcp/${id}/refresh`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mcp"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/mcp/${id}`, { enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mcp"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  const servers = data?.servers ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[.16em] text-muted">Connected tools</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Anything that speaks MCP. Its tools join the catalogue and are granted, called and audited exactly like the built-in ones — this
            is how a new capability arrives without a deploy. Image generation is the obvious one: connect a server that draws and{" "}
            <code className="font-mono text-xs">image.generate</code> starts working.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          Connect a server
        </Button>
      </div>

      <Presets />

      {servers.length === 0 ? (
        <EmptyState message="Nothing connected yet. The built-in tools work without this — a connection adds what this app doesn't do itself." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {servers.map((server) => (
            <Card key={server.id} className="h-full">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot tone={server.lastError ? "bad" : server.enabled ? "ok" : "idle"} />
                    <span className="font-display text-lg tracking-[-.02em]">{server.name}</span>
                  </div>
                  <code className="mt-0.5 block truncate font-mono text-[10px] text-muted">{server.url}</code>
                </div>
                <div className="flex shrink-0 gap-1">
                  {server.spends && <Badge>$</Badge>}
                  {server.outward && <Badge tone="muted">outward</Badge>}
                  <Badge tone="muted">{server.scope}</Badge>
                </div>
              </div>

              {server.purpose && <p className="mt-2 text-sm text-muted">{server.purpose}</p>}

              {server.lastError ? (
                <p className="mt-3 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{server.lastError}</p>
              ) : (
                <p className="mt-3 font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                  {server.toolCount} tool{server.toolCount === 1 ? "" : "s"}
                  {server.hasAuth ? " · authorised" : " · no credential"}
                </p>
              )}

              {server.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {server.tools.slice(0, 6).map((tool) => (
                    <span key={tool.name} title={tool.description ?? undefined} className="rounded-xl border border-line bg-cream px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      {tool.name}
                    </span>
                  ))}
                  {server.tools.length > 6 && <span className="px-1 py-0.5 text-[10px] text-muted">+{server.tools.length - 6}</span>}
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Toggle
                  checked={server.enabled}
                  onChange={(enabled) => toggle.mutate({ id: server.id, enabled })}
                  label={server.enabled ? "Agents may call it" : "Switched off"}
                />
                <button
                  type="button"
                  onClick={() => refresh.mutate(server.id)}
                  disabled={refresh.isPending}
                  className="font-mono text-[10px] uppercase tracking-[.1em] text-muted transition hover:text-ink"
                >
                  {refresh.isPending ? "Checking…" : "Re-check"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(server)}
                  className="font-mono text-[10px] uppercase tracking-[.1em] text-muted transition hover:text-ink"
                >
                  Settings
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConnectionDrawer open={adding} server={null} onClose={() => setAdding(false)} />
      <ConnectionDrawer open={Boolean(editing)} server={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

/**
 * Connecting one, or changing what it is trusted with.
 *
 * The three risk settings are the point of the form. A server telling us its
 * tool only reads is a server telling us it may act with nobody watching, so
 * they are set here and read from here — see the server's
 * services/tools/mcpTools.ts.
 */
function ConnectionDrawer({ open, server, onClose }: { open: boolean; server: McpServerRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    key: "",
    name: "",
    purpose: "",
    url: "",
    authHeader: "",
    scope: "read" as McpServerRow["scope"],
    spends: false,
    outward: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    setWarning(null);
    setForm({
      key: server?.key ?? "",
      name: server?.name ?? "",
      purpose: server?.purpose ?? "",
      url: server?.url ?? "",
      // Never read back — a credential that can be displayed is a credential
      // that leaks. Blank leaves the stored one alone.
      authHeader: "",
      scope: server?.scope ?? "read",
      spends: server?.spends ?? false,
      outward: server?.outward ?? false,
    });
  }, [open, server]);

  const done = (result: { error?: string | null }) => {
    void qc.invalidateQueries({ queryKey: ["mcp"] });
    void qc.invalidateQueries({ queryKey: ["tools"] });
    if (result.error) {
      setWarning(result.error);
      return;
    }
    onClose();
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        purpose: form.purpose.trim() || null,
        url: form.url.trim(),
        scope: form.scope,
        spends: form.spends,
        outward: form.outward,
        ...(form.authHeader.trim() ? { authHeader: form.authHeader.trim() } : {}),
      };
      return server
        ? api.patch<{ server: McpServerRow; error: string | null }>(`/mcp/${server.id}`, body)
        : api.post<{ server: McpServerRow; error: string | null }>("/mcp", { ...body, key: form.key.trim() });
    },
    onSuccess: done,
    onError: (err: Error) => setNotice(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ revokedGrants: number }>(`/mcp/${server!.id}`),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["mcp"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      if (result.revokedGrants > 0) console.info(`[mcp] revoked ${result.revokedGrants} grant(s) with the connection.`);
      onClose();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  const ready = form.name.trim() && form.url.trim() && (server || /^[a-z][a-z0-9-]*$/.test(form.key.trim()));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={server ? server.name : "Connect a server"}
      subtitle={server ? "What it is trusted with" : "Anything that speaks MCP over HTTP"}
      footer={
        <div className="flex items-center justify-between gap-2">
          {server ? (
            <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={!ready || save.isPending}>
              {save.isPending ? "Connecting…" : server ? "Save" : "Connect"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {notice && <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{notice}</p>}
        {warning && (
          <p className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">
            Saved, but the server didn't answer: {warning}
          </p>
        )}

        <Field label="Name" full hint="What you call it. Appears on every tool it contributes.">
          <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>

        {!server && (
          <Field
            label="Key"
            full
            hint="Lowercase, no spaces. It becomes part of every tool key — mcp.yourkey.toolname — and can't be changed afterwards without revoking every grant that names it."
          >
            <input
              className="input font-mono text-xs"
              placeholder="magnific"
              value={form.key}
              onChange={(event) => setForm({ ...form, key: event.target.value.toLowerCase() })}
            />
          </Field>
        )}

        <Field label="Endpoint" full hint="The MCP endpoint itself, not the service's homepage.">
          <input className="input font-mono text-xs" placeholder="https://…/mcp" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
        </Field>

        <Field
          label="Authorisation header"
          full
          hint={server?.hasAuth ? "A credential is stored. Leave blank to keep it, or paste a new one to replace it." : "Sent verbatim as the Authorization header — include the scheme."}
        >
          <input
            className="input font-mono text-xs"
            type="password"
            placeholder="Bearer sk-…"
            value={form.authHeader}
            onChange={(event) => setForm({ ...form, authHeader: event.target.value })}
          />
        </Field>

        <Field label="What it's for" full hint="Optional. A sentence, so the next person knows why it's connected.">
          <input className="input" value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} />
        </Field>

        <div className="overflow-hidden rounded-2xl border border-line bg-cream p-4">
          <h3 className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">What it's trusted with</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            These three decide how a call is gated, and they are read from here rather than from anything the server says about itself. A
            server describing its own tool as harmless is a server asking to act unwatched.
          </p>

          <div className="mt-3 space-y-3">
            <Field label="Riskiest thing its tools do">
              <select className="input" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value as McpServerRow["scope"] })}>
                <option value="read">Reads — fetches things, changes nothing</option>
                <option value="write">Writes — changes something we own</option>
                <option value="send">Sends — acts on the outside world</option>
                <option value="charge">Charges — moves money</option>
              </select>
            </Field>
            <Toggle checked={form.spends} onChange={(spends) => setForm({ ...form, spends })} label="Calls cost money" />
            <Toggle
              checked={form.outward}
              onChange={(outward) => setForm({ ...form, outward })}
              label="Calls are visible outside the company"
            />
          </div>
        </div>

        {!server && (
          <p className="rounded-xl border border-line bg-white px-3 py-2 text-xs text-muted">
            It arrives switched off. Connecting a server and letting agents call it are two decisions — turn it on once you've seen what it
            advertises.
          </p>
        )}
      </div>
    </Drawer>
  );
}

// --- Presets ---------------------------------------------------------------

interface Preset {
  key: string;
  name: string;
  url: string;
  purpose: string;
  scope: string;
  spends: boolean;
  outward: boolean;
  note: string;
  connected: boolean;
  credentialReady: boolean;
  credentialNote: string | null;
}

/**
 * Servers whose risk has already been decided.
 *
 * A preset is not a shortcut for typing a URL. The three fields that actually
 * matter on an MCP connection — scope, whether it spends, whether it reaches
 * outside the company — are read from our own row rather than from anything the
 * server says about itself, which is what stops a remote tool talking its way
 * past the autonomy gate. Apify is the clearest case: its `actors` group starts
 * real runs that cost real money, so the connection has to be marked as
 * spending before an agent is pointed at it, and getting that wrong by hand is
 * both easy and silent.
 *
 * Connected switched **off**, like every other connection: connecting a server
 * and letting agents call it are two decisions.
 */
function Presets() {
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["mcp-presets"], queryFn: () => api.get<{ presets: Preset[] }>("/mcp/presets") });

  const connect = useMutation({
    mutationFn: (key: string) => api.post<{ note: string }>(`/mcp/presets/${key}`),
    onSuccess: (result) => {
      setNote(result.note);
      void qc.invalidateQueries({ queryKey: ["mcp"] });
      void qc.invalidateQueries({ queryKey: ["mcp-presets"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
    },
    onError: (err: Error) => setNote(err.message),
  });

  const available = (data?.presets ?? []).filter((preset) => !preset.connected);
  if (available.length === 0) return note ? <p className="text-sm text-muted">{note}</p> : null;

  return (
    <div className="space-y-2">
      {available.map((preset) => (
        <Card key={preset.key} className="border-dashed">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display text-lg tracking-[-.02em]">{preset.name}</span>
                {preset.spends && <Badge>$</Badge>}
                <Badge tone="muted">{preset.scope}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted">{preset.purpose}</p>
              <p className="mt-1 text-sm text-muted">{preset.note}</p>
              {preset.credentialNote && (
                <p className={`mt-1 text-xs ${preset.credentialReady ? "text-muted" : "text-warn-text"}`}>{preset.credentialNote}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={connect.isPending || !preset.credentialReady}
              onClick={() => connect.mutate(preset.key)}
            >
              {connect.isPending ? "Connecting…" : `Connect ${preset.name}`}
            </Button>
          </div>
        </Card>
      ))}
      {note && <p className="text-sm text-muted">{note}</p>}
    </div>
  );
}
