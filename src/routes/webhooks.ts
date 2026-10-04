import { createHmac } from "node:crypto";
import { nanoid } from "nanoid";
import { all, get, getAgreement, nowIso, parseJson, run } from "../lib/db.js";
import { env } from "../lib/env.js";
import type { Agreement, SignedFields } from "../lib/types.js";
import { claimWebhook, recordWebhookResult } from "../lib/webhookClaims.js";
import { postWebhook } from "../lib/safeWebhook.js";

const retryDelaysMs = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const deliveriesInFlight = new Map<string, Promise<void>>();

export function signWebhookPayload(payloadJson: string, secret: string) {
  return createHmac("sha256", secret).update(payloadJson).digest("hex");
}

export function completedPayload(agreement: Agreement) {
  const fields = parseJson<SignedFields>(agreement.signed_fields_json, {});
  return {
    event: "agreement.completed",
    agreement_id: agreement.id,
    completed_at: agreement.completed_at,
    recipient: { name: agreement.recipient_name, email: agreement.recipient_email },
    fields,
    signed_pdf_url: `${env.baseUrl}/v1/agreements/${agreement.id}/pdf`,
    audit_trail_url: `${env.baseUrl}/v1/agreements/${agreement.id}/audit`,
    metadata: parseJson<Record<string, unknown> | null>(agreement.metadata_json, null)
  };
}

export function cancelledPayload(agreement: Agreement) {
  return {
    event: "agreement.cancelled",
    agreement_id: agreement.id,
    cancelled_at: nowIso(),
    recipient: { name: agreement.recipient_name, email: agreement.recipient_email },
    metadata: parseJson<Record<string, unknown> | null>(agreement.metadata_json, null)
  };
}

export function webhookInsertStatement(agreementId: string, url: string, payload: unknown) {
  const id = `whd_${nanoid(16)}`;
  return {
    id,
    sql: `INSERT INTO webhook_deliveries (id, agreement_id, url, payload_json, attempts, next_retry_at) VALUES (?, ?, ?, ?, 0, ?)`,
    params: [id, agreementId, url, JSON.stringify(payload), nowIso()]
  };
}

export async function enqueueWebhook(agreementId: string, url: string, payload: unknown) {
  const statement = webhookInsertStatement(agreementId, url, payload);
  await run(statement.sql, ...statement.params);
  void deliverWebhook(statement.id).catch((error) => console.error("[AgentContract webhook delivery failed]", error));
}

export function deliverWebhook(deliveryId: string): Promise<void> {
  const pending = deliveriesInFlight.get(deliveryId);
  if (pending) return pending;
  const delivery = executeWebhookDelivery(deliveryId).finally(() => deliveriesInFlight.delete(deliveryId));
  deliveriesInFlight.set(deliveryId, delivery);
  return delivery;
}

async function executeWebhookDelivery(deliveryId: string) {
  const delivery = await get<{
    id: string;
    agreement_id: string;
    url: string;
    payload_json: string;
    attempts: number;
    delivered_at: string | null;
  }>("SELECT * FROM webhook_deliveries WHERE id = ?", deliveryId);
  if (!delivery || delivery.delivered_at) return;

  const agreement = await getAgreement(delivery.agreement_id);
  if (!agreement?.webhook_secret) return;

  const token = await claimWebhook(deliveryId);
  if (!token) return;
  const claimed = await get<{ attempts: number; expires_at: string }>(
    `SELECT webhook_deliveries.attempts, webhook_delivery_leases.expires_at
     FROM webhook_deliveries JOIN webhook_delivery_leases ON delivery_id = webhook_deliveries.id
     WHERE webhook_deliveries.id = ? AND token = ? AND delivered_at IS NULL AND webhook_deliveries.attempts < 5`, deliveryId, token
  );
  if (!claimed || !Number.isFinite(Date.parse(claimed.expires_at)) || Date.parse(claimed.expires_at) <= Date.now()) return;
  const attempt = claimed.attempts + 1;
  const signature = signWebhookPayload(delivery.payload_json, agreement.webhook_secret);
  let status: number | null = null;
  let error: string | null = null;
  try {
    status = await postWebhook(delivery.url, delivery.payload_json, {
      "Content-Type": "application/json",
      "X-AgentInk-Signature": signature,
      "X-AgentInk-Delivery-Id": delivery.id
    }, { deadlineAt: Date.parse(claimed.expires_at) - 1_000 });
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const delivered = status !== null && status >= 200 && status < 300;
  const delay = retryDelaysMs[attempt - 1];
  const nextRetryAt = !delivered && delay && attempt < 5 ? new Date(Date.now() + delay).toISOString() : null;
  await recordWebhookResult({ deliveryId, token, attempt, status, error, nextRetryAt, delivered });
}

export async function retryDueWebhooks() {
  try {
    const now = nowIso();
    const due = await all<{ id: string }>(
      `SELECT id FROM webhook_deliveries
       WHERE delivered_at IS NULL AND attempts < 5 AND next_retry_at IS NOT NULL AND next_retry_at <= ?
         AND EXISTS (SELECT 1 FROM agreements WHERE agreements.id = webhook_deliveries.agreement_id AND webhook_secret IS NOT NULL AND webhook_secret <> '')
         AND NOT EXISTS (SELECT 1 FROM webhook_delivery_leases WHERE delivery_id = webhook_deliveries.id AND expires_at > ?)
       ORDER BY next_retry_at ASC
       LIMIT 10`,
      now, now
    );
    let failed = 0;
    await Promise.all(due.map(delivery => deliverWebhook(delivery.id).catch(error => {
      failed++;
      console.error("[AgentContract webhook retry failed]", delivery.id, error);
    })));
    return { checked: due.length, failed };
  } catch (error) {
    console.error("[AgentContract webhook retry query failed]", error);
    return { checked: 0, failed: 1 };
  }
}

export function startWebhookRetryWorker() {
  setInterval(retryDueWebhooks, 15_000).unref();
}
