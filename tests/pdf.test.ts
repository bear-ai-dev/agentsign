import assert from "node:assert/strict";
import test from "node:test";
import { renderDocumentHtml } from "../src/lib/pdf.js";

test("signed field placeholders render values inline instead of duplicating them below", () => {
  const html = renderDocumentHtml({
    markdown: [
      "# Filesystem Purchase Agreement",
      "",
      "### SELLER:",
      "Signature: {{signed:seller_signature}}",
      "Printed Name: {{signed:seller_printed_name}}",
      "Email: {{signed:seller_email}}",
      "Country of Residence: {{signed:seller_country}}",
      "Date: {{signed:seller_signature_date}}"
    ].join("\n"),
    fields: [
      { id: "seller_signature", label: "Seller signature", type: "signature", required: true },
      { id: "seller_printed_name", label: "Seller printed legal name", type: "text", required: true },
      { id: "seller_email", label: "Seller email", type: "email", required: true },
      { id: "seller_country", label: "Country of residence", type: "text", required: true },
      { id: "seller_signature_date", label: "Seller signature date", type: "date", required: true }
    ],
    signedFields: {
      seller_signature: { signed: true, typed_name: "Test Signer" },
      seller_printed_name: "Test Signer",
      seller_email: "signer@example.com",
      seller_country: "USA",
      seller_signature_date: "2026-06-25"
    }
  });

  assert.match(html, /Signature: <span class="typed-signature">Test Signer<\/span>/);
  assert.match(html, /Printed Name: <span class="signed-inline">Test Signer<\/span>/);
  assert.match(html, /Email: <span class="signed-inline">signer@example\.com<\/span>/);
  assert.doesNotMatch(html, /<h2>Signed Fields<\/h2>/);
});

test("unsigned field placeholders render as empty inline slots", () => {
  const html = renderDocumentHtml({
    markdown: "Signature: {{signed:seller_signature}}",
    fields: [
      { id: "seller_signature", label: "Seller signature", type: "signature", required: true }
    ]
  });

  assert.match(html, /Signature: <span class="signed-inline empty"><\/span>/);
  assert.doesNotMatch(html, /\{\{signed:seller_signature\}\}/);
});
