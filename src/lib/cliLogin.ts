import { randomBytes, randomInt } from "node:crypto";
import { nanoid } from "nanoid";
import { hashApiKey } from "./apiKeys.js";
import { get, nowIso, run } from "./db.js";
import type { CliLoginCode } from "./types.js";

const ttlMs = 5 * 60 * 1000;

async function insertLoginCode(code: string, input: {
  keyName?: string | null;
  ownerId?: string | null;
  ownerEmail?: string | null;
}) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  await run(
    `INSERT INTO cli_login_codes (id, code_hash, key_name, owner_id, owner_email, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `clc_${nanoid(12)}`,
    hashApiKey(code),
    input.keyName?.trim() || "AgentContract CLI",
    input.ownerId ?? null,
    input.ownerEmail ?? null,
    createdAt,
    expiresAt
  );

  return code;
}

export async function createCliLoginCode(input: {
  keyName?: string | null;
  ownerId?: string | null;
  ownerEmail?: string | null;
}) {
  return insertLoginCode(`clc_${randomBytes(24).toString("base64url")}`, input);
}

export async function createEmailLoginCode(input: {
  keyName?: string | null;
  ownerId?: string | null;
  ownerEmail?: string | null;
}) {
  return insertLoginCode(String(randomInt(100000, 1_000_000)), input);
}

export async function consumeCliLoginCode(code: string) {
  const record = await get<CliLoginCode>(
    "SELECT * FROM cli_login_codes WHERE code_hash = ? AND used_at IS NULL",
    hashApiKey(code)
  );
  if (!record) return null;
  if (new Date(record.expires_at).getTime() < Date.now()) return null;

  await run("UPDATE cli_login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL", nowIso(), record.id);
  return {
    keyName: record.key_name,
    ownerEmail: record.owner_email,
    ownerId: record.owner_id
  };
}
