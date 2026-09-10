# The Dakyworld GitHub App

The per-customer replacement for the one shared personal access token. **Built
and deployed; the app itself does not exist yet** — creating it on GitHub is a
manual step, and until it is done every website carries on publishing with the
shared token exactly as before.

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

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**. Create
it under a Dakyworld organisation rather than a personal account if there is one,
so ownership belongs to the business.

| Field | Value |
|---|---|
| Name | Dakyworld Website Editor |
| Homepage URL | https://dakyworld.com |
| Webhook URL | https://os.dakyworld.com/api/github/webhook |
| Webhook secret | a long random string — keep it |
| Where can it be installed | Any account |

Permissions — the minimum, and no more:

| Permission | Access | Why |
|---|---|---|
| Metadata | Read | Basic repository information |
| Contents | Read & write | Read the website's files and publish changes |
| Pull requests | Read & write | Only if publish-by-pull-request is used |
| Everything else | **None** | Administration, Issues and Actions are not needed |

Subscribe to these events: **Installation**, **Installation repositories**. Push
is not needed — the editor reads the file when it needs it.

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

Keep the shared token for Dakyworld's own repositories. Do **not** install the
customer-facing app on the OS repository.

## Checked by

`checks/githubApp.ts` — app JWTs (RS256, backdated, short-lived), borrowed
installation tokens and their caching, an installation that has gone, the shared
token still publishing outside an installation scope, and webhook signatures
including a truncated one that must not read as a prefix match. No request in it
can leave the machine.
