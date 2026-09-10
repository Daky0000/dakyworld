/**
 * Creates the Dakyworld GitHub App, in one click.
 *
 *   node scripts/createGithubApp.mjs [--org dakyworld] [--port 8765]
 *
 * A GitHub App cannot be created from an access token — GitHub allows it only
 * through the web UI or through this, the App Manifest flow, which is the same
 * thing with the form filled in already. So the whole configuration lives here
 * rather than in a page of instructions somebody follows by hand: the
 * permissions, the events, the webhook address. The person signed in to GitHub
 * presses one button and sees exactly what they are agreeing to.
 *
 * What comes back is the app's id, its slug, a private key and a webhook secret.
 * The private key authenticates the app across every installation, so it is
 * written to a file this script prints and never to the repository, and the next
 * step puts it into the deployment's own secrets.
 *
 * See docs/github-app.md for what it is all for.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const org = flag("org", "dakyworld");
const port = Number(flag("port", "8765"));
const webhookUrl = flag("webhook", "https://os.dakyworld.com/api/github/webhook");
const out = resolve(flag("out", "../.github-app.json"));
const state = randomBytes(16).toString("hex");

/**
 * The app, described once.
 *
 * The permissions are the minimum the Website Builder actually uses and no more:
 * read the repository's metadata, read and write its files, and open a pull
 * request where publishing by review is wanted. Administration, Issues and
 * Actions are deliberately absent — an editor that can change a repository's
 * settings is a different and much larger promise.
 *
 * **No events are subscribed to, and that is correct.** The two this system
 * actually listens for — `installation` and `installation_repositories` — are
 * app lifecycle events that GitHub delivers to every app's webhook on its own;
 * they are not in the subscribable list, and asking for them makes the manifest
 * invalid ("Default events unsupported"). Nothing else is wanted: the editor
 * reads a file when it needs one, so a webhook for every commit anybody makes
 * would be noise this system has nothing to do with.
 */
const manifest = {
  name: "Dakyworld Website Editor",
  url: "https://dakyworld.com",
  hook_attributes: { url: webhookUrl, active: true },
  redirect_url: `http://127.0.0.1:${port}/callback`,
  // Installable by anyone, because the customers who install it are not members
  // of this organisation. It does not make the source public — see the note in
  // docs/github-app.md.
  public: true,
  default_permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  description:
    "Lets Dakyworld edit and publish the pages of this website through the Dakyworld Website Builder. It reads and writes the repository files you choose, and nothing else.",
};

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Create the Dakyworld GitHub App</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; background: #F4F5F0; color: #08101F; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { max-width: 34rem; background: #fff; padding: 2rem; border-radius: 1rem; border: 1px solid #DFE4EB; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  p { color: #69758A; margin: .5rem 0; }
  button { margin-top: 1rem; background: #08101F; color: #fff; border: 0; border-radius: .75rem; padding: .7rem 1.1rem; font-size: .9rem; font-weight: 600; cursor: pointer; }
  code { font-size: .8rem; background: #F5F6F8; padding: .1rem .3rem; border-radius: .25rem; }
</style></head>
<body><main>
  <h1>Create the Dakyworld Website Editor app</h1>
  <p>This creates a GitHub App owned by the <strong>${org}</strong> organisation, with these permissions and nothing else:</p>
  <p><code>Metadata: read</code> · <code>Contents: read &amp; write</code> · <code>Pull requests: read &amp; write</code></p>
  <p>Webhook: <code>${webhookUrl}</code> — it receives installation changes, which GitHub sends to every app automatically.</p>
  <p>GitHub will show you the same list before it creates anything.</p>
  <form action="https://github.com/organizations/${org}/settings/apps/new?state=${state}" method="post">
    <input type="hidden" name="manifest" id="manifest">
    <button type="submit">Continue to GitHub</button>
  </form>
  <script>document.getElementById("manifest").value = ${JSON.stringify(JSON.stringify(manifest))};</script>
</main></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
    return;
  }

  if (url.pathname !== "/callback") {
    res.writeHead(404).end("Not here.");
    return;
  }

  const code = url.searchParams.get("code");
  // The state is checked because this server is listening on a machine the
  // person is browsing on: without it, any page they visit could hand this
  // endpoint a code and have the result written to disk.
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end("<h1>That did not come from the form this script served. Nothing was saved.</h1>");
    return;
  }

  try {
    const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "dakyworld-os", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub refused the conversion: ${response.status} ${await response.text()}`);
    const app = await response.json();

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          id: String(app.id),
          slug: app.slug,
          name: app.name,
          owner: app.owner?.login,
          htmlUrl: app.html_url,
          privateKey: app.pem,
          webhookSecret: app.webhook_secret,
          clientId: app.client_id,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      `<!doctype html><meta charset="utf-8"><body style="font:15px/1.6 system-ui;background:#F4F5F0;color:#08101F;display:grid;place-items:center;min-height:100vh;margin:0">
       <main style="max-width:34rem;background:#fff;padding:2rem;border-radius:1rem;border:1px solid #DFE4EB">
       <h1 style="font-size:1.15rem;margin:0 0 .5rem">${app.name} created</h1>
       <p style="color:#69758A">App ID ${app.id} · <a href="${app.html_url}">${app.html_url}</a></p>
       <p style="color:#69758A">Its key and webhook secret were written to the file the terminal names. You can close this tab.</p>
       </main></body>`,
    );

    console.log(`\n  ✓ ${app.name} created — app id ${app.id}, slug ${app.slug}`);
    console.log(`  ✓ Key and webhook secret written to ${out} (not in the repository)`);
    console.log(`  → ${app.html_url}\n`);
    setTimeout(() => server.close(() => process.exit(0)), 250);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    console.error(`\n  ✗ ${error}\n`);
    setTimeout(() => server.close(() => process.exit(1)), 250);
  }
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`\n  Open ${url} and press the button.`);
  console.log(`  You must be signed in to GitHub as an owner of the "${org}" organisation.\n`);
  // Opening it is a convenience; the address above works if this does nothing.
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
});
