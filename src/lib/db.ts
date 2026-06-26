import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import pg from "pg";
import { env } from "./env.js";
import type { Agreement, AuditEvent, AgreementStatus, SignerRole } from "./types.js";

mkdirSync(dirname(env.databasePath), { recursive: true });

const usePostgres = Boolean(process.env.DATABASE_URL);
const sqlite = usePostgres ? null : new Database(env.databasePath);
const pool = usePostgres ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

if (sqlite) {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
}

export const dbReady = ensureSchema();

export function nowIso() {
  return new Date().toISOString();
}

export type RunResult = {
  changes: number;
};

export async function run(sql: string, ...params: unknown[]) {
  await dbReady;
  if (pool) {
    const result = await pool.query(toPg(sql), params);
    return { changes: result.rowCount ?? 0 } satisfies RunResult;
  }
  const result = sqlite!.prepare(sql).run(...params);
  return { changes: result.changes } satisfies RunResult;
}

export async function runTransaction(statements: Array<{ sql: string; params?: unknown[] }>) {
  await dbReady;
  if (!statements.length) return;

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(toPg(statement.sql), statement.params ?? []);
      }
      await client.query("COMMIT");
      return;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const transaction = sqlite!.transaction((items: Array<{ sql: string; params?: unknown[] }>) => {
    for (const statement of items) {
      sqlite!.prepare(statement.sql).run(...(statement.params ?? []));
    }
  });
  transaction(statements);
}

export async function get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  await dbReady;
  if (pool) {
    const result = await pool.query(toPg(sql), params);
    return result.rows[0] as T | undefined;
  }
  return sqlite!.prepare(sql).get(...params) as T | undefined;
}

export async function all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  await dbReady;
  if (pool) {
    const result = await pool.query(toPg(sql), params);
    return result.rows as T[];
  }
  return sqlite!.prepare(sql).all(...params) as T[];
}

export async function hasColumn(table: string, column: string) {
  await dbReady;
  if (pool) {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
      [table, column]
    );
    return Boolean(result.rows[0]);
  }

  return sqlite!
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => (item as { name: string }).name === column);
}

export async function addAuditEvent(input: {
  agreementId: string;
  eventType: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  data?: unknown;
}) {
  await run(
    `INSERT INTO audit_events (id, agreement_id, event_type, ip_address, user_agent, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `evt_${nanoid(16)}`,
    input.agreementId,
    input.eventType,
    input.ipAddress ?? null,
    input.userAgent ?? null,
    input.data === undefined ? null : JSON.stringify(input.data),
    nowIso()
  );
}

export async function getAgreement(id: string): Promise<Agreement | undefined> {
  return get<Agreement>("SELECT * FROM agreements WHERE id = ?", id);
}

export async function getAgreementByToken(token: string): Promise<Agreement | undefined> {
  return get<Agreement>("SELECT * FROM agreements WHERE signing_token = ?", token);
}

export async function getAgreementBySigningToken(token: string): Promise<{ agreement: Agreement; signerRole: SignerRole } | undefined> {
  const agreement = await get<Agreement>(
    "SELECT * FROM agreements WHERE signing_token = ? OR sender_signing_token = ? LIMIT 1",
    token,
    token
  );
  if (!agreement) return undefined;
  return {
    agreement,
    signerRole: agreement.sender_signing_token === token ? "sender" : "recipient"
  };
}

export async function getAuditEvents(agreementId: string): Promise<AuditEvent[]> {
  return all<AuditEvent>("SELECT * FROM audit_events WHERE agreement_id = ? ORDER BY created_at ASC", agreementId);
}

export async function updateAgreementStatus(id: string, status: AgreementStatus) {
  await run("UPDATE agreements SET status = ? WHERE id = ?", status, id);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function ensureSchema() {
  const exists = usePostgres
    ? await pool!.query("SELECT to_regclass('public.agreements') AS table_name").then((result) => result.rows[0]?.table_name)
    : sqlite!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agreements'").get();
  if (!exists) {
    await applyMigrationFile("001_init.sql");
  }

  await ensureAgreementStorageSchema();
  await ensureApiKeysSchema();
  await ensureCliLoginCodesSchema();
  await ensureProductFeedbackSchema();
  await ensureAgentSessionSchema();
}

async function ensureAgreementStorageSchema() {
  const columns = [
    ["sender_signing_token", "TEXT"],
    ["owner_email", "TEXT"],
    ["signed_pdf_base64", "TEXT"],
    ["signed_pdf_sha256", "TEXT"],
    ["signed_pdf_bytes", "INTEGER"]
  ] as const;

  if (pool) {
    for (const [name, type] of columns) {
      await pool.query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_agreements_sender_signing_token ON agreements(sender_signing_token) WHERE sender_signing_token IS NOT NULL");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agreements_owner_email ON agreements(owner_email) WHERE owner_email IS NOT NULL");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agreements_signed_pdf_sha256 ON agreements(signed_pdf_sha256) WHERE signed_pdf_sha256 IS NOT NULL");
    return;
  }

  const existing = new Set(
    sqlite!.prepare("PRAGMA table_info(agreements)").all().map((column) => (column as { name: string }).name)
  );
  for (const [name, type] of columns) {
    if (!existing.has(name)) sqlite!.exec(`ALTER TABLE agreements ADD COLUMN ${name} ${type}`);
  }
  sqlite!.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agreements_sender_signing_token ON agreements(sender_signing_token) WHERE sender_signing_token IS NOT NULL");
  sqlite!.exec("CREATE INDEX IF NOT EXISTS idx_agreements_owner_email ON agreements(owner_email) WHERE owner_email IS NOT NULL");
  sqlite!.exec("CREATE INDEX IF NOT EXISTS idx_agreements_signed_pdf_sha256 ON agreements(signed_pdf_sha256) WHERE signed_pdf_sha256 IS NOT NULL");
}

async function ensureApiKeysSchema() {
  const apiKeyColumns = [
    ["key_hash", "TEXT"],
    ["key_prefix", "TEXT"],
    ["last4", "TEXT"],
    ["name", "TEXT"],
    ["owner_id", "TEXT"],
    ["owner_email", "TEXT"],
    ["created_at", "TEXT"],
    ["last_used_at", "TEXT"],
    ["revoked_at", "TEXT"]
  ] as const;
  const sql = `CREATE TABLE IF NOT EXISTS agentcontract_api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    last4 TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT,
    owner_email TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`;

  if (pool) {
    await pool.query(sql);
    for (const [name, type] of apiKeyColumns) {
      await pool.query(`ALTER TABLE agentcontract_api_keys ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_owner_email ON agentcontract_api_keys(owner_email)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_hash ON agentcontract_api_keys(key_hash)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_active ON agentcontract_api_keys(revoked_at) WHERE revoked_at IS NULL");
    return;
  }

  sqlite!.exec(sql);
  const columns = new Set(
    sqlite!.prepare("PRAGMA table_info(agentcontract_api_keys)").all().map((column) => (column as { name: string }).name)
  );
  for (const [name, type] of apiKeyColumns) {
    if (!columns.has(name)) sqlite!.exec(`ALTER TABLE agentcontract_api_keys ADD COLUMN ${name} ${type}`);
  }
  sqlite!.exec(`
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_owner_email ON agentcontract_api_keys(owner_email);
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_hash ON agentcontract_api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_active ON agentcontract_api_keys(revoked_at) WHERE revoked_at IS NULL;
  `);
}

async function ensureCliLoginCodesSchema() {
  const columns = [
    ["key_name", "TEXT"],
    ["owner_id", "TEXT"],
    ["owner_email", "TEXT"],
    ["created_at", "TEXT"],
    ["expires_at", "TEXT"],
    ["used_at", "TEXT"]
  ] as const;
  const sql = `CREATE TABLE IF NOT EXISTS cli_login_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    key_name TEXT NOT NULL,
    owner_id TEXT,
    owner_email TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`;

  if (pool) {
    await pool.query(sql);
    for (const [name, type] of columns) {
      await pool.query(`ALTER TABLE cli_login_codes ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await pool.query("UPDATE cli_login_codes SET key_name = 'AgentContract CLI' WHERE key_name IS NULL");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_cli_login_codes_hash ON cli_login_codes(code_hash)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_cli_login_codes_pending ON cli_login_codes(expires_at) WHERE used_at IS NULL");
    return;
  }

  sqlite!.exec(sql);
  const existing = new Set(
    sqlite!.prepare("PRAGMA table_info(cli_login_codes)").all().map((column) => (column as { name: string }).name)
  );
  for (const [name, type] of columns) {
    if (!existing.has(name)) sqlite!.exec(`ALTER TABLE cli_login_codes ADD COLUMN ${name} ${type}`);
  }
  sqlite!.exec(`
    UPDATE cli_login_codes SET key_name = 'AgentContract CLI' WHERE key_name IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cli_login_codes_hash ON cli_login_codes(code_hash);
    CREATE INDEX IF NOT EXISTS idx_cli_login_codes_pending ON cli_login_codes(expires_at) WHERE used_at IS NULL;
  `);
}

async function ensureProductFeedbackSchema() {
  const columns = [
    ["owner_email", "TEXT"],
    ["reporter_email", "TEXT"],
    ["reporter_name", "TEXT"],
    ["source", "TEXT"],
    ["category", "TEXT"],
    ["severity", "TEXT"],
    ["command", "TEXT"],
    ["message", "TEXT"],
    ["expected", "TEXT"],
    ["actual", "TEXT"],
    ["context_json", "TEXT"],
    ["status", "TEXT"],
    ["created_at", "TEXT"]
  ] as const;
  const sql = `CREATE TABLE IF NOT EXISTS product_feedback (
    id TEXT PRIMARY KEY,
    owner_email TEXT,
    reporter_email TEXT,
    reporter_name TEXT,
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    command TEXT,
    message TEXT NOT NULL,
    expected TEXT,
    actual TEXT,
    context_json TEXT,
    status TEXT NOT NULL CHECK(status IN ('open', 'triaged', 'closed')) DEFAULT 'open',
    created_at TEXT NOT NULL
  )`;

  if (pool) {
    await pool.query(sql);
    for (const [name, type] of columns) {
      await pool.query(`ALTER TABLE product_feedback ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await pool.query("UPDATE product_feedback SET source = 'agentcontract-cli' WHERE source IS NULL");
    await pool.query("UPDATE product_feedback SET category = 'general' WHERE category IS NULL");
    await pool.query("UPDATE product_feedback SET severity = 'normal' WHERE severity IS NULL");
    await pool.query("UPDATE product_feedback SET status = 'open' WHERE status IS NULL");
    await pool.query("UPDATE product_feedback SET created_at = NOW()::text WHERE created_at IS NULL");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_product_feedback_created_at ON product_feedback(created_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_product_feedback_status ON product_feedback(status)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_product_feedback_owner_email ON product_feedback(owner_email)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_product_feedback_reporter_email ON product_feedback(reporter_email)");
    return;
  }

  sqlite!.exec(sql);
  const existing = new Set(
    sqlite!.prepare("PRAGMA table_info(product_feedback)").all().map((column) => (column as { name: string }).name)
  );
  for (const [name, type] of columns) {
    if (!existing.has(name)) sqlite!.exec(`ALTER TABLE product_feedback ADD COLUMN ${name} ${type}`);
  }
  sqlite!.exec(`
    UPDATE product_feedback SET source = 'agentcontract-cli' WHERE source IS NULL;
    UPDATE product_feedback SET category = 'general' WHERE category IS NULL;
    UPDATE product_feedback SET severity = 'normal' WHERE severity IS NULL;
    UPDATE product_feedback SET status = 'open' WHERE status IS NULL;
    UPDATE product_feedback SET created_at = datetime('now') WHERE created_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_product_feedback_created_at ON product_feedback(created_at);
    CREATE INDEX IF NOT EXISTS idx_product_feedback_status ON product_feedback(status);
    CREATE INDEX IF NOT EXISTS idx_product_feedback_owner_email ON product_feedback(owner_email);
    CREATE INDEX IF NOT EXISTS idx_product_feedback_reporter_email ON product_feedback(reporter_email);
  `);
}

async function ensureAgentSessionSchema() {
  const sessionSql = `CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    owner_email TEXT,
    agent TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL DEFAULT 'agentcontract-cli',
    initial_goal TEXT,
    privacy_mode TEXT NOT NULL DEFAULT 'full',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT,
    metadata_json TEXT
  )`;
  const eventsSql = `CREATE TABLE IF NOT EXISTS agent_session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor_role TEXT,
    content_text TEXT,
    content_json TEXT,
    created_at TEXT NOT NULL,
    metadata_json TEXT,
    UNIQUE(session_id, sequence_number)
  )`;

  if (pool) {
    await pool.query(sessionSql);
    await pool.query(eventsSql);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_email ON agent_sessions(owner_email)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at ON agent_sessions(started_at)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agent_session_events_session ON agent_session_events(session_id, sequence_number)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agent_session_events_type ON agent_session_events(event_type)");
    return;
  }

  sqlite!.exec(`
    ${sessionSql};
    ${eventsSql};
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_email ON agent_sessions(owner_email);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at ON agent_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_agent_session_events_session ON agent_session_events(session_id, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_agent_session_events_type ON agent_session_events(event_type);
  `);
}

async function applyMigrationFile(filename: string) {
  const migrationPath = join(process.cwd(), "migrations", filename);
  if (!existsSync(migrationPath)) {
    throw new Error(`Missing migration file: ${migrationPath}`);
  }
  let sql = readFileSync(migrationPath, "utf8");
  if (usePostgres) {
    sql = sql
      .replaceAll("CREATE TABLE agreements", "CREATE TABLE IF NOT EXISTS agreements")
      .replaceAll("CREATE TABLE audit_events", "CREATE TABLE IF NOT EXISTS audit_events")
      .replaceAll("CREATE TABLE webhook_deliveries", "CREATE TABLE IF NOT EXISTS webhook_deliveries")
      .replaceAll("CREATE TABLE api_keys", "CREATE TABLE IF NOT EXISTS api_keys")
      .replaceAll("CREATE TABLE cli_login_codes", "CREATE TABLE IF NOT EXISTS cli_login_codes")
      .replaceAll("CREATE TABLE product_feedback", "CREATE TABLE IF NOT EXISTS product_feedback")
      .replace(/CREATE INDEX (?!IF NOT EXISTS)/g, "CREATE INDEX IF NOT EXISTS ");
    await pool!.query(sql);
  } else {
    sqlite!.exec(sql);
  }
}

function toPg(sql: string) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
