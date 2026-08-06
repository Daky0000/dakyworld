import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full border border-ink/20 bg-white px-3 py-2 text-sm outline-none transition focus:border-ink";

  return (
    <div className="flex min-h-screen items-center justify-center bg-ivory px-6 text-ink">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center border border-ink/20 bg-ink text-ivory">
            <span className="font-serif text-sm font-semibold">D</span>
          </span>
          <div className="leading-none">
            <div className="font-mono text-xs font-medium uppercase tracking-[.18em]">Dakyworld OS</div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Internal Operations</div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="border border-ink/10 bg-white p-6">
          <h1 className="font-serif text-2xl">Sign in</h1>

          <label className="mt-6 block">
            <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">Email</span>
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
            <span className="font-mono text-[10px] uppercase tracking-[.14em] text-ink/50">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className={`mt-1.5 ${inputClass}`}
            />
          </label>

          {error && (
            <p role="alert" className="mt-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 w-full bg-ink px-4 py-2.5 font-mono text-xs uppercase tracking-[.12em] text-ivory transition hover:bg-black disabled:opacity-50"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-ink/40">
          Locked out? Reset <span className="font-mono">OWNER_PASSWORD</span> in Railway and redeploy.
        </p>
      </div>
    </div>
  );
}
