import { useState, type FormEvent } from "react";
import { isMfaChallenge, useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { Button, Notice } from "../components/ui";

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
    <div className="os-login">
      <section className="os-login-intro"><span className="os-caption">Dakyworld OS</span><h2>Good work.<br />Clear direction.</h2><p>One considered workspace for your business, your clients and everything ahead.</p><span className="os-login-edition">The business workspace</span></section>
      <div className="os-login-form">
        <div className="mb-8 flex items-center gap-3">
          <img src="/brand/mark-on-light-96.png" alt="" width={36} height={36} className="h-9 w-9" />
          <div className="leading-none">
            <div className="font-display text-base font-medium tracking-[-.03em] text-ink">Dakyworld OS</div>
            <div className="mt-1 font-sans text-[11px] uppercase tracking-[.06em] text-muted">Internal Operations</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="os-login-fields">
          <h1 className="font-display text-3xl tracking-[-.03em]">{challenge ? "Two-factor" : "Sign in"}</h1>

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
            <Notice tone="danger" className="mt-4">
              {error}
            </Notice>
          )}

          {/* Sign in is the one action on this screen, so it is the one place
              the lime pill belongs. */}
          <Button type="submit" variant="accent" disabled={submitting} className="mt-7 w-full justify-center py-3">
            {submitting ? "Signing in…" : challenge ? "Verify" : "Sign in"}
          </Button>

          {challenge && (
            <button
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode("");
                setPassword("");
                setError(null);
              }}
              className="mt-3 w-full text-center text-xs text-muted underline-offset-2 transition hover:text-ink hover:underline"
            >
              Start again
            </button>
          )}
        </form>

        <p className="mt-4 text-center text-xs text-muted">
          Need access? Contact your workspace administrator.
        </p>
      </div>
    </div>
  );
}
