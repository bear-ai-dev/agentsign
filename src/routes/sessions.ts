import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { requireApiKey } from "../lib/auth.js";
import { all, get, nowIso, parseJson, run } from "../lib/db.js";
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

  await run(
    `INSERT INTO agent_sessions (
      id, owner_email, agent, source, initial_goal, privacy_mode, started_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ownerEmail,
    cleanString(body.agent, 80) ?? "unknown",
    cleanString(body.source, 80) ?? "agentcontract-cli",
    cleanString(body.initial_goal ?? body.goal, 4_000),
    cleanString(body.privacy_mode, 40) ?? "full",
    startedAt,
    Object.keys(metadata).length ? JSON.stringify(metadata) : null
  );

  const session = await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", id);
  return c.json({ session: publicSession(session!), started: true }, 201);
});

sessions.get("/v1/sessions", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const rows = await all<AgentSession>(
    "SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?",
    limit
  );
  return c.json({ sessions: rows.map(publicSession) });
});

sessions.get("/v1/sessions/:id", async (c) => {
  const session = await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  const events = await all<AgentSessionEvent>(
    "SELECT * FROM agent_session_events WHERE session_id = ? ORDER BY sequence_number ASC",
    session.id
  );
  return c.json({ session: publicSession(session), events: events.map(publicEvent) });
});

sessions.post("/v1/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  const session = await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", sessionId);
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
  return c.json({ event: publicEvent(event!), stored: true }, 201);
});

sessions.post("/v1/sessions/:id/end", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ outcome?: string }>().catch(() => ({})) as { outcome?: string };
  const session = await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  await run(
    "UPDATE agent_sessions SET ended_at = ?, outcome = ? WHERE id = ?",
    nowIso(),
    cleanString(body.outcome, 2_000),
    sessionId
  );
  const updated = await get<AgentSession>("SELECT * FROM agent_sessions WHERE id = ?", sessionId);
  return c.json({ session: publicSession(updated!), ended: true });
});
