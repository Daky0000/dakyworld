/**
 * The wording Dakyworld ships for each writing job, fetched on demand.
 *
 * The API needs this so the Agents screen can show a brief *before* anybody has
 * edited it — an editor that opens empty and silently replaces a doctrine the
 * moment you type into it is the same lie this whole module exists to end. The
 * founder has to be able to read what is running now, edit that text, and save
 * it. So the screen is seeded with exactly the string the model would have got.
 *
 * **Loaded by dynamic import, deliberately.** Half of these live in files that
 * already import the brief resolver — `emailDrafter` calls `writerSystem`, and
 * `catalogue.ts` imports it too while `runner.ts` imports `catalogue.ts`. A
 * static import here would close that ring and leave one of the two modules
 * half-initialised at boot, which shows up as an undefined constant in a prompt
 * rather than as an error. Importing inside the function defers all of it to
 * the first request, by which time every module is built.
 */

/**
 * One loader per job. The registry says which *file* owns a job; this says
 * which *export* in it holds the words, which is the part a path cannot tell
 * you.
 */
const LOADERS: Record<string, () => Promise<string>> = {
  "email.cold": async () => (await import("../../lib/emailDrafter.js")).shippedDoctrineFor("email.cold"),
  "email.followup": async () => (await import("../../lib/emailDrafter.js")).shippedDoctrineFor("email.followup"),
  "email.billing": async () => (await import("../../lib/emailDrafter.js")).shippedDoctrineFor("email.billing"),
  "email.client": async () => (await import("../../lib/emailDrafter.js")).shippedDoctrineFor("email.client"),
  "message.phone": async () => (await import("../../lib/messageDrafter.js")).SHIPPED_DOCTRINE,
  proposal: async () => (await import("../../lib/proposalWriter.js")).SHIPPED_DOCTRINE,
  "audit.ux": async () => (await import("../audit/ux.js")).SHIPPED_DOCTRINE,
  "audit.speed": async () => (await import("../audit/performance.js")).SHIPPED_DOCTRINE,
  "audit.content": async () => (await import("../audit/content.js")).SHIPPED_DOCTRINE,
  "audit.synthesis": async () => (await import("../audit/synthesis.js")).SHIPPED_DOCTRINE,
  "content.draft": async () => (await import("../tools/catalogue.js")).CONTENT_DRAFT_DOCTRINE,
  "content.plain": async () => (await import("../tools/catalogue.js")).CONTENT_PLAIN_DOCTRINE,
  "demo.page": async () => (await import("../demoBuilder.js")).SHIPPED_DOCTRINE,
  "lead.research": async () => (await import("../leadResearch.js")).SHIPPED_DOCTRINE,
  "homepage.look": async () => (await import("../homepageLook.js")).SHIPPED_DOCTRINE,
  "mail.triage": async () => (await import("../mailbox/triage.js")).SHIPPED_DOCTRINE,
};

/** The shipped wording for a job, or empty when nothing claims it. */
export async function shippedDoctrine(jobKey: string): Promise<string> {
  const load = LOADERS[jobKey];
  if (!load) return "";
  try {
    return (await load()) ?? "";
  } catch (err) {
    console.warn(`[writers] could not read the shipped wording for ${jobKey}: ${(err as Error).message}`);
    return "";
  }
}

/** Which jobs have a loader — used by the harness to catch a job nobody wired. */
export function jobsWithShippedWording(): string[] {
  return Object.keys(LOADERS);
}
