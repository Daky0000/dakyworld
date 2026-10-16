import express, { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { rateLimit } from "../middleware/security.js";
import { entitlementsFor } from "../services/entitlements.js";
import {
  CODE_TTL_MS,
  authenticateClient,
  clientCredentials,
  errorRedirect,
  findClient,
  hashCode,
  issuer,
  newCode,
  partnerKeyMatches,
  pkceMatches,
  redirectAllowed,
  validChallenge,
} from "../services/oauth.js";

/**
 * Sign-in for DakyX's other products, and what they may ask about a person.
 *
 *   GET  /api/auth/oauth/authorize   browser; needs the OS session
 *   POST /api/auth/oauth/token       the partner's backend; client secret + PKCE
 *   GET  /api/auth/oauth/products    the signed-in person's own grants, for the nav
 *   GET  /api/partner/v1/entitlements/:sub   the partner's backend; partner key
 *
 * Under /api/auth so every host serves it (editor.dakyx.com and app.dakyx.com
 * hide most of the API, and a customer's session lives on whichever host they
 * signed in at — the cookie is `__Host-`, deliberately never shared).
 * docs/cross-product-access.md.
 */

export const oauthRouter = Router();
export const partnerRouter = Router();

const oauthLimit = rateLimit({ windowMs: 60_000, max: 60, message: "Too many sign-in requests. Try again in {minutes}." });
const partnerLimit = rateLimit({ windowMs: 60_000, max: 600, message: "Too many requests. Try again in {minutes}." });

oauthRouter.get("/authorize", oauthLimit, async (req, res, next) => {
  try {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = req.query;
    const client = findClient(client_id);
    // Until the client and its redirect are known good, an error is shown here
    // and never sent anywhere: redirecting to an unchecked URI is the open redirect.
    if (!client || !redirectAllowed(client, redirect_uri)) {
      return res.status(400).type("text/plain").send("This sign-in link is not valid. Go back to the app you came from and try again.");
    }
    if (response_type !== "code") return res.redirect(302, errorRedirect(redirect_uri, "unsupported_response_type", state));
    if (typeof state !== "string" || state.length < 16 || state.length > 512) return res.redirect(302, errorRedirect(redirect_uri, "invalid_request", state));
    if (code_challenge_method !== "S256" || !validChallenge(code_challenge)) return res.redirect(302, errorRedirect(redirect_uri, "invalid_request", state));

    const user = req.dbUser;
    if (!user) {
      // The SPA shows the sign-in form on any path and, once signed in, sends
      // /sso/continue straight back here with the same query.
      const query = new URLSearchParams(req.query as Record<string, string>).toString();
      return res.redirect(302, `/sso/continue?${query}`);
    }
    if (!user.active || user.deletionScheduledFor) return res.redirect(302, errorRedirect(redirect_uri, "access_denied", state));

    const { code, hash } = newCode();
    await prisma.oAuthCode.create({
      data: {
        codeHash: hash,
        userId: user.id,
        clientId: client.id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    const back = new URL(redirect_uri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    back.searchParams.set("iss", issuer());
    res.redirect(302, back.toString());
  } catch (err) {
    next(err);
  }
});

oauthRouter.post("/token", oauthLimit, express.urlencoded({ extended: false, limit: "16kb" }), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const client = authenticateClient(clientCredentials(req.get("authorization"), body));
    if (!client) return res.status(401).json({ error: "invalid_client" });
    if (body.grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });
    if (typeof body.code !== "string" || body.code.length > 200) return res.status(400).json({ error: "invalid_grant" });

    const codeHash = hashCode(body.code);
    // Spent in the same statement that checks it is unspent and unexpired, so
    // two redemptions racing each other cannot both see "unused".
    const spent = await prisma.oAuthCode.updateMany({
      where: { codeHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (spent.count !== 1) return res.status(400).json({ error: "invalid_grant" });

    const row = await prisma.oAuthCode.findUnique({ where: { codeHash } });
    if (!row || row.clientId !== client.id || row.redirectUri !== body.redirect_uri || !pkceMatches(body.code_verifier, row.codeChallenge)) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, email: true, name: true, active: true, deletionScheduledFor: true, emailVerifiedAt: true } });
    if (!user?.active || user.deletionScheduledFor) return res.status(400).json({ error: "invalid_grant" });

    const entitlements = await entitlementsFor(user.id);
    res.json({
      iss: issuer(),
      aud: client.id,
      sub: user.id,
      email: user.email,
      email_verified: Boolean(user.emailVerifiedAt),
      name: user.name,
      entitlements,
    });
  } catch (err) {
    next(err);
  }
});

oauthRouter.get("/products", async (req, res, next) => {
  try {
    if (!req.dbUser) return res.status(401).json({ error: "Not authenticated" });
    const entitlements = await entitlementsFor(req.dbUser.id);
    const marketingUrl = process.env.MARKETING_APP_URL?.trim().replace(/\/$/, "") || "https://marketing.dakyx.com";
    res.json({
      grants: entitlements.grants,
      // The SaaS starts the sign-in itself — it holds the state and the PKCE verifier.
      marketing: { url: `${marketingUrl}/api/auth/dakyx/start?next=%2Fdashboard`, included: entitlements.grants.some((grant) => grant.product === "marketing-suite") },
    });
  } catch (err) {
    next(err);
  }
});

partnerRouter.get("/v1/entitlements/:sub", partnerLimit, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    if (!partnerKeyMatches(req.get("authorization"))) return res.status(401).json({ error: "invalid_token" });
    const sub = String(req.params.sub ?? "");
    if (!/^[a-z0-9]{10,40}$/i.test(sub)) return res.status(400).json({ error: "invalid_subject" });
    res.json(await entitlementsFor(sub));
  } catch (err) {
    next(err);
  }
});

/** Spent and expired codes are worth nothing after a day. */
export async function purgeOAuthCodes(now = new Date()): Promise<void> {
  await prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
}
