import type { AgreementInsert } from "../../src/lib/serializedAgreementCreation.js";

export const creationTable = "CREATE TABLE agreements (id TEXT PRIMARY KEY, idempotency_scope TEXT, idempotency_key TEXT, creation_request_sha256 TEXT, metadata_json TEXT)";
export const toPg = (sql: string) => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };
export function insertInput(id: string, scope = "owner:a", key = "a".repeat(64), requestHash = "original", global = true): AgreementInsert {
  return { sql: "INSERT INTO agreements VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", params: [id, scope, key, requestHash, null], key, scope, requestHash, global, metadataParamIndex: 4 };
}
