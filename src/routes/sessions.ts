import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { requireApiKey } from "../lib/auth.js";
import { all, get, nowIso, parseJson, run } from "../lib/db.js";
import { ownerDistinctId, posthog, setPosthogDistinctId } from "../lib/posthog.js";
import type { AgentSession, AgentSessionEvent, ApiKeyRecord } from "../lib/types.js";

export const sessions = new Hono();
sessions.use("/v1/*", requireApiKey);

type SessionBody = {
  agent?: string;
  goal?: string;
  initial_goal?: string;
  source?: string;
  privacy_mode?: string;
  metadata?: Record<string, unknown>;
};

type EventBody = {
  event_type?: string;
  actor_role?: string;
  content_text?: string;
  content?: string;
  content_json?: unknown;
  metadata?: Record<string, unknown>;
};

function cleanString(value: unknown, maxLength = 2_000) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function cleanObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function isBootstrapKey(c: Context) {
  return Boolean((c as unknown as { get(key: string): unknown }).get("apiKeyBootstrap"));
}

function currentOwnerEmail(c: Context) {
  return apiKeyRecord(c)?.owner_email ?? null;
}

function requireOwnedKey(c: Context) {
  if (isBootstrapKey(c)) return { bootstrap: true, ownerEmail: null };
  const ownerEmail = currentOwnerEmail(c);
  if (!ownerEmail) return null;
  return { bootstrap: false, ownerEmail };
}

function publicSession(row: AgentSession) {
  return {
    id: row.id,
    owner_email: row.owner_email,
    agent: row.agent,
    source: row.source,
    initial_goal: row.initial_goal,
    privacy_mode: row.privacy_mode,
    started_at: row.started_at,
    ended_at: row.ended_at,
    outcome: row.outcome,
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null)
  };
}

function publicEvent(row: AgentSessionEvent) {
  return {
    id: row.id,
    session_id: row.session_id,
    sequence_number: row.sequence_number,
    event_type: row.event_type,
    actor_role: row.actor_role,
    content_text: row.content_text,
    content_json: parseJson<unknown | null>(row.content_json, null),
    created_at: row.created_at,
    metadata: parseJson<Record<string, unknown> | null>(row.metadata_json, null)
  };
}

sessions.post("/v1/sessions", async (c) => {
  const body = await c.req.json<SessionBody>().catch(() => ({})) as SessionBody;
  const id = `sess_${nanoid(12)}`;
  const startedAt = nowIso();
  const ownerEmail = apiKeyRecord(c)?.owner_email ?? null;
  const metadata = cleanObject(body.metadata);
  const agent = cleanString(body.agent, 80) ?? "unknown";
  const source = cleanString(body.source, 80) ?? "agentcontract-cli";
  const initialGoal = cleanString(body.initial_goal ?? body.goal, 4_000);
  const privacyMode = cleanString(body.privacy_mode, 40) ?? "full";
  const distinctId = ownerDistinctId(ownerEmail, id);

  await run(
    `INSERT INTO agent_sessions (
      id, owner_email, agent, source, initial_goal, privacy_mode, started_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ownerEmail,
    agent,
    source,
    initialGoal,
    privacyMode,
    startedAt,
    Object.keys(metadata).length ? JSON.stringify(metadata) : null
  );

  const session = await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", id);
  setPosthogDistinctId(c, distinctId);
  posthog.captureEvent("agent session started", {
    session_id: id,
    agent,
    source,
    privacy_mode: privacyMode,
    has_initial_goal: Boolean(initialGoal),
    metadata_keys: Object.keys(metadata)
  }, distinctId);
  return c.json({ session: publicSession(session!), started: true }, 201);
});

sessions.get("/v1/sessions", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const scope = requireOwnedKey(c);
  if (!scope) return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  const rows = scope.bootstrap
    ? await all<AgentSession>("SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?", limit)
    : await all<AgentSession>("SELECT * FROM agent_sessions WHERE owner_email = ? ORDER BY started_at DESC LIMIT ?", scope.ownerEmail, limit);
  return c.json({ sessions: rows.map(publicSession) });
});

sessions.get("/v1/sessions/:id", async (c) => {
  const scope = requireOwnedKey(c);
  if (!scope) return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  const session = scope.bootstrap
    ? await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", c.req.param("id"))
    : await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ? AND owner_email = ?", c.req.param("id"), scope.ownerEmail);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const events = await all<AgentSessionEvent>(
    "SELECT * FROM agent_session_events WHERE session_id = ? ORDER BY sequence_number ASC",
    session.id
  );
  return c.json({ session: publicSession(session), events: events.map(publicEvent) });
});

sessions.post("/v1/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  const scope = requireOwnedKey(c);
  if (!scope) return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  const session = scope.bootstrap
    ? await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", sessionId)
    : await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ? AND owner_email = ?", sessionId, scope.ownerEmail);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const body = await c.req.json<EventBody>().catch(() => ({})) as EventBody;
  const current = await get<{ max_sequence: number | null }>(
    "SELECT MAX(sequence_number) AS max_sequence FROM agent_session_events WHERE session_id = ?",
    sessionId
  );
  const sequenceNumber = Number(current?.max_sequence ?? 0) + 1;
  const id = `sevt_${nanoid(12)}`;
  const metadata = cleanObject(body.metadata);
  const eventType = cleanString(body.event_type, 80) ?? "note";
  const contentText = cleanString(body.content_text ?? body.content, 10_000);
  const contentJson = body.content_json === undefined ? null : JSON.stringify(body.content_json);
  const distinctId = ownerDistinctId(session.owner_email, session.id);

  await run(
    `INSERT INTO agent_session_events (
      id, session_id, sequence_number, event_type, actor_role, content_text, content_json, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    sessionId,
    sequenceNumber,
    eventType,
    cleanString(body.actor_role, 80),
    contentText,
    contentJson,
    nowIso(),
    Object.keys(metadata).length ? JSON.stringify(metadata) : null
  );

  const event = await get<AgentSessionEvent>("SELECT * FROM agent_session_events WHERE id = ?", id);
  setPosthogDistinctId(c, distinctId);
  posthog.captureEvent("agent session event recorded", {
    session_id: sessionId,
    event_id: id,
    event_type: eventType,
    actor_role: cleanString(body.actor_role, 80),
    sequence_number: sequenceNumber,
    has_content_text: Boolean(contentText),
    has_content_json: body.content_json !== undefined,
    metadata_keys: Object.keys(metadata)
  }, distinctId);
  return c.json({ event: publicEvent(event!), stored: true }, 201);
});

sessions.post("/v1/sessions/:id/end", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ outcome?: string }>().catch(() => ({})) as { outcome?: string };
  const scope = requireOwnedKey(c);
  if (!scope) return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  const session = scope.bootstrap
    ? await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", sessionId)
    : await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ? AND owner_email = ?", sessionId, scope.ownerEmail);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const distinctId = ownerDistinctId(session.owner_email, session.id);

  await run(
    "UPDATE agent_sessions SET ended_at = ?, outcome = ? WHERE id = ?",
    nowIso(),
    cleanString(body.outcome, 2_000),
    sessionId
  );
  const updated = await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", sessionId);
  setPosthogDistinctId(c, distinctId);
  posthog.captureEvent("agent session ended", {
    session_id: sessionId,
    agent: session.agent,
    source: session.source,
    had_outcome: Boolean(cleanString(body.outcome, 2_000))
  }, distinctId);
  return c.json({ session: publicSession(updated!), ended: true });
});
