import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * The websites the actor is tested against.
 *
 * Local rather than real, and that is the point: a test that photographs
 * example.com proves the internet was up. These pages are the shapes that have
 * actually broken a screenshot — a page longer than any model will read, one
 * that never finishes loading, one that redirects, one narrower than the width
 * we resize to — and each of them behaves the same way on every run.
 */

const page = (title: string, body: string, extra = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f5f0;color:#08101f}${extra}</style>
</head><body>${body}</body></html>`;

export interface Fixtures {
  origin: string;
  /**
   * The same pages over HTTPS with a certificate nothing trusts — or null when
   * this machine has no `openssl` to make one with.
   *
   * A self-signed certificate is exactly the case the audit exists to report:
   * a prospect whose certificate has expired has a site every visitor reaches
   * by clicking *Advanced → Continue to site*, and until Sep 2026 the report
   * could read that page and show no picture of it.
   *
   * **Generated into a temp directory at test time and deleted afterwards.** A
   * key and certificate committed to the repository would be a private key in
   * git, which the repository's own secret scan is there to refuse — correctly,
   * because "it is only a test key" is what every leaked key's commit message
   * says.
   */
  secureOrigin: string | null;
  close(): Promise<void>;
}

/** A throwaway self-signed certificate for 127.0.0.1, or null if openssl is absent. */
function selfSigned(): { key: string; cert: string; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "dakyshot-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(dir, "key.pem"),
        "-out", join(dir, "cert.pem"),
        "-days", "1",
        "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "key.pem"), "utf-8"), cert: readFileSync(join(dir, "cert.pem"), "utf-8"), dir };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

export async function startFixtures(): Promise<Fixtures> {
  /** Held open so `/slow` can be released at teardown instead of leaking a socket. */
  const hanging = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/ok") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page("A short page", `<header style="height:300px;background:#3157ff;color:#fff"><h1>Adom Dental</h1></header><p>Kumasi</p>`));
    }

    // Twelve thousand pixels, which is roughly a real small-business homepage
    // with a gallery on it and past what any vision model will accept.
    if (path === "/tall") {
      const blocks = Array.from({ length: 60 }, (_, i) => `<section style="height:200px;background:hsl(${i * 6} 40% ${70 + (i % 3) * 5}%)">Row ${i}</section>`).join("");
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(page("A very long page", blocks));
    }

    if (path === "/redirect") {
      res.writeHead(302, { Location: "/ok" });
      return res.end();
    }

    // Headers sent, body never finished: "load" never fires and the page
    // timeout is the only thing that ends it.
    if (path === "/slow") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<!doctype html><html><body><p>still loading</p><img src=\"/never\">");
      hanging.add(res);
      return;
    }
    if (path === "/never") {
      hanging.add(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(page("Not found", "<h1>404</h1>"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // The same handler over TLS, behind a certificate no browser will accept.
  const certificate = selfSigned();
  let secure: https.Server | null = null;
  let securePort = 0;
  if (certificate) {
    secure = https.createServer({ key: certificate.key, cert: certificate.cert }, server.listeners("request")[0] as http.RequestListener);
    await new Promise<void>((resolve) => secure!.listen(0, "127.0.0.1", resolve));
    securePort = (secure.address() as AddressInfo).port;
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    secureOrigin: secure ? `https://127.0.0.1:${securePort}` : null,
    close: async () => {
      for (const res of hanging) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (secure) await new Promise<void>((resolve) => secure!.close(() => resolve()));
      if (certificate) rmSync(certificate.dir, { recursive: true, force: true });
    },
  };
}
