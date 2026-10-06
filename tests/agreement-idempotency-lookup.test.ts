import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { Agreement } from "../src/lib/types.js";
import { auditModule, embedded } from "./helpers/signing-security-audit-module.js";

const key = "0123456789abcdef".repeat(4);
const owner = "owner@example.test";
const identities = {
  ownerA: { id: "owner-a", owner_email: owner },
  ownerA2: { id: "owner-a-2", owner_email: owner },
  ownerB: { id: "owner-b", owner_email: "other@example.test" },
  keyA: { id: "key-a", owner_email: null },
  keyB: { id: "key-b", owner_email: null }
};

function record(scope = `owner:${owner}`, overrides: Partial<Agreement> = {}): Agreement {
  return {
    id: `agr_${scope}`, status: "sent", recipient_name: "Signer", recipient_email: "signer@example.test",
    document_title: "Agreement", document_markdown: "# Original contract", fields_json: "[]", signed_fields_json: '{"signature":"Signer"}',
    webhook_url: "https://hooks.example.test", webhook_secret: "whsec_private", metadata_json: '{"operation":"original"}',
    owner_email: scope.startsWith("owner:") ? scope.slice(6) : null, signing_mode: "embedded",
    allowed_parent_origins_json: '["https://parent.example.test"]', prefill_fields_json: "{}",
    idempotency_scope: scope, idempotency_key: key, creation_request_sha256: "request-hash",
    signing_token: "private-signing-token", sender_signing_token: "private-sender-token", created_at: "2026-10-06T00:00:00.000Z",
    sent_at: null, viewed_at: null, completed_at: null, signed_pdf_path: null, signed_pdf_base64: null,
    signed_pdf_sha256: null, signed_pdf_bytes: null, source_pdf_base64: null, source_pdf_sha256: null,
    source_pdf_bytes: null, source_pdf_filename: null, ...overrides
  };
}

function fixture(rows: Agreement[] = [record()]) {
  const state = { reads: [] as Array<{ sql: string; params: unknown[] }>, effects: [] as string[], failLookup: false, failGlobalLookup: false };
  const forbidden = (name: string) => async () => { state.effects.push(name); throw new Error(`Forbidden side effect: ${name}`); };
  const database = {
    get: async (sql: string, ...params: unknown[]) => {
      state.reads.push({ sql, params });
      if (state.failLookup) throw new Error("Database unavailable");
      if (sql === "SELECT id FROM agreements WHERE idempotency_key = ? LIMIT 1") {
        if (state.failGlobalLookup) throw new Error("Global lookup unavailable");
        const collision = rows.find(row => row.idempotency_key === params[0]);
        return collision ? { id: collision.id } : undefined;
      }
      if (sql === "SELECT * FROM agreements WHERE id = ? AND owner_email = ?") return rows.find(row => row.id === params[0] && row.owner_email === params[1]);
      assert.equal(sql, "SELECT * FROM agreements WHERE idempotency_scope = ? AND idempotency_key = ?");
      return rows.find(row => row.idempotency_scope === params[0] && row.idempotency_key === params[1]);
    },
    parseJson: (value: string | null, fallback: unknown) => value ? JSON.parse(value) : fallback,
    run: forbidden("db write"), addAuditEvent: forbidden("audit write"),
    all: async (sql: string, ...params: unknown[]) => {
      assert.match(sql, /WHERE owner_email = \?/);
      return rows.filter(row => row.owner_email === params[0]);
    },
    getAgreement: forbidden("unscoped read"), getAuditEvents: async () => []
  };
  const env = { env: { baseUrl: "https://provider.example.test", apiKey: "bootstrap" } };
  const auth = auditModule("src/lib/auth.ts", {
    "node:crypto": { createHash, timingSafeEqual }, "./env.js": env,
    "./apiKeys.js": { verifyStoredApiKey: async (token: string) => identities[token as keyof typeof identities] ?? null }
  });
  const scopes = auditModule("src/lib/agreementIdempotency.ts", { "./db.js": database, "./embeddedSigning.js": embedded });
  const routes = auditModule<{ agreements: Hono }>("src/routes/agreements.ts", {
    hono: { Hono }, nanoid: { nanoid: forbidden("id generation") }, "../lib/db.js": database,
    "../lib/env.js": env, "../lib/embeddedSigning.js": embedded, "../lib/agreementIdempotency.js": scopes,
    "../lib/auth.js": auth,
    "../lib/email.js": { sendSigningEmail: forbidden("signing email"), sendSenderSigningEmail: forbidden("sender email") },
    "../lib/posthog.js": { posthog: { captureEvent: forbidden("telemetry") } },
    "./webhooks.js": { enqueueWebhook: forbidden("webhook") },
    "../lib/agreementArtifacts.js": {}, "../lib/pdfStorage.js": {}, "../lib/signers.js": {},
    "../lib/templates.js": {}, "../lib/audit.js": { auditEventsForApi: (events: unknown[]) => events }, "../lib/safeWebhook.js": {}
  }).agreements;
  const app = new Hono();
  app.route("/", routes);
  app.onError(() => new Response("Internal Server Error", { status: 500 }));
  const request = (requestedKey = key, identity: string | null = "ownerA", method = "GET") => app.request(
    `https://provider.example.test/v1/agreements/by-idempotency/${encodeURIComponent(requestedKey)}`,
    { method, headers: identity === null ? {} : { authorization: `Bearer ${identity}` } }
  );
  const knownIdRequest = (id = rows[0]?.id ?? "missing", identity: string | null = "ownerA") => app.request(
    `https://provider.example.test/v1/agreements/${encodeURIComponent(id)}`,
    { headers: identity === null ? {} : { authorization: `Bearer ${identity}` } }
  );
  const listRequest = () => app.request("https://provider.example.test/v1/agreements", { headers: { authorization: "Bearer ownerA" } });
  return { state, request, knownIdRequest, listRequest };
}

test("found lookup includes original-operation proof and signed fields using the existing embedded formatter", async () => {
  const { state, request } = fixture();
  state.failGlobalLookup = true;
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.json();
  assert.equal(body.idempotency_key, key);
  assert.equal(body.durable_idempotency, true);
  assert.equal(body.globally_serialized_creation, true);
  assert.equal(body.global_absence, false);
  assert.equal(body.agreement.id, `agr_owner:${owner}`);
  assert.equal(body.agreement.idempotency_key, key);
  assert.equal(body.agreement.document_markdown, "# Original contract");
  assert.deepEqual(body.agreement.metadata, { operation: "original" });
  assert.deepEqual(body.agreement.recipient, { name: "Signer", email: "signer@example.test" });
  assert.deepEqual(body.agreement.allowed_parent_origins, ["https://parent.example.test"]);
  assert.equal(body.agreement.signing_mode, "embedded");
  assert.deepEqual(body.agreement.signed_fields, { signature: "Signer" });
  assert.equal(body.agreement.webhook_secret, "whsec_private");
  for (const field of ["preview_url", "signing_url", "sender_signing_url"]) assert.equal(body.agreement[field], null);
  assert.doesNotMatch(JSON.stringify(body), /private-signing-token|private-sender-token|ownerA|request-hash/);
  for (const field of ["signing_token", "sender_signing_token", "document_token", "idempotency_scope"]) assert.ok(!(field in body.agreement));
  assert.deepEqual(state.reads.map(read => read.params), [[`owner:${owner}`, key]]);
  assert.deepEqual(state.effects, []);
});

test("known-id GET returns the same idempotency key and original-operation proof without widening owner access", async () => {
  const { state, request, knownIdRequest } = fixture();
  const lookup = await (await request()).json();
  for (const identity of ["ownerA", "ownerA2"]) {
    const response = await knownIdRequest(undefined, identity);
    assert.equal(response.status, 200);
    const { audit_events, ...agreement } = await response.json();
    assert.equal(agreement.idempotency_key, key);
    assert.equal(agreement.document_markdown, "# Original contract");
    assert.deepEqual(agreement, lookup.agreement);
    assert.deepEqual(audit_events, []);
  }
  assert.equal((await knownIdRequest(undefined, "ownerB")).status, 404);
  assert.equal((await knownIdRequest(undefined, null)).status, 401);
  assert.deepEqual(state.effects, []);
});

test("known-id GET preserves null idempotency keys on legacy agreements", async () => {
  const { request, knownIdRequest } = fixture([record(undefined, { idempotency_key: null })]);
  const response = await knownIdRequest();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).idempotency_key, null);
  assert.equal((await (await request()).json()).agreement, null);
});

test("authenticated lists omit document Markdown while individual GET proofs include it", async () => {
  const { state, listRequest } = fixture([record(), record("owner:other@example.test")]);
  const response = await listRequest();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agreements.length, 1);
  assert.equal(body.agreements[0].idempotency_key, key);
  assert.ok(!("document_markdown" in body.agreements[0]));
  assert.doesNotMatch(JSON.stringify(body), /Original contract|other@example/);
  assert.deepEqual(state.effects, []);
});

test("successful absence requires both scoped and global queries to find no matching key", async () => {
  const { state, request } = fixture();
  const missingKey = "a".repeat(64);
  const response = await request(missingKey);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { idempotency_key: missingKey, durable_idempotency: true, globally_serialized_creation: true, global_absence: true, agreement: null });
  assert.deepEqual(state.reads, [
    { sql: "SELECT * FROM agreements WHERE idempotency_scope = ? AND idempotency_key = ?", params: [`owner:${owner}`, missingKey] },
    { sql: "SELECT id FROM agreements WHERE idempotency_key = ? LIMIT 1", params: [missingKey] }
  ]);
  assert.deepEqual(state.effects, []);
});

test("malformed keys are rejected before reading the database", async () => {
  const { state, request } = fixture();
  for (const malformed of ["a".repeat(63), "a".repeat(65), key.toUpperCase(), "g".repeat(64), `${key}\n`, ` ${key}`, `${key}:0`]) {
    const response = await request(malformed);
    assert.equal(response.status, 400, malformed);
    assert.match((await response.json()).error, /64 lowercase hexadecimal/);
  }
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.effects, []);
});

test("unauthenticated and invalid credentials cannot access the lookup or query records", async () => {
  const { state, request } = fixture();
  for (const identity of [null, "invalid", ""]) {
    const response = await request(key, identity);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  }
  assert.equal((await request("malformed", null)).status, 401);
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.effects, []);
});

test("keys for the same owner share lookup while other owners and principals cannot see the record", async () => {
  const { state, request } = fixture();
  const sameOwner = await request(key, "ownerA2");
  assert.equal(sameOwner.status, 200);
  assert.equal((await sameOwner.json()).agreement.id, `agr_owner:${owner}`);
  for (const identity of ["ownerB", "keyA", "keyB", "bootstrap"]) {
    const response = await request(key, identity);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "cannot-confirm-original-send" });
  }
  assert.deepEqual(state.effects, []);
});

test("identical keys remain isolated in owner, bootstrap and stored key namespaces including bulk", async () => {
  const scopes = [`owner:${owner}`, "owner:other@example.test", "bootstrap", "key:key-a", "key:key-b"];
  const rows = scopes.map(scope => record(scope, { signing_mode: "hosted" }));
  const { state, request } = fixture([record(`owner:${owner}:bulk`), ...rows]);
  for (const [index, identity] of ["ownerA", "ownerB", "bootstrap", "keyA", "keyB"].entries()) {
    const response = await request(key, identity);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.agreement.id, rows[index].id);
    assert.equal(body.global_absence, false);
    assert.deepEqual(state.reads.at(-1)?.params, [scopes[index], key]);
    assert.equal(body.agreement.signing_mode, "hosted");
    assert.equal(body.agreement.signing_url, "https://provider.example.test/sign/private-signing-token");
  }
  assert.deepEqual(state.effects, []);
  const bulkOnly = fixture([record(`owner:${owner}:bulk`)]);
  assert.equal((await bulkOnly.request()).status, 409);
});

test("global collisions across foreign and legacy namespaces block absence without disclosing any record details", async () => {
  for (const scope of ["owner:other@example.test", "bootstrap", "key:key-a", "key:key-b", `owner:${owner}:bulk`, null]) {
    const foreign = record(undefined, { id: "agr_foreign_private", owner_email: "foreign-private@example.test", idempotency_scope: scope });
    const { state, request } = fixture([foreign]);
    const response = await request();
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "cannot-confirm-original-send" });
    assert.equal(state.reads.length, 2);
    assert.deepEqual(state.reads.at(-1), { sql: "SELECT id FROM agreements WHERE idempotency_key = ? LIMIT 1", params: [key] });
    assert.deepEqual(state.effects, []);
  }
});

test("scoped or global database failure is a non-success and cannot claim durable absence", async () => {
  for (const failure of ["failLookup", "failGlobalLookup"] as const) {
    const { state, request } = fixture([]);
    state[failure] = true;
    const response = await request();
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /durable_idempotency|global_absence|idempotency_key|agreement.*null/);
    assert.equal(state.reads.length, failure === "failLookup" ? 1 : 2);
    assert.deepEqual(state.effects, []);
  }
});

test("lookup is read-only and repeated GET requests never create records or delivery side effects", async () => {
  const rows = [record()];
  const original = JSON.stringify(rows);
  const { state, request } = fixture(rows);
  for (let index = 0; index < 3; index++) assert.equal((await request()).status, 200);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await request(key, "ownerA", method)).status, 404);
  assert.equal(JSON.stringify(rows), original);
  assert.equal(state.reads.length, 3);
  assert.deepEqual(state.effects, []);
});
