import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import ts from "typescript";

function fixture(secret: string, failed = 0) {
  let dispatches = 0;
  const auth: Record<string, unknown> = {};
  const load = (path: string, exports: Record<string, unknown>, dependencies: Record<string, unknown>) => runInNewContext(ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: (name: string) => dependencies[name] });
  load("src/lib/auth.ts", auth, { "node:crypto": { createHash, timingSafeEqual }, "./apiKeys.js": {}, "./env.js": { env: { cronSecret: secret, apiKey: "owner-key" } } });
  const routes: Record<string, any> = {};
  load("src/routes/cron.ts", routes, { hono: { Hono }, "../lib/auth.js": auth, "./webhooks.js": { retryDueWebhooks: async () => { dispatches++; return { checked: 2, failed }; } } });
  return { app: routes.cron as Hono, dispatches: () => dispatches };
}

test("cron fails closed without a configured secret and never dispatches", async () => {
  const runtime = fixture("");
  for (const method of ["GET", "POST"]) {
    const response = await runtime.app.request("/internal/cron/webhooks", { method, headers: { authorization: "Bearer owner-key" } });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.deepEqual(await response.json(), { error: "Webhook scheduler unavailable" });
  }
  assert.equal(runtime.dispatches(), 0);
});

test("cron accepts only its bearer secret; cookies and owner keys cannot dispatch", async () => {
  const runtime = fixture("synthetic-cron-secret");
  for (const authorization of ["", "Bearer owner-key", "Bearer incorrect", "Basic synthetic-cron-secret"]) {
    const response = await runtime.app.request("/internal/cron/webhooks", { headers: { authorization, cookie: "session=synthetic-cron-secret" } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  }
  assert.equal(runtime.dispatches(), 0);
  for (const method of ["GET", "POST"]) {
    const response = await runtime.app.request("/internal/cron/webhooks", { method, headers: { authorization: "Bearer synthetic-cron-secret" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, checked: 2, failed: 0 });
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  assert.equal(runtime.dispatches(), 2);
});

test("cron returns a retryable failure without secret or delivery payload disclosure", async () => {
  const runtime = fixture("synthetic-cron-secret", 1);
  const response = await runtime.app.request("/internal/cron/webhooks", { headers: { authorization: "Bearer synthetic-cron-secret" } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, checked: 2, failed: 1 });
});

test("Vercel minute schedule reaches the dedicated Hono handler with a sufficient timeout", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.deepEqual(config.crons, [{ path: "/api/webhook-cron", schedule: "* * * * *" }]);
  assert.equal(config.rewrites, undefined);
  assert.ok(config.functions["api/webhook-cron.ts"].maxDuration >= 30);
  assert.equal(config.functions["api/index.ts"], undefined);
  assert.match(readFileSync("api/webhook-cron.ts", "utf8"), /handle\(cron\)/);
  assert.match(readFileSync("src/app.ts", "utf8"), /app\.route\("\/", cron\)/);
});


test("the actual Vercel function path is authenticated and dispatches without relying on rewritten URLs", async () => {
  const runtime = fixture("synthetic-cron-secret");
  const denied = await runtime.app.request("/api/webhook-cron");
  assert.equal(denied.status, 401);
  assert.equal(runtime.dispatches(), 0);
  const allowed = await runtime.app.request("/api/webhook-cron", { headers: { authorization: "Bearer synthetic-cron-secret" } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true, checked: 2, failed: 0 });
  assert.equal(runtime.dispatches(), 1);
  const unconfigured = fixture("");
  assert.equal((await unconfigured.app.request("/api/webhook-cron")).status, 503);
  assert.equal(unconfigured.dispatches(), 0);
});
