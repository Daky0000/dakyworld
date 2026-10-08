/**
 * The server's password rules, mirrored so the screen can say what will be
 * refused before it is sent.
 *
 * `server/src/lib/passwordPolicy.ts` is the authority — it is what actually
 * refuses a password — and this file must say the same thing. Change one, change
 * both. The blocklist here is the short head of the server's; the server still
 * catches whatever this misses, it just catches it a round trip later.
 *
 * The strength score on top is guidance, not a rule: a password that passes
 * every check is accepted whatever the meter says.
 */

export const MIN_PASSWORD_LENGTH = 12;

const COMMON = new Set([
  "password", "passw0rd", "password1", "password123", "123456", "12345678", "123456789", "1234567890",
  "qwertyuiop", "qwerty123456", "letmein", "welcome1", "welcome123", "iloveyou123", "admin", "admin123",
  "administrator", "changeme", "changeme123", "secret123", "sunshine123", "football123", "princess1234",
  "temppassword", "newpassword1", "resetpassword", "dakyworld", "dakyworld123", "dakyx", "dakyxtech", "ghana123456",
]);

const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

function flatten(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function forms(password: string): string[] {
  const base = password.toLowerCase();
  const symbols = base.replace(/@/g, "a").replace(/\$/g, "s").replace(/[!|]/g, "i");
  const digits = (value: string) => value.replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");
  const out = new Set<string>();
  for (const form of [base, symbols, digits(base), digits(symbols)]) {
    const flat = flatten(form);
    out.add(flat);
    out.add(flat.replace(/[0-9]+$/, ""));
  }
  out.delete("");
  return [...out];
}

export type PasswordContext = { email?: string | null; name?: string | null };

export type PasswordCheck = { key: "length" | "common" | "personal" | "spaces"; label: string; ok: boolean };

/** The rules the server enforces, each as a line the guide can tick. */
export function passwordChecks(password: string, context: PasswordContext = {}): PasswordCheck[] {
  const variants = forms(password);
  const common =
    variants.some((form) => COMMON.has(form)) ||
    /^(.)\1+$/.test(password) ||
    variants.some((form) => form.length >= 4 && (/^(.)\1+$/.test(form) || SEQUENCES.some((seq) => seq.includes(form) || seq.includes([...form].reverse().join("")))));
  const personal = [context.email, context.email?.split("@")[0], context.name, ...(context.name?.split(/\s+/) ?? [])]
    .filter((value): value is string => Boolean(value && value.length >= 4))
    .map(flatten)
    .filter((value) => value.length >= 4)
    .some((value) => variants.some((form) => form.includes(value)));
  return [
    { key: "length", label: `At least ${MIN_PASSWORD_LENGTH} characters`, ok: password.length >= MIN_PASSWORD_LENGTH },
    { key: "common", label: "Not a common password or a run of keys", ok: password.length > 0 && !common },
    { key: "personal", label: "Not built from your name or email", ok: password.length > 0 && !personal },
    { key: "spaces", label: "No space at the start or end", ok: password.length > 0 && password.trim() === password },
  ];
}

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string; acceptable: boolean };

/**
 * 0–4. Anything failing a rule is 0 or 1, because the server will refuse it.
 * Above that, length counts for most — a long passphrase of plain words beats a
 * short tangle of symbols — and variety and unrepeated characters for the rest.
 */
export function passwordStrength(password: string, context: PasswordContext = {}): Strength {
  if (!password) return { score: 0, label: "", acceptable: false };
  const checks = passwordChecks(password, context);
  const acceptable = checks.every((check) => check.ok);
  if (!acceptable) return { score: password.length >= 8 ? 1 : 0, label: password.length < MIN_PASSWORD_LENGTH ? "Too short" : "Too easy to guess", acceptable };

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  const unique = new Set(password).size / password.length;
  const words = password.trim().split(/[\s\-_.]+/).filter((word) => word.length >= 3).length;
  let points = 0;
  points += password.length >= 20 ? 3 : password.length >= 16 ? 2 : 1;
  points += classes >= 3 ? 1 : 0;
  points += words >= 3 ? 1 : 0;
  points -= unique < 0.5 ? 1 : 0;
  const score = Math.max(2, Math.min(4, points)) as 2 | 3 | 4;
  return { score, label: score === 4 ? "Very strong" : score === 3 ? "Strong" : "Good", acceptable };
}
