import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHmac } from "node:crypto";
import ts from "typescript";
import { Hono } from "hono";
import { requireCronSecret } from "../../src/lib/auth.js";
import { nanoid } from "nanoid";
import * as db from "../../src/lib/db.js";
import * as claims from "../../src/lib/webhookClaims.js";
import { ProviderRequestError } from "../../src/lib/embeddedSigning.js";

await db.dbReady;
const input = JSON.parse(process.argv[2]) as { action: string; id: string; token?: string; marker?: string; crash?: boolean; waitFor?: string; ready?: string; authorization?: string };
if (input.waitFor) {
  appendFileSync(input.ready!, "ready");
  const deadline = Date.now() + 20_000;
  while (!existsSync(input.waitFor)) {
    if (Date.now() > deadline) throw new Error("Fixture barrier expired");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
if (input.action === "claim") console.log(JSON.stringify({ token: await claims.claimWebhook(input.id) ?? null }));
else if (input.action === "receipt") {
  try {
    await claims.recordWebhookResult({ deliveryId: input.id, token: input.token!, attempt: 1, status: 204, error: null, nextRetryAt: null, delivered: true });
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || error.status !== 409) throw error;
    console.log(JSON.stringify({ stale: true }));
  }
  console.log(JSON.stringify(await db.get("SELECT * FROM webhook_deliveries WHERE id = ?", input.id)));
} else if (["deliver", "cron"].includes(input.action)) {
  const exports: { deliverWebhook?: (id: string) => Promise<void>; retryDueWebhooks?: () => Promise<{ checked: number; failed: number }> } = {};
  const dependencies: Record<string, unknown> = {
    "node:crypto": { createHmac }, nanoid: { nanoid }, "../lib/db.js": db, "../lib/webhookClaims.js": claims,
    "../lib/env.js": { env: { baseUrl: "https://provider.example.test" } },
    "../lib/safeWebhook.js": { postWebhook: async (_url: string, body: string, headers: Record<string, string>) => {
      appendFileSync(input.marker!, JSON.stringify({ body, headers }) + "\n");
      if (input.crash) process.exit(17);
      await new Promise(resolve => setTimeout(resolve, 150));
      return 204;
    } }
  };
  const source = readFileSync("src/routes/webhooks.ts", "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, console });
  if (input.action === "cron") {
    const routeExports: { cron?: Hono } = {};
    const cronDependencies: Record<string, unknown> = { hono: { Hono }, "../lib/auth.js": { requireCronSecret }, "./webhooks.js": exports };
    runInNewContext(ts.transpileModule(readFileSync("src/routes/cron.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: routeExports, require: (name: string) => cronDependencies[name] });
    const response = await routeExports.cron!.request("https://provider.example.test/internal/cron/webhooks", { headers: { authorization: input.authorization ?? "Bearer fixture-cron-secret" } });
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  } else {
    await exports.deliverWebhook!(input.id);
    console.log("delivered");
  }
}
process.exit(0);
