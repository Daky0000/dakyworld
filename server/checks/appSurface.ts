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

if (original === undefined) delete process.env.APP_SURFACE;
else process.env.APP_SURFACE = original;
process.exit(failures ? 1 : 0);
