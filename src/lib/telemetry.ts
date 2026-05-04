import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { get, nowIso, run } from "./db.js";

export type AgreementContextInput = {
  agreementId: string;
  sessionId?: string | null;
  cliRunId?: string | null;
  source?: string | null;
  reasonSent?: string | null;
  approvalMessage?: string | null;
  chatSummary?: string | null;
  transcriptText?: string | null;
  transcriptJson?: unknown;
  metadata?: unknown;
};

export type CliRunInput = {
  id?: string;
  sessionId?: string | null;
  agreementId?: string | null;
  ownerEmail?: string | null;
  apiKeyId?: string | null;
  command: string;
  argv?: unknown;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  exitCode?: number | null;
  success?: boolean | number | null;
  errorName?: string | null;
  errorMessage?: string | null;
  errorFingerprint?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  cliVersion?: string | null;
  packageName?: string | null;
  nodeVersion?: string | null;
  platform?: string | null;
  arch?: string | null;
  cwdHash?: string | null;
  agreementIds?: unknown;
  prompt?: string | null;
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

function cleanMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["prompt", "agent", "config_loaded", "json_output", "dry_run"]) {
    if (input[key] !== undefined && input[key] !== null) output[key] = input[key];
  }
  return Object.keys(output).length ? output : null;
}

export function errorFingerprint(message: string | null | undefined) {
  const text = cleanString(message, 2_000);
  if (!text) return null;
  return createHash("sha256").update(text.replace(/\s+/g, " ").toLowerCase()).digest("hex").slice(0, 24);
}

export async function saveAgreementContext(input: AgreementContextInput) {
  const metadataObject = cleanMetadata(input.metadata);
  const metadata = metadataObject === null ? null : jsonText(metadataObject);
  const meaningful = [
    input.reasonSent,
    input.approvalMessage,
    input.chatSummary,
    metadata
  ].some((value) => cleanString(typeof value === "string" ? value : value ? String(value) : null));
  if (!meaningful) return null;

  const id = `ctx_${nanoid(14)}`;
  const createdAt = nowIso();
  await run(
    `INSERT INTO agreement_contexts (
      id, agreement_id, session_id, cli_run_id, source, reason_sent, approval_message,
      chat_summary, transcript_text, transcript_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.agreementId,
    cleanString(input.sessionId, 120),
    cleanString(input.cliRunId, 120),
    cleanString(input.source, 80) ?? "agentcontract-cli",
    cleanString(input.reasonSent),
    cleanString(input.approvalMessage),
    cleanString(input.chatSummary),
    null,
    null,
    metadata,
    createdAt
  );
  return { id, created_at: createdAt };
}

export async function saveCliRun(input: CliRunInput) {
  const id = cleanString(input.id, 120) ?? `run_${nanoid(14)}`;
  const existing = await get<{ id: string }>("SELECT id FROM cli_runs WHERE id = ?", id);
  const now = nowIso();
  const success = input.success === true || input.success === 1 ? 1 : 0;
  const errorMessage = cleanString(input.errorMessage);
  const fingerprint = cleanString(input.errorFingerprint, 120) ?? errorFingerprint(errorMessage);
  const metadata = cleanMetadata({
    ...(cleanMetadata(input.metadata) ?? {}),
    ...(cleanString(input.prompt) ? { prompt: cleanString(input.prompt) } : {})
  });

  const params = [
    cleanString(input.sessionId, 120),
    cleanString(input.agreementId, 120),
    cleanString(input.ownerEmail, 320),
    cleanString(input.apiKeyId, 120),
    cleanString(input.command, 4_000) ?? "agentcontract",
    jsonText(input.argv),
    cleanString(input.startedAt, 80) ?? now,
    cleanString(input.endedAt, 80),
    Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
    Number.isFinite(Number(input.exitCode)) ? Number(input.exitCode) : null,
    success,
    cleanString(input.errorName, 200),
    errorMessage,
    fingerprint,
    cleanString(input.stdoutExcerpt, 20_000),
    cleanString(input.stderrExcerpt, 20_000),
    cleanString(input.cliVersion, 80),
    cleanString(input.packageName, 200),
    cleanString(input.nodeVersion, 80),
    cleanString(input.platform, 80),
    cleanString(input.arch, 80),
    cleanString(input.cwdHash, 120),
    jsonText(input.agreementIds),
    jsonText(metadata)
  ];

  if (existing) {
    await run(
      `UPDATE cli_runs SET
        session_id = ?, agreement_id = ?, owner_email = ?, api_key_id = ?, command = ?, argv_json = ?,
        started_at = ?, ended_at = ?, duration_ms = ?, exit_code = ?, success = ?, error_name = ?,
        error_message = ?, error_fingerprint = ?, stdout_excerpt = ?, stderr_excerpt = ?, cli_version = ?,
        package_name = ?, node_version = ?, platform = ?, arch = ?, cwd_hash = ?, agreement_ids_json = ?,
        metadata_json = ?
       WHERE id = ?`,
      ...params,
      id
    );
  } else {
    await run(
      `INSERT INTO cli_runs (
        session_id, agreement_id, owner_email, api_key_id, command, argv_json, started_at,
        ended_at, duration_ms, exit_code, success, error_name, error_message, error_fingerprint,
        stdout_excerpt, stderr_excerpt, cli_version, package_name, node_version, platform, arch,
        cwd_hash, agreement_ids_json, metadata_json, created_at, id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...params,
      now,
      id
    );
  }

  return { id, stored: true };
}
