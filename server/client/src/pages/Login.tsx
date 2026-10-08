import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { isMfaChallenge, useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { Button, Notice } from "../components/ui";
import { PasswordInput } from "../components/PasswordField";
import { currentSurface, setPageTitle, type Surface } from "../lib/surface";

/**
 * What the sign-in screen says, per product.
 *
 * The same screen answers on all three hosts, and it used to say "DakyXTech OS ·
 * Internal Operations" on every one — so the first thing a paying customer read
 * after setting their password was that they had walked into somebody else's
 * office. Staff keep the OS wording; customers are told what they bought.
 *
 * The three tiles under the headline say what the product does, not how much of
 * it there is: nothing is known about the visitor before they sign in, and a
 * number on a public page would be a number anybody could read.
 */
const COPY: Record<Surface, { caption: string; headline: [string, string]; lede: string; badge: string; tiles: [string, string][]; help: ReactNode }> = {
  os: {
    caption: "DakyXTech OS",
    headline: ["Good work.", "Clear direction."],
    lede: "One workspace for leads, proposals, clients, invoices and the agents that keep it all moving.",
    badge: "Business workspace",
    tiles: [["Leads", "Found, audited and written to"], ["Proposals", "Drafted from the evidence"], ["Invoices", "Sent, paid and chased"]],
    help: <>Need access? Ask your workspace owner.</>,
  },
  editor: {
    caption: "DakyX Website Editor",
    headline: ["Your website.", "Your words."],
    lede: "Change your text, pictures and prices, check them on a phone, and publish — without waiting for a developer.",
    badge: "Website editor",
    tiles: [["Edit", "Words and pictures, in place"], ["Check", "On a phone before it goes live"], ["Publish", "In one click, undo any time"]],
    help: (
      <>
        New to DakyX? <a href="https://dakyx.com/website-builder#price">See the plans</a>
        {" · "}
        <a href="https://dakyx.com/website-builder-setup">How it works</a>
      </>
    ),
  },
  app: {
    caption: "DakyX",
    headline: ["Everything you run", "with DakyX."],
    lede: "Your website, your plan and your invoices, in one account.",
    badge: "Customer account",
    tiles: [["Website", "Edit and publish"], ["Plan", "Change or cancel"], ["Invoices", "Every receipt in one place"]],
    help: (
      <>
        New to DakyX? <a href="https://dakyx.com/products">See what we offer</a>
      </>
    ),
  },
};

/**
 * The frame every signed-out screen shares: a navy panel with the dot field
 * and the product's promise, and a white panel with the task. Sign-in, choosing
 * a password, the forgotten-password form and email confirmation all sit in it,
 * so arriving from an email link looks like the same product as signing in.
 */
export function AuthFrame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const copy = COPY[currentSurface()];
  return (
    <main className="os-login">
      <section className="os-login-intro dot-field">
        <span className="os-login-caption">{copy.caption}</span>
        <div className="os-login-copy">
          <h2>
            {copy.headline[0]}
            <br />
            <span>{copy.headline[1]}</span>
          </h2>
          <p>{copy.lede}</p>
          <div className="os-login-tiles">
            {copy.tiles.map(([title, line]) => (
              <div key={title}>
                <b>{title}</b>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="os-login-panel">
        <div className="os-login-form">
          <img src="/brand/lockup-on-light.png" alt={copy.caption} className="os-login-logo" />
          <span className="os-login-badge">{copy.badge}</span>
          {children}
        </div>
        <div className="os-login-foot">
          <span>© {new Date().getFullYear()} DakyXTech</span>
          <span>{footer ?? copy.help}</span>
        </div>
      </section>
    </main>
  );
}

export function Login() {
  const { login, completeLogin } = useAuth();
  useEffect(() => setPageTitle("Sign in"), []);
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

  return (
    <AuthFrame>
      <form onSubmit={onSubmit}>
        <h1 className="os-login-title">{challenge ? "Two-factor" : "Welcome back"}</h1>
        <p className="os-login-lead">
          {challenge ? "Enter the six-digit code from your authenticator app, or one of your recovery codes." : "Sign in to carry on where you left off."}
        </p>

        {challenge ? (
          <label className="os-login-field">
            <span>Code</span>
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
              className="input font-mono tracking-[.2em]"
            />
          </label>
        ) : (
          <>
            <label className="os-login-field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus className="input" />
            </label>
            <div className="os-login-field">
              <span className="os-login-row">
                <label htmlFor="login-password">Password</label>
                {/* Until this existed, a forgotten password meant emailing somebody
                    at DakyXTech and waiting for them to set a new one by hand. */}
                <a href="/forgot-password">Forgotten it?</a>
              </span>
              <PasswordInput id="login-password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
          </>
        )}

        {error && (
          <Notice tone="danger" className="mt-4">
            {error}
          </Notice>
        )}

        {/* Sign in is the one action on this screen, so it is the one place
            the blue accent belongs. */}
        <Button type="submit" variant="accent" disabled={submitting} className="mt-6 w-full justify-center py-3">
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
    </AuthFrame>
  );
}
