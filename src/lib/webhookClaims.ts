import { nanoid } from "nanoid";
import { get, nowIso, runTransaction } from "./db.js";

export const webhookLeaseMs = 60_000;

export async function claimWebhook(deliveryId: string) {
  const token = nanoid(32);
  const now = nowIso();
  const claim = await get<{ token: string }>(
    `INSERT INTO webhook_delivery_leases (delivery_id, token, expires_at)
     SELECT id, ?, ? FROM webhook_deliveries
     WHERE id = ? AND delivered_at IS NULL AND attempts < 5
       AND next_retry_at IS NOT NULL AND next_retry_at <= ?
     ON CONFLICT (delivery_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
       WHERE webhook_delivery_leases.expires_at <= ?
     RETURNING token`,
    token, new Date(Date.parse(now) + webhookLeaseMs).toISOString(), deliveryId, now, now
  );
  if (!claim) return undefined;
  const current = await get<{ id: string }>(
    `SELECT id FROM webhook_deliveries WHERE id = ? AND delivered_at IS NULL AND attempts < 5
     AND next_retry_at IS NOT NULL AND next_retry_at <= ?`, deliveryId, nowIso()
  );
  if (!current) {
    await runTransaction([{ sql: "DELETE FROM webhook_delivery_leases WHERE delivery_id = ? AND token = ?", params: [deliveryId, token] }]);
    return undefined;
  }
  return claim.token;
}

export async function recordWebhookResult(input: { deliveryId: string; token: string; attempt: number; status: number | null; error: string | null; nextRetryAt: string | null; delivered: boolean }) {
  const now = nowIso();
  await runTransaction([
    {
      sql: "UPDATE webhook_delivery_leases SET token = token WHERE delivery_id = ? AND token = ? AND expires_at > ?",
      params: [input.deliveryId, input.token, now], expectedChanges: 1
    },
    {
      sql: `UPDATE webhook_deliveries
            SET attempts = ?, status_code = ?, delivered_at = ?, last_attempt_at = ?, next_retry_at = ?, error = ?
            WHERE id = ? AND delivered_at IS NULL AND EXISTS (
              SELECT 1 FROM webhook_delivery_leases WHERE delivery_id = ? AND token = ? AND expires_at > ?
            )`,
      params: [input.attempt, input.status, input.delivered ? now : null, now, input.nextRetryAt, input.error, input.deliveryId, input.deliveryId, input.token, now], expectedChanges: 1
    },
    { sql: "DELETE FROM webhook_delivery_leases WHERE delivery_id = ? AND token = ?", params: [input.deliveryId, input.token] }
  ]);
}
