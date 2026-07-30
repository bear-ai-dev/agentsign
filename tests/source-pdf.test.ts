import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { PDFDocument } from "pdf-lib";

let routeTestDir = "";
let appModule: typeof import("../src/app.js");

const apiKey = "ak_test_source_pdf";

function tokenFromSigningUrl(url: string) {
  return new URL(url).pathname.split("/").filter(Boolean).at(-1)!;
}

async function buildSourcePdf() {
  const document = await PDFDocument.create();
  const first = document.addPage([595.28, 841.89]);
  first.drawText("Engagement and Release Agreement", { x: 60, y: 780, size: 18 });
  const second = document.addPage([595.28, 841.89]);
  second.drawText("Signature page", { x: 60, y: 780, size: 14 });
  return Buffer.from(await document.save());
}

before(async () => {
  routeTestDir = await mkdtemp(join(tmpdir(), "agentcontract-source-pdf-"));
  process.env.DATABASE_PATH = join(routeTestDir, "agentcontract.db");
  process.env.PDF_OUTPUT_DIR = join(routeTestDir, "pdfs");
  process.env.AGENTCONTRACT_API_KEY = apiKey;
  process.env.BASE_URL = "https://agentcontract.to";
  appModule = await import("../src/app.js");
});

after(async () => {
  await rm(routeTestDir, { recursive: true, force: true });
});

test("source PDF agreements serve the exact original bytes and sign into a merged PDF", async () => {
  const sourcePdf = await buildSourcePdf();
  const sourceSha256 = createHash("sha256").update(sourcePdf).digest("hex");
  const sourcePageCount = (await PDFDocument.load(sourcePdf)).getPageCount();

  const createResponse = await appModule.app.request("https://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      recipient: { name: "Talent Person", email: "talent@example.com" },
      document_pdf_base64: sourcePdf.toString("base64"),
      document_pdf_filename: "engagement-release.pdf",
      document_title: "Engagement and Release Agreement",
      fields: [
        { id: "talent_print_name", label: "Talent print name", type: "text", required: true },
        { id: "date_signed", label: "Date signed", type: "date", required: true },
        { id: "signature", label: "Talent signature", type: "signature", required: true }
      ]
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string; signing_url: string };
  const token = tokenFromSigningUrl(created.signing_url);

  const showResponse = await appModule.app.request(`https://agentcontract.test/v1/agreements/${created.id}`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  const shown = await showResponse.json() as {
    document_title: string;
    source_pdf: { filename: string; sha256: string; bytes: number } | null;
  };
  assert.equal(shown.document_title, "Engagement and Release Agreement");
  assert.equal(shown.source_pdf?.sha256, sourceSha256);
  assert.equal(shown.source_pdf?.bytes, sourcePdf.byteLength);
  assert.equal(shown.source_pdf?.filename, "engagement-release.pdf");

  const signPageResponse = await appModule.app.request(`https://agentcontract.test/sign/${token}`);
  assert.equal(signPageResponse.status, 200);
  const signPageHtml = await signPageResponse.text();
  assert.match(signPageHtml, /pdf-viewer/);
  assert.match(signPageHtml, new RegExp(`/sign/${token}/source\\.pdf`));

  const sourceResponse = await appModule.app.request(`https://agentcontract.test/sign/${token}/source.pdf`);
  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceResponse.headers.get("content-type"), "application/pdf");
  const servedSource = Buffer.from(await sourceResponse.arrayBuffer());
  assert.ok(servedSource.equals(sourcePdf), "served source PDF must be byte-identical to the uploaded PDF");

  const ownerSourceResponse = await appModule.app.request(`https://agentcontract.test/v1/agreements/${created.id}/source-pdf`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  assert.equal(ownerSourceResponse.status, 200);
  assert.ok(Buffer.from(await ownerSourceResponse.arrayBuffer()).equals(sourcePdf));

  const submitResponse = await appModule.app.request(`https://agentcontract.test/sign/${token}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      consent_timestamp: new Date().toISOString(),
      fields: {
        talent_print_name: "Talent Person",
        date_signed: "2026-07-30",
        signature: "Talent Person"
      }
    })
  });
  assert.equal(submitResponse.status, 200);
  const submitted = await submitResponse.json() as { completed: boolean; signed_pdf_url: string };
  assert.equal(submitted.completed, true);

  const signedPdfResponse = await appModule.app.request(`https://agentcontract.test/sign/${token}/pdf`);
  assert.equal(signedPdfResponse.status, 200);
  const signedPdf = Buffer.from(await signedPdfResponse.arrayBuffer());
  assert.equal(signedPdf.subarray(0, 5).toString("latin1"), "%PDF-");

  const signedDocument = await PDFDocument.load(signedPdf);
  assert.ok(
    signedDocument.getPageCount() > sourcePageCount,
    "signed PDF must contain the original pages plus an appended signature certificate"
  );
  for (let index = 0; index < sourcePageCount; index += 1) {
    const { width, height } = signedDocument.getPage(index).getSize();
    assert.equal(Math.round(width), 595);
    assert.equal(Math.round(height), 842);
  }
});

test("create rejects non-PDF base64 payloads", async () => {
  const response = await appModule.app.request("https://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      recipient: { name: "Talent Person", email: "talent@example.com" },
      document_pdf_base64: Buffer.from("not a pdf").toString("base64"),
      fields: []
    })
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /%PDF-/);
});
