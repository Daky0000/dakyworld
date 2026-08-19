import { useState, type FormEvent } from "react";
import { isMfaChallenge, useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

export function Login() {
  const { login, completeLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  /** Non-null once the password has been accepted and only the code is outstanding. */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (challenge) {
        await completeLogin(challenge, code);
        return;
      }
      const result = await login(email, password);
      if (isMfaChallenge(result)) {
        setChallenge(result.challenge);
        setSubmitting(false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setSubmitting(false);
      // An expired challenge means starting over rather than retyping a code
      // into a ticket the server has already forgotten.
      if (err instanceof ApiError && err.status === 401 && challenge) {
        setChallenge(null);
        setCode("");
        setPassword("");
      }
    }
  }

  // The shared .input component class, so the one sign-in form cannot drift
  // away from every other field in the product.
  const inputClass = "input";

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-6 text-ink">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img src="/brand/mark-on-light-96.png" alt="" width={36} height={36} className="h-9 w-9" />
          <div className="leading-none">
            <div className="font-display text-base font-bold tracking-[-.03em]">Dakyworld OS</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Internal Operations</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl border border-line bg-white p-7">
          <h1 className="font-display text-2xl tracking-[-.03em]">{challenge ? "Two-factor" : "Sign in"}</h1>

          {challenge ? (
            <>
              <p className="mt-2 text-sm text-muted">
                Enter the six-digit code from your authenticator app, or one of your recovery codes.
              </p>
              <label className="mt-6 block">
                <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[.1em] text-muted">Code</span>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  // one-time-code lets a phone offer the code straight from the
                  // notification instead of making somebody switch apps.
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  autoFocus
                  className={`mt-1.5 font-mono tracking-[.2em] ${inputClass}`}
                />
              </label>
            </>
          ) : (
            <>
              <label className="mt-6 block">
                <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[.1em] text-muted">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                  autoFocus
                  className={`mt-1.5 ${inputClass}`}
                />
              </label>

              <label className="mt-4 block">
                <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[.1em] text-muted">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  className={`mt-1.5 ${inputClass}`}
                />
              </label>
            </>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {error}
            </p>
          )}

          {/* Sign in is the one action on this screen, so it is the one place
              the lime pill belongs. */}
          <button
            type="submit"
            disabled={submitting}
            className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-full bg-lime px-4 py-3 text-[13px] font-bold text-ink transition hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(184,255,61,.32)] disabled:pointer-events-none disabled:opacity-50"
          >
            {submitting ? "Signing in…" : challenge ? "Verify" : "Sign in"}
          </button>

          {challenge && (
            <button
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode("");
                setPassword("");
                setError(null);
              }}
              className="mt-3 w-full text-center text-xs text-muted underline-offset-2 hover:underline"
            >
              Start again
            </button>
          )}
        </form>

        <p className="mt-4 text-center text-xs text-ink/40">
          Locked out? Reset <span className="font-mono">OWNER_PASSWORD</span> in Railway and redeploy.
        </p>
      </div>
    </div>
  );
}
