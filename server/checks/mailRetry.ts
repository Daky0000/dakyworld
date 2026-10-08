// sendMail retries a temporary refusal, never a permanent one, and records both.
// A fake SMTP server on localhost; the database is stubbed, so no row is written.
// Case A: the first connection gets a temporary 451 at MAIL FROM, the second is
// accepted — sendMail must succeed in two attempts. Case B: a permanent 550 —
// sendMail must give up after one attempt (no duplicate risk, no pointless wait).
import net from "node:net";

let connections = 0;
let mode: "temp-then-ok" | "permanent" = "temp-then-ok";
let delivered = 0;

const server = net.createServer((socket) => {
  connections += 1;
  const nth = connections;
  socket.write("220 fake ESMTP\r\n");
  let data = false;
  socket.on("data", (chunk) => {
    for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
      if (data) {
        if (line === ".") { data = false; delivered += 1; socket.write("250 2.0.0 Ok: queued\r\n"); }
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd === "AUTH") socket.write("235 2.7.0 ok\r\n");
      else if (cmd === "MAIL") {
        if (mode === "permanent") socket.write("550 5.7.1 refused\r\n");
        else if (nth === 1) socket.write("451 4.7.1 try again later\r\n");
        else socket.write("250 ok\r\n");
      } else if (cmd === "RCPT") socket.write("250 ok\r\n");
      else if (cmd === "DATA") { data = true; socket.write("354 go\r\n"); }
      else if (cmd === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
      else socket.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;
Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_SECURE: "false", SMTP_USER: "u@test.local", SMTP_PASSWORD: "p", MAIL_FROM_EMAIL: "u@test.local", MAIL_TRANSPORT: "SMTP" });

// No database here: settings answer from the environment, and the delivery
// rows are captured instead of written.
const { prisma } = await import("../src/lib/prisma.js");
const rows: Array<{ status: string; attempts: number; category: string | null }> = [];
const stub = (target: object, name: string, fn: unknown) => Object.defineProperty(target, name, { value: fn, configurable: true });
stub(prisma.appSetting, "findUnique", async () => null);
stub(prisma.appSetting, "findMany", async () => []);
stub(prisma.mailDelivery, "create", async ({ data }: { data: (typeof rows)[number] }) => { rows.push(data); return data; });
stub(prisma.mailDelivery, "deleteMany", async () => ({ count: 0 }));
const { sendMail } = await import("../src/lib/mailer.js");
const msg = { to: "someone@test.local", subject: "retry check", html: "<p>hi</p>", text: "hi", category: "test" };

let ok = true;
const started = Date.now();
await sendMail(msg).then(() => console.log(`A: sent after ${connections} connection(s), ${delivered} delivered, ${Date.now() - started}ms`)).catch((e) => { ok = false; console.log("A: FAILED", e.message); });
if (connections !== 2 || delivered !== 1) ok = false;

mode = "permanent"; connections = 0; delivered = 0;
await sendMail(msg).then(() => { ok = false; console.log("B: unexpectedly sent"); }).catch((e) => console.log(`B: refused after ${connections} connection(s): ${e.message.slice(0, 60)}`));
if (connections !== 1) ok = false;

console.log("delivery rows:", JSON.stringify(rows.map((r) => [r.status, r.attempts, r.category])));
if (JSON.stringify(rows.map((r) => [r.status, r.attempts])) !== JSON.stringify([["SENT", 2], ["FAILED", 1]])) ok = false;
server.close();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
