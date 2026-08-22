import { randomBytes, randomInt } from "node:crypto";
import { nanoid } from "nanoid";
import { hashApiKey } from "./apiKeys.js";
import { get, hasColumn, nowIso, run } from "./db.js";
import type { CliLoginCode } from "./types.js";

const ttlMs = 5 * 60 * 1000;
const issuanceCooldownMs = 60_000;
const maxFailedAttempts = 5;
const maxCodeGenerationAttempts = 10;

export class LoginCodeRateLimitError extends Error {
  constructor() {
    super("Please wait before requesting another login code");
    this.name = "LoginCodeRateLimitError";
  }
}

function normalizedEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

async function cleanupLoginCodes() {
  const now = nowIso();
  await run("DELETE FROM cli_login_codes WHERE used_at IS NOT NULL OR expires_at <= ?", now);
}

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
    normalizedEmail(input.ownerEmail),
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
  const ownerEmail = normalizedEmail(input.ownerEmail);
  if (!ownerEmail) throw new Error("ownerEmail is required for email login codes");

  await cleanupLoginCodes();
  const active = await get<Pick<CliLoginCode, "created_at">>(
    "SELECT created_at FROM cli_login_codes WHERE owner_email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
    ownerEmail,
    nowIso()
  );
  if (active && Date.now() - new Date(active.created_at).getTime() < issuanceCooldownMs) {
    throw new LoginCodeRateLimitError();
  }
  await run("UPDATE cli_login_codes SET used_at = ? WHERE owner_email = ? AND used_at IS NULL", nowIso(), ownerEmail);

  for (let attempt = 0; attempt < maxCodeGenerationAttempts; attempt += 1) {
    try {
      return await insertLoginCode(String(randomInt(100000, 1_000_000)), { ...input, ownerEmail });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/active_email|owner_email/i.test(message)) throw new LoginCodeRateLimitError();
      if (!/unique|duplicate|constraint/i.test(message) || attempt === maxCodeGenerationAttempts - 1) throw error;
    }
  }
  throw new Error("Could not generate a unique login code");
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
  const email = normalizedEmail(ownerEmail);
  if (!email) return null;
  const record = await get<CliLoginCode>(
    "SELECT * FROM cli_login_codes WHERE code_hash = ? AND owner_email = ? AND used_at IS NULL AND expires_at > ? AND failed_attempts < ?",
    hashApiKey(code),
    email,
    nowIso(),
    maxFailedAttempts
  );
  if (!record) {
    await run(
      `UPDATE cli_login_codes
       SET failed_attempts = failed_attempts + 1,
           used_at = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE used_at END
       WHERE owner_email = ? AND used_at IS NULL AND expires_at > ?`,
      maxFailedAttempts,
      nowIso(),
      email,
      nowIso()
    );
    return null;
  }
  return claimLoginCode(record);
}

export async function invalidateEmailLoginCode(code: string, ownerEmail: string) {
  await run(
    "UPDATE cli_login_codes SET used_at = ? WHERE code_hash = ? AND owner_email = ? AND used_at IS NULL",
    nowIso(),
    hashApiKey(code),
    normalizedEmail(ownerEmail)
  );
}
