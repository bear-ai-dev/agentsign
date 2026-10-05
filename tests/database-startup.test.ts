import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseReadiness } from "../src/lib/databaseReadiness.js";

test("a failed authentication attempt does not poison later database requests", async () => {
  let attempts = 0;
  let clock = 0;
  const failure = new Error("authentication timeout");
  const ready = createDatabaseReadiness(async () => {
    if (++attempts === 1) throw failure;
  }, { now: () => clock, retryDelayMs: 1000 });
  await assert.rejects(Promise.resolve(ready), failure);
  await assert.rejects(Promise.resolve(ready), failure);
  assert.equal(attempts, 1);
  clock = 1000;
  await ready;
  await ready;
  assert.equal(attempts, 2);
});

test("concurrent cold requests share one initialization and successful readiness is cached", async () => {
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = createDatabaseReadiness(async () => { attempts++; await gate; });
  assert.equal(attempts, 0);
  const requests = Array.from({ length: 20 }, () => Promise.resolve(ready));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  release();
  await Promise.all(requests);
  await ready;
  assert.equal(attempts, 1);
});

test("repeated failures stay closed and the next retry is single-flight", async () => {
  let attempts = 0;
  let clock = 0;
  const ready = createDatabaseReadiness(async () => { attempts++; throw new Error("database unavailable"); }, { now: () => clock, retryDelayMs: 1000 });
  const first = await Promise.allSettled(Array.from({ length: 10 }, () => Promise.resolve(ready)));
  assert.ok(first.every(result => result.status === "rejected"));
  assert.equal(attempts, 1);
  clock = 1000;
  const second = await Promise.allSettled(Array.from({ length: 10 }, () => Promise.resolve(ready)));
  assert.ok(second.every(result => result.status === "rejected"));
  assert.equal(attempts, 2);
});

test("synchronous initialization failures are caught and can recover", async () => {
  let clock = 0;
  let attempts = 0;
  const ready = createDatabaseReadiness(() => {
    if (++attempts === 1) throw new Error("startup failed");
    return Promise.resolve();
  }, { now: () => clock, retryDelayMs: 1000 });
  await assert.rejects(Promise.resolve(ready), /startup failed/);
  clock = 1000;
  await ready;
  assert.equal(attempts, 2);
});
