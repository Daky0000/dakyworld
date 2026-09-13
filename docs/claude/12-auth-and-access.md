# Auth, access control and security

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**Auth** — `src/middleware/auth.ts`. `DEV_NO_AUTH=true` runs the API as one
implicit Owner and is force-disabled when `NODE_ENV=production`. Sign-in is
email + password + an optional TOTP second factor (`lib/totp.ts`,
`routes/auth.ts`).

**Access is data, not code** — `lib/permissions.ts`, `lib/accessRoles.ts`,
`middleware/permissionGate.ts`, `routes/access.ts`, the `/team` screen. Until
Aug 2026 it was six values in a Prisma enum and `requireRole("OWNER", …)`
written into twenty routers, so "can a Project Manager see invoices" was a code
change and a deploy — and there was no screen for any of it: the endpoints to
invite somebody and set their role existed and **nothing in the client had ever
called them.**

- **The catalogue is code; the grants are rows.** `PERMISSION_MODULES` is the
  list of every gateable action, because a permission is only real if a route
  checks it — a row in a table no gate names is a tick that reads as a
  restriction and enforces nothing. `AccessRole` stores only *which* of those
  keys a role holds, so the Owner can invent "Lead" without a deploy.
- **`gateBy` is one line per router, keyed on the HTTP method**, with a `routes`
  list for the actions that are not CRUD (sending, importing, anything that
  spends). The alternative was `requirePermission` on each of ~300 routes, whose
  failure mode is not a compile error but one POST somebody forgot.
  **`view` is required for every request**, so nobody can write into a module
  they cannot read.
- **Effective access is `(role + extra) − denied`, and deny wins.** A revocation
  that silently reverses itself when somebody later widens the role is the kind
  of thing nobody notices until it is in a log.
- **The Owner role short-circuits before the list is read.** That is what makes
  a lockout impossible, and therefore what makes every other role safe to narrow
  to nothing.
- **`ensureSystemRoles()` sets permissions on create and never on update.** The
  single most important line in the feature: a seeder that reinstated the
  shipped list would undo the Owner's own tightening on the next deploy, with
  nothing on any screen to say why access came back.
- **A new account and a new role both start with nothing.** The old invite route
  defaulted people to `DEVELOPER`, which on the day this shipped meant every
  lead, client, proposal and invoice in the business, chosen by a `.default()`
  in a Zod schema.
- **`STARTER_ROLES` is the exception, and a different category from
  `SYSTEM_ROLES`.** A system role is furniture — undeletable, fixed name,
  referred to by key in this codebase. A starter role is a *head start*: an
  ordinary editable row that arrives with sensible ticks on it and can then be
  renamed, narrowed or thrown away. `Lead` is the one, and its permission list
  is **derived from `moduleKeys("leads")` rather than written out**, so a lead
  permission added in six months is in the role whose entire definition is "all
  of them" without anybody remembering. Seeded once behind
  `SETTING.ACCESS_STARTER_ROLES`: checking whether the row is *absent* instead
  would resurrect a deleted role on every boot, for ever, with nothing on any
  screen to explain it. `ensureStarterRoles()` takes the seed list and the
  marker as arguments because that is the only way `checks/access.ts` can
  exercise it without deleting and recreating the real `Lead` row — a check that
  quietly widens somebody's access is worse than anything it catches.
- **Nobody may grant what they do not hold**, and nobody edits their own access.
  Without the first, `team.access` is equivalent to every permission in the
  catalogue.
- The `Role` enum survives on `User` and **decides nothing** — it is kept in
  step with the seeded role for the old rows and for `OWNER_PASSWORD`
  bootstrapping. `scopeExternal` replaces `scopeClientViewer` and keys off
  `AccessRole.external`, still a closed door until a client portal exists.
- Three keys were **deleted rather than shipped** because no route could enforce
  them (`leads.assign` — `Lead` has no assignee column; `inbox.reply` —
  answering is a send, governed by `emails.send`; `settings.security` — no such
  route). `checks/access.ts` fails if a catalogue key is never gated, or if a
  gate names a key that cannot be granted.

`checks/access.ts` is the committed half (55 assertions, database only).
`tmp/accessOverHttp.ts` is the one that cannot be faked: it signs a real person
on a narrow role in over real HTTP and asserts the 403s, because a gate that is
registered but never mounted compiles, unit-tests green and lets everything
through. **Run it with `DEV_NO_AUTH=false`** — `.env` sets it true, and against
an implicit Owner every refusal assertion fails and the cause looks like the
gate.

**[SECURITY.md](../../SECURITY.md) is the security runbook** — what protects what,
where each control lives, the two accepted risks, and the four things still
waiting on somebody with a login. Read it before touching auth, headers, uploads
or the webhook intake. Four rules from it that are easy to undo by accident:

- **Never write `include: { user: true }`.** A whole `User` row carries the
  password hash, the TOTP secret and the recovery-code hashes, and
  `GET /api/projects/:id` shipped all three to every signed-in user for months.
  `select: PUBLIC_USER` from `lib/userSelect.ts`.
- **`trust proxy` is a hop count, never `true`.** The login limiter reads
  `req.ip`; trusting the whole chain means trusting whatever the caller put at
  the front of `X-Forwarded-For`, which turns a per-address limiter into a
  per-request one that stops nobody.
- **Every path that sets a password goes through `lib/passwordPolicy.ts`.**
  There were three copies of `min(10)` in two files before it; the weakest path
  is the one an attacker uses.
- **Uploads are judged on their bytes** (`lib/fileType.ts`), never on the
  filename or the `data:` prefix, both of which the caller writes.
- **A 500 is deliberately uninformative, and two error classes are exempt.**
  `AnalystError` and `ApifyError` are raised on purpose, at a known point, with
  a sentence somebody wrote for the person reading — "Add a ChatGPT key under
  Settings → AI models" is the answer, not a leak — so the handler in
  `index.ts` passes their status and message through. Everything else that
  reaches there is an accident, and an accident's message is a map of the
  system. This mattered: building a demo with no model connected threw a 503
  saying exactly what to do about it, and the Owner was shown "Something went
  wrong." The client now appends the log reference to that sentence so the
  useless version is at least traceable.

