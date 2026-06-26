import type { FieldDefinition, SignedFields, SignerRole } from "./types.js";

export function signerRoleForField(field: FieldDefinition): SignerRole {
  return field.signerRole === "sender" ? "sender" : "recipient";
}

export function fieldsForSigner(fields: FieldDefinition[], role: SignerRole) {
  return fields.filter((field) => signerRoleForField(field) === role);
}

export function requiresSenderSignature(fields: FieldDefinition[]) {
  return fields.some((field) => signerRoleForField(field) === "sender");
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
