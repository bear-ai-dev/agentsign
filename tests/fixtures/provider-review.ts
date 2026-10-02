import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";

export let directory = "";
export let app: typeof import("../../src/app.js").app;
export let db: typeof import("../../src/lib/db.js");
export let ownerKey = "";
export let ownerlessA = "";
export let ownerlessB = "";
export let sourcePdf: Buffer;
export const bootstrap = "provider-review-fake-bootstrap";
export const provider = "https://provider.example.test";
export const parent = "https://parent.example.test";
export const payload = () => ({ recipient: { name: "Talent", email: "talent@example.test" }, document_markdown: "# Review\n\n{{signed:signature}}", fields: [{ id: "signature", label: "Signature", type: "signature", required: true }], signing_mode: "embedded", allowed_parent_origins: [parent] });
export const headers = (key = ownerKey) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
export const request = async (path: string, init?: RequestInit) => app.request(`${provider}${path}`, init);
export const create = (overrides: Record<string, unknown> = {}, key = ownerKey) => request("/v1/agreements", { method: "POST", headers: headers(key), body: JSON.stringify({ ...payload(), ...overrides }) });
export const bulk = (body: Record<string, unknown>, key = ownerKey) => request("/v1/agreements/bulk", { method: "POST", headers: headers(key), body: JSON.stringify(body) });
export async function created(overrides: Record<string, unknown> = {}, key = ownerKey) {
  const response = await create(overrides, key);
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as { id: string; signing_url: string | null; webhook_secret: string | null };
}
export const session = (id: string, key = ownerKey) => request(`/v1/agreements/${id}/signing-sessions`, { method: "POST", headers: headers(key), body: JSON.stringify({ parent_origin: parent, return_url: `${parent}/done` }) });
export async function sessionPath(id: string) {
  const response = await session(id);
  assert.equal(response.status, 201);
  return new URL((await response.json() as { session_url: string }).session_url).pathname;
}
export const submit = (path: string, signature = "Talent") => request(`${path}/submit`, { method: "POST", headers: { "content-type": "application/json", origin: provider }, body: JSON.stringify({ fields: { signature }, consent_timestamp: new Date().toISOString() }) });
export function dashboardHeaders() {
  const value = Buffer.from(JSON.stringify({ email: "owner@example.test", exp: Date.now() + 60_000 })).toString("base64url");
  const signature = createHmac("sha256", "provider-review-fake-cookie-password").update(value).digest("base64url");
  return { cookie: `agentcontract_admin_email_session=${value}.${signature}` };
}
export async function setup(databaseUrl = "") {
  directory = await mkdtemp(join(tmpdir(), "provider-review-"));
  Object.assign(process.env, { DOTENV_CONFIG_PATH: "/dev/null", DATABASE_PATH: join(directory, "provider.db"), DATABASE_URL: databaseUrl, PDF_OUTPUT_DIR: join(directory, "pdfs"), AGENTCONTRACT_API_KEY: bootstrap, BASE_URL: provider, RESEND_API_KEY: "", NODE_ENV: "test", VERCEL: "", WORKOS_COOKIE_PASSWORD: "provider-review-fake-cookie-password", POSTHOG_ENABLED: "false", POSTHOG_API_KEY: "" });
  if (databaseUrl) assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
  ({ app } = await import("../../src/app.js"));
  db = await import("../../src/lib/db.js");
  const { createApiKey } = await import("../../src/lib/apiKeys.js");
  ownerKey = (await createApiKey({ name: "Owner", ownerEmail: "owner@example.test" })).key;
  ownerlessA = (await createApiKey({ name: "Ownerless A" })).key;
  ownerlessB = (await createApiKey({ name: "Ownerless B" })).key;
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 9; page++) pdf.addPage().drawText(`Synthetic source page ${page}`);
  sourcePdf = Buffer.from(await pdf.save());
}
export const cleanup = () => rm(directory, { recursive: true, force: true });
