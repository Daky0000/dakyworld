import assert from "node:assert/strict";
import { createCache, type CacheBackend } from "../src/lib/cache.js";

let stored: string | null = null;
const backend: CacheBackend = {
  async generation() { return "generation"; },
  async get() { return stored; },
  async put(_key, _generationKey, _generation, value) { stored = value; },
  async invalidate() { stored = null; },
};
const cache = createCache(backend, true);
const key = { scope: "test", resource: "resilience", identity: "value" };
const policy = { ttlMs: 1000 };

const circular: { self?: unknown } = {};
circular.self = circular;
for (const value of [circular, 1n, { toJSON() { throw new Error("cannot serialize"); } }]) {
  assert.equal(await cache.getOrLoad(key, policy, async () => value), value,
    "serialization failure preserves the source result");
  assert.equal(stored, null, "failed serialization does not write an entry");
}

for (const raw of ["null", "{", JSON.stringify({ version: 1, expiresAt: Date.now() + 60_000 })]) {
  stored = raw;
  assert.equal(await cache.getOrLoad(key, policy, async () => "fresh"), "fresh",
    "invalid envelopes fall back to the source");
}

stored = null;
await cache.getOrLoad(key, policy, async () => null);
assert.equal(await cache.getOrLoad(key, { ...policy, cacheNull: false }, async () => "found"), "found",
  "a caller rejecting null entries must also reject existing cached nulls");

stored = null;
assert.equal(await cache.getOrLoad(key, policy, async () => undefined), undefined);
assert.equal(stored, null, "undefined cannot produce an envelope without a value");

const failure = new Error("source unavailable");
await assert.rejects(cache.getOrLoad(key, policy, async () => { throw failure; }), error => error === failure);
assert.equal(await cache.getOrLoad(key, policy, async () => "recovered"), "recovered",
  "source failures clear the in-flight entry and release capacity");
assert.equal(await cache.getOrLoad(key, policy, async () => { throw failure; }), "recovered",
  "valid entries still avoid loading the source");
console.log("Cache serialization, corrupt-entry, null-policy, and recovery checks passed.");
