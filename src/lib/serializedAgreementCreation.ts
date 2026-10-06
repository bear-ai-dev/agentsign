import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type pg from "pg";
import { ProviderRequestError } from "./embeddedSigning.js";
import type { Agreement } from "./types.js";

export type AgreementInsert = {
  sql: string;
  params: unknown[];
  key: string;
  scope: string;
  requestHash: string;
  global?: boolean;
  metadataParamIndex: number;
};

export const globalIdempotencyMarker = "_agentsign_global_idempotency";

function creationMetadata(value: string | null, global: boolean) {
  const metadata = value ? JSON.parse(value) as Record<string, unknown> : {};
  delete metadata[globalIdempotencyMarker];
  if (global) metadata[globalIdempotencyMarker] = true;
  return Object.keys(metadata).length ? JSON.stringify(metadata) : null;
}

function globallyClaimed(row: Agreement) {
  return row.metadata_json ? JSON.parse(row.metadata_json)[globalIdempotencyMarker] === true : false;
}

export function agreementCreationLock(key: string) {
  return createHash("sha256").update(key).digest().readBigInt64BE(0).toString();
}

function existingCreation(rows: Agreement[], input: AgreementInsert) {
  const foreign = rows.filter(row => row.idempotency_scope !== input.scope);
  if (foreign.some(row => input.global || globallyClaimed(row))) {
    throw new ProviderRequestError("cannot-confirm-original-send", 409);
  }
  const own = rows.filter(row => row.idempotency_scope === input.scope);
  if (own.some(row => row.creation_request_sha256 !== input.requestHash)) throw new ProviderRequestError("idempotency_key was already used with a different request", 409);
  return own[0];
}

export async function serializedAgreementInsert(
  database: { sqlite: Database.Database | null; pool: Pick<pg.Pool, "connect"> | null; toPg: (sql: string) => string },
  input: AgreementInsert
): Promise<{ changes: number; existing?: Agreement }> {
  const params = [...input.params];
  params[input.metadataParamIndex] = creationMetadata(params[input.metadataParamIndex] as string | null, input.global === true);
  if (database.pool) {
    const client = await database.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [agreementCreationLock(input.key)]);
      const rows = await client.query("SELECT * FROM agreements WHERE idempotency_key = $1", [input.key]);
      const existing = existingCreation(rows.rows, input);
      if (existing && input.global && !globallyClaimed(existing)) {
        existing.metadata_json = creationMetadata(existing.metadata_json, true);
        await client.query("UPDATE agreements SET metadata_json = $1 WHERE id = $2", [existing.metadata_json, existing.id]);
      }
      const changes = existing ? 0 : (await client.query(database.toPg(input.sql), params)).rowCount;
      if (!existing && changes !== 1) throw new Error("Agreement insert did not create a record");
      await client.query("COMMIT");
      return { changes: changes ?? 0, ...(existing ? { existing } : {}) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { discard = true; throw rollbackError; }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  const sqlite = database.sqlite;
  if (!sqlite) throw new Error("Agreement database unavailable");
  return sqlite.transaction(() => {
    const rows = sqlite.prepare("SELECT * FROM agreements WHERE idempotency_key = ?").all(input.key) as Agreement[];
    const existing = existingCreation(rows, input);
    if (existing && input.global && !globallyClaimed(existing)) {
      existing.metadata_json = creationMetadata(existing.metadata_json, true);
      sqlite.prepare("UPDATE agreements SET metadata_json = ? WHERE id = ?").run(existing.metadata_json, existing.id);
    }
    if (existing) return { changes: 0, existing };
    const changes = sqlite.prepare(input.sql).run(...params).changes;
    if (changes !== 1) throw new Error("Agreement insert did not create a record");
    return { changes };
  }).immediate();
}
