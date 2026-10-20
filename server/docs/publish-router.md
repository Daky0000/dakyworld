# The publish router

How a Website Builder publish goes live, and what has to be set up outside this
repository before each faster route can be switched on. Built 20 Oct 2026 from
the plan "DakyX Publish Router: implementation plan".

Every customer presses **Publish** and nothing else. DakyX works out how the
site goes live and uses the fastest route that site has. A fast route that fails
falls back to following the host, so no publish is ever lost.

## The rules it keeps

1. DakyX never hosts a repository-backed customer site. The customer's host always serves it.
2. Nothing extra happens on each publish. Any permission is given once, and every faster route is optional.
3. Every site works on day one with no setup (Route D).
4. Every fast route falls back to Route D, and the customer is told plainly.
5. The patch-script option stays rejected.

The one rule that changed, approved by Dan on 20 Oct 2026, is in
`website-compatibility.md`: DakyX may deploy through a host's official deploy
API, only for sites with no build step, and only after the customer connected
their host account through the host's own sign-in. SFTP and FTP stay unsupported.

## The routes

| Route | What it does | Code | Needs, outside the repo |
|---|---|---|---|
| **D · Follow** | Commit, then watch the host deploy it until the live page shows it | `websitePublishJobs.ts`, `websiteDeployDetect.ts`, `websiteDeployWatch.ts`, `websiteDeployHook.ts` | The six read permissions on the GitHub App (below). It works without them, with less to say |
| **A · Direct** | Upload the changed files straight to Netlify or Vercel | `publishRoutes/direct*.ts`, `publishRoutes/hostConnect.ts` | A Netlify OAuth app and a Vercel Integration |
| **P · Pages** | GitHub Pages builds from DakyX's own workflow, skipping Jekyll | `publishRoutes/pagesActions.ts` | The DakyX Pages GitHub App, and the timing test passing |
| **B · Bridge** | A Cloudflare Worker serves the new files in front of the host within a second | `edge/`, `websiteEdgeBridge.ts` | A hosting domain on Cloudflare with Cloudflare for SaaS, and the Worker deployed |

`websitePublishRouter.ts` runs the faster routes after every commit, in the
order bridge, direct, pages, hook. It records on the publish job which route
made the change live (`route`), the faster route that failed first
(`fallbackFrom`), and every attempt (`routeLog`). The watcher follows every
publish whatever route it took.

**Off switches.**
- Globally: `PUBLISH_ROUTES_DISABLED=bridge,direct,pages,hook`, as a Railway variable or a setting.
- Per site: the "Faster routes on this site" list in Website settings.
- Following the host cannot be switched off.

## Route D, in detail

**Detection** (`websiteDeployDetect.ts`) reads five kinds of evidence and keeps
the result on `Site.deployProfile`:

- the live page's response headers;
- DNS;
- GitHub's deployments, check runs and commit statuses on recent commits;
- the repository's Pages settings, webhooks, workflows and config files;
- the last publishes.

It gives one of four answers:

- `auto`: the host deploys this branch on its own;
- `needs-hook`: the host does not pick up a commit by itself;
- `branch-mismatch`: the host deploys a different branch or folder, and the editor warns about it before anyone publishes;
- `unsure`: there is not enough evidence. It never guesses.

**When detection runs:**
- after a GitHub App connect;
- after the repository fields change;
- when GitHub says an installation's permissions or repositories changed;
- when someone presses "Check again";
- otherwise nightly, two sites per scheduler tick.

**Live progress** (`websiteDeployWatch.ts`) turns GitHub's records into five
stages: queued, building, deploying, live, failed.

- When the host reports a failure, the job becomes `DEPLOY_FAILED` with the host's own words (D1).
- A failed GitHub Pages build is retried once (D6). The retry never runs while githubstatus.com shows Pages or Actions degraded. It needs the DakyX Pages app, which alone holds Pages and Actions write.

**Deploy hooks** (D4):
- validated by shape;
- refused over http or at a local address;
- called once on save to prove they work;
- retried twice on a 5xx;
- stored encrypted;
- called only when detection has not seen the host deploy on its own.

**`.nojekyll`** (D5) is one click, offered for a plain HTML site on GitHub
Pages' classic build. Measure it with the Phase 4 script below.

## What Dan has to do, in order

### 1. GitHub App read permissions (Route D)

On <https://github.com/organizations/dakyworld/settings/apps/dakyworld-website-editor>
→ Permissions & events, add, all **Read-only**:

| Permission | For |
|---|---|
| Deployments | What Vercel, Netlify and Pages say about each commit |
| Checks | The same, from hosts that report as check runs |
| Commit statuses | The same, from hosts that report as statuses |
| Actions | GitHub Pages' build runs |
| Webhooks | Which host the repository tells about pushes |
| Pages | Which branch and folder GitHub Pages builds |

GitHub asks every installation's owner to approve added permissions. Until an
owner approves, that site runs in graceful mode: headers, DNS, files and the
page check still work, and settings say "Approve the DakyX app's new read
access on GitHub". When they approve, the `new_permissions_accepted` webhook
re-runs detection by itself.

### 2. Netlify and Vercel (Route A)

- **Netlify:** User settings → Applications → OAuth → New OAuth app.
  - Redirect URI: `https://editor.dakyx.com/api/website/connect/netlify/callback`.
  - Set `NETLIFY_CLIENT_ID` and `NETLIFY_CLIENT_SECRET` on Railway (`dakyworld` service, production).
- **Vercel:** Integrations Console → Create.
  - Redirect URL: `https://editor.dakyx.com/api/website/connect/vercel/callback`.
  - Scopes: Projects read, Deployments read and write.
  - Set `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET` and `VERCEL_INTEGRATION_SLUG` (the slug in the integration's URL).
- **Still to be proven:** that the Integration's token can create a production deployment on an existing Git-connected project.
  1. Connect a test Vercel project.
  2. Publish once.
  3. Confirm the activity log says "Deployed to Vercel production".
  4. Confirm the next Git build produces the same page.
  5. If it cannot, set `PUBLISH_ROUTES_DISABLED=direct` for Vercel sites; they stay on Route D.
- **Cloudflare Pages:** no third-party OAuth was found, so it stays on Route D or a deploy hook.

### 3. DakyX Pages app (Route P, and the D6 retry)

1. Run `node scripts/createGithubApp.mjs --pages --org dakyworld` from `server/` and press the button. It asks for:
   - Contents, Workflows, Pages and Actions write;
   - Setup URL `https://editor.dakyx.com/api/website/github-pages/callback`.
2. Set `GITHUB_PAGES_APP_ID`, `GITHUB_PAGES_APP_SLUG` and `GITHUB_PAGES_APP_PRIVATE_KEY` from the file it writes.
3. **Measure before offering it.** On a copy of africon-app, never the real one, run:
   `GITHUB_TOKEN=… node scripts/pagesTiming.mjs --repo owner/africon-app-timing --runs 5`
4. Keep Route P only if it beats `.nojekyll` by 10 seconds or more on the median. Otherwise set `PUBLISH_ROUTES_DISABLED=pages`.

### 4. The edge bridge (Route B)

Follow `edge/README.md`. In short:

1. Buy a hosting domain (`dakyxsites.com` was suggested) and add it to Cloudflare.
2. Turn on Cloudflare for SaaS, and deploy the Worker with its Durable Object.
3. Set `BRIDGE_ADMIN_URL`, `BRIDGE_ADMIN_TOKEN`, `BRIDGE_BYPASS_TOKEN`, `BRIDGE_CNAME_TARGET`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID`.
4. Run the six checks in the next list before switching it on for any customer.

**Before a customer gets it (plan §5.1)**, on a throwaway domain:

1. The Worker runs on a custom hostname through Cloudflare for SaaS, on a non-Enterprise plan.
2. GitHub Pages passes through without a redirect loop. That needs the custom domain cleared from Pages: DakyX does it with the DakyX Pages app, or the customer does it by hand. Then the Worker fetches from `owner.github.io/repo/`.
3. A publish shows on the test domain in under a second.
4. With the bridged copy deleted, the host's version is served, and images, styles and forms work.
5. The bare domain reaches the site over https, through the registrar's forwarding or an ALIAS record.
6. A domain already proxied through the customer's own Cloudflare account works, or is detected and refused with a clear message.

**Domain Connect.** `edge/domainconnect/dakyx.com.bridge.json` is the template
to submit to the Domain Connect templates repository and each DNS provider.
Expect weeks per provider. Set `DOMAIN_CONNECT_PROVIDER_ID=dakyx.com` and
`DOMAIN_CONNECT_SERVICE_ID=bridge` once one provider accepts it; until then
every customer gets the guided records screen. **Hostinger is not a Domain
Connect provider.** Entri was not evaluated.

**Changed from the plan:** the Worker keeps bridged files in a Durable Object,
not Workers KV. KV is eventually consistent and can keep returning an old
answer for up to a minute in other locations, including "nothing here". That is
exactly the window the bridge exists to close.

## Costs

| Item | Cost |
|---|---|
| Routes D, A, P | $0. On a private repository, Route P runs use the customer's Actions minutes, under a minute each |
| Cloudflare Workers paid plan | $5/month, including Durable Object requests and storage at this scale |
| Cloudflare for SaaS | 100 hostnames free, then $0.10 per hostname per month |
| Hosting domain | about $20/year |

## Checked by

- `checks/publishRouter.ts` (no database), 114 checks:
  - detection;
  - stages;
  - retry once, and never during an outage;
  - fallback and credit;
  - deploy hooks;
  - Netlify and Vercel against recorded hosts;
  - the instant card;
  - signed connect state;
  - the Worker against an in-memory Durable Object;
  - who may call what.
- `checks/websitePublishVerify.ts` and `checks/websitePublishJobs.ts`: the watch.
- `checks/browser/deployPanel.mjs` and `checks/browser/publishFollow.mjs`: the settings panel and the publish toast, in Chromium.
