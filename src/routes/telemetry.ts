import { Hono, type Context } from "hono";
import { requireApiKey } from "../lib/auth.js";
import { nowIso } from "../lib/db.js";
import { saveAgreementContext, saveCliRun } from "../lib/telemetry.js";
import type { ApiKeyRecord } from "../lib/types.js";

export const telemetry = new Hono();
telemetry.use("/v1/*", requireApiKey);

type SessionBody = {
  id?: string;
  agent?: string;
  source?: string;
  initial_goal?: string;
  goal?: string;
  privacy_mode?: string;
  metadata?: unknown;
};

type SessionEventBody = {
  event_type?: string;
  type?: string;
  role?: string;
  actor_role?: string;
  content_text?: string;
  text?: string;
  message?: string;
  content_json?: unknown;
  content?: unknown;
  metadata?: unknown;
};

type SessionEndBody = {
  outcome?: string;
  metadata?: unknown;
};

type AgreementContextBody = {
  agreement_id?: string;
  session_id?: string;
  cli_run_id?: string;
  source?: string;
  reason_sent?: string;
  approval_message?: string;
  chat_summary?: string;
  transcript_text?: string;
  transcript_json?: unknown;
  metadata?: unknown;
};

function cleanString(value: unknown, maxLength = 100_000) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function jsonText(value: unknown) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function ownerEmail(c: Context) {
  return apiKeyRecord(c)?.owner_email ?? null;
}

function apiKeyId(c: Context) {
  return apiKeyRecord(c)?.id ?? null;
}

function metadataObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function promptFromBody(body: Record<string, unknown>) {
  const metadata = metadataObject(body.metadata);
  return cleanString(
    body.prompt
      ?? body.goal
      ?? body.initial_goal
      ?? body.chat_summary
      ?? metadata.prompt
      ?? metadata.goal
      ?? metadata.initial_goal
      ?? metadata.chat_summary,
    2_000
  );
}

telemetry.post("/v1/agent-sessions", async (c) => {
  const body = await c.req.json<SessionBody>().catch(() => ({})) as SessionBody;
  const id = cleanString(body.id, 120) ?? "sess_compat_noop";
  const createdAt = nowIso();

  return c.json({
    agent_session: {
      id,
      owner_email: ownerEmail(c),
      agent: cleanString(body.agent, 80) ?? "unknown",
      source: cleanString(body.source, 80) ?? "agentcontract-cli",
      initial_goal: cleanString(body.initial_goal ?? body.goal),
      privacy_mode: cleanString(body.privacy_mode, 40) ?? "full",
      started_at: createdAt,
      stored: false
    },
    stored: false
  }, 201);
});

telemetry.post("/v1/agent-sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  await c.req.json<SessionEventBody>().catch(() => ({}));

  return c.json({
    agent_session_event: {
      id: "evt_compat_noop",
      session_id: sessionId,
      sequence_number: 0,
      created_at: nowIso(),
      stored: false
    },
    stored: false
  }, 202);
});

telemetry.post("/v1/agent-sessions/:id/end", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<SessionEndBody>().catch(() => ({})) as SessionEndBody;
  const endedAt = nowIso();
  return c.json({ agent_session: { id: sessionId, ended_at: endedAt, outcome: cleanString(body.outcome, 2_000), stored: false }, stored: false }, 202);
});

telemetry.post("/v1/cli-runs", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({})) as Record<string, unknown>;
  const exitCode = Number(body.exit_code);
  const success = body.success === true || body.success === 1 || exitCode === 0;
  if (success) return c.json({ cli_run: null, stored: false }, 202);

  const metadata = metadataObject(body.metadata);
  const prompt = promptFromBody(body);
  const result = await saveCliRun({
    id: cleanString(body.id, 120) ?? undefined,
    agreementId: cleanString(body.agreement_id, 120),
    ownerEmail: ownerEmail(c),
    apiKeyId: apiKeyId(c),
    command: cleanString(body.command, 4_000) ?? "agentcontract",
    argv: body.argv,
    startedAt: cleanString(body.started_at, 80),
    endedAt: cleanString(body.ended_at, 80),
    durationMs: Number(body.duration_ms),
    exitCode,
    success: false,
    errorName: cleanString(body.error_name, 200),
    errorMessage: cleanString(body.error_message),
    errorFingerprint: cleanString(body.error_fingerprint, 120),
    cliVersion: cleanString(body.cli_version, 80),
    packageName: cleanString(body.package_name, 200),
    nodeVersion: cleanString(body.node_version, 80),
    platform: cleanString(body.platform, 80),
    arch: cleanString(body.arch, 80),
    cwdHash: cleanString(body.cwd_hash, 120),
    agreementIds: body.agreement_ids,
    prompt,
    metadata: {
      ...(prompt ? { prompt } : {}),
      ...(cleanString(metadata.agent, 80) ? { agent: cleanString(metadata.agent, 80) } : {}),
      ...(typeof metadata.config_loaded === "boolean" ? { config_loaded: metadata.config_loaded } : {}),
      ...(typeof metadata.json_output === "boolean" ? { json_output: metadata.json_output } : {}),
      ...(typeof metadata.dry_run === "boolean" ? { dry_run: metadata.dry_run } : {})
    }
  });
  return c.json({ cli_run: result }, 201);
});

telemetry.post("/v1/agreement-contexts", async (c) => {
  const body = await c.req.json<AgreementContextBody>().catch(() => ({})) as AgreementContextBody;
  const agreementId = cleanString(body.agreement_id, 120);
  if (!agreementId) return c.json({ error: "agreement_id is required" }, 400);
  const stored = await saveAgreementContext({
    agreementId,
    sessionId: cleanString(body.session_id, 120),
    cliRunId: cleanString(body.cli_run_id, 120),
    source: cleanString(body.source, 80),
    reasonSent: cleanString(body.reason_sent),
    approvalMessage: cleanString(body.approval_message),
    chatSummary: cleanString(body.chat_summary),
    metadata: body.metadata
  });
  return c.json({ agreement_context: stored, stored: Boolean(stored) }, 201);
});
