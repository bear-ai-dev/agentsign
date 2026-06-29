import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

let routeTestDir = "";
let appModule: typeof import("../src/app.js");
let apiKeysModule: typeof import("../src/lib/apiKeys.js");

const ownerA = "owner-a@example.com";
const ownerB = "owner-b@example.com";
let keyA = "";
let keyB = "";
let agreementA = "";
let agreementB = "";

function authHeaders(key: string) {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json"
  };
}

function adminEmailCookie(email: string) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Date.now() + 60 * 60 * 1000
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.AGENTCONTRACT_API_KEY!).update(payload).digest("base64url");
  return `agentcontract_admin_email_session=${payload}.${signature}`;
}

async function createAgreement(key: string, recipientEmail: string) {
  const response = await appModule.app.request("https://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      recipient: { name: recipientEmail.split("@")[0], email: recipientEmail },
      document_markdown: "# Tenant Test\n\nHello {{recipient_name}}.",
      fields: [{ id: "signature", label: "Signature", type: "signature", required: true }]
    })
  });
  assert.equal(response.status, 201);
  return (await response.json() as { id: string }).id;
}

before(async () => {
  routeTestDir = await mkdtemp(join(tmpdir(), "agentcontract-tenant-"));
  process.env.DATABASE_PATH = join(routeTestDir, "agentcontract.db");
  process.env.AGENTCONTRACT_API_KEY = "ak_test_tenant_isolation";
  process.env.BASE_URL = "https://agentcontract.to";
  [appModule, apiKeysModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/lib/apiKeys.js")
  ]);

  keyA = (await apiKeysModule.createApiKey({ ownerEmail: ownerA, name: "Owner A" })).key;
  keyB = (await apiKeysModule.createApiKey({ ownerEmail: ownerB, name: "Owner B" })).key;
  agreementA = await createAgreement(keyA, "alice@example.com");
  agreementB = await createAgreement(keyB, "bob@example.com");
});

after(async () => {
  await rm(routeTestDir, { recursive: true, force: true });
});

test("user-owned API keys only list their own agreements", async () => {
  const responseA = await appModule.app.request("https://agentcontract.test/v1/agreements?limit=100", {
    headers: { authorization: `Bearer ${keyA}` }
  });
  assert.equal(responseA.status, 200);
  const listA = await responseA.json() as { agreements: Array<{ id: string; recipient: { email: string } }> };
  assert.deepEqual(listA.agreements.map((agreement) => agreement.id), [agreementA]);
  assert.equal(listA.agreements[0].recipient.email, "alice@example.com");

  const responseB = await appModule.app.request("https://agentcontract.test/v1/agreements?limit=100", {
    headers: { authorization: `Bearer ${keyB}` }
  });
  assert.equal(responseB.status, 200);
  const listB = await responseB.json() as { agreements: Array<{ id: string; recipient: { email: string } }> };
  assert.deepEqual(listB.agreements.map((agreement) => agreement.id), [agreementB]);
  assert.equal(listB.agreements[0].recipient.email, "bob@example.com");
});

test("user-owned API keys cannot read or mutate another owner's agreement", async () => {
  for (const path of [
    `/v1/agreements/${agreementB}`,
    `/v1/agreements/${agreementB}/document`,
    `/v1/agreements/${agreementB}/audit`,
    `/v1/agreements/${agreementB}/pdf`
  ]) {
    const response = await appModule.app.request(`https://agentcontract.test${path}`, {
      headers: { authorization: `Bearer ${keyA}` }
    });
    assert.equal(response.status, 404, path);
  }

  for (const path of [
    `/v1/agreements/${agreementB}/cancel`,
    `/v1/agreements/${agreementB}/remind`
  ]) {
    const response = await appModule.app.request(`https://agentcontract.test${path}`, {
      method: "POST",
      headers: authHeaders(keyA),
      body: JSON.stringify({})
    });
    assert.equal(response.status, 404, path);
  }
});

test("dashboard only renders agreements for the signed-in email session", async () => {
  const response = await appModule.app.request("https://agentcontract.test/dashboard", {
    headers: { cookie: adminEmailCookie(ownerA) }
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /alice@example\.com/);
  assert.doesNotMatch(html, /bob@example\.com/);
  assert.match(html, new RegExp(ownerA));
  assert.doesNotMatch(html, new RegExp(ownerB));
  assert.match(html, /href="\/templates\/filesystem-purchase-agreement"/);
});

test("specific dashboard templates default to the signed-in sender", async () => {
  for (const path of ["/templates/bear-privacy", "/templates/specific-contractor", "/templates/filesystem-purchase-agreement"]) {
    const response = await appModule.app.request(`https://agentcontract.test${path}`, {
      headers: { cookie: adminEmailCookie(ownerA) }
    });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, new RegExp(`name="sender_name" value="${ownerA}"`), path);
    assert.match(html, new RegExp(`name="sender_email" type="email" value="${ownerA}"`), path);
    assert.doesNotMatch(html, /name="sender_email" type="email" value="sid@usebear\.ai"/, path);
    assert.doesNotMatch(html, /name="sender_name" value="Sid from Specific"/, path);
  }
});

test("filesystem dashboard template uses recipient-first countersignature payload", async () => {
  const response = await appModule.app.request("https://agentcontract.test/templates/filesystem-purchase-agreement", {
    headers: { cookie: adminEmailCookie(ownerA) }
  });
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /Filesystem Purchase Agreement/);
  assert.match(html, /const senderSignatureRequired = true;/);
  assert.match(html, /const signingOrder = "recipient_first";/);
  assert.match(html, /"buyer_signature"/);
  assert.match(html, /sender_signature_required: senderSignatureRequired \|\| undefined/);
  assert.match(html, /signing_order: signingOrder \|\| undefined/);
});
