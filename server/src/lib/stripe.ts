import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;

// Stripe client is only created when a real key is present. Every call site
// must check `stripeEnabled` first and return a clear error otherwise —
// this integration is fully wired but inactive until real keys are added.
export const stripeEnabled = Boolean(key);
export const stripe = key ? new Stripe(key) : null;
