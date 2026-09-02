/**
 * The contract between Dakyworld OS and this actor.
 *
 * This file is the single definition of what goes in and what comes out. It is
 * duplicated — deliberately, and only in shape — by
 * `server/src/services/apifyScreenshot.ts`, because the two halves are
 * deployed separately and neither can import from the other. If you change
 * anything here, change it there in the same commit.
 *
 * The rule that shapes all of it: **every requested URL produces exactly one
 * row, carrying back the id it arrived with**. The system this replaced
 * matched dataset rows to requests by looking for the address in the row and
 * falling back to position, which meant one failed page shifted every picture
 * after it onto the wrong business. A picture attached to the wrong business
 * is a page carrying somebody's name that is not theirs, so the id is not a
 * convenience — it is the safeguard.
 */

/** One page to photograph, and the caller's own name for it. */
export interface ScreenshotRequest {
  /**
   * Whatever the caller wants to find this row by afterwards. Returned
   * unchanged, never interpreted, never used as a filename.
   */
  id: string;
  url: string;
}

export interface ScreenshotInput {
  urls: ScreenshotRequest[];
  /**
   * The browser window. A real device size, not a crop: it decides what the
   * page thinks it is being viewed on, which changes where a sticky header
   * sits and how much a lazy-loading gallery brings in before the shutter.
   * 1280x800 is a laptop; 390x844 is an iPhone 14.
   */
  viewport: { width: number; height: number };
  /** Capture the whole scrollable page rather than one window. */
  fullPage: boolean;
  /** Milliseconds to wait after load, for fonts and a hero image to arrive. */
  delay: number;
  /**
   * Resize the finished picture down to this width. Never up: a 390px-wide
   * phone shot blown up is the same picture with softer edges and three times
   * the vision tiles to pay for. Omit to keep the captured width.
   */
  maxWidth?: number;
  /**
   * Keep this many rows from the top and throw the rest away.
   *
   * Measured in **captured** pixels, before `maxWidth` shrinks anything —
   * cropping first is what removes the footer nobody is judging, and shrinking
   * a 12,000px page before cutting it would spend the work on rows that are
   * about to go. Omit to keep the whole capture.
   */
  maxHeight?: number;
  /** Per page, in milliseconds. One broken site cannot hold the batch open. */
  navigationTimeoutMs?: number;
  /** Apify proxy settings. The caller does not send this; see README. */
  proxy?: { useApifyProxy?: boolean; apifyProxyGroups?: string[]; apifyProxyCountry?: string };
}

/**
 * Why a page produced no picture.
 *
 * Every one of these is an expected thing for a stranger's website to do, so
 * each is a row the caller can act on rather than an exception. `ACTOR_*` and
 * `APIFY_*` codes are the caller's half of the vocabulary — a run that never
 * started has no rows to carry a code — and live in the server.
 */
export type ScreenshotErrorCode =
  /** Not a URL this could open. Never costs a page load. */
  | "INVALID_URL"
  /** The page did not finish loading inside the allowed time. */
  | "PAGE_TIMEOUT"
  /** DNS, TLS, a refused connection, a proxy that could not be reached. */
  | "NAVIGATION_ERROR"
  /** The page loaded and the shutter failed — nearly always an enormous page. */
  | "SCREENSHOT_FAILED"
  /** The picture was taken and could not be cropped, resized or stored. */
  | "IMAGE_PROCESSING_FAILED"
  /** Chromium would not start. Fails the whole run, not one page. */
  | "BROWSER_LAUNCH_FAILED";

export interface ScreenshotError {
  code: ScreenshotErrorCode;
  /** One sentence for a person. Never carries a credential or a proxy URL. */
  message: string;
}

export interface ScreenshotResult {
  /** Exactly what arrived in the request. */
  id: string;
  /** Exactly what arrived in the request. */
  url: string;
  /** Where the browser ended up — a redirect to www or to https shows here. */
  finalUrl: string | null;
  success: boolean;
  /** The processed picture: cropped, resized, and what a model should read. */
  screenshotUrl: string | null;
  /**
   * The capture before any of that, kept so a person can open what was
   * actually on the screen. Null when the crop and the resize both did
   * nothing, in which case `screenshotUrl` already is the original.
   */
  fullScreenshotUrl: string | null;
  /** The processed picture's size. */
  width: number | null;
  height: number | null;
  /** What was captured, before the crop and the resize. */
  fullWidth: number | null;
  fullHeight: number | null;
  /** True when the page was longer than `maxHeight` and the rest was cut. */
  cropped: boolean;
  /** Echoed back, so a row says what it was taken at without the input beside it. */
  viewportWidth: number;
  viewportHeight: number;
  format: "png";
  /** How long the page itself took, for anyone pricing a batch. */
  durationMs: number;
  error: ScreenshotError | null;
}
