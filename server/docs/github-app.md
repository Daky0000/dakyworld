# The Dakyworld GitHub App

The per-customer replacement for the one shared personal access token.

**Created and configured on 10 Sep 2026**: *Dakyworld Website Editor*, app id
`4895561`, slug `dakyworld-website-editor`, owned by the **Dakyworld**
organisation — <https://github.com/apps/dakyworld-website-editor>. Its id, slug,
private key and webhook secret are Railway variables on the `dakyworld` service;
the key is in no repository and no screen.

Nothing changes for a website until somebody installs the app on its repository
and connects it. Every site without an installation still publishes with the
shared token, exactly as before.

## Why

One token reaches every repository the account can see. With a hundred customers
that is a hundred repositories behind one credential, and the customer:

- cannot see what it can reach,
- cannot narrow it,
- cannot take it back without asking us to,
- and has to hand us a secret of their own to set it up.

An installation inverts every one of those. The customer installs the app on the
repositories **they** choose; GitHub refuses anything outside that set whatever
this process asks for; the tokens it lends expire in an hour; and they can narrow
or remove the installation themselves, without a conversation.

Installing the app does **not** give them anything of ours. Access runs the other
way: they grant the app access to their repositories. A public app is not public
source code.

## What to create, once

Run **`node scripts/createGithubApp.mjs --org dakyworld`** from `server/`. It
serves a local page that posts a filled-in App Manifest to GitHub; one click on
GitHub's own confirmation screen creates the app, and the id, slug, private key
and webhook secret come straight back to a file the script names. A GitHub App
cannot be created from an access token, so that click is the whole of the manual
part.

Then **`node scripts/configureGithubApp.mjs`** proves the key against GitHub and
sets the four Railway variables.

By hand instead: GitHub → the organisation → Settings → Developer settings →
GitHub Apps → **New GitHub App**, with exactly what follows.

| Field | Value |
|---|---|
| Name | Dakyworld Website Editor |
| Homepage URL | https://dakyworld.com |
| Webhook URL | https://os.dakyworld.com/api/github/webhook |
| Webhook secret | GitHub generates one through the manifest flow |
| Where can it be installed | Any account |

`GET /app` does **not** report the webhook, so a manifest that quietly dropped it
would look identical to one that kept it. `configureGithubApp.mjs` asks
`/app/hook/config`, which does know, and repairs it with the same JWT if it is
wrong.

Permissions — the minimum, and no more:

| Permission | Access | Why |
|---|---|---|
| Metadata | Read | Basic repository information |
| Contents | Read & write | Read the website's files and publish changes |
| Pull requests | Read & write | Only if publish-by-pull-request is used |
| Everything else | **None** | Administration, Issues and Actions are not needed |

**Subscribe to no events.** The two this system listens for — `installation` and
`installation_repositories` — are lifecycle events GitHub delivers to every app's
webhook on its own. They are not in the subscribable list, and asking for them is
rejected: *"Default events unsupported: installation and installation_repositories"*.
Push is not wanted either — the editor reads a file when it needs one, so a
webhook for every commit anybody makes would be noise.

Then generate a private key (`.pem`) and note the App ID and the app's slug (the
`dakyworld-website-editor` in `github.com/apps/…`).

## What to put where

Railway → the `dakyworld` service → Variables:

```
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=dakyworld-website-editor
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----
GITHUB_APP_WEBHOOK_SECRET=the-webhook-secret
```

Newlines in the key can be written as `\n`; the app puts them back.

**The private key authenticates the app across every installation.** Never commit
it, never put it in the client, never return it from an API, and prefer the
deployment variable over the settings screen — the code reads either, and
environment wins.

## What a customer sees

`Website → Settings → Customer's own GitHub access` offers the install link. They
choose **Only select repositories**, pick theirs, and GitHub sends them back to a
URL ending `installation_id=…`. That number goes in the box, the screen lists
what the installation actually reaches, and picking the repository connects it.

The installation id is not a secret — it is a number in a redirect URL. The key
that turns it into a token never leaves the server.

## What happens afterwards

- Every read and publish for that site borrows an hour-long installation token.
  Everything else keeps using the shared token; both work, per site.
- The local writable-repositories allowlist is **not** applied to installation
  credentials. GitHub is the boundary there, and requiring our list as well would
  mean adding every client's repository to a setting in order to use the
  mechanism whose whole point is that the customer chooses.
- If the customer removes the repository, suspends or uninstalls the app, GitHub
  says so on the webhook: the site is marked as having lost access with the date,
  the cached token is dropped immediately, and the settings screen says what
  happened instead of a publish failing later with a 404 nobody can act on.

## Migrating a site

1. Ask the customer to install the app on their website's repository.
2. Connect it on the settings screen.
3. Publish something small and watch it go live (the publish now says when it
   actually reaches the site — see `docs/website-editor.md`).
4. Roll it back, to prove that path too.
5. Only then take that repository out of `GITHUB_ALLOWED_REPOS`.

Publishing needs *a* credential. As of 10 Sep 2026 production has no
`GITHUB_TOKEN` variable at all, so unless one was pasted into Settings →
Developer, an installation is the only way any site can publish.

## Dakyworld's own website

`dakyworld.com` and Dakyworld OS are the **same repository** — `Daky0000/dakyworld`
holds `index.html`, `about.html` and the rest at its root, and the whole OS under
`server/`.

An earlier draft of this file said to keep that site on the shared token for that
reason. **That was wrong, and the comparison is the other way round.** A personal
access token reaches *every* repository the account can see, with our own
allowlist as the only thing narrowing it; an installation scoped to this one
repository reaches nothing else, and GitHub enforces that rather than us. The app
is strictly the narrower credential for the same job.

What is true about the shared repository is that either credential can write
anywhere inside it, `server/` included. Neither actually does: the editor writes
only the file a scanned page came from — a top-level `.html` under the site's
configured folder — plus the assets that page references. So the repository being
shared is a reason to split it eventually, not a reason to prefer the broader
token in the meantime.

So: install the app on `Daky0000/dakyworld` with **Only select repositories**, and
select only that one. Splitting the marketing site into its own repository later
makes the boundary tidy as well as correct.

## Checked by

`checks/githubApp.ts` — app JWTs (RS256, backdated, short-lived), borrowed
installation tokens and their caching, an installation that has gone, the shared
token still publishing outside an installation scope, and webhook signatures
including a truncated one that must not read as a prefix match. No request in it
can leave the machine.
