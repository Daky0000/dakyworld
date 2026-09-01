import type { ReactNode } from "react";
import { PageHeader } from "./ui";

/**
 * A screen that is planned, described, and not built yet.
 *
 * The Website Builder is a ten-screen product being built over months, and the
 * risk with that is not that a screen is missing — it is that a screen is
 * *forgotten*, because the only record of it was a PDF nobody opens twice. So
 * every screen in the plan exists from the start and says what it will hold.
 *
 * This is deliberately **not** an empty shell with a spinner on it. An empty
 * shell teaches somebody the product is broken; a page that says "this is the
 * asset library, here is what it will do, here is what it is waiting on" teaches
 * them it is coming, and reminds whoever is building it what they agreed to.
 *
 * Each of these is gated on `website.manage`, so a client with editing rights
 * and nothing else never sees them.
 *
 * `docs/website-builder.md` is the same map in prose, with file paths.
 */
export function PlannedScreen({
  title,
  eyebrow,
  summary,
  willHold,
  decided,
  waitingOn,
  children,
}: {
  title: string;
  eyebrow?: string;
  /** One sentence: what this screen is for. */
  summary: string;
  /** What it will show or do, in the words of the plan. */
  willHold: string[];
  /** Design calls already taken, which should not be re-litigated when it is built. */
  decided?: string[];
  /** What has to exist first. Empty when it is simply not started. */
  waitingOn?: string[];
  /** Anything specific to this screen — a dropped decision, a warning. */
  children?: ReactNode;
}) {
  return (
    <div>
      <PageHeader title={title} eyebrow={eyebrow ?? "Website Builder"} subtitle={summary} />

      <div className="mb-6 rounded-2xl border border-dashed border-line bg-white px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Not built yet</div>
        <p className="mt-1.5 text-sm text-muted">
          This screen is in the plan and has not been built. It is here so it is not forgotten — see{" "}
          <span className="font-mono text-xs text-ink">server/docs/website-builder.md</span> for the whole map.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 font-display text-lg tracking-[-.02em]">What it will hold</h2>
          <ul className="space-y-2">
            {willHold.map((item) => (
              <li key={item} className="flex gap-2.5 text-sm text-muted">
                <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink/30" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-6">
          {decided && decided.length > 0 && (
            <section>
              <h2 className="mb-3 font-display text-lg tracking-[-.02em]">Already decided</h2>
              <ul className="space-y-2">
                {decided.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm text-muted">
                    {/* Blue rather than lime: these are structure, not actions. */}
                    <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-blue" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {waitingOn && waitingOn.length > 0 && (
            <section>
              <h2 className="mb-3 font-display text-lg tracking-[-.02em]">Waiting on</h2>
              <ul className="space-y-2">
                {waitingOn.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm text-muted">
                    <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-warn" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {children && <div className="mt-8">{children}</div>}
    </div>
  );
}
