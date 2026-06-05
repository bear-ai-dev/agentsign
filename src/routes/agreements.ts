import { Hono } from "hono";
import { nanoid } from "nanoid";
import { addAuditEvent, all, getAgreement, getAuditEvents, nowIso, parseJson, run } from "../lib/db.js";
import { env } from "../lib/env.js";
import { requireApiKey } from "../lib/auth.js";
import { sendSigningEmail } from "../lib/email.js";
import { pdfBufferForAgreement } from "../lib/pdfStorage.js";
import { posthog, signerDistinctId } from "../lib/posthog.js";
import { applyTemplateVars, loadTemplate, titleFromMarkdown } from "../lib/templates.js";
import { auditEventsForApi } from "../lib/audit.js";
import type { Agreement, FieldDefinition, SignedFields } from "../lib/types.js";
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
  fields?: FieldDefinition[];
  webhook_url?: string;
  metadata?: Record<string, unknown>;
};

function assertCreateBody(body: CreateBody) {
  if (!body.recipient?.name || !body.recipient?.email) throw new Error("recipient.name and recipient.email are required");
  if (!body.document_markdown && !body.template) throw new Error("template or document_markdown is required");
  if (!Array.isArray(body.fields)) throw new Error("fields array is required");
}

function markdownForBody(body: CreateBody) {
  const source = body.document_markdown ?? loadTemplate(body.template!);
  return applyTemplateVars(source, {
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

function stringMetadata(value: Record<string, unknown>, key: string) {
  const item = value[key];
  return typeof item === "string" ? item : null;
}

export async function createAgreement(body: CreateBody, baseUrl = env.baseUrl) {
  assertCreateBody(body);
  const markdown = markdownForBody(body);
  const id = `agr_${nanoid(12)}`;
  const token = nanoid(32);
  const webhookSecret = body.webhook_url ? `whsec_${nanoid(32)}` : null;
  const createdAt = nowIso();
  const documentTitle = titleFromMarkdown(markdown);
  const senderEmail = normalizeEmailList(body.sender_email)[0] ?? null;
  const senderName = typeof body.sender_name === "string" ? body.sender_name.trim() : "";
  const notificationEmails = normalizeEmailList(body.notification_email ?? body.sender_email);
  const metadata = {
    ...(body.metadata ?? {}),
    ...(notificationEmails.length ? { notification_email: notificationEmails } : {}),
    ...(senderEmail ? { sender_email: senderEmail } : {}),
    ...(senderName ? { sender_name: senderName } : {})
  };

  await run(
    `INSERT INTO agreements (
      id, status, recipient_name, recipient_email, document_markdown, document_title, fields_json,
      webhook_url, webhook_secret, metadata_json, signing_token, created_at, sent_at
    ) VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    body.recipient!.name,
    body.recipient!.email,
    markdown,
    documentTitle,
    JSON.stringify(body.fields),
    body.webhook_url ?? null,
    webhookSecret,
    Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    token,
    createdAt,
    createdAt
  );

  await addAuditEvent({ agreementId: id, eventType: "created", data: { source: body.template ? "template" : "raw_markdown" } });
  const cc = normalizeEmailList(body.cc ?? body.recipient?.cc);
  await addAuditEvent({ agreementId: id, eventType: "sent", data: { recipient_email: body.recipient!.email, cc, sender_email: senderEmail } });

  const signingUrl = `${baseUrl}/sign/${token}`;
  await sendSigningEmail({
    to: body.recipient!.email!,
    cc,
    replyTo: senderEmail ? [senderEmail] : undefined,
    senderName,
    recipientName: body.recipient!.name!,
    documentTitle,
    signingUrl
  });

  posthog.captureEvent("agreement created", {
    agreement_id: id,
    status: "sent",
    source: body.template ? "template" : "raw_markdown",
    template: body.template ?? null,
    field_count: body.fields?.length ?? 0,
    cc_count: cc.length,
    notification_count: notificationEmails.length,
    has_webhook: Boolean(body.webhook_url),
    has_sender_email: Boolean(senderEmail),
    workflow: stringMetadata(metadata, "workflow")
  }, signerDistinctId(id));

  return {
    id,
    status: "sent",
    preview_url: `${baseUrl}/preview/${token}`,
    signing_url: signingUrl,
    webhook_secret: webhookSecret,
    notification_email: notificationEmails,
    created_at: createdAt
  };
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
    preview_url: `${env.baseUrl}/preview/${agreement.signing_token}`,
    signing_url: `${env.baseUrl}/sign/${agreement.signing_token}`,
    created_at: agreement.created_at,
    sent_at: agreement.sent_at,
    viewed_at: agreement.viewed_at,
    completed_at: agreement.completed_at,
    signed_pdf_url: agreement.status === "completed" ? `${env.baseUrl}/v1/agreements/${agreement.id}/pdf` : null,
    signed_pdf_saved: Boolean(agreement.signed_pdf_base64),
    signed_pdf_sha256: agreement.signed_pdf_sha256,
    signed_pdf_bytes: agreement.signed_pdf_bytes
  };
}

agreements.post("/v1/agreements", async (c) => {
  try {
    const result = await createAgreement(await c.req.json<CreateBody>(), new URL(c.req.url).origin);
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
      template_vars_default?: Record<string, unknown>;
      recipients?: Array<{ name: string; email: string; cc?: string | string[]; template_vars?: Record<string, unknown>; metadata?: Record<string, unknown> }>;
      cc?: string | string[];
      notification_email?: string | string[];
      sender_email?: string;
      sender_name?: string;
      fields?: FieldDefinition[];
      webhook_url?: string;
      metadata?: Record<string, unknown>;
    }>();
    if (!Array.isArray(body.recipients) || body.recipients.length === 0) throw new Error("recipients array is required");

    const results = [];
    for (const recipient of body.recipients) {
      results.push(await createAgreement({
        recipient,
        template: body.template,
        document_markdown: body.document_markdown,
        template_vars: { ...(body.template_vars_default ?? {}), ...(recipient.template_vars ?? {}) },
        cc: recipient.cc ?? body.cc,
        notification_email: body.notification_email,
        sender_email: body.sender_email,
        sender_name: body.sender_name,
        fields: body.fields,
        webhook_url: body.webhook_url,
        metadata: { ...(body.metadata ?? {}), ...(recipient.metadata ?? {}) }
      }, new URL(c.req.url).origin));
    }
    return c.json({ agreements: results }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
});

agreements.get("/v1/agreements", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const cursor = c.req.query("cursor");
  const includeSignedFields = c.req.query("include") === "signed_fields";
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
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ ...agreementForApi(agreement, { includeSignedFields: true }), audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
});

agreements.get("/v1/agreements/:id/document", async (c) => {
  const agreement = await getAgreement(c.req.param("id"));
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
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (agreement.status === "completed") return c.json({ error: "Completed agreements cannot be cancelled" }, 400);

  await run("UPDATE agreements SET status = 'cancelled' WHERE id = ?", agreement.id);
  await addAuditEvent({ agreementId: agreement.id, eventType: "cancelled" });
  const updated = (await getAgreement(agreement.id))!;
  if (updated.webhook_url) enqueueWebhook(updated.id, updated.webhook_url, cancelledPayload(updated));
  posthog.captureEvent("agreement cancelled", {
    agreement_id: updated.id,
    previous_status: agreement.status,
    has_webhook: Boolean(updated.webhook_url)
  }, signerDistinctId(updated.id));
  return c.json(agreementForApi(updated, { includeSignedFields: true }));
});

agreements.post("/v1/agreements/:id/remind", async (c) => {
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
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

agreements.get("/v1/agreements/:id/pdf", async (c) => {
  const agreement = await getAgreement(c.req.param("id"));
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
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ agreement_id: agreement.id, audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
});
