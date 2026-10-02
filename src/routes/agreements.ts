import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { addAuditEvent, all, get, getAgreement, getAuditEvents, nowIso, parseJson, run } from "../lib/db.js";
import { env } from "../lib/env.js";
import { creationHash, isEmbedded, inactiveAgreement, newSigningToken, hashSigningToken, ProviderRequestError, validatedEmbeddedOptions, validateSessionRequest, type EmbeddedOptions } from "../lib/embeddedSigning.js";
import { certificateBufferForAgreement, sourceDocumentBufferForAgreement } from "../lib/agreementArtifacts.js";
import { assertEmbeddedCreator, bindBulkRequest, creationScope } from "../lib/agreementIdempotency.js";
import { requireApiKey } from "../lib/auth.js";
import { sendSenderSigningEmail, sendSigningEmail } from "../lib/email.js";
import { pdfBufferForAgreement, pdfSha256, sourcePdfBufferForAgreement } from "../lib/pdfStorage.js";
import { posthog, signerDistinctId } from "../lib/posthog.js";
import { fieldsForSigner, requiresSenderSignature as fieldsRequireSenderSignature } from "../lib/signers.js";
import { applyTemplateVars, loadTemplate, titleFromMarkdown } from "../lib/templates.js";
import { auditEventsForApi } from "../lib/audit.js";
import type { Agreement, ApiKeyRecord, FieldDefinition, SignedFields, SigningOrder } from "../lib/types.js";
import { cancelledPayload, enqueueWebhook } from "./webhooks.js";
import { validateWebhookUrl } from "../lib/safeWebhook.js";

export const agreements = new Hono();
agreements.use("/v1/*", requireApiKey);
agreements.use("/v1/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});

type CreateBody = EmbeddedOptions & {
  recipient?: { name?: string; email?: string; cc?: string | string[] };
  cc?: string | string[];
  notification_email?: string | string[];
  sender_email?: string;
  sender_name?: string;
  template?: string;
  template_vars?: Record<string, unknown>;
  document_markdown?: string;
  document_pdf_base64?: string;
  document_pdf_filename?: string;
  document_title?: string;
  fields?: FieldDefinition[];
  webhook_url?: string;
  metadata?: Record<string, unknown>;
  sender_signature_required?: boolean;
  sender_fields?: FieldDefinition[];
  signing_order?: string;
};

type CreateOptions = {
  ownerEmail?: string | null;
  authenticatedScope?: string;
  idempotencyScope?: string;
};

const maxSourcePdfBytes = 6 * 1024 * 1024;

const fieldTypes = new Set(["text", "email", "date", "currency", "number", "select", "boolean", "signature", "initials"]);

function assertFieldDefinitions(value: unknown, name: string): asserts value is FieldDefinition[] {
  if (!Array.isArray(value)) throw new Error(`${name} array is required`);
  for (const rawField of value) {
    if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) throw new Error(`${name} entries must be objects`);
    const field = rawField as Record<string, unknown>;
    if (typeof field.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(field.id)) {
      throw new Error(`${name} field ids must be strings beginning with a letter`);
    }
    if (typeof field.label !== "string" || !field.label.trim()) throw new Error(`${name} field labels are required`);
    if (typeof field.type !== "string" || !fieldTypes.has(field.type)) throw new Error(`${name} contains an unsupported field type`);
    if (field.required !== undefined && typeof field.required !== "boolean") throw new Error(`${name} required values must be booleans`);
    if (field.signerRole !== undefined && field.signerRole !== "recipient" && field.signerRole !== "sender") {
      throw new Error(`${name} signerRole must be recipient or sender`);
    }
    if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some((option) => typeof option !== "string"))) {
      throw new Error(`${name} options must be strings`);
    }
  }
}

function assertCreateBody(body: CreateBody) {
  if (!body.recipient?.name || !body.recipient?.email) throw new Error("recipient.name and recipient.email are required");
  if (!body.document_markdown && !body.template && !body.document_pdf_base64) {
    throw new Error("template, document_markdown, or document_pdf_base64 is required");
  }
  assertFieldDefinitions(body.fields, "fields");
  if (body.sender_fields !== undefined) assertFieldDefinitions(body.sender_fields, "sender_fields");
}

function assertUniqueFieldIds(fields: FieldDefinition[]) {
  const ids = new Set<string>();
  for (const field of fields) {
    if (ids.has(field.id)) throw new Error(`Duplicate field id: ${field.id}`);
    ids.add(field.id);
  }
}

async function validateCreateBody(body: CreateBody) {
  assertCreateBody(body);
  if (body.webhook_url) await validateWebhookUrl(body.webhook_url);
  documentForBody(body);
  const requiresSenderSignature = senderSignatureRequired(body);
  if (requiresSenderSignature && !normalizeEmailList(body.sender_email)[0]) {
    throw new Error("sender_email is required when sender signature is required");
  }
  signingOrderFor(body, requiresSenderSignature);
  assertUniqueFieldIds(agreementFieldsFor(body, requiresSenderSignature));
  validatedEmbeddedOptions(body, agreementFieldsFor(body, requiresSenderSignature));
}

function markdownForBody(body: CreateBody) {
  const source = body.document_markdown ?? loadTemplate(body.template!);
  return applyTemplateVars(source, {
    ...(body.template_vars ?? {}),
    recipient_name: body.recipient?.name ?? "",
    recipient_email: body.recipient?.email ?? ""
  });
}

function sourcePdfForBody(body: CreateBody) {
  if (!body.document_pdf_base64) return null;
  const buffer = Buffer.from(body.document_pdf_base64, "base64");
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("document_pdf_base64 must decode to a PDF file (missing %PDF- header)");
  }
  if (buffer.byteLength > maxSourcePdfBytes) {
    throw new Error(`document_pdf_base64 decodes to ${buffer.byteLength} bytes; the limit is ${maxSourcePdfBytes} bytes`);
  }
  return buffer;
}

function sourcePdfTitle(body: CreateBody) {
  const explicit = body.document_title?.trim();
  if (explicit) return explicit;
  const filename = body.document_pdf_filename?.trim();
  if (filename) return filename.replace(/\.pdf$/i, "");
  return "Original PDF Agreement";
}

function sourcePdfPlaceholderMarkdown(title: string, sha256: string, bytes: number) {
  return [
    `# ${title}`,
    "",
    `This agreement was sent as an original PDF document (${bytes} bytes, SHA-256 \`${sha256}\`).`,
    "",
    "Signers review and sign the original PDF. The signed PDF preserves the original pages byte-for-byte and appends a signature certificate with the signed fields and audit trail."
  ].join("\n");
}

type DocumentForBody = {
  markdown: string;
  title: string;
  source: "source_pdf" | "template" | "raw_markdown";
  sourcePdf: Buffer | null;
  sourcePdfSha256: string | null;
  sourcePdfFilename: string | null;
};

function documentForBody(body: CreateBody): DocumentForBody {
  const sourcePdf = sourcePdfForBody(body);
  if (!sourcePdf) {
    const markdown = markdownForBody(body);
    return {
      markdown,
      title: titleFromMarkdown(markdown),
      source: body.template ? "template" : "raw_markdown",
      sourcePdf: null,
      sourcePdfSha256: null,
      sourcePdfFilename: null
    };
  }

  const sourcePdfSha256 = pdfSha256(sourcePdf);
  const title = sourcePdfTitle(body);
  return {
    markdown: sourcePdfPlaceholderMarkdown(title, sourcePdfSha256, sourcePdf.byteLength),
    title,
    source: "source_pdf",
    sourcePdf,
    sourcePdfSha256,
    sourcePdfFilename: body.document_pdf_filename?.trim() || null
  };
}

function normalizeEmailList(value: string | string[] | undefined) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((email) => email.trim()).filter(Boolean);
}

function stringMetadata(value: Record<string, unknown>, key: string) {
  const item = value[key];
  return typeof item === "string" ? item : null;
}

function metadataBoolean(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return value === true || value === "true";
}

function signingOrderFrom(value: unknown): SigningOrder | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "parallel" || normalized === "any" || normalized === "any_order") return "parallel";
  if (normalized === "sender_first" || normalized === "sender") return "sender_first";
  if (normalized === "recipient_first" || normalized === "recipient") return "recipient_first";
  throw new Error("signing_order must be parallel, sender_first, or recipient_first");
}

function signingOrderFor(body: CreateBody, requiresSenderSignature: boolean): SigningOrder {
  const requested = signingOrderFrom(body.signing_order ?? body.metadata?.signing_order);
  if (!requiresSenderSignature) {
    if (requested && requested !== "parallel") {
      throw new Error("signing_order requires sender signature fields");
    }
    return "parallel";
  }
  return requested ?? "parallel";
}

function senderSignatureRequired(body: CreateBody) {
  return Boolean(
    fieldsRequireSenderSignature(body.fields ?? [])
    || body.sender_signature_required
    || metadataBoolean(body.metadata, "sender_signature_required")
    || (Array.isArray(body.sender_fields) && body.sender_fields.length > 0)
  );
}

function senderFieldsFor(body: CreateBody): FieldDefinition[] {
  const existing = fieldsForSigner(body.fields ?? [], "sender");
  if (existing.length > 0) return existing;
  if (Array.isArray(body.sender_fields) && body.sender_fields.length > 0) return body.sender_fields;
  return [
    { id: "sender_full_name", label: "Sender full legal name", type: "text", required: true, signerRole: "sender" },
    { id: "sender_title", label: "Sender title", type: "text", required: false, signerRole: "sender" },
    { id: "sender_signature_date", label: "Sender signature date", type: "date", required: true, signerRole: "sender" },
    { id: "sender_signature", label: "Sender signature", type: "signature", required: true, signerRole: "sender" }
  ];
}

function agreementFieldsFor(body: CreateBody, requiresSenderSignature: boolean) {
  const fields = body.fields ?? [];
  if (!requiresSenderSignature || fieldsRequireSenderSignature(fields)) return fields;
  return [
    ...fields.map((field) => ({ ...field, signerRole: field.signerRole ?? "recipient" as const })),
    ...senderFieldsFor(body).map((field) => ({ ...field, signerRole: "sender" as const }))
  ];
}

export async function createAgreement(body: CreateBody, baseUrl = env.baseUrl, options: CreateOptions = {}) {
  await validateCreateBody(body);
  const embedded = validatedEmbeddedOptions(body, agreementFieldsFor(body, senderSignatureRequired(body)));
  const authenticatedScope = creationScope(options.ownerEmail, options.authenticatedScope);
  const scope = options.idempotencyScope ?? authenticatedScope;
  assertEmbeddedCreator(embedded.mode, options.ownerEmail, authenticatedScope);
  const requestHash = creationHash(body);
  const {
    markdown,
    title: documentTitle,
    source: documentSource,
    sourcePdf,
    sourcePdfSha256,
    sourcePdfFilename
  } = documentForBody(body);
  const id = `agr_${nanoid(12)}`;
  const token = nanoid(32);
  const webhookSecret = body.webhook_url ? `whsec_${nanoid(32)}` : null;
  const createdAt = nowIso();
  const senderEmail = normalizeEmailList(body.sender_email)[0] ?? null;
  const senderName = typeof body.sender_name === "string" ? body.sender_name.trim() : "";
  const notificationEmails = normalizeEmailList(body.notification_email ?? body.sender_email);
  const requiresSenderSignature = senderSignatureRequired(body);
  if (requiresSenderSignature && !senderEmail) {
    throw new Error("sender_email is required when sender signature is required");
  }
  const signingOrder = signingOrderFor(body, requiresSenderSignature);
  const senderToken = requiresSenderSignature ? nanoid(32) : null;
  const fields = agreementFieldsFor(body, requiresSenderSignature);
  assertUniqueFieldIds(fields);
  const metadata = {
    ...(body.metadata ?? {}),
    ...(notificationEmails.length ? { notification_email: notificationEmails } : {}),
    ...(senderEmail ? { sender_email: senderEmail } : {}),
    ...(senderName ? { sender_name: senderName } : {}),
    ...(requiresSenderSignature ? { sender_signature_required: true, signing_order: signingOrder } : {})
  };

  const inserted = await run(
    `INSERT INTO agreements (
      id, status, recipient_name, recipient_email, document_markdown, document_title, fields_json,
      webhook_url, webhook_secret, metadata_json, owner_email, signing_token, sender_signing_token, created_at, sent_at,
      source_pdf_base64, source_pdf_sha256, source_pdf_bytes, source_pdf_filename,
      signing_mode, allowed_parent_origins_json, prefill_fields_json, idempotency_scope, idempotency_key, creation_request_sha256
    ) VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    id,
    body.recipient!.name,
    body.recipient!.email,
    markdown,
    documentTitle,
    JSON.stringify(fields),
    body.webhook_url ?? null,
    webhookSecret,
    Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    options.ownerEmail ?? null,
    token,
    senderToken,
    createdAt,
    createdAt,
    sourcePdf?.toString("base64") ?? null,
    sourcePdfSha256,
    sourcePdf?.byteLength ?? null,
    sourcePdfFilename,
    embedded.mode,
    JSON.stringify(embedded.origins),
    JSON.stringify(embedded.prefill),
    scope,
    body.idempotency_key ?? null,
    requestHash
  );
  if (!inserted.changes) {
    const existing = await get<Agreement>("SELECT * FROM agreements WHERE idempotency_scope = ? AND idempotency_key = ?", scope, body.idempotency_key ?? null);
    if (!existing || existing.creation_request_sha256 !== requestHash) throw new ProviderRequestError("idempotency_key was already used with a different request", 409);
    return creationResult(existing, baseUrl);
  }

  const deliveryErrors: string[] = [];
  const safeAuditEvent = async (input: Parameters<typeof addAuditEvent>[0]) => {
    try {
      await addAuditEvent(input);
    } catch (error) {
      deliveryErrors.push(`audit: ${error instanceof Error ? error.message : String(error)}`);
      console.error("[AgentContract audit write failed]", error);
    }
  };
  await safeAuditEvent({
    agreementId: id,
    eventType: "created",
    data: {
      source: documentSource,
      ...(sourcePdf ? { source_pdf_sha256: sourcePdfSha256, source_pdf_bytes: sourcePdf.byteLength } : {})
    }
  });
  const cc = normalizeEmailList(body.cc ?? body.recipient?.cc);

  const signingUrl = embedded.mode === "embedded" ? null : `${baseUrl}/sign/${token}`;
  const senderSigningUrl = embedded.mode !== "embedded" && senderToken ? `${baseUrl}/sign/${senderToken}` : null;
  if (signingUrl && (!requiresSenderSignature || signingOrder !== "sender_first")) {
    try {
      await sendSigningEmail({
        to: body.recipient!.email!,
        cc,
        replyTo: senderEmail ? [senderEmail] : undefined,
        senderName,
        recipientName: body.recipient!.name!,
        documentTitle,
        signingUrl
      });
    } catch (error) {
      deliveryErrors.push(`recipient: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (signingUrl) {
    await safeAuditEvent({ agreementId: id, eventType: "recipient_signing_email_deferred", data: { signing_order: signingOrder } });
  }

  if (senderEmail && senderSigningUrl && signingOrder !== "recipient_first") {
    try {
      await sendSenderSigningEmail({
        to: senderEmail,
        senderName,
        recipientName: body.recipient!.name!,
        recipientEmail: body.recipient!.email!,
        documentTitle,
        agreementId: id,
        signingUrl: senderSigningUrl,
        recipientSigned: false
      });
    } catch (error) {
      deliveryErrors.push(`sender: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (senderEmail && senderSigningUrl) {
    await safeAuditEvent({ agreementId: id, eventType: "sender_signing_email_deferred", data: { signing_order: signingOrder } });
  }

  await safeAuditEvent(deliveryErrors.length
    ? { agreementId: id, eventType: "delivery_failed", data: { errors: deliveryErrors } }
    : {
      agreementId: id,
      eventType: "sent",
      data: { recipient_email: body.recipient!.email, cc, sender_email: senderEmail, sender_signature_required: requiresSenderSignature, signing_order: signingOrder }
    });

  posthog.captureEvent("agreement created", {
    agreement_id: id,
    status: "sent",
    source: documentSource,
    template: body.template ?? null,
    field_count: fields.length,
    cc_count: cc.length,
    notification_count: notificationEmails.length,
    has_webhook: Boolean(body.webhook_url),
    has_sender_email: Boolean(senderEmail),
    sender_signature_required: requiresSenderSignature,
    signing_order: signingOrder,
    workflow: stringMetadata(metadata, "workflow")
  }, signerDistinctId(id));

  return {
    id,
    status: "sent",
    signing_mode: embedded.mode,
    preview_url: embedded.mode === "embedded" ? null : `${baseUrl}/preview/${token}`,
    signing_url: signingUrl,
    sender_signing_url: senderSigningUrl,
    signing_order: signingOrder,
    webhook_secret: webhookSecret,
    notification_email: notificationEmails,
    delivery_status: embedded.mode === "embedded" ? "managed" : deliveryErrors.length ? "failed" : "sent",
    delivery_errors: deliveryErrors,
    created_at: createdAt
  };
}

function creationResult(agreement: Agreement, baseUrl: string) {
  const metadata = parseJson<Record<string, unknown>>(agreement.metadata_json, {});
  return {
    id: agreement.id, status: agreement.status, signing_mode: agreement.signing_mode,
    preview_url: isEmbedded(agreement) ? null : `${baseUrl}/preview/${agreement.signing_token}`,
    signing_url: isEmbedded(agreement) ? null : `${baseUrl}/sign/${agreement.signing_token}`,
    sender_signing_url: !isEmbedded(agreement) && agreement.sender_signing_token ? `${baseUrl}/sign/${agreement.sender_signing_token}` : null,
    signing_order: metadata.signing_order ?? "parallel", webhook_secret: agreement.webhook_secret,
    notification_email: metadata.notification_email ?? [], delivery_status: isEmbedded(agreement) ? "managed" : "sent", delivery_errors: [], created_at: agreement.created_at
  };
}

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function currentOwnerEmail(c: Context) {
  return apiKeyRecord(c)?.owner_email ?? null;
}

function authenticatedCreationScope(c: Context) {
  const record = apiKeyRecord(c);
  const bootstrap = (c as unknown as { get(key: string): unknown }).get("apiKeyBootstrap") === true;
  return creationScope(record?.owner_email, bootstrap ? "bootstrap" : record ? `key:${record.id}` : undefined);
}

async function getAgreementForOwner(id: string, ownerEmail: string | null, c: Context) {
  if (!ownerEmail) {
    const agreement = await getAgreement(id);
    return agreement && apiKeyRecord(c) && isEmbedded(agreement) ? undefined : agreement;
  }
  return get<Agreement>("SELECT * FROM agreements WHERE id = ? AND owner_email = ?", id, ownerEmail);
}

function agreementForApi(agreement: Agreement, options: { includeSignedFields?: boolean } = {}) {
  const signedFields = parseJson<SignedFields | null>(agreement.signed_fields_json, null);
  return {
    id: agreement.id,
    status: agreement.status,
    recipient: { name: agreement.recipient_name, email: agreement.recipient_email },
    document_title: agreement.document_title,
    fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
    ...(options.includeSignedFields ? { signed_fields: signedFields } : { signed_fields_saved: Boolean(signedFields) }),
    webhook_url: agreement.webhook_url,
    webhook_secret: agreement.webhook_secret,
    metadata: parseJson<Record<string, unknown> | null>(agreement.metadata_json, null),
    signing_mode: agreement.signing_mode,
    allowed_parent_origins: parseJson<string[]>(agreement.allowed_parent_origins_json, []),
    prefill_fields: parseJson<Record<string, unknown>>(agreement.prefill_fields_json, {}),
    preview_url: isEmbedded(agreement) ? null : `${env.baseUrl}/preview/${agreement.signing_token}`,
    signing_url: isEmbedded(agreement) ? null : `${env.baseUrl}/sign/${agreement.signing_token}`,
    sender_signing_url: !isEmbedded(agreement) && agreement.sender_signing_token ? `${env.baseUrl}/sign/${agreement.sender_signing_token}` : null,
    signing_order: typeof parseJson<Record<string, unknown>>(agreement.metadata_json, {}).signing_order === "string"
      ? parseJson<Record<string, unknown>>(agreement.metadata_json, {}).signing_order
      : "parallel",
    created_at: agreement.created_at,
    sent_at: agreement.sent_at,
    viewed_at: agreement.viewed_at,
    completed_at: agreement.completed_at,
    signed_pdf_url: agreement.status === "completed" ? `${env.baseUrl}/v1/agreements/${agreement.id}/pdf` : null,
    signed_pdf_saved: Boolean(agreement.signed_pdf_base64),
    signed_pdf_sha256: agreement.signed_pdf_sha256,
    signed_pdf_bytes: agreement.signed_pdf_bytes,
    source_pdf: agreement.source_pdf_base64
      ? {
        filename: agreement.source_pdf_filename,
        sha256: agreement.source_pdf_sha256,
        bytes: agreement.source_pdf_bytes,
        url: `${env.baseUrl}/v1/agreements/${agreement.id}/source-pdf`
      }
      : null
  };
}

agreements.post("/v1/agreements", async (c) => {
  try {
    const result = await createAgreement(await c.req.json<CreateBody>(), new URL(c.req.url).origin, {
      ownerEmail: currentOwnerEmail(c),
      authenticatedScope: authenticatedCreationScope(c)
    });
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, error instanceof ProviderRequestError ? error.status : 400);
  }
});

agreements.post("/v1/agreements/bulk", async (c) => {
  try {
    const body = await c.req.json<EmbeddedOptions & {
      template?: string;
      document_markdown?: string;
      document_pdf_base64?: string;
      document_pdf_filename?: string;
      document_title?: string;
      template_vars_default?: Record<string, unknown>;
      recipients?: Array<{ name: string; email: string; cc?: string | string[]; template_vars?: Record<string, unknown>; metadata?: Record<string, unknown> }>;
      cc?: string | string[];
      notification_email?: string | string[];
      sender_email?: string;
      sender_name?: string;
      fields?: FieldDefinition[];
      webhook_url?: string;
      metadata?: Record<string, unknown>;
      sender_signature_required?: boolean;
      sender_fields?: FieldDefinition[];
      signing_order?: string;
    }>();
    if (!Array.isArray(body.recipients) || body.recipients.length === 0) throw new Error("recipients array is required");

    const ownerEmail = currentOwnerEmail(c);
    const scope = authenticatedCreationScope(c);
    assertEmbeddedCreator(body.signing_mode ?? "hosted", ownerEmail, scope);
    const agreementBodies = body.recipients.map((recipient, index): CreateBody => ({
        recipient,
        signing_mode: body.signing_mode,
        allowed_parent_origins: body.allowed_parent_origins,
        prefill_fields: body.prefill_fields,
        idempotency_key: body.idempotency_key === undefined ? undefined : `${creationHash(body.idempotency_key)}:${index}`,
        template: body.template,
        document_markdown: body.document_markdown,
        document_pdf_base64: body.document_pdf_base64,
        document_pdf_filename: body.document_pdf_filename,
        document_title: body.document_title,
        template_vars: { ...(body.template_vars_default ?? {}), ...(recipient.template_vars ?? {}) },
        cc: recipient.cc ?? body.cc,
        notification_email: body.notification_email,
        sender_email: body.sender_email,
        sender_name: body.sender_name,
        fields: body.fields,
        webhook_url: body.webhook_url,
        metadata: { ...(body.metadata ?? {}), ...(recipient.metadata ?? {}) },
        sender_signature_required: body.sender_signature_required,
        sender_fields: body.sender_fields,
        signing_order: body.signing_order
      }));
    await Promise.all(agreementBodies.map(validateCreateBody));
    const memberScope = await bindBulkRequest(scope, body.idempotency_key, body);

    const results = [];
    for (const agreementBody of agreementBodies) {
      results.push(await createAgreement(agreementBody, new URL(c.req.url).origin, { ownerEmail, authenticatedScope: scope, idempotencyScope: memberScope }));
    }
    return c.json({ agreements: results }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, error instanceof ProviderRequestError ? error.status : 400);
  }
});

agreements.get("/v1/agreements", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const cursor = c.req.query("cursor");
  const includeSignedFields = c.req.query("include") === "signed_fields";
  const params: unknown[] = [];
  const where: string[] = [];
  const ownerEmail = currentOwnerEmail(c);
  if (!ownerEmail && apiKeyRecord(c)) where.push("signing_mode = 'hosted'");
  if (ownerEmail) {
    where.push("owner_email = ?");
    params.push(ownerEmail);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (cursor) {
    where.push("created_at < ?");
    params.push(cursor);
  }
  params.push(limit);

  const rows = await all<Agreement>(
    `SELECT * FROM agreements ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT ?`,
    ...params
  );
  return c.json({
    agreements: rows.map((agreement) => agreementForApi(agreement, { includeSignedFields })),
    next_cursor: rows.at(-1)?.created_at ?? null
  });
});

agreements.get("/v1/agreements/:id", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ ...agreementForApi(agreement, { includeSignedFields: true }), audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
});

agreements.get("/v1/agreements/:id/document", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({
    agreement_id: agreement.id,
    status: agreement.status,
    document_title: agreement.document_title,
    recipient: { name: agreement.recipient_name, email: agreement.recipient_email },
    document_markdown: agreement.document_markdown,
    fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
    signed_fields: parseJson<SignedFields | null>(agreement.signed_fields_json, null),
    metadata: parseJson<Record<string, unknown> | null>(agreement.metadata_json, null),
    created_at: agreement.created_at,
    completed_at: agreement.completed_at
  });
});

agreements.post("/v1/agreements/:id/cancel", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (agreement.status === "completed") return c.json({ error: "Completed agreements cannot be cancelled" }, 400);

  await run("UPDATE agreements SET status = 'cancelled' WHERE id = ?", agreement.id);
  await addAuditEvent({ agreementId: agreement.id, eventType: "cancelled" });
  const updated = (await getAgreement(agreement.id))!;
  if (updated.webhook_url) await enqueueWebhook(updated.id, updated.webhook_url, cancelledPayload(updated));
  posthog.captureEvent("agreement cancelled", {
    agreement_id: updated.id,
    previous_status: agreement.status,
    has_webhook: Boolean(updated.webhook_url)
  }, signerDistinctId(updated.id));
  return c.json(agreementForApi(updated, { includeSignedFields: true }));
});

agreements.post("/v1/agreements/:id/remind", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (isEmbedded(agreement)) return c.json({ error: "Embedded signing requires a new signing session" }, 409);
  if (agreement.status === "completed" || agreement.status === "cancelled") return c.json({ error: `Cannot remind ${agreement.status} agreement` }, 400);

  const metadata = parseJson<Record<string, unknown>>(agreement.metadata_json, {});
  const senderEmail = typeof metadata.sender_email === "string" ? metadata.sender_email : "";
  const senderName = typeof metadata.sender_name === "string" ? metadata.sender_name : "";
  await sendSigningEmail({
    to: agreement.recipient_email,
    replyTo: senderEmail ? [senderEmail] : undefined,
    senderName,
    recipientName: agreement.recipient_name,
    documentTitle: agreement.document_title,
    signingUrl: `${env.baseUrl}/sign/${agreement.signing_token}`
  });
  await addAuditEvent({ agreementId: agreement.id, eventType: "sent", data: { reminder: true } });
  posthog.captureEvent("agreement reminder sent", {
    agreement_id: agreement.id,
    status: agreement.status,
    has_sender_email: Boolean(senderEmail)
  }, signerDistinctId(agreement.id));
  return c.json({ ok: true });
});

agreements.post("/v1/agreements/:id/signing-sessions", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (!isEmbedded(agreement)) return c.json({ error: "Agreement does not use embedded signing" }, 409);
  if (inactiveAgreement(agreement)) return c.json({ error: "Agreement is not available for signing" }, 409);
  try {
    const body = await c.req.json();
    const { parentOrigin, returnUrl, role } = validateSessionRequest(agreement, body);
    const token = newSigningToken();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await run("INSERT INTO agreement_signing_sessions (token_hash, agreement_id, signer_role, parent_origin, return_url, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", hashSigningToken(token), agreement.id, role, parentOrigin, returnUrl, expiresAt, nowIso());
    await addAuditEvent({ agreementId: agreement.id, eventType: "signing_session_created", data: { signer_role: role, parent_origin: parentOrigin, expires_at: expiresAt } });
    const origin = new URL(c.req.url).origin;
    c.header("Cache-Control", "private, no-store");
    return c.json({ session_url: `${origin}/sign/${token}`, expires_at: expiresAt, origin }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid session request" }, error instanceof ProviderRequestError ? error.status : 400);
  }
});

agreements.get("/v1/agreements/:id/documents/:kind", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  const kind = c.req.param("kind");
  if (!["source", "signed", "certificate"].includes(kind)) return c.json({ error: "Document kind not found" }, 404);
  if (kind !== "source" && agreement.status !== "completed") return c.json({ error: "Agreement is not completed" }, 409);
  const buffer = kind === "source" ? await sourceDocumentBufferForAgreement(agreement) : kind === "certificate" ? await certificateBufferForAgreement(agreement) : await pdfBufferForAgreement(agreement);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${agreement.id}-${kind}.pdf"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
});

agreements.get("/v1/agreements/:id/pdf", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);

  if (isEmbedded(agreement) && agreement.status !== "completed") return c.json({ error: "Agreement is not completed" }, 409);

  const buffer = await pdfBufferForAgreement(agreement);

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${agreement.id}.pdf"`
    }
  });
});

agreements.get("/v1/agreements/:id/source-pdf", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  const buffer = sourcePdfBufferForAgreement(agreement);
  if (!buffer) return c.json({ error: "Agreement has no source PDF" }, 404);

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${agreement.source_pdf_filename ?? `${agreement.id}-source.pdf`}"`
    }
  });
});

agreements.get("/v1/agreements/:id/audit", async (c) => {
  const agreement = await getAgreementForOwner(c.req.param("id"), currentOwnerEmail(c), c);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ agreement_id: agreement.id, audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
});
