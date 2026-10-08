import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { setPageTitle } from "../lib/surface";

/**
 * Where GitHub sends the tab the install was opened in.
 *
 * The setup itself is still waiting in the tab it was started from, watching
 * for the repository to arrive, so this one has nothing left to do but say
 * what happened and get out of the way. It closes itself when it can — a tab a
 * script opened may be closed by one — and says so when it cannot.
 */
export function WebsiteGithubConnected() {
  const [params] = useSearchParams();
  const ok = params.get("ok") === "1";
  const error = params.get("error");
  const count = Number(params.get("repositories") ?? 0);
  const login = params.get("login");
  const installation = params.get("installation");

  useEffect(() => {
    setPageTitle(ok ? "GitHub connected" : "GitHub not connected");
    if (!ok) return;
    const timer = window.setTimeout(() => window.close(), 2500);
    return () => window.clearTimeout(timer);
  }, [ok]);

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="w-full max-w-md rounded-[14px] border border-line bg-white p-6 text-center">
        <h1 className="font-display text-xl tracking-[-.02em] text-ink">{ok ? "GitHub is connected" : "GitHub was not connected"}</h1>
        {ok ? (
          <p className="mt-2 text-sm leading-relaxed text-muted">
            DakyX can reach {count} repositor{count === 1 ? "y" : "ies"}
            {login ? ` on ${login}` : ""}. Go back to the tab you started in. Your setup carries on there by itself.
          </p>
        ) : (
          <p role="alert" className="mt-2 text-sm leading-relaxed text-danger-text">{error || "GitHub did not say why."}</p>
        )}
        {installation && (
          <p className="mt-2 text-sm text-muted">
            The app is installed. If DakyXTech asked you for a number, it is <b className="font-semibold text-ink">{installation}</b>.
          </p>
        )}
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" className="h-9 rounded-[10px] bg-ink px-4 text-sm font-medium text-white" onClick={() => window.close()}>
            Close this tab
          </button>
          <Link to="/website/welcome" className="inline-flex h-9 items-center rounded-[10px] border border-line px-4 text-sm text-ink">
            Continue here
          </Link>
        </div>
      </div>
    </div>
  );
}
