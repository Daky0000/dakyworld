import { useEffect } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { setPageTitle } from "../lib/surface";
import { updateUiState } from "../lib/uiState";
import { useWebsiteSites } from "../components/WebsiteGuard";
import { WebsiteSubscriberOnboarding } from "../components/WebsiteSubscriberOnboarding";

/**
 * Where somebody with no website yet starts: what the next ten minutes hold,
 * the wizard that adds their website, and a way out that does not trap them.
 *
 * Adding a website ends in the editor with its tour already running
 * (`?walkthrough`), so the three steps here are one continuous path: add it,
 * change something with the tour beside you, publish. Somebody who already has
 * a website is sent to their pages — this screen is for the first visit only.
 */
const STEPS = [
  { n: "1", title: "Add your website", body: "Start from a template, bring the website you have, or upload its HTML." },
  { n: "2", title: "Change something", body: "A two-minute tour shows you how, on your own page." },
  { n: "3", title: "Publish it", body: "You see exactly what changes before anything goes live." },
];

export function WebsiteWelcome() {
  const { user } = useAuth();
  const sites = useWebsiteSites();
  const navigate = useNavigate();
  useEffect(() => setPageTitle("Welcome"), []);

  if (sites.isLoading) return <p className="text-sm text-muted" role="status">Loading…</p>;
  if ((sites.data?.length ?? 0) > 0) return <Navigate to="/website/sites" replace />;

  const first = user?.name.split(" ")[0];
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="rounded-2xl border border-line bg-white p-6">
        <h1 className="font-display text-2xl font-semibold tracking-[-.03em] text-ink sm:text-3xl">
          Welcome{first ? `, ${first}` : ""}.
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Three steps and about ten minutes. Nothing goes live until you say so, and you can stop at any point and come back.
        </p>
        <ol className="mt-5 grid gap-3 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.n} className={`rounded-xl border p-4 ${index === 0 ? "border-blue bg-blue/5" : "border-line"}`}>
              <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-muted">Step {step.n}{index === 0 ? " · now" : ""}</span>
              <p className="mt-1 text-sm font-semibold text-ink">{step.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <WebsiteSubscriberOnboarding onSiteCreated={() => updateUiState({ welcome: { status: "done", at: new Date().toISOString() } })} />

      <p className="text-center text-xs text-muted">
        Want to read first? The{" "}
        <a className="font-semibold text-ink underline underline-offset-2" href="https://dakyx.com/website-builder-setup" target="_blank" rel="noreferrer">setup guide</a>{" "}
        covers every route, and the wizard above can book us to do it for you.{" "}
        <button
          type="button"
          className="font-semibold text-ink underline underline-offset-2"
          onClick={() => {
            updateUiState({ welcome: { status: "skipped", at: new Date().toISOString() } });
            navigate("/website/sites");
          }}
        >
          Skip for now
        </button>
      </p>
    </div>
  );
}
