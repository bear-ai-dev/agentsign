import { createHash, randomBytes } from "node:crypto";
import type { Agreement, FieldDefinition, SignerRole } from "./types.js";

export type EmbeddedOptions = {
  signing_mode?: "hosted" | "embedded";
  allowed_parent_origins?: string[];
  prefill_fields?: Record<string, unknown>;
  idempotency_key?: string;
};
export type SigningSession = {
  token_hash: string;
  agreement_id: string;
  signer_role: SignerRole;
  parent_origin: string;
  return_url: string;
  expires_at: string;
  created_at: string;
};
export class ProviderRequestError extends Error {
  constructor(message: string, public status: 400 | 403 | 409 = 400) { super(message); }
}
export const isEmbedded = (agreement: Agreement) => agreement.signing_mode === "embedded";
export const hashSigningToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newSigningToken = () => randomBytes(32).toString("base64url");
export const inactiveAgreement = (agreement: Agreement) => !["sent", "viewed", "completed"].includes(agreement.status);

export function exactOrigin(value: unknown) {
  if (typeof value !== "string") throw new ProviderRequestError("An exact parent origin is required");
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderRequestError("Invalid parent origin"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || url.username || url.password || url.hostname.includes("*") || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new ProviderRequestError("Parent origins must be exact HTTPS origins or local HTTP origins");
  return url.origin;
}

export function validatedEmbeddedOptions(body: EmbeddedOptions, fields: FieldDefinition[]) {
  const mode = body.signing_mode ?? "hosted";
  if (mode !== "hosted" && mode !== "embedded") throw new ProviderRequestError("signing_mode must be hosted or embedded");
  const rawOrigins = body.allowed_parent_origins ?? [];
  if (!Array.isArray(rawOrigins) || rawOrigins.length > 20) throw new ProviderRequestError("allowed_parent_origins must be an array with at most 20 exact origins");
  const origins = [...new Set(rawOrigins.map(exactOrigin))];
  if (mode === "embedded" && !origins.length) throw new ProviderRequestError("Embedded signing requires allowed_parent_origins");
  if (mode === "embedded") {
    const roles = new Set(fields.map((field) => field.signerRole ?? "recipient"));
    roles.add("recipient");
    for (const role of roles) if (!fields.some((field) => (field.signerRole ?? "recipient") === role && field.type === "signature" && field.required === true)) throw new ProviderRequestError(`Embedded ${role} fields require a required signature`);
  }
  const prefill = body.prefill_fields ?? {};
  if (!prefill || typeof prefill !== "object" || Array.isArray(prefill)) throw new ProviderRequestError("prefill_fields must be an object");
  for (const [id, value] of Object.entries(prefill)) {
    const field = fields.find((item) => item.id === id);
    if (!field || field.signerRole === "sender" || ["signature", "initials", "boolean"].includes(field.type) || !["string", "number"].includes(typeof value)) throw new ProviderRequestError(`prefill_fields may only contain recipient non-assent fields: ${id}`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new ProviderRequestError(`Invalid prefill value: ${id}`);
    if (field.type === "select" && !field.options?.includes(String(value))) throw new ProviderRequestError(`Invalid prefill option: ${id}`);
  }
  validateIdempotencyKey(body.idempotency_key);
  return { mode, origins, prefill };
}

export function validateIdempotencyKey(key: unknown) {
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(key))) throw new ProviderRequestError("idempotency_key must contain 1 to 200 safe characters");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const creationHash = (body: unknown) => hashSigningToken(canonicalJson(body));

export function validateSessionRequest(agreement: Agreement, body: { parent_origin?: unknown; return_url?: unknown; signer_role?: unknown }) {
  const parentOrigin = exactOrigin(body.parent_origin);
  const origins = JSON.parse(agreement.allowed_parent_origins_json ?? "[]") as string[];
  if (!origins.includes(parentOrigin)) throw new ProviderRequestError("parent_origin is not allowlisted");
  let returnUrl: URL;
  try { returnUrl = new URL(String(body.return_url)); } catch { throw new ProviderRequestError("A valid return_url is required"); }
  if (returnUrl.origin !== parentOrigin || returnUrl.username || returnUrl.password) throw new ProviderRequestError("return_url must belong to parent_origin without credentials");
  const role = body.signer_role ?? "recipient";
  if (role !== "recipient" && role !== "sender") throw new ProviderRequestError("signer_role must be recipient or sender");
  const fields = JSON.parse(agreement.fields_json) as FieldDefinition[];
  if (!fields.some((field) => (field.signerRole ?? "recipient") === role)) throw new ProviderRequestError("Agreement has no fields for this signer role");
  return { parentOrigin, returnUrl: returnUrl.href, role };
}

export function completionScript(agreementId: string, session: SigningSession) {
  const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `window.parent.postMessage(${json({ type: "agentcontract:completed", agreement_id: agreementId })}, ${json(session.parent_origin)});`;
}
