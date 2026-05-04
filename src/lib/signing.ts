import type { FieldDefinition, SignedFields, SignerRole } from "./types.js";

const signerRoleLabels: Record<SignerRole, string> = {
  recipient: "Recipient",
  sender: "Sender"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function signerRoleLabel(role: SignerRole) {
  return signerRoleLabels[role];
}

export function isMultiPartySignedFields(value: SignedFields | null | undefined): value is SignedFields & { recipient?: SignedFields; sender?: SignedFields } {
  return isRecord(value) && (isRecord(value.recipient) || isRecord(value.sender));
}

export function signedFieldsForRole(signedFields: SignedFields | null | undefined, role: SignerRole) {
  if (!signedFields) return undefined;
  if (isMultiPartySignedFields(signedFields)) {
    const roleFields = signedFields[role];
    return isRecord(roleFields) ? roleFields as SignedFields : undefined;
  }
  return role === "recipient" ? signedFields : undefined;
}

export function mergeSignedFieldsForRole(input: {
  current: SignedFields | null | undefined;
  role: SignerRole;
  fields: SignedFields;
  multiParty: boolean;
}) {
  if (!input.multiParty && input.role === "recipient") return input.fields;

  const next: SignedFields = isMultiPartySignedFields(input.current)
    ? { ...input.current }
    : input.current
      ? { recipient: input.current }
      : {};
  next[input.role] = input.fields;
  return next;
}

function signatureValuePresent(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0;
  if (!isRecord(value)) return false;
  const typedName = value.typed_name;
  const dataUrl = value.data_url;
  return (typeof typedName === "string" && typedName.trim().length > 0)
    || (typeof dataUrl === "string" && dataUrl.startsWith("data:image/"));
}

function fieldValuePresent(field: FieldDefinition, value: unknown) {
  if (field.type === "signature" || field.type === "initials") return signatureValuePresent(value);
  return value !== undefined && value !== null && value !== "" && value !== false;
}

export function signerHasRequiredFields(input: {
  signedFields: SignedFields | null | undefined;
  role: SignerRole;
  fields: FieldDefinition[];
}) {
  const roleFields = signedFieldsForRole(input.signedFields, input.role);
  if (!roleFields) return false;
  return input.fields.every((field) => !field.required || fieldValuePresent(field, roleFields[field.id]));
}

export function signedPartyCount(input: {
  signedFields: SignedFields | null | undefined;
  fields: FieldDefinition[];
  senderRequired: boolean;
}) {
  const recipient = signerHasRequiredFields({ signedFields: input.signedFields, role: "recipient", fields: input.fields });
  const sender = input.senderRequired
    ? signerHasRequiredFields({ signedFields: input.signedFields, role: "sender", fields: input.fields })
    : false;
  return Number(recipient) + Number(sender);
}
