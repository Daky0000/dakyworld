import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { requestTourMode, TOUR_EVENTS, TOURS, type TourAction, type TourId, type TourStep } from "../lib/tours";
import { tourSeen, updateUiState, useUiState } from "../lib/uiState";

/**
 * Runs one guided tour at a time over whatever screen is open.
 *
 * Not modal: the spotlight dims the rest of the screen but every click still
 * lands, because most steps are finished by the person doing the real thing —
 * selecting a heading, changing a word — and a tour that blocked the page could
 * only ever ask them to read about it. A step whose control is not on screen
 * (a phone hides the device switch) is skipped if it is optional, and shown as
 * a plain card if it is not, rather than pointing at an empty corner.
 *
 * Progress lives on the account (lib/uiState.ts): a finished or dismissed tour
 * is never offered again, on any device. `offer` names the tour this screen
 * suggests once, to somebody who has never seen it; `autoStart` starts one
 * straight away (the editor does this for `?walkthrough=interactive`, which is
 * where a new customer lands after adding their website).
 */

type Rect = { top: number; left: number; width: number; height: number };
const CARD_WIDTH = 340;
const MARGIN = 16;

function visibleMatch(selector: string): HTMLElement | null {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return node;
  }
  return null;
}

function placeCard(rect: Rect | null, cardHeight: number): { top: number; left: number } {
  const width = Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2);
  const clampLeft = (value: number) => Math.min(Math.max(MARGIN, value), window.innerWidth - width - MARGIN);
  // Whatever happens to the target, the card — and its buttons — stay on screen.
  const clampTop = (value: number) => Math.min(Math.max(MARGIN, value), Math.max(MARGIN, window.innerHeight - cardHeight - MARGIN));
  if (!rect) return { top: clampTop((window.innerHeight - cardHeight) / 2), left: (window.innerWidth - width) / 2 };
  // A target as big as the page (the canvas) gets the card inside its top corner.
  if (rect.height > window.innerHeight * 0.55) return { top: clampTop(rect.top + MARGIN), left: clampLeft(rect.left + rect.width - width - MARGIN) };
  const below = rect.top + rect.height + 12;
  if (below + cardHeight < window.innerHeight - MARGIN) return { top: clampTop(below), left: clampLeft(rect.left) };
  const above = rect.top - cardHeight - 12;
  if (above > MARGIN && above + cardHeight < window.innerHeight) return { top: above, left: clampLeft(rect.left) };
  // Beside it, whichever side has room.
  const right = rect.left + rect.width + 12;
  const side = right + width < window.innerWidth - MARGIN ? right : rect.left - width - 12;
  return { top: clampTop(rect.top), left: clampLeft(side) };
}

export function TourHost({ scope, offer, autoStart, canOffer = true }: { scope: "editor" | "workspace"; offer?: TourId; autoStart?: TourId | null; canOffer?: boolean }) {
  const ui = useUiState();
  const [tourId, setTourId] = useState<TourId | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [doneFlash, setDoneFlash] = useState(false);
  const [offerVisible, setOfferVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [cardHeight, setCardHeight] = useState(180);
  const direction = useRef<1 | -1>(1);
  const started = useRef(false);

  const tour = tourId ? TOURS[tourId] : null;
  const step: TourStep | null = tour ? tour.steps[index] ?? null : null;
  const inScope = (id: TourId) => (id === "workspace" ? scope === "workspace" : scope === "editor");

  const begin = useCallback((id: TourId) => {
    if (!inScope(id)) return;
    direction.current = 1;
    setOfferVisible(false);
    setTourId(id);
    setIndex(0);
    setRect(null);
    updateUiState({ tours: { [id]: { status: "started", step: 0, at: new Date().toISOString() } } });
    window.setTimeout(() => headingRef.current?.focus(), 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const finish = useCallback((status: "done" | "dismissed") => {
    if (!tourId) return;
    updateUiState({ tours: { [tourId]: { status, step: index, at: new Date().toISOString() } } });
    setTourId(null);
    setRect(null);
  }, [tourId, index]);

  const go = useCallback((delta: 1 | -1) => {
    if (!tour) return;
    direction.current = delta;
    const next = index + delta;
    if (next >= tour.steps.length) { finish("done"); return; }
    setIndex(Math.max(0, next));
    setRect(null);
    setMissing(false);
  }, [tour, index, finish]);

  // Started from a menu anywhere on the screen.
  useEffect(() => {
    const onStart = (event: Event) => {
      const id = (event as CustomEvent<{ id: TourId }>).detail?.id;
      if (id && TOURS[id]) begin(id);
    };
    window.addEventListener(TOUR_EVENTS.start, onStart);
    return () => window.removeEventListener(TOUR_EVENTS.start, onStart);
  }, [begin]);

  // Started on arrival, or offered once.
  useEffect(() => {
    if (started.current) return;
    if (autoStart && inScope(autoStart)) {
      started.current = true;
      const timer = window.setTimeout(() => begin(autoStart), 700);
      return () => window.clearTimeout(timer);
    }
    if (!offer || !canOffer) return;
    // Long enough for the account's state to arrive, so somebody who already
    // said "not now" does not see the offer flash up first.
    const timer = window.setTimeout(() => {
      started.current = true;
      setOfferVisible(true);
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, offer, canOffer]);

  // The real action a step is waiting for.
  useEffect(() => {
    if (!step?.waitFor) return;
    const waiting = step.waitFor;
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<{ action: TourAction }>).detail?.action;
      if (action !== waiting) return;
      setDoneFlash(true);
      window.setTimeout(() => { setDoneFlash(false); go(1); }, 450);
    };
    window.addEventListener(TOUR_EVENTS.action, onAction);
    return () => window.removeEventListener(TOUR_EVENTS.action, onAction);
  }, [step, go]);

  // Find what the step points at, follow it as the screen moves, and skip an
  // optional step whose control is not there.
  useEffect(() => {
    if (!step) return;
    if (step.mode) requestTourMode(step.mode);
    if (!step.target) { setRect(null); setMissing(false); return; }
    let frame = 0;
    let gaveUp = false;
    let scrolled = false;
    const startedAt = performance.now();
    const track = () => {
      const node = visibleMatch(step.target!);
      if (node) {
        // Once per step: bring it on screen, so the spotlight is not around
        // something below the fold of a scrolled menu.
        if (!scrolled) {
          scrolled = true;
          const first = node.getBoundingClientRect();
          if (first.bottom > window.innerHeight || first.top < 0) node.scrollIntoView({ block: "center", inline: "nearest" });
        }
        const box = node.getBoundingClientRect();
        setMissing(false);
        setRect((previous) => {
          const next = { top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 };
          return previous && Math.abs(previous.top - next.top) < 0.5 && Math.abs(previous.left - next.left) < 0.5 && Math.abs(previous.width - next.width) < 0.5 && Math.abs(previous.height - next.height) < 0.5 ? previous : next;
        });
      } else if (!gaveUp && performance.now() - startedAt > 1800) {
        gaveUp = true;
        if (step.optional) { go(direction.current); return; }
        setRect(null);
        setMissing(true);
      }
      frame = window.requestAnimationFrame(track);
    };
    frame = window.requestAnimationFrame(track);
    return () => window.cancelAnimationFrame(frame);
  }, [step, go]);

  useEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight);
  }, [step, rect, missing, doneFlash]);

  const offerTour = offer ? TOURS[offer] : null;
  const showOffer = offerVisible && !tourId && offerTour && !ui.tours?.[offerTour.id] && !tourSeen(ui, offerTour.id);

  if (!tour || !step) {
    if (!showOffer || !offerTour) return null;
    return createPortal(
      <section
        role="region"
        aria-label={`${offerTour.title} tour`}
        className="fixed bottom-4 left-4 z-[10000] w-[min(340px,calc(100vw-32px))] rounded-2xl border border-line bg-white p-4 text-ink shadow-2xl"
      >
        <p className="text-sm font-semibold">New here? Take the {offerTour.minutes}-minute tour.</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{offerTour.summary}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-white hover:bg-ink/85" onClick={() => begin(offerTour.id)}>
            Start the tour
          </button>
          <button
            type="button"
            className="rounded-xl border border-line px-3 py-2 text-xs font-semibold text-ink hover:border-line-strong"
            onClick={() => {
              setOfferVisible(false);
              updateUiState({ tours: { [offerTour.id]: { status: "dismissed", step: 0, at: new Date().toISOString() } } });
            }}
          >
            Not now
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted">Every tour is under More whenever you want it.</p>
      </section>,
      document.body,
    );
  }

  const position = placeCard(rect, cardHeight);
  const total = tour.steps.length;
  const last = index === total - 1;
  return createPortal(
    <>
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[10000] rounded-xl ring-2 ring-blue transition-all duration-200"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, boxShadow: "0 0 0 9999px rgba(8,16,31,.42)" }}
        />
      )}
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-step-title"
        aria-describedby="tour-step-body"
        className="fixed z-[10001] rounded-2xl border border-line bg-white p-4 text-ink shadow-2xl outline-none"
        style={{ top: position.top, left: position.left, width: Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2) }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); finish("dismissed"); }
        }}
      >
        <p className="text-[11px] font-semibold uppercase tracking-[.06em] text-muted">
          {tour.title} · {index + 1} of {total}
        </p>
        <h2 id="tour-step-title" ref={headingRef} tabIndex={-1} className="mt-1 font-display text-base font-semibold outline-none">
          {doneFlash ? "Done ✓" : step.title}
        </h2>
        <p id="tour-step-body" aria-live="polite" className="mt-1 text-sm leading-relaxed text-muted">
          {step.body}
          {missing && " (This part is not on screen right now.)"}
        </p>
        {step.waitFor && !doneFlash && (
          <p className="mt-2 text-xs font-medium text-blue">Do it on the page — this moves on by itself.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {index > 0 && (
            <button type="button" className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold hover:border-line-strong" onClick={() => go(-1)}>
              Back
            </button>
          )}
          <button type="button" className="rounded-xl bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink/85" onClick={() => go(1)}>
            {last ? "Finish" : step.waitFor ? "Skip this step" : "Next"}
          </button>
          <button type="button" className="ml-auto text-xs font-semibold text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => finish("dismissed")}>
            End tour
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
