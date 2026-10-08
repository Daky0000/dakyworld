import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { SURFACE_NAME, currentSurface, setPageTitle } from "../lib/surface";
import { passwordStrength } from "../lib/passwordStrength";
import { ConfirmPasswordField, NewPasswordField } from "../components/PasswordField";
import { AuthFrame } from "./Login";

/**
 * The three screens somebody reaches from a link in an email, plus the "I have
 * forgotten it" form on the sign-in page.
 *
 * They are deliberately outside the signed-in app: everybody who arrives here
 * is by definition unable to sign in. `main.tsx` shows them before the auth
 * gate, from the path alone.
 */

function Shell({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  useEffect(() => setPageTitle(title), [title]);
  return (
    <AuthFrame footer={<a href="/">Back to sign in</a>}>
      <h1 className="os-login-title">{title}</h1>
      {lead && <p className="os-login-lead">{lead}</p>}
      <div className="space-y-4 text-sm text-ink">{children}</div>
    </AuthFrame>
  );
}

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

/** Sets a first password (after a purchase or an invite) or a replacement one. */
export function SetPassword({ kind }: { kind: "SET_PASSWORD" | "PASSWORD_RESET" }) {
  const [token, setToken] = useState(() => tokenFromUrl());
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get("email") ?? "");
  const [verifying, setVerifying] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // One switch shows or hides both fields, so the two can be compared by eye.
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reference = new URLSearchParams(window.location.search).get("reference") || new URLSearchParams(window.location.search).get("trxref") || "";
  const isOnboarding = new URLSearchParams(window.location.search).get("onboarding") === "true" || kind === "SET_PASSWORD";

  useEffect(() => {
    if (!token && reference) {
      setVerifying(true);
      api
        .post<{ paid: boolean; token?: string; email?: string }>("/public/website-payment-status", { reference })
        .then((res) => {
          if (res.token) setToken(res.token);
          if (res.email) setEmail(res.email);
        })
        .catch((err) => setError((err as Error).message))
        .finally(() => setVerifying(false));
    }
  }, [token, reference]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!passwordStrength(password, { email }).acceptable) {
      setError("That password doesn't meet the rules under it yet.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords are not the same.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/password/token", { token, password, kind });
      // Signed in by the same request, so go straight on. A new customer lands
      // on the welcome flow (/website/welcome), which sends anybody who already
      // has a website to their pages; /website/onboarding is the staff checklist.
      window.location.href = isOnboarding ? "/website/welcome" : "/";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (verifying) {
    return (
      <Shell title="Verifying payment…">
        <p className="text-sm text-muted">
          Confirming your purchase with Paystack and preparing your account setup…
        </p>
      </Shell>
    );
  }

  if (!token) {
    return (
      <Shell title="That link is incomplete">
        <p className="text-muted">
          The address is missing its token. Open the link from the email again, or ask for a new one from the sign-in
          screen.
        </p>
      </Shell>
    );
  }

  const title = kind === "PASSWORD_RESET" ? "Choose a new password" : "Create your password";
  const ready = passwordStrength(password, { email }).acceptable && password === confirm;

  return (
    <Shell
      title={title}
      lead={isOnboarding ? "This is the password you'll sign in with from now on." : "Pick one you haven't used before. The old one stops working as soon as you save."}
    >
      {email && (
        <div className="os-login-account">
          <span>Account</span>
          <b>{email}</b>
        </div>
      )}
      <form className="space-y-4" onSubmit={submit}>
        {/* The username field lets a password manager file the new password
            under the right account instead of asking which one it was for. */}
        {email && <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />}
        <NewPasswordField value={password} onChange={setPassword} context={{ email }} shown={shown} onToggle={() => setShown((value) => !value)} autoFocus />
        <ConfirmPasswordField value={confirm} onChange={setConfirm} against={password} shown={shown} onToggle={() => setShown((value) => !value)} />
        {error && <p role="alert" className="rounded-xl bg-warn-surface p-3 text-xs text-warn-text">{error}</p>}
        <button type="submit" disabled={busy || !ready} className="os-login-submit">
          {busy ? "Saving…" : isOnboarding ? "Create password and continue" : "Save and sign in"}
        </button>
      </form>
    </Shell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    // The answer is the same whether or not the address is known, so there is
    // nothing to branch on and nothing to report.
    await api.post("/auth/password/forgot", { email }).catch(() => undefined);
    setSent(true);
    setBusy(false);
  }

  if (sent) {
    return (
      <Shell title="Check your email" lead={<>If {email} has an account, a link to choose a new password is on its way. It is good for one hour.</>}>
        <a className="os-login-submit" href="/">
          Back to sign in
        </a>
      </Shell>
    );
  }

  return (
    <Shell title="Forgotten your password?" lead="Enter the address you sign in with and we'll email you a link to choose a new one.">
      <form className="space-y-4" onSubmit={submit}>
        <label className="os-login-field">
          <span>Email</span>
          <input type="email" required autoComplete="email" className="input" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus />
        </label>
        <button type="submit" disabled={busy} className="os-login-submit">
          {busy ? "Sending…" : "Send me a link"}
        </button>
      </form>
    </Shell>
  );
}

export function VerifyEmail() {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = tokenFromUrl();
    if (!token) {
      setState("failed");
      setMessage("The address is missing its token.");
      return;
    }
    api
      .post<{ email: string }>("/auth/email/verify", { token })
      .then((result) => {
        setState("done");
        setMessage(result.email);
      })
      .catch((err: Error) => {
        setState("failed");
        setMessage(err.message);
      });
  }, []);

  return (
    <Shell title={state === "done" ? "Address confirmed" : state === "failed" ? "That link did not work" : "Confirming…"}>
      {state === "done" && <p className="text-muted">{message} is confirmed. You can close this tab.</p>}
      {state === "failed" && <p className="text-muted">{message}</p>}
      {state !== "working" && (
        <a className="os-login-submit" href="/">
          Go to {SURFACE_NAME[currentSurface()]}
        </a>
      )}
    </Shell>
  );
}
