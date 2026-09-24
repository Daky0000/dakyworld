import crypto from "node:crypto";
import type { AuthTokenKind, User } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { hashPassword } from "../lib/password.js";
import { sendMail, mailerConfigured } from "../lib/mailer.js";
import { appUrl } from "./emailSender.js";
import { WebsiteError } from "./website/site.js";

/**
 * Getting into an account without somebody at Dakyworld doing it for you.
 *
 * Until now the only way an account existed was an Owner creating one and
 * telling the person their password, and the only way to change a forgotten
 * password was the same conversation. That is workable for five colleagues and
 * impossible for customers: somebody pays at two in the morning and there is
 * nothing to sign into until a human wakes up.
 *
 * Three links are issued here — a first password, a reset, and an address
 * verification — and they share one shape. The token is random, only its hash
 * is stored, it is single-use, and it expires. None of them ever says whether
 * an address is known: "if that address has an account, a link is on its way"
 * is the answer to a stranger and to a customer alike, because the difference
 * is exactly what somebody probing for accounts is asking for.
 */

const TOKEN_BYTES = 32;

const LIFETIME_MS: Record<AuthTokenKind, number> = {
  PASSWORD_RESET: 60 * 60_000, // an hour: long enough to find the email, short enough to matter
  EMAIL_VERIFICATION: 7 * 24 * 60 * 60_000,
  SET_PASSWORD: 7 * 24 * 60 * 60_000, // a customer who bought on Friday may not open it until Monday
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueToken(userId: string, kind: AuthTokenKind): Promise<string> {
  // One live token per purpose per account: issuing a new reset link must
  // silently retire the last one, or an old email keeps working.
  await prisma.authToken.updateMany({
    where: { userId, kind, usedAt: null },
    data: { usedAt: new Date() },
  });
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  await prisma.authToken.create({
    data: {
      userId,
      kind,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + LIFETIME_MS[kind]),
    },
  });
  return token;
}

/**
 * The account a token belongs to, or null.
 *
 * Deliberately returns null for every failure — unknown, expired, already
 * used — because a caller that could tell them apart would leak whether a
 * token ever existed.
 */
export async function consumeToken(token: string, kind: AuthTokenKind): Promise<User | null> {
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!row || row.kind !== kind || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;
  // Claim it before acting on it, and only if it is still unclaimed, so two
  // requests arriving with the same link cannot both succeed.
  const claimed = await prisma.authToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;
  return row.user;
}

async function linkFor(kind: AuthTokenKind, token: string): Promise<string> {
  const base = (await appUrl()).replace(/\/$/, "");
  const path = kind === "EMAIL_VERIFICATION" ? "verify-email" : "set-password";
  return `${base}/${path}?token=${encodeURIComponent(token)}`;
}

async function deliver(to: string, toName: string, subject: string, heading: string, body: string, link: string, action: string) {
  if (!(await mailerConfigured())) {
    // Nothing is configured, so nothing can be sent. Say so in the log with the
    // link in it: on a local machine that is how the flow stays testable, and
    // on a deployment it is the signal that mail needs setting up.
    console.warn(`[account] no mailer configured — ${subject} for ${to}: ${link}`);
    return;
  }
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#1b2029">
  <p>Hello ${escapeHtml(toName.split(" ")[0] ?? "there")},</p>
  <p>${escapeHtml(body)}</p>
  <p style="margin:26px 0"><a href="${link}" style="background:#1b2029;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">${escapeHtml(action)}</a></p>
  <p style="color:#5b6572;font-size:13px">If the button does not work, paste this into your browser:<br>${escapeHtml(link)}</p>
  <p style="color:#5b6572;font-size:13px">If you were not expecting this, you can ignore it and nothing will change.</p>
  <p>Dakyworld</p>
</div>`;
  const text = `Hello ${toName.split(" ")[0] ?? "there"},\n\n${body}\n\n${action}: ${link}\n\nIf you were not expecting this, you can ignore it and nothing will change.\n\nDakyworld`;
  await sendMail({ to, toName, subject: heading, html, text });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/* ------------------------------------------------------- the three flows -- */

/** A customer who has just paid, or a colleague who has just been invited. */
export async function sendSetPasswordLink(user: { id: string; email: string; name: string }, reason: "purchase" | "invite" = "invite") {
  const token = await issueToken(user.id, "SET_PASSWORD");
  const link = await linkFor("SET_PASSWORD", token);
  await deliver(
    user.email,
    user.name,
    "Set your Dakyworld password",
    reason === "purchase" ? "Your Website Builder account is ready" : "Your Dakyworld account is ready",
    reason === "purchase"
      ? "Thank you for your payment. Choose a password and your website editor is ready to use."
      : "An account has been created for you. Choose a password to sign in.",
    link,
    "Choose a password",
  );
  return link;
}

export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, email: true, name: true, active: true } });
  // An inactive account gets no link either, and the caller is told nothing
  // about which case it was.
  if (!user || !user.active) return;
  const token = await issueToken(user.id, "PASSWORD_RESET");
  const link = await linkFor("PASSWORD_RESET", token);
  await deliver(
    user.email,
    user.name,
    "Reset your Dakyworld password",
    "Reset your password",
    "Somebody asked to reset the password on this account. The link is good for one hour.",
    link,
    "Choose a new password",
  );
}

export async function sendEmailVerification(user: { id: string; email: string; name: string }) {
  const token = await issueToken(user.id, "EMAIL_VERIFICATION");
  const link = await linkFor("EMAIL_VERIFICATION", token);
  await deliver(
    user.email,
    user.name,
    "Confirm your email address",
    "Confirm your email address",
    "Please confirm this address so we can reach you about your website.",
    link,
    "Confirm address",
  );
}

/**
 * Sets a password from a link and signs every other session out.
 *
 * Revoking the rest is the point of the operation as much as the new password
 * is: somebody resetting a password they think was stolen has to end the
 * thief's session too, and leaving those alive would make the reset cosmetic.
 */
export async function completePasswordFromToken(token: string, password: string, kind: AuthTokenKind): Promise<User> {
  if (password.length < 10) throw new WebsiteError(400, "Choose a password of at least 10 characters.");
  const user = await consumeToken(token, kind);
  if (!user) throw new WebsiteError(400, "That link has expired or has already been used. Ask for a new one.");
  const passwordHash = await hashPassword(password);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      // Following a link sent to the address proves the address, so a first
      // password doubles as verification and the customer is not asked twice.
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
    },
  });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  return updated;
}

export async function verifyEmailFromToken(token: string): Promise<User> {
  const user = await consumeToken(token, "EMAIL_VERIFICATION");
  if (!user) throw new WebsiteError(400, "That link has expired or has already been used. Ask for a new one.");
  return prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
}

/**
 * The account behind a paid subscription, created if it does not exist.
 *
 * No password is set: the customer chooses one from the link, so no password
 * ever travels by email and nothing has to be told to them by a person. The
 * account is external — a customer, not staff — and carries only the website
 * permissions their plan implies.
 */
export async function ensureCustomerAccount(input: {
  email: string;
  name: string;
  businessName?: string | null;
}): Promise<{ user: User; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { user: existing, created: false };

  const externalRole = await prisma.accessRole.findFirst({ where: { external: true }, select: { id: true } });
  const user = await prisma.user.create({
    data: {
      email,
      name: input.name,
      role: "DEVELOPER",
      active: true,
      accessRoleId: externalRole?.id ?? null,
      extraPermissions: ["website.view", "website.edit", "website.publish"],
    },
  });
  return { user, created: true };
}
