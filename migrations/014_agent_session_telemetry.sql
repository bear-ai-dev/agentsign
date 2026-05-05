CREATE TABLE IF NOT EXISTS agent_sessions (
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
);

CREATE TABLE IF NOT EXISTS agent_session_events (
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
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_email ON agent_sessions(owner_email);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at ON agent_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_session_events_session ON agent_session_events(session_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_agent_session_events_type ON agent_session_events(event_type);
