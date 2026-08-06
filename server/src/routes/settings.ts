import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { SETTING, deleteSetting, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { maskSecret } from "../lib/secrets.js";
import { ApifyError, getAccount } from "../lib/apify.js";

export const settingsRouter = Router();

// Integration credentials are Owner-only: they spend real money and reach
// outside the company.
settingsRouter.use(requireRole("OWNER"));

// The account lookup is a network round trip; the settings page polls, so a
// short cache keeps it from hammering Apify on every render.
const ACCOUNT_CACHE_MS = 60_000;
let accountCache: { at: number; token: string; account: unknown | null; error: string | null } | null = null;

async function describeApify() {
  const token = await getSetting(SETTING.APIFY_TOKEN);
  if (!token) {
    return { connected: false, envManaged: isEnvManaged(SETTING.APIFY_TOKEN), token: null, account: null, error: null };
  }

  if (!accountCache || accountCache.token !== token || Date.now() - accountCache.at > ACCOUNT_CACHE_MS) {
    try {
      const account = await getAccount(token);
      accountCache = { at: Date.now(), token, account, error: null };
    } catch (err) {
      accountCache = { at: Date.now(), token, account: null, error: (err as Error).message };
    }
  }

  return {
    connected: Boolean(accountCache.account),
    envManaged: isEnvManaged(SETTING.APIFY_TOKEN),
    token: maskSecret(token),
    account: accountCache.account,
    error: accountCache.error,
  };
}

// GET /api/settings/integrations
settingsRouter.get("/integrations", async (_req, res, next) => {
  try {
    res.json({ apify: await describeApify() });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/integrations/apify — the token is verified against Apify
// before it is stored, so a typo fails here rather than silently at 6am.
settingsRouter.put("/integrations/apify", async (req, res, next) => {
  try {
    const { token } = z.object({ token: z.string().min(10, "That doesn't look like an Apify token") }).parse(req.body);

    try {
      await getAccount(token.trim());
    } catch (err) {
      const status = err instanceof ApifyError ? err.status : 400;
      return res.status(status === 401 || status === 403 ? 400 : status).json({
        error: err instanceof ApifyError ? err.message : "Could not verify the token with Apify",
      });
    }

    await setSetting(SETTING.APIFY_TOKEN, token.trim(), { secret: true });
    accountCache = null;
    res.json({ apify: await describeApify() });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/settings/integrations/apify — disconnects. Sources and captured
// leads are left alone; scheduled runs simply stop firing.
settingsRouter.delete("/integrations/apify", async (_req, res, next) => {
  try {
    await deleteSetting(SETTING.APIFY_TOKEN);
    accountCache = null;
    res.json({ apify: await describeApify() });
  } catch (err) {
    next(err);
  }
});
