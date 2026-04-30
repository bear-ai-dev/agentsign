import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { all, get, nowIso, run } from "./db.js";
import { env } from "./env.js";
import type { ApiKeyRecord } from "./types.js";

const apiKeysTable = "agentcontract_api_keys";

export type ApiKeyOwner = {
  ownerId?: string | null;
  ownerEmail?: string | null;
};

export function hashApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

function keyEnvironment() {
  return env.isVercel || process.env.NODE_ENV === "production" ? "live" : "local";
}

export function generateApiKey() {
  return `ak_${keyEnvironment()}_${randomBytes(24).toString("base64url")}`;
}

export async function createApiKey(input: ApiKeyOwner & { name?: string }) {
  const key = generateApiKey();
  const record: ApiKeyRecord = {
    id: `key_${nanoid(12)}`,
    key_hash: hashApiKey(key),
    key_prefix: key.slice(0, 16),
    last4: key.slice(-4),
    name: input.name?.trim() || "AgentContract CLI",
    owner_id: input.ownerId ?? null,
    owner_email: input.ownerEmail ?? null,
    created_at: nowIso(),
    last_used_at: null,
    revoked_at: null
  };

  await run(
    `INSERT INTO ${apiKeysTable} (id, key_hash, key_prefix, last4, name, owner_id, owner_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.key_hash,
    record.key_prefix,
    record.last4,
    record.name,
    record.owner_id,
    record.owner_email,
    record.created_at
  );

  return { key, record };
}

export async function listApiKeysForOwner(ownerEmail: string | null | undefined) {
  if (!ownerEmail) return [];
  return all<ApiKeyRecord>(
    `SELECT * FROM ${apiKeysTable} WHERE owner_email = ? ORDER BY created_at DESC`,
    ownerEmail
  );
}

export async function revokeApiKeyForOwner(id: string, ownerEmail: string | null | undefined) {
  if (!ownerEmail) return false;
  await run(`UPDATE ${apiKeysTable} SET revoked_at = ? WHERE id = ? AND owner_email = ? AND revoked_at IS NULL`, nowIso(), id, ownerEmail);
  const record = await get<ApiKeyRecord>(`SELECT * FROM ${apiKeysTable} WHERE id = ? AND owner_email = ?`, id, ownerEmail);
  return Boolean(record?.revoked_at);
}

export async function verifyStoredApiKey(key: string) {
  const record = await get<ApiKeyRecord>(
    `SELECT * FROM ${apiKeysTable} WHERE key_hash = ? AND revoked_at IS NULL`,
    hashApiKey(key)
  );
  if (!record) return null;

  await run(`UPDATE ${apiKeysTable} SET last_used_at = ? WHERE id = ?`, nowIso(), record.id);
  return record;
}
