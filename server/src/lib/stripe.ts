import Stripe from "stripe";
import { SETTING, getSetting } from "./settings.js";

/**
 * Stripe, configured at use rather than at boot.
 *
 * The key can be pasted into Settings and stored encrypted in the database, so
 * it can change without a redeploy — which means the client can't be a
 * module-level constant built from `process.env` any more. The client is
 * rebuilt only when the key itself changes, so the common case is still one
 * object for the life of the process.
 */

let cached: { key: string; client: Stripe } | null = null;

export async function getStripe(): Promise<Stripe | null> {
  const key = await getSetting(SETTING.STRIPE_SECRET_KEY);
  if (!key) return null;
  if (!cached || cached.key !== key) cached = { key, client: new Stripe(key) };
  return cached.client;
}

/** Every call site checks this first and returns a clear 503 rather than failing obscurely. */
export async function stripeConfigured(): Promise<boolean> {
  return Boolean(await getSetting(SETTING.STRIPE_SECRET_KEY));
}

export async function stripeWebhookSecret(): Promise<string | null> {
  return getSetting(SETTING.STRIPE_WEBHOOK_SECRET);
}

/** Confirms a key works — and says which mode it's in — before it is stored. */
export async function verifyStripeKey(key: string): Promise<{ livemode: boolean; account: string | null }> {
  const client = new Stripe(key);
  const account = await client.accounts.retrieve();
  return { livemode: !key.startsWith("sk_test_"), account: account.business_profile?.name ?? account.id };
}
