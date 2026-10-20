# The publish router

How a Website Builder publish goes live, and what has to be set up outside this
repository before each faster route can be switched on. Built 20 Oct 2026 from
the plan "DakyX Publish Router: implementation plan".

Every customer presses **Publish** and nothing else. DakyX works out how the
site goes live and uses the fastest route that site has. A fast route that fails
falls back to following the host, so no publish is ever lost.

## The rules it keeps

1. DakyX never hosts a repository-backed customer site. The customer's host always serves it, and nothing DakyX runs sits between a visitor and that host.
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

**Route B, the edge bridge, was built and then removed (Dan, 20 Oct 2026).** It
put a Cloudflare Worker that DakyX runs in front of the customer's host, so every
visit to their site passed through DakyX. That is hosting in all but name, and
against rule 1. Its code is in the history at `ec0297a` if the question ever
comes back.

`websitePublishRouter.ts` runs the faster routes after every commit, in the
order direct, pages, hook. It records on the publish job which route made the
change live (`route`), the faster route that failed first (`fallbackFrom`), and
every attempt (`routeLog`). The watcher follows every publish whatever route it
took.

**Off switches.**
- Globally: `PUBLISH_ROUTES_DISABLED=direct,pages,hook`, as a Railway variable or a setting.
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

It also checks the two setup problems that make every publish fail: the
publishing branch missing from the repository (`branchMissing`), and a
credential that can read but not write (`canWrite`). Both are warned about in
the editor before anybody publishes, and in settings.

**When detection runs:**
- after a GitHub App connect;
- after the repository fields change;
- when GitHub says an installation's permissions or repositories changed;
- when someone presses "Check again";
- otherwise nightly, two sites per scheduler tick.

**Live progress** (`websiteDeployWatch.ts`) turns GitHub's records into five
stages: queued, building, deploying, live, failed.

- When the host reports a failure, the job becomes `DEPLOY_FAILED` with the host's own words (D1).
- A failed build is asked for again once (D6): GitHub Pages through GitHub (needs the DakyX Pages app, which alone holds Pages and Actions write), any other host through its deploy hook when the site has one. Never while githubstatus.com shows the part that host builds on as degraded.

**When a publish fails** (`DEPLOY_FAILED`, or `VERIFY_FAILED` after a day),
whoever pressed Publish gets one email saying so, with the host's own words
(`websitePublishNotice.ts`). A slow host never triggers it.

**What the customer sees.**
- The publish toast follows the job. It says how long this site's host usually takes, shows the host's stages, and once live, its "Open the live page" link skips any cached copy.
- Website settings, under "How this site goes live", lists the last ten publishes: how long each took, which route carried it, and what went wrong in the host's words.

**Deploy hooks** (D4):
- validated by shape;
- refused over http or at a local address;
- called once on save to prove they work;
- retried twice on a 5xx;
- stored encrypted;
- called on each publish only when detection has not seen the host deploy on its own.

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
  3. Confirm the publish history says it was uploaded straight to the host.
  4. Confirm the next Git build produces the same page.
  5. If it cannot, set `PUBLISH_ROUTES_DISABLED=direct` for Vercel sites; they stay on Route D.
- **Cloudflare Pages:** no third-party OAuth was found, so it stays on Route D or a deploy hook.

### 3. DakyX Pages app (Route P, and the GitHub Pages retry)

1. Run `node scripts/createGithubApp.mjs --pages --org dakyworld` from `server/` and press the button. It asks for:
   - Contents, Workflows, Pages and Actions write;
   - Setup URL `https://editor.dakyx.com/api/website/github-pages/callback`.
2. Set `GITHUB_PAGES_APP_ID`, `GITHUB_PAGES_APP_SLUG` and `GITHUB_PAGES_APP_PRIVATE_KEY` from the file it writes.
3. **Measure before offering it.** On a copy of africon-app, never the real one, run:
   `GITHUB_TOKEN=… node scripts/pagesTiming.mjs --repo owner/africon-app-timing --runs 5`
4. Keep Route P only if it beats `.nojekyll` by 10 seconds or more on the median. Otherwise set `PUBLISH_ROUTES_DISABLED=pages`.

## Costs

Routes D, A and P cost DakyX nothing. On a private repository, Route P runs use
the customer's Actions minutes, under a minute each.

## Checked by

- `checks/publishRouter.ts` (no database):
  - detection;
  - stages;
  - retry once, and never during an outage;
  - fallback and credit;
  - deploy hooks;
  - Netlify and Vercel against recorded hosts;
  - the instant card;
  - signed connect state;
  - who may call what, including that the removed bridge routes answer nobody.
- `checks/websitePublishVerify.ts` and `checks/websitePublishJobs.ts`: the watch.
- `checks/browser/deployPanel.mjs` and `checks/browser/publishFollow.mjs`: the settings panel, the publish history and the publish toast, in Chromium.
