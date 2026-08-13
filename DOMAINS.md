# Domains

Two domains are served from this one repository, by two different hosts that
both watch it. They cannot collide, because each host is told its own domain in
its own place.

| Domain | Host | Serves | Domain configured in |
|---|---|---|---|
| `os.dakyworld.com` | Railway | `server/` (API + built client) | Railway dashboard |
| `dakyworld.com` | GitHub Pages | the repo root (`index.html`, `assets/`, …) | the `CNAME` file in this repo |

The `CNAME` file only affects GitHub Pages. It has no bearing on Railway, and
editing it cannot take the OS app down.

## Status

The website **is built and serving** — every page and asset returns 200 at
<https://daky0000.github.io/dakyworld/>. `CNAME` already contains
`dakyworld.com`. Nothing in this repo needs to change.

The apex domain does not resolve to it yet, for one reason only: **the DNS zone
still points `dakyworld.com` at two hosts at once.** Four A records belong to
GitHub Pages; one A and one AAAA still point at Hostinger, where an empty
WordPress install sits. Visitors get whichever their resolver picks, which is
why `https://dakyworld.com` fails with a certificate warning about half the
time — and GitHub will not issue a certificate or attach the domain while it
resolves somewhere else.

## Fixing it

DNS is managed at **Hostinger** — the nameservers are `ns1.dns-parking.com` and
`ns2.dns-parking.com`. Do this in hPanel, not at the registrar.

**1. Open the zone editor.** hpanel.hostinger.com → Domains → dakyworld.com →
DNS / Nameservers → DNS Zone Editor.

**2. Delete exactly two records.**

| Type | Name | Value |
|---|---|---|
| `A` | `@` | `82.25.96.134` |
| `AAAA` | `@` | `2a02:4780:3f:2070:0:1fe2:824b:3` |

**3. Confirm these four survived**, as `A` on `@`. Re-add any that are missing.

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

**4. Delete the junk TXT record.** Its value is GitHub's *example instruction
text*, pasted by mistake instead of a verification value. It does nothing.

```
dig _github-pages-challenge-USERNAME.example.com +nostats +nocomments +nocmd TXT
```

Leave the other TXT record (`v=spf1 include:_spf.mail.hostinger.com ~all`)
alone — it is the SPF record for email.

**5. Optional — restore IPv6.** The deleted AAAA record was providing IPv6
reachability. GitHub Pages' equivalents, as `AAAA` on `@`:

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

**6. If GitHub says the domain is "already taken".** Setting the custom domain
on the repo can fail with *"The custom domain dakyworld.com is already taken."*
That is a Pages claim held outside the account — DNS is irrelevant to it, it
will not clear on its own, and it is why the `CNAME` file never applied by
itself. Fix it at account level: **GitHub → account Settings → Pages → Add a
domain → `dakyworld.com`**. GitHub returns a challenge token; add it in
Hostinger as TXT with the name **`_github-pages-challenge-Daky0000`** (name
only — hPanel appends the domain). It cannot collide with SPF, which sits at
`@`. Click Verify; the account then takes priority and the repo accepts the
domain. Verifying the apex is expected to cover subdomains, clearing any
`marketing.dakyworld.com` entry sitting unverified.

**7. Let GitHub attach the domain.** github.com/Daky0000/dakyworld → Settings →
Pages. The custom domain field should read `dakyworld.com` from the `CNAME`
file; if it is blank, type it and Save. Once the check passes, tick **Enforce
HTTPS**. The certificate is issued automatically and can take up to an hour.

**8. Verify.**

```bash
nslookup dakyworld.com 8.8.8.8  # expect only 185.199.108-111.153
curl -sSI https://dakyworld.com # expect HTTP/2 200, Server: GitHub.com
```

> **Do not check against `ns1`/`ns2.dns-parking.com`.** Those anycast nodes
> served stale records for well over an hour after a confirmed zone edit, which
> reads exactly like a change that failed to save and nearly caused a correct
> edit to be undone. Use a public resolver as the source of truth.

## Do not delete these

Everything here is live. Removing any of it breaks email or takes the OS app
offline.

| Record | Value | What it does |
|---|---|---|
| `MX` | `mx1.hostinger.com` (5), `mx2.hostinger.com` (10) | Receives all company email |
| `TXT` | `v=spf1 include:_spf.mail.hostinger.com ~all` | SPF — keeps outgoing mail out of spam |
| `CNAME` | `os` → `jvi1adna.up.railway.app` | Points os.dakyworld.com at the OS app |
| `A` ×4 | `185.199.108–111.153` | GitHub Pages — serves the website |
| `CNAME` | `www` → `dakyworld.com` | Sends www to the apex |

## If it still is not working

| Symptom | Cause | Fix |
|---|---|---|
| `Site not found` from GitHub | Pages has not attached the domain — either DNS still resolves to Hostinger, or the domain is claimed elsewhere | Confirm DNS on a public resolver, then do step 6 |
| `The custom domain is already taken` | Another Pages site holds the claim; DNS is irrelevant | Step 6 — account-level domain verification |
| A zone edit looks like it did not save | Hostinger's own nameservers serve stale records long after the change is live | Re-check against `8.8.8.8` before undoing anything |
| Certificate warning | DNS is right, certificate not issued yet | Wait up to an hour, then tick Enforce HTTPS |
| The empty WordPress page appears | A resolver is still caching the old address | Wait out the TTL, or test with `curl --resolve dakyworld.com:443:185.199.108.153 https://dakyworld.com/` |
| os.dakyworld.com goes down | The `os` CNAME was deleted | Re-add `os` → `jvi1adna.up.railway.app` |
| Email stops arriving | An MX or the SPF TXT record was deleted | Re-add from the table above |

---

Verified against live DNS and both hosts on 13 August 2026.
