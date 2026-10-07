/**
 * The guided tours, as data.
 *
 * A step points at a real control (`data-tour="…"`, or any selector) and, where
 * it can, waits for the person to actually do the thing — select a heading,
 * change a word, switch to Phone — rather than offering a Next button over a
 * picture of it. The screens announce what happened with `tourAction()`; the
 * host (components/TourHost.tsx) moves on when it hears the action a step is
 * waiting for.
 *
 * Every sentence here is something the product does today. The tour this
 * replaced promised "zero-downtime CDN publishing" and drag-and-drop layers;
 * a tour that describes features that are not there teaches somebody to
 * distrust the next thing it says.
 */

export type TourAction =
  | "field-selected"
  | "image-selected"
  | "text-edited"
  | "draft-saved"
  | "device-changed"
  | "mode-preview"
  | "mode-visual"
  | "mode-list"
  | "publish-review-opened"
  | "approval-opened"
  | "versions-opened"
  | "asset-picker-opened";

export type TourStep = {
  id: string;
  /** What to point at. A step with no target is a card in the middle of the screen. */
  target?: string;
  title: string;
  body: string;
  /** The action that finishes this step. Without one, the step has a Next button. */
  waitFor?: TourAction;
  /** Skipped when its target is not on screen — a control a phone does not show, a dialog not open. */
  optional?: boolean;
  /** Put the editor in this mode before the step is shown. */
  mode?: "visual" | "edit" | "preview";
};

export type TourId = "editor" | "publishing" | "pictures" | "workspace";
export type Tour = { id: TourId; title: string; summary: string; minutes: number; steps: TourStep[] };

export const TOURS: Record<TourId, Tour> = {
  editor: {
    id: "editor",
    title: "Editor basics",
    summary: "Change something on your page, check it on a phone, and see how it goes live.",
    minutes: 2,
    steps: [
      {
        id: "canvas",
        target: '[data-tour="canvas"]',
        mode: "visual",
        title: "This is your page",
        body: "It is your real website, as visitors see it. Click a heading on it to select it.",
        waitFor: "field-selected",
      },
      {
        id: "change",
        target: '[data-tour="inspector"]',
        mode: "visual",
        title: "Change it",
        body: "This panel shows what you picked. Change its words here, or double-click it on the page and type. Make any small change now — Ctrl+Z, or Undo in the bar, takes it back.",
        waitFor: "text-edited",
      },
      {
        id: "saved",
        target: '[data-tour="save-status"]',
        title: "It saves by itself",
        body: "Every change is kept as a private draft as you go. Your live website has not changed, and nobody else can see this yet.",
        optional: true,
      },
      {
        id: "phone",
        target: '[data-tour="devices"]',
        title: "Check it on a phone",
        body: "Most visitors will see your website on a phone. Switch to Phone to see your change there.",
        waitFor: "device-changed",
        optional: true,
      },
      {
        id: "preview",
        target: '[data-tour="modes"]',
        title: "See it as a visitor would",
        body: "Preview shows the page without the editing outlines. List shows every word and link as a list — handy on a phone. Try Preview.",
        waitFor: "mode-preview",
      },
      {
        id: "publish",
        target: '[data-tour="publish"]',
        mode: "visual",
        title: "Making it live",
        body: "When you are happy, Publish shows exactly what will change — the old words and the new — before anything goes live. You can also send it to somebody for approval from there.",
      },
      {
        id: "more",
        target: '[data-tour="more"]',
        title: "Everything else",
        body: "More holds your notes, every earlier version of this page, Discard (which throws the draft away), and the other tours.",
      },
    ],
  },
  publishing: {
    id: "publishing",
    title: "Publishing and versions",
    summary: "Review a change, send it for approval or schedule it, and put back an earlier version.",
    minutes: 2,
    steps: [
      {
        id: "review",
        target: '[data-tour="publish"]',
        title: "Review before it goes live",
        body: "Press Publish to see every change side by side with the live page. Nothing goes live until you confirm. If Publish is greyed out, change something first.",
        waitFor: "publish-review-opened",
      },
      {
        id: "approval",
        target: '[data-tour="send-for-approval"]',
        title: "Need somebody's OK?",
        body: "Send for approval gives you a private link for a client or a colleague. They see the change, can pin comments on it, and approve or ask for changes — and you are emailed their answer.",
        optional: true,
      },
      {
        id: "schedule",
        target: '[data-tour="schedule"]',
        title: "Or publish later",
        body: "Choose a date and time, and if you like a second one for the page to go back — for an offer that ends on Sunday.",
        optional: true,
      },
      {
        id: "versions",
        target: '[data-tour="more"]',
        title: "Every version is kept",
        body: "Close the review, then open More and choose Versions. Every publish is listed with what changed and who did it.",
        waitFor: "versions-opened",
      },
      {
        id: "restore",
        title: "Putting one back",
        body: "Restoring a version makes it a draft you can check and publish, so even an undo goes through the same review.",
      },
    ],
  },
  pictures: {
    id: "pictures",
    title: "Pictures",
    summary: "Replace a picture, describe it, and choose what stays in view on a phone.",
    minutes: 1,
    steps: [
      {
        id: "pick",
        target: '[data-tour="canvas"]',
        mode: "visual",
        title: "Choose a picture",
        body: "Click a picture on your page to select it.",
        waitFor: "image-selected",
      },
      {
        id: "replace",
        target: '[data-tour="image-replace"]',
        title: "Replace it",
        body: "Pick one already on your site, or upload a new one. Always add a short description: it is what a screen reader says, and what search engines read.",
        waitFor: "asset-picker-opened",
        optional: true,
      },
      {
        id: "framing",
        title: "What stays in view",
        body: "Under Style, Crop & focal point chooses which part of the picture stays in view on a narrow screen. The original file is never changed.",
      },
    ],
  },
  workspace: {
    id: "workspace",
    title: "Finding your way around",
    summary: "Your pages, your team, your plan and your account.",
    minutes: 1,
    steps: [
      {
        id: "pages",
        target: '[data-tour="pages-list"]',
        title: "Your pages",
        body: "Every page of your website. A page with changes that are not live yet says so. Open one to edit it.",
        optional: true,
      },
      {
        id: "team",
        target: 'a[href="/website/team"]',
        title: "Your team",
        body: "Invite the people who will edit with you, and choose who may publish.",
        optional: true,
      },
      {
        id: "balance",
        target: 'a[href="/website/balance"]',
        title: "Your plan and invoices",
        body: "What you pay, in your own currency, and every invoice.",
        optional: true,
      },
      {
        id: "account",
        target: 'a[href="/website/account"]',
        title: "Your account",
        body: "Your password, two-step sign-in, where you are signed in, and a copy of your website whenever you want one.",
        optional: true,
      },
      {
        id: "next",
        title: "Ready when you are",
        body: "Open any page and the editor offers its own two-minute tour. You can take any tour again from More in the editor.",
      },
    ],
  },
};

const ACTION_EVENT = "dakyx:tour-action";
const START_EVENT = "dakyx:tour-start";
const MODE_EVENT = "dakyx:tour-mode";

/** A screen saying the person just did something a tour may be waiting for. */
export function tourAction(action: TourAction) {
  window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: { action } }));
}

export function startTour(id: TourId) {
  window.dispatchEvent(new CustomEvent(START_EVENT, { detail: { id } }));
}

/** Asks the editor to show a mode before a step that needs it. */
export function requestTourMode(mode: "visual" | "edit" | "preview") {
  window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: { mode } }));
}

export const TOUR_EVENTS = { action: ACTION_EVENT, start: START_EVENT, mode: MODE_EVENT } as const;
