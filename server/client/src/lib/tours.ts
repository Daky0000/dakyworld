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
  /** Open this inspector tab before the step is shown. */
  tab?: "content" | "style" | "interactions";
  /** The line in the "do this" box of a step that waits for an action. */
  doText?: string;
  /** A small hint row: what to do, and the keys for it. */
  tip?: [string, string?];
  /** Which side of its target the card prefers. */
  side?: "top" | "bottom" | "left" | "right";
};

export type TourId = "editor" | "publishing" | "pictures" | "workspace";
export type Tour = {
  id: TourId;
  title: string;
  summary: string;
  minutes: number;
  steps: TourStep[];
  /** The centred card that offers the tour, before step one. */
  welcome?: { title: string; body: string };
  /** What the finishing card lists as learned. */
  done?: string[];
};

export const TOURS: Record<TourId, Tour> = {
  editor: {
    id: "editor",
    title: "Editor basics",
    summary: "Select something, change it, see every screen size, and publish.",
    minutes: 1,
    welcome: {
      title: "Welcome to the editor",
      body: "Everything you need to change your website is here, and nothing goes live until you publish. This tour takes about a minute.",
    },
    done: ["Select anything to edit it", "Style normal and hover", "Use the tool rail and search", "Publish when ready"],
    steps: [
      {
        id: "modes",
        target: '[data-tour="modes"]',
        mode: "visual",
        title: "Pick how you work",
        body: "Edit on the page in Visual, edit all the words at once in List, or check it as a visitor in Preview.",
      },
      {
        id: "devices",
        target: '[data-tour="devices"]',
        title: "Check every screen size",
        body: "Switch between desktop, tablet and phone. Changes made on tablet or phone only apply to those screens.",
        optional: true,
      },
      {
        id: "canvas",
        target: '[data-tour="canvas"]',
        mode: "visual",
        title: "Click anything to edit it",
        body: "Selecting something opens its settings on the right. Double-click words to type straight into them.",
        waitFor: "field-selected",
        doText: "Try it: click a heading on your page",
      },
      {
        id: "inspector",
        target: '[data-tour="inspector"]',
        side: "left",
        tab: "content",
        title: "All the settings in one place",
        body: "Content is the words, links and pictures. Style is how it looks. Interactions are animations and what happens on click.",
      },
      {
        id: "states",
        target: '[data-tour="style-states"]',
        side: "left",
        tab: "style",
        title: "Style normal and hover",
        body: "Switch to Hover to change how it looks when the mouse is over it.",
        optional: true,
      },
      {
        id: "rail",
        target: '[data-tour="more"]',
        side: "right",
        title: "Your tools live here",
        body: "Browse layers, set the page's colours and fonts, swap pictures, tune SEO and growth tools, leave notes, open History, and find the other tours under Help.",
      },
      {
        id: "rightclick",
        target: '[data-tour="canvas"]',
        title: "Right-click for quick actions",
        body: "Copy, paste, duplicate, copy a style to reuse, move things up or down, hide on phone, or delete. Highlight words while typing for bold, colour and links.",
        tip: ["Right-click any element"],
      },
      {
        id: "search",
        target: '[data-tour="search"]',
        title: "Search every tool",
        body: "Can't remember where something is? Search finds any tool, panel or setting — and anything on this page.",
        tip: ["Open search", "Ctrl K"],
        optional: true,
      },
      {
        id: "agent",
        target: '[data-tour="agent"]',
        side: "left",
        title: "Or just ask",
        body: "Tell the builder agent what you want in plain words. It makes the change as a draft you can check first.",
        optional: true,
      },
      {
        id: "publish",
        target: '[data-tour="publish"]',
        mode: "visual",
        title: "Publish when you're ready",
        body: "Edits save as a private draft by themselves. Publish shows exactly what will change before anything goes live. The arrow beside it saves, downloads and opens every earlier version.",
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
        body: "Close the review, then click History on the left. Every publish is listed with what changed, and can be put back.",
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
        body: "Open any page and the editor offers its own one-minute tour. You can take any tour again from Help in the editor.",
      },
    ],
  },
};

const ACTION_EVENT = "dakyx:tour-action";
const START_EVENT = "dakyx:tour-start";
const MODE_EVENT = "dakyx:tour-mode";
const TAB_EVENT = "dakyx:tour-tab";

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

/** Asks the editor to open an inspector tab before a step that points into it. */
export function requestTourTab(tab: "content" | "style" | "interactions") {
  window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: { tab } }));
}

export const TOUR_EVENTS = { action: ACTION_EVENT, start: START_EVENT, mode: MODE_EVENT, tab: TAB_EVENT } as const;
