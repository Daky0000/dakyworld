import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { withWebsitePublishLock } from "../src/services/websitePublishing.js";

const id = randomUUID();
let unlock!: () => void;
let acquired!: () => void;
const held = new Promise<void>(resolve => { acquired = resolve; });
const release = new Promise<void>(resolve => { unlock = resolve; });
try {
  const first = withWebsitePublishLock(id, async () => { acquired(); await release; return "first"; });
  await held;
  try {
    await assert.rejects(withWebsitePublishLock(id, async () => "must not run"), (error: any) => error.status === 409);
    assert.equal(await withWebsitePublishLock(`${id}-other`, async () => "independent"), "independent");
  } finally { unlock(); }
  assert.equal(await first, "first");
  await assert.rejects(withWebsitePublishLock(id, async () => { throw new Error("failed commit"); }), /failed commit/);
  assert.equal(await withWebsitePublishLock(id, async () => "released"), "released");
  console.log("websitePublishing: concurrent publish refusal, independent pages and failure recovery passed");
} finally { unlock?.(); await prisma.$disconnect(); }
