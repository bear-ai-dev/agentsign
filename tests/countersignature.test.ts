import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

let routeTestDir = "";
let appModule: typeof import("../src/app.js");

function tokenFromSigningUrl(url: string) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1)!;
}

before(async () => {
  routeTestDir = await mkdtemp(join(tmpdir(), "agentcontract-countersign-"));
  process.env.DATABASE_PATH = join(routeTestDir, "agentcontract.db");
  process.env.AGENTCONTRACT_API_KEY = "ak_test_countersignature";
  process.env.BASE_URL = "https://agentcontract.to";
  appModule = await import("../src/app.js");
});

after(async () => {
  await rm(routeTestDir, { recursive: true, force: true });
});

test("recipient-first countersignature completes only after sender signs", async () => {
  const createResponse = await appModule.app.request("https://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: {
      authorization: "Bearer ak_test_countersignature",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      recipient: { name: "Seller Person", email: "seller@example.com" },
      sender_email: "buyer@example.com",
      sender_name: "Buyer Person",
      signing_order: "recipient_first",
      document_markdown: [
        "# Counter Signature Test",
        "",
        "Seller: {{signed:seller_signature}}",
        "",
        "Buyer: {{signed:buyer_signature}}"
      ].join("\n"),
      fields: [
        { id: "seller_printed_name", label: "Seller printed legal name", type: "text", required: true, signerRole: "recipient" },
        { id: "seller_signature_date", label: "Seller signature date", type: "date", required: true, signerRole: "recipient" },
        { id: "seller_signature", label: "Seller signature", type: "signature", required: true, signerRole: "recipient" },
        { id: "buyer_printed_name", label: "Buyer printed legal name", type: "text", required: true, signerRole: "sender" },
        { id: "buyer_signature_date", label: "Buyer signature date", type: "date", required: true, signerRole: "sender" },
        { id: "buyer_signature", label: "Buyer signature", type: "signature", required: true, signerRole: "sender" }
      ]
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as {
    id: string;
    signing_url: string;
    sender_signing_url: string;
    signing_order: string;
  };
  assert.equal(created.signing_order, "recipient_first");
  assert.ok(created.sender_signing_url);

  const recipientToken = tokenFromSigningUrl(created.signing_url);
  const senderToken = tokenFromSigningUrl(created.sender_signing_url);

  const senderEarlyResponse = await appModule.app.request(`https://agentcontract.test/sign/${senderToken}`);
  assert.equal(senderEarlyResponse.status, 409);
  assert.match(await senderEarlyResponse.text(), /Waiting for recipient signature/);

  const recipientPageResponse = await appModule.app.request(`https://agentcontract.test/sign/${recipientToken}`);
  assert.equal(recipientPageResponse.status, 200);
  const recipientPage = await recipientPageResponse.text();
  assert.match(recipientPage, /Seller signature/);
  assert.doesNotMatch(recipientPage, /Buyer signature<\/label>/);
  assert.doesNotMatch(recipientPage, /\{\{signed:/);

  const recipientSignResponse = await appModule.app.request(`https://agentcontract.test/sign/${recipientToken}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consent_timestamp: "2026-06-26T12:00:00.000Z",
      fields: {
        seller_printed_name: "Seller Person",
        seller_signature_date: "2026-06-26",
        seller_signature: "Seller Person"
      }
    })
  });
  assert.equal(recipientSignResponse.status, 200);
  const recipientSigned = await recipientSignResponse.json() as { pending?: boolean; completed?: boolean };
  assert.equal(recipientSigned.pending, true);
  assert.equal(recipientSigned.completed, false);

  const pendingResponse = await appModule.app.request(`https://agentcontract.test/v1/agreements/${created.id}`, {
    headers: { authorization: "Bearer ak_test_countersignature" }
  });
  assert.equal(pendingResponse.status, 200);
  const pending = await pendingResponse.json() as { status: string; signed_fields: Record<string, unknown> };
  assert.notEqual(pending.status, "completed");
  assert.ok(pending.signed_fields.seller_signature);
  assert.equal(pending.signed_fields.buyer_signature, undefined);

  const senderPageResponse = await appModule.app.request(`https://agentcontract.test/sign/${senderToken}`);
  assert.equal(senderPageResponse.status, 200);
  const senderPage = await senderPageResponse.text();
  assert.match(senderPage, /Buyer signature/);
  assert.doesNotMatch(senderPage, /Seller signature<\/label>/);

  const senderSignResponse = await appModule.app.request(`https://agentcontract.test/sign/${senderToken}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consent_timestamp: "2026-06-26T12:05:00.000Z",
      fields: {
        buyer_printed_name: "Buyer Person",
        buyer_signature_date: "2026-06-26",
        buyer_signature: "Buyer Person"
      }
    })
  });
  assert.equal(senderSignResponse.status, 200);
  const senderSigned = await senderSignResponse.json() as { completed?: boolean; signed_pdf_url?: string };
  assert.equal(senderSigned.completed, true);
  assert.ok(senderSigned.signed_pdf_url);

  const completedResponse = await appModule.app.request(`https://agentcontract.test/v1/agreements/${created.id}`, {
    headers: { authorization: "Bearer ak_test_countersignature" }
  });
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json() as { status: string; signed_fields: Record<string, unknown> };
  assert.equal(completed.status, "completed");
  assert.ok(completed.signed_fields.seller_signature);
  assert.ok(completed.signed_fields.buyer_signature);
});
