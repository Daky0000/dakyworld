import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "./prisma.js";
import { assertPublicationOwnership } from "./publicationLease.js";

type Context = { jobId: string; leaseOwner: string; authorize: () => Promise<unknown>; pendingActions?: number; completedAction?: boolean };
const storage = new AsyncLocalStorage<Context>();
export const currentWebsiteWork = () => storage.getStore();
export function withWebsiteWork<T>(context: Context, work: () => Promise<T>): Promise<T> {
  return storage.run(context, work);
}
export class WorkCancelledError extends Error {
  constructor() { super("This work was cancelled before the next external action."); }
}
export class UncertainExternalError extends Error {
  constructor() { super("The provider outcome is uncertain. Your manager must check provider records before retrying this work."); }
}
/** Persist uncertainty before an external request; a crash must never make it look unattempted. */
export async function beforeWebsiteExternalAction() {
  await assertPublicationOwnership();
  const context = storage.getStore();
  if (!context) return;
  await context.authorize();
  const job = await prisma.websiteWorkJob.updateMany({
    where: { id: context.jobId, leaseOwner: context.leaseOwner, leaseUntil: { gt: new Date() }, state: "RUNNING", cancelRequested: false },
    data: { externalStartedAt: new Date() },
  });
  if (!job.count) throw new WorkCancelledError();
  context.pendingActions = (context.pendingActions ?? 0) + 1;
}
/** A received rejection is known; a disconnected or timed-out request remains uncertain. */
export async function confirmWebsiteProviderResponse(executed: boolean) {
  const context = storage.getStore();
  if (!context) return;
  context.pendingActions = Math.max(0, (context.pendingActions ?? 1) - 1);
  if (executed) context.completedAction = true;
  if (!context.pendingActions && !context.completedAction) await prisma.websiteWorkJob.updateMany({
    where: { id: context.jobId, leaseOwner: context.leaseOwner, state: "RUNNING" }, data: { externalStartedAt: null },
  });
}
