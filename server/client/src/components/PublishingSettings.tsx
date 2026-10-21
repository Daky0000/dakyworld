import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AppSettings, PublishRouteName, PublishingApp, PublishingField } from "../lib/types";
import { Badge, Button, Field, Toggle } from "./ui";

/**
 * Everything the Website Builder's faster publishing needs from outside.
 *
 * The publish router (server/docs/publish-router.md) was built reading these
 * from Railway variables, and the only list of what was missing was a runbook.
 * Each panel here is one of the runbook's steps: what it unlocks, the address to
 * paste into the other side, and the fields that come back. Following the
 * host's own deploy needs none of it, so every publish keeps working whatever
 * is blank here.
 */

type Settings = AppSettings["publishing"];
type Group = "githubApp" | "pagesApp" | "netlify" | "vercel";

function useSave() {
  const qc = useQueryClient();
  return (result: AppSettings) => qc.setQueryData(["settings"], result);
}

function Shell({ title, what, state, children }: { title: string; what: ReactNode; state: ReactNode; children?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">{what}</p>
      <div className="mt-4 border-y border-line py-4">{state}</div>
      {children}
    </section>
  );
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4">
      <p className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="rounded-[10px] break-all border border-line bg-cream px-2 py-1 font-mono text-xs">{value}</code>
        <button
          type="button"
          className="font-sans text-[11px] uppercase tracking-[.06em] text-blue transition hover:underline"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {hint && <p className="mt-1 max-w-2xl text-xs text-muted">{hint}</p>}
    </div>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  if (!(error instanceof Error)) return null;
  return <p className="mt-3 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error.message}</p>;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-blue hover:underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/**
 * One group's fields. A blank field keeps what is saved, so changing the slug
 * never means pasting the private key again; a field pinned by a Railway
 * variable is shown, not offered.
 */
function Credentials({ group, fields, columns = 2 }: { group: Group; fields: PublishingField[]; columns?: 2 | 3 }) {
  const save = useSave();
  const [values, setValues] = useState<Record<string, string>>({});
  const editable = fields.filter((field) => !field.envManaged);
  const pinned = fields.filter((field) => field.envManaged);
  const anySaved = editable.some((field) => field.set);

  const submit = useMutation({
    mutationFn: () => api.put<AppSettings>(`/settings/publishing/${group}`, { values }),
    onSuccess: (result) => {
      setValues({});
      save(result);
    },
  });
  const remove = useMutation({ mutationFn: () => api.delete<AppSettings>(`/settings/publishing/${group}`), onSuccess: save });

  return (
    <>
      <ul className="mt-4 grid gap-1.5 text-sm">
        {fields.map((field) => (
          <li key={field.id} className="flex flex-wrap items-center gap-2">
            <Badge tone={field.set ? "positive" : "muted"}>{field.set ? "set" : "missing"}</Badge>
            <span>{field.label}</span>
            {field.shown && <span className="font-mono text-xs text-muted">{field.shown}</span>}
            {field.envManaged && <span className="text-xs text-muted">from Railway · {field.env}</span>}
          </li>
        ))}
      </ul>
      {pinned.length > 0 && (
        <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-xs text-warn-text">
          {pinned.map((field) => field.env).join(", ")} {pinned.length === 1 ? "is" : "are"} set in Railway, so{" "}
          {pinned.length === 1 ? "it can't" : "they can't"} be edited here. Change {pinned.length === 1 ? "it" : "them"} in Railway, or
          remove the variable to manage it from this screen.
        </p>
      )}
      {editable.length > 0 && (
        <form
          className={`mt-4 grid gap-3 ${columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (Object.values(values).some((value) => value.trim())) submit.mutate();
          }}
        >
          {editable.map((field) => (
            <div key={field.id} className={field.multiline ? (columns === 3 ? "sm:col-span-3" : "sm:col-span-2") : undefined}>
              <Field label={field.set ? `Replace ${field.label}` : field.label}>
                {field.multiline ? (
                  <textarea
                    value={values[field.id] ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                    placeholder={field.set ? "Saved. Paste a new key only to replace it." : "-----BEGIN RSA PRIVATE KEY-----"}
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    className="input font-mono text-xs"
                  />
                ) : (
                  <input
                    type={field.secret ? "password" : "text"}
                    value={values[field.id] ?? ""}
                    onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                    placeholder={field.set && field.secret ? "Saved. Leave blank to keep it." : (field.shown ?? field.placeholder ?? "")}
                    autoComplete="off"
                    className={`input ${field.secret || field.id.endsWith("Id") ? "font-mono text-xs" : ""}`}
                  />
                )}
              </Field>
            </div>
          ))}
          <div className={`flex flex-wrap items-center gap-2 ${columns === 3 ? "sm:col-span-3" : "sm:col-span-2"}`}>
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? "Saving…" : "Save"}
            </Button>
            {anySaved && (
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Remove saved values
              </Button>
            )}
            <span className="text-xs text-muted">Blank fields keep what is saved.</span>
          </div>
        </form>
      )}
      <ErrorNote error={submit.error ?? remove.error} />
    </>
  );
}

/** What GitHub says about the app right now, asked as the app. */
function AppCheck({ app, need }: { app: PublishingApp; need: string }) {
  const save = useSave();
  const recheck = useMutation({ mutationFn: () => api.post<AppSettings>("/settings/publishing/recheck", {}), onSuccess: save });
  if (!app.configured) return null;
  const missing = app.permissions.filter((entry) => !entry.ok);
  return (
    <div className="mt-4 rounded-xl border border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {app.identity?.ok ? (
          <>
            <Badge tone="positive">GitHub accepts the key</Badge>
            <span>{app.identity.name}</span>
            <span className="font-mono text-xs text-muted">{app.identity.slug}</span>
          </>
        ) : (
          <>
            <Badge tone="danger">GitHub refused</Badge>
            <span className="text-danger-text">{app.identity?.error}</span>
          </>
        )}
        <Button variant="ghost" size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
          {recheck.isPending ? "Checking…" : "Check again"}
        </Button>
      </div>
      {app.identity?.ok && (
        <>
          <p className="mt-3 font-sans text-[11px] uppercase tracking-[.06em] text-muted">{need}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {app.permissions.map((entry) => (
              <li key={entry.key}>
                <Badge tone={entry.ok ? "positive" : "warn"}>
                  {entry.label}: {entry.level ?? "none"}
                </Badge>
              </li>
            ))}
          </ul>
          {missing.length > 0 && (
            <p className="mt-2 text-xs text-warn-text">
              Missing: {missing.map((entry) => entry.label).join(", ")}. Add {missing.length === 1 ? "it" : "them"} under{" "}
              <ExternalLink href={`https://github.com/organizations/dakyworld/settings/apps/${app.identity.slug}/permissions`}>
                Permissions &amp; events
              </ExternalLink>{" "}
              on GitHub, then press Check again.
            </p>
          )}
        </>
      )}
      <ErrorNote error={recheck.error} />
    </div>
  );
}

function Step({ ok, partial, children }: { ok: boolean; partial?: boolean; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Badge tone={ok ? "positive" : partial ? "warn" : "muted"}>{ok ? "done" : partial ? "partly" : "to do"}</Badge>
      <span>{children}</span>
    </li>
  );
}

function Overview({ publishing }: { publishing: Settings }) {
  const main = publishing.githubApp;
  const mainOk = main.configured && Boolean(main.identity?.ok);
  const readsOk = mainOk && main.permissions.every((entry) => entry.ok);
  const pagesOk = publishing.pagesApp.configured && Boolean(publishing.pagesApp.identity?.ok) && publishing.pagesApp.permissions.every((entry) => entry.ok);
  return (
    <Shell
      title="Publishing"
      what={
        <>
          What the Website Builder needs to make a publish go live faster. Without any of it, every publish still works: it commits
          to the customer's repository and follows their host's own deploy. Each key below switches on one faster route, and a route
          that fails falls back to following the host.
        </>
      }
      state={
        <ul className="grid gap-1.5 text-sm">
          <Step ok={mainOk} partial={main.configured}>
            The DakyXTech GitHub App: how customers connect a repository, and how publishes are followed
          </Step>
          <Step ok={readsOk} partial={mainOk}>
            Its six read permissions: live build progress and the host's own error words
          </Step>
          <Step ok={publishing.netlify.configured} partial={publishing.netlify.fields.some((field) => field.set)}>
            Netlify OAuth app: upload straight to Netlify sites
          </Step>
          <Step ok={publishing.vercel.configured} partial={publishing.vercel.fields.some((field) => field.set)}>
            Vercel Integration: upload straight to Vercel projects
          </Step>
          <Step ok={pagesOk} partial={publishing.pagesApp.configured}>
            DakyX Pages app: faster GitHub Pages builds, and a retry when a Pages build fails
          </Step>
        </ul>
      }
    >
      <p className="mt-4 max-w-2xl text-xs text-muted">
        Nothing else is needed. Cloudflare is not: the edge bridge was removed, and nothing DakyX runs sits between a visitor and a
        customer's host. Deploy hooks are per site, under that site's Website settings.
      </p>
    </Shell>
  );
}

function GithubAppPanel({ app }: { app: Settings["githubApp"] }) {
  return (
    <Shell
      title="DakyXTech GitHub App"
      what={
        <>
          The app customers install on their website repository. Every publish through an installation commits with it, and Route D
          reads GitHub's deployments, checks and statuses through it to show live build progress.
        </>
      }
      state={
        app.configured ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="positive">connected</Badge>
            <span>Publishing through installations is on.</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone="muted">not set up</Badge>
            <span>Sites publish with the shared token under Developer, or not at all.</span>
          </div>
        )
      }
    >
      <p className="mt-4 max-w-2xl text-sm text-muted">
        All six values are on the app's page:{" "}
        <ExternalLink href="https://github.com/organizations/dakyworld/settings/apps">GitHub → Settings → Developer settings → GitHub Apps</ExternalLink>.
        The App ID and Client ID are on General; generate a private key and a client secret there too. The webhook secret is whatever
        was typed into the app's Webhook section.
      </p>
      <CopyRow label="Callback URL" value={app.urls.callback} hint="Under Identifying and authorizing users. Tick “Request user authorization (OAuth) during installation”." />
      <CopyRow label="Webhook URL" value={app.urls.webhook} hint="Under Webhook. Active, with the same secret as below." />
      <Credentials group="githubApp" fields={app.fields} />
      <AppCheck app={app} need="Read permissions Route D needs (all read-only)" />
    </Shell>
  );
}

function NetlifyPanel({ netlify }: { netlify: Settings["netlify"] }) {
  return (
    <Shell
      title="Netlify"
      what={<>Lets a customer whose site is on Netlify press “Connect Netlify” once, after which each publish is uploaded straight to Netlify instead of waiting for its Git build.</>}
      state={
        netlify.configured ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="positive">connected</Badge>
            <span>The Connect Netlify button works.</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone="muted">not set up</Badge>
            <span>Netlify sites follow Netlify's own build.</span>
          </div>
        )
      }
    >
      <p className="mt-4 max-w-2xl text-sm text-muted">
        Create it in <ExternalLink href="https://app.netlify.com/user/applications">Netlify → User settings → Applications → OAuth → New OAuth app</ExternalLink>,
        with the redirect URI below. Netlify then shows the Client ID and Secret.
      </p>
      <CopyRow label="Redirect URI" value={netlify.urls.redirect} />
      <Credentials group="netlify" fields={netlify.fields} />
    </Shell>
  );
}

function VercelPanel({ vercel }: { vercel: Settings["vercel"] }) {
  return (
    <Shell
      title="Vercel"
      what={<>Lets a customer whose site is on Vercel connect it once; each publish is then deployed straight to Vercel instead of waiting for its Git build.</>}
      state={
        vercel.configured ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="positive">connected</Badge>
            <span>The Connect Vercel button works.</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone="muted">not set up</Badge>
            <span>Vercel sites follow Vercel's own build.</span>
          </div>
        )
      }
    >
      <p className="mt-4 max-w-2xl text-sm text-muted">
        Create an Integration in the <ExternalLink href="https://vercel.com/dashboard/integrations/console">Vercel Integrations Console</ExternalLink>{" "}
        with the redirect URL below and the scopes <strong>Projects: read</strong> and <strong>Deployments: read and write</strong>. The
        slug is the last part of the integration's address, vercel.com/integrations/<em>slug</em>.
      </p>
      <CopyRow label="Redirect URL" value={vercel.urls.redirect} />
      <Credentials group="vercel" fields={vercel.fields} columns={3} />
      {vercel.configured && (
        <p className="mt-3 max-w-2xl text-xs text-muted">
          Not yet proven: that the Integration's token can deploy to a project already connected to Git. Publish once to a test
          project; if the history does not say it was uploaded straight to the host, switch Direct upload off below.
        </p>
      )}
    </Shell>
  );
}

function PagesAppPanel({ app }: { app: Settings["pagesApp"] }) {
  return (
    <Shell
      title="DakyX Pages app"
      what={
        <>
          A second, opt-in GitHub App for sites on GitHub Pages. It alone holds Workflows, Pages and Actions write, so only a
          customer who turns on faster Pages builds is ever asked for them. It also lets a failed Pages build be retried once.
        </>
      }
      state={
        app.configured ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="positive">connected</Badge>
            <span>Customers can install it from Website settings.</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <Badge tone="muted">not set up</Badge>
            <span>GitHub Pages sites use Pages' own build.</span>
          </div>
        )
      }
    >
      <p className="mt-4 max-w-2xl text-sm text-muted">
        Create it from the server folder with <code className="font-mono text-xs">node scripts/createGithubApp.mjs --pages --org dakyworld</code>{" "}
        and press the button it opens. It writes a file with the three values below. Before telling customers about it, time it on a
        copy of a real site with <code className="font-mono text-xs">scripts/pagesTiming.mjs</code>; keep it only if it beats a
        plain Pages build by 10 seconds or more.
      </p>
      <CopyRow label="Setup URL" value={app.urls.setup} hint="Already set by the script. Shown here in case the app is made by hand." />
      <Credentials group="pagesApp" fields={app.fields} columns={2} />
      <AppCheck app={app} need="Write permissions it needs" />
    </Shell>
  );
}

const ROUTES: Array<{ id: PublishRouteName; label: string; blurb: string }> = [
  { id: "direct", label: "Direct upload", blurb: "Netlify and Vercel, for sites whose owner connected their account" },
  { id: "pages", label: "Faster Pages builds", blurb: "GitHub Pages, for sites with DakyX Pages installed" },
  { id: "hook", label: "Deploy hooks", blurb: "Calling a site's saved hook when its host does not deploy on its own" },
];

function RoutesPanel({ routes }: { routes: Settings["routes"] }) {
  const save = useSave();
  const toggle = useMutation({
    mutationFn: (disabled: PublishRouteName[]) => api.put<AppSettings>("/settings/publishing/routes", { disabled }),
    onSuccess: save,
  });
  return (
    <Shell
      title="Fast routes"
      what={<>The global switch for each faster route. Following the host's own deploy is always on; it is what every route falls back to. A site can also turn routes off for itself.</>}
      state={
        <ul className="grid gap-3">
          {ROUTES.map((route) => {
            const on = !routes.disabled.includes(route.id);
            return (
              <li key={route.id} className="flex flex-wrap items-center gap-3">
                {routes.envManaged ? (
                  <Badge tone={on ? "positive" : "muted"}>{on ? "on" : "off"}</Badge>
                ) : (
                  <Toggle
                    checked={on}
                    label={route.label}
                    onChange={(next) => toggle.mutate(next ? routes.disabled.filter((id) => id !== route.id) : [...routes.disabled, route.id])}
                  />
                )}
                {routes.envManaged && <span className="text-sm">{route.label}</span>}
                <span className="text-xs text-muted">{route.blurb}</span>
              </li>
            );
          })}
        </ul>
      }
    >
      {routes.envManaged && (
        <p className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-xs text-warn-text">
          Set by the <code className="font-mono">PUBLISH_ROUTES_DISABLED</code> variable in Railway, so it can't be switched here.
        </p>
      )}
      <ErrorNote error={toggle.error} />
    </Shell>
  );
}

export function PublishingPanels({ settings }: { settings: AppSettings }) {
  const publishing = settings.publishing;
  return (
    <div className="space-y-6">
      <Overview publishing={publishing} />
      <GithubAppPanel app={publishing.githubApp} />
      <NetlifyPanel netlify={publishing.netlify} />
      <VercelPanel vercel={publishing.vercel} />
      <PagesAppPanel app={publishing.pagesApp} />
      <RoutesPanel routes={publishing.routes} />
    </div>
  );
}
