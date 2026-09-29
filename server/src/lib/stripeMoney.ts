/** Stripe charge amounts use minor units, including its documented currency exceptions. */
const zeroDecimal = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"]);
const threeDecimal = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
export function stripeMinorAmount(amount: number, currency: string): number {
  const code = currency.toUpperCase();
  const factor = zeroDecimal.has(code) ? 1 : threeDecimal.has(code) ? 1000 : 100;
  const scaled = amount * factor;
  const minor = Math.round(scaled);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(minor) || Math.abs(scaled - minor) > 0.000001
    || (["ISK", "UGX"].includes(code) && factor === 100 && minor % 100 !== 0)
    || (threeDecimal.has(code) && minor % 10 !== 0)) throw new Error("The invoice amount is not valid for this Stripe currency.");
  return minor;
}
