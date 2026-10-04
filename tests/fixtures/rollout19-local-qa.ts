import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "provider-local-qa-"));
const providerOrigin = "http://localhost:4149";
const parentOrigin = "http://localhost:4150";
const bootstrapKey = "local-qa-provider-key";
Object.assign(process.env, { DOTENV_CONFIG_PATH: "/dev/null", DATABASE_URL: "", DATABASE_PATH: join(directory, "fixture.db"), PDF_OUTPUT_DIR: join(directory, "pdfs"), AGENTCONTRACT_API_KEY: bootstrapKey, BASE_URL: providerOrigin, RESEND_API_KEY: "", POSTHOG_ENABLED: "false", POSTHOG_PROJECT_API_KEY: "", POSTHOG_API_KEY: "", NODE_ENV: "test", VERCEL: "", WORKOS_COOKIE_PASSWORD: "local-qa-cookie-password-for-test-only" });
const { app } = await import("../../src/app.js");
const { getAgreement } = await import("../../src/lib/db.js");
const require = createRequire(import.meta.url);
const { serve } = require("@hono/node-server") as typeof import("@hono/node-server");
const { chromium } = await import("/Users/rishigarg/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const providerServer = serve({ fetch: app.fetch, hostname: "localhost", port: 4149 });
let sessionUrl = "";
const parentServer = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Embedded signing QA</title><style>body{margin:0;background:#f8fafc;font-family:system-ui,sans-serif}header{padding:16px 24px;border-bottom:1px solid #e2e8f0;background:white}h1{margin:0;font-size:18px}p{margin:4px 0 0;color:#475569;font-size:13px}iframe{display:block;width:100%;height:1000px;border:0;background:white}@media(max-width:600px){header{padding:14px 16px}iframe{height:1300px}}</style></head><body><header><h1>Local embedded signing fixture</h1><p>Sample participant · no live envelope or email</p></header><iframe title="Embedded agreement signer" src="${sessionUrl}"></iframe><script>window.messages=[];window.addEventListener('message',event=>window.messages.push({origin:event.origin,data:event.data}));</script></body></html>`);
});
await new Promise<void>((done) => parentServer.listen(4150, "localhost", done));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results: Array<{ width: number; screenshot: string; completed: boolean }> = [];
try {
  for (const [label, width] of [["desktop", 1440], ["phone", 390]] as const) {
    const body = {
      recipient: { name: "Alex Participant", email: "alex@local-qa.example.test" },
      document_markdown: "# Voice consent preview\n\nThis agreement is an isolated local test fixture.\n\n## Review the document\n\nThe participant name may be prefilled and edited. Signing requires entering a signature and initials, selecting the agreement checkbox, and confirming electronic signature consent.\n\n## Participant details\n\nName: {{signed:full_name}}\n\n## Your choice\n\nReview the complete document before entering your signature. No signature or checkbox is completed in advance.",
      fields: [
        { id: "full_name", label: "Full legal name", type: "text", required: true },
        { id: "signature", label: "Participant signature", type: "signature", required: true },
        { id: "initials", label: "Participant initials", type: "initials", required: true },
        { id: "accept", label: "I accept this local test document", type: "boolean", required: true }
      ],
      signing_mode: "embedded", allowed_parent_origins: [parentOrigin], prefill_fields: { full_name: "Alex Participant" }
    };
    const created = await fetch(`${providerOrigin}/v1/agreements`, { method: "POST", headers: { authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const agreement = await created.json() as { id: string; signing_url: string | null };
    assert.equal(agreement.signing_url, null);
    const issued = await fetch(`${providerOrigin}/v1/agreements/${agreement.id}/signing-sessions`, { method: "POST", headers: { authorization: `Bearer ${bootstrapKey}`, "content-type": "application/json" }, body: JSON.stringify({ parent_origin: parentOrigin, return_url: `${parentOrigin}/done` }) });
    assert.equal(issued.status, 201);
    sessionUrl = (await issued.json() as { session_url: string }).session_url;
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/*", (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
      const origin = new URL(route.request().url()).origin;
      return origin === providerOrigin || origin === parentOrigin ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.goto(parentOrigin, { waitUntil: "networkidle" });
    const signer = page.frameLocator("iframe");
    const reject = signer.locator('[data-c15t-action="reject"]').first();
    if (await reject.isVisible()) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await reject.click();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    assert.equal(await signer.locator('[name="full_name"]').inputValue(), "Alex Participant");
    assert.equal(await signer.locator('[name="signature"]').inputValue(), "");
    assert.equal(await signer.locator('[name="initials"]').inputValue(), "");
    assert.equal(await signer.locator('[name="accept"]').isChecked(), false);
    assert.equal(await signer.locator("#consent").isChecked(), false);
    assert.equal(await signer.locator("html").evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth), false);
    const signingHeight = await signer.locator("html").evaluate((element: HTMLElement) => element.scrollHeight);
    await page.locator("iframe").evaluate((element: HTMLElement, height: number) => { element.style.height = `${height + 48}px`; }, signingHeight);
    const screenshot = resolve(`reports/rollout19/embedded-${label}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await signer.locator("#field-signature-typed").fill("Alex Participant");
    await signer.locator("#field-initials-typed").fill("AP");
    await signer.locator('[name="accept"]').check();
    await signer.locator("#consent").check();
    await signer.getByRole("button", { name: "Sign and Submit" }).click();
    await page.waitForFunction(() => (window as unknown as { messages: unknown[] }).messages.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages), [{ origin: providerOrigin, data: { type: "agentcontract:completed", agreement_id: agreement.id } }]);
    assert.equal((await getAgreement(agreement.id))!.status, "completed");
    results.push({ width, screenshot, completed: true });
    await context.close();
  }
  await writeFile("reports/rollout19/qa-results.json", JSON.stringify({ tool: "Playwright with local Chrome", provider_origin: providerOrigin, parent_origin: parentOrigin, results }, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => providerServer.close((error?: Error) => error ? reject(error) : done()));
  await new Promise<void>((done, reject) => parentServer.close((error?: Error) => error ? reject(error) : done()));
  await rm(directory, { recursive: true, force: true });
}
