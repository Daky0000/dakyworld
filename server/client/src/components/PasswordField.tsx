import { useId, useState, type InputHTMLAttributes } from "react";
import { passwordChecks, passwordStrength, type PasswordContext } from "../lib/passwordStrength";

/**
 * A password input with a show/hide button.
 *
 * Seeing what you typed is the cheapest fix for the commonest sign-in failure,
 * and on a phone it is the only way to check a long passphrase. The button is a
 * real button with a label that says what it will do, and it never submits the
 * form it sits in.
 */
export function PasswordInput({
  className = "",
  shown,
  onToggle,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { shown?: boolean; onToggle?: () => void }) {
  const [ownShown, setOwnShown] = useState(false);
  const visible = shown ?? ownShown;
  const toggle = onToggle ?? (() => setOwnShown((value) => !value));
  return (
    <div className="pw-wrap">
      <input {...props} type={visible ? "text" : "password"} className={`input pw-input ${className}`} spellCheck={false} autoCapitalize="none" />
      <button type="button" className="pw-eye" onClick={toggle} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible} title={visible ? "Hide password" : "Show password"}>
        {visible ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
        )}
      </button>
    </div>
  );
}

/**
 * Choosing a new password: the field, a strength meter, and the guide.
 *
 * The guide is the server's own rules (`lib/passwordStrength.ts` mirrors
 * `passwordPolicy.ts`), ticked as they are met, so nobody learns a rule by
 * having a password refused. The meter is advice on top of that.
 */
export function NewPasswordField({
  value,
  onChange,
  context,
  label = "New password",
  shown,
  onToggle,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  context?: PasswordContext;
  label?: string;
  shown?: boolean;
  onToggle?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const strength = passwordStrength(value, context);
  const checks = passwordChecks(value, context);
  return (
    <div className="pw-field">
      <label htmlFor={id} className="pw-label">{label}</label>
      <PasswordInput id={id} autoComplete="new-password" required value={value} onChange={(event) => onChange(event.target.value)} shown={shown} onToggle={onToggle} autoFocus={autoFocus} aria-describedby={`${id}-guide`} />
      <div className="pw-meter" data-score={value ? strength.score : undefined} aria-hidden="true">
        {[1, 2, 3, 4].map((step) => <i key={step} className={value && strength.score >= step ? "on" : ""} />)}
      </div>
      <div className="pw-meta" aria-live="polite">
        <span>{value ? strength.label : "How strong it is shows here"}</span>
        <span>{value.length ? `${value.length} characters` : ""}</span>
      </div>
      <ul className="pw-guide" id={`${id}-guide`}>
        {checks.map((check) => (
          <li key={check.key} className={check.ok ? "ok" : value ? "no" : ""}>
            {check.ok ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>
            )}
            <span>{check.label}</span>
            <span className="sr-only">{check.ok ? " — done" : " — not yet"}</span>
          </li>
        ))}
      </ul>
      <p className="pw-tip">
        <b>Tip:</b> three or four unrelated words — <i>kente mango bicycle river</i> — make a password that is long, hard to guess and easy to remember.
      </p>
    </div>
  );
}

/** "Type it again", with the one thing worth saying about it. */
export function ConfirmPasswordField({ value, onChange, against, shown, onToggle }: { value: string; onChange: (value: string) => void; against: string; shown?: boolean; onToggle?: () => void }) {
  const id = useId();
  const state = !value ? null : value === against ? "match" : against.startsWith(value) ? null : "differs";
  return (
    <div className="pw-field">
      <label htmlFor={id} className="pw-label">Type it again</label>
      <PasswordInput id={id} autoComplete="new-password" required value={value} onChange={(event) => onChange(event.target.value)} shown={shown} onToggle={onToggle} />
      {state === "match" && <p className="pw-match ok">The two passwords match.</p>}
      {state === "differs" && <p className="pw-match no">These are not the same yet.</p>}
    </div>
  );
}
