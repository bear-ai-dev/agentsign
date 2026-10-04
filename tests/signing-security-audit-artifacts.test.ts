import assert from "node:assert/strict";
import test from "node:test";
import { signingAuditFixture } from "./helpers/signing-security-audit-module.js";

for (const corruption of ["hash", "length", "missing"] as const) test(`markdown certificate refuses ${corruption} signed artifact corruption`, async () => {
  const { state, artifacts, storage } = signingAuditFixture();
  const original = Buffer.from("signed-pdf");
  Object.assign(state.agreement, { status: "completed", signed_pdf_base64: corruption === "missing" ? null : original.toString("base64"), signed_pdf_sha256: corruption === "hash" ? storage.pdfSha256(Buffer.from("different")) : storage.pdfSha256(original), signed_pdf_bytes: corruption === "length" ? original.length + 1 : original.length });
  await assert.rejects(artifacts.certificateBufferForAgreement(state.agreement), /Stored signed PDF/);
  assert.equal(state.renders, 0);
  assert.equal(state.writes, 0);
});

test("verified markdown certificate remains available", async () => {
  const { state, artifacts, storage } = signingAuditFixture();
  const original = Buffer.from("signed-pdf");
  Object.assign(state.agreement, { status: "completed", signed_pdf_base64: original.toString("base64"), signed_pdf_sha256: storage.pdfSha256(original), signed_pdf_bytes: original.length });
  assert.equal((await artifacts.certificateBufferForAgreement(state.agreement)).toString(), "signed-pdf");
  assert.equal(state.renders, 0);
});

test("completed embedded preview cannot disclose signed fields through a session bearer", async () => {
  const { state, request } = signingAuditFixture();
  state.agreement.status = "completed";
  state.agreement.signed_fields_json = '{"signature":{"typed_name":"Private signed identity","signed":true}}';
  const response = await request("/preview/session-token");
  assert.equal(response.status, 403);
  assert.equal(state.renders, 0);
});

for (const access of ["unauthenticated", "foreign-owner", "ownerless-key"] as const) test(`${access} cannot retrieve private documents or mint a session`, async () => {
  const { state, request } = signingAuditFixture();
  state.agreement.status = "completed";
  state.authenticated = access !== "unauthenticated";
  state.owner = access === "foreign-owner" ? "other@example.test" : null;
  for (const suffix of ["documents/source", "documents/signed", "documents/certificate", "pdf", "source-pdf", "signing-sessions"]) {
    const response = await request(`/v1/agreements/${state.agreement.id}/${suffix}`, suffix === "signing-sessions" ? { method: "POST" } : undefined);
    assert.equal(response.status, access === "unauthenticated" ? 401 : 404);
    assert.doesNotMatch(await response.text(), /Private contract|Private title|verified@example.test/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(state.renders, 0);
  assert.equal(state.reads, 0);
  assert.equal(state.writes, 0);
});

test("owner downloads committed bytes despite a tampered path; session bearer cannot download them", async () => {
  const { state, request, storage } = signingAuditFixture();
  const committed = Buffer.from("committed-signed-pdf");
  Object.assign(state.agreement, { status: "completed", signed_pdf_base64: committed.toString("base64"), signed_pdf_sha256: storage.pdfSha256(committed), signed_pdf_bytes: committed.length, signed_pdf_path: "/fake/tampered.pdf" });
  state.files.set("/fake/tampered.pdf", Buffer.from("tampered-file"));
  const owner = await request(`/v1/agreements/${state.agreement.id}/documents/signed`);
  assert.equal(owner.status, 200);
  assert.ok(Buffer.from(await owner.arrayBuffer()).equals(committed));
  assert.equal(owner.headers.get("cache-control"), "private, no-store");
  assert.equal((await request("/sign/session-token/pdf")).status, 403);
  assert.equal(state.reads, 0);
  assert.equal(state.writes, 0);
});

test("tampered fallback file fails before overwriting the committed hash", async () => {
  const { state, storage } = signingAuditFixture();
  Object.assign(state.agreement, { status: "completed", signed_pdf_path: "/fake/tampered.pdf", signed_pdf_sha256: storage.pdfSha256(Buffer.from("original")), signed_pdf_bytes: 8 });
  state.files.set("/fake/tampered.pdf", Buffer.from("tampered"));
  const hash = state.agreement.signed_pdf_sha256;
  await assert.rejects(storage.pdfBufferForAgreement(state.agreement), /hash mismatch/);
  assert.equal(state.agreement.signed_pdf_sha256, hash);
  assert.equal(state.writes, 0);
  assert.equal(state.renders, 0);
});

test("hosted completed previews and signed PDF bearer downloads remain compatible", async () => {
  const { state, request, storage } = signingAuditFixture();
  const committed = Buffer.from("legacy-signed-pdf");
  Object.assign(state.agreement, { signing_mode: "hosted", status: "completed", signed_pdf_base64: committed.toString("base64"), signed_pdf_sha256: storage.pdfSha256(committed), signed_pdf_bytes: committed.length });
  assert.equal((await request("/preview/legacy-token")).status, 200);
  const response = await request("/sign/legacy-token/pdf");
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(committed));
});

for (const corruption of ["hash", "length"]) test(`owner signed-PDF route fails privately on ${corruption} corruption`, async () => {
  const { state, request, storage } = signingAuditFixture();
  const bytes = Buffer.from("signed-pdf");
  Object.assign(state.agreement, { status: "completed", signed_pdf_base64: bytes.toString("base64"), signed_pdf_sha256: corruption === "hash" ? "0".repeat(64) : storage.pdfSha256(bytes), signed_pdf_bytes: corruption === "length" ? bytes.length + 1 : bytes.length });
  const response = await request(`/v1/agreements/${state.agreement.id}/documents/signed`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /Stored signed PDF|agreement-audit|Private contract|verified@example.test/);
  assert.equal(state.writes, 0);
  assert.equal(state.renders, 0);
});

test("source-PDF certificate extracts only certificate pages from verified committed bytes", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const { state, artifacts, storage } = signingAuditFixture();
  const source = await PDFDocument.create();
  source.addPage([100, 100]);
  const original = Buffer.from(await source.save());
  const signed = await PDFDocument.load(original);
  signed.addPage([200, 200]);
  const completed = Buffer.from(await signed.save());
  Object.assign(state.agreement, { status: "completed", source_pdf_base64: original.toString("base64"), source_pdf_sha256: storage.pdfSha256(original), source_pdf_bytes: original.length, signed_pdf_base64: completed.toString("base64"), signed_pdf_sha256: storage.pdfSha256(completed), signed_pdf_bytes: completed.length });
  const certificate = await PDFDocument.load(await artifacts.certificateBufferForAgreement(state.agreement));
  assert.equal(certificate.getPageCount(), 1);
  assert.equal(certificate.getPage(0).getWidth(), 200);
  assert.equal(state.renders, 0);
  assert.equal(state.writes, 0);
});

for (const corruption of ["hash", "length"]) test(`source download rejects ${corruption} corruption`, () => {
  const { state, storage } = signingAuditFixture();
  const bytes = Buffer.from("source-pdf");
  Object.assign(state.agreement, { source_pdf_base64: bytes.toString("base64"), source_pdf_sha256: corruption === "hash" ? "0".repeat(64) : storage.pdfSha256(bytes), source_pdf_bytes: corruption === "length" ? bytes.length + 1 : bytes.length });
  assert.throws(() => storage.sourcePdfBufferForAgreement(state.agreement), /Stored source PDF/);
  assert.equal(state.writes, 0);
});

test("mutable Markdown fields and audit cannot alter an existing certificate artifact", async () => {
  const { state, artifacts, storage } = signingAuditFixture();
  const original = Buffer.from("committed-evidence");
  Object.assign(state.agreement, { status: "completed", signed_pdf_base64: original.toString("base64"), signed_pdf_sha256: storage.pdfSha256(original), signed_pdf_bytes: original.length, document_markdown: "altered", signed_fields_json: '{"signature":{"typed_name":"altered"}}', document_title: "altered" });
  state.audits.push({ event_type: "altered" });
  assert.ok((await artifacts.certificateBufferForAgreement(state.agreement)).equals(original));
  assert.equal(state.renders, 0);
});

test("a legacy certificate with no committed artifact refuses reconstruction from mutable fields", async () => {
  const { state, artifacts } = signingAuditFixture();
  Object.assign(state.agreement, { status: "completed", signed_pdf_base64: null, signed_pdf_path: null, signed_pdf_sha256: null, signed_pdf_bytes: null });
  await assert.rejects(artifacts.certificateBufferForAgreement(state.agreement), /Stored signed PDF artifact is missing/);
  assert.equal(state.renders, 0);
});
