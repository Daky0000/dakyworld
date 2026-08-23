import { Router } from "express";
import { clearLoginAttempts, loginAccountRateLimit, loginRateLimit, rateLimit } from "../middleware/security.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { assertPasswordAcceptable, WeakPasswordError } from "../lib/passwordPolicy.js";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import {
  clearSessionCookie,
  createSession,
  revokeAllSessionsFor,
  revokeSession,
  setSessionCookie,
} from "../lib/session.js";
import { issueChallenge, readChallenge } from "../lib/mfaChallenge.js";
import { consumeRecoveryCode, generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from "../lib/totp.js";
import { requireAuth } from "../middleware/auth.js";
import { WITH_ACCESS, effectivePermissions } from "../lib/accessRoles.js";
import { COMPANY } from "../services/dakyworld.js";

export const authRouter = Router();

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

/**
 * What the client gets back about whoever is signed in. Never the row — that
 * carries the hash and the TOTP secret.
 *
 * `permissions` is the resolved set, and the client draws its entire navigation
 * from it. Sending the role name alone would push the client into re-deriving
 * "so what does an Operations & Finance actually see" from a copy of the rules,
 * which is exactly the duplicated permission table this whole change removed
 * from `Layout.tsx`.
 */
function publicUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  totpConfirmedAt: Date | null;
  extraPermissions: string[];
  deniedPermissions: string[];
  accessRole: { id: string; name: string; superAdmin: boolean; permissions: string[] } | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    twoFactorEnabled: Boolean(user.totpConfirmedAt),
    roleId: user.accessRole?.id ?? null,
    roleName: user.accessRole?.name ?? null,
    permissions: [...effectivePermissions(user)].sort(),
  };
}

/**
 * Failures are deliberately indistinguishable — unknown address, no password
 * set, deactivated account and wrong password all return the same message, so
 * this can't be used to enumerate who has an account.
 */
authRouter.post("/login", loginRateLimit, loginAccountRateLimit, async (req, res, next) => {
  try {
    const parsed = loginInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Email and password are required" });

    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, include: WITH_ACCESS });
    const ok = user?.active ? await verifyPassword(parsed.data.password, user.passwordHash) : false;

    if (!ok || !user) {
      // Spend roughly the same time on a miss as on a hit, so response timing
      // doesn't reveal whether the address exists.
      if (!user) await hashPassword(parsed.data.password);
      return res.status(401).json({ error: "Incorrect email or password" });
    }

    // The password was right but it is not, on its own, a session. Note that
    // the attempt counters are *not* cleared here: a correct password with no
    // second factor is exactly what a credential-stuffing run produces, and
    // forgiving it would hand an attacker a fresh allowance for guessing codes.
    if (user.totpConfirmedAt) {
      return res.json({ mfaRequired: true, challenge: issueChallenge(user.id) });
    }

    // Signing in successfully clears the counter, so a person who mistyped
    // twice and then got it right isn't locked out by their own attempts.
    clearLoginAttempts(req);
    setSessionCookie(res, await createSession(user.id));
    res.json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

/**
 * The second half of a login. Rate limited harder than the password step: six
 * digits is a million possibilities, and a limiter is the only thing standing
 * between that and an attacker who already has the password.
 */
const mfaAttemptLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 8,
  message: "Too many codes tried. Try again in {minutes}.",
});

const mfaLoginInput = z.object({
  challenge: z.string().min(1).max(500),
  code: z.string().min(1).max(40),
});

authRouter.post("/login/2fa", mfaAttemptLimit, async (req, res, next) => {
  try {
    const parsed = mfaLoginInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "That code is not the right shape" });

    const userId = readChallenge(parsed.data.challenge);
    if (!userId) return res.status(401).json({ error: "That sign-in has expired. Start again." });

    const user = await prisma.user.findUnique({ where: { id: userId }, include: WITH_ACCESS });
    if (!user?.active || !user.totpConfirmedAt || !user.totpSecret) {
      return res.status(401).json({ error: "That sign-in has expired. Start again." });
    }

    const secret = decryptSecret(user.totpSecret);
    if (!secret) {
      // APP_SECRET was rotated out from under the stored secret. Say so
      // plainly — the alternative is an Owner locked out by a message that
      // reads as "your authenticator is wrong".
      return res.status(500).json({
        error: "The stored second-factor secret can no longer be read (APP_SECRET changed). An Owner must reset it.",
      });
    }

    const step = verifyTotp(secret, parsed.data.code);
    if (step !== null) {
      // A code is single-use. Without this, one lifted off a phishing page
      // stays good for the rest of its thirty seconds.
      if (user.totpLastStep !== null && step <= user.totpLastStep) {
        return res.status(401).json({ error: "That code has already been used. Wait for the next one." });
      }
      await prisma.user.update({ where: { id: user.id }, data: { totpLastStep: step } });
    } else {
      const remaining = consumeRecoveryCode(parsed.data.code, user.totpRecoveryHashes);
      if (!remaining) return res.status(401).json({ error: "That code is not right" });
      await prisma.user.update({ where: { id: user.id }, data: { totpRecoveryHashes: remaining } });
    }

    clearLoginAttempts(req);
    mfaAttemptLimit.forgive(req);
    setSessionCookie(res, await createSession(user.id));
    res.json({ ...publicUser(user), recoveryCodesRemaining: user.totpRecoveryHashes.length });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    if (req.sessionToken) await revokeSession(req.sessionToken);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** The client calls this on load to decide between the app and the login screen. */
authRouter.get("/me", requireAuth, (req, res) => {
  res.json(publicUser(req.dbUser!));
});

const passwordChangeInput = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

authRouter.post("/password", requireAuth, async (req, res, next) => {
  try {
    const parsed = passwordChangeInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Both the current and the new password are required" });

    const user = req.dbUser!;
    if (process.env.OWNER_EMAIL?.trim().toLowerCase() === user.email) {
      // bootstrapOwner would overwrite this on the next deploy, so refusing is
      // kinder than silently reverting it.
      return res.status(409).json({
        error: "This account's password is set by OWNER_PASSWORD in Railway — change it there and redeploy",
      });
    }

    if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    assertPasswordAcceptable(parsed.data.newPassword, { email: user.email, name: user.name });

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    });
    // Drop every session including this one — a password change should end
    // any session an attacker might already hold.
    await revokeAllSessionsFor(user.id);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    if (err instanceof WeakPasswordError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// --- Second factor, for the account that is already signed in ----------------

/**
 * Enrolment is two steps on purpose. `/2fa/setup` mints a secret and stores it
 * *unconfirmed*; only a correct code from the app confirms it. Storing it
 * enabled in one step is how somebody locks themselves out of their own system
 * with a mistyped QR scan.
 */
authRouter.get("/2fa", requireAuth, (req, res) => {
  const user = req.dbUser!;
  res.json({
    enabled: Boolean(user.totpConfirmedAt),
    pending: Boolean(user.totpSecret && !user.totpConfirmedAt),
    enabledAt: user.totpConfirmedAt,
    recoveryCodesRemaining: user.totpRecoveryHashes.length,
  });
});

authRouter.post("/2fa/setup", requireAuth, async (req, res, next) => {
  try {
    const user = req.dbUser!;
    if (user.totpConfirmedAt) {
      return res.status(409).json({ error: "Two-factor is already on. Turn it off first to re-enrol." });
    }

    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: encryptSecret(secret), totpConfirmedAt: null, totpLastStep: null },
    });

    // The secret is shown once, here, because there is nowhere else it could
    // come from — the user has to type it into their authenticator.
    res.json({ secret, uri: totpUri(secret, user.email, COMPANY.displayName) });
  } catch (err) {
    next(err);
  }
});

const codeInput = z.object({ code: z.string().min(1).max(40) });

authRouter.post("/2fa/confirm", requireAuth, mfaAttemptLimit, async (req, res, next) => {
  try {
    const parsed = codeInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter the six-digit code" });

    const user = req.dbUser!;
    if (user.totpConfirmedAt) return res.status(409).json({ error: "Two-factor is already on." });
    if (!user.totpSecret) return res.status(409).json({ error: "Start again — there is no enrolment in progress." });

    const secret = decryptSecret(user.totpSecret);
    const step = secret ? verifyTotp(secret, parsed.data.code) : null;
    if (step === null) return res.status(400).json({ error: "That code is not right. Check your phone's clock and try the next one." });

    const { codes, hashes } = generateRecoveryCodes();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpConfirmedAt: new Date(), totpRecoveryHashes: hashes, totpLastStep: step },
    });
    mfaAttemptLimit.forgive(req);

    // Shown once and never again — they are stored as hashes, so this response
    // is the only time they exist in readable form.
    res.json({ enabled: true, recoveryCodes: codes });
  } catch (err) {
    next(err);
  }
});

const disableInput = z.object({
  password: z.string().min(1).max(200),
  code: z.string().min(1).max(40),
});

/**
 * Turning it off needs both factors. Requiring only the session would mean a
 * stolen session could strip the protection that the theft was supposed to run
 * into.
 */
authRouter.post("/2fa/disable", requireAuth, mfaAttemptLimit, async (req, res, next) => {
  try {
    const parsed = disableInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Your password and a current code are both required" });

    const user = req.dbUser!;
    if (!user.totpConfirmedAt || !user.totpSecret) return res.status(409).json({ error: "Two-factor is not on." });
    if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: "That password is not right" });
    }

    const secret = decryptSecret(user.totpSecret);
    const matched = secret ? verifyTotp(secret, parsed.data.code) !== null : false;
    const byRecovery = !matched && consumeRecoveryCode(parsed.data.code, user.totpRecoveryHashes) !== null;
    if (!matched && !byRecovery) return res.status(401).json({ error: "That code is not right" });

    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpConfirmedAt: null, totpRecoveryHashes: [], totpLastStep: null },
    });
    mfaAttemptLimit.forgive(req);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** A fresh set, which invalidates the old sheet. Needs the password, because the old sheet may be what an attacker has. */
authRouter.post("/2fa/recovery-codes", requireAuth, async (req, res, next) => {
  try {
    const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Your password is required" });

    const user = req.dbUser!;
    if (!user.totpConfirmedAt) return res.status(409).json({ error: "Two-factor is not on." });
    if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: "That password is not right" });
    }

    const { codes, hashes } = generateRecoveryCodes();
    await prisma.user.update({ where: { id: user.id }, data: { totpRecoveryHashes: hashes } });
    res.json({ recoveryCodes: codes });
  } catch (err) {
    next(err);
  }
});
