import { get, nowIso, run } from "./db.js";
import { creationHash, ProviderRequestError, validateIdempotencyKey } from "./embeddedSigning.js";

export function creationScope(ownerEmail?: string | null, authenticatedScope?: string) {
  if (ownerEmail) return `owner:${ownerEmail}`;
  if (authenticatedScope) return authenticatedScope;
  throw new ProviderRequestError("Authenticated creation scope is required", 403);
}

export function assertEmbeddedCreator(mode: string, ownerEmail: string | null | undefined, scope: string) {
  if (mode === "embedded" && !ownerEmail && scope !== "bootstrap") throw new ProviderRequestError("Embedded creation requires an owner-scoped key or bootstrap admin", 403);
}

export async function bindBulkRequest(scope: string, key: string | undefined, body: unknown) {
  validateIdempotencyKey(key);
  if (key === undefined) return scope;
  const hash = creationHash(body);
  await run("INSERT INTO agreement_bulk_requests (idempotency_scope, idempotency_key, creation_request_sha256, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", scope, key, hash, nowIso());
  const existing = await get<{ creation_request_sha256: string }>("SELECT creation_request_sha256 FROM agreement_bulk_requests WHERE idempotency_scope = ? AND idempotency_key = ?", scope, key);
  if (existing?.creation_request_sha256 !== hash) throw new ProviderRequestError("idempotency_key was already used with a different bulk request", 409);
  return `${scope}:bulk`;
}
