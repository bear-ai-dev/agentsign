import { createHash } from "node:crypto";
import type { AuditEvent } from "./types.js";

export function documentHash(document: string | Buffer) {
  return createHash("sha256").update(document).digest("hex");
}

export function auditEventsForApi(events: AuditEvent[]) {
  return events.map((event) => ({
    id: event.id,
    event_type: event.event_type,
    ip_address: event.ip_address,
    user_agent: event.user_agent,
    data: event.data_json ? JSON.parse(event.data_json) : null,
    created_at: event.created_at
  }));
}
