import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Card } from "./ui";

/**
 * Wraps a screen in the permission its own API routes ask for.
 *
 * Hiding the nav tab is not enough on its own: a bookmark, a link somebody
 * pasted into Slack, or the browser's own history will all put a person on a
 * URL they cannot use. Without this they get the page's chrome and then a
 * cascade of red 403 toasts as each of its queries fails — which reads as a
 * broken app rather than as a closed door.
 *
 * It is a courtesy and not a boundary. The server refuses the same calls
 * whatever this renders, which is the only reason it is safe for the whole
 * check to live in the browser.
 */
export function Guard({ needs, children }: { needs: string; children: ReactNode }) {
  const { user, can } = useAuth();
  if (can(needs)) return <>{children}</>;

  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[.14em] text-muted">Not available to you</div>
      <h1 className="mt-3 font-display text-[22px] font-bold tracking-[-.03em]">This screen isn't part of your role</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        {user?.roleName ? (
          <>
            You're on the <span className="font-semibold text-ink">{user.roleName}</span> role, which doesn't include this
            screen.
          </>
        ) : (
          <>Your account hasn't been given a role yet, so nothing is available to it.</>
        )}{" "}
        An Owner can change that under Team &amp; Access.
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex rounded-full bg-ink px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-ink/85"
      >
        Back to the start
      </Link>
    </Card>
  );
}

/**
 * The landing screen for somebody whose role does not include the dashboard.
 *
 * Sending them to a refusal at `/` would make the app look broken from the
 * first second. This finds the first screen they *can* open instead, and only
 * says no when the honest answer is that there is nothing.
 */
export function Landing({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  if (can("dashboard.view")) return <>{children}</>;

  const first = [
    ["leads.view", "/leads"],
    ["emails.view", "/emails"],
    ["inbox.view", "/inbox"],
    ["projects.view", "/projects"],
    ["clients.view", "/clients"],
    ["invoices.view", "/invoices"],
    ["proposals.view", "/proposals"],
    ["retainers.view", "/care-plans"],
    ["demos.view", "/demos"],
    ["agents.view", "/agents"],
    ["team.view", "/team"],
    ["settings.view", "/settings"],
  ].find(([permission]) => can(permission));

  if (!first) return <Guard needs="dashboard.view">{children}</Guard>;

  return (
    <Card className="mx-auto max-w-lg p-8 text-center">
      <h1 className="font-display text-[22px] font-bold tracking-[-.03em]">Welcome</h1>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        The dashboard isn't part of your role, but the rest of your work is waiting.
      </p>
      <Link
        to={first[1]}
        className="mt-6 inline-flex rounded-full bg-ink px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-ink/85"
      >
        Get started
      </Link>
    </Card>
  );
}
