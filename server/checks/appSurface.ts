import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { appSurface, editorPublicSurfaceGate } from "../src/middleware/appSurface.js";

let failures = 0;
function check(label: string, value: boolean) {
  if (value) console.log(`PASS ${label}`);
  else { console.error(`FAIL ${label}`); failures += 1; }
}

const original = process.env.APP_SURFACE;
process.env.APP_SURFACE = "editor";
check("editor surface parses", appSurface() === "editor");

function statusFor(path: string): number {
  let status = 200;
  let passed = false;
  const req = { path } as never;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as never;
  editorPublicSurfaceGate(req, res, () => { passed = true; });
  return passed ? 200 : status;
}

check("editor permits its product API", statusFor("/api/website/sites") === 200);
check("editor permits authentication", statusFor("/api/auth/session") === 200);
check("editor permits readiness", statusFor("/api/ready") === 200);
check("editor permits demos", statusFor("/api/demos") === 200);
check("editor conceals leads", statusFor("/api/leads") === 404);
check("editor conceals invoices", statusFor("/api/invoices") === 404);
check("editor conceals agents", statusFor("/api/agents") === 404);
check("editor conceals settings", statusFor("/api/settings") === 404);

process.env.APP_SURFACE = "app";
check("app surface parses", appSurface() === "app");
check("app permits products API", statusFor("/api/products") === 200);
check("app permits authentication", statusFor("/api/auth/session") === 200);
check("app conceals leads", statusFor("/api/leads") === 404);
check("app conceals invoices", statusFor("/api/invoices") === 404);
check("app conceals agents", statusFor("/api/agents") === 404);

process.env.APP_SURFACE = "invalid";
let invalidRejected = false;
try { appSurface(); } catch { invalidRejected = true; }
check("unknown surface fails closed", invalidRejected);

// Read from the request's own address, over real HTTP, with `trust proxy` on as
// in production — which is what makes Express's `req.hostname` come from
// `X-Forwarded-Host`. The caller writes both headers, so the narrowest surface
// either one names has to win: a forged header may take access away from the
// request carrying it, never add any.
delete process.env.APP_SURFACE;
const app = express();
app.set("trust proxy", 1);
app.use(editorPublicSurfaceGate);
app.use((req, res) => { res.json({ reached: req.path, surface: appSurface(req) }); });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;

function request(path: string, host: string, forwardedHost?: string) {
  return new Promise<{ status: number; surface?: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: host, ...(forwardedHost === undefined ? {} : { "X-Forwarded-Host": forwardedHost }) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let body: { surface?: string } = {};
        try { body = JSON.parse(text); } catch { /* a refusal body is not needed */ }
        resolve({ status: res.statusCode ?? 0, surface: body.surface });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

try {
  check("os.dakyx.com reaches the OS API", (await request("/api/leads", "os.dakyx.com")).status === 200);
  check("editor.dakyx.com conceals the OS API", (await request("/api/leads", "editor.dakyx.com")).status === 404);
  check("editor.dakyx.com with a port is still the editor", (await request("/api/leads", "editor.dakyx.com:443")).status === 404);
  check("editor.dakyx.com still reaches its own API", (await request("/api/website/sites", "editor.dakyx.com")).status === 200);
  check("a forged X-Forwarded-Host cannot turn the editor into the OS", (await request("/api/leads", "editor.dakyx.com", "os.dakyx.com")).status === 404);
  check("nor the account app into the OS", (await request("/api/invoices", "app.dakyx.com", "os.dakyx.com")).status === 404);
  check("nor the account app into the editor", (await request("/api/website/pages", "app.dakyx.com", "editor.dakyx.com")).status === 404);
  check("a forwarded editor host narrows a request that arrived on the OS host", (await request("/api/leads", "os.dakyx.com", "editor.dakyx.com")).status === 404);
  check("any entry in a forwarded list narrows it", (await request("/api/leads", "os.dakyx.com", "os.dakyx.com, editor.dakyx.com")).status === 404);
  check("a proxy that forwards the editor host from an internal one is still the editor", (await request("/api/leads", "dakyworld-api.railway.internal", "editor.dakyx.com")).status === 404);
  check("an agreeing forwarded host changes nothing", (await request("/api/leads", "os.dakyx.com", "os.dakyx.com")).status === 200);
  check("appSurface reports the narrowed surface, which is what X-DakyX-Surface carries", (await request("/api/auth/session", "editor.dakyx.com", "os.dakyx.com")).surface === "editor");
  process.env.APP_SURFACE = "os";
  check("APP_SURFACE still decides when it is set", (await request("/api/leads", "editor.dakyx.com")).status === 200);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

if (original === undefined) delete process.env.APP_SURFACE;
else process.env.APP_SURFACE = original;
process.exit(failures ? 1 : 0);
