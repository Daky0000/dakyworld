# Security and search

What protects this system, where each control lives, and — at the bottom — the
four things that still need somebody with a login somewhere to finish. Written
for whoever picks this up next, including the owner.

Two products live in this repo (see [CLAUDE.md](CLAUDE.md)), and they have
different threat models. **Dakyworld OS** (`server/`) holds every lead, client,
invoice and mailbox credential the business has, behind a login. The **website**
(repo root) is thirteen static pages with nothing to steal, whose job is to be
found.

---

## Running the checks

```bash
npm run security      # credentials in the repo, then a dependency audit
npm run scan:secrets            # the working tree
npm run scan:secrets:history    # every commit ever made
npm run audit                   # shipped dependencies, both packages

npm run site          # regenerate the SEO metadata and breadcrumbs, check links
npm run seo:check     # CI form: fail if the metadata is out of date
npm run links         # broken and non-canonical internal links
```

All of it runs in CI on every push and pull request, plus Monday mornings for
the advisories that land against code nobody touched
([.github/workflows/security.yml](.github/workflows/security.yml)).

---

## Dakyworld OS

### Getting in

| | Where |
|---|---|
| Passwords hashed with scrypt (N=16384), params stored alongside | [`src/lib/password.ts`](server/src/lib/password.ts) |
| One password policy for every path that sets one | [`src/lib/passwordPolicy.ts`](server/src/lib/passwordPolicy.ts) |
| TOTP second factor, recovery codes, replay prevention | [`src/lib/totp.ts`](server/src/lib/totp.ts), [`src/routes/auth.ts`](server/src/routes/auth.ts) |
| Sessions as a random token, only its SHA-256 in the database | [`src/lib/session.ts`](server/src/lib/session.ts) |
| Login rate limits, per address and per account | [`src/middleware/security.ts`](server/src/middleware/security.ts) |

**The password policy follows NIST SP 800-63B rather than the older
"one uppercase, one digit, one symbol" habit.** Twelve characters minimum, a
blocklist, and a refusal of anything built out of the account's own name or
email. Composition rules mostly produce `Password1!`; length and a blocklist do
the actual work. There is deliberately no expiry — forced rotation makes people
iterate a counter on the end, and a password change here already drops every
session, which is what rotation was trying to buy.

**Two-factor is TOTP, not an emailed code.** An emailed OTP is only as strong as
the mailbox, and the mailbox this company would use is the one the app itself
sends from — so a compromise of the mail token would hand over the second factor
along with the first. An authenticator app shares nothing with this system.

Turning 2FA on is two steps, and it is the *confirm* step that enables it: a
secret stored as enabled before the app has proved it can read it is how
somebody locks themselves out with a mistyped setup key. The secret is encrypted
at rest with `APP_SECRET`, exactly like every integration token. Recovery codes
are stored as SHA-256 and shown once. A used TOTP step is recorded, so a code
lifted off a phishing page is not still good for the rest of its thirty seconds.

**The way back in, in order:** a recovery code → an Owner clearing the enrolment
(`DELETE /api/users/:id/2fa`) → changing `OWNER_PASSWORD` in Railway and
redeploying, which is what `bootstrapOwner` exists for and is why a weak
`OWNER_PASSWORD` produces a warning in the deploy log rather than a refusal to
boot.

### Who may see what

`requireAuth` closes the door; `requireRole` gates the routes that spend money
or write to clients. Client-side role checks exist only to hide nav items
([`client/src/components/Layout.tsx`](server/client/src/components/Layout.tsx)) —
nothing depends on them.

**`CLIENT_VIEWER` is a closed door, not a narrow one.** The role means "somebody
outside the company", and until Aug 2026 it carried no restriction at all: it
could be assigned from the Team screen and then read every lead, client, invoice
and email in the business, because nothing between `requireAuth` and the routers
ever looked at it. There is no client portal yet and no column tying a user to
the client they belong to, so there is nothing to scope a view *down to* — and
the honest position with nothing to scope by is a refusal. `scopeClientViewer`
in [`src/middleware/auth.ts`](server/src/middleware/auth.ts) allows the account
to sign in and see itself, and nothing else. Widen it deliberately, per route,
when the portal exists — never by deleting the check.

**Never write `include: { user: true }`.** A whole `User` row carries the
password hash, the TOTP secret and the recovery-code hashes. `GET
/api/projects/:id` returned exactly that for every assignee, to anybody signed
in. Use `select: PUBLIC_USER` from
[`src/lib/userSelect.ts`](server/src/lib/userSelect.ts), so adding a sensitive
column to the model can never quietly widen an existing response.

### The data

- **Every integration key is encrypted at rest** (AES-256-GCM, keyed from
  `APP_SECRET`) in `AppSetting` rather than in an environment variable, so
  adding or rotating one never needs a redeploy —
  [`src/lib/secrets.ts`](server/src/lib/secrets.ts). Keys are masked in every
  API response and never unmasked. **Rotating `APP_SECRET` makes every stored
  key unreadable.**
- **Row-level security is on for all 42 tables**
  ([migration](server/prisma/migrations/20260819180100_row_level_security/migration.sql)).
  Read that file before reasoning about it — Postgres skips RLS for a table's
  owner, and the app owns every table, so the app is unaffected and *every other
  role reads zero rows*. That covers what actually happens to a small system: a
  read-only role handed to a BI tool, a connection string out of a dashboard, a
  psql session opened as somebody else. Per-user row scoping is not expressible
  here — Prisma holds one pooled connection as one role — so it lives in the
  application; the migration says what it would take to move it.
- **No database credential ever reaches a browser.** The client bundle receives
  exactly one variable, `VITE_API_BASE=/api`. Every query goes through the API.
  (If this ever moves to a Supabase-style architecture where the browser talks to
  the database directly, *that* is when a publishable anon key and real RLS
  policies become the mechanism — today the equivalent guarantee is that the
  browser has no database access to constrain.)
- **Every query goes through Prisma.** There is no `$queryRaw` anywhere, so
  there is no string-concatenated SQL to inject into.

### What arrives from outside

- **Every route validates with zod** before anything reaches Prisma. The two
  that do not are `dashboard` (read-only, no input) and `webhooks` (raw bytes by
  design, because a signature covers the exact bytes sent).
- **No mass assignment.** Nothing spreads a request body into a Prisma
  `create`/`update`; every field is named.
- **Uploads are checked as bytes, not as claims** —
  [`src/lib/fileType.ts`](server/src/lib/fileType.ts). A filename ending in
  `.xlsx` and a `data:image/png` prefix are both strings the caller chose. The
  bytes are sniffed against the declared type, an `.xlsx` is checked for a
  declared expansion a spreadsheet would never have, and an SVG is refused if it
  carries a script, an event handler or an external reference.
- **The public webhook is the only anonymous write**, and it is public for a good
  reason ([`src/routes/webhooks.ts`](server/src/routes/webhooks.ts)). It is rate
  limited, size capped, recorded before it is acted on, and filtered by
  [`src/services/botCheck.ts`](server/src/services/botCheck.ts) — a honeypot, a
  fill-time check, a link count and a mail-header-injection check. No CAPTCHA:
  that is a third-party key, a script on every page, a cookie the privacy policy
  would have to describe, and a measurable share of real people who give up on
  the form. Flagged posts are recorded and simply do not become leads, because
  the failure mode of a spam filter is the enquiry it eats.
- **User content is never rendered as markup.** React escapes by default and
  there is no `dangerouslySetInnerHTML` anywhere in the client. The one place
  model-written HTML *is* served — `/demos/:slug` — is sanitised and served under
  its own far stricter CSP.

### In transit

`app.set("trust proxy", 1)`, then `forceHttps`, then `securityHeaders`
([`src/index.ts`](server/src/index.ts),
[`src/middleware/security.ts`](server/src/middleware/security.ts)):

- HSTS (2 years, `includeSubDomains`, `preload`) and a 308 redirect for the
  first visit HSTS cannot cover. A write over plain HTTP is refused rather than
  redirected — the body has already crossed the network in clear, and a redirect
  would only send it a second time.
- A real CSP: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, `form-action 'self'`. Affordable without a nonce because
  the client is a Vite build with no inline script anywhere.
- `nosniff`, `DENY`, `strict-origin-when-cross-origin`, a `Permissions-Policy`,
  COOP/CORP, `X-Robots-Tag: noindex` on the whole app, and `X-Powered-By`
  removed.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, and the `__Host-` prefix
  in production — which the browser enforces, so nothing on a sibling subdomain
  can set or overwrite it. `Lax` rather than `Strict` deliberately: the Google
  Drive consent screen returns the user by top-level navigation, and a strict
  cookie is not sent on that. Cross-site *writes* are still blocked, which is the
  CSRF case that matters.
- CORS issues no cross-origin grant at all in production, because the client is
  served from the same origin and needs none.

**`trust proxy` is not cosmetic.** The login limiter used to read
`X-Forwarded-For[0]` by hand, which is a header the caller writes — so a script
sending a fresh value per request got a fresh allowance per request. With a hop
*count*, Express takes the entry the proxy itself wrote, which the caller cannot
reach past. Trusting the whole chain (`true`) would put the bug straight back.

**A 500 says nothing in production.** It used to return `err.message`, which is
a Prisma error naming the table and constraint, or a fetch error naming an
internal host. The body is now a fixed sentence plus a reference that ties it to
the stdout line Railway keeps.

---

## The website

Everything in each `<head>` between the `BEGIN SEO` / `END SEO` markers is
generated by [`scripts/build-seo.mjs`](scripts/build-seo.mjs), and the visible
breadcrumbs by [`scripts/build-breadcrumbs.mjs`](scripts/build-breadcrumbs.mjs),
from one table each. **Do not hand-edit inside the markers** — CI fails on it,
and thirteen hand-maintained copies of anything is how this drifted in the first
place: three pages had no canonical, one pointed at a URL nothing linked to, and
not one page carried a single Open Graph tag, so every link shared to WhatsApp,
LinkedIn or Slack rendered as a grey box.

What each page now carries: a canonical, a robots directive, keywords, geo tags,
a full Open Graph and Twitter card set pointing at
[`assets/brand/og-share.png`](assets/brand/og-share.png) (1200×630, on-brand),
and JSON-LD. The homepage carries `Organization` + `WebSite` +
`ProfessionalService`; every other page carries a type that fits it plus a
`BreadcrumbList` that matches the breadcrumb actually on the page.

`robots.txt` and `sitemap.xml` are generated by the same script.
[`404.html`](404.html) is the one page that says `noindex`, which is why it is
not in that table.

### Headers on a static site

Every page carries a Content-Security-Policy as a `<meta>` tag, because GitHub
Pages serves files and cannot set a response header. **That is not the same
thing, and the difference matters in two places:**

- **`frame-ancestors` and `X-Frame-Options` are ignored in a meta tag.** There is
  no clickjacking protection on dakyworld.com and there cannot be until the site
  sits behind something that sets headers — Cloudflare in front of Pages is the
  cheap version; serving it from the Railway service that already sets them
  properly is the thorough one. Nothing on the site takes input yet, so the
  exposure today is somebody framing the pages to misrepresent them, not to
  harvest anything.
- **HSTS cannot be set either.** GitHub Pages does redirect http→https for a
  custom domain with "Enforce HTTPS" on, which is the important half; check that
  setting is on.

What the meta CSP does buy is real: an injected script from an origin other than
the three named cannot run, a form cannot be repointed at somebody else's
server, `<base>` cannot be rewritten to redirect every relative link, and no
plugin content can be embedded at all.

### The two CDN scripts — the largest remaining exposure on the website

Every page loads `https://cdn.tailwindcss.com` and
`https://unpkg.com/lucide@latest`. Both run with full privileges on
dakyworld.com, and **a CSP naming a host does not protect against that host**.
`lucide@latest` is worse than Tailwind: the version is unpinned, so the file
served can change at any time without anything in this repo changing, and an
unpinned URL cannot carry an SRI hash either.

This was left alone rather than fixed quietly, because both fixes are real
changes to a live site and the choice belongs to whoever owns it:

- **lucide** — pin a version and vendor it into `assets/vendor/`, or inline the
  handful of icons actually used as SVG and drop the dependency. Small, contained,
  removes an unpinned remote script entirely.
- **Tailwind** — `cdn.tailwindcss.com` is the Play CDN, which Tailwind's own docs
  say is not for production: it ships a compiler to every visitor, is the reason
  the CSP needs `'unsafe-eval'`, and costs a render-blocking download on every
  page. The fix is a build step producing one small CSS file. That is a project,
  not a patch — roughly 116 places on the site use a Tailwind class, and the rest
  is already served by `assets/site.css`.

Analytics is [`assets/analytics.js`](assets/analytics.js), loaded by every page
and doing **nothing at all** until a Measurement ID is filled in at the top of
the file — no third-party script fetched, no cookie set. It honours Do Not Track
and Global Privacy Control, truncates the IP address (Act 843 treats one as
personal data, and the site's own privacy policy is written on that basis), and
skips localhost so preview traffic never enters the real numbers.

---

## Still to do — these need an account, not a commit

1. **Paste the GA4 Measurement ID** into the top of
   [`assets/analytics.js`](assets/analytics.js). One line, then push. Until then
   there are no analytics at all — everything else is wired.

2. **Verify the site with Google Search Console and Bing Webmaster Tools.** Put
   the two `content` values into `VERIFICATION` at the top of
   [`scripts/build-seo.mjs`](scripts/build-seo.mjs) and run `npm run seo`. Then
   submit `https://dakyworld.com/sitemap.xml` in both. Verification is what
   unlocks the part that matters — which queries actually reach the site, and
   being told about a crawl error rather than finding it in the traffic. (Bing
   can import the whole property from Search Console, which is faster.)

3. **Fill in `sameAs` and the local details** in
   [`scripts/build-seo.mjs`](scripts/build-seo.mjs). Two gaps, both deliberate:

   - `COMPANY.sameAs` is empty because a guessed profile URL either 404s or
     points at somebody else's account. It is the single strongest signal tying
     this site to a verified identity. Real LinkedIn/Facebook/X URLs, then
     `npm run seo`.
   - `ProfessionalService` carries no street address, no coordinates and no
     opening hours, because inventing any of them would be a false statement
     about a real business. **A Google Business Profile is what actually gets a
     company into the local pack** — the schema supports the listing, it does not
     replace it. Create the profile, then bring the address it verifies back into
     this file.

4. **Turn on two-factor for the Owner account.** Settings → Security. Everything
   is built and tested; nobody is enrolled. This is the control that matters most
   on a system holding every client relationship the business has, and it is
   currently off.

## Two things known and accepted

- **`exceljs` depends on a vulnerable `uuid`** (GHSA-w5hq-g745-h8pq, moderate).
  Not reachable: the advisory is about a missing bounds check *when a buffer is
  passed*, and exceljs calls `uuidv4()` with no arguments
  (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`). 4.4.0 is the latest
  release, so there is no fix to take. `npm audit --audit-level=high` is
  therefore what CI enforces; the full report is printed alongside it.
- **The contact form on dakyworld.com is still not connected to anything.** It
  says so to the visitor. The honeypot and timing fields are in the markup and
  the server side is built and tested, so pointing it at
  `POST /api/webhooks/website-form` is the only remaining step — but until
  somebody does, enquiries arrive by email and phone only.
