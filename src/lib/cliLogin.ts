import { randomBytes, randomInt } from "node:crypto";
import { nanoid } from "nanoid";
import { hashApiKey } from "./apiKeys.js";
import { get, hasColumn, nowIso, run } from "./db.js";
import type { CliLoginCode } from "./types.js";

const ttlMs = 5 * 60 * 1000;

async function insertLoginCode(code: string, input: {
  keyName?: string | null;
  ownerId?: string | null;
  ownerEmail?: string | null;
}) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const hasLegacyPlaintextColumn = await hasColumn("cli_login_codes", "api_key_plaintext");

  await run(
    `INSERT INTO cli_login_codes (${[
      "id",
      "code_hash",
      hasLegacyPlaintextColumn ? "api_key_plaintext" : "",
      "key_name",
      "owner_id",
      "owner_email",
      "created_at",
      "expires_at"
    ].filter(Boolean).join(", ")})
     VALUES (${Array.from({ length: hasLegacyPlaintextColumn ? 8 : 7 }, () => "?").join(", ")})`,
    `clc_${nanoid(12)}`,
    hashApiKey(code),
    ...(hasLegacyPlaintextColumn ? [""] : []),
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

async function claimLoginCode(record: CliLoginCode) {
  if (new Date(record.expires_at).getTime() < Date.now()) return null;

  const claimed = await run("UPDATE cli_login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL", nowIso(), record.id);
  if (claimed.changes !== 1) return null;

  return {
    keyName: record.key_name,
    ownerEmail: record.owner_email,
    ownerId: record.owner_id
  };
}

export async function consumeCliLoginCode(code: string) {
  const record = await get<CliLoginCode>(
    "SELECT * FROM cli_login_codes WHERE code_hash = ? AND used_at IS NULL",
    hashApiKey(code)
  );
  if (!record) return null;
  return claimLoginCode(record);
}

export async function consumeEmailLoginCode(code: string, ownerEmail: string) {
  const record = await get<CliLoginCode>(
    "SELECT * FROM cli_login_codes WHERE code_hash = ? AND owner_email = ? AND used_at IS NULL",
    hashApiKey(code),
    ownerEmail
  );
  if (!record) return null;
  return claimLoginCode(record);
}
