import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { setup, cleanup, created, db, request, headers, sessionPath, submit } from "./fixtures/provider-review.js";

before(() => setup());
after(cleanup);

test("real SQLite webhook insertion failure rolls back signature, artifact and audits; retry commits one outbox row", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  await db.run("UPDATE agreements SET webhook_url = 'https://receiver.example.test', webhook_secret = NULL WHERE id = ?", id);
  await db.run("CREATE TRIGGER fixture_webhook_failure BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT, 'fixture webhook insert unavailable'); END");
  try {
    assert.equal((await submit(path)).status, 500);
    const stored = (await db.getAgreement(id))!;
    assert.equal(stored.status, "sent");
    assert.equal(stored.signed_fields_json, null);
    assert.equal(stored.signed_pdf_base64, null);
    assert.equal((await db.getAuditEvents(id)).filter(event => ["signed", "completed"].includes(event.event_type)).length, 0);
    assert.equal((await db.all("SELECT id FROM webhook_deliveries WHERE agreement_id = ?", id)).length, 0);
  } finally { await db.run("DROP TRIGGER fixture_webhook_failure"); }
  const successful = await submit(path, "Editable Talent");
  assert.equal(successful.status, 200, await successful.clone().text());
  const rows = await db.all<{ payload_json: string; delivered_at: string | null }>("SELECT * FROM webhook_deliveries WHERE agreement_id = ?", id);
  assert.equal(rows.length, 1);
  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.event, "agreement.completed");
  assert.equal(payload.agreement_id, id);
  assert.equal(payload.fields.signature.typed_name, "Editable Talent");
  assert.equal(payload.completed_at, (await db.getAgreement(id))!.completed_at);
  assert.equal(rows[0].delivered_at, null);
  assert.equal((await submit(path)).status, 409);
  assert.equal((await db.all("SELECT id FROM webhook_deliveries WHERE agreement_id = ?", id)).length, 1);
});

test("real SQLite concurrent signing commits one immutable completion webhook", async () => {
  const { id } = await created();
  await db.run("UPDATE agreements SET webhook_url = 'https://receiver.example.test', webhook_secret = NULL WHERE id = ?", id);
  const first = await sessionPath(id);
  const second = await sessionPath(id);
  const responses = await Promise.all([submit(first, "First"), submit(second, "Second")]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await db.getAuditEvents(id)).filter(event => event.event_type === "completed").length, 1);
  const rows = await db.all<{ payload_json: string }>("SELECT payload_json FROM webhook_deliveries WHERE agreement_id = ?", id);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload_json).fields.signature.typed_name, JSON.parse((await db.getAgreement(id))!.signed_fields_json!).signature.typed_name);
});

test("a Markdown certificate remains byte-identical after mutable database evidence changes", async () => {
  const { id } = await created();
  assert.equal((await submit(await sessionPath(id))).status, 200);
  const committed = Buffer.from((await db.getAgreement(id))!.signed_pdf_base64!, "base64");
  await db.run("UPDATE agreements SET document_title = 'Altered title', document_markdown = '# Altered', signed_fields_json = '{\"signature\":{\"typed_name\":\"Altered\"}}' WHERE id = ?", id);
  await db.addAuditEvent({ agreementId: id, eventType: "altered_evidence", data: { forged: true } });
  const response = await request(`/v1/agreements/${id}/documents/certificate`, { headers: headers() });
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(committed));
});

test("a hosted post-commit notification audit failure does not report signing failure", async () => {
  const { id } = await created({ signing_mode: "hosted", allowed_parent_origins: undefined, notification_email: "owner@example.test" });
  const agreement = (await db.getAgreement(id))!;
  await db.run("CREATE TRIGGER fixture_notification_audit_failure BEFORE INSERT ON audit_events WHEN NEW.event_type IN ('notification_sent', 'notification_failed') BEGIN SELECT RAISE(ABORT, 'fixture notification audit unavailable'); END");
  try {
    const response = await submit(`/sign/${agreement.signing_token}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await db.getAgreement(id))!.status, "completed");
  } finally { await db.run("DROP TRIGGER fixture_notification_audit_failure"); }
});

test("real SQLite partial signature acknowledgement survives both notification audit failures", async () => {
  const { id } = await created({ signing_mode: "hosted", allowed_parent_origins: undefined, signing_order: "recipient_first", sender_email: "client@example.test", fields: [{ id: "signature", label: "Talent", type: "signature", required: true }, { id: "client", label: "Client", type: "signature", signerRole: "sender", required: true }] });
  const agreement = (await db.getAgreement(id))!;
  await db.run("CREATE TRIGGER fixture_next_signer_audit_failure BEFORE INSERT ON audit_events WHEN NEW.event_type IN ('sender_signing_email_sent', 'sender_signing_email_failed') BEGIN SELECT RAISE(ABORT, 'fixture next signer audit unavailable'); END");
  try {
    const response = await submit(`/sign/${agreement.signing_token}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).pending, true);
    assert.equal((await db.getAgreement(id))!.status, "viewed");
    assert.equal((await db.getAuditEvents(id)).filter(event => event.event_type === "signed").length, 1);
  } finally { await db.run("DROP TRIGGER fixture_next_signer_audit_failure"); }
});

test("embedded creation, reminders, partial and complete signing suppress provider email even when configured", async () => {
  const { env } = await import("../src/lib/env.js");
  const previousKey = env.resendApiKey;
  const previousFetch = globalThis.fetch;
  let emailCalls = 0;
  env.resendApiKey = "synthetic-provider-key";
  globalThis.fetch = async () => { emailCalls++; return new Response('{"id":"synthetic"}', { status: 200 }); };
  try {
    const { id, signing_url } = await created({ notification_email: "owner@example.test", sender_email: "sender@example.test", cc: ["cc@example.test"] });
    assert.equal(signing_url, null);
    assert.equal((await request(`/v1/agreements/${id}/remind`, { method: "POST", headers: headers() })).status, 409);
    assert.equal((await submit(await sessionPath(id))).status, 200);
    const partial = await created({ signing_order: "recipient_first", sender_email: "sender@example.test", notification_email: "owner@example.test", fields: [{ id: "signature", label: "Talent", type: "signature", required: true }, { id: "client", label: "Client", type: "signature", signerRole: "sender", required: true }] });
    const response = await submit(await sessionPath(partial.id));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pending, true);
    assert.equal(emailCalls, 0);
    for (const agreementId of [id, partial.id]) assert.equal((await db.getAuditEvents(agreementId)).filter(event => /email|notification/.test(event.event_type)).length, 0);
  } finally { env.resendApiKey = previousKey; globalThis.fetch = previousFetch; }
});
