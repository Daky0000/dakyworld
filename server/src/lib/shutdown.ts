import type { Server } from "node:http";

/** Stop new requests immediately, drain existing work, then disconnect shared resources. */
export function installShutdown(options: {
  server: Server;
  stop: () => Promise<unknown> | unknown;
  drain: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  timeoutMs?: number;
}) {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: draining requests and background work.`);
    const deadline = setTimeout(() => process.exit(1), options.timeoutMs ?? 25_000);
    deadline.unref();
    const closed = new Promise<void>(resolve => options.server.close(() => resolve()));
    options.server.closeIdleConnections();
    const results = await Promise.allSettled([closed, Promise.resolve().then(options.stop), Promise.resolve().then(options.drain)]);
    let failed = results.some(result => result.status === "rejected");
    try { await options.disconnect(); } catch { failed = true; }
    process.exit(failed ? 1 : 0);
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
}
