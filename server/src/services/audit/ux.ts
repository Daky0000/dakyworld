import { callModel, type PromptImage } from "../../lib/models/call.js";
import { PROVIDERS } from "../../lib/models/registry.js";
import type { AuditEvidence } from "./evidence.js";
import { DISCIPLINE_AGENTS, scoreFindings, sortBySeverity, trimFindings, type AuditFindingDetail, type DisciplineReport, type Region, type ScreenshotView } from "./types.js";

/**
 * The UI/UX review: what a first-time visitor actually sees.
 *
 * This is the only section of the report that cannot be measured. Everything
 * else — a header, a title tag, a certificate — is present or absent, and the
 * finding writes itself. Whether a page looks like it belongs to a serious
 * company, whether a stranger can tell within five seconds what is sold here,
 * whether the phone number is findable on a phone: none of that is in the
 * markup. It needs eyes.
 *
 * Two pictures, not one. A site that lays out perfectly at 1280 and spills off
 * the screen at 390 passes every check except the one that matches where the
 * customers are, and for most of the businesses this app writes to the phone
 * view *is* the site.
 *
 * **The regions are the feature.** Every observation the reviewer can point at
 * comes back with a box — in fractions of the image, so it survives every
 * resize — and `annotate.ts` draws them numbered onto the picture. A report
 * that says "the hero does not say what you sell" is an opinion; the same
 * sentence beside a box drawn around the hero is something the owner can
 * argue with, which is what makes them read the rest.
 *
 * The boxes are approximate and the document says so. A model can point at the
 * top third of a page reliably; it cannot measure to the pixel, and claiming
 * otherwise in a caption would be the same kind of false precision as
 * reporting a Lighthouse score nobody ran.
 */

/** The cap the schema asks for in words, applied to what comes back. */
const MAX_OBSERVATIONS = 10;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "firstImpression", "fitsTheBusiness", "observations"],
  properties: {
    headline: { type: "string", description: "One sentence, under fifteen words: the state of this site's design. No jargon." },
    summary: {
      type: "string",
      description:
        "Two or three sentences a business owner reads instead of the list. What a stranger takes from this page, and the one thing about how it looks that is costing them.",
    },
    firstImpression: {
      type: "string",
      description:
        "The five-second test: what somebody who has never heard of this business can tell about it from the first screen alone. Describe what is there, not what is missing.",
    },
    fitsTheBusiness: {
      type: "string",
      description:
        "The gap between what this company evidently is and what its page makes it look like. This is the point that lands hardest with an established firm — an eighteen-year-old company whose page looks like a 2013 template is losing work to smaller competitors who look bigger. Say 'no gap' if there is none.",
    },
    observations: {
      type: "array",
      // Not `maxItems`: structured outputs reject array constraints, so the
      // cap goes in the description and is enforced by the slice below.
      description: "At most 10, worst first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "observed", "where", "view", "impact", "plainly", "recommendation", "severity", "region"],
        properties: {
          title: { type: "string", description: "A few words, as a heading. 'Nothing above the fold says what they sell'." },
          observed: {
            type: "string",
            description:
              "What is visibly true in the picture, in words the owner would use. Only what you can see. Never a claim about a page you were not shown, about their booking system, or about how fast the site is.",
          },
          where: { type: "string", description: "Where on the page: 'the hero', 'the top navigation', 'the first screen', 'the footer'." },
          view: { type: "string", enum: ["desktop", "mobile"], description: "Which of the two pictures this is about." },
          impact: { type: "string", description: "What it costs them — a customer, an enquiry, a comparison lost. One sentence, concrete, no adjectives." },
          plainly: {
            type: "string",
            description:
              "The same point as somebody would say it across a desk, with no web vocabulary in it at all. No 'hero', no 'above the fold', no 'CTA'. This is the sentence an email will use.",
          },
          recommendation: { type: "string", description: "What to do about it, in one sentence. Empty string for a GOOD observation." },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "GOOD"] },
          region: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "width", "height"],
            description:
              "The area of that picture this is about, as fractions of the image between 0 and 1, with 0,0 at the top left. Be generous rather than precise — a box around the top third of the page is more useful than a tight box in the wrong place. Use x:0, y:0, width:1, height:1 when the point is about the whole page.",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
          },
        },
      },
    },
  },
} as const;

interface LookedAt {
  headline: string;
  summary: string;
  firstImpression: string;
  fitsTheBusiness: string;
  observations: {
    title: string;
    observed: string;
    where: string;
    view: ScreenshotView;
    impact: string;
    plainly: string;
    recommendation: string;
    severity: AuditFindingDetail["severity"];
    region: { x: number; y: number; width: number; height: number };
  }[];
}

function systemPrompt(business: { name: string; trade: string | null; town: string | null }, views: ScreenshotView[]): string {
  return `You are the Dakyworld UI/UX Designer, reviewing one homepage for ${business.name}${business.trade ? `, ${business.trade}` : ""}${business.town ? ` in ${business.town}` : ""}.

You are looking at ${views.length === 2 ? "two screenshots of the same page: the first as it appears on a desktop browser at 1280px wide, the second as it appears on a phone at 390px wide" : `one screenshot of the page, taken at ${views[0] === "mobile" ? "phone width (390px)" : "desktop width (1280px)"}`}. ${views.includes("mobile") ? "Most of the people who will open this site are on the phone one." : ""}

**The pictures are the whole of your evidence.** They show the top of the page — roughly the first screen and a little of what follows. You may not say anything about a page you were not shown, about what happens when a button is pressed, about their booking system, their prices, or how fast the site loads. If you cannot see it, it is not an observation.

**Judge the business, not the design.** "The type is inconsistent" is a critique. "A builder comparing three suppliers cannot tell from this screen whether you sell what he needs, so he goes back to the search results" is a reason to spend money. Every observation must end up somewhere a business owner recognises: a customer lost, an enquiry not made, a comparison gone the wrong way, a company made to look smaller than it is.

**Say when there is nothing to say.** A homepage that is genuinely fine is a real answer, and reporting it honestly is what makes the criticism credible when there is some. Mark what is good as GOOD rather than leaving it out — a review that only criticises reads as a sales pitch, and it is read as one.

**Every observation has to be one the owner can check in ten seconds by opening their own site.** Anything they cannot verify while still reading is an opinion, and it reads as one.

Severity means: CRITICAL — a visitor cannot use or trust the page. HIGH — it is costing them enquiries now. MEDIUM — it is holding them back. LOW — worth doing, not urgent. GOOD — this is right and should stay.

British English. No exclamation marks. No "modern", "sleek", "user-friendly" or "seamless" — say what is actually there.`;
}

export async function reviewUx(
  evidence: AuditEvidence,
  business: { name: string; trade: string | null; town: string | null },
): Promise<DisciplineReport> {
  const notes: string[] = [];
  const checked: string[] = [];

  const shots = evidence.shots;
  if (!shots.length) {
    // Three different reasons, and saying the wrong one is how a report gets
    // argued with. The certificate case is its own sentence because the
    // screenshot services cannot be told to click past a warning — none of the
    // actors declares such a key — so this is a real limit rather than a
    // missing token, and it should read as one.
    notes.push(
      evidence.security?.certificate
        ? "The page itself was read by going past the certificate warning, but no picture of it could be taken: the screenshot service opens a real browser and that browser stops at the same warning, with no way to tell it to continue. So the words, the speed and the search side below are all genuine, and how the page *looks* is the one thing nobody has seen. Fix the certificate and the picture comes back on the next run."
        : evidence.reachable
          ? "No screenshot could be taken, so nobody has seen how the site actually looks — only what it is made of. This is the half a business owner cares about, and none of it was checked. It usually means no Apify token is connected."
          : "Their site could not be retrieved, so there was nothing to photograph.",
    );
    return {
      discipline: "UX",
      reviewer: DISCIPLINE_AGENTS.UX.name,
      reviewedBy: "Not run",
      score: 0,
      scored: false,
      headline: "Nobody has seen how the site looks",
      summary: notes[0],
      findings: [],
      checked,
      notes,
      costUsd: 0,
    };
  }

  const views = shots.map((entry) => entry.view);
  checked.push(...views.map((view) => (view === "mobile" ? "How the homepage looks on a phone (390px wide)" : "How the homepage looks on a desktop browser (1280px wide)")));

  const images: PromptImage[] = shots.map((entry) => ({
    base64: entry.result.base64!,
    mediaType: entry.result.shot!.mediaType,
  }));

  const facts = [
    `The business: ${business.name}`,
    business.trade ? `What they do, according to the record: ${business.trade}` : null,
    business.town ? `Where: ${business.town}` : null,
    evidence.finalUrl ? `The address photographed: ${evidence.finalUrl}` : null,
    ...shots.map(
      (entry, index) =>
        `Picture ${index + 1} — ${entry.view === "mobile" ? "phone, 390px wide" : "desktop, 1280px wide"}${entry.result.shot!.cropped ? ", showing the top of a longer page" : ", the whole page"}.`,
    ),
  ].filter(Boolean);

  let looked: LookedAt;
  let by: string;
  let costUsd = 0;
  try {
    const result = await callModel<LookedAt>({
      purpose: "audit.ux",
      // Looking at a picture. ChatGPT unless the Owner has moved it.
      job: "vision",
      system: systemPrompt(business, views),
      prompt: () => [...facts, "", "Review the page."].join("\n"),
      images,
      schema: SCHEMA as unknown as Record<string, unknown>,
      effort: "medium",
      maxTokens: 4000,
      messages: {
        noKey: "No model is connected that can look at a picture, so the pictures were taken and nobody read them. Add a ChatGPT, Claude or Gemini key under Settings → AI models — any one of the three can do this.",
      },
    });
    looked = result.data;
    by = PROVIDERS[result.provider].name;
    costUsd = result.costUsd;
    if (result.fallbackNote) notes.push(result.fallbackNote);
  } catch (err) {
    notes.push(`The pictures were taken but nobody could look at them: ${(err as Error).message}`);
    return {
      discipline: "UX",
      reviewer: DISCIPLINE_AGENTS.UX.name,
      reviewedBy: "Not run",
      score: 0,
      scored: false,
      headline: "The homepage was photographed but not reviewed",
      summary: notes[notes.length - 1],
      findings: [],
      checked,
      notes,
      costUsd: 0,
    };
  }

  const available = new Set(views);
  const findings: AuditFindingDetail[] = looked.observations.slice(0, MAX_OBSERVATIONS).map((observation, index) => {
    // A reviewer shown one picture occasionally attributes a point to the
    // other one. Snapping it back is better than dropping the observation or
    // drawing the box on an image that was never taken.
    const view: ScreenshotView = available.has(observation.view) ? observation.view : views[0];
    return {
      id: `ux-${index + 1}`,
      discipline: "UX" as const,
      severity: observation.severity,
      title: observation.title,
      observed: observation.observed,
      evidence: `${observation.where}, ${view === "mobile" ? "phone view" : "desktop view"} of ${evidence.finalUrl ?? "the homepage"}`,
      impact: observation.impact,
      plainly: observation.plainly,
      recommendation: observation.recommendation?.trim() ? observation.recommendation.trim() : null,
      region: clampRegion(observation.region, view),
      marker: null,
    };
  });

  const { kept, dropped } = trimFindings(findings, { medium: 5, low: 3, good: 3 });
  if (dropped) notes.push(`${dropped} smaller design point${dropped === 1 ? "" : "s"} were left out of this section to keep it readable.`);

  const sorted = sortBySeverity(kept);
  // Numbered after sorting, so the badge on the picture counts down the same
  // order the reader meets them in the document. A box labelled 7 beside the
  // first paragraph is a document that has stopped making sense.
  let marker = 0;
  for (const finding of sorted) {
    if (finding.region) finding.marker = ++marker;
  }

  return {
    discipline: "UX",
    reviewer: DISCIPLINE_AGENTS.UX.name,
    reviewedBy: by,
    score: scoreFindings(sorted),
    scored: true,
    headline: looked.headline.trim(),
    summary: [looked.summary.trim(), looked.firstImpression.trim(), looked.fitsTheBusiness.trim()].filter(Boolean).join("\n\n"),
    findings: sorted,
    checked,
    notes,
    costUsd,
  };
}

/**
 * A box that is actually on the picture.
 *
 * A model asked for fractions will occasionally answer in pixels, or in
 * percentages, or hand back a box that starts at 0.9 and is 0.4 wide. None of
 * those are worth losing an observation over, and all of them draw a rectangle
 * off the edge of the image or wrapped around to the other side.
 */
function clampRegion(region: { x: number; y: number; width: number; height: number } | null | undefined, view: ScreenshotView): Region | null {
  if (!region) return null;
  const values = [region.x, region.y, region.width, region.height];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;

  // Answered in percentages, or in pixels against a 1024-wide image. Either
  // way, everything is out of range in the same direction, so one scale fixes
  // the whole box.
  const largest = Math.max(...values.map(Math.abs));
  const scale = largest > 100 ? 1 / 1024 : largest > 1.5 ? 1 / 100 : 1;

  const x = Math.min(0.98, Math.max(0, region.x * scale));
  const y = Math.min(0.98, Math.max(0, region.y * scale));
  const width = Math.min(1 - x, Math.max(0.02, region.width * scale));
  const height = Math.min(1 - y, Math.max(0.02, region.height * scale));
  return { x, y, width, height, view };
}
