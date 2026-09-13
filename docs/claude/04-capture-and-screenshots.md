# Screenshots, the Dakyworld actor, and fetching a site

> Part of the Dakyworld OS architecture notes. The index is in [CLAUDE.md](../../CLAUDE.md).

**The screenshot actor is Dakyworld's own** — `apify/dakyworld-screenshot/`
in this repository, pushed to Apify with `apify push`, called through
`services/apifyScreenshot.ts`. Read that folder's README before changing
anything about a picture; what follows is why the server half looks the way it
does.

Until 2 Sep 2026 it was four strangers' actors and a translation layer. Every
screenshot actor on the store does the same job under a different input schema
— `urls` vs `link_urls`, `viewportWidth` vs `window_Width` vs `width`, `proxy`
vs `proxyConfig` vs `proxyConfiguration` — so `buildScreenshotInput()` read the
configured actor's *published schema* at run time, cached it for six hours, and
sent only keys that actor declared. That was the right answer to the problem it
had, because **Apify ignores an unknown input key in silence**: the failure mode
of guessing is a perfectly successful run at the wrong size with nothing
anywhere saying so. Owning the actor deletes the problem rather than the
defence. `screenshotActors.ts` and its four profiles are gone; the run body is
now six fields and no lookup.

- **The id is the whole point, and it is a safeguard rather than a
  convenience.** Every request carries one and every row carries it back, and
  `siteShot` matches on nothing else. What it replaced looked for the address
  inside the dataset row and **fell back to position**, so one page failing
  part-way through a batch shifted every picture after it onto the *next*
  business — a report, an email and sometimes a public demo page carrying
  somebody's name that is not theirs. `matchItem()` is gone.
  `checks/screenshots.ts` returns the rows shuffled with one missing, which is
  the shape that makes position wrong.
- **The actor cuts the picture down, so the server no longer decodes one.**
  `maxWidth` (1024) and `maxHeight` (2400 desktop, 3200 phone) go out with the
  run and Sharp does the work inside the actor. The uncut capture is stored
  beside it and fetched only when somebody asked for it (`withFullImage`),
  refused above 10 MB — which is what `fileStore` will take — with the crop
  surviving and a sentence saying only the top of the page was kept. The server downloads roughly a
  tenth of the bytes it used to — a 1024x1920 picture instead of a 1280x12000
  page — and `cropPngTop`/`downscalePng` are gone from `services/png.ts`. The
  **decoder stays**: `audit/annotate.ts` draws numbered boxes onto the picture
  and pixel writes need pixels.
- **`maxHeight` is measured in *captured* pixels, before the resize**, because
  the crop happens first: 2400 rows of a 1280-wide capture is 1920 rows once it
  is shrunk to 1024. Resizing first would throw away half the page.
- **Two pictures come back for two readers, and both are now kept.**
  `screenshotUrl` is the cut-down one the model reads; `fullScreenshotUrl` is
  the capture, and is null when the crop and the resize both did nothing, in
  which case they are the same picture. `ShotOptions.withFullImage` brings the
  capture's *bytes* back as well as its link — off by default, on wherever a
  person will look at the result (one lead being prepared, a website review) —
  because an Apify key-value-store link expires with the run's data, and before
  Sep 2026 a lead looked at last month showed a broken image on the one screen
  a person uses to disagree with the model. The whole page is never sent to a
  model: a 12,000px picture is past every vendor's edge limit, and the argument
  rests on what a visitor sees first.
- **The proxy moved into the actor**, where it is forced on and a page gets a
  session of its own. The server no longer knows Apify has proxy settings, which
  was the last actor-shaped thing in it.
- **A private actor's key-value store can refuse an anonymous read.** A bare
  `fetch` of the picture was right while the actor was somebody else's public
  one; `downloadScreenshot()` retries a 401 or 403 with the token, because that
  failure would otherwise look exactly like a website blocking us.
- **A certificate warning is clicked past here too, at last.** The actor retries
  a TLS failure once with `ignoreHTTPSErrors` on that one browser context — the
  same decision `companyAudit.fetchSite` has made since Aug 2026, which the
  screenshot half could not follow while the actor belonged to somebody else.
  The row comes back `insecure: true`, it reaches the report as
  `Screenshot.insecure`, and the note beside the picture says the connection was
  not verified. **[SECURITY.md](../../SECURITY.md) is where the scope is written
  down**, and it now names both places.

**Screenshot cost is the actor booting, not the picture** — an Apify run starts
a container and a browser before it does anything useful, and that boot is
identical for one page or twenty. So `captureHomepages()` is the real function
and `captureHomepage()` wraps it; `prepareLeads()` batches a whole selection
into `ceil(n / MAX_BATCH)` runs instead of n. Sixty leads is three runs, not
sixty. The other levers, in order of size: not re-shooting what is still fresh
(`skipFresh`), `runOptionsFor()` sizing memory and timeout to the batch (compute
is billed in gigabyte-hours), and the resize to 1024 — vision is billed in 512px
tiles, so 1280x2400 is 15 tiles and 1024x1920 is 8.

**Desktop and phone are one run, everywhere a homepage is photographed** —
`captureHomepageViews()` for one page, `captureHomepageViewsBatch()` for many,
used by `audit/evidence.ts` and, since Sep 2026, by `leadPrep` as well. Each
page in the contract may carry its own `viewport` and `maxHeight`, so the two
pictures of one homepage cost one container boot and one extra page load
instead of two of everything. Measured on the actor (`test/timing.ts`): a run's
fixed cost is ~3.1s of process start and browser launch before any page,
against ~0.2s of marginal work per extra page — the whole reason batching is
the design. **The batching argument and the two-viewport argument are the same
argument, so they compose**: `MAX_BATCH` counts *pages*, so a batch is chunked
at ten businesses and each chunk is one run of twenty pages.

**The lead scan sees both views too, and so does the model that reads them.**
Until Sep 2026 the drawer showed one laptop picture and `lookAtHomepage` was
handed one image, which meant the most saleable fault in this trade — a page
that lays out correctly at 1280 and spills off the screen at 390, where nearly
every one of these businesses is actually looked up — was invisible to the
whole pipeline. `HomepageLook.onAPhone` and `on` per observation carry it into
the letter. Both are refused outright when there was no phone picture: a claim
about somebody's site at phone width, made from a laptop screenshot, is a false
statement to the one person who can check it.

**A lead's pictures are files now, not links** — `services/leadShots.ts`,
`LeadResearch.shots`, `GET /api/leads/:id/screenshot/:name` (`desktop.png`,
`desktop-full.png`, and the same two for `mobile`). Two rules keep the database
from filling up with homepages: only where a person is going to look (one lead
being prepared files its pictures, a batch of sixty keeps the links —
`PrepOptions.keepPictures`), and a re-run replaces rather than adds. The
website review files a third copy per view, `<view>-full.png`, beside the crop
and the marked-up one; `shotFilesOf` carries a `full` flag, and **anything
selecting "the plain picture" has to exclude it** or the annotator and the PDF
are handed a 12,000px strip.

That change reversed one guard on purpose. The phone picture used to be asked
for **only when the desktop one worked**, which was right while it meant a
second run and a second bill; inside one run it is one more page load against a
browser that is already open, and a site that serves one viewport and breaks on
the other is exactly what the phone shot is for. `evidence.ts` still prints one
sentence rather than two when neither worked — a site that blocks automated
browsers blocks both, and saying so twice reads as two faults.

**A section that did not run says why, and the reason is the real one.** The
UI/UX reviewer used to print a *guess* when it had no pictures — "it usually
means no Apify token is connected" — whatever had actually happened, and the
first time that guess was wrong it sent somebody to check a token that was fine
while the real cause (an actor that had never been deployed) went unnamed on the
one screen that had been handed it. `reviewUx` reads
`evidence.stepNotes.screenshots` now, and the fallback mentions no cause at all,
because every reason `siteShot` can have already comes back as a sentence — no
token, an actor not on the account, a run that failed, a page that timed out, a
picture no model will read. A branch that invents a cause can only disagree with
one of them. `checks/auditRerun.ts` holds it, including the negative that a
section with no reason must not invent one.

**The actor is still a setting** (`capture.screenshotActor`,
`GET`/`PUT /api/settings/capture/screenshot-actor`) for a narrower reason than
before. It is no longer a choice between vendors: the username half of an actor
id is the Apify account it was pushed to, so a deployment whose account is not
`dakyworld` has to say so, and a staging copy should be reachable without a
deploy. **The Apify account is `daky_world`, with an underscore.** Not a guess and not
lookup-able from a developer machine: the first automatic deploy shipped naming
`dakyworld`, Apify created the actor under the account the **token** belongs to,
and the mismatch guard stopped before building and said so in the boot log. The
username half of an actor id is whichever account the token is on. Everything
asserting against it carries the same spelling.

**The app deploys the actor itself** — `services/screenshotActorDeploy.ts`,
`POST /api/settings/capture/screenshot-actor/deploy`, and a boot pass. This was
the last thing standing between a good deploy and no screenshots: the actor's
source is in this repository, `apify push` deploys it, and `apify push` needs
the Apify CLI, Docker and a login on somebody's machine — while **the app holds
the token and could do nothing with it**. Apify's `GIT_REPO` source type is the
way round: an actor version names a public repository and a subdirectory and
Apify clones and builds it. No Docker, no CLI, and nothing needed in the
container, which matters because Railway's root is `server/` and the actor
lives beside it.

- **Creating a version and updating one are different calls.**
  `PUT /versions/{n}` only updates one that exists; a brand-new actor needs
  `POST /versions`. PUT-only returns 200 and the *build* then fails with "Actor
  version was not found", which points at the wrong call. `setActorGitVersion`
  lists the versions and picks; both paths are live.
- **Deployed is not up to date, and this is the one that keeps a fix working.**
  The actor's source ships in this repository and Apify holds whatever was last
  built out of it; nothing on an actor's record says which version of ours that
  was. `ACTOR_SOURCE_VERSION` in `apifyScreenshot.ts` is that answer — **bump it
  in the same commit as any change under `apify/dakyworld-screenshot/src/`** —
  and a successful build records it. The boot pass rebuilds when it differs.
  Without it a fixed actor stays broken on Apify for ever, because the pass only
  ever built one that was *missing*; rebuilding on every deploy instead would
  spend an Apify build each time anybody pushed anything at all. A failed build
  records nothing, or a broken actor looks current for ever.
- **Present is not runnable.** `findActor` reports `hasBuild` from
  `taggedBuilds`, and both the readiness check and the deploy pass require it.
  An actor whose creation succeeded and whose build failed exists, answers
  `GET /acts/:id` happily, and cannot be run — the first version skipped it as
  "already there" and called it ready, which would have left a permanently
  broken account looking healthy. `checks/screenshotDeploy.ts` caught that.
- **The boot pass tries once per *deployment*** — the third answer to that
  question and the one a real failure chose. Once ever hides a build that failed
  on a bad afternoon behind a marker nobody can see; once a *day* was the second
  answer, and when the next run failed on a one-line bug the marker refused to
  try the fix until tomorrow, putting a rate limit meant to stop waste between a
  working fix and a working system. A deployment is the right unit: a restart or
  a crash loop keeps the same `RAILWAY_DEPLOYMENT_ID` and does not retry, a push
  does.
- **It will not build onto the wrong account.** The username half of an actor id
  is the account the token belongs to; Apify says which on create, and a
  mismatch stops with that name in the sentence rather than leaving a working
  actor nothing will ever call.
- `SCREENSHOT_ACTOR_REPO` overrides the source for a fork or a branch.

`apify push` still works and is the faster path at a terminal:
`APIFY_TOKEN=<the one in Settings → Lead Sources → Connection> apify push`.

**There is no half-measure while it is undeployed**, and that is the deliberate
cost of having one actor instead of four: pointing `capture.screenshotActor` at
a store actor no longer works, because the server sends the Dakyworld contract
and nothing on the store reads it — and a run that comes back with rows carrying
no `id` is reported as exactly that rather than as twenty pages that each
"finished without producing a result".

**The monthly Apify ceiling is seeded, not defaulted** —
`SEEDED_MONTHLY_BUDGET_USD` (10) and `seedCaptureBudget()` in
`captureConfig.ts`. The distinction is the whole design: **blank means no
ceiling**, and a *default* of ten would make that unsayable, because clearing
the box would put ten straight back. So ten is written once as a real stored
value the Owner can raise, lower, or clear — behind a marker, so clearing it
survives the next boot. Before this a deployment that never opened the settings
screen had no ceiling at all, and the meter read Apify's own free-plan credit
($5) as though it were one.

**A page that never finishes loading is still photographed.** `load` waits for
every image, font and script, and one third-party asset that never returns is
the commonest way a real small-business site fails to photograph — the document
itself rendered seconds earlier. A timeout drops one rung to
`domcontentloaded`, presses `window.stop()` (leaving the requests open only
moves the timeout from `goto` to `screenshot`), takes the picture, and marks the
row `partiallyLoaded` so the report carries the caveat rather than silence. Only
on a timeout: a refused connection gives the same answer twice.

**A connection timeout earns the direct retry, not just a proxy error.** A law
firm's site came back `net::ERR_TIMED_OUT` through the Apify proxy while
answering a plain request in 1.7 seconds. A datacentre range a host drops on the
floor does not announce itself as a proxy failure — it looks exactly like a dead
website, and the report then says a live business's site could not be opened.

**Chromium's vocabulary never reaches a business.** `NETWORK_REASONS` in the
actor translates each `net::ERR_*` into a sentence, the way `lib/whatsapp.ts`
translates Meta's codes. Two traps came with that, both caught by the actor's
own tests:

- **The retries must classify on the raw message, never the translated one.**
  Translating `ERR_CERT_DATE_INVALID` deletes the token the certificate retry
  tests for, which switched that retry off silently. `CaptureFailure.raw` keeps
  Chromium's words for the code, and off the contract so nothing downstream
  depends on them.
- **Only one half may frame the sentence.** The actor sends the reason and
  `describeRowFailure` puts the frame round it; both framing produced, in a real
  report, *"the page could not be opened. The page could not be opened:
  page.goto: net::ERR_TIMED_OUT at https://…"*. The same doubling hit
  "Nobody has seen how the site looks", once from `ux.ts` with a cause and once
  from `evidence.ts` without — that blanket note now only fires when nothing
  else has explained itself.

Three things about the picture that are still exactly as they were, because
getting any of them wrong is silent:

- **`fullPage` is sent `true`** and the crop happens afterwards. Sending `false`
  shortens every picture to the window height.
- **`viewportHeight` is a real device height** (800 desktop, 844 phone), not a
  fraction of the width. Three quarters of 390 is a 293px window, which is not a
  shape any site was designed against.
- **`waitUntil` is `load`, never `networkidle`.** A page with a chat widget or
  an ad script never goes idle, and waiting for it burns the whole timeout to
  produce the same picture.

`checks/screenshots.ts` (74, database only) drives the whole path against a
local express playing Apify, hosting the pictures **and playing Anthropic** —
the last of those is what proves the end of the line, that the bytes the actor
produced are the bytes `lookAtHomepage` hands a vision model, base64, PNG,
before the words. One harness rather than two because the thing being asserted
spans both vendors, and two harnesses agreeing about a picture is the
arrangement this refactor exists to stop needing.

Half of it is the negatives: a bad address must start no run, a site with no row
must get no picture rather than its neighbour's, an empty dataset must not read
as a broken run, a missing actor must not read as an outage, and an ordinary
picture must not come back marked insecure.

`fetchSite` checks *both* spellings of the host even when the first works, so
"only www resolves" is found whichever form the scrape happened to record. When
the stored address does not resolve and another form does, `leadPrep` corrects
the record — swapping only the hostname, not adopting the redirect's landing
path — which is the one case where overwriting stored data is a correction
rather than a loss. The fault itself survives as a finding and a tag.

Matching a dataset row back to the business that asked for it is done by the
id the request went out with, and by nothing else. A picture attached to the
wrong business is a page carrying somebody's name that is not theirs — see the
screenshot section above for what the id replaced.

**When a check fails, try the obvious alternative before reporting failure.**
This is the habit, not a one-off: `fetchSite` swaps www for the bare host and
retries a 403 as a browser; `leadPrep` photographs the address that *answered*
rather than the one on file; `post()` in the model layer waits out a 429 and
tries again. Each of those was a real failure that reached a person as a
sentence when the system could have solved it — "your website did not load",
"the model provider is rate-limiting this key", and a lead whose screenshot was
taken of a hostname with no DNS record so the look never ran at all.

**Rate limits are a queue, not a failure.** `post()` retries 429 and 5xx up to
four attempts, honouring `Retry-After` and capped at 90s of total waiting. It
matters most for the biggest requests, which are both the likeliest to be
limited and the most expensive to throw away — a demo build loses its design
lookup too. Relatedly: `max_completion_tokens` counts against a per-minute
budget whether or not it is used, so the demo asks for 16k rather than 32k.

**A failed question is not an answer** — `companyAudit.fetchSite()`. The audit
used to collapse every fetch failure into `catch { return null }` and raise a
CRITICAL "their website did not load at all". A real email went out saying that
to a company whose site loads in a second: the address on file was the apex,
which has no DNS record, while `www.` answers 200. So the fetch now tries the
www/apex pair, retries a 403 with a browser user agent, classifies the failure,
and **only DNS saying "no such host" on every candidate becomes a finding**.
Everything else — a timeout, a WAF, a chain Node rejects and a browser repairs —
is a `note`, and notes never reach the drafter. This is the same rule
`probeDns` already followed for DNS records, applied where it was missing. The
drafter and the polish carry it too: a negative claim that is not in the facts
is a false statement about somebody, made to the one person who can check it.

**A certificate warning is clicked past, not reported as a dead end.** The third
rung of that ladder retries a TLS failure with verification off — what a person
does at *Advanced → Continue to site*. It exists because of a real report whose
entire content was "we could not open it, and here is one thing about your mail
domain", about a site every visitor reaches by clicking the same button, with the
expired certificate never named. Now the page is read, every section is marked as
having come over an unverified connection, and the certificate is the loudest
finding in the document with the issuer and expiry date read off the socket
(`cert-untrusted`, CRITICAL; `sec-cert-untrusted` in the audit team; the
`Certificate warning` tag). **[SECURITY.md](../../SECURITY.md) is where the scope of
that relaxation is written down** — one call, no credential sent, never
`NODE_TLS_REJECT_UNAUTHORIZED`, and `routability()` re-checked on every redirect
hop. **The screenshot half follows it now**, which it could not while the actor
belonged to somebody else: none of the external ones declared an
ignore-certificate input, and inventing a key Apify silently drops is not an
implementation. Dakyworld's own actor retries a TLS failure once with
`ignoreHTTPSErrors` on that one context and marks the row `insecure`, so the
report shows the page *and* says the connection was not verified. `ux.ts` lost
its third branch with it — the sentence explaining why a site behind a
certificate warning had no picture would now be false, and a report explaining
a limit that no longer exists is worse than one that says nothing.

