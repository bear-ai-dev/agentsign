import assert from "node:assert/strict";
import test from "node:test";
import { retryFixture } from "./helpers/webhook-retry-module.js";

test("a due-query database outage is logged without rejecting the interval callback", async () => {
  const { state, webhooks } = retryFixture();
  state.dueError = new Error("local database temporarily unavailable");
  webhooks.startWebhookRetryWorker();
  await assert.doesNotReject(async () => { await state.callbacks[0](); });
  assert.equal(state.deliveredPosts, 0);
  assert.ok(JSON.stringify(state.errors).includes("local database temporarily unavailable") || state.errors.some(values => values.some(value => value === state.dueError)));
});

test("an already delivered webhook is not posted or assigned a new attempt", async () => {
  const { state, webhooks } = retryFixture();
  state.delivery.delivered_at = "2026-01-01T01:00:00.000Z";
  state.delivery.next_retry_at = null;
  state.delivery.attempts = 2;
  await webhooks.deliverWebhook(state.delivery.id);
  assert.equal(state.deliveredPosts, 0);
  assert.equal(state.delivery.attempts, 2);
  assert.equal(state.delivery.delivered_at, "2026-01-01T01:00:00.000Z");
});

test("simultaneous in-process retries share one delivery and preserve the completed receipt", async () => {
  const { state, webhooks } = retryFixture();
  let finish: (status: number) => void = () => { throw new Error("delivery has not started"); };
  const posting = new Promise<number>(resolve => { finish = resolve; });
  state.post = () => posting;
  const first = webhooks.deliverWebhook(state.delivery.id);
  const second = webhooks.deliverWebhook(state.delivery.id);
  await new Promise<void>(resolve => setImmediate(resolve));
  const posts = state.deliveredPosts;
  finish(204);
  await Promise.all([first, second]);
  assert.equal(posts, 1);
  assert.equal(state.delivery.attempts, 1);
  assert.ok(state.delivery.delivered_at);
  assert.equal(state.delivery.next_retry_at, null);
});

test("a failed delivery remains retryable and a later success clears the error", async () => {
  const { state, webhooks } = retryFixture();
  state.post = async () => 503;
  await webhooks.deliverWebhook(state.delivery.id);
  assert.equal(state.delivery.attempts, 1);
  assert.equal(state.delivery.delivered_at, null);
  assert.equal(state.delivery.error, "HTTP 503");
  assert.ok(state.delivery.next_retry_at);
  state.post = async () => 204;
  await webhooks.deliverWebhook(state.delivery.id);
  assert.equal(state.delivery.attempts, 2);
  assert.ok(state.delivery.delivered_at);
  assert.equal(state.delivery.next_retry_at, null);
  assert.equal(state.delivery.error, null);
});

test("a failed scheduled lookup is logged and does not strand the next delivery attempt", async () => {
  const { state, webhooks } = retryFixture();
  state.lookupError = new Error("delivery lookup unavailable");
  webhooks.startWebhookRetryWorker();
  await state.callbacks[0]();
  assert.ok(state.errors.some(values => values.includes(state.lookupError)));
  assert.equal(state.deliveredPosts, 0);
  assert.equal(state.delivery.attempts, 0);
  state.lookupError = null;
  await state.callbacks[0]();
  assert.equal(state.deliveredPosts, 1);
  assert.ok(state.delivery.delivered_at);
});

test("a due-query outage does not prevent a healthy later scheduled retry", async () => {
  const { state, webhooks } = retryFixture();
  state.dueError = new Error("temporary query failure");
  webhooks.startWebhookRetryWorker();
  await state.callbacks[0]();
  state.dueError = null;
  await state.callbacks[0]();
  assert.equal(state.deliveredPosts, 1);
  assert.equal(state.delivery.attempts, 1);
  assert.ok(state.delivery.delivered_at);
});
