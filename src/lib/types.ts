export type AgreementStatus = "sent" | "viewed" | "completed" | "declined" | "expired" | "cancelled";

export type FieldType = "text" | "email" | "date" | "currency" | "number" | "select" | "boolean" | "signature" | "initials";

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
  document_markdown: string;
  document_title: string;
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
