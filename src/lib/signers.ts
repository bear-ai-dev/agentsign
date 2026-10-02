import type { Agreement, FieldDefinition, SignedFields, SignerRole } from "./types.js";

export function signerRoleForField(field: FieldDefinition): SignerRole {
  return field.signerRole === "sender" ? "sender" : "recipient";
}

export function fieldsForSigner(fields: FieldDefinition[], role: SignerRole) {
  return fields.filter((field) => signerRoleForField(field) === role);
}

export function requiresSenderSignature(fields: FieldDefinition[]) {
  return fields.some((field) => signerRoleForField(field) === "sender");
}

const recipientNameFields = new Set([
  "name", "full_name", "legal_name", "printed_name", "recipient_name", "recipient_full_name",
  "signer_name", "signer_full_name", "seller_printed_name"
]);
const recipientEmailFields = new Set([
  "email", "email_address", "account_email", "associated_email", "recipient_email", "signer_email", "seller_email"
]);

export function recipientPrefillForField(
  field: FieldDefinition,
  recipient: Pick<Agreement, "recipient_name" | "recipient_email">,
  explicitPrefills: Record<string, unknown>
) {
  if (signerRoleForField(field) !== "recipient" || ["signature", "initials", "boolean"].includes(field.type)) return undefined;
  if (Object.hasOwn(explicitPrefills, field.id)) return explicitPrefills[field.id];

  const id = field.id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replaceAll("-", "_");
  if (field.type === "text" && recipientNameFields.has(id)) return recipient.recipient_name;
  if ((field.type === "email" || field.type === "text") && recipientEmailFields.has(id)) return recipient.recipient_email;
  return undefined;
}

function signaturePresent(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.signed && (record.typed_name || record.data_url));
}

export function signedValuePresent(field: FieldDefinition, value: unknown) {
  if (field.type === "signature" || field.type === "initials") return signaturePresent(value);
  return value !== undefined && value !== null && value !== "" && value !== false;
}

export function requiredFieldsComplete(fields: FieldDefinition[], signedFields: SignedFields) {
  return fields.every((field) => !field.required || signedValuePresent(field, signedFields[field.id]));
}
