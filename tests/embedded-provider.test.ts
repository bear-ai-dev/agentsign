import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test, { after, before } from "node:test";
import { PDFDocument } from "pdf-lib";

let directory = "";
let app: typeof import("../src/app.js").app;
let db: typeof import("../src/lib/db.js");
let ownerKey = "";
let otherKey = "";
let sourcePdf: Buffer;
const provider = "https://agentcontract.test";
const parent = "https://app.example.test";
const fields = [
  { id: "full_name", label: "Full name", type: "text", required: true },
  { id: "signature", label: "Signature", type: "signature", required: true },
  { id: "initials", label: "Initials", type: "initials", required: true },
  { id: "accept", label: "Accept", type: "boolean", required: true }
];
const payload = () => ({ recipient: { name: "Talent", email: "talent@example.test" }, document_markdown: "# Consent\n\nName {{signed:full_name}}", fields, signing_mode: "embedded", allowed_parent_origins: [parent], prefill_fields: { full_name: 'Talent <&"' } });
const headers = (key = ownerKey) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
const request = (path: string, init?: RequestInit) => app.request(`${provider}${path}`, init);
const create = (overrides: Record<string, unknown> = {}, key = ownerKey) => request("/v1/agreements", { method: "POST", headers: headers(key), body: JSON.stringify({ ...payload(), ...overrides }) });
async function created(overrides: Record<string, unknown> = {}) {
  const response = await create(overrides);
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as { id: string; signing_url: string | null; preview_url: string | null; sender_signing_url: string | null; signing_mode: string };
}
async function session(id: string, overrides: Record<string, unknown> = {}, key = ownerKey) {
  return request(`/v1/agreements/${id}/signing-sessions`, { method: "POST", headers: headers(key), body: JSON.stringify({ parent_origin: parent, return_url: `${parent}/done`, ...overrides }) });
}
async function sessionPath(id: string, overrides: Record<string, unknown> = {}) {
  const response = await session(id, overrides);
  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json() as { session_url: string; expires_at: string; origin: string };
  assert.equal(body.origin, provider);
  assert.ok(Math.abs(Date.parse(body.expires_at) - Date.now() - 600_000) < 2_000);
  return new URL(body.session_url).pathname;
}
const submit = (path: string, values: Record<string, unknown>, origin: string | undefined = provider) => request(`${path}/submit`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ fields: values, consent_timestamp: "2026-10-02T10:00:00.000Z" }) });
const signed = { full_name: "Talent", signature: "Talent", initials: "TP", accept: true };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "embedded-provider-"));
  Object.assign(process.env, { DOTENV_CONFIG_PATH: "/dev/null", DATABASE_PATH: join(directory, "provider.db"), DATABASE_URL: process.env.AGENTCONTRACT_TEST_DATABASE_URL ?? "", PDF_OUTPUT_DIR: join(directory, "pdfs"), AGENTCONTRACT_API_KEY: "embedded-test-bootstrap", BASE_URL: provider, RESEND_API_KEY: "", NODE_ENV: "test", VERCEL: "", WORKOS_COOKIE_PASSWORD: "embedded-provider-test-cookie-password", POSTHOG_API_KEY: "" });
  if (process.env.DATABASE_URL) assert.equal(new URL(process.env.DATABASE_URL).hostname, "localhost");
  ({ app } = await import("../src/app.js"));
  db = await import("../src/lib/db.js");
  const { createApiKey } = await import("../src/lib/apiKeys.js");
  ownerKey = (await createApiKey({ ownerEmail: "owner@example.test", name: "Owner" })).key;
  otherKey = (await createApiKey({ ownerEmail: "other@example.test", name: "Other" })).key;
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 9; page++) pdf.addPage().drawText(`Page ${page}`);
  sourcePdf = Buffer.from(await pdf.save());
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

test("embedded creation, listing, dashboard and reminders never expose persistent capabilities", async () => {
  const agreement = await created();
  assert.equal(agreement.signing_mode, "embedded");
  assert.equal(agreement.signing_url, null);
  assert.equal(agreement.preview_url, null);
  assert.equal(agreement.sender_signing_url, null);
  const stored = (await db.getAgreement(agreement.id))!;
  for (const path of [`/v1/agreements/${agreement.id}`, "/v1/agreements?limit=100"]) {
    const text = await (await request(path, { headers: headers() })).text();
    assert.ok(!text.includes(stored.signing_token));
  }
  const cookiePayload = Buffer.from(JSON.stringify({ email: "owner@example.test", exp: Date.now() + 60_000 })).toString("base64url");
  const cookieSignature = createHmac("sha256", process.env.WORKOS_COOKIE_PASSWORD!).update(cookiePayload).digest("base64url");
  const dashboard = await request("/dashboard", { headers: { cookie: `agentcontract_admin_email_session=${cookiePayload}.${cookieSignature}` } });
  assert.equal(dashboard.status, 200);
  assert.ok(!(await dashboard.text()).includes(stored.signing_token));
  const reminder = await request(`/v1/agreements/${agreement.id}/remind`, { method: "POST", headers: headers() });
  assert.equal(reminder.status, 409);
  assert.match(await reminder.text(), /session/i);
});

test("persistent tokens cannot sign, preview or download embedded documents in either role", async () => {
  const agreement = await created({ sender_email: "client@example.test", sender_signature_required: true, document_pdf_base64: sourcePdf.toString("base64") });
  const stored = (await db.getAgreement(agreement.id))!;
  for (const token of [stored.signing_token, stored.sender_signing_token]) {
    if (!token) continue;
    for (const path of [`/sign/${token}`, `/preview/${token}`, `/sign/${token}/source.pdf`, `/sign/${token}/pdf`]) assert.equal((await request(path)).status, 404, path);
    assert.equal((await submit(`/sign/${token}`, signed)).status, 404);
  }
});

test("embedded options survive bulk creation", async () => {
  const response = await request("/v1/agreements/bulk", { method: "POST", headers: headers(), body: JSON.stringify({ ...payload(), recipients: [payload().recipient] }) });
  assert.equal(response.status, 201);
  const body = await response.json() as { agreements: Array<{ signing_mode: string; signing_url: string | null }> };
  assert.equal(body.agreements[0].signing_mode, "embedded");
  assert.equal(body.agreements[0].signing_url, null);
});

test("prefill rejects assent, sender, unknown and malformed fields before creating rows", async () => {
  for (const prefill of [{ signature: "Talent" }, { initials: "TP" }, { accept: true }, { unknown: "value" }, { full_name: { signed: true } }, []]) {
    const response = await create({ prefill_fields: prefill });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /prefill/i);
  }
  const response = await create({ fields: [{ id: "sender_name", label: "Client name", type: "text", signerRole: "sender" }], sender_email: "client@example.test", prefill_fields: { sender_name: "Client" } });
  assert.equal(response.status, 400);
});

test("origins require exact canonical HTTP origins with no wildcard or URL components", async () => {
  for (const origin of ["*", "null", "https://*.example.test", `${parent}/`, `${parent}/path`, `${parent}?q=1`, `${parent}#x`, "https://user:pass@app.example.test", "http://public.example.test", "javascript:alert(1)", "https://APP.example.test"]) {
    const response = await create({ allowed_parent_origins: [origin] });
    assert.equal(response.status, 400, origin);
  }
  assert.equal((await create({ allowed_parent_origins: [] })).status, 400);
  assert.equal((await create({ signing_mode: "unknown" })).status, 400);
});

test("idempotency deduplicates concurrent retries, rejects changed payload and isolates owners", async () => {
  const key = "creation-retry";
  const responses = await Promise.all(Array.from({ length: 6 }, () => create({ idempotency_key: key })));
  for (const response of responses) assert.equal(response.status, 201);
  const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>));
  assert.equal(new Set(bodies.map((body) => body.id)).size, 1);
  assert.equal((await create({ idempotency_key: key, document_markdown: "# Different" })).status, 409);
  const other = await create({ idempotency_key: key }, otherKey);
  assert.equal(other.status, 201);
  assert.notEqual((await other.json() as { id: string }).id, bodies[0].id);
  const events = await db.getAuditEvents(bodies[0].id);
  assert.equal(events.filter((event) => event.event_type === "created").length, 1);
});

test("session minting requires API authentication, agreement ownership and allowlisted return origin", async () => {
  const { id } = await created();
  assert.equal((await request(`/v1/agreements/${id}/signing-sessions`, { method: "POST" })).status, 401);
  assert.equal((await session(id, {}, otherKey)).status, 404);
  for (const overrides of [{ parent_origin: "https://evil.example.test" }, { return_url: "https://evil.example.test/done" }, { return_url: `https://user:pass@app.example.test/done` }, { parent_origin: `${parent}/` }, { signer_role: "admin" }]) assert.equal((await session(id, overrides)).status, 400);
  const legacy = await created({ signing_mode: undefined, allowed_parent_origins: undefined });
  assert.equal((await session(legacy.id)).status, 409);
});

test("sessions render nonassent prefill, exact frame ancestors and safe completion message", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  const page = await request(path);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), `frame-ancestors ${parent}`);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("cache-control")!, /no-store/);
  const html = await page.text();
  assert.match(html, /value="Talent &lt;&amp;&quot;"/);
  assert.doesNotMatch(html.match(/<form id="sign-form"[\s\S]*?<\/form>/)![0], /<input\b[^>]*type="checkbox"[^>]*\schecked(?:\s|=|>)/);
  assert.doesNotMatch(html, /data-signature-input[^>]*value=/);
  assert.equal((await submit(path, { signature: "Talent", initials: "TP", accept: true })).status, 400);
  assert.equal((await db.getAgreement(id))!.signed_fields_json, null);
  const completed = await submit(path, signed);
  assert.equal(completed.status, 200);
  const result = await completed.json() as { completed: boolean; signed_pdf_url: string | null };
  assert.equal(result.completed, true);
  assert.equal(result.signed_pdf_url, null);
  const success = await (await request(path)).text();
  const scripts = [...success.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const messages: unknown[] = [];
  const location = { href: "" };
  for (const script of scripts.filter((value) => value.includes("postMessage"))) runInNewContext(script, { window: { parent: { postMessage: (message: unknown, origin: string) => messages.push({ message: JSON.parse(JSON.stringify(message)), origin }) }, location } });
  assert.deepEqual(messages, [{ message: { type: "agentcontract:completed", agreement_id: id }, origin: parent }]);
  assert.doesNotMatch(success, /\/pdf|Download PDF/);
});

test("embedded submissions reject foreign, missing and opaque Origin headers", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  for (const origin of ["https://evil.example.test", parent, "null", ""]) assert.equal((await submit(path, signed, origin)).status, 403);
  assert.equal((await db.getAgreement(id))!.signed_fields_json, null);
});

test("expired sessions reject every signing, preview and token artifact path", async () => {
  const { id } = await created({ document_pdf_base64: sourcePdf.toString("base64") });
  const path = await sessionPath(id);
  await db.run("UPDATE agreement_signing_sessions SET expires_at = ? WHERE agreement_id = ?", "2000-01-01T00:00:00.000Z", id);
  const token = path.split("/").at(-1)!;
  for (const suffix of ["", "/pdf", "/source.pdf"]) assert.equal((await request(`${path}${suffix}`)).status, 404);
  assert.equal((await request(`/preview/${token}`)).status, 404);
  assert.equal((await submit(path, signed)).status, 404);
});

test("cancelled, declined and expired agreements cannot issue or use sessions", async () => {
  for (const status of ["cancelled", "declined", "expired"] as const) {
    const { id } = await created();
    const path = await sessionPath(id);
    await db.run("UPDATE agreements SET status = ? WHERE id = ?", status, id);
    assert.equal((await session(id)).status, 409);
    assert.equal((await request(path)).status, 410);
    assert.equal((await submit(path, signed)).status, 410);
  }
});

test("role scoped sessions enforce signing order, duplicate prevention and both signatures", async () => {
  const { id } = await created({ fields: [{ id: "talent", label: "Talent signature", type: "signature", required: true }, { id: "client", label: "Client signature", type: "signature", required: true, signerRole: "sender" }], prefill_fields: {}, sender_email: "client@example.test", signing_order: "recipient_first" });
  const talent = await sessionPath(id);
  const client = await sessionPath(id, { signer_role: "sender" });
  assert.equal((await submit(client, { client: "Client" })).status, 409);
  assert.equal((await submit(talent, { client: "Forged" })).status, 400);
  const first = await submit(talent, { talent: "Talent", client: "Forged" });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { completed: boolean }).completed, false);
  assert.ok(!(await db.getAgreement(id))!.signed_fields_json!.includes("Forged"));
  assert.equal((await submit(talent, { talent: "Again" })).status, 409);
  assert.equal((await submit(client, { client: "Client" })).status, 200);
  assert.equal((await db.getAgreement(id))!.status, "completed");
});

test("authenticated artifact endpoints keep source exact and final PDF and certificate private", async () => {
  const { id } = await created({ document_pdf_base64: sourcePdf.toString("base64") });
  for (const kind of ["source", "signed", "certificate"]) {
    assert.equal((await request(`/v1/agreements/${id}/documents/${kind}`)).status, 401);
    assert.equal((await request(`/v1/agreements/${id}/documents/${kind}`, { headers: headers(otherKey) })).status, 404);
  }
  const source = await request(`/v1/agreements/${id}/documents/source`, { headers: headers() });
  assert.equal(source.status, 200);
  assert.ok(Buffer.from(await source.arrayBuffer()).equals(sourcePdf));
  for (const kind of ["signed", "certificate"]) assert.equal((await request(`/v1/agreements/${id}/documents/${kind}`, { headers: headers() })).status, 409);
  const path = await sessionPath(id);
  assert.equal((await submit(path, signed)).status, 200);
  const pdf = await request(`/v1/agreements/${id}/documents/signed`, { headers: headers() });
  const signedPdf = await PDFDocument.load(await pdf.arrayBuffer());
  assert.ok(signedPdf.getPageCount() > 9);
  const certificate = await request(`/v1/agreements/${id}/documents/certificate`, { headers: headers() });
  assert.equal(certificate.status, 200);
  assert.ok((await PDFDocument.load(await certificate.arrayBuffer())).getPageCount() >= 1);
  assert.match(certificate.headers.get("cache-control")!, /no-store/);
  assert.equal((await request(`${path}/pdf`)).status, 403);
});

test("legacy hosted agreements retain stable signing and source download", async () => {
  const legacy = await created({ signing_mode: undefined, allowed_parent_origins: undefined, prefill_fields: undefined, document_pdf_base64: sourcePdf.toString("base64") });
  const path = new URL(legacy.signing_url!).pathname;
  assert.equal((await request(path)).status, 200);
  assert.equal((await request(`${path}/source.pdf`)).status, 200);
});

test("embedded agreements require an explicit required signature for each signer role", async () => {
  for (const invalidFields of [
    [{ id: "full_name", label: "Name", type: "text", required: true }],
    [{ id: "signature", label: "Signature", type: "signature", required: false }],
    [{ id: "signature", label: "Signature", type: "signature", required: true }, { id: "client_name", label: "Client name", type: "text", signerRole: "sender", required: true }]
  ]) {
    const response = await create({ fields: invalidFields, prefill_fields: {}, sender_email: "client@example.test" });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /required signature/i);
  }
});

test("embedded checkbox assent and consent timestamps cannot be forged through truthy values", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  for (const accept of ["false", "true", 1, {}, []]) assert.equal((await submit(path, { ...signed, accept })).status, 400);
  const response = await request(`${path}/submit`, { method: "POST", headers: { "content-type": "application/json", origin: provider }, body: JSON.stringify({ fields: signed, consent_timestamp: "unverified" }) });
  assert.equal(response.status, 400);
  assert.equal((await db.getAgreement(id))!.signed_fields_json, null);
});

test("concurrent submissions commit one signature and one completion", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  const responses = await Promise.all([submit(path, signed), submit(path, signed)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const events = await db.getAuditEvents(id);
  assert.equal(events.filter((event) => event.event_type === "signed").length, 1);
  assert.equal(events.filter((event) => event.event_type === "completed").length, 1);
});

test("cancellation during PDF generation cannot resurrect an agreement", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  const pending = submit(path, signed);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await db.run("UPDATE agreements SET status = 'cancelled' WHERE id = ?", id);
  assert.ok([409, 410].includes((await pending).status));
  const agreement = (await db.getAgreement(id))!;
  assert.equal(agreement.status, "cancelled");
  assert.equal(agreement.signed_fields_json, null);
  assert.equal((await db.getAuditEvents(id)).filter((event) => event.event_type === "completed").length, 0);
});

test("session expiry during PDF generation cannot commit completion", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  const pending = submit(path, signed);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await db.run("UPDATE agreement_signing_sessions SET expires_at = ? WHERE agreement_id = ?", "2000-01-01T00:00:00.000Z", id);
  assert.ok([404, 409].includes((await pending).status));
  assert.equal((await db.getAgreement(id))!.signed_fields_json, null);
});

test("session bearer values are hashed and never included in API agreement or audit responses", async () => {
  const { id } = await created();
  const path = await sessionPath(id);
  const token = path.split("/").at(-1)!;
  const stored = await db.get<{ token_hash: string }>("SELECT token_hash FROM agreement_signing_sessions WHERE agreement_id = ?", id);
  assert.equal(stored!.token_hash.length, 64);
  assert.notEqual(stored!.token_hash, token);
  assert.ok(!(await (await request(`/v1/agreements/${id}`, { headers: headers() })).text()).includes(token));
});

test("ownerless stored keys cannot mint sessions or retrieve embedded artifacts", async () => {
  const { createApiKey } = await import("../src/lib/apiKeys.js");
  const key = (await createApiKey({ name: "Ownerless" })).key;
  const { id } = await created({ document_pdf_base64: sourcePdf.toString("base64") });
  assert.equal((await session(id, {}, key)).status, 404);
  for (const kind of ["source", "signed", "certificate"]) assert.equal((await request(`/v1/agreements/${id}/documents/${kind}`, { headers: headers(key) })).status, 404);
});

test("embedded signer works in a desktop and mobile iframe and sends completion to its exact parent", async () => {
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    for (const width of [1280, 320]) {
      const { id } = await created();
      const path = await sessionPath(id);
      const page = await browser.newPage();
      await page.setViewport({ width, height: 900 });
      await page.setRequestInterception(true);
      page.on("request", async (incoming) => {
        if (new URL(incoming.url()).origin === parent) {
          await incoming.respond({ contentType: "text/html", body: `<html><body style="margin:0"><iframe title="Sign agreement" style="width:100%;height:880px;border:0" src="${provider}${path}"></iframe><script>window.received=[];window.addEventListener('message',event=>window.received.push({origin:event.origin,data:event.data}));</script></body></html>` });
        } else if (new URL(incoming.url()).origin === provider) {
          const response = await app.request(incoming.url(), { method: incoming.method(), headers: incoming.headers(), body: incoming.postData() });
          await incoming.respond({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
        } else await incoming.abort();
      });
      await page.goto(`${parent}/signing`, { waitUntil: "networkidle0" });
      const frame = page.frames().find((item) => item.url().startsWith(provider))!;
      await frame.waitForSelector("#sign-form");
      const rejectCookies = await frame.$('[data-c15t-action="reject"]');
      if (rejectCookies && await rejectCookies.isVisible()) await rejectCookies.click();
      const initial = await frame.evaluate(() => ({ name: (document.querySelector('[name="full_name"]') as HTMLInputElement).value, signature: (document.querySelector('[name="signature"]') as HTMLInputElement).value, assent: (document.querySelector('[name="accept"]') as HTMLInputElement).checked, consent: (document.querySelector("#consent") as HTMLInputElement).checked, overflow: document.documentElement.scrollWidth > window.innerWidth }));
      assert.equal(initial.name, 'Talent <&"');
      assert.equal(initial.signature, "");
      assert.equal(initial.assent, false);
      assert.equal(initial.consent, false);
      assert.equal(initial.overflow, false);
      await page.screenshot({ path: `/tmp/agentsign-provider-${width}.png`, fullPage: true });
      await frame.type("#field-signature-typed", "Talent");
      await frame.type("#field-initials-typed", "TP");
      await frame.click('[name="accept"]');
      await frame.click("#consent");
      assert.equal(await frame.evaluate(() => (document.querySelector("#submit") as HTMLButtonElement).disabled), false);
      await frame.click("#submit");
      await page.waitForFunction(() => (window as unknown as { received: unknown[] }).received.length > 0, { timeout: 15_000 });
      const messages = await page.evaluate(() => (window as unknown as { received: unknown[] }).received);
      assert.deepEqual(messages, [{ origin: provider, data: { type: "agentcontract:completed", agreement_id: id } }]);
      assert.equal((await db.getAgreement(id))!.status, "completed");
      await page.close();
    }
  } finally { await browser.close(); }
});
