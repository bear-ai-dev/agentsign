import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Hono, type Context, type Next } from "hono";
import * as cookies from "hono/cookie";
import { nanoid } from "nanoid";
import { PDFDocument } from "pdf-lib";
import ts from "typescript";
import type { Agreement, FieldDefinition } from "../../src/lib/types.js";
import type * as Embedded from "../../src/lib/embeddedSigning.js";
import type * as Storage from "../../src/lib/pdfStorage.js";
import type * as Artifacts from "../../src/lib/agreementArtifacts.js";

export function auditModule<T>(path: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(javascript, { exports, require: (name: string) => { if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`); return dependencies[name]; }, Buffer, URL, Response, Uint8Array, Date, Error, console, fetch: () => { throw new Error("Network forbidden"); } });
  return exports as T;
}

export const embedded = auditModule<typeof Embedded>("src/lib/embeddedSigning.ts", { "node:crypto": { createHash, randomBytes } });

export function signingAuditFixture() {
  const fields: FieldDefinition[] = [{ id: "full_name", label: "Legal name", type: "text", required: true }, { id: "email", label: "Email", type: "email", required: true }, { id: "signature", label: "Signature", type: "signature", required: true }, { id: "assent", label: "Assent", type: "boolean", required: true }];
  const agreement: Agreement = {
    id: "agreement-audit", status: "sent", recipient_name: "Local Signer", recipient_email: "signer@example.test", document_markdown: "Private contract", document_title: "Private title", fields_json: JSON.stringify(fields), signed_fields_json: null,
    webhook_url: null, webhook_secret: null, metadata_json: null, owner_email: "owner@example.test", signing_mode: "embedded", allowed_parent_origins_json: '["https://parent.example.test"]', prefill_fields_json: '{"full_name":"Verified Signer","email":"verified@example.test"}', idempotency_scope: null, idempotency_key: null, creation_request_sha256: null,
    signing_token: "legacy-token", sender_signing_token: "legacy-sender", created_at: new Date().toISOString(), sent_at: null, viewed_at: "2026-01-01T00:00:00.000Z", completed_at: null, signed_pdf_path: null, signed_pdf_base64: null, signed_pdf_sha256: null, signed_pdf_bytes: null,
    source_pdf_base64: null, source_pdf_sha256: null, source_pdf_bytes: null, source_pdf_filename: null
  };
  const state = { agreement, sessions: new Map<string, Embedded.SigningSession>(), audits: [] as unknown[], transactions: 0, renders: 0, reads: 0, writes: 0, emails: 0, webhooks: 0, owner: "owner@example.test" as string | null, authenticated: true, bootstrap: false, clock: Date.now(), expireDuringRender: false, failWebhookInsert: false, failNotificationAudit: false, files: new Map<string, Buffer>() };
  const session = (token = "session-token") => {
    const value: Embedded.SigningSession = { token_hash: embedded.hashSigningToken(token), agreement_id: agreement.id, signer_role: "recipient", parent_origin: "https://parent.example.test", return_url: "https://parent.example.test/done", expires_at: new Date(state.clock + 600_000).toISOString(), created_at: new Date(state.clock).toISOString() };
    state.sessions.set(value.token_hash, value);
    return value;
  };
  session();
  const database = {
    parseJson: (value: string | null, fallback: unknown) => value ? JSON.parse(value) : fallback,
    nowIso: () => new Date(state.clock).toISOString(),
    getAgreement: async (id: string) => id === agreement.id ? { ...agreement } : undefined,
    get: async (_sql: string, id: string, owner: string) => id === agreement.id && owner === agreement.owner_email ? { ...agreement } : undefined,
    getAuditEvents: async () => state.audits,
    getAgreementByToken: async (token: string): Promise<Agreement | undefined> => (await database.getAgreementBySigningToken(token))?.agreement,
    addAuditEvent: async (event: unknown) => { if (state.failNotificationAudit) throw new Error("fixture notification audit unavailable"); state.audits.push(event); },
    getAgreementBySigningToken: async (token: string) => {
      const value = state.sessions.get(embedded.hashSigningToken(token));
      if (value && value.expires_at > new Date(state.clock).toISOString() && agreement.signing_mode === "embedded") return { agreement: { ...agreement }, signerRole: value.signer_role, session: value };
      if (agreement.signing_mode === "hosted" && [agreement.signing_token, agreement.sender_signing_token].includes(token)) return { agreement: { ...agreement }, signerRole: token === agreement.sender_signing_token ? "sender" : "recipient" };
      return undefined;
    },
    run: async (sql: string, ...params: unknown[]) => {
      state.writes++;
      if (sql.startsWith("INSERT INTO agreement_signing_sessions")) state.sessions.set(String(params[0]), { token_hash: String(params[0]), agreement_id: String(params[1]), signer_role: params[2] as "recipient" | "sender", parent_origin: String(params[3]), return_url: String(params[4]), expires_at: String(params[5]), created_at: String(params[6]) });
      else if (sql.includes("SET signed_pdf_path")) Object.assign(agreement, { signed_pdf_path: params[0], signed_pdf_base64: params[1], signed_pdf_sha256: params[2], signed_pdf_bytes: params[3] });
      else throw new Error(`Unexpected write: ${sql}`);
      return { changes: 1 };
    },
    runTransaction: async (statements: { sql: string; params: unknown[]; expectedChanges?: number }[], guard: { agreementId: string; sessionTokenHash?: string }) => {
      if (guard.sessionTokenHash) {
        const value = state.sessions.get(guard.sessionTokenHash);
        if (!value || value.expires_at <= new Date(state.clock).toISOString()) throw new embedded.ProviderRequestError("Signing session expired; issue a new session", 409);
      }
      const update = statements.find(item => item.expectedChanges === 1);
      if (!update || !["sent", "viewed"].includes(agreement.status) || (agreement.signed_fields_json ?? "") !== update.params.at(-1)) throw new embedded.ProviderRequestError("Signing state changed; refresh the session", 409);
      if (state.failWebhookInsert && statements.some(item => item.sql.startsWith("INSERT INTO webhook_deliveries"))) throw new Error("fixture webhook insert unavailable");
      state.transactions++;
      state.webhooks += statements.filter(item => item.sql.startsWith("INSERT INTO webhook_deliveries")).length;
      agreement.signed_fields_json = String(update.params[0]);
      if (update.sql.includes("status = 'completed'")) Object.assign(agreement, { status: "completed", completed_at: update.params[1], signed_pdf_path: update.params[2], signed_pdf_base64: update.params[3], signed_pdf_sha256: update.params[4], signed_pdf_bytes: update.params[5] });
      else agreement.status = "viewed";
      state.audits.push(...statements.filter(item => item.sql.startsWith("INSERT INTO audit_events")).map(item => item.params));
    }
  };
  const pdf = {
    signatureFontFaceCss: "", renderContractBodyHtml: () => ({ body: "<p>Private contract</p>" }), signatureCertificateMarkdown: () => "Certificate",
    renderAgreementPdfResult: async () => { state.renders++; if (state.expireDuringRender) state.clock += 600_001; return { path: "/fake/signed.pdf", buffer: Buffer.from("signed-pdf") }; },
    renderPDFResult: async () => { state.renders++; return { path: "/fake/certificate.pdf", buffer: Buffer.from("certificate-pdf") }; }
  };
  const storage = auditModule<typeof Storage>("src/lib/pdfStorage.ts", { "node:crypto": { createHash }, "node:fs": { existsSync: (path: string) => state.files.has(path), readFileSync: (path: string) => { state.reads++; return state.files.get(path); } }, "./db.js": database, "./pdf.js": pdf });
  const artifacts = auditModule<typeof Artifacts>("src/lib/agreementArtifacts.ts", { "pdf-lib": { PDFDocument }, "./db.js": database, "./pdf.js": pdf, "./pdfStorage.js": storage });
  const signers = auditModule("src/lib/signers.ts", {});
  const dependencies: Record<string, unknown> = {
    hono: { Hono }, "hono/cookie": cookies, nanoid: { nanoid }, "../lib/db.js": database, "../lib/embeddedSigning.js": embedded, "../lib/signers.js": signers, "../lib/pdfStorage.js": storage, "../lib/pdf.js": pdf,
    "../lib/email.js": { sendCompletionEmail: async () => { state.emails++; }, sendSenderSigningEmail: async () => { state.emails++; }, sendSigningEmail: async () => { state.emails++; } },
    "../lib/posthog.js": { posthog: { captureEvent: () => undefined, captureException: async () => undefined }, setPosthogDistinctId: () => undefined, signerDistinctId: (id: string) => id },
    "./webhooks.js": { webhookInsertStatement: (id: string, url: string, payload: unknown) => ({ id: "fixture-delivery", sql: "INSERT INTO webhook_deliveries", params: [id, url, payload] }), deliverWebhook: async () => undefined, completedPayload: () => ({}), cancelledPayload: () => ({}), enqueueWebhook: async () => { state.webhooks++; } },
    "../lib/env.js": { env: { baseUrl: "https://provider.example.test" } }, "../lib/agreementArtifacts.js": artifacts,
    "../lib/agreementIdempotency.js": {}, "../lib/templates.js": {}, "../lib/audit.js": {}, "../lib/safeWebhook.js": {},
    "../lib/auth.js": { requireApiKey: async (c: Context, next: Next) => { if (!state.authenticated) return c.json({ error: "Unauthorized" }, 401); if (state.bootstrap) c.set("apiKeyBootstrap", true); else c.set("apiKeyRecord", { id: "local-key", owner_email: state.owner }); await next(); } }
  };
  const sign = auditModule<{ sign: Hono }>("src/routes/sign.ts", dependencies).sign;
  const routes = auditModule<{ agreements: Hono }>("src/routes/agreements.ts", dependencies).agreements;
  const app = new Hono();
  app.route("/", sign).route("/", routes);
  const request = (path: string, init?: RequestInit) => { const url = new URL(path, "https://provider.example.test"); if (url.origin !== "https://provider.example.test") throw new Error("Unexpected HTTP origin"); return app.request(url.href, init); };
  const submit = (values: Record<string, unknown> = {}, token = "session-token", origin: string | null = "https://provider.example.test", consent = new Date(state.clock).toISOString()) => request(`/sign/${token}/submit`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) }, body: JSON.stringify({ fields: { full_name: "Verified Signer", email: "verified@example.test", signature: "Local Signer", assent: true, ...values }, consent_timestamp: consent }) });
  return { state, request, submit, session, storage, artifacts };
}
