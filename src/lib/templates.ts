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
  name: "Marketplace Privacy Policy Acknowledgement",
  description: "Generic marketplace privacy policy acknowledgement with typed signature, acknowledgement date, audit trail, and sender notification support.",
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
  name: "Marketplace Contributor Terms of Use",
  description: "Generic contributor/contractor marketplace terms with independent-contractor language, typed signature, acknowledgement date, audit trail, and sender notification support.",
  variables: [
    { key: "company_name", label: "Company name", defaultValue: "Acme Marketplace", required: true },
    { key: "service_name", label: "Service name", defaultValue: "Acme", required: true },
    { key: "website_url", label: "Website", defaultValue: "example.com", required: true },
    { key: "contact_email", label: "Contact email", defaultValue: "legal@example.com", required: true },
    { key: "company_address", label: "Company address", defaultValue: "123 Market Street, San Francisco, CA", required: true },
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
  name: "Acme Inc. Nondisclosure Agreement",
  description: "Generic one-way nondisclosure agreement with recipient and sender e-signature support.",
  variables: [
    { key: "company_name", label: "Company name", defaultValue: "Acme Inc.", required: true }
  ],
  fields: [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "company_entity", label: "Company / Entity (if applicable)", type: "text" },
    { id: "title", label: "Title", type: "text" },
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
