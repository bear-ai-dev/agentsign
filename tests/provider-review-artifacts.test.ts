import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import test, { before, after } from "node:test";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import { setup, cleanup, created, request, headers, db, sourcePdf, sessionPath, submit, dashboardHeaders } from "./fixtures/provider-review.js";

before(() => setup());
after(cleanup);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dashboard = (id: string) => request(`/dashboard/agreements/${id}/pdf`, { headers: dashboardHeaders() });
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("dashboard serves the exact original nine-page PDF before signing and after a partial signature", async () => {
  const { id } = await created({ document_pdf_base64: sourcePdf.toString("base64"), fields: [{ id: "signature", label: "Talent", type: "signature", required: true }, { id: "client", label: "Client", type: "signature", signerRole: "sender", required: true }], sender_email: "client@example.test" });
  for (const partial of [false, true]) {
    if (partial) assert.equal((await submit(await sessionPath(id))).status, 200);
    const response = await dashboard(id);
    assert.equal(response.status, 200);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.ok(buffer.equals(sourcePdf));
    assert.equal((await PDFDocument.load(buffer)).getPageCount(), 9);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
});

test("completed dashboard downloads use verified database bytes despite overwritten or missing local files", async () => {
  const { id } = await created({ document_pdf_base64: sourcePdf.toString("base64") });
  assert.equal((await submit(await sessionPath(id))).status, 200);
  const agreement = (await db.getAgreement(id))!;
  const committed = Buffer.from(agreement.signed_pdf_base64!, "base64");
  assert.ok((await PDFDocument.load(committed)).getPageCount() > 9);
  for (const missing of [false, true]) {
    if (missing) await rm(agreement.signed_pdf_path!, { force: true });
    else await writeFile(agreement.signed_pdf_path!, sourcePdf);
    const response = await dashboard(id);
    assert.equal(response.status, 200);
    assert.equal(hash(new Uint8Array(await response.arrayBuffer())), hash(committed));
  }
});

test("dashboard refuses corrupted committed PDF bytes and source bytes", async () => {
  const { id } = await created({ document_pdf_base64: sourcePdf.toString("base64") });
  await db.run("UPDATE agreements SET source_pdf_sha256 = ? WHERE id = ?", "0".repeat(64), id);
  assert.equal((await dashboard(id)).status, 500);
  const completed = await created();
  assert.equal((await submit(await sessionPath(completed.id))).status, 200);
  await db.run("UPDATE agreements SET signed_pdf_sha256 = ? WHERE id = ?", "0".repeat(64), completed.id);
  assert.equal((await dashboard(completed.id)).status, 500);
});

test("completed file fallback cannot replace an existing artifact hash with different bytes", async () => {
  const { id } = await created({ document_pdf_base64: sourcePdf.toString("base64") });
  assert.equal((await submit(await sessionPath(id))).status, 200);
  const agreement = (await db.getAgreement(id))!;
  await db.run("UPDATE agreements SET signed_pdf_base64 = NULL WHERE id = ?", id);
  await writeFile(agreement.signed_pdf_path!, sourcePdf);
  assert.equal((await dashboard(id)).status, 500);
  assert.equal((await db.getAgreement(id))!.signed_pdf_sha256, agreement.signed_pdf_sha256);
  await rm(agreement.signed_pdf_path!, { force: true });
  assert.equal((await dashboard(id)).status, 500);
  assert.equal((await db.getAgreement(id))!.signed_pdf_sha256, agreement.signed_pdf_sha256);
});

for (const source of [false, true]) test(`rejected delayed ${source ? "source" : "markdown"} render cannot overwrite the winning published artifact`, async (t) => {
  const { id } = await created(source ? { document_pdf_base64: sourcePdf.toString("base64") } : {});
  const loserPath = await sessionPath(id);
  const winnerPath = await sessionPath(id);
  const rendering = signal();
  const release = signal();
  const original = puppeteer.launch.bind(puppeteer);
  let first = true;
  const mocked = t.mock.method(puppeteer, "launch", async (...args: Parameters<typeof puppeteer.launch>) => {
    if (first) { first = false; rendering.resolve(); await release.promise; }
    return original(...args);
  });
  const loser = submit(loserPath, "LOSER");
  try {
    await rendering.promise;
    assert.equal((await submit(winnerPath, "WINNER")).status, 200);
    const winner = (await db.getAgreement(id))!;
    await db.run("UPDATE agreement_signing_sessions SET expires_at = ? WHERE token_hash = ?", "2000-01-01T00:00:00.000Z", createHash("sha256").update(loserPath.split("/").at(-1)!).digest("hex"));
    release.resolve();
    assert.equal((await loser).status, 409);
    const stored = (await db.getAgreement(id))!;
    assert.equal(JSON.parse(stored.signed_fields_json!).signature.typed_name, "WINNER");
    assert.equal(hash(await readFile(stored.signed_pdf_path!)), winner.signed_pdf_sha256);
    for (const response of [await dashboard(id), await request(`/v1/agreements/${id}/documents/signed`, { headers: headers() })]) {
      assert.equal(response.status, 200);
      assert.equal(hash(new Uint8Array(await response.arrayBuffer())), winner.signed_pdf_sha256);
    }
    const events = await db.getAuditEvents(id);
    assert.equal(events.filter((event) => event.event_type === "signed").length, 1);
    assert.equal(events.filter((event) => event.event_type === "completed").length, 1);
  } finally { release.resolve(); await loser; mocked.mock.restore(); }
});
