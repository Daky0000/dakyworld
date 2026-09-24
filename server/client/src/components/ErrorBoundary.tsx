import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * What the app shows when a render throws.
 *
 * Without one of these, React unmounts the whole tree and the person is left
 * looking at a white page — which is exactly what happened when a hook was
 * added below the website editor's early returns: a real bug, but one that
 * reached the customer as "the product is broken" rather than as a message and
 * a way out. A boundary cannot prevent the bug; it decides whether somebody
 * can tell you about it.
 *
 * The reference is what makes a support conversation possible. It is a short
 * random string put into the page and logged next to the stack, so "it broke,
 * reference 4F2A" finds the log line without anybody having to reproduce it.
 */

type Props = { children: ReactNode; label?: string };
type State = { error: Error | null; reference: string | null };

function makeReference(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reference: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, reference: makeReference() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is the only place this can go until error reporting is wired
    // up. It carries the reference the person on screen is being shown, so the
    // two can be matched later.
    console.error(`[ui ${this.state.reference ?? "?"}] ${this.props.label ?? "render"} failed:`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-[60vh] place-items-center p-6">
        <div className="max-w-lg rounded-2xl border border-line bg-surface p-8 text-center">
          <h1 className="font-display text-xl font-medium text-ink">This screen stopped working</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Something on this page failed while it was drawing. Nothing you had saved is affected — your work is on the
            server, not in this screen.
          </p>
          <p className="mt-3 text-sm text-muted">
            If you tell us about it, quote reference{" "}
            <span className="font-mono font-semibold text-ink">{this.state.reference}</span>.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              className="rounded-xl bg-ink px-4 py-2 text-sm font-medium text-white"
              onClick={() => this.setState({ error: null, reference: null })}
            >
              Try this screen again
            </button>
            <button
              type="button"
              className="rounded-xl border border-line px-4 py-2 text-sm font-medium text-ink"
              onClick={() => window.location.reload()}
            >
              Reload the app
            </button>
          </div>
          <details className="mt-6 text-left">
            <summary className="cursor-pointer text-xs text-muted">Technical detail</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-ink/5 p-3 text-[11px] leading-relaxed text-ink">
              {this.state.error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
