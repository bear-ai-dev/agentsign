import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { setup, cleanup, app, db, created, sessionPath, request, headers, bulk } from "./fixtures/provider-review.js";

const recipient = { name: 'Santosh <&"', email: "santosh@example.test" };
const fields = [
  { id: "full_name", label: "Full legal name", type: "text", required: true },
  { id: "seller_printed_name", label: "Seller printed legal name", type: "text" },
  { id: "seller_email", label: "Seller email", type: "email", required: true },
  { id: "account_email", label: "Associated account email", type: "text" },
  { id: "notification_email", label: "Notification email", type: "email" },
  { id: "company_name", label: "Company name", type: "text" },
  { id: "emergency_contact_name", label: "Emergency contact name", type: "text" },
  { id: "signature", label: "Signature", type: "signature", required: true },
  { id: "initials", label: "Initials", type: "initials", required: true },
  { id: "accept", label: "Accept agreement", type: "boolean", required: true }
];
const provider = "https://provider.example.test";
const parent = "https://parent.example.test";

before(() => setup());
after(cleanup);

async function signer(mode: "hosted" | "embedded", overrides: Record<string, unknown> = {}) {
  const agreement = await created({
    recipient, fields, document_markdown: "# Local signer prefill test\n\nReview your details before signing.",
    signing_mode: mode === "hosted" ? undefined : mode,
    allowed_parent_origins: mode === "hosted" ? undefined : [parent],
    ...overrides
  });
  // Legacy hosted agreements have no explicit prefill values.
  if (mode === "hosted" && !Object.hasOwn(overrides, "prefill_fields")) {
    await db.run("UPDATE agreements SET prefill_fields_json = NULL WHERE id = ?", agreement.id);
  }
  const path = mode === "embedded" ? await sessionPath(agreement.id) : new URL(agreement.signing_url!).pathname;
  return { ...agreement, path };
}

function input(html: string, name: string) {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`))?.[0];
  assert.ok(tag, `Missing input ${name}`);
  return tag;
}

for (const mode of ["hosted", "embedded"] as const) {
  test(`${mode} prefills known recipient details in the actual form without filling assent or unrelated fields`, async () => {
    const { id, path } = await signer(mode);
    const response = await request(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const name of ["full_name", "seller_printed_name"]) assert.match(input(html, name), /value="Santosh &lt;&amp;&quot;"/);
    for (const name of ["seller_email", "account_email"]) assert.match(input(html, name), /value="santosh@example.test"/);
    for (const name of ["notification_email", "company_name", "emergency_contact_name"]) assert.match(input(html, name), /value=""/);
    for (const name of ["full_name", "seller_email"]) assert.doesNotMatch(input(html, name), /\b(?:readonly|disabled)\b/);
    for (const name of ["signature", "initials"]) assert.doesNotMatch(input(html, name), /\bvalue=/);
    assert.doesNotMatch(html, /data-signature-input[^>]*\bvalue=/);
    const form = html.match(/<form id="sign-form"[\s\S]*?<\/form>/)![0];
    assert.doesNotMatch(form, /<input\b[^>]*type="checkbox"[^>]*\schecked(?:\s|=|>)/);
    assert.match(form, /id="submit"[^>]*\bdisabled/);
    assert.equal((await db.getAgreement(id))!.signed_fields_json, null);
  });

  test(`${mode} explicit prefills override defaults and an explicit empty value stays empty`, async () => {
    const { path } = await signer(mode, { prefill_fields: { full_name: "Confirmed Legal Name", seller_email: "preferred@example.test", seller_printed_name: "" } });
    const html = await (await request(path)).text();
    assert.match(input(html, "full_name"), /value="Confirmed Legal Name"/);
    assert.match(input(html, "seller_email"), /value="preferred@example.test"/);
    assert.match(input(html, "seller_printed_name"), /value=""/);
    assert.match(input(html, "account_email"), /value="santosh@example.test"/);
  });

  test(`${mode} sender form never receives the recipient's defaults`, async () => {
    const agreement = await signer(mode, {
      sender_email: "sender@example.test",
      fields: [
        { id: "signature", label: "Recipient signature", type: "signature", required: true },
        { id: "full_name", label: "Sender name", type: "text", required: true, signerRole: "sender" },
        { id: "email", label: "Sender email", type: "email", required: true, signerRole: "sender" },
        { id: "sender_signature", label: "Sender signature", type: "signature", required: true, signerRole: "sender" }
      ]
    });
    const stored = (await db.getAgreement(agreement.id))!;
    let path = `/sign/${stored.sender_signing_token}`;
    if (mode === "embedded") {
      const response = await request(`/v1/agreements/${agreement.id}/signing-sessions`, { method: "POST", headers: headers(), body: JSON.stringify({ parent_origin: parent, return_url: `${parent}/done`, signer_role: "sender" }) });
      assert.equal(response.status, 201);
      path = new URL((await response.json() as { session_url: string }).session_url).pathname;
    }
    const html = await (await request(path)).text();
    assert.match(input(html, "full_name"), /value=""/);
    assert.match(input(html, "email"), /value=""/);
  });

  test(`${mode} requires fresh signatures and consent and preserves editable email policy`, async () => {
    const { id, path } = await signer(mode);
    const submit = (values: Record<string, unknown>, consent_timestamp?: string) => request(`${path}/submit`, {
      method: "POST", headers: { "content-type": "application/json", origin: provider }, body: JSON.stringify({ fields: values, consent_timestamp })
    });
    const values = { full_name: "Confirmed Legal Name", seller_email: "edited@example.test", signature: "Santosh", initials: "SP", accept: true };
    assert.equal((await submit(values)).status, 400);
    assert.equal((await submit({ ...values, signature: "" }, new Date().toISOString())).status, 400);
    assert.equal((await submit({ ...values, initials: "" }, new Date().toISOString())).status, 400);
    assert.equal((await submit({ ...values, accept: false }, new Date().toISOString())).status, 400);
    assert.equal((await submit({ ...values, seller_email: "" }, new Date().toISOString())).status, 400);
    assert.equal((await db.getAgreement(id))!.signed_fields_json, null);
    // AgentSign has no recipient-email equality enforcement; edits remain valid.
    assert.equal((await submit(values, new Date().toISOString())).status, 200);
    const stored = (await db.getAgreement(id))!;
    assert.equal(stored.status, "completed");
    assert.equal(stored.recipient_email, "santosh@example.test");
    assert.equal(JSON.parse(stored.signed_fields_json!).seller_email, "edited@example.test");
    assert.equal(JSON.parse(stored.signed_fields_json!).full_name, "Confirmed Legal Name");
  });
}

test("embedded single and bulk creation send no provider invitations for any signing order", async (t) => {
  const { env } = await import("../src/lib/env.js");
  const originalKey = env.resendApiKey;
  env.resendApiKey = "re_local_invitation_transport_test";
  const deliveries: Array<{ to: string[]; cc?: string[] }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    deliveries.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "local-email-transport" }), { status: 200 });
  });
  try {
    for (const order of ["parallel", "recipient_first", "sender_first"]) {
      const body = { recipient, fields, signing_mode: "embedded", allowed_parent_origins: [parent], sender_email: "sender@example.test", sender_signature_required: true, signing_order: order, cc: ["cc@example.test"], notification_email: "notify@example.test" };
      await created(body);
      const response = await bulk({ ...body, document_markdown: "# Local invitation test", recipients: [recipient, { name: "Second Recipient", email: "second@example.test" }] });
      assert.equal(response.status, 201);
      assert.deepEqual(deliveries, [], `Embedded ${order} creation sent an email`);
    }
    // A hosted control proves the real invitation path uses this transport.
    await created({ recipient, fields, signing_mode: "hosted", allowed_parent_origins: undefined, sender_email: "sender@example.test", sender_signature_required: true });
    assert.deepEqual(deliveries.map((email) => email.to), [["santosh@example.test"], ["sender@example.test"]]);
  } finally { env.resendApiKey = originalKey; }
});

test("hosted and embedded browser forms show editable defaults and keep assent blank on desktop and mobile", async () => {
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    for (const mode of ["hosted", "embedded"] as const) for (const width of [1280, 320]) {
      const { id, path } = await signer(mode);
      const page = await browser.newPage();
      await page.setViewport({ width, height: 1000 });
      await page.setRequestInterception(true);
      page.on("request", async (incoming) => {
        if (new URL(incoming.url()).origin === parent) {
          await incoming.respond({ contentType: "text/html", body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><iframe style="width:100%;height:980px;border:0" src="${provider}${path}"></iframe><script>window.received=[];window.addEventListener('message',event=>window.received.push({origin:event.origin,data:event.data}));</script></body></html>` });
        } else if (new URL(incoming.url()).origin === provider) {
          const response = await app.request(incoming.url(), { method: incoming.method(), headers: incoming.headers(), body: incoming.postData() });
          await incoming.respond({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
        } else await incoming.abort();
      });
      await page.goto(mode === "embedded" ? `${parent}/signing` : `${provider}${path}`, { waitUntil: "networkidle0" });
      const frame = mode === "embedded" ? page.frames().find((item) => item.url().startsWith(provider))! : page.mainFrame();
      await frame.waitForSelector("#sign-form");
      const state = await frame.evaluate(() => {
        return { name: (document.querySelector('[name="full_name"]') as HTMLInputElement).value, email: (document.querySelector('[name="seller_email"]') as HTMLInputElement).value, signature: (document.querySelector('[name="signature"]') as HTMLInputElement).value, initials: (document.querySelector('[name="initials"]') as HTMLInputElement).value, accept: (document.querySelector('[name="accept"]') as HTMLInputElement).checked, consent: (document.querySelector("#consent") as HTMLInputElement).checked, disabled: (document.querySelector("#submit") as HTMLButtonElement).disabled, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(state, { name: 'Santosh <&"', email: "santosh@example.test", signature: "", initials: "", accept: false, consent: false, disabled: true, overflow: false });
      await page.screenshot({ path: `/tmp/agentsign-signer-prefill-${mode}-${width}.png`, fullPage: true });
      const rejectCookies = await frame.$('[data-c15t-action="reject"]');
      if (rejectCookies && await rejectCookies.isVisible()) await rejectCookies.click();
      await frame.$eval('[name="full_name"]', (element) => { (element as HTMLInputElement).value = ""; });
      await frame.type('[name="full_name"]', "Confirmed Legal Name");
      await frame.type("#field-signature-typed", "Santosh");
      await frame.type("#field-initials-typed", "SP");
      await frame.click('[name="accept"]');
      assert.equal(await frame.$eval("#submit", (element) => (element as HTMLButtonElement).disabled), true);
      await frame.click("#consent");
      assert.equal(await frame.$eval("#submit", (element) => (element as HTMLButtonElement).disabled), false);
      if (mode === "hosted") {
        await Promise.all([page.waitForNavigation(), frame.click("#submit")]);
        assert.equal(new URL(page.url()).pathname, `${path}/pdf`);
      } else {
        await frame.click("#submit");
        await page.waitForFunction(() => (window as unknown as { received: unknown[] }).received.length > 0);
        assert.deepEqual(await page.evaluate(() => (window as unknown as { received: unknown[] }).received), [{ origin: provider, data: { type: "agentcontract:completed", agreement_id: id } }]);
      }
      const stored = (await db.getAgreement(id))!;
      assert.equal(stored.status, "completed");
      assert.equal(JSON.parse(stored.signed_fields_json!).full_name, "Confirmed Legal Name");
      assert.equal(JSON.parse(stored.signed_fields_json!).seller_email, "santosh@example.test");
      await page.close();
    }
  } finally { await browser.close(); }
});
