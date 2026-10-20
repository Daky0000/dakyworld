/**
 * The publish router: how a site goes live, decided and done, with no database.
 *
 *   npx tsx checks/publishRouter.ts
 *
 * Detection, the host's progress, the failure and retry rule, which route gets
 * the credit, the deploy hook, both direct uploads against a recorded host, the
 * "Make updates instant" card and the signed connect state. Nothing here can leave the
 * machine: every outbound request is answered by a stub, and an unexpected one
 * fails the check.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.APP_SECRET ??= "publish-router-check-secret";
process.env.DATABASE_URL ??= "postgresql://checks:checks@127.0.0.1:1/checks";
process.env.GITHUB_TOKEN = "publish-router-check-token";
process.env.GITHUB_ALLOWED_REPOS = "fixture/site";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const detect = await import("../src/services/websiteDeployDetect.js");
const watch = await import("../src/services/websiteDeployWatch.js");
const { decideHostFailure } = await import("../src/services/websitePublishJobs.js");
const { settleRoutes, tryRoute } = await import("../src/services/websitePublishRouter.js");
const hooks = await import("../src/services/websiteDeployHook.js");
const netlify = await import("../src/services/publishRoutes/directNetlify.js");
const vercel = await import("../src/services/publishRoutes/directVercel.js");
const { hostFetch } = await import("../src/services/publishRoutes/hostApi.js");
const { matchCandidates } = await import("../src/services/publishRoutes/hostConnect.js");
const { instantOffer } = await import("../src/services/websiteDeployRoutes.js");
const { signState, readState } = await import("../src/lib/signedState.js");
const { pagesWorkflow } = await import("../src/services/publishRoutes/pagesActions.js");
const { websiteRequestAction, websiteGateHandlesDirectly } = await import("../src/services/websiteAccess.js");

type Evidence = import("../src/services/websiteDeployDetect.js").Evidence;
const decide = (evidence: Evidence[], extra: Partial<Parameters<typeof detect.decideProfile>[0]> = {}) =>
  detect.decideProfile({ evidence, repoBranch: "main", repoPath: "", missingAccess: [], ...extra });

/* ------------------------------------------------------------- detection */

equal("GitHub Pages building the branch publishing writes to deploys on its own",
  decide([{ kind: "headers", host: "github-pages", serves: true, detail: "" }], { pages: { buildType: "legacy", branch: "main", folder: "/", noJekyll: false, jekyllContent: false } }).answer, "auto");
const wrongBranch = decide([{ kind: "headers", host: "github-pages", serves: true, detail: "" }], { pages: { buildType: "legacy", branch: "gh-pages", folder: "/", noJekyll: false, jekyllContent: false } });
equal("GitHub Pages building another branch is caught before anybody publishes", wrongBranch.answer, "branch-mismatch");
equal("and says which branch", wrongBranch.deployBranch, "gh-pages");
equal("GitHub Pages serving /docs while pages live at the root is a mismatch too",
  decide([{ kind: "headers", host: "github-pages", serves: true, detail: "" }], { pages: { buildType: "legacy", branch: "main", folder: "/docs", noJekyll: false, jekyllContent: false } }).answer, "branch-mismatch");
equal("but not when the pages live in docs",
  decide([{ kind: "headers", host: "github-pages", serves: true, detail: "" }], { repoPath: "docs", pages: { buildType: "legacy", branch: "main", folder: "/docs", noJekyll: false, jekyllContent: false } }).answer, "auto");
equal("Vercel deploying recent commits on the branch is automatic",
  decide([{ kind: "headers", host: "vercel", serves: true, detail: "" }, { kind: "deployments", host: "vercel", deploys: true, branch: "main", detail: "" }]).answer, "auto");
equal("Vercel deploying only another branch to production is a mismatch",
  decide([{ kind: "headers", host: "vercel", serves: true, detail: "" }, { kind: "deployments", host: "vercel", deploys: true, branch: "production", detail: "" }]).answer, "branch-mismatch");
equal("the host that serves the page wins over a config file naming another",
  decide([{ kind: "headers", host: "netlify", serves: true, detail: "" }, { kind: "files", host: "vercel", detail: "" }]).host, "netlify");
equal("Hostinger with no trace of a deploy is not guessed at",
  decide([{ kind: "headers", host: "hostinger", serves: true, detail: "" }]).answer, "unsure");
equal("but a publish seen not to arrive makes it a hook",
  decide([{ kind: "headers", host: "hostinger", serves: true, detail: "" }, { kind: "observed", missed: true, detail: "" }]).answer, "needs-hook");
equal("and a publish seen to arrive makes it automatic",
  decide([{ kind: "headers", host: "hostinger", serves: true, detail: "" }, { kind: "observed", deploys: true, branch: "main", detail: "" }]).answer, "auto");
equal("Netlify leaving no records on commits GitHub let us read needs a hook",
  decide([{ kind: "headers", host: "netlify", serves: true, detail: "" }, { kind: "deployments", detail: "No deploys" }]).answer, "needs-hook");
equal("but not when GitHub refused the reads: then it is unsure",
  decide([{ kind: "headers", host: "netlify", serves: true, detail: "" }, { kind: "deployments", detail: "No deploys" }], { missingAccess: ["deployments"] }).answer, "unsure");
equal("nothing at all is unsure, not a guess", decide([]).answer, "unsure");

equal("a build script is a build step", detect.decideBuildStep({ files: ["package.json"], sourceKind: null, packageJson: '{"scripts":{"build":"vite build"}}', netlifyToml: null, vercelJson: null }), true);
equal("a netlify.toml command is a build step", detect.decideBuildStep({ files: ["netlify.toml"], sourceKind: null, packageJson: null, netlifyToml: '[build]\n  command = "npm run build"', vercelJson: null }), true);
equal("plain files are not", detect.decideBuildStep({ files: ["index.html"], sourceKind: null, packageJson: null, netlifyToml: '[build]\n  publish = "."', vercelJson: null }), false);
equal("a repository that could not be read is unknown, which rules out a direct upload", detect.decideBuildStep({ files: null, sourceKind: null, packageJson: null, netlifyToml: null, vercelJson: null }), null);

const deploysPages = detect.readWorkflow("on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - uses: actions/deploy-pages@v4\n");
equal("a workflow using the Pages deploy action deploys to GitHub Pages", deploysPages.host, "github-pages");
equal("on the branch it names", deploysPages.pushBranches, ["main"]);
equal("block-form branches are read too", detect.readWorkflow("on:\n  push:\n    branches:\n      - release\nsteps:\n  - run: npx wrangler pages deploy out\n").pushBranches, ["release"]);
equal("GitHub Pages' addresses are recognised", detect.hostFromDns([], ["185.199.110.153"]), "github-pages");
equal("and Vercel's CNAME", detect.hostFromDns(["cname.vercel-dns.com."], []), "vercel");
check("a preview deployment is not production", !detect.isProductionEnvironment("Preview") && detect.isProductionEnvironment("Production") && detect.isProductionEnvironment("github-pages"));
equal("a stored profile with junk in it is read safely", detect.deployProfileOf({ deployProfile: { host: "vercel", disabledRoutes: ["hook", "teleport", "bridge"] } } as never)?.disabledRoutes, ["hook"]);

/* ---------------------------------------------------- what the host is doing */

equal("a queued run is queued", watch.stageFromRun("queued", null), "queued");
equal("a failed run is failed", watch.stageFromRun("completed", "failure"), "failed");
equal("a cancelled run is not this commit failing", watch.stageFromRun("completed", "cancelled"), null);
equal("a deployment in progress is deploying", watch.stageFromDeploymentState("in_progress"), "deploying");
equal("an errored Pages build is failed", watch.stageFromPagesBuild("errored"), "failed");
equal("a retry building is reported over the failure it replaced",
  watch.combineProgress([{ stage: "failed", source: "a" }, { stage: "building", source: "b" }])?.stage, "building");
equal("live from any reporter wins", watch.combineProgress([{ stage: "failed", source: "a" }, { stage: "live", source: "b" }])?.stage, "live");
equal("nothing to say is nothing", watch.combineProgress([null, null]), null);

equal("a failed build while GitHub is down is waited out, never retried", decideHostFailure({ githubTrouble: true, canRetry: true, retried: false }), "wait");
equal("a failed Pages build is retried once", decideHostFailure({ githubTrouble: false, canRetry: true, retried: false }), "retry");
equal("and only once", decideHostFailure({ githubTrouble: false, canRetry: true, retried: true }), "fail");
equal("a host that cannot be asked again has failed", decideHostFailure({ githubTrouble: false, canRetry: false, retried: false }), "fail");

/* --------------------------------------------------------- the router */

const ok = (route: "direct" | "pages" | "hook") => ({ route, ok: true, ms: 1, detail: "", at: "" });
const bad = (route: "direct" | "pages" | "hook") => ({ route, ok: false, ms: 1, detail: "", at: "" });
equal("nothing faster means the host's own deploy", settleRoutes([]), { route: "follow", fallbackFrom: null });
equal("a direct upload takes the credit over the hook", settleRoutes([ok("direct"), ok("hook")]), { route: "direct", fallbackFrom: null });
equal("a failed direct upload falls back, and says so", settleRoutes([bad("direct")]), { route: "follow", fallbackFrom: "direct" });
equal("a failed direct upload with a working hook names both", settleRoutes([bad("direct"), ok("hook")]), { route: "hook", fallbackFrom: "direct" });
const slow = await tryRoute("direct", () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200)), 20);
check("a route that runs out of time is recorded as failed, not waited on", !slow.ok && /gave up/.test(slow.detail));
const thrown = await tryRoute("direct", async () => { throw new Error("token revoked"); });
equal("a route that throws never throws out of the router", [thrown.ok, thrown.detail], [false, "token revoked"]);

/* ------------------------------------------------------------- the hook */

equal("a Netlify build hook is recognised", hooks.validateDeployHookUrl("https://api.netlify.com/build_hooks/0123456789abcdef01234567"), { ok: true, provider: "netlify" });
equal("a Render deploy hook is recognised", hooks.validateDeployHookUrl("https://api.render.com/deploy/srv-abc123?key=Zx_9"), { ok: true, provider: "render" });
check("http is refused", !hooks.validateDeployHookUrl("http://api.netlify.com/build_hooks/0123456789abcdef01234567").ok);
check("a local address is refused", !hooks.validateDeployHookUrl("https://localhost/hook").ok);
check("a numeric address is refused", !hooks.validateDeployHookUrl("https://10.0.0.5/hook").ok);
check("a page on a known host that is not its hook shape is refused", !hooks.validateDeployHookUrl("https://app.netlify.com/sites/x/settings").ok);
check("a host we do not know is allowed", hooks.validateDeployHookUrl("https://deploy.example-host.io/trigger/abc").ok);
check("a saved hook is shown masked", hooks.maskHook("https://api.netlify.com/build_hooks/0123456789abcdef01234567") === "https://api.netlify.com/…4567");

const calls: number[] = [];
const flaky = async () => { calls.push(1); if (calls.length < 3) throw Object.assign(new Error("The deploy hook answered 502."), { status: 502 }); return 200; };
const retried = await hooks.callDeployHook("https://x", flaky, async () => undefined);
check("a hook that fails twice with a server error is tried a third time", retried.ok && retried.attempts === 3);
calls.length = 0;
const refused = await hooks.callDeployHook("https://x", async () => { calls.push(1); throw Object.assign(new Error("The deploy hook answered 404."), { status: 404 }); }, async () => undefined);
check("a hook the host says is wrong is not retried", !refused.ok && calls.length === 1);

/* ------------------------------------------ the direct uploads, recorded */

const page = Buffer.from("<h1>New words</h1>");
const digest = createHash("sha1").update(page).digest("hex");
equal("only the changed file's digest moves", netlify.nextFileMap({ "/index.html": "old", "/style.css": "css" }, [{ path: "index.html", content: page }]).files, { "/index.html": digest, "/style.css": "css" });
equal("repository paths map into Netlify's publish folder", netlify.servedFiles([{ path: "public/index.html", content: page }, { path: "README.md", content: page }], "public").map((file) => file.path), ["/index.html"]);
equal("with no publish folder, everything is served from the root", netlify.servedFiles([{ path: "about.html", content: page }], "").map((file) => file.path), ["/about.html"]);

type Recorded = { method: string; url: string; body?: string };
let recorded: Recorded[] = [];
const respond = (value: unknown, status = 200) => new Response(value === undefined ? "" : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function host(handler: (method: string, url: URL, body: string | undefined) => Response | undefined) {
  hostFetch.fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : undefined;
    recorded.push({ method, url: url.toString(), body });
    const answer = handler(method, url, body);
    if (!answer) throw new Error(`Unexpected host request ${method} ${url}`);
    return answer;
  }) as typeof fetch;
}

recorded = [];
host((method, url) => {
  if (method === "GET" && url.pathname === "/api/v1/sites/site-1") return respond({ id: "site-1", published_deploy: { id: "dep-0" }, build_settings: { cmd: "", dir: "" } });
  if (method === "GET" && url.pathname === "/api/v1/deploys/dep-0") return respond({ id: "dep-0", state: "ready", available_functions: [] });
  if (method === "GET" && url.pathname === "/api/v1/deploys/dep-0/files") return respond([{ path: "/index.html", sha: "old" }, { path: "/style.css", sha: "css" }]);
  if (method === "POST" && url.pathname === "/api/v1/sites/site-1/deploys") return respond({ id: "dep-1", state: "uploading", required: [digest] });
  if (method === "PUT" && url.pathname === "/api/v1/deploys/dep-1/files/index.html") return respond({});
  if (method === "GET" && url.pathname === "/api/v1/deploys/dep-1") return respond({ id: "dep-1", state: "ready", ssl_url: "https://example.netlify.app" });
  return undefined;
});
const netlifyResult = await netlify.deployToNetlify({ token: "t", siteId: "site-1", changed: [{ path: "index.html", content: page }], title: "DakyX publish" });
equal("Netlify gets exactly one upload for a one-page publish", netlifyResult.uploaded, 1);
const created = JSON.parse(recorded.find((entry) => entry.method === "POST")!.body!);
equal("and the deploy keeps every other file it already had", created.files, { "/index.html": digest, "/style.css": "css" });

host((method, url) => (method === "GET" && url.pathname === "/api/v1/sites/site-2" ? respond({ id: "site-2", published_deploy: { id: "d" }, build_settings: { cmd: "npm run build" } }) : undefined));
await assert.rejects(netlify.deployToNetlify({ token: "t", siteId: "site-2", changed: [{ path: "index.html", content: page }], title: "x" }), /builds this site/);
checks++;
host((method, url) => (method === "GET" && url.pathname === "/api/v1/sites/site-3" ? respond({ message: "Unauthorized" }, 401) : undefined));
const revoked = await netlify.deployToNetlify({ token: "t", siteId: "site-3", changed: [], title: "x" }).catch((error) => error);
check("a token Netlify stopped accepting is recognised as needing a reconnect", revoked.revoked === true);

// Vercel reads the repository tree from GitHub; GitHub is answered here too.
const originalFetch = globalThis.fetch;
const css = Buffer.from("body{color:red}");
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.github.com" && url.pathname === "/repos/fixture/site/git/trees/c0ffee") {
    return respond({ tree: [{ path: "index.html", type: "blob", sha: "git-index-2" }, { path: "style.css", type: "blob", sha: "git-css" }, { path: "node_modules/x.js", type: "blob", sha: "nm" }], truncated: false });
  }
  throw new Error(`Unexpected request ${url}`);
}) as typeof fetch;
recorded = [];
host((method, url, body) => {
  if (method === "GET" && url.pathname === "/v9/projects/prj_1") return respond({ id: "prj_1", name: "site", framework: null, buildCommand: null });
  if (method === "POST" && url.pathname === "/v2/files") return respond({});
  if (method === "POST" && url.pathname === "/v13/deployments") return respond({ id: "dpl_1", readyState: "READY", url: "site-abc.vercel.app", body });
  return undefined;
});
const vercelResult = await vercel.deployToVercel({
  token: "t", projectId: "prj_1", teamId: null, repo: "fixture/site", commitSha: "c0ffee",
  changed: [{ path: "index.html", content: page }],
  manifest: { "index.html": { git: "git-index-1", sha: "old", size: 3 }, "style.css": { git: "git-css", sha: createHash("sha1").update(css).digest("hex"), size: css.length } },
});
globalThis.fetch = originalFetch;
equal("Vercel gets only the file that changed", vercelResult.uploaded, 1);
const deployment = JSON.parse(recorded.find((entry) => entry.url.includes("/v13/deployments"))!.body!);
equal("and a production deployment of the whole tree, minus node_modules", deployment.files.map((file: { file: string }) => file.file).sort(), ["index.html", "style.css"]);
equal("as production", deployment.target, "production");
check("and the manifest now holds the new digest", vercelResult.manifest["index.html"]?.sha === digest);
check(".vercelignore folders are left out", vercel.ignoredBy(["drafts/", "*.psd"])("drafts/a.html") && vercel.ignoredBy(["*.psd"])("art/logo.psd") && !vercel.ignoredBy(["drafts"])("index.html"));

/* ------------------------------------------------------- connecting */

const site = { publicUrl: "https://www.example.com", customDomain: null, repoOwner: "fixture", repoName: "site" };
equal("a host site serving the domain is matched", matchCandidates(site, [{ id: "a", name: "a", url: null, domains: ["example.com"], repo: null }, { id: "b", name: "b", url: null, domains: ["other.com"], repo: null }]).map((entry) => entry.id), ["a"]);
equal("as is one linked to the repository", matchCandidates(site, [{ id: "c", name: "c", url: null, domains: [], repo: "https://github.com/fixture/site" }]).map((entry) => entry.id), ["c"]);

const state = signState({ site: "s1", user: "u1", provider: "netlify" });
equal("a connect state comes back to the person who started it", readState(state, "u1")?.site, "s1");
equal("and to nobody else", readState(state, "u2"), null);
equal("an edited state is refused", readState(state.replace(/.$/, (char) => (char === "A" ? "B" : "A")), "u1"), null);
equal("an expired state is refused", readState(signState({ site: "s1", user: "u1" }, Date.now() - 31 * 60_000), "u1"), null);

/* ---------------------------------------------- the "Make updates instant" card */

const profile = (over: Partial<import("../src/services/websiteDeployDetect.js").DeployProfile>) => ({ host: "unknown", answer: "auto", evidence: [], hasBuildStep: false, lastCheckedAt: "", missingAccess: [], routes: {}, disabledRoutes: [], ...over }) as import("../src/services/websiteDeployDetect.js").DeployProfile;
const everything = { netlify: true, vercel: true, pages: true };
const nothingOn = { direct: null, pages: false };
equal("Netlify with no build is offered Connect Netlify", instantOffer({ profile: profile({ host: "netlify" }), available: everything, active: nothingOn }).button, "Connect Netlify");
equal("Vercel with no build, Connect Vercel", instantOffer({ profile: profile({ host: "vercel" }), available: everything, active: nothingOn }).button, "Connect Vercel");
const built = instantOffer({ profile: profile({ host: "vercel", hasBuildStep: true, typicalSeconds: 42 }), available: everything, active: nothingOn });
equal("a site with a build step is told how long it takes, with no button", [built.kind, built.button, /about 42 seconds/.test(built.text ?? "")], ["build-step", null, true]);
equal("GitHub Pages is offered fast Pages", instantOffer({ profile: profile({ host: "github-pages" }), available: everything, active: nothingOn }).kind, "pages");
equal("but never for a Jekyll site", instantOffer({ profile: profile({ host: "github-pages", pages: { buildType: "legacy", noJekyll: false, jekyllContent: true } }), available: everything, active: nothingOn }).kind, null);
equal("Hostinger is offered nothing that would put DakyX in front of the site", instantOffer({ profile: profile({ host: "hostinger" }), available: everything, active: nothingOn }).kind, null);
equal("a route already on says so", instantOffer({ profile: profile({ host: "netlify" }), available: everything, active: { direct: "netlify", pages: false } }).active, true);
equal("nothing detected yet, nothing offered", instantOffer({ profile: null, available: everything, active: nothingOn }).kind, null);

/* ------------------------------------------------------------ Route P */

const workflow = pagesWorkflow("main", "/docs");
check("the Pages workflow deploys the folder as it is", /upload-pages-artifact@v3/.test(workflow) && /path: "docs"/.test(workflow) && /deploy-pages@v4/.test(workflow));
check("on pushes to the publishing branch only", /branches: \["main"\]/.test(workflow));
check("and the root when Pages serves the root", /path: "\."/.test(pagesWorkflow("main", "/")));
equal("and detection recognises it as a Pages deploy", detect.readWorkflow(workflow).host, "github-pages");

/* ----------------------------------------------------- who may do what */

equal("reading how a site goes live is for anybody on it", websiteRequestAction("GET", "/sites/s1/deploy"), "view");
equal("changing it is managing", websiteRequestAction("PUT", "/sites/s1/deploy/hook"), "manage");
equal("even reading a host account's site list is managing", websiteRequestAction("GET", "/sites/s1/connect/netlify/candidates"), "manage");
equal("the removed bridge routes are refused for everybody", websiteRequestAction("POST", "/sites/s1/bridge/check"), null);
check("the hosts' callbacks are account routes, checked in their handlers", websiteGateHandlesDirectly("GET", "/connect/netlify/callback") && websiteGateHandlesDirectly("GET", "/github-pages/callback") && !websiteGateHandlesDirectly("GET", "/bridge/connected"));
check("but not for a made-up host", !websiteGateHandlesDirectly("GET", "/connect/heroku/callback"));

console.log(`publishRouter: ${checks} checks — detection, the host's progress, retry once and never during an outage, routes that fall back, the deploy hook, both direct uploads against a recorded host, the instant card and signed connect state`);
