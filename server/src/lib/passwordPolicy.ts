import { z } from "zod";

/**
 * What counts as an acceptable password, in one place.
 *
 * There were three separate rules before this — `min(10)` written out three
 * times in two files — which is how a policy drifts: one of them gets raised,
 * the other two don't, and the weakest path is the one an attacker uses.
 * Everything that sets a password imports `passwordField` from here.
 *
 * The shape of the rules follows NIST SP 800-63B rather than the older
 * "one uppercase, one digit, one symbol" habit: length and a blocklist do the
 * work, composition rules mostly produce `Password1!`. What is checked:
 *
 * - **Length.** 12 minimum, which is the single biggest factor. Capped at 200
 *   so a megabyte of text can't be pushed through scrypt as a way of pinning
 *   the CPU.
 * - **A blocklist**, of the passwords that appear at the top of every breach
 *   corpus, plus the ones specific to this company. `dakyworld2026` would sail
 *   past any length rule and is the first thing anybody would try.
 * - **Nothing derived from the account.** The email, its local part, or the
 *   person's name appearing inside the password.
 * - **Runs and repeats** — `aaaaaaaaaaaa` and `123456789012` are twelve
 *   characters and no harder to guess than three.
 *
 * Deliberately *not* here: expiry. Forced rotation makes people iterate a
 * counter on the end, and this system already drops every session on a change,
 * which is the thing rotation was trying to buy.
 */

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

/**
 * The head of the common-password lists, plus what somebody would pick for
 * this system specifically. Not a substitute for a full corpus — it is the
 * hundred that would otherwise get chosen this week.
 */
const BLOCKLIST = new Set(
  [
    "password", "passw0rd", "password1", "password123", "password1234", "passwordpassword",
    "123456", "1234567", "12345678", "123456789", "1234567890", "123456789012",
    "qwertyuiop", "qwerty123456", "1qaz2wsx3edc", "zaq12wsxcde3",
    "letmein", "letmein123", "welcome1", "welcome123", "iloveyou123",
    "admin", "administrator", "admin123", "admin1234", "administrator1",
    "changeme", "changeme123", "secret123", "trustno1234", "sunshine123",
    "monkey123456", "dragon123456", "football123", "baseball123", "superman123",
    "abc123456789", "111111111111", "000000000000", "aaaaaaaaaaaa",
    "iloveyouforever", "princess1234", "starwars1234", "whatever1234",
    "companyname1", "temporary123", "temppassword", "newpassword1", "resetpassword",
    // This company, this system. The obvious guesses.
    "dakyworld", "dakyworld1", "dakyworld123", "dakyworld2025", "dakyworld2026",
    "dakyworldos", "dakyworldos1", "dakyworldos2026", "dakyworldadmin",
    "kumasighana1", "ghana123456", "dankwameayipah", "danayipah123",
  ].map((entry) => entry.toLowerCase()),
);

/** Lowercased, punctuation dropped. The form everything else is built from. */
function flatten(password: string): string {
  return password.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Every form of a password worth testing against the blocklist.
 *
 * One canonical form is not enough, and getting this wrong is not academic:
 * a single fold that turned digits into letters let `P@ssw0rd1234` through,
 * because `0 -> o` and `1 -> i` rewrote the `1234` on the end into `i2ea` and
 * the result matched nothing. Two separate folds — symbols-to-letters and
 * digits-to-letters — plus a version with the trailing digits stripped, cover
 * the two things people actually do: swap characters that look alike, and
 * bolt a number on the end to satisfy a rule.
 */
function candidates(password: string): string[] {
  const base = password.toLowerCase();
  // Symbols only, so a numeric suffix survives.
  const symbolFold = base.replace(/@/g, "a").replace(/\$/g, "s").replace(/[!|]/g, "i");
  // Digits too, for `passw0rd` and `l33t`.
  const digitFold = (value: string) =>
    value.replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");

  const forms = new Set<string>();
  for (const form of [base, symbolFold, digitFold(base), digitFold(symbolFold)]) {
    const flat = flatten(form);
    forms.add(flat);
    // "the word, and then a number" — the single most common way of meeting a
    // length rule without adding anything an attacker has to guess.
    forms.add(flat.replace(/[0-9]+$/, ""));
  }
  forms.delete("");
  return [...forms];
}

/** All of one character, or a straight run up or down a keyboard row — with or without a number stuck on the end. */
function isLowEntropyRun(password: string): boolean {
  if (/^(.)\1+$/.test(password)) return true;

  const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
  for (const form of candidates(password)) {
    if (form.length < 4) continue;
    if (/^(.)\1+$/.test(form)) return true;
    const reversed = [...form].reverse().join("");
    if (SEQUENCES.some((seq) => seq.includes(form) || seq.includes(reversed))) return true;
  }
  return false;
}

export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

/**
 * The reason a password is refused, or null if it's fine.
 *
 * Returns one sentence rather than a list, because a form that reports every
 * fault at once teaches an attacker more about the rules than it helps the
 * person typing.
 */
export function passwordProblem(password: string, context: PasswordContext = {}): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Keep it under ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim().length !== password.length) {
    return "Remove the space at the start or end.";
  }

  const forms = candidates(password);
  if (forms.some((form) => BLOCKLIST.has(form))) {
    return "That is one of the most commonly used passwords. Pick something else.";
  }
  if (isLowEntropyRun(password)) {
    return "That is a single repeated character or a straight run of keys. Pick something else.";
  }

  // Anything derived from the account itself: an attacker targeting this
  // person already knows all of it.
  const derived = [context.email, context.email?.split("@")[0], context.name, ...(context.name?.split(/\s+/) ?? [])]
    .filter((value): value is string => Boolean(value && value.length >= 4))
    .map((value) => flatten(value))
    .filter((value) => value.length >= 4);

  if (derived.some((value) => forms.some((form) => form.includes(value)))) {
    return "Don't build it out of your own name or email address.";
  }

  return null;
}

/**
 * The zod field to use anywhere a new password arrives. Context-free — the
 * name/email checks need the account, so callers that have one should also run
 * `passwordProblem` with it. `assertPasswordAcceptable` does both.
 */
export const passwordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Keep it under ${MAX_PASSWORD_LENGTH} characters.`)
  .refine((value) => passwordProblem(value) === null, (value) => ({
    message: passwordProblem(value) ?? "Pick a stronger password.",
  }));

/** Thrown as a 400 by the routes. */
export class WeakPasswordError extends Error {}

export function assertPasswordAcceptable(password: string, context: PasswordContext = {}): void {
  const problem = passwordProblem(password, context);
  if (problem) throw new WeakPasswordError(problem);
}
