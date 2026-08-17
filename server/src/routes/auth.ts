import { Router } from "express";
import { clearLoginAttempts, loginRateLimit } from "../middleware/security.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  clearSessionCookie,
  createSession,
  revokeAllSessionsFor,
  revokeSession,
  setSessionCookie,
} from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Failures are deliberately indistinguishable — unknown address, no password
 * set, deactivated account and wrong password all return the same message, so
 * this can't be used to enumerate who has an account.
 */
authRouter.post("/login", loginRateLimit, async (req, res, next) => {
  try {
    const parsed = loginInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Email and password are required" });

    const email = parsed.data.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    const ok = user?.active ? await verifyPassword(parsed.data.password, user.passwordHash) : false;

    if (!ok || !user) {
      // Spend roughly the same time on a miss as on a hit, so response timing
      // doesn't reveal whether the address exists.
      if (!user) await hashPassword(parsed.data.password);
      return res.status(401).json({ error: "Incorrect email or password" });
    }

    // Signing in successfully clears the counter, so a person who mistyped
    // twice and then got it right isn't locked out by their own attempts.
    clearLoginAttempts(req);
    setSessionCookie(res, await createSession(user.id));
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
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
  const { id, name, email, role } = req.dbUser!;
  res.json({ id, name, email, role });
});

const passwordChangeInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, "Use at least 10 characters"),
});

authRouter.post("/password", requireAuth, async (req, res, next) => {
  try {
    const parsed = passwordChangeInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid password" });
    }

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
    next(err);
  }
});
