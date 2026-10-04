import assert from "node:assert/strict";
import test from "node:test";
import { signingAuditFixture } from "./helpers/signing-security-audit-module.js";

for (const mode of ["embedded", "hosted"] as const) test(`${mode} signer can correct identity without changing the invitation recipient`, async () => {
  const { state, submit } = signingAuditFixture();
  state.agreement.signing_mode = mode;
  const response = await submit({ full_name: "Corrected Legal Name", email: "corrected@example.test" }, mode === "hosted" ? "legacy-token" : "session-token");
  assert.equal(response.status, 200);
  assert.equal(state.agreement.recipient_email, "signer@example.test");
  const signed = JSON.parse(state.agreement.signed_fields_json!);
  assert.equal(signed.full_name, "Corrected Legal Name");
  assert.equal(signed.email, "corrected@example.test");
  assert.equal(signed.signature.method, "typed");
  assert.ok(signed.signature.signed_at);
  assert.equal((await response.json()).signed_pdf_url, mode === "embedded" ? null : "/sign/legacy-token/pdf");
});

for (const values of [{ signature: "" }, { assent: false }, { assent: "true" }, { full_name: "" }, { email: "" }]) test(`embedded identity prefill cannot bypass required field ${JSON.stringify(values)}`, async () => {
  const { state, submit } = signingAuditFixture();
  assert.equal((await submit(values)).status, 400);
  assert.equal(state.transactions, 0);
  assert.equal(state.renders, 0);
  assert.equal(state.agreement.signed_fields_json, null);
});

for (const consent of ["", "invalid-date"]) test(`embedded consent rejects ${JSON.stringify(consent)}`, async () => {
  const { state, submit } = signingAuditFixture();
  assert.equal((await submit({}, "session-token", "https://provider.example.test", consent)).status, 400);
  assert.equal(state.transactions, 0);
});

test("embedded form prefills editable identity while leaving signatures and assent blank", async () => {
  const { request } = signingAuditFixture();
  const html = await (await request("/sign/session-token")).text();
  assert.match(html, /name="full_name"[^>]*value="Verified Signer"/);
  assert.match(html, /name="email"[^>]*value="verified@example.test"/);
  assert.doesNotMatch(html, /name="(?:full_name|email)"[^>]*(?:readonly|disabled)/);
  assert.match(html, /type="hidden"[^>]*name="signature"[^>]*\/?>/);
  assert.doesNotMatch(html, /name="signature"[^>]*value=/);
  assert.doesNotMatch(html, /name="assent"[^>]*checked/);
});

test("explicit empty prefill overrides known identity without silently locking a blank field", async () => {
  const { state, request, submit } = signingAuditFixture();
  state.agreement.prefill_fields_json = '{"full_name":"","email":""}';
  const html = await (await request("/sign/session-token")).text();
  assert.match(html, /name="full_name"[^>]*value=""/);
  assert.match(html, /name="email"[^>]*value=""/);
  assert.equal((await submit()).status, 200);
});
