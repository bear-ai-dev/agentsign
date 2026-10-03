import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { nanoid } from "nanoid";
import ts from "typescript";

type Delivery = { id: string; agreement_id: string; url: string; payload_json: string; attempts: number; delivered_at: string | null; next_retry_at: string | null; error: string | null; status_code: number | null };
type RetryTick = () => void | Promise<void>;
type Webhooks = { startWebhookRetryWorker: () => void; deliverWebhook: (id: string) => Promise<void> };

export function retryFixture() {
  const delivery: Delivery = { id: "delivery-test", agreement_id: "agreement-test", url: "https://receiver.example.test/webhook", payload_json: JSON.stringify({ event: "agreement.completed" }), attempts: 0, delivered_at: null, next_retry_at: "2026-01-01T00:00:00.000Z", error: null, status_code: null };
  const state = { delivery, dueError: null as Error | null, lookupError: null as Error | null, deliveredPosts: 0, post: async () => 204, callbacks: [] as RetryTick[], errors: [] as unknown[][] };
  const database = {
    all: async () => { if (state.dueError) throw state.dueError; return [{ id: delivery.id }]; },
    get: async () => { if (state.lookupError) throw state.lookupError; return { ...delivery }; },
    getAgreement: async () => ({ id: delivery.agreement_id, webhook_secret: "local-test-only-secret" }),
    nowIso: () => new Date().toISOString(),
    parseJson: (value: string | null, fallback: unknown) => value ? JSON.parse(value) : fallback,
    run: async (sql: string, ...params: unknown[]) => {
      delivery.attempts = Number(params[0]);
      delivery.status_code = params[1] === null ? null : Number(params[1]);
      if (sql.includes("delivered_at = ?")) { delivery.delivered_at = String(params[2]); delivery.next_retry_at = null; delivery.error = null; }
      else { delivery.next_retry_at = params[3] === null ? null : String(params[3]); delivery.error = String(params[4]); }
      return { changes: 1 };
    },
  };
  const dependencies: Record<string, unknown> = {
    "node:crypto": { createHmac }, nanoid: { nanoid }, "../lib/db.js": database,
    "../lib/env.js": { env: { baseUrl: "https://provider.example.test" } },
    "../lib/safeWebhook.js": { postWebhook: async () => { state.deliveredPosts++; return state.post(); } },
  };
  const source = readFileSync(new URL("../../src/routes/webhooks.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Partial<Webhooks> = {};
  runInNewContext(javascript, { exports, require: (name: string) => { if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`); return dependencies[name]; }, setInterval: (callback: RetryTick) => { state.callbacks.push(callback); return { unref: () => undefined }; }, console: { ...console, error: (...values: unknown[]) => state.errors.push(values) } });
  if (typeof exports.deliverWebhook !== "function" || typeof exports.startWebhookRetryWorker !== "function") throw new Error("Missing production webhook exports");
  return { state, webhooks: exports as Webhooks };
}
