import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldDefinition } from "./types.js";

const templateNames = new Set(["nda", "privacy", "contractor"]);
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
  name: "Bear AI Contractor Agreement",
  description: "Bear AI 1099 contractor agreement with recipient-specific scope, rate, start date, and typed signature.",
  variables: [
    { key: "company_name", label: "Company name", defaultValue: "Bear AI", required: true },
    { key: "effective_date", label: "Effective date", defaultValue: new Date().toISOString().slice(0, 10), required: true },
    { key: "scope_of_work", label: "Scope of work", defaultValue: "Backend engineering", required: true },
    { key: "rate", label: "Hourly rate", defaultValue: "150", required: true },
    { key: "rate_unit", label: "Rate unit", defaultValue: "hour", required: true },
    { key: "invoice_frequency", label: "Invoice frequency", defaultValue: "biweekly", required: true },
    { key: "start_date", label: "Start date", defaultValue: new Date().toISOString().slice(0, 10), required: true },
    { key: "notice_days", label: "Notice days", defaultValue: "14", required: true }
  ],
  fields: [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "address", label: "Address", type: "text", required: true },
    { id: "tax_id", label: "SSN or EIN (last 4)", type: "text", required: true },
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

export const templateDefinitions = {
  privacy: privacyTemplateDefinition,
  contractor: contractorTemplateDefinition,
  nda: ndaTemplateDefinition
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
