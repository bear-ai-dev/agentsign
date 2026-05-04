import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { Agreement } from "./types.js";

export const maxUploadedPdfBytes = 10 * 1024 * 1024;

export type OriginalPdfDocument = {
  buffer: Buffer;
  base64: string;
  filename: string;
  sha256: string;
  bytes: number;
};

function cleanFilename(value: string | undefined) {
  const fallback = "uploaded-document.pdf";
  const name = basename(String(value ?? "").trim() || fallback)
    .replace(/[^\w .()[\]-]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const withName = name || fallback;
  return withName.toLowerCase().endsWith(".pdf") ? withName : `${withName}.pdf`;
}

export function titleFromPdfFilename(filename: string | undefined) {
  const clean = cleanFilename(filename);
  const withoutExt = clean.slice(0, clean.length - extname(clean).length);
  const words = withoutExt.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words || "Uploaded PDF Agreement";
}

export function decodeOriginalPdf(input: {
  base64?: string;
  filename?: string;
}): OriginalPdfDocument | null {
  const rawBase64 = typeof input.base64 === "string" ? input.base64.trim() : "";
  if (!rawBase64) return null;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(rawBase64, "base64");
  } catch {
    throw new Error("document_pdf_base64 must be valid base64");
  }

  if (!buffer.byteLength) throw new Error("document_pdf_base64 is empty");
  if (buffer.byteLength > maxUploadedPdfBytes) throw new Error("document_pdf_base64 must be 10MB or smaller");
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("document_pdf_base64 must contain a PDF file");
  }

  return {
    buffer,
    base64: buffer.toString("base64"),
    filename: cleanFilename(input.filename),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.byteLength
  };
}

export function originalPdfMarkdown(input: {
  title: string;
  filename: string;
  sha256: string;
  bytes: number;
}) {
  return [
    `# ${input.title}`,
    "",
    "This agreement was created from an uploaded PDF. Review the PDF in the signing flow before signing.",
    "",
    `- Source file: ${input.filename}`,
    `- Source SHA-256: ${input.sha256}`,
    `- Source bytes: ${input.bytes}`
  ].join("\n");
}

export function agreementHasOriginalPdf(agreement: Agreement) {
  return Boolean(agreement.original_pdf_base64);
}

export function originalPdfBufferForAgreement(agreement: Agreement) {
  if (!agreement.original_pdf_base64) return null;
  const buffer = Buffer.from(agreement.original_pdf_base64, "base64");
  if (agreement.original_pdf_bytes !== null && buffer.byteLength !== Number(agreement.original_pdf_bytes)) {
    throw new Error(`Stored original PDF byte length mismatch for ${agreement.id}`);
  }
  if (agreement.original_pdf_sha256) {
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== agreement.original_pdf_sha256) throw new Error(`Stored original PDF hash mismatch for ${agreement.id}`);
  }
  return buffer;
}
