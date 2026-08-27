# Website Builder — the whole plan, and where it has got to

The Website Builder is the first thing this company has built to **sell** rather
than to use. This file is the map: every part of
`AI_Website_Editor_System_Plan.pdf` (27 Aug 2026), what it means here, whether it
exists yet, and where it lives when it does.

**Keep this file honest.** A section marked *Built* means it works and something
asserts that it works. *Skeleton* means the screen or the signature exists and
says what goes there — it is a reminder, not a feature. *Not started* means
nothing exists but this line.

---

## The three decisions everything else follows from

Taken by the founder on 27 Aug 2026 when the plan was read. Do not quietly
reverse any of them.

1. **Hosted seats on os.dakyworld.com.** The customer logs into this OS with an
   external role scoped to their own site. There is **no installed module, no
   license server, no signed release packages and no update endpoint** — for a
   hosted product, "module updates" is a Railway deploy. This is why §2B and §7A
   of the plan are marked *dropped* below.
2. **Billing reuses CarePlan + Invoice + Paystack.** A builder subscription is a
   retainer with a tier and a feature list. There is no parallel `License` model.
3. **Editable regions, not blocks.** Held over from the original editor: a page
   has exactly the sections its HTML has. §4 stage 4 (repeatable regions a
   developer marks) is the only structural editing that will ever be added.

---

## Status by plan section

| § | What it asks for | Status | Where |
|---|---|---|---|
| 1 | Product definition — connector, scanner, editor, publisher | **Built** | `services/website/` |
| 2A | Hosted control plane | **Built** (it is this OS) | `server/` |
| 2B | Installed site module | **Dropped** — hosted delivery | — |
| 3.1 | Prevent draft overwrites | **Built** | `SitePage.draftRevision`, `routes/website.ts`, `ConflictDialog` |
| 3.2 | Cache repository reads | **Built** | `services/website/sourceCache.ts` |
| 3.3 | Fix route scoping | **Built** (hook in place) | `assertSiteAccess` in `routes/website.ts` |
| 3.4 | One-click rollback | **Built** | `GET/POST /pages/:id/versions/:vid/diff|publish`, `WebsiteVersions.tsx` |
| 3.5 | Human-readable change summaries | **Built** | `describeChanges`, `categoriseChanges` |
| 4.1 | Stage 1 — text and links | **Built** | the editor as it stands |
| 4.2 | Stage 2 — image management | **Skeleton** | `WebsiteAssets.tsx`, below |
| 4.3 | Stage 3 — controlled visual styles | **Built** (tokens outstanding) | `StylePanel.tsx`, `safeStyle` |
| 4.4 | Stage 4 — repeatable content | **Not started** | below |
| 5 | Stable field identity (`data-dw-field`) | **Not started** | below — the highest-value item left |
| 6 | AI as a validated change plan | **Skeleton** | `WebsiteAI.tsx`, below |
| 7A | Product module updates | **Dropped** — hosted delivery | `WebsiteUpdates.tsx` records why |
| 7B | Website code updates by pull request | **Not started** | below |
| 8 | Licensing and subscription | **Skeleton** | `WebsiteBilling.tsx`, below |
| 9 | Security requirements | **Partly built** | `SECURITY.md`, below |
| 10 | Data model additions | **Not started** | below |
| 11 | Publishing workflow | **Partly built** | below |
| 12 | Testing strategy | **Partly built** | below |
| 13 | Admin configuration | **Skeleton** | `WebsiteSettings.tsx`, below |
| 14 | Module menu and navigation | **Built** | `Layout.tsx`, `WebsiteLayout.tsx` |
| 15 | Sprint order | — | this file is the tracker |
| 16 | `website-editor-core` package | **Built** | `services/website/index.ts` |

---

## The screens

Nine live under `/website`, plus the editor. The eight that are skeletons each
render what they will hold, so the plan is visible in the product rather than
only in this file.

| Route | File | Status |
|---|---|---|
| `/website` | `pages/WebsiteOverview.tsx` | Built |
| `/website/sites` | `pages/Website.tsx` | Built |
| `/website/pages/:pageId` | `pages/WebsiteEditor.tsx` | Built |
| `/website/assets` | `pages/WebsiteAssets.tsx` | Skeleton |
| `/website/ai` | `pages/WebsiteAI.tsx` | Skeleton |
| `/website/team` | `pages/WebsiteTeam.tsx` | Skeleton |
| `/website/audit` | `pages/WebsiteAudit.tsx` | Skeleton |
| `/website/settings` | `pages/WebsiteSettings.tsx` | Skeleton |
| `/website/billing` | `pages/WebsiteBilling.tsx` | Skeleton |
| `/website/updates` | `pages/WebsiteUpdates.tsx` | Skeleton — and argues it should stay one |

A site detail screen (`/website/sites/:siteId`) is in the plan's route map and is
**not** built, deliberately: with one site, the Sites screen already shows that
site's pages, and a detail screen would be a click between a list of one and the
thing it contains. Split it out when there is a second site.

---

## What each skeleton owes

### Assets (§4 stage 2)

Upload → judge the bytes → strip metadata → resize → commit to the repository →
update `src` and `alt`. Then a library: every uploaded image, its alt text, its
dimensions, and which page and field uses it. Crop, focal point, decorative flag.

Two things already decided:

- **No native image dependency.** `cloudinary` is already a dependency and is
  already configured-at-use from encrypted settings (`lib/cloudinary.ts`), so it
  is the resize/compress/strip pipeline. With no Cloudinary key — today's state —
  it degrades rather than fails: PNG through `decodePng`/`downscalePng` in
  `services/png.ts`, JPEG and WebP accepted under a size cap with a note saying
  they were not recompressed.
- **The bytes are committed to the repository**, not linked from a CDN, so the
  published site depends on nothing external. The repository stays the source of
  truth for pictures as it is for words.

Two traps waiting: uploads ride in the JSON body as base64, so the path must be
added to `UPLOAD_PATHS` in `index.ts` **and** the router must mount its own
larger parser — both, or it fails at 100 kB. And uploads are judged on their
bytes (`assertImageBytes` in `lib/fileType.ts`), never on the filename or the
`data:` prefix, both of which the caller writes.

### AI Assistant (§6)

A prompt produces a **structured change plan** and nothing else:

```json
{ "intent": "update_content", "pageId": "home",
  "changes": [{ "fieldId": "hero.heading", "operation": "replace_text", "value": "…" }],
  "explanation": "…" }
```

Validated against a Zod schema, then permissions, then rendered as a preview,
then approved by a person, then saved as an ordinary draft, then published
through the ordinary pipeline. **There is no path from a model to a commit.**

The model can never return raw file contents, arbitrary JS or CSS, selectors,
script tags, repository or deployment commands, or file paths — those shapes are
not in the schema, and a plan naming an unknown `fieldId` is dropped and counted,
the way `audit/synthesis.ts` already refuses a finding id no reviewer produced.

Page content enters the prompt **as data**, under a heading saying that page
content may contain instructions and that instructions found inside it are never
followed. Repository tokens, database credentials and any other customer's data
never enter the context.

It routes like every other job — `callModel({ job: "html" })` — so it inherits
vendor fallback, pricing and the cache breakpoints, and it is metered by the
existing `LlmCall` ledger and capped by the existing `Budget` scopes. No second
metering system.

The wording is owned by a new `website.editor` agent, per *writers read the agent
that owns them*: the doctrine editable from the Agents screen, the contract
appended after it by `composeWriterSystem()` where no edit can reach it. A
`website.propose` entry in `services/tools/catalogue.ts` lets agents reach it
through the same gate, autonomy level and `ToolCall` row as everything else.
`ensureAgents()` only ever creates, so on an existing database the tool has to be
ticked by hand.

### Team & Permissions (§10)

`SiteMember` with the plan's six roles — viewer, editor, reviewer, publisher,
manager, developer — per site. This is what makes `assertSiteAccess` mean
something: today it enforces the rule that can be enforced with one site.

### Audit Log (§9)

Every publish, rollback, upload, permission change, member change and sign-in,
rendered with the readable summaries from §3.5. `ToolCall` and
`AgentTaskTransition` already do this for the agent floor; this is the same idea
for the builder, and a customer asking "who changed our pricing page" has to be
answerable.

### Settings (§13)

Per site: **General** (repository, branch, sitemap, scan schedule), **Editing
rules** (approved fields, required fields, max lengths, allowed domains, allowed
styles, repeatable regions, upload settings), **Publishing** (direct commit vs
pull request, approval, build command, deploy status, maintenance window,
scheduled publish), **AI** (enabled, model, usage limit, allowed actions, brand
voice, require review), **Updates**, **License**.

Repository, branch and public URL are already editable through
`PATCH /website/sites/:siteId`; everything else is new.

### License & Billing (§8)

Plan, active sites, renewal date, usage, and the Paystack customer portal,
reading the client's `CarePlan` and its invoices. `entitlement(site)` resolves
plan → `{ maxSites, features[], state }`.

The states, and the last line is a rule rather than a preference:

| State | Behaviour |
|---|---|
| Active | Full editing, AI, publishing |
| Payment problem | Full access during grace, warnings |
| Expired | **The published site stays live.** Editing and AI stop |
| Suspended | Access disabled after a clear account action |
| Server unavailable | Temporary grace |

**Never take a customer's public website down because their builder subscription
lapsed.** They paid a developer to build that site; the builder is a convenience
over it, not the thing holding it up.

`BudgetExceeded` is the precedent for the error class: a fixable billing state
must read as a sentence naming what to do, never "Something went wrong".

### Updates (§7)

Kept as a screen only so the decision is visible rather than forgotten. §7A is
about a module installed in a customer's own project checking an update endpoint,
verifying a signature, backing up and rolling back. **There is no such module**,
so there is nothing to update — a Railway deploy updates every customer at once.

§7B is real and is **not** built: changing a customer's actual site code must
never silently overwrite their work. Publish-by-pull-request — branch, preview,
PR, merge only after approval — using `createBranch` and `openPullRequest`, which
already exist in `lib/github.ts`. It belongs on the Settings screen as a per-site
`publishMode`, not here.

---

## The data model still to add (§10)

Nothing below exists yet. Each needs its own migration, and remember that
**Postgres enum values cannot be added and used in one migration** — the addition
needs its own earlier one.

| Model | Holds |
|---|---|
| `SiteMember` | user, site, role (viewer/editor/reviewer/publisher/manager/developer) |
| `SiteField` | stable key, label, field type, selector/marker, editable, required, max length, allowed styles, confidence |
| `SiteAsset` | site, filename, content type, bytes, dimensions, repo path, alt, uploader, and which page/field uses it |
| `SiteAuditEvent` | actor, site, page, kind, summary, at |
| `PublishJob` | site, page(s), state, commit, build result, deploy result |
| `SiteSettings` | the §13 configuration, per site |

### The definitions, ready to paste

Written out here rather than added to `schema.prisma` now, because an empty table
in a customer's database is a migration nobody asked for and a model nobody
reads. Take the one you need when you build the screen that needs it.

```prisma
enum SiteMemberRole {
  VIEWER
  EDITOR
  REVIEWER
  PUBLISHER
  MANAGER
  DEVELOPER
}

/// Who may touch one site. The access catalogue answers "may this person edit
/// websites" and never sees which one; this is the other half.
model SiteMember {
  id     String @id @default(cuid())
  site   Site   @relation(fields: [siteId], references: [id], onDelete: Cascade)
  siteId String
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId String

  role      SiteMemberRole @default(VIEWER)
  invitedBy String?
  createdAt DateTime       @default(now())

  @@unique([siteId, userId])
  @@index([userId])
}

enum SiteFieldConfidence {
  /// A developer wrote `data-dw-field` on the element. Survives a restructure.
  HIGH
  /// Found by position. Correct until somebody inserts a section above it.
  MEDIUM
}

/// What a page offers for editing, and the rules on it. The parse still finds
/// fields; this is what a developer has decided *about* them.
model SiteField {
  id     String @id @default(cuid())
  site   Site   @relation(fields: [siteId], references: [id], onDelete: Cascade)
  siteId String
  page   SitePage? @relation(fields: [pageId], references: [id], onDelete: Cascade)
  pageId String?

  /// The stable key: `hero.title`. Matches `data-dw-field` where one exists.
  key        String
  label      String
  kind       String
  confidence SiteFieldConfidence @default(MEDIUM)

  editable      Boolean  @default(true)
  required      Boolean  @default(false)
  maxLength     Int?
  /// Style properties this field may carry. Empty means the site default.
  allowedStyles String[] @default([])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([siteId, key])
  @@index([pageId])
}

/// A picture in the repository, and what uses it.
model SiteAsset {
  id     String @id @default(cuid())
  site   Site   @relation(fields: [siteId], references: [id], onDelete: Cascade)
  siteId String

  filename    String
  contentType String
  bytes       Int
  width       Int?
  height      Int?
  /// Where it was committed, relative to the repository root.
  repoPath    String
  /// The description read out to somebody who cannot see it. Empty and
  /// `decorative` is a decision; empty and not decorative is a defect.
  alt         String  @default("")
  decorative  Boolean @default(false)

  uploadedBy   User?   @relation(fields: [uploadedById], references: [id], onDelete: SetNull)
  uploadedById String?
  createdAt    DateTime @default(now())

  @@unique([siteId, repoPath])
  @@index([siteId, createdAt])
}

enum SiteAuditKind {
  PUBLISH
  ROLLBACK
  DRAFT_DISCARD
  ASSET_UPLOAD
  ASSET_DELETE
  MEMBER_CHANGE
  SETTINGS_CHANGE
  SIGN_IN
}

/// The record. "Who changed our pricing page" has to be answerable.
model SiteAuditEvent {
  id     String @id @default(cuid())
  site   Site   @relation(fields: [siteId], references: [id], onDelete: Cascade)
  siteId String
  page   SitePage? @relation(fields: [pageId], references: [id], onDelete: SetNull)
  pageId String?

  kind SiteAuditKind
  /// One sentence, from `describeChanges`, so this and the version list cannot
  /// disagree about what a publish did.
  summary String
  /// The full change list, for the detail view.
  detail  Json?

  actor   User?   @relation(fields: [actorId], references: [id], onDelete: SetNull)
  actorId String?
  /// Kept as text as well, because a deleted user must not erase the record.
  actorName String

  createdAt DateTime @default(now())

  @@index([siteId, createdAt])
  @@index([pageId, createdAt])
}

enum PublishJobState {
  QUEUED
  COMMITTING
  BUILDING
  DEPLOYED
  FAILED
}

/// Publishing as a job, so a slow commit-build-deploy shows progress rather
/// than a spinner, and a failure is inspectable afterwards.
model PublishJob {
  id     String @id @default(cuid())
  site   Site   @relation(fields: [siteId], references: [id], onDelete: Cascade)
  siteId String
  /// Empty for a site-wide publish — "Publish all drafts" is one commit.
  pageIds String[] @default([])

  state     PublishJobState @default(QUEUED)
  commitSha String?
  commitUrl String?
  /// Null until it fails. The sentence, not the stack.
  failure   String?

  requestedBy   User?   @relation(fields: [requestedById], references: [id], onDelete: SetNull)
  requestedById String?

  /// Set to run it later. Null publishes now.
  scheduledFor DateTime?
  startedAt    DateTime?
  finishedAt   DateTime?
  createdAt    DateTime  @default(now())

  @@index([siteId, createdAt])
  @@index([state, scheduledFor])
}

/// The §13 configuration. One row per site, created with the site.
model SiteSettings {
  id     String @id @default(cuid())
  site   Site   @relation(fields: [siteId], references: [id], onDelete: Cascade)
  siteId String @unique

  // Publishing
  /// COMMIT writes to the branch. PULL_REQUEST branches, previews and waits.
  publishMode      String  @default("COMMIT")
  requireApproval  Boolean @default(false)
  maintenanceWindow String?

  // Editing rules
  allowedLinkDomains String[] @default([])
  maxUploadBytes     Int      @default(5000000)

  // AI
  aiEnabled       Boolean @default(false)
  aiMonthlyUsdCap Decimal? @db.Decimal(10, 2)
  aiRequireReview Boolean @default(true)
  brandVoice      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Two columns belong on models that already exist:

```prisma
// On User — the column middleware/auth.ts already names as the missing piece
// that makes a client portal possible.
client   Client? @relation(fields: [clientId], references: [id], onDelete: SetNull)
clientId String?

// On Site — which retainer pays for this site's builder seat.
carePlan   CarePlan? @relation(fields: [carePlanId], references: [id], onDelete: SetNull)
carePlanId String?
```

`SiteInstallation` from the plan is **not** needed — it belongs to the installed
module that is not being built.

`Draft` + `DraftChange` as separate tables are **not** needed either: §3.1 asked
for multi-user draft safety, and `SitePage.draftRevision` provides it without
splitting a working draft across two tables. Revisit only if per-field ownership
inside one draft is ever wanted.

---

## Field identity (§5) — the highest-value item left

Ids are positional today, which is why every stored edit carries `original`: a
draft written against a heading that has since moved refuses to publish rather
than writing into whatever now sits there. That is correct and it is a
consolation prize.

The fix is to read an element's own `data-dw-field` as its id where it has one,
falling back to positional discovery where it does not:

```html
<h1 data-dw-field="hero.title">Build better websites</h1>
<a data-dw-field="hero.cta" href="/contact">Start a project</a>
<article data-dw-item-id="service-1">
  <h3 data-dw-field="service-1.title">Brand strategy</h3>
</article>
```

Two confidences, both supported: **automatic discovery** (medium — needs
developer approval) and **developer annotation** (high). An annotated page's
drafts stop expiring when somebody inserts a section above them, which removes
the entire class of conflict `original` exists to catch.

---

## Publishing (§11)

Built: permission check → fetch latest source → compare → validate draft →
commit → record version.

Not built: **license check**, **preview diff before confirming** (the rollback
path has one; the ordinary publish still uses `window.confirm`), **job-based
publishing** with build and deploy state, **"Publish all drafts" as one commit**
for site-wide nav and footer changes, **approval workflow**, and **scheduled
publish** on the existing minute tick.

---

## Security (§9)

| Requirement | State |
|---|---|
| Encrypt repository tokens at rest | Built — `AppSetting`, keyed by `APP_SECRET` |
| Prefer GitHub App auth over personal tokens | Not started |
| Never expose tokens to the browser | Built |
| Keep AI provider keys server-side | Built |
| Verify site ownership before activation | Not started — needs `SiteMember` |
| Restrict repository and branch access | Built — the writable-repository list |
| Require confirmation before publishing | Built (`window.confirm`; §11 wants a diff) |
| Log every publish, rollback, upload, permission change | **Not started** — `SiteAuditEvent` |
| Rate-limit autosave, AI, uploads, publishing | **Not started** — `rateLimit()` exists in `middleware/security.ts` |
| Sanitise text, rich text, links, images, CSS, SVG separately | Built — `sanitize.ts`, `safeStyle` |
| Enforce CSP, sandbox previews in iframes | Built — `previewDocument` |
| Scan uploads | Not started |
| Make destructive operations reversible | Built — rollback, and history is never deleted |

**The CSP trap, because it has already cost five rounds:** a nonce anywhere in
`style-src` makes a browser ignore `'unsafe-inline'`, and `'unsafe-inline'` is
what permits a `style=""` attribute — which is the only thing this editor writes.
`style-src-attr 'unsafe-inline'` is what puts attributes back.
`checks/websiteVisual.ts` asserts it. **Assert the computed style, never the
attribute:** four rounds of green tests asserted the attribute while the feature
was dead.

---

## Testing (§12)

| Kind | State |
|---|---|
| Parser fuzz — unclosed tags, nested quotes, comments holding tags, entities, SVG, duplicate attributes | **Built** — `checks/website.ts` |
| Byte-preserving splice over every real page | Built — `checks/website.ts`, `checks/websiteVisual.ts` |
| Draft conflict, cache, rollback, scoping, readable summaries | **Built** — `checks/websiteBuilder.ts` |
| Security — XSS, `javascript:` URLs, CSS injection, SVG scripts, event handlers | Partly — `checks/website.ts` covers the sanitiser |
| Security — prompt injection | Not started, with §6 |
| Security — cross-site access, expired-license access, token leakage, role escalation | **Not started** — needs `SiteMember` and entitlement |
| Integration — GitHub read, commit, build failure, rate limits, token expiry | Not started |
| Browser (Playwright) | Not started. The house pattern is `tmp/shot.mjs` over the DevTools protocol; there is no Playwright here |
| Backup and recovery — failed commit, rollback after a bad publish | Partly — rollback is built and checked |

**The one that cannot be faked:** the client portal must be exercised over real
HTTP with `DEV_NO_AUTH=false`, following `tmp/accessOverHttp.ts`. `.env` sets it
true, and against an implicit Owner every refusal assertion passes for the wrong
reason. A lying green run is the specific trap.

---

## Order to build in

1. **Field identity (§5)** — it makes every draft after it more durable, and
   everything else is easier on top of stable ids.
2. **Assets (§4 stage 2)** — the most-asked-for missing feature for a client.
3. **Settings (§13)** — the management hub the rest hangs off.
4. **AI (§6)** — wants stable ids underneath it.
5. **Members, entitlement, audit log (§8, §9, §10)** — the commercial layer,
   and the client portal is the riskiest change in the whole programme.
6. **Publish jobs, PR mode, scheduled publish (§7B, §11)**.
7. **Expansion** — GitLab, Netlify, SFTP, WordPress, React/Next, white-label.
   Behind a provider interface the GitHub path is already shaped like.
