import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { requestTourMode, requestTourTab, TOUR_EVENTS, TOURS, type TourAction, type TourId, type TourStep } from "../lib/tours";
import { tourSeen, updateUiState, useUiState } from "../lib/uiState";

/**
 * Runs one guided tour at a time over whatever screen is open.
 *
 * Three kinds of card: a centred welcome that offers the tour, a step card
 * beside the control it is about, and a centred finish that says what was
 * learned. A step card dims the rest of the screen and rings its target. A
 * step that waits for the person to actually do something (select a heading)
 * lets clicks through and pulses its ring; every other step holds the screen
 * still so a stray click does not lose somebody's place — clicking outside
 * nudges the card instead. A step whose control is not on screen is skipped if
 * it is optional, and shown as a plain card if not.
 *
 * Progress lives on the account (lib/uiState.ts): a finished or dismissed tour
 * is never offered again, on any device. `offer` names the tour this screen
 * suggests once; `autoStart` starts one straight away (the editor does this
 * for `?walkthrough=interactive`, where a new customer lands).
 */

type Rect = { top: number; left: number; width: number; height: number };
type Side = "top" | "bottom" | "left" | "right" | "inside";
const GAP = 16;

function visibleMatch(selector: string): HTMLElement | null {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return node;
  }
  return null;
}

function placeCard(rect: Rect, width: number, height: number, prefer?: TourStep["side"]): { top: number; left: number; side: Side } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clamp = (value: number, max: number) => Math.max(12, Math.min(value, max));
  if (rect.height > vh * 0.6 && rect.width > vw * 0.5) {
    return { top: clamp(rect.top + 40, vh - height - 12), left: clamp(rect.left + rect.width - width - 40, vw - width - 12), side: "inside" };
  }
  let side: Side = prefer ?? (vh - (rect.top + rect.height) > height + GAP ? "bottom" : rect.top > height + GAP ? "top" : "left");
  if (side === "left" && rect.left < width + GAP) side = "right";
  if (side === "right" && vw - (rect.left + rect.width) < width + GAP) side = vh - (rect.top + rect.height) > height + GAP ? "bottom" : "top";
  let x = 0;
  let y = 0;
  if (side === "bottom") { x = rect.left + rect.width / 2 - width / 2; y = rect.top + rect.height + GAP; }
  if (side === "top") { x = rect.left + rect.width / 2 - width / 2; y = rect.top - height - GAP; }
  if (side === "left") { x = rect.left - width - GAP; y = rect.top + Math.min(40, rect.height / 2 - height / 2); }
  if (side === "right") { x = rect.left + rect.width + GAP; y = rect.top + 40; }
  return { top: clamp(y, vh - height - 12), left: clamp(x, vw - width - 12), side };
}

const check = (size = 13) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
);
const cursor = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M5 3l14 7-6 2-2 6z" /></svg>;

function Confetti() {
  const [pieces] = useState(() =>
    Array.from({ length: 60 }, (_, index) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.5,
      duration: 1.2 + Math.random(),
      colour: ["#4d7bff", "#c6f24e", "#8a5cff", "#3fcf8e", "#f5b543"][index % 5],
    })),
  );
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  return (
    <div className="dx-confetti" aria-hidden="true">
      {pieces.map((piece, index) => (
        <i key={index} style={{ left: `${piece.left}%`, background: piece.colour, animationDelay: `${piece.delay}s`, animationDuration: `${piece.duration}s` }} />
      ))}
    </div>
  );
}

export function TourHost({ scope, offer, autoStart, canOffer = true }: { scope: "editor" | "workspace"; offer?: TourId; autoStart?: TourId | null; canOffer?: boolean }) {
  const ui = useUiState();
  const [tourId, setTourId] = useState<TourId | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [doneFlash, setDoneFlash] = useState(false);
  const [offerVisible, setOfferVisible] = useState(false);
  /** The finish card, for the tour that has just been completed. */
  const [finished, setFinished] = useState<TourId | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [cardSize, setCardSize] = useState({ width: 320, height: 200 });
  const direction = useRef<1 | -1>(1);
  const started = useRef(false);

  const tour = tourId ? TOURS[tourId] : null;
  const step: TourStep | null = tour ? tour.steps[index] ?? null : null;
  const inScope = (id: TourId) => (id === "workspace" ? scope === "workspace" : scope === "editor");

  const begin = useCallback((id: TourId) => {
    if (!inScope(id)) return;
    direction.current = 1;
    setOfferVisible(false);
    setFinished(null);
    setTourId(id);
    setIndex(0);
    setRect(null);
    updateUiState({ tours: { [id]: { status: "started", step: 0, at: new Date().toISOString() } } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const finish = useCallback((status: "done" | "dismissed") => {
    if (!tourId) return;
    updateUiState({ tours: { [tourId]: { status, step: index, at: new Date().toISOString() } } });
    if (status === "done") setFinished(tourId);
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
    if (step.tab) requestTourTab(step.tab);
    if (!step.target) { setRect(null); setMissing(false); return; }
    let frame = 0;
    let gaveUp = false;
    let scrolled = false;
    const startedAt = performance.now();
    const track = () => {
      const node = visibleMatch(step.target!);
      if (node) {
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

  useLayoutEffect(() => {
    if (cardRef.current) setCardSize({ width: cardRef.current.offsetWidth, height: cardRef.current.offsetHeight });
  }, [step, rect, missing, doneFlash, finished, offerVisible]);

  // Keyboard: arrows move, Escape ends.
  useEffect(() => {
    if (!tour) return;
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']");
      if (event.key === "Escape") { event.stopPropagation(); finish("dismissed"); }
      else if (!typing && event.key === "ArrowRight" && !step?.waitFor) { event.preventDefault(); go(1); }
      else if (!typing && event.key === "ArrowLeft" && index > 0) { event.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tour, step, index, go, finish]);

  useEffect(() => {
    window.setTimeout(() => primaryRef.current?.focus({ preventScroll: true }), 60);
  }, [tourId, index, finished, offerVisible]);

  const nudge = () => cardRef.current?.animate([{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "none" }], { duration: 250 });

  const offerTour = offer ? TOURS[offer] : null;
  const showOffer = offerVisible && !tourId && offerTour && !ui.tours?.[offerTour.id] && !tourSeen(ui, offerTour.id);

  // ---- centred cards: the offer, and the finish ----
  const centred = (body: React.ReactNode, art: "window" | "done", labelled: { role: "region" | "dialog"; label: string }) =>
    createPortal(
      <>
        <div className="dx-t-veil" onClick={nudge} aria-hidden="true" />
        <div ref={cardRef} className="dx-t-card center" role={labelled.role} aria-label={labelled.label} style={{ left: (window.innerWidth - cardSize.width) / 2, top: Math.max(16, (window.innerHeight - cardSize.height) / 2) }}>
          <div className="dx-t-art">
            {art === "window" ? (
              <div className="dx-t-win"><i /><i /><i className="cv" /><i className="hl" /></div>
            ) : (
              <div className="dx-t-big">{check(64)}</div>
            )}
          </div>
          {body}
        </div>
        {art === "done" && <Confetti />}
      </>,
      portalRoot(),
    );

  if (!tour || !step) {
    if (finished) {
      const done = TOURS[finished];
      return centred(
        <>
          <div className="dx-t-body dx-t-done">
            <h3>You're all set</h3>
            <p>Here's what you just learned:</p>
            <ul>{(done.done ?? [done.summary]).map((line) => <li key={line}>{check()}{line}</li>)}</ul>
          </div>
          <div className="dx-t-foot">
            <button type="button" className="dx-btn dx-ghost" onClick={() => begin(finished)}>Replay</button>
            <span style={{ flex: 1 }} />
            <button ref={primaryRef} type="button" className="dx-btn dx-pri" onClick={() => setFinished(null)}>Start editing</button>
          </div>
        </>,
        "done",
        { role: "dialog", label: "Tour finished" },
      );
    }
    if (!showOffer || !offerTour) return null;
    const welcome = offerTour.welcome ?? { title: `New here? Take the ${offerTour.minutes}-minute tour.`, body: offerTour.summary };
    return centred(
      <>
        <div className="dx-t-body">
          <h3>{welcome.title}</h3>
          <p>{welcome.body}</p>
        </div>
        <div className="dx-t-foot">
          <button
            type="button"
            className="dx-btn dx-ghost"
            onClick={() => {
              setOfferVisible(false);
              updateUiState({ tours: { [offerTour.id]: { status: "dismissed", step: 0, at: new Date().toISOString() } } });
            }}
          >
            Not now
          </button>
          <span style={{ flex: 1 }} />
          <button ref={primaryRef} type="button" className="dx-btn dx-pri" onClick={() => begin(offerTour.id)}>Start the tour</button>
        </div>
      </>,
      "window",
      { role: "region", label: `${offerTour.title} tour` },
    );
  }

  const total = tour.steps.length;
  const last = index === total - 1;
  const cardWidth = Math.min(320, window.innerWidth - 24);
  const placed = rect ? placeCard(rect, cardWidth, cardSize.height, step.side) : { top: Math.max(16, (window.innerHeight - cardSize.height) / 2), left: (window.innerWidth - cardWidth) / 2, side: "inside" as Side };
  const waiting = Boolean(step.waitFor) && !doneFlash;
  let arrow: React.CSSProperties | null = null;
  if (rect && placed.side !== "inside") {
    const centreX = rect.left + rect.width / 2 - placed.left - 6;
    const centreY = rect.top + rect.height / 2 - placed.top - 6;
    if (placed.side === "bottom") arrow = { top: -7, left: Math.max(16, Math.min(cardWidth - 28, centreX)), borderRight: 0, borderBottom: 0 };
    if (placed.side === "top") arrow = { bottom: -7, left: Math.max(16, Math.min(cardWidth - 28, centreX)), borderLeft: 0, borderTop: 0 };
    if (placed.side === "left") arrow = { right: -7, top: Math.max(16, Math.min(cardSize.height - 28, centreY)), borderLeft: 0, borderBottom: 0 };
    if (placed.side === "right") arrow = { left: -7, top: 28, borderRight: 0, borderTop: 0 };
  }

  return createPortal(
    <>
      {/* A held step blocks the page; a step waiting for an action lets it through. */}
      {!waiting && <div className="dx-t-block" onClick={nudge} aria-hidden="true" />}
      <div aria-hidden className={`dx-t-ring${rect ? "" : " none"}${waiting ? " wait" : ""}`} style={rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : undefined} />
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={step.title}
        aria-describedby="tour-step-body"
        className="dx-t-card"
        style={{ top: placed.top, left: placed.left, width: cardWidth }}
      >
        <div className="dx-t-body">
          <span className="dx-t-step">STEP {index + 1} OF {total}</span>
          <h3 id="tour-step-title">{doneFlash ? "Done ✓" : step.title}</h3>
          <p id="tour-step-body" aria-live="polite">
            {step.body}
            {missing && " (This part is not on screen right now.)"}
          </p>
          {step.tip && (
            <div className="dx-t-tip">{cursor}<span>{step.tip[0]}</span>{step.tip[1] && <kbd>{step.tip[1]}</kbd>}</div>
          )}
          {waiting && <div className="dx-t-do"><span className="dx-t-pulse" />{step.doText ?? "Do it on the page — this moves on by itself."}</div>}
        </div>
        <div className="dx-t-foot">
          <div className="dx-t-dots" aria-hidden="true">
            {tour.steps.map((candidate, position) => <i key={candidate.id} className={position === index ? "on" : position < index ? "done" : ""} />)}
          </div>
          <button type="button" className="dx-t-skip" onClick={() => finish("dismissed")}>Skip</button>
          {index > 0 && <button type="button" className="dx-btn dx-ghost" onClick={() => go(-1)}>Back</button>}
          <button ref={primaryRef} type="button" className="dx-btn dx-pri" onClick={() => go(1)}>
            {last ? "Finish" : step.waitFor ? "Skip step" : "Next"}
          </button>
        </div>
        {arrow && <span className="dx-t-arrow" style={arrow} />}
      </div>
    </>,
    portalRoot(),
  );
}

/** Inside the editor when there is one, so its light or dark colours apply. */
function portalRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(".website-editor") ?? document.body;
}
