import { createHmac } from "node:crypto";
import { nanoid } from "nanoid";
import { all, get, getAgreement, nowIso, parseJson, run } from "../lib/db.js";
import { env } from "../lib/env.js";
import type { Agreement, SignedFields } from "../lib/types.js";

const retryDelaysMs = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

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

export function enqueueWebhook(agreementId: string, url: string, payload: unknown) {
  const id = `whd_${nanoid(16)}`;
  void run(
    `INSERT INTO webhook_deliveries (id, agreement_id, url, payload_json, attempts, next_retry_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    id,
    agreementId,
    url,
    JSON.stringify(payload),
    nowIso()
  ).then(() => deliverWebhook(id));
}

export async function deliverWebhook(deliveryId: string) {
  const delivery = await get<{
    id: string;
    agreement_id: string;
    url: string;
    payload_json: string;
    attempts: number;
  }>("SELECT * FROM webhook_deliveries WHERE id = ?", deliveryId);
  if (!delivery) return;

  const agreement = await getAgreement(delivery.agreement_id);
  if (!agreement?.webhook_secret) return;

  const attempt = delivery.attempts + 1;
  const signature = signWebhookPayload(delivery.payload_json, agreement.webhook_secret);

  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentInk-Signature": signature
      },
      body: delivery.payload_json
    });

    if (response.status >= 200 && response.status < 300) {
      await run(
        `UPDATE webhook_deliveries
         SET attempts = ?, status_code = ?, delivered_at = ?, last_attempt_at = ?, next_retry_at = NULL, error = NULL
         WHERE id = ?`,
        attempt,
        response.status,
        nowIso(),
        nowIso(),
        delivery.id
      );
      return;
    }

    await scheduleRetry(delivery.id, attempt, response.status, `HTTP ${response.status}`);
  } catch (error) {
    await scheduleRetry(delivery.id, attempt, null, error instanceof Error ? error.message : String(error));
  }
}

async function scheduleRetry(deliveryId: string, attempts: number, statusCode: number | null, error: string) {
  const delay = retryDelaysMs[attempts - 1];
  const nextRetryAt = delay && attempts < 5 ? new Date(Date.now() + delay).toISOString() : null;
  await run(
    `UPDATE webhook_deliveries
     SET attempts = ?, status_code = ?, last_attempt_at = ?, next_retry_at = ?, error = ?
     WHERE id = ?`,
    attempts,
    statusCode,
    nowIso(),
    nextRetryAt,
    error,
    deliveryId
  );
}

export function startWebhookRetryWorker() {
  setInterval(async () => {
    const due = await all<{ id: string }>(
      `SELECT id FROM webhook_deliveries
       WHERE delivered_at IS NULL AND next_retry_at IS NOT NULL AND next_retry_at <= ?
       ORDER BY next_retry_at ASC
       LIMIT 10`,
      nowIso()
    );

    for (const delivery of due) {
      void deliverWebhook(delivery.id);
    }
  }, 15_000).unref();
}
