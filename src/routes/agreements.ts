import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { addAuditEvent, all, get, getAgreement, getAuditEvents, nowIso, parseJson, run } from "../lib/db.js";
import { env } from "../lib/env.js";
import { requireApiKey } from "../lib/auth.js";
import { sendSigningEmail } from "../lib/email.js";
import { pdfBufferForAgreement } from "../lib/pdfStorage.js";
import { checkRateLimits } from "../lib/rateLimit.js";
import { saveAgreementContext } from "../lib/telemetry.js";
import { applyTemplateVars, defaultTemplateVars, loadTemplate, templateDefinitions, titleFromMarkdown } from "../lib/templates.js";
import { auditEventsForApi } from "../lib/audit.js";
import { decodeOriginalPdf, originalPdfBufferForAgreement, originalPdfMarkdown, titleFromPdfFilename, type OriginalPdfDocument } from "../lib/originalPdf.js";
import { agreementUrl } from "../lib/signingUrls.js";
import { getVerifiedSenderProfileForOwner, ownerHasVerifiedSenderProfile, resolveSenderProfile } from "../lib/senderProfiles.js";
import type { Agreement, AgreementBatch, AgreementBatchItem, ApiKeyRecord, FieldDefinition, SignedFields } from "../lib/types.js";
import { cancelledPayload, enqueueWebhook } from "./webhooks.js";

export const agreements = new Hono();
agreements.use("/v1/*", requireApiKey);

type CreateBody = {
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
  session_id?: string;
  cli_run_id?: string;
  agreement_context?: {
    source?: string;
    reason_sent?: string;
    approval_message?: string;
    chat_summary?: string;
    transcript_text?: string;
    transcript_json?: unknown;
    metadata?: unknown;
  };
};
type ReminderTarget = "recipient" | "sender" | "all";
type CreateOptions = {
  ownerEmail?: string | null;
  apiKeyId?: string | null;
  batchId?: string | null;
};

function assertCreateBody(body: CreateBody) {
  if (!body.recipient?.name || !body.recipient?.email) throw new Error("recipient.name and recipient.email are required");
  if (!body.document_markdown && !body.template && !body.document_pdf_base64) {
    throw new Error("template, document_markdown, or document_pdf_base64 is required");
  }
  if (!Array.isArray(body.fields)) throw new Error("fields array is required");
}

function documentTitleForPdf(body: CreateBody, originalPdf: OriginalPdfDocument) {
  return body.document_title?.trim() || titleFromPdfFilename(originalPdf.filename);
}

function markdownForBody(body: CreateBody, originalPdf?: OriginalPdfDocument | null) {
  if (originalPdf) {
    return body.document_markdown || originalPdfMarkdown({
      title: documentTitleForPdf(body, originalPdf),
      filename: originalPdf.filename,
      sha256: originalPdf.sha256,
      bytes: originalPdf.bytes
    });
  }

  const source = body.document_markdown ?? loadTemplate(body.template!);
  const definition = body.template ? templateDefinitions[body.template as keyof typeof templateDefinitions] : undefined;
  return applyTemplateVars(source, {
    ...(definition ? defaultTemplateVars(definition) : {}),
    ...(body.template_vars ?? {}),
    recipient_name: body.recipient?.name ?? "",
    recipient_email: body.recipient?.email ?? ""
  });
}

function normalizeEmailList(value: string | string[] | undefined) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((email) => email.trim()).filter(Boolean);
}

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function isBootstrapKey(c: Context) {
  return Boolean((c as unknown as { get(key: string): unknown }).get("apiKeyBootstrap"));
}

function requestOwnerEmail(c: Context) {
  return apiKeyRecord(c)?.owner_email?.trim().toLowerCase() ?? null;
}

function clientIp(c: Context) {
  return (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown").split(",")[0].trim() || "unknown";
}

function rateLimitJson(result: Awaited<ReturnType<typeof checkRateLimits>>) {
  return {
    error: "Rate limit exceeded",
    limit: result.limit,
    remaining: result.remaining,
    reset_at: result.reset_at
  };
}

async function enforceAgreementRateLimit(c: Context, ownerEmail: string | null, cost = 1) {
  if (isBootstrapKey(c)) return null;
  if (!ownerEmail) return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  const verified = await ownerHasVerifiedSenderProfile(ownerEmail);
  const result = await checkRateLimits([
    { scope: "agreement_send_owner_hour", subject: ownerEmail, limit: verified ? 50 : 10, windowMs: 60 * 60 * 1000, cost },
    { scope: "agreement_send_owner_day", subject: ownerEmail, limit: verified ? 250 : 50, windowMs: 24 * 60 * 60 * 1000, cost },
    { scope: "agreement_send_ip_hour", subject: clientIp(c), limit: verified ? 100 : 30, windowMs: 60 * 60 * 1000, cost }
  ]);
  if (!result.allowed) return c.json(rateLimitJson(result), 429);

  return null;
}

async function getAgreementForRequest(c: Context, id: string) {
  if (isBootstrapKey(c)) return getAgreement(id);
  const ownerEmail = requestOwnerEmail(c);
  if (!ownerEmail) return undefined;
  return get<Agreement>("SELECT * FROM agreements WHERE id = ? AND owner_email = ?", id, ownerEmail);
}

function normalizeReminderTarget(value: unknown): ReminderTarget | null {
  const target = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_]+/g, "-") : "recipient";
  if (["recipient", "recipients", "other", "others", "everyone-else", "counterparty", "counterparties"].includes(target)) return "recipient";
  if (["sender", "self", "me", "myself"].includes(target)) return "sender";
  if (["all", "both", "everyone", "all-signers"].includes(target)) return "all";
  return null;
}

export async function createAgreement(body: CreateBody, baseUrl = env.baseUrl, options: CreateOptions = {}) {
  assertCreateBody(body);
  const originalPdf = decodeOriginalPdf({
    base64: body.document_pdf_base64,
    filename: body.document_pdf_filename
  });
  const markdown = markdownForBody(body, originalPdf);
  const id = `agr_${nanoid(12)}`;
  const token = nanoid(32);
  const webhookSecret = body.webhook_url ? `whsec_${nanoid(32)}` : null;
  const createdAt = nowIso();
  const documentTitle = body.document_title?.trim() || (originalPdf ? documentTitleForPdf(body, originalPdf) : titleFromMarkdown(markdown));
  const ownerEmail = options.ownerEmail?.trim().toLowerCase() || null;
  const requestedSenderEmail = normalizeEmailList(body.sender_email)[0]?.toLowerCase() ?? null;
  const resolvedSender = await resolveSenderProfile({
    ownerEmail,
    requestedSenderEmail,
    senderName: typeof body.sender_name === "string" ? body.sender_name : undefined
  });
  const senderEmail = resolvedSender.senderEmail;
  const senderName = resolvedSender.senderName;
  const senderProfileId = resolvedSender.senderProfile?.id ?? null;
  const signingBaseUrl = resolvedSender.signingBaseUrl ?? baseUrl;
  const senderSigningToken = senderEmail ? nanoid(32) : null;
  const notificationEmails = normalizeEmailList(body.notification_email ?? senderEmail ?? body.sender_email);
  const metadata = {
    ...(body.metadata ?? {}),
    ...(ownerEmail ? { owner_email: ownerEmail } : {}),
    ...(body.session_id ? { agent_session_id: body.session_id } : {}),
    ...(body.cli_run_id ? { cli_run_id: body.cli_run_id } : {}),
    ...(notificationEmails.length ? { notification_email: notificationEmails } : {}),
    ...(senderEmail ? { sender_email: senderEmail } : {}),
    ...(senderName ? { sender_name: senderName } : {}),
    ...(senderProfileId ? { sender_profile_id: senderProfileId } : {}),
    ...(signingBaseUrl ? { signing_base_url: signingBaseUrl } : {}),
    ...(options.batchId ? { batch_id: options.batchId } : {}),
    ...(originalPdf ? {
      document_source: "pdf",
      document_pdf_filename: originalPdf.filename,
      document_pdf_sha256: originalPdf.sha256,
      document_pdf_bytes: originalPdf.bytes
    } : {}),
    ...(senderEmail && senderSigningToken ? { sender_signature_required: true, sender_signing_token: senderSigningToken } : {})
  };

  await run(
    `INSERT INTO agreements (
      id, status, recipient_name, recipient_email, owner_email, api_key_id, sender_profile_id, signing_base_url, batch_id, document_markdown, document_title,
      original_pdf_base64, original_pdf_filename, original_pdf_sha256, original_pdf_bytes, fields_json,
      webhook_url, webhook_secret, metadata_json, signing_token, created_at, sent_at
    ) VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    body.recipient!.name,
    body.recipient!.email,
    ownerEmail,
    options.apiKeyId ?? null,
    senderProfileId,
    signingBaseUrl,
    options.batchId ?? null,
    markdown,
    documentTitle,
    originalPdf?.base64 ?? null,
    originalPdf?.filename ?? null,
    originalPdf?.sha256 ?? null,
    originalPdf?.bytes ?? null,
    JSON.stringify(body.fields),
    body.webhook_url ?? null,
    webhookSecret,
    Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    token,
    createdAt,
    createdAt
  );

  await addAuditEvent({ agreementId: id, eventType: "created", data: { source: originalPdf ? "pdf_upload" : body.template ? "template" : "raw_markdown" } });
  const cc = normalizeEmailList(body.cc ?? body.recipient?.cc);
  await addAuditEvent({ agreementId: id, eventType: "sent", data: { recipient_email: body.recipient!.email, cc, sender_email: senderEmail } });

  const agreementBase = { signing_base_url: signingBaseUrl };
  const signingUrl = agreementUrl(agreementBase, `/sign/${token}`);
  const senderSigningUrl = senderSigningToken ? agreementUrl(agreementBase, `/sign/${senderSigningToken}`) : null;
  await sendSigningEmail({
    to: body.recipient!.email!,
    cc,
    replyTo: senderEmail ? [senderEmail] : undefined,
    senderName,
    fromEmail: senderEmail ?? undefined,
    recipientName: body.recipient!.name!,
    documentTitle,
    signingUrl
  });
  if (senderEmail && senderSigningUrl) {
    await sendSigningEmail({
      to: senderEmail,
      senderName,
      fromEmail: senderEmail,
      recipientName: senderName || senderEmail,
      documentTitle,
      signingUrl: senderSigningUrl,
      message: "Your signature is also required before this agreement is complete."
    });
    await addAuditEvent({ agreementId: id, eventType: "sent", data: { sender_email: senderEmail, role: "sender" } });
  }

  await saveAgreementContext({
    agreementId: id,
    sessionId: body.session_id ?? null,
    cliRunId: body.cli_run_id ?? null,
    source: body.agreement_context?.source ?? "agentcontract-cli",
    reasonSent: body.agreement_context?.reason_sent,
    approvalMessage: body.agreement_context?.approval_message,
    chatSummary: body.agreement_context?.chat_summary,
    metadata: body.agreement_context?.metadata
  }).catch((error) => {
    console.warn("[AgentContract agreement context save failed]", error);
  });

  return {
    id,
    status: "sent",
    preview_url: agreementUrl(agreementBase, `/preview/${token}`),
    signing_url: signingUrl,
    sender_signing_url: senderSigningUrl,
    sender_profile_id: senderProfileId,
    signing_base_url: signingBaseUrl,
    batch_id: options.batchId ?? null,
    webhook_secret: webhookSecret,
    notification_email: notificationEmails,
    document_source: originalPdf ? "pdf" : "markdown",
    document_pdf_filename: originalPdf?.filename ?? null,
    document_pdf_sha256: originalPdf?.sha256 ?? null,
    document_pdf_bytes: originalPdf?.bytes ?? null,
    created_at: createdAt
  };
}

function agreementForApi(agreement: Agreement) {
  const metadata = parseJson<Record<string, unknown> | null>(agreement.metadata_json, null);
  const senderToken = typeof metadata?.sender_signing_token === "string" ? metadata.sender_signing_token : null;
  return {
    id: agreement.id,
    status: agreement.status,
    recipient: { name: agreement.recipient_name, email: agreement.recipient_email },
    owner_email: agreement.owner_email,
    sender_profile_id: agreement.sender_profile_id,
    signing_base_url: agreement.signing_base_url,
    batch_id: agreement.batch_id,
    document_title: agreement.document_title,
    document_source: agreement.original_pdf_base64 ? "pdf" : "markdown",
    document_pdf_filename: agreement.original_pdf_filename,
    document_pdf_sha256: agreement.original_pdf_sha256,
    document_pdf_bytes: agreement.original_pdf_bytes,
    fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
    signed_fields: parseJson<SignedFields | null>(agreement.signed_fields_json, null),
    webhook_url: agreement.webhook_url,
    webhook_secret: agreement.webhook_secret,
    metadata,
    preview_url: agreementUrl(agreement, `/preview/${agreement.signing_token}`),
    signing_url: agreementUrl(agreement, `/sign/${agreement.signing_token}`),
    sender_signing_url: senderToken ? agreementUrl(agreement, `/sign/${senderToken}`) : null,
    created_at: agreement.created_at,
    sent_at: agreement.sent_at,
    viewed_at: agreement.viewed_at,
    completed_at: agreement.completed_at,
    signed_pdf_url: agreement.status === "completed" ? agreementUrl(agreement, `/v1/agreements/${agreement.id}/pdf`) : null,
    signed_pdf_saved: Boolean(agreement.signed_pdf_base64),
    signed_pdf_sha256: agreement.signed_pdf_sha256,
    signed_pdf_bytes: agreement.signed_pdf_bytes
  };
}

function batchForApi(batch: AgreementBatch) {
  return {
    id: batch.id,
    status: batch.status,
    owner_email: batch.owner_email,
    sender_profile_id: batch.sender_profile_id,
    total_count: Number(batch.total_count),
    sent_count: Number(batch.sent_count),
    failed_count: Number(batch.failed_count),
    metadata: parseJson<Record<string, unknown> | null>(batch.metadata_json, null),
    created_at: batch.created_at,
    completed_at: batch.completed_at
  };
}

function batchItemForApi(item: AgreementBatchItem) {
  return {
    id: item.id,
    batch_id: item.batch_id,
    agreement_id: item.agreement_id,
    recipient: { name: item.recipient_name, email: item.recipient_email },
    status: item.status,
    error: item.error,
    created_at: item.created_at
  };
}

async function getBatchForRequest(c: Context, id: string) {
  if (isBootstrapKey(c)) return get<AgreementBatch>("SELECT * FROM agreement_batches WHERE id = ?", id);
  const ownerEmail = requestOwnerEmail(c);
  if (!ownerEmail) return undefined;
  return get<AgreementBatch>("SELECT * FROM agreement_batches WHERE id = ? AND owner_email = ?", id, ownerEmail);
}

async function createAgreementBatch(input: {
  ownerEmail: string | null;
  apiKeyId: string | null;
  senderProfileId: string | null;
  totalCount: number;
  metadata?: Record<string, unknown>;
}) {
  const id = `bat_${nanoid(12)}`;
  const createdAt = nowIso();
  await run(
    `INSERT INTO agreement_batches (
      id, owner_email, api_key_id, sender_profile_id, status, total_count, sent_count, failed_count, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'processing', ?, 0, 0, ?, ?)`,
    id,
    input.ownerEmail,
    input.apiKeyId,
    input.senderProfileId,
    input.totalCount,
    input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt
  );
  return (await get<AgreementBatch>("SELECT * FROM agreement_batches WHERE id = ?", id))!;
}

async function addBatchItem(input: {
  batchId: string;
  agreementId?: string | null;
  recipientName: string;
  recipientEmail: string;
  status: "sent" | "failed";
  error?: string | null;
}) {
  await run(
    `INSERT INTO agreement_batch_items (
      id, batch_id, agreement_id, recipient_name, recipient_email, status, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    `bitem_${nanoid(12)}`,
    input.batchId,
    input.agreementId ?? null,
    input.recipientName,
    input.recipientEmail,
    input.status,
    input.error ?? null,
    nowIso()
  );
}

async function finishAgreementBatch(id: string, sentCount: number, failedCount: number) {
  const status = failedCount === 0 ? "completed" : sentCount === 0 ? "failed" : "partial_failed";
  await run(
    "UPDATE agreement_batches SET status = ?, sent_count = ?, failed_count = ?, completed_at = ? WHERE id = ?",
    status,
    sentCount,
    failedCount,
    nowIso(),
    id
  );
  return (await get<AgreementBatch>("SELECT * FROM agreement_batches WHERE id = ?", id))!;
}

agreements.post("/v1/agreements", async (c) => {
  try {
    const body = await c.req.json<CreateBody>();
    const ownerEmail = requestOwnerEmail(c);
    const limited = await enforceAgreementRateLimit(c, ownerEmail);
    if (limited) return limited;
    const result = await createAgreement(body, new URL(c.req.url).origin, {
      ownerEmail,
      apiKeyId: apiKeyRecord(c)?.id ?? null
    });
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
});

agreements.post("/v1/agreements/bulk", async (c) => {
  try {
    const body = await c.req.json<{
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
      session_id?: string;
      cli_run_id?: string;
      agreement_context?: CreateBody["agreement_context"];
    }>();
    if (!Array.isArray(body.recipients) || body.recipients.length === 0) throw new Error("recipients array is required");

    const ownerEmail = requestOwnerEmail(c);
    const verifiedProfile = await getVerifiedSenderProfileForOwner(ownerEmail);
    const bulkLimit = verifiedProfile ? 50 : 25;
    if (body.recipients.length > bulkLimit) throw new Error(`Bulk agreement sends are capped at ${bulkLimit} recipients`);
    const limited = await enforceAgreementRateLimit(c, ownerEmail, body.recipients.length);
    if (limited) return limited;

    const batch = await createAgreementBatch({
      ownerEmail,
      apiKeyId: apiKeyRecord(c)?.id ?? null,
      senderProfileId: verifiedProfile?.id ?? null,
      totalCount: body.recipients.length,
      metadata: {
        template: body.template ?? null,
        document_title: body.document_title ?? null,
        source: body.document_pdf_base64 ? "pdf" : body.template ? "template" : "raw_markdown"
      }
    });
    const results = [];
    const failed = [];
    for (const recipient of body.recipients) {
      try {
        const agreement = await createAgreement({
          recipient,
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
          session_id: body.session_id,
          cli_run_id: body.cli_run_id,
          agreement_context: body.agreement_context
        }, new URL(c.req.url).origin, {
          ownerEmail,
          apiKeyId: apiKeyRecord(c)?.id ?? null,
          batchId: batch.id
        });
        results.push(agreement);
        await addBatchItem({
          batchId: batch.id,
          agreementId: agreement.id,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
          status: "sent"
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid request";
        failed.push({ recipient: { name: recipient.name, email: recipient.email }, error: message });
        await addBatchItem({
          batchId: batch.id,
          recipientName: recipient.name,
          recipientEmail: recipient.email,
          status: "failed",
          error: message
        });
      }
    }
    const finishedBatch = await finishAgreementBatch(batch.id, results.length, failed.length);
    return c.json({ batch_id: finishedBatch.id, batch: batchForApi(finishedBatch), agreements: results, failed }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
});

agreements.get("/v1/agreement-batches", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const cursor = c.req.query("cursor");
  const params: unknown[] = [];
  const where: string[] = [];
  if (cursor) {
    where.push("created_at < ?");
    params.push(cursor);
  }
  if (!isBootstrapKey(c)) {
    const ownerEmail = requestOwnerEmail(c);
    if (!ownerEmail) return c.json({ batches: [], next_cursor: null });
    where.push("owner_email = ?");
    params.push(ownerEmail);
  }
  params.push(limit);
  const rows = await all<AgreementBatch>(
    `SELECT * FROM agreement_batches ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT ?`,
    ...params
  );
  return c.json({ batches: rows.map(batchForApi), next_cursor: rows.at(-1)?.created_at ?? null });
});

agreements.get("/v1/agreement-batches/:id", async (c) => {
  const batch = await getBatchForRequest(c, c.req.param("id"));
  if (!batch) return c.json({ error: "Agreement batch not found" }, 404);
  const items = await all<AgreementBatchItem>(
    "SELECT * FROM agreement_batch_items WHERE batch_id = ? ORDER BY created_at ASC",
    batch.id
  );
  return c.json({ batch: batchForApi(batch), items: items.map(batchItemForApi) });
});

agreements.get("/v1/agreements", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const cursor = c.req.query("cursor");
  const params: unknown[] = [];
  const where: string[] = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (cursor) {
    where.push("created_at < ?");
    params.push(cursor);
  }
  if (!isBootstrapKey(c)) {
    const ownerEmail = requestOwnerEmail(c);
    if (!ownerEmail) return c.json({ agreements: [], next_cursor: null });
    where.push("owner_email = ?");
    params.push(ownerEmail);
  }
  params.push(limit);

  const rows = await all<Agreement>(
    `SELECT * FROM agreements ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT ?`,
    ...params
  );
  return c.json({ agreements: rows.map(agreementForApi), next_cursor: rows.at(-1)?.created_at ?? null });
});

agreements.get("/v1/agreements/:id", async (c) => {
  const agreement = await getAgreementForRequest(c, c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ ...agreementForApi(agreement), audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
});

agreements.get("/v1/agreements/:id/document", async (c) => {
  const agreement = await getAgreementForRequest(c, c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({
    agreement_id: agreement.id,
    status: agreement.status,
    document_title: agreement.document_title,
    recipient: { name: agreement.recipient_name, email: agreement.recipient_email },
    document_source: agreement.original_pdf_base64 ? "pdf" : "markdown",
    document_markdown: agreement.document_markdown,
    document_pdf_filename: agreement.original_pdf_filename,
    document_pdf_sha256: agreement.original_pdf_sha256,
    document_pdf_bytes: agreement.original_pdf_bytes,
    document_pdf_url: agreement.original_pdf_base64 ? agreementUrl(agreement, `/v1/agreements/${agreement.id}/original-pdf`) : null,
    fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
    signed_fields: parseJson<SignedFields | null>(agreement.signed_fields_json, null),
    metadata: parseJson<Record<string, unknown> | null>(agreement.metadata_json, null),
    created_at: agreement.created_at,
    completed_at: agreement.completed_at
  });
});

agreements.get("/v1/agreements/:id/original-pdf", async (c) => {
  const agreement = await getAgreementForRequest(c, c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  const buffer = originalPdfBufferForAgreement(agreement);
  if (!buffer) return c.json({ error: "Agreement does not have an uploaded PDF" }, 404);

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${agreement.original_pdf_filename ?? `${agreement.id}.pdf`}"`
    }
  });
});

agreements.post("/v1/agreements/:id/cancel", async (c) => {
  const agreement = await getAgreementForRequest(c, c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (agreement.status === "completed") return c.json({ error: "Completed agreements cannot be cancelled" }, 400);

  await run("UPDATE agreements SET status = 'cancelled' WHERE id = ?", agreement.id);
  await addAuditEvent({ agreementId: agreement.id, eventType: "cancelled" });
  const updated = (await getAgreement(agreement.id))!;
  if (updated.webhook_url) enqueueWebhook(updated.id, updated.webhook_url, cancelledPayload(updated));
  return c.json(agreementForApi(updated));
});

agreements.post("/v1/agreements/:id/remind", async (c) => {
  const agreement = await getAgreementForRequest(c, c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (agreement.status === "completed" || agreement.status === "cancelled") return c.json({ error: `Cannot remind ${agreement.status} agreement` }, 400);
  const body = await c.req.json<{ target?: string }>().catch(() => ({})) as { target?: string };
  const target = normalizeReminderTarget(body.target);
  if (!target) return c.json({ error: "target must be recipient, sender, or all" }, 400);

  const metadata = parseJson<Record<string, unknown>>(agreement.metadata_json, {});
  const senderEmail = typeof metadata.sender_email === "string" ? metadata.sender_email : "";
  const senderName = typeof metadata.sender_name === "string" ? metadata.sender_name : "";
  const senderSigningToken = typeof metadata.sender_signing_token === "string" ? metadata.sender_signing_token : "";
  const reminders: Array<{
    role: "recipient" | "sender";
    email: string;
    name: string;
    signingUrl: string;
    message?: string;
  }> = [];

  if (target === "recipient" || target === "all") {
    reminders.push({
      role: "recipient",
      email: agreement.recipient_email,
      name: agreement.recipient_name,
      signingUrl: agreementUrl(agreement, `/sign/${agreement.signing_token}`)
    });
  }

  if (target === "sender" || target === "all") {
    if (!senderEmail || !senderSigningToken) {
      if (target === "sender") return c.json({ error: "Sender reminder is unavailable for this agreement" }, 400);
    } else {
      reminders.push({
        role: "sender",
        email: senderEmail,
        name: senderName || senderEmail,
        signingUrl: agreementUrl(agreement, `/sign/${senderSigningToken}`),
        message: "Your signature is also required before this agreement is complete."
      });
    }
  }

  if (reminders.length === 0) return c.json({ error: "No reminder recipients found" }, 400);

  for (const reminder of reminders) {
    await sendSigningEmail({
      to: reminder.email,
      replyTo: reminder.role === "recipient" && senderEmail ? [senderEmail] : undefined,
      senderName,
      fromEmail: senderEmail || undefined,
      recipientName: reminder.name,
      documentTitle: agreement.document_title,
      signingUrl: reminder.signingUrl,
      message: reminder.message
    });
  }

  await addAuditEvent({
    agreementId: agreement.id,
    eventType: "sent",
    data: {
      reminder: true,
      target,
      to: reminders.map((reminder) => ({ role: reminder.role, email: reminder.email }))
    }
  });
  return c.json({
    ok: true,
    target,
    reminded: reminders.map((reminder) => ({ role: reminder.role, email: reminder.email }))
  });
});

agreements.get("/v1/agreements/:id/pdf", async (c) => {
  const agreement = await getAgreementForRequest(c, c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);

  const buffer = await pdfBufferForAgreement(agreement);

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${agreement.id}.pdf"`
    }
  });
});

agreements.get("/v1/agreements/:id/audit", async (c) => {
  const agreement = await getAgreementForRequest(c, c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ agreement_id: agreement.id, audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
});
