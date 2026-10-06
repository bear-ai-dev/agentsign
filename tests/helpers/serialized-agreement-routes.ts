import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Hono, type Context, type Next } from "hono";
import { nanoid } from "nanoid";
import * as embedded from "../../src/lib/embeddedSigning.js";
import { serializedAgreementInsert, type AgreementInsert } from "../../src/lib/serializedAgreementCreation.js";
import { auditModule } from "./signing-security-audit-module.js";
import { toPg } from "./serialized-agreement-fixture.js";

export function serializedRouteFixture() {
  const sqlite = new Database(":memory:");
  const columns = "id,status,recipient_name,recipient_email,document_markdown,document_title,fields_json,webhook_url,webhook_secret,metadata_json,owner_email,signing_token,sender_signing_token,created_at,sent_at,source_pdf_base64,source_pdf_sha256,source_pdf_bytes,source_pdf_filename,signing_mode,allowed_parent_origins_json,prefill_fields_json,idempotency_scope,idempotency_key,creation_request_sha256".split(",");
  sqlite.exec(`CREATE TABLE agreements (${columns.map(name => `${name} TEXT`).join(",")}, PRIMARY KEY (id))`);
  sqlite.exec("CREATE TABLE agreement_bulk_requests (idempotency_scope TEXT, idempotency_key TEXT, creation_request_sha256 TEXT, created_at TEXT, PRIMARY KEY (idempotency_scope, idempotency_key))");
  const state = { emails: 0, audits: 0, failInsert: false, inputs: [] as AgreementInsert[] };
  const database = {
    nowIso: () => new Date().toISOString(),
    parseJson: (value: string | null, fallback: unknown) => value ? JSON.parse(value) : fallback,
    get: async (sql: string, ...params: unknown[]) => sqlite.prepare(sql).get(...params),
    run: async (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params),
    insertAgreementWithIdempotency: async (input: AgreementInsert) => {
      state.inputs.push(input);
      if (state.failInsert) throw new Error("fixture database failure");
      return serializedAgreementInsert({ sqlite, pool: null, toPg }, input);
    },
    addAuditEvent: async () => { assert.equal(sqlite.inTransaction, false); state.audits++; }
  };
  const scopes = auditModule("src/lib/agreementIdempotency.ts", { "./db.js": database, "./embeddedSigning.js": embedded });
  const email = async () => { assert.equal(sqlite.inTransaction, false); state.emails++; };
  const routes = auditModule<{ agreements: Hono }>("src/routes/agreements.ts", {
    hono: { Hono }, nanoid: { nanoid }, "../lib/db.js": database, "../lib/env.js": { env: { baseUrl: "https://provider.example.test" } },
    "../lib/embeddedSigning.js": embedded, "../lib/agreementIdempotency.js": scopes,
    "../lib/auth.js": { requireApiKey: async (c: Context, next: Next) => { const identity = c.req.header("authorization"); if (!identity) return c.json({ error: "Unauthorized" }, 401); c.set("apiKeyRecord", { id: identity, owner_email: `${identity}@example.test` }); await next(); } },
    "../lib/email.js": { sendSigningEmail: email, sendSenderSigningEmail: email },
    "../lib/posthog.js": { posthog: { captureEvent: () => undefined }, signerDistinctId: (id: string) => id },
    "../lib/signers.js": auditModule("src/lib/signers.ts", {}),
    "../lib/templates.js": { applyTemplateVars: (value: string) => value, titleFromMarkdown: () => "Proof" },
    "../lib/agreementArtifacts.js": {}, "../lib/pdfStorage.js": {}, "./webhooks.js": {}, "../lib/audit.js": {}, "../lib/safeWebhook.js": {}
  }).agreements;
  const request = (key: string | undefined, identity = "owner-a", global = true, extra: Record<string, unknown> = {}, bulk = false) => routes.request(`https://provider.example.test/v1/agreements${bulk ? "/bulk" : ""}`, {
    method: "POST", headers: { authorization: identity, "content-type": "application/json", ...(global ? { "X-AgentContract-Global-Idempotency": "1" } : {}) },
    body: JSON.stringify({ recipient: { name: "Signer", email: "signer@example.test" }, document_markdown: "# Complete original proof\n\nSecond paragraph", fields: [], idempotency_key: key, ...extra })
  });
  return { sqlite, state, request };
}
