import { Suspense, useRef, type ReactNode } from "react";

/** Load optional panels on first use, then retain their state when they close. */
export function DeferredPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const mounted = useRef(active);
  if (active) mounted.current = true;
  if (!mounted.current) return null;
  return <Suspense fallback={<div role="status" className="fixed bottom-4 right-4 z-50 rounded-lg bg-white px-4 py-2 text-sm shadow">Loading panel…</div>}>{children}</Suspense>;
}
