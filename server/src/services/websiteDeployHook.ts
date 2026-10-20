import type { Site } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { postWebsiteHook, resolveWebsiteAddress } from "../lib/websiteFetch.js";
import { WebsiteError } from "./website/site.js";

/**
 * A host's deploy hook: a secret URL that starts a build when it is POSTed to.
 *
 * Some hosts do not deploy on a push at all (a Netlify site whose repository
 * link was removed, a Hostinger site without auto-deploy, Render with
 * auto-deploy off). For those, detection says "needs a hook" and the customer
 * pastes the URL from their host once. Every publish then calls it.
 *
 * The URL is a credential (anyone holding it can start builds), so it is
 * encrypted at rest, never returned whole, and only ever called over https at a
 * public address. It is validated by shape so a typo fails on save rather than
 * on the next publish, and tested on save, because a URL that looks right and
 * answers 404 is the commonest way this goes wrong.
 */

export type HookProvider = "netlify" | "vercel" | "cloudflare-pages" | "render" | "custom";

const SHAPES: Array<{ provider: HookProvider; pattern: RegExp }> = [
  { provider: "netlify", pattern: /^https:\/\/api\.netlify\.com\/build_hooks\/[a-f0-9]{24}$/i },
  { provider: "vercel", pattern: /^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\/prj_[A-Za-z0-9]+\/[A-Za-z0-9]+$/ },
  { provider: "cloudflare-pages", pattern: /^https:\/\/api\.cloudflare\.com\/client\/v4\/pages\/webhooks\/deploy_hooks\/[a-f0-9-]{36}$/i },
  { provider: "render", pattern: /^https:\/\/api\.render\.com\/deploy\/srv-[a-z0-9]+\?key=[A-Za-z0-9_-]+$/ },
];

/** Which host a hook belongs to, or a reason it cannot be one. */
export function validateDeployHookUrl(value: string): { ok: true; provider: HookProvider } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: "That is not a web address." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "A deploy hook must start with https://." };
  if (url.username || url.password) return { ok: false, reason: "A deploy hook cannot carry a username or password." };
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) {
    return { ok: false, reason: "A deploy hook must be a public web address, not a local or numeric one." };
  }
  const shape = SHAPES.find((entry) => entry.pattern.test(url.href.replace(/\/$/, "")));
  if (shape) return { ok: true, provider: shape.provider };
  // A host we do not recognise by shape: allowed, but its hostname must at
  // least say whose it is, so nobody pastes a page address by mistake.
  if (/(netlify|vercel|cloudflare|render)\.com$/i.test(url.hostname)) {
    return { ok: false, reason: "That address is on a known host but is not the shape of its deploy hook. Copy the hook again from the host's settings." };
  }
  return { ok: true, provider: "custom" };
}

/** `https://api.netlify.com/build_hooks/…a1b2`: enough to recognise, not enough to use. */
export function maskHook(value: string): string {
  try {
    const url = new URL(value);
    const tail = (url.pathname + url.search).slice(-4);
    return `${url.origin}/…${tail}`;
  } catch {
    return "…";
  }
}

export function storedHook(site: Pick<Site, "deployHookSecret">): string | null {
  return site.deployHookSecret ? decryptSecret(site.deployHookSecret) : null;
}

/**
 * Calls a hook, trying twice more on a network error or a 5xx. A 4xx is the
 * host saying the hook is wrong, which a retry will not change.
 */
export async function callDeployHook(url: string, post: (url: string) => Promise<number> = postWebsiteHook, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<{ ok: true; status: number; attempts: number } | { ok: false; reason: string; attempts: number }> {
  let reason = "The deploy hook could not be reached.";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { ok: true, status: await post(url), attempts: attempt };
    } catch (error) {
      const status = (error as { status?: number }).status;
      reason = error instanceof Error ? error.message : reason;
      if (status && status >= 400 && status < 500) return { ok: false, reason, attempts: attempt };
      if (attempt < 3) await wait(attempt * 2_000);
    }
  }
  return { ok: false, reason, attempts: 3 };
}

/** Saves (or clears) a site's hook, after checking it and, if asked, calling it once. */
export async function saveDeployHook(siteId: string, value: string | null, options: { test: boolean }): Promise<{ provider: HookProvider | null; masked: string | null; tested: boolean }> {
  if (value === null || !value.trim()) {
    await prisma.site.update({ where: { id: siteId }, data: { deployHookSecret: null } });
    return { provider: null, masked: null, tested: false };
  }
  const url = value.trim();
  const valid = validateDeployHookUrl(url);
  if (!valid.ok) throw new WebsiteError(400, valid.reason);
  await resolveWebsiteAddress(new URL(url)).catch(() => {
    throw new WebsiteError(400, "That deploy hook's address does not lead to a public server.");
  });
  if (options.test) {
    const called = await callDeployHook(url);
    if (!called.ok) throw new WebsiteError(400, `The host did not accept the deploy hook: ${called.reason} Nothing was saved.`);
  }
  await prisma.site.update({ where: { id: siteId }, data: { deployHookSecret: encryptSecret(url) } });
  return { provider: valid.provider, masked: maskHook(url), tested: options.test };
}
