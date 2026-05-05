import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldDefinition } from "./types.js";

const templateNames = new Set(["nda", "privacy", "contractor", "mutual-nda", "one-way-nda", "privacy-policy"]);
const moduleDir = dirname(fileURLToPath(import.meta.url));

export type TemplateVariable = {
  key: string;
  label: string;
  defaultValue: string;
  required?: boolean;
};

export type TemplateDefinition = {
  id: string;
  name: string;
  description: string;
  variables: TemplateVariable[];
  fields: FieldDefinition[];
};

export const privacyTemplateDefinition: TemplateDefinition = {
  id: "privacy",
  name: "Specific Marketplace Privacy Policy Acknowledgement",
  description: "Specific contributor privacy policy acknowledgement reconstructed from the PDF, with typed signature, acknowledgement date, audit trail, and sender notification support.",
  variables: [
    { key: "effective_date", label: "Policy effective date", defaultValue: "April 29, 2026", required: true }
  ],
  fields: [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "acknowledgement_date", label: "Acknowledgement date", type: "date", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ]
};

export const contractorTemplateDefinition: TemplateDefinition = {
  id: "contractor",
  name: "Specific Marketplace Contributor Terms of Use",
  description: "Specific contributor/contractor marketplace terms reconstructed from the Bear AI Contractor PDF, with independent-contractor language, typed signature, acknowledgement date, audit trail, and sender notification support.",
  variables: [
    { key: "company_name", label: "Company name", defaultValue: "Specific Marketplace", required: true },
    { key: "service_name", label: "Service name", defaultValue: "Specific", required: true },
    { key: "website_url", label: "Website", defaultValue: "usespecific.com", required: true },
    { key: "contact_email", label: "Contact email", defaultValue: "sid@usebear.ai", required: true },
    { key: "company_address", label: "Company address", defaultValue: "39 Tehama, San Francisco, CA", required: true },
    { key: "effective_date", label: "Effective date", defaultValue: "April 29, 2026", required: true }
  ],
  fields: [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "acknowledgement_date", label: "Acknowledgement date", type: "date", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ]
};

export const ndaTemplateDefinition: TemplateDefinition = {
  id: "nda",
  name: "Bear AI Mutual NDA",
  description: "Bear AI mutual non-disclosure agreement for contractor and partner onboarding.",
  variables: [
    { key: "company_name", label: "Company name", defaultValue: "Bear AI", required: true },
    { key: "effective_date", label: "Effective date", defaultValue: new Date().toISOString().slice(0, 10), required: true },
    { key: "term_years", label: "Term years", defaultValue: "2", required: true }
  ],
  fields: [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ]
};

export const mutualNdaTemplateDefinition: TemplateDefinition = {
  id: "mutual-nda",
  name: "Standard Mutual NDA",
  description: "Balanced two-way confidentiality agreement for partnerships, vendor evaluations, diligence, and collaborations where both parties may disclose confidential information.",
  variables: [
    { key: "party_a_name", label: "First party name", defaultValue: "Acme, Inc.", required: true },
    { key: "party_a_address", label: "First party address", defaultValue: "123 Market Street, San Francisco, CA 94105", required: true },
    { key: "party_b_name", label: "Second party name", defaultValue: "Recipient Company, LLC", required: true },
    { key: "party_b_address", label: "Second party address", defaultValue: "456 Main Street, New York, NY 10001", required: true },
    { key: "effective_date", label: "Effective date", defaultValue: new Date().toISOString().slice(0, 10), required: true },
    { key: "purpose", label: "Permitted purpose", defaultValue: "evaluating a potential business relationship between the parties", required: true },
    { key: "term_years", label: "Confidentiality term years", defaultValue: "3", required: true },
    { key: "governing_law", label: "Governing law", defaultValue: "Delaware", required: true },
    { key: "court_venue", label: "Court venue", defaultValue: "state and federal courts located in Delaware", required: true }
  ],
  fields: [
    { id: "full_name", label: "Signer full legal name", type: "text", required: true },
    { id: "title", label: "Signer title", type: "text", required: true },
    { id: "signature_date", label: "Signature date", type: "date", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ]
};

export const oneWayNdaTemplateDefinition: TemplateDefinition = {
  id: "one-way-nda",
  name: "Standard One-Way NDA",
  description: "Unilateral confidentiality agreement for sales demos, invention reviews, contractor interviews, diligence, and other situations where one party mainly discloses sensitive information.",
  variables: [
    { key: "disclosing_party_name", label: "Disclosing party name", defaultValue: "Acme, Inc.", required: true },
    { key: "disclosing_party_address", label: "Disclosing party address", defaultValue: "123 Market Street, San Francisco, CA 94105", required: true },
    { key: "receiving_party_name", label: "Receiving party name", defaultValue: "Recipient Company, LLC", required: true },
    { key: "receiving_party_address", label: "Receiving party address", defaultValue: "456 Main Street, New York, NY 10001", required: true },
    { key: "effective_date", label: "Effective date", defaultValue: new Date().toISOString().slice(0, 10), required: true },
    { key: "purpose", label: "Permitted purpose", defaultValue: "evaluating a potential business relationship with the Disclosing Party", required: true },
    { key: "term_years", label: "Confidentiality term years", defaultValue: "3", required: true },
    { key: "governing_law", label: "Governing law", defaultValue: "Delaware", required: true },
    { key: "court_venue", label: "Court venue", defaultValue: "state and federal courts located in Delaware", required: true }
  ],
  fields: [
    { id: "full_name", label: "Signer full legal name", type: "text", required: true },
    { id: "title", label: "Signer title", type: "text", required: true },
    { id: "signature_date", label: "Signature date", type: "date", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ]
};

export const privacyPolicyTemplateDefinition: TemplateDefinition = {
  id: "privacy-policy",
  name: "Standard Website/App Privacy Policy",
  description: "Plain-language privacy policy acknowledgement for websites, apps, SaaS tools, and marketplaces that need to explain collection, use, sharing, retention, rights, and contact paths.",
  variables: [
    { key: "company_name", label: "Company name", defaultValue: "Acme, Inc.", required: true },
    { key: "service_name", label: "Service name", defaultValue: "Acme", required: true },
    { key: "website_url", label: "Website or app URL", defaultValue: "https://example.com", required: true },
    { key: "contact_email", label: "Privacy contact email", defaultValue: "privacy@example.com", required: true },
    { key: "company_address", label: "Company address", defaultValue: "123 Market Street, San Francisco, CA 94105", required: true },
    { key: "effective_date", label: "Effective date", defaultValue: new Date().toISOString().slice(0, 10), required: true },
    { key: "personal_data_categories", label: "Personal data categories", defaultValue: "account details, contact information, usage data, device data, support messages, and payment-related records", required: true },
    { key: "processing_purposes", label: "Use purposes", defaultValue: "provide and secure the service, process transactions, communicate with users, improve product quality, prevent fraud, comply with law, and market relevant features", required: true },
    { key: "sharing_categories", label: "Sharing categories", defaultValue: "hosting providers, analytics providers, payment processors, customer support tools, security vendors, professional advisors, and authorities when required by law", required: true },
    { key: "retention_period", label: "Retention period", defaultValue: "for as long as needed to provide the service, comply with legal obligations, resolve disputes, and enforce agreements", required: true }
  ],
  fields: [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "acknowledgement_date", label: "Acknowledgement date", type: "date", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ]
};

export const templateDefinitions = {
  privacy: privacyTemplateDefinition,
  contractor: contractorTemplateDefinition,
  nda: ndaTemplateDefinition,
  "mutual-nda": mutualNdaTemplateDefinition,
  "one-way-nda": oneWayNdaTemplateDefinition,
  "privacy-policy": privacyPolicyTemplateDefinition
};

export function loadTemplate(name: string): string {
  if (!templateNames.has(name)) {
    throw new Error(`Unknown template: ${name}`);
  }

  const filename = `${name}.md`;
  const candidates = [
    join(moduleDir, "..", "templates", filename),
    join(process.cwd(), "src", "templates", filename),
    join(process.cwd(), "dist", "src", "templates", filename)
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`Template ${filename} was not found. Rebuild the package or reinstall AgentContract.`);
  }

  return readFileSync(path, "utf8");
}

export function defaultTemplateVars(definition: TemplateDefinition) {
  return Object.fromEntries(definition.variables.map((variable) => [variable.key, variable.defaultValue]));
}

export function applyTemplateVars(markdown: string, vars: Record<string, unknown> = {}) {
  return markdown.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function titleFromMarkdown(markdown: string) {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || "Agreement";
}
