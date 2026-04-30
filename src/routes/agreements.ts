import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { addAuditEvent, all, getAgreement, getAuditEvents, nowIso, parseJson, run } from "../lib/db.js";
import { env } from "../lib/env.js";
import { requireApiKey } from "../lib/auth.js";
import { sendSigningEmail } from "../lib/email.js";
import { renderPDF } from "../lib/pdf.js";
import { applyTemplateVars, loadTemplate, titleFromMarkdown } from "../lib/templates.js";
import { auditEventsForApi } from "../lib/audit.js";
import type { Agreement, FieldDefinition, SignedFields } from "../lib/types.js";
import { cancelledPayload, enqueueWebhook } from "./webhooks.js";

export const agreements = new Hono();
agreements.use("/v1/*", requireApiKey);

type CreateBody = {
  recipient?: { name?: string; email?: string; cc?: string | string[] };
  cc?: string | string[];
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
  return applyTemplateVars(source, body.template_vars ?? {});
}

function normalizeEmailList(value: string | string[] | undefined) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((email) => email.trim()).filter(Boolean);
}

async function createAgreement(body: CreateBody, baseUrl = env.baseUrl) {
  assertCreateBody(body);
  const markdown = markdownForBody(body);
  const id = `agr_${nanoid(12)}`;
  const token = nanoid(32);
  const webhookSecret = body.webhook_url ? `whsec_${nanoid(32)}` : null;
  const createdAt = nowIso();
  const documentTitle = titleFromMarkdown(markdown);

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
    body.metadata ? JSON.stringify(body.metadata) : null,
    token,
    createdAt,
    createdAt
  );

  await addAuditEvent({ agreementId: id, eventType: "created", data: { source: body.template ? "template" : "raw_markdown" } });
  const cc = normalizeEmailList(body.cc ?? body.recipient?.cc);
  await addAuditEvent({ agreementId: id, eventType: "sent", data: { recipient_email: body.recipient!.email, cc } });

  const signingUrl = `${baseUrl}/sign/${token}`;
  await sendSigningEmail({
    to: body.recipient!.email!,
    cc,
    recipientName: body.recipient!.name!,
    documentTitle,
    signingUrl
  });

  return { id, status: "sent", signing_url: signingUrl, webhook_secret: webhookSecret, created_at: createdAt };
}

function agreementForApi(agreement: Agreement) {
  return {
    id: agreement.id,
    status: agreement.status,
    recipient: { name: agreement.recipient_name, email: agreement.recipient_email },
    document_title: agreement.document_title,
    fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
    signed_fields: parseJson<SignedFields | null>(agreement.signed_fields_json, null),
    webhook_url: agreement.webhook_url,
    webhook_secret: agreement.webhook_secret,
    metadata: parseJson<Record<string, unknown> | null>(agreement.metadata_json, null),
    signing_url: `${env.baseUrl}/sign/${agreement.signing_token}`,
    created_at: agreement.created_at,
    sent_at: agreement.sent_at,
    viewed_at: agreement.viewed_at,
    completed_at: agreement.completed_at,
    signed_pdf_url: agreement.signed_pdf_path ? `${env.baseUrl}/v1/agreements/${agreement.id}/pdf` : null
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
  return c.json({ agreements: rows.map(agreementForApi), next_cursor: rows.at(-1)?.created_at ?? null });
});

agreements.get("/v1/agreements/:id", async (c) => {
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ ...agreementForApi(agreement), audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
});

agreements.post("/v1/agreements/:id/cancel", async (c) => {
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (agreement.status === "completed") return c.json({ error: "Completed agreements cannot be cancelled" }, 400);

  await run("UPDATE agreements SET status = 'cancelled' WHERE id = ?", agreement.id);
  await addAuditEvent({ agreementId: agreement.id, eventType: "cancelled" });
  const updated = (await getAgreement(agreement.id))!;
  if (updated.webhook_url) enqueueWebhook(updated.id, updated.webhook_url, cancelledPayload(updated));
  return c.json(agreementForApi(updated));
});

agreements.post("/v1/agreements/:id/remind", async (c) => {
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  if (agreement.status === "completed" || agreement.status === "cancelled") return c.json({ error: `Cannot remind ${agreement.status} agreement` }, 400);

  await sendSigningEmail({
    to: agreement.recipient_email,
    recipientName: agreement.recipient_name,
    documentTitle: agreement.document_title,
    signingUrl: `${env.baseUrl}/sign/${agreement.signing_token}`
  });
  await addAuditEvent({ agreementId: agreement.id, eventType: "sent", data: { reminder: true } });
  return c.json({ ok: true });
});

agreements.get("/v1/agreements/:id/pdf", async (c) => {
  const agreement = await getAgreement(c.req.param("id"));
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);

  let path = agreement.signed_pdf_path;
  if (!path || !existsSync(path)) {
    path = await renderPDF({
      agreementId: agreement.id,
      markdown: agreement.document_markdown,
      fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
      signedFields: parseJson<SignedFields | undefined>(agreement.signed_fields_json, undefined),
      auditEvents: await getAuditEvents(agreement.id)
    });
    if (agreement.status === "completed") {
      await run("UPDATE agreements SET signed_pdf_path = ? WHERE id = ?", path, agreement.id);
    }
  }

  return new Response(readFileSync(path), {
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
