import assert from "node:assert/strict";
import test from "node:test";
import { embedded, signingAuditFixture } from "./helpers/signing-security-audit-module.js";

for (const origin of [null, "null", "https://evil.example.test", "https://parent.example.test", "https://provider.example.test.evil.test"]) test(`embedded submit rejects Origin ${origin}`, async () => {
  const { state, submit } = signingAuditFixture();
  const response = await submit({}, "session-token", origin);
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /Private contract|Private title|verified@example.test/);
  assert.equal(state.transactions, 0);
  assert.equal(state.renders, 0);
});

for (const token of ["legacy-token", "legacy-sender", "unknown-token"]) test(`embedded persistent or unknown token is rejected: ${token}`, async () => {
  const { state, request, submit } = signingAuditFixture();
  for (const path of [`/sign/${token}`, `/preview/${token}`, `/sign/${token}/pdf`, `/sign/${token}/source.pdf`]) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /Private contract|Private title|verified@example.test/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await submit({}, token)).status, 404);
  assert.equal(state.transactions, 0);
});

test("expired session rejects every bearer path and refresh issues an independent expiring token", async () => {
  const { state, request, submit, session } = signingAuditFixture();
  session().expires_at = new Date(state.clock - 1).toISOString();
  for (const path of ["/sign/session-token", "/preview/session-token", "/sign/session-token/pdf", "/sign/session-token/source.pdf"]) assert.equal((await request(path)).status, 404);
  assert.equal((await submit()).status, 404);
  const response = await request(`/v1/agreements/${state.agreement.id}/signing-sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent_origin: "https://parent.example.test", return_url: "https://parent.example.test/done" }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  const token = new URL(body.session_url).pathname.split("/").at(-1)!;
  assert.notEqual(token, "session-token");
  assert.ok(state.sessions.has(embedded.hashSigningToken(token)));
  assert.ok(new Date(body.expires_at).getTime() - Date.now() < 601_000);
  assert.ok(new Date(body.expires_at).getTime() - Date.now() > 599_000);
  assert.equal((await request(`/sign/${token}`)).status, 200);
  assert.equal((await submit()).status, 404);
});

test("expiry while rendering cannot commit evidence or send completion side effects", async () => {
  const { state, submit } = signingAuditFixture();
  state.expireDuringRender = true;
  assert.equal((await submit()).status, 409);
  assert.equal(state.agreement.signed_fields_json, null);
  assert.equal(state.transactions, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.emails, 0);
  assert.equal(state.webhooks, 0);
});

test("concurrent completion routes honor transaction conflict and replay cannot overwrite evidence", async () => {
  const { state, submit, session } = signingAuditFixture();
  session("second-session");
  state.agreement.webhook_url = "https://receiver.example.test";
  const responses = await Promise.all([submit({ signature: "First" }), submit({ signature: "Second" }, "second-session")]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(state.transactions, 1);
  assert.equal(state.audits.length, 2);
  assert.equal(state.webhooks, 1);
  const evidence = state.agreement.signed_fields_json;
  assert.equal((await submit({ signature: "Replacement" })).status, 409);
  assert.equal(state.agreement.signed_fields_json, evidence);
  assert.equal(state.audits.length, 2);
  assert.equal(state.emails, 0);
});

for (const override of [{ parent_origin: "https://evil.example.test" }, { parent_origin: "https://parent.example.test/" }, { parent_origin: "https://*.example.test" }, { return_url: "https://evil.example.test/done" }, { return_url: "https://user:pass@parent.example.test/done" }, { signer_role: "admin" }]) test(`session rejects invalid origin or role ${JSON.stringify(override)}`, async () => {
  const { state, request } = signingAuditFixture();
  const response = await request(`/v1/agreements/${state.agreement.id}/signing-sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent_origin: "https://parent.example.test", return_url: "https://parent.example.test/done", ...override }) });
  assert.equal(response.status, 400);
  assert.equal(state.sessions.size, 1);
  assert.equal(state.writes, 0);
});

test("session frame ancestor and completion message remain bound to the exact parent", async () => {
  const { state, request } = signingAuditFixture();
  state.agreement.status = "completed";
  const response = await request("/sign/session-token");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors https://parent.example.test");
  const html = await response.text();
  assert.match(html, /postMessage\(\{"type":"agentcontract:completed","agreement_id":"agreement-audit"\}, "https:\/\/parent.example.test"\)/);
  assert.doesNotMatch(html, /Private contract|verified@example.test|\/pdf/);
});

test("recipient cannot sign sender fields and each role's completion is recorded once", async () => {
  const { state, submit, session } = signingAuditFixture();
  const fields = JSON.parse(state.agreement.fields_json);
  fields.push({ id: "sender_signature", label: "Sender signature", type: "signature", signerRole: "sender", required: true });
  state.agreement.fields_json = JSON.stringify(fields);
  const sender = session("sender-session");
  sender.signer_role = "sender";
  const recipient = await submit({ sender_signature: "Forged sender" });
  assert.equal(recipient.status, 200);
  assert.equal((await recipient.json()).pending, true);
  assert.doesNotMatch(state.agreement.signed_fields_json!, /Forged sender|sender_signature/);
  assert.equal((await submit()).status, 409);
  const final = await submit({ sender_signature: "Actual sender", signature: "Forged recipient" }, "sender-session");
  assert.equal(final.status, 200);
  const stored = JSON.parse(state.agreement.signed_fields_json!);
  assert.equal(stored.signature.typed_name, "Local Signer");
  assert.equal(stored.sender_signature.typed_name, "Actual sender");
  assert.equal(state.transactions, 2);
  assert.equal(state.audits.length, 3);
  assert.equal(state.emails, 0);
});

test("sender-first order rejects early recipient evidence without side effects", async () => {
  const { state, submit } = signingAuditFixture();
  const fields = JSON.parse(state.agreement.fields_json);
  fields.push({ id: "sender_signature", label: "Sender signature", type: "signature", signerRole: "sender", required: true });
  state.agreement.fields_json = JSON.stringify(fields);
  state.agreement.metadata_json = '{"signing_order":"sender_first"}';
  assert.equal((await submit()).status, 409);
  assert.equal(state.transactions, 0);
  assert.equal(state.renders, 0);
  assert.equal(state.agreement.signed_fields_json, null);
});

test("completion script executes one notification to the exact parent without exposing evidence", async () => {
  const { runInNewContext } = await import("node:vm");
  const { session } = signingAuditFixture();
  const messages: { value: unknown; origin: string }[] = [];
  const id = 'agreement-</script><script>throw new Error("injected")</script>';
  runInNewContext(embedded.completionScript(id, session()), { window: { parent: { postMessage: (value: unknown, origin: string) => messages.push({ value, origin }) } } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].origin, "https://parent.example.test");
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].value)), { type: "agentcontract:completed", agreement_id: id });
});

for (const prefill of [{ signature: "Forged signature" }, { assent: true }]) test(`embedded options reject assent prefill ${JSON.stringify(prefill)}`, () => {
  const { state } = signingAuditFixture();
  assert.throws(() => embedded.validatedEmbeddedOptions({ signing_mode: "embedded", allowed_parent_origins: ["https://parent.example.test"], prefill_fields: prefill }, JSON.parse(state.agreement.fields_json)), /non-assent fields/);
});

test("embedded options require a required signature for every signer role", () => {
  const options = { signing_mode: "embedded" as const, allowed_parent_origins: ["https://parent.example.test"] };
  assert.throws(() => embedded.validatedEmbeddedOptions(options, [{ id: "name", label: "Name", type: "text", required: true }]), /required signature/);
  assert.throws(() => embedded.validatedEmbeddedOptions(options, [{ id: "signature", label: "Signature", type: "signature", required: true }, { id: "sender_name", label: "Sender name", type: "text", signerRole: "sender", required: true }]), /Embedded sender fields require a required signature/);
});

test("a completion webhook insert failure prevents a partial committed signature", async () => {
  const { state, submit } = signingAuditFixture();
  state.agreement.webhook_url = "https://receiver.example.test";
  state.failWebhookInsert = true;
  assert.equal((await submit()).status, 500);
  assert.equal(state.agreement.status, "sent");
  assert.equal(state.agreement.signed_fields_json, null);
  assert.equal(state.agreement.signed_pdf_base64, null);
  assert.equal(state.transactions, 0);
  assert.equal(state.webhooks, 0);
});

test("post-commit notification audit failure still acknowledges a hosted signature", async () => {
  const { state, submit } = signingAuditFixture();
  state.agreement.signing_mode = "hosted";
  state.agreement.metadata_json = JSON.stringify({ notification_email: ["owner@example.test"] });
  state.failNotificationAudit = true;
  const response = await submit({ signature: "Talent" }, "legacy-token");
  assert.equal(response.status, 200);
  assert.equal(state.agreement.status, "completed");
  assert.equal(state.emails, 1);
});

test("a partial hosted signature acknowledges saved evidence despite next-signer notification audit failure", async () => {
  const { state, submit } = signingAuditFixture();
  state.agreement.signing_mode = "hosted";
  const fields = JSON.parse(state.agreement.fields_json);
  state.agreement.fields_json = JSON.stringify([...fields, { id: "client", label: "Client", type: "signature", signerRole: "sender", required: true }]);
  state.agreement.metadata_json = JSON.stringify({ signing_order: "recipient_first", sender_email: "sender@example.test" });
  state.failNotificationAudit = true;
  const response = await submit({ signature: "Talent" }, "legacy-token");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pending, true);
  assert.equal(state.agreement.status, "viewed");
  assert.equal(state.emails, 1);
});
