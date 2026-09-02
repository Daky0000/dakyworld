# Dakyworld Website Screenshot

The Apify actor that photographs a prospect's homepage. Playwright and Chromium
inside; one stable input and output contract outside.

It exists because the alternative was worse in a specific way. Dakyworld OS used
four different screenshot actors from the Apify store, and no two of them agreed
on their input: one took `urls`, another `link_urls`; the viewport was
`viewportWidth`, `window_Width` or `width` depending on who wrote it; the proxy
arrived under `proxy`, `proxyConfig` or `proxyConfiguration`. So the server read
each actor's published schema at run time, cached it for six hours, and
translated Dakyworld's settings into whichever names that actor happened to use
— because **Apify ignores an unknown input key in silence**, and the failure
mode of guessing is a perfectly successful run at the wrong size with nothing
anywhere saying so.

None of that is needed once we own the actor. The server now sends a viewport,
and this reads a viewport.

## Deploying it

**The app does this on its own.** Dakyworld OS holds the Apify token, and
`services/screenshotActorDeploy.ts` uses it to create this actor and build it
straight from the public repository — on boot when the actor is missing, or on
demand from `POST /api/settings/capture/screenshot-actor/deploy`. Nothing below
is needed unless you want to deploy from a terminal, or you are working on a
branch the app does not know about.

Everything under here is the manual path. Needs the
[Apify CLI](https://docs.apify.com/cli) and an Apify account.

```bash
npm install -g apify-cli
cd apify/dakyworld-screenshot

# Either sign in interactively (opens a browser)…
apify login
apify push

# …or use the token Dakyworld OS already holds, with no browser at all.
# Copy it from the app: Settings → Lead Sources → Connection.
APIFY_TOKEN=apify_api_xxx apify push
```

The second form is the quicker one and it is the same token the app runs on, so
the actor lands on the account the app is already pointed at — which is the
thing most likely to go wrong about this.

`apify push` builds the Docker image on Apify and creates or updates the actor.
It lands as `<your-username>/website-screenshot`.

**The username half matters.** Dakyworld OS ships pointing at
`daky_world/website-screenshot` — with the underscore, which is the account
this company's token belongs to. If the Apify account is not `daky_world`, do not
edit the constant — set the actor id under **Settings → Lead Sources →
Screenshot actor** (`capture.screenshotActor`). That setting exists for this,
and for pointing a staging deployment at a staging copy.

Until it is deployed, every screenshot fails with a sentence naming the actor
and pointing at this folder, the server's boot log prints the same thing on
every deploy, and the audit's UI/UX section carries that exact reason rather
than a guess. All three are deliberate: an actor that has not been pushed yet is
a five-minute job, and Apify's own words for it ("Actor was not found") read as
an outage.

**There is no half-measure while it is undeployed.** Pointing
`capture.screenshotActor` at a store actor does not work any more: the server
sends this contract — `urls: [{ id, url }]`, a `viewport` object — and no actor
on the store reads it. That is the deliberate consequence of having one actor
instead of four and a translation layer, and it is why the only two positions
are *push this* or *revert the commit that introduced it*.

## Running it locally

```bash
npm install
npx playwright install chromium
npm test
```

`npm test` starts a local website that misbehaves on purpose — a page twelve
thousand pixels long, one that never finishes loading, one that redirects, one
narrower than the width we resize to — and runs `src/main.ts` against it as its
own process with Apify's local storage, exactly as the platform does. No Apify
account, no token, no network. See `test/local.ts`.

To run it by hand against a real site, put an input in
`storage/key_value_stores/default/INPUT.json` and `npm run start:dev`.

## The contract

`src/contract.ts` is the definition. It is mirrored, in shape only, by
`server/src/services/apifyScreenshot.ts` — the two halves are deployed
separately and neither can import from the other, **so a change to one is a
change to both in the same commit**.

```json
{
  "urls": [
    { "id": "lead_123", "url": "https://example.com" },
    { "id": "lead_456", "url": "https://example.org" }
  ],
  "viewport": { "width": 1280, "height": 800 },
  "fullPage": true,
  "delay": 3000,
  "maxWidth": 1024,
  "maxHeight": 2400
}
```

A page may carry its own `viewport` and `maxHeight`, overriding the run's. That
is the whole of how the audit gets a laptop picture and a phone picture of one
homepage without paying for two runs:

```json
{
  "urls": [
    { "id": "audit_desktop", "url": "https://example.com" },
    { "id": "audit_mobile", "url": "https://example.com",
      "viewport": { "width": 390, "height": 844 }, "maxHeight": 3200 }
  ],
  "viewport": { "width": 1280, "height": 800 },
  "fullPage": true, "delay": 3000, "maxWidth": 1024, "maxHeight": 2400
}
```

Out, one row per requested URL, always:

```json
{
  "id": "lead_123",
  "url": "https://example.com",
  "finalUrl": "https://example.com/",
  "success": true,
  "screenshotUrl": "https://api.apify.com/v2/key-value-stores/…/records/shot_0_lead_123",
  "fullScreenshotUrl": "https://api.apify.com/v2/key-value-stores/…/records/shot_0_lead_123_full",
  "width": 1024, "height": 1920,
  "fullWidth": 1280, "fullHeight": 9400,
  "cropped": true,
  "insecure": false,
  "viewportWidth": 1280, "viewportHeight": 800,
  "format": "png",
  "durationMs": 6120,
  "error": null
}
```

A failure is the same shape with `success: false`, every measurement null, and
an `error` carrying a code: `INVALID_URL`, `PAGE_TIMEOUT`, `NAVIGATION_ERROR`,
`SCREENSHOT_FAILED`, `IMAGE_PROCESSING_FAILED` or `BROWSER_LAUNCH_FAILED`.

### The id is a safeguard, not a convenience

Every request carries an id and every row carries it back, and the server
matches on nothing else. What it replaced looked for the address inside the row
and fell back to position — so one page failing part-way through a batch shifted
every picture after it onto the *next* business. A picture attached to the wrong
business is a report, an email and sometimes a public demo page carrying
somebody's name that is not theirs.

### Two pictures, for two readers

`screenshotUrl` is cropped to `maxHeight` and resized to `maxWidth`: it is what
the vision model reads, and it is roughly a tenth of the bytes of the capture.
`fullScreenshotUrl` is the capture itself, kept so a person can open what was
actually on the screen, and null when the crop and the resize both did nothing.

**Crop first, then resize** — so `maxHeight` is measured in captured pixels.
2400 rows of a 1280-wide capture is 1920 rows once it has been shrunk to 1024.
Resizing first would throw away half the page.

## Decisions worth knowing before changing something

- **The proxy is the actor's business and is forced on**, whatever a run's own
  input says; the input only chooses groups and country. A datacentre IP with no
  proxy in front of it is refused by a good share of small-business sites behind
  Cloudflare, and "their site blocks automated browsers" is indistinguishable
  from "their site is down" in the report that comes out. An account with no
  proxy goes direct rather than refusing to run. A page gets one session of its
  own, so twenty sites are twenty IPs.
- **`waitUntil: "load"`, never `networkidle`.** A page with a chat widget, an
  analytics beacon or an ad script never goes idle, and waiting for it burns the
  whole timeout to produce exactly the same picture. The `delay` after load is
  what catches fonts and a hero image.
- **The run ends before Apify ends it.** Pages are worked through against
  Apify's own timeout, and anything not reached when time runs short is written
  as a timed-out row. A run Apify kills is a run whose rows the caller never
  reads, so a batch that overruns would otherwise lose the pictures it did take.
- **Sequential, not concurrent.** Twenty pages at ~10s each fits inside the
  timeout the server asks for, and a batch that OOMs its container loses every
  picture in it — which is the one failure this design refuses to risk. If it
  ever needs to be faster, that is the lever, and it needs a memory-derived
  ceiling rather than a constant.
- **`media` is the only resource type blocked.** Video and audio on a homepage
  are megabytes paid for and never looked at. Images and fonts are the opposite:
  they are the thing being judged.
- **A real Chrome user agent.** A good share of small-business sites behind a
  WAF serve a challenge page to anything announcing HeadlessChrome, and a
  challenge page photographed and read by a vision model becomes a report about
  a website that does not exist.
- **Two retries, and only two.** A proxy that could not carry the request is
  retried without the proxy; a certificate a browser will not accept is retried
  with `ignoreHTTPSErrors` on that one context, which is what a person does at
  *Advanced → Continue to site* — and the row comes back `insecure: true` so a
  report showing the picture can say the connection was not verified. The scope
  of that second one is written down in the repository's `SECURITY.md`, and it
  is narrow on purpose: only on a certificate failure, only one context, never
  a browser-wide or process-wide switch, and nothing of ours is ever sent. A
  good certificate is verified normally. Everything else — a timeout, a refused
  connection, a 403 — gives the same answer the second time and costs another
  page load to say so.
- **The Docker tag and the `playwright` dependency move together.** The browsers
  baked into the base image live in a directory named for the Playwright version
  that installed them, so a package.json asking for a different version finds no
  browser and every run dies on "Executable doesn't exist at
  /home/myuser/.cache/ms-playwright/chromium-…".
- **PNG, 8-bit, no palette, explicitly.** The audit draws numbered boxes onto
  this picture with a decoder that reads greyscale and RGB(A) at 8 bits and
  refuses everything else. A palette PNG would be quietly unmarkable and the
  report would lose its annotations without saying why.

## What a run costs

Apify bills platform compute in **compute units**: 1 CU is one gigabyte-hour, so
a run at 2048 MB for T seconds is `2 × T / 3600` CU. That is the only charge —
this actor is private and charges no per-result fee of its own.

The shape of the bill is a fixed cost plus a marginal one, and both are
measurable. Measured on this actor with `test/timing.ts` against instant local
pages:

| | measured |
|---|---|
| Fixed, per run (process start, Apify init, Chromium launch) | **~3.1 s** |
| Marginal, per extra page (context, navigate, shoot, Sharp) | **~0.2 s** |

On Apify add the container start to the fixed half, and add the real page to the
marginal half — a page load plus the 3 s `delay`, so call it 6–10 s a page for a
real website. Neither of those two is measured here, and they are the reason the
live number still has to be read off one real run.

What the arithmetic says, and why the design is the shape it is:

- **The fixed cost dominates a single picture.** That is why `captureHomepages`
  batches and why `captureHomepageViews` puts both viewports in one run: two
  pictures of one homepage used to be two boots, and are now one boot and one
  extra page.
- **A batch of twenty spreads one boot across twenty pictures**, which is where
  a compute-priced actor beats a flat per-picture fee outright.

**Read the real number before quoting one.** After `apify push`, run one batch
of twenty and one audit pair, then read Runs → the run → *Compute units* in the
Apify console, or `usageTotalUsd` off the run record (the server already carries
it through to `Screenshot.costUsd`, shared out across the pictures that came
back).

## Two things deliberately not done

Both are improvements. Both change evidence the vision half was tuned against,
so each is a change to make on purpose with the vision half re-checked — not a
side effect of owning the actor.

- **Mobile emulation is off.** Playwright's `isMobile` is more faithful to a
  real phone: a page with no viewport meta tag is laid out at Chrome's 980px
  default and zoomed out, which is what a phone actually shows. It also means
  the phone screenshot comes back 980 wide instead of 390, which is not the
  picture the audit's UX reviewer and its prompts were written against. Turning
  it on is one line in `src/screenshot.ts` and a re-read of the UX section.
- **WebP is not offered, and the blocker is concrete rather than untested.** It
  would roughly halve the bytes, and every vision vendor accepts `image/webp`.
  What does not is Dakyworld's own report: `audit/annotate.ts` draws the
  numbered boxes onto this picture with the small PNG decoder in
  `services/png.ts`, and it refuses anything that is not a PNG — gracefully, by
  returning the plain picture and a note. So a WebP screenshot would silently
  cost every audit its annotations, which are the thing that makes a finding
  arguable rather than assertable. Switching format means giving `annotate.ts` a
  decoder that reads it, and that is a change to the report, not to this actor.
  `format` is reported as a constant `"png"` so the row shape does not move when
  it happens.

The third item on this list used to be **ignoring an invalid certificate**, and
it is done: see the retry bullet above and `SECURITY.md`.
