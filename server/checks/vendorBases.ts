/**
 * Every vendor this app talks to can be pointed somewhere else.
 *
 * This is how the whole model layer is exercised with no keys — point
 * `ANTHROPIC_BASE_URL` and friends at one local stub and the *real* adapters
 * run against a fake vendor. The non-model integrations had no such door:
 * Apify and Slack held their roots in module constants, so the only way to
 * exercise a capture or a card was a real token and a real workspace.
 *
 * A `DEV_MODE` that made `toolReadiness()` return mock results was the other
 * option and is the wrong one. Readiness answering "yes" when nothing is
 * connected means an agent calls `email.send`, receives a fake success and
 * reports the letter as sent — precisely the failure `readiness.ts` says it
 * exists to prevent. Pointing the vendor elsewhere keeps the real code path
 * and the real refusals; only the far end changes.
 *
 * **The assertion is what went over the wire**, not what a getter returned. A
 * correct base function that some call site does not use is exactly the defect
 * this pattern was written for: `BASE` in `models/call.ts` was captured at
 * import while `openRouterBase()` read per call, so a harness repointing a
 * vendor between scenarios got a frozen address in one half and a live one in
 * the other — green, testing nothing, and on a machine with a real key,
 * spending money.
 *
 * No database, no key, no network beyond localhost.
 */
import express from "express";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const PORT = 4597;
const seen: { path: string; auth: string | null }[] = [];

const app = express();
app.use(express.json());
// Apify: an actor run, and the account's usage.
app.get("/v2/acts/:actor", (req, res) => {
  seen.push({ path: req.path, auth: req.headers.authorization ?? null });
  res.json({ data: { id: "stub", defaultRunOptions: { memoryMbytes: 1024 }, pricingInfos: [] } });
});
// Slack.
app.post("/api/chat.postMessage", (req, res) => {
  seen.push({ path: req.path, auth: req.headers.authorization ?? null });
  res.json({ ok: true, channel: "C1", ts: "1.2" });
});
const server = app.listen(PORT, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));

const root = `http://127.0.0.1:${PORT}`;
process.env.APIFY_BASE_URL = `${root}/v2`;
process.env.SLACK_BASE_URL = `${root}/api`;

console.log("\nApify");
{
  // Imported *after* the variable is set, and it would still work if it were
  // not — which is the point. A module constant would have frozen the real
  // address at import and this would silently reach api.apify.com.
  const { getActor } = await import("../src/lib/apify.js");

  // No token, no request. The client refuses before it reaches the wire, and
  // pointing the vendor elsewhere must not change that — a stub is a different
  // far end, not a way past the credential check.
  try {
    await getActor("some~actor");
  } catch (err) {
    void err;
  }
  check("with no token it refuses before calling anything", seen.length === 0, seen.map((e) => e.path).join(", "));

  // The env token overrides the stored one, which is what makes a harness
  // possible without writing a credential into the database.
  process.env.APIFY_TOKEN = "stub-token";
  // The settings cache remembers the miss from the call above, and it is
  // per-process — the same reason `writers/brief.ts` reads its override with a
  // direct query rather than through `getSetting`.
  const settings = await import("../src/lib/settings.js");
  settings.clearSettingsCache();
  try {
    await getActor("some~actor");
  } catch (err) {
    // A stub answering the wrong shape is fine; reaching it is the claim.
    void err;
  }
  const hit = seen.find((entry) => entry.path.startsWith("/v2/acts/"));
  check("a request goes to the stub, not to api.apify.com", Boolean(hit), seen.map((e) => e.path).join(", ") || "nothing arrived");
  check("and it carries the credential the real path would", hit?.auth?.includes("stub-token") === true, `${hit?.auth}`);
  delete process.env.APIFY_TOKEN;
}

console.log("\nSlack");
{
  const { sendSlackBlocks } = await import("../src/lib/slack.js");
  const { setSetting, clearSettingsCache } = await import("../src/lib/settings.js");
  await setSetting("slack.botToken", "xoxb-stub", { secret: true });
  await setSetting("slack.defaultChannel", "#stub");
  clearSettingsCache();

  try {
    await sendSlackBlocks({ text: "hello", blocks: [] });
  } catch (err) {
    void err;
  }
  const hit = seen.find((entry) => entry.path === "/api/chat.postMessage");
  check("a card goes to the stub, not to slack.com", Boolean(hit), seen.map((e) => e.path).join(", ") || "nothing arrived");
  check("and it still sends the credential the real path would", hit?.auth?.includes("xoxb-stub") === true, `${hit?.auth}`);

  const { prisma } = await import("../src/lib/prisma.js");
  await prisma.appSetting.deleteMany({ where: { key: { in: ["slack.botToken", "slack.defaultChannel"] } } });
  clearSettingsCache();
  await prisma.$disconnect();
}

console.log("\nWhat the override does not do");
{
  // Readiness is untouched, deliberately. Pointing a vendor at a stub must not
  // make a tool claim to be configured — an agent that receives a fake success
  // for `email.send` reports a letter as sent, which is the failure the whole
  // readiness layer exists to prevent.
  const { clearReadinessCache, toolReadiness } = await import("../src/services/tools/readiness.js");
  clearReadinessCache();
  const email = await toolReadiness("email");
  check("pointing a vendor elsewhere does not fake readiness", !email.ready, `${email.reason}`);
  check("and the refusal still says where the credential goes", email.reason?.includes("Settings") === true, `${email.reason}`);
}

server.close();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nEvery vendor can be pointed at a stub, and readiness still tells the truth.`);
process.exitCode = bad ? 1 : 0;
