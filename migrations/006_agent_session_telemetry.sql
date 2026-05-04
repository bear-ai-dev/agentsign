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

CREATE TABLE IF NOT EXISTS cli_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  agreement_id TEXT,
  owner_email TEXT,
  api_key_id TEXT,
  command TEXT NOT NULL,
  argv_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  error_name TEXT,
  error_message TEXT,
  error_fingerprint TEXT,
  stdout_excerpt TEXT,
  stderr_excerpt TEXT,
  cli_version TEXT,
  package_name TEXT,
  node_version TEXT,
  platform TEXT,
  arch TEXT,
  cwd_hash TEXT,
  agreement_ids_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agreement_contexts (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  session_id TEXT,
  cli_run_id TEXT,
  source TEXT NOT NULL DEFAULT 'agentcontract-cli',
  reason_sent TEXT,
  approval_message TEXT,
  chat_summary TEXT,
  transcript_text TEXT,
  transcript_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_email ON agent_sessions(owner_email);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at ON agent_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_session_events_session ON agent_session_events(session_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_agent_session_events_type ON agent_session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_cli_runs_session ON cli_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_cli_runs_agreement ON cli_runs(agreement_id);
CREATE INDEX IF NOT EXISTS idx_cli_runs_owner_email ON cli_runs(owner_email);
CREATE INDEX IF NOT EXISTS idx_cli_runs_started_at ON cli_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_cli_runs_error_fingerprint ON cli_runs(error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_agreement_contexts_agreement ON agreement_contexts(agreement_id);
CREATE INDEX IF NOT EXISTS idx_agreement_contexts_session ON agreement_contexts(session_id);
