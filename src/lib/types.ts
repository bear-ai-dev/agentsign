export type AgreementStatus = "sent" | "viewed" | "completed" | "declined" | "expired" | "cancelled";

export type FieldType = "text" | "email" | "date" | "currency" | "number" | "select" | "boolean" | "signature" | "initials";
export type SignerRole = "recipient" | "sender";

export type FieldDefinition = {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
};

export type Agreement = {
  id: string;
  status: AgreementStatus;
  recipient_name: string;
  recipient_email: string;
  owner_email: string | null;
  api_key_id: string | null;
  sender_profile_id: string | null;
  signing_base_url: string | null;
  batch_id: string | null;
  document_markdown: string;
  document_title: string;
  original_pdf_base64: string | null;
  original_pdf_filename: string | null;
  original_pdf_sha256: string | null;
  original_pdf_bytes: number | null;
  fields_json: string;
  signed_fields_json: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  metadata_json: string | null;
  signing_token: string;
  created_at: string;
  sent_at: string | null;
  viewed_at: string | null;
  completed_at: string | null;
  signed_pdf_path: string | null;
  signed_pdf_base64: string | null;
  signed_pdf_sha256: string | null;
  signed_pdf_bytes: number | null;
};

export type AuditEvent = {
  id: string;
  agreement_id: string;
  event_type: string;
  ip_address: string | null;
  user_agent: string | null;
  data_json: string | null;
  created_at: string;
};

export type SignedFields = Record<string, unknown>;

export type ApiKeyRecord = {
  id: string;
  key_hash: string;
  key_prefix: string;
  last4: string;
  name: string;
  owner_id: string | null;
  owner_email: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type DomainStatus = "pending" | "verified" | "failed" | "pending_operator_action";

export type DnsRecord = {
  type: string;
  name: string;
  value: string;
  status?: string;
  priority?: number | null;
};

export type SenderProfile = {
  id: string;
  owner_email: string;
  email_domain: string;
  signing_domain: string;
  default_from_email: string;
  default_from_name: string | null;
  resend_domain_id: string | null;
  email_domain_status: DomainStatus;
  signing_domain_status: DomainStatus;
  email_dns_records_json: string | null;
  signing_dns_records_json: string | null;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
};

export type AgreementBatch = {
  id: string;
  owner_email: string | null;
  api_key_id: string | null;
  sender_profile_id: string | null;
  status: "processing" | "completed" | "partial_failed" | "failed";
  total_count: number;
  sent_count: number;
  failed_count: number;
  metadata_json: string | null;
  created_at: string;
  completed_at: string | null;
};

export type AgreementBatchItem = {
  id: string;
  batch_id: string;
  agreement_id: string | null;
  recipient_name: string;
  recipient_email: string;
  status: "sent" | "failed";
  error: string | null;
  created_at: string;
};

export type CliLoginCode = {
  id: string;
  code_hash: string;
  key_name: string;
  owner_id: string | null;
  owner_email: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

export type ProductFeedback = {
  id: string;
  owner_email: string | null;
  reporter_email: string | null;
  reporter_name: string | null;
  source: string;
  category: string;
  severity: string;
  command: string | null;
  message: string;
  expected: string | null;
  actual: string | null;
  context_json: string | null;
  status: "open" | "triaged" | "closed";
  created_at: string;
};
