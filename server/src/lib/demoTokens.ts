import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Secret key used to sign demo visit tracking tokens.
 * Falls back to session secret, JWT secret, or a deterministic fallback.
 */
function getSigningSecret(): string {
  return (
    process.env.DEMO_TRACKING_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.JWT_SECRET ||
    "dakyworld-demo-analytics-visit-token-20260929"
  );
}

export interface VisitTokenPayload {
  v: string; // visitId
  d: string; // demoId
  s: string; // slug
  i: number; // issuedAt (timestamp ms)
  e: number; // expiresAt (timestamp ms)
}

export interface TokenVerificationResult {
  valid: boolean;
  visitId?: string;
  demoId?: string;
  slug?: string;
  expired?: boolean;
  error?: string;
}

/**
 * Creates a signed, tamper-proof, expiring token for a specific demo visit.
 *
 * Scoped strictly to the demo ID, slug, and the server-issued visit ID.
 * Default TTL is 24 hours.
 */
export function createVisitToken(
  params: {
    visitId: string;
    demoId: string;
    slug: string;
    issuedAt?: number;
    expiresAt?: number;
  },
  secret = getSigningSecret(),
): string {
  const now = params.issuedAt ?? Date.now();
  const ttlMs = 24 * 60 * 60 * 1000; // 24 hours
  const expiresAt = params.expiresAt ?? now + ttlMs;

  const payload: VisitTokenPayload = {
    v: params.visitId,
    d: params.demoId,
    s: params.slug,
    i: now,
    e: expiresAt,
  };

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");

  return `${payloadB64}.${signature}`;
}

/**
 * Verifies a visit token's signature, expiration, and expected scoping.
 */
export function verifyVisitToken(
  token: string | null | undefined,
  expected?: {
    demoId?: string;
    slug?: string;
    visitId?: string;
  },
  secret = getSigningSecret(),
): TokenVerificationResult {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Missing token" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 2) {
    return { valid: false, error: "Malformed token format" };
  }

  const [payloadB64, sig] = parts as [string, string];

  // Verify HMAC signature in constant time
  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: "Invalid signature" };
  }

  let payload: VisitTokenPayload;
  try {
    const jsonStr = Buffer.from(payloadB64, "base64url").toString("utf8");
    payload = JSON.parse(jsonStr);
  } catch {
    return { valid: false, error: "Invalid payload encoding" };
  }

  const now = Date.now();
  if (payload.e && now > payload.e) {
    return { valid: false, expired: true, error: "Token expired" };
  }

  if (expected?.demoId && payload.d !== expected.demoId) {
    return { valid: false, error: "Token demo mismatch" };
  }

  if (expected?.slug && payload.s !== expected.slug) {
    return { valid: false, error: "Token slug mismatch" };
  }

  if (expected?.visitId && payload.v !== expected.visitId) {
    return { valid: false, error: "Token visit mismatch" };
  }

  return {
    valid: true,
    visitId: payload.v,
    demoId: payload.d,
    slug: payload.s,
  };
}
