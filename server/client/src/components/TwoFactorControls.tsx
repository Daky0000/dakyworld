import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Button, Field } from "./ui";

/**
 * Two-factor sign-in, for whoever is signed in — staff in Settings, customers
 * on their account page. One implementation, because the four steps (start,
 * confirm, new recovery codes, turn off) have exact rules on the server and two
 * copies of the forms would drift from them separately.
 *
 * Enrolment is deliberately two steps, and it is the confirm step that turns it
 * on: storing a secret as "enabled" before the app has proved it can read it is
 * how somebody locks themselves out with a mistyped setup key.
 *
 * There is no QR code here on purpose — a QR generator is a dependency and a
 * few hundred lines to save one paste, and every authenticator worth using
 * (Google Authenticator, Authy, 1Password, Bitwarden) accepts a setup key
 * entered by hand.
 */
export type TwoFactorState = {
  enabled: boolean;
  pending: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
};

export function useTwoFactorState() {
  return useQuery({ queryKey: ["2fa"], queryFn: ({ signal }) => api.get<TwoFactorState>("/auth/2fa", signal) });
}

export function TwoFactorControls({ data }: { data?: TwoFactorState }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["2fa"] });
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "Something went wrong.");

  const begin = useMutation({
    mutationFn: () => api.post<{ secret: string; uri: string }>("/auth/2fa/setup", {}),
    onSuccess: (result) => {
      setError(null);
      setSetup(result);
    },
    onError: fail,
  });

  const confirm = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/auth/2fa/confirm", { code }),
    onSuccess: (result) => {
      setError(null);
      setSetup(null);
      setCode("");
      setRecoveryCodes(result.recoveryCodes);
      refresh();
    },
    onError: fail,
  });

  const disable = useMutation({
    mutationFn: () => api.post("/auth/2fa/disable", { password, code: disableCode }),
    onSuccess: () => {
      setError(null);
      setPassword("");
      setDisableCode("");
      setRecoveryCodes(null);
      refresh();
    },
    onError: fail,
  });

  const regenerate = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { password }),
    onSuccess: (result) => {
      setError(null);
      setPassword("");
      setRecoveryCodes(result.recoveryCodes);
      refresh();
    },
    onError: fail,
  });

  // Grouped in fours, because this gets typed into a phone by hand.
  const grouped = setup?.secret.replace(/(.{4})/g, "$1 ").trim();

  return (
    <>
      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          {error}
        </p>
      )}

      {recoveryCodes && (
        <div className="mt-4 rounded-xl border border-warn-line bg-warn-surface px-3 py-3">
          <p className="text-sm font-bold text-warn-text">Recovery codes — copy them now. They are not shown again.</p>
          <p className="mt-1 text-xs text-warn-text/80">
            Each works once, in place of a code from your phone. Keep them somewhere that is not the phone.
          </p>
          <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-xs text-warn-text sm:grid-cols-2">
            {recoveryCodes.map((entry) => (
              <span key={entry}>{entry}</span>
            ))}
          </div>
          <div className="mt-3">
            <Button onClick={() => setRecoveryCodes(null)}>I have saved them</Button>
          </div>
        </div>
      )}

      {!data?.enabled && !setup && (
        <div className="mt-4">
          <Button onClick={() => begin.mutate()} disabled={begin.isPending}>
            {begin.isPending ? "Starting…" : "Turn on two-factor"}
          </Button>
        </div>
      )}

      {setup && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <div>
            <p className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Setup key</p>
            <p className="mt-1 text-sm text-muted">
              In your authenticator app, add an account by entering a setup key, and paste this.
            </p>
            <code className="rounded-xl mt-2 block select-all break-all border border-line bg-cream px-3 py-2 font-mono text-sm">
              {grouped}
            </code>
          </div>
          <Field label="Then the six-digit code it shows">
            <input
              className="input font-mono tracking-[.2em]"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={confirm.isPending || code.trim().length < 6}>
              {confirm.isPending ? "Checking…" : "Confirm"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setSetup(null);
                setCode("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {data?.enabled && (
        <div className="mt-6 space-y-6 border-t border-line pt-5">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              regenerate.mutate();
            }}
          >
            <p className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">New recovery codes</p>
            <p className="text-sm text-muted">
              Issues a fresh set and voids the old sheet. Worth doing if you cannot account for where the last one ended up.
            </p>
            <Field label="Your password">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" disabled={regenerate.isPending || !password}>
              {regenerate.isPending ? "Issuing…" : "Issue new codes"}
            </Button>
          </form>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            <p className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">Turn it off</p>
            <p className="text-sm text-muted">
              Both factors are required, so a stolen session cannot strip the protection it has just run into. Fill in the
              password above as well.
            </p>
            <Field label="A current code, or a recovery code">
              <input
                className="input font-mono tracking-[.2em]"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                autoComplete="one-time-code"
                required
              />
            </Field>
            <Button type="submit" disabled={disable.isPending || !password || !disableCode}>
              {disable.isPending ? "Turning off…" : "Turn off two-factor"}
            </Button>
          </form>
        </div>
      )}
    </>
  );
}
