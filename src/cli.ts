#!/usr/bin/env node

import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { marked } from "marked";
import { applyTemplateVars, loadTemplate, titleFromMarkdown } from "./lib/templates.js";

type Args = Record<string, string | boolean | string[]>;

const defaultApiUrl = process.env.AGENTSIGN_API_URL ?? process.env.AGENTINK_API_URL ?? "https://agentink-pied.vercel.app";
const defaultApiKey = process.env.AGENTSIGN_API_KEY ?? process.env.AGENTINK_API_KEY;
const bearDefaults = {
  companyName: "Bear AI",
  senderEmail: "sid@usebear.ai",
  senderName: "Sid from Bear AI",
  websiteUrl: "https://usebear.ai",
  contactEmail: "sid@usebear.ai",
  companyAddress: "39 Tehama, San Francisco, CA",
  termsName: "Contributor Terms of Use",
  dataUsePolicyName: "Data Use Policy"
};

class CliError extends Error {
  usageHint?: string;

  constructor(message: string, usageHint?: string) {
    super(message);
    this.name = "CliError";
    this.usageHint = usageHint;
  }
}

function usage() {
  console.log(`AgentSign CLI

Usage:
  agentsign bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01 [options]
  agentsign bear-mnda --to jane@example.com --name "Jane Doe" [options]
  agentsign bear-privacy --to jane@example.com --name "Jane Doe" [options]
  agentsign send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI" [options]
  agentsign send-privacy --from janak@usebear.ai --to jane@example.com --name "Jane Doe" [options]
  agentsign send-contract --from sid@usebear.ai --to jane@example.com --name "Jane Doe" --template contractor --var rate=150 [options]
  agentsign preview --template contractor --var company_name="Bear AI" --var rate=150 --open
  agentsign bulk-mnda --from janak@usebear.ai --file recipients.json --company "Bear AI" [options]
  agentsign view <agreement_id> --open
  agentsign status <agreement_id> [options]

Sender / Receiver:
  --from, --sender-email <email>     Human sender. Used as Reply-To and default signed notification target
  --sender-name <name>               Human sender name shown in request email
  --to, --email, --receiver-email    Recipient email
  --name, --receiver-name <name>     Recipient name
  --cc <email[,email]>               CC the signing request email
  --notify <email[,email]>           Override who gets emailed when the agreement is signed

Options:
  --api-url <url>                    API base URL. Defaults to AGENTSIGN_API_URL or ${defaultApiUrl}
  --api-key <key>                    API key. Defaults to AGENTSIGN_API_KEY or AGENTINK_API_KEY
  --webhook-url <url>                Machine webhook for agreement.completed
  --template <name>                  Template for send-contract/preview: nda, privacy, contractor
  --var <key=value>                  Template variable. Repeatable
  --vars-json <json>                 Template variables as JSON
  --vars-file <path>                 Template variables JSON file
  --markdown-file <path>             Custom markdown contract file
  --fields-file <path>               JSON field definitions file
  --preview                          Render local HTML preview instead of sending
  --preview-file <path>              Where to write preview HTML
  --open                             Open preview/signing URL in the browser
  --scope <text>                     Bear contractor scope of work
  --rate <amount>                    Bear contractor rate
  --start-date <date>                Bear contractor start date
  --effective-date <date>            Defaults to today
  --term-years <years>               MNDA term. Defaults to 2
  --service <name>                   Privacy policy service name. Defaults to Bear AI
  --website <url>                    Privacy policy website. Defaults to https://usebear.ai
  --contact <email>                  Privacy policy contact email. Defaults to sid@usebear.ai
  --address <text>                   Privacy policy company address
  --dry-run                          Print the request without sending it
  --json                             Print raw JSON only

Environment:
  AGENTSIGN_API_URL, AGENTSIGN_API_KEY, AGENTSIGN_SENDER_EMAIL, AGENTSIGN_SENDER_NAME, AGENTSIGN_NOTIFY_EMAIL

Bulk JSON can be either an array of recipients or { "recipients": [...] }.
Each recipient should have "name" and "email".`);
}

function parseArgs(argv: string[]) {
  const args: Args = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "-j") {
      args.json = true;
      continue;
    }
    if (token === "-n") {
      args["dry-run"] = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    const key = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
    const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : undefined;
    const next = argv[i + 1];
    const value = inlineValue ?? (!next || next.startsWith("-") ? true : next);
    if (inlineValue === undefined && value !== true) i += 1;

    if (args[key] === undefined) {
      args[key] = value;
    } else {
      args[key] = Array.isArray(args[key]) ? [...args[key] as string[], String(value)] : [String(args[key]), String(value)];
    }
  }

  return { args, positional };
}

function stringArg(args: Args, ...keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.at(-1);
  }
  return undefined;
}

function cleanString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function listArg(args: Args, key: string) {
  const value = args[key];
  if (!value || value === true) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => String(entry).split(",")).map((email) => email.trim()).filter(Boolean);
}

function requireArg(value: string | undefined, label: string, example: string) {
  if (!value) throw new CliError(`${label} is required`, example);
  return value;
}

function parseEmailList(value: string | undefined) {
  return value?.split(",").map((email) => email.trim()).filter(Boolean) ?? [];
}

function apiConfig(args: Args, requireKey = true) {
  const apiUrl = (stringArg(args, "api-url") ?? defaultApiUrl).replace(/\/+$/, "");
  const apiKey = stringArg(args, "api-key") ?? defaultApiKey;
  if (requireKey && !apiKey) {
    throw new CliError(
      "API key missing. Set AGENTSIGN_API_KEY or pass --api-key.",
      "For a non-sending preview, run the same command with --dry-run."
    );
  }
  return { apiUrl, apiKey: apiKey ?? "" };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function mndaFields() {
  return [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ];
}

function privacyFields() {
  return [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "acknowledgement_date", label: "Acknowledgement date", type: "date", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ];
}

function contractorFields() {
  return [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "address", label: "Address", type: "text", required: true },
    { id: "tax_id", label: "SSN or EIN (last 4)", type: "text", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ];
}

function defaultFieldsFor(template: string | undefined) {
  if (template === "privacy") return privacyFields();
  if (template === "contractor") return contractorFields();
  return mndaFields();
}

async function postJson(apiUrl: string, apiKey: string, path: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: controller.signal
  });
  clearTimeout(timeout);

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new CliError(result.error ?? `HTTP ${response.status}`);
  return result;
}

async function getJson(apiUrl: string, apiKey: string, path: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new CliError(result.error ?? `HTTP ${response.status}`);
  return result;
}

function dryRun(args: Args) {
  return Boolean(args["dry-run"]);
}

function jsonOutput(args: Args) {
  return Boolean(args.json) || stringArg(args, "output") === "json";
}

function senderEmail(args: Args) {
  return cleanString(stringArg(args, "from", "sender-email")) ?? cleanString(process.env.AGENTSIGN_SENDER_EMAIL);
}

function senderName(args: Args, fallback?: string) {
  return cleanString(stringArg(args, "sender-name")) ?? cleanString(process.env.AGENTSIGN_SENDER_NAME) ?? fallback;
}

function receiverName(args: Args) {
  return requireArg(
    stringArg(args, "name", "receiver-name"),
    "--name / --receiver-name",
    'Example: agentsign send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI"'
  );
}

function receiverEmail(args: Args) {
  return requireArg(
    stringArg(args, "to", "email", "receiver-email"),
    "--to / --email / --receiver-email",
    'Example: agentsign send-privacy --from janak@usebear.ai --to jane@example.com --name "Jane Doe"'
  );
}

function notificationArgs(args: Args, defaultEmail?: string) {
  const notify = listArg(args, "notify");
  if (notify.length === 0) notify.push(...parseEmailList(process.env.AGENTSIGN_NOTIFY_EMAIL));
  if (notify.length === 0 && defaultEmail) notify.push(defaultEmail);
  return notify;
}

function sharedSendOptions(args: Args, fallbackSenderName?: string) {
  const sender_email = senderEmail(args);
  const cc = listArg(args, "cc");
  const notify = notificationArgs(args, sender_email);
  return {
    cc: cc.length ? cc : undefined,
    sender_email,
    sender_name: senderName(args, fallbackSenderName),
    notification_email: notify.length ? notify : undefined,
    webhook_url: stringArg(args, "webhook-url")
  };
}

function withBearDefaults(args: Args): Args {
  return {
    ...args,
    from: stringArg(args, "from", "sender-email") ?? bearDefaults.senderEmail,
    "sender-name": stringArg(args, "sender-name") ?? bearDefaults.senderName,
    company: stringArg(args, "company") ?? bearDefaults.companyName,
    website: stringArg(args, "website") ?? bearDefaults.websiteUrl,
    contact: stringArg(args, "contact") ?? bearDefaults.contactEmail,
    address: stringArg(args, "address") ?? bearDefaults.companyAddress,
    "terms-name": stringArg(args, "terms-name") ?? bearDefaults.termsName,
    "data-use-policy-name": stringArg(args, "data-use-policy-name") ?? bearDefaults.dataUsePolicyName
  };
}

function repeatArg(args: Args, key: string) {
  const value = args[key];
  if (!value || value === true) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function parseJsonArg(value: string, label: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new CliError(`${label} must be valid JSON`);
  }
}

function templateVarsFromArgs(args: Args) {
  const vars: Record<string, unknown> = {};
  const varsFile = stringArg(args, "vars-file");
  if (varsFile) Object.assign(vars, parseJsonArg(readFileSync(varsFile, "utf8"), "--vars-file"));
  const varsJson = stringArg(args, "vars-json");
  if (varsJson) Object.assign(vars, parseJsonArg(varsJson, "--vars-json"));

  for (const entry of repeatArg(args, "var")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new CliError(`Invalid --var "${entry}"`, "Use --var key=value, for example --var rate=150");
    const key = entry.slice(0, eq).trim();
    const rawValue = entry.slice(eq + 1).trim();
    vars[key] = coerceVarValue(rawValue);
  }

  return vars;
}

function coerceVarValue(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function fieldsFromArgs(args: Args, fallback: Array<Record<string, unknown>>) {
  const fieldsFile = stringArg(args, "fields-file");
  if (!fieldsFile) return fallback;
  const parsed = JSON.parse(readFileSync(fieldsFile, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new CliError("--fields-file must contain a JSON array of field definitions");
  return parsed as Array<Record<string, unknown>>;
}

function markdownFromArgs(args: Args) {
  const markdownFile = stringArg(args, "markdown-file", "document-file", "contract-file");
  if (markdownFile) return readFileSync(markdownFile, "utf8");
  return stringArg(args, "document-markdown", "markdown");
}

type AgreementPayload = {
  recipient?: { name: string; email: string };
  cc?: string[];
  sender_email?: string;
  sender_name?: string;
  notification_email?: string[];
  template?: string;
  document_markdown?: string;
  template_vars?: Record<string, unknown>;
  fields?: Array<Record<string, unknown>>;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
};

function withCustomContractArgs(args: Args, payload: AgreementPayload) {
  const templateOverride = stringArg(args, "template");
  const markdown = markdownFromArgs(args);
  const template = markdown ? undefined : templateOverride ?? payload.template;
  const fallbackFields = payload.fields ?? defaultFieldsFor(template);
  const customized: AgreementPayload = {
    ...payload,
    ...(template ? { template } : {}),
    ...(markdown ? { document_markdown: markdown } : {}),
    template_vars: {
      ...(payload.template_vars ?? {}),
      ...templateVarsFromArgs(args)
    },
    fields: fieldsFromArgs(args, fallbackFields)
  };
  if (markdown) delete customized.template;
  return customized;
}

function baseMndaPayload(args: Args) {
  const company = requireArg(stringArg(args, "company"), "--company", 'Example: agentsign send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI"');
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template: "nda",
    template_vars: {
      company_name: company,
      effective_date: stringArg(args, "effective-date") ?? today(),
      term_years: Number(stringArg(args, "term-years") ?? 2)
    },
    fields: mndaFields(),
    metadata: { source: "agentsign-cli" }
  });
}

function basePrivacyPayload(args: Args) {
  const company = stringArg(args, "company") ?? "Bear AI";
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template: "privacy",
    template_vars: {
      company_name: company,
      service_name: stringArg(args, "service") ?? company,
      website_url: stringArg(args, "website") ?? "https://usebear.ai",
      effective_date: stringArg(args, "effective-date") ?? today(),
      terms_name: stringArg(args, "terms-name") ?? "Contributor Terms of Use",
      data_use_policy_name: stringArg(args, "data-use-policy-name") ?? "Data Use Policy",
      contact_email: stringArg(args, "contact") ?? "sid@usebear.ai",
      company_address: stringArg(args, "address") ?? "39 Tehama, San Francisco, CA"
    },
    fields: privacyFields(),
    metadata: { source: "agentsign-cli", template_kind: "privacy_policy" }
  });
}

function baseContractPayload(args: Args) {
  const template = stringArg(args, "template") ?? (markdownFromArgs(args) ? undefined : "contractor");
  if (!template && !markdownFromArgs(args)) {
    throw new CliError("send-contract needs --template or --markdown-file");
  }
  const company = stringArg(args, "company") ?? String(templateVarsFromArgs(args).company_name ?? "Bear AI");
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template,
    template_vars: {
      company_name: company,
      effective_date: stringArg(args, "effective-date") ?? today(),
      rate_unit: stringArg(args, "rate-unit") ?? "hour",
      invoice_frequency: stringArg(args, "invoice-frequency") ?? "biweekly",
      notice_days: stringArg(args, "notice-days") ?? "14",
      start_date: stringArg(args, "start-date") ?? today(),
      ...templateVarsFromArgs(args)
    },
    fields: defaultFieldsFor(template),
    metadata: { source: "agentsign-cli", template_kind: template ?? "custom_markdown" }
  });
}

function baseBearMndaPayload(args: Args) {
  const bearArgs = withBearDefaults(args);
  const payload = baseMndaPayload(bearArgs);
  return {
    ...payload,
    metadata: { ...(payload.metadata ?? {}), workflow: "bear_mnda", company: bearDefaults.companyName }
  };
}

function baseBearPrivacyPayload(args: Args) {
  const bearArgs = withBearDefaults(args);
  const payload = basePrivacyPayload(bearArgs);
  return {
    ...payload,
    metadata: { ...(payload.metadata ?? {}), workflow: "bear_privacy_acknowledgement", company: bearDefaults.companyName }
  };
}

function baseBearContractorPayload(args: Args) {
  const bearArgs = withBearDefaults(args);
  const vars = templateVarsFromArgs(args);
  const scope = cleanString(stringArg(args, "scope", "scope-of-work", "work", "role")) ?? cleanString(String(vars.scope_of_work ?? ""));
  const rate = cleanString(stringArg(args, "rate", "hourly-rate")) ?? cleanString(String(vars.rate ?? ""));
  const startDate = cleanString(stringArg(args, "start-date")) ?? cleanString(String(vars.start_date ?? ""));
  if (!scope) {
    throw new CliError(
      "--scope is required for Bear contractor agreements",
      'Example: agentsign bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01 --preview --open'
    );
  }
  if (!rate) {
    throw new CliError(
      "--rate is required for Bear contractor agreements",
      'Example: agentsign bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01'
    );
  }
  if (!startDate) {
    throw new CliError(
      "--start-date is required for Bear contractor agreements",
      'Example: agentsign bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01'
    );
  }

  return withCustomContractArgs(bearArgs, {
    ...sharedSendOptions(bearArgs, bearDefaults.senderName),
    template: "contractor",
    template_vars: {
      company_name: bearDefaults.companyName,
      effective_date: stringArg(args, "effective-date") ?? today(),
      scope_of_work: scope,
      rate,
      rate_unit: stringArg(args, "rate-unit") ?? "hour",
      invoice_frequency: stringArg(args, "invoice-frequency") ?? "biweekly",
      start_date: startDate,
      notice_days: stringArg(args, "notice-days") ?? "14",
      ...vars
    },
    fields: contractorFields(),
    metadata: {
      source: "agentsign-cli",
      workflow: "bear_contractor_onboarding",
      company: bearDefaults.companyName
    }
  });
}

function previewHtmlFor(payload: AgreementPayload) {
  const source = payload.document_markdown ?? loadTemplate(payload.template ?? "nda");
  const rendered = applyTemplateVars(source, {
    ...(payload.template_vars ?? {}),
    recipient_name: payload.recipient?.name ?? "Preview Recipient",
    recipient_email: payload.recipient?.email ?? "preview@example.com"
  });
  const title = titleFromMarkdown(rendered);
  const html = marked.parse(rendered, { async: false }) as string;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} | AgentSign Preview</title>
  <style>
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(100% - 32px, 820px); margin: 32px auto; }
    header { margin-bottom: 16px; color: #475569; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    article { border: 1px solid #e2e8f0; border-radius: 8px; background: white; padding: 36px; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
    h1 { font-size: 30px; line-height: 1.15; margin: 0 0 22px; }
    h2 { font-size: 18px; margin: 28px 0 8px; }
    p, li { line-height: 1.68; color: #334155; }
    hr { border: 0; border-top: 1px solid #e2e8f0; margin: 28px 0; }
  </style>
</head>
<body><main><header>AgentSign contract preview</header><article>${html}</article></main></body>
</html>`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function writePreview(payload: AgreementPayload, args: Args) {
  const output = resolve(stringArg(args, "preview-file", "output-file", "out") ?? join(tmpdir(), "agentsign-preview.html"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, previewHtmlFor(payload));
  if (args.open) openTarget(output);
  return { preview: true, path: output, opened: Boolean(args.open), title: titleFromMarkdown(applyTemplateVars(payload.document_markdown ?? loadTemplate(payload.template ?? "nda"), payload.template_vars ?? {})) };
}

function openTarget(target: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error) throw new CliError(`Could not open ${target}: ${result.error.message}`);
}

function dryRunResult(command: string, apiUrl: string, path: string, payload: unknown) {
  return {
    dry_run: true,
    command,
    method: "POST",
    url: `${apiUrl}${path}`,
    payload
  };
}

function printResult(result: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (typeof result === "object" && result && "dry_run" in result) {
    const dry = result as unknown as { command: string; method: string; url: string; payload: { recipient?: { name?: string; email?: string }; sender_email?: string; notification_email?: string[] } };
    console.log(`Dry run: ${dry.command}`);
    console.log(`${dry.method} ${dry.url}`);
    if (dry.payload.sender_email) console.log(`From / Reply-To: ${dry.payload.sender_email}`);
    if (dry.payload.recipient?.email) console.log(`To: ${dry.payload.recipient.name ?? ""} <${dry.payload.recipient.email}>`);
    if (dry.payload.notification_email?.length) console.log(`Notify on signed: ${dry.payload.notification_email.join(", ")}`);
    console.log(JSON.stringify(dry.payload, null, 2));
    return;
  }

  if (typeof result === "object" && result && "preview" in result) {
    const preview = result as unknown as { path: string; opened?: boolean; title?: string };
    console.log(`Preview: ${preview.path}`);
    if (preview.title) console.log(`Title: ${preview.title}`);
    if (preview.opened) console.log("Opened in browser");
    return;
  }

  if (typeof result === "object" && result && "agreements" in result && Array.isArray(result.agreements)) {
    console.log(`Sent ${result.agreements.length} agreements`);
    for (const agreement of result.agreements) {
      console.log(`${agreement.id}: ${agreement.signing_url}`);
    }
    return;
  }

  if (typeof result === "object" && result && "id" in result) {
    const agreement = result as { id: string; status?: string; signing_url?: string; preview_url?: string; signed_pdf_url?: string | null; webhook_secret?: string | null; notification_email?: string[] };
    console.log(`Sent agreement: ${agreement.id}`);
    if (agreement.status) console.log(`Status: ${agreement.status}`);
    if (agreement.preview_url) console.log(`Preview URL: ${agreement.preview_url}`);
    if (agreement.signing_url) console.log(`Signing URL: ${agreement.signing_url}`);
    if (agreement.signed_pdf_url) console.log(`Signed PDF: ${agreement.signed_pdf_url}`);
    if (agreement.webhook_secret) console.log(`Webhook secret: ${agreement.webhook_secret}`);
    if (agreement.notification_email?.length) console.log(`Notify on signed: ${agreement.notification_email.join(", ")}`);
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

async function sendMnda(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseMndaPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return dryRunResult("send-mnda", apiUrl, "/v1/agreements", payload);
  const result = await postJson(apiUrl, apiKey, "/v1/agreements", payload);
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendPrivacy(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...basePrivacyPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return dryRunResult("send-privacy", apiUrl, "/v1/agreements", payload);
  const result = await postJson(apiUrl, apiKey, "/v1/agreements", payload);
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendContract(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseContractPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return dryRunResult("send-contract", apiUrl, "/v1/agreements", payload);
  const result = await postJson(apiUrl, apiKey, "/v1/agreements", payload);
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendBearMnda(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseBearMndaPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return dryRunResult("bear-mnda", apiUrl, "/v1/agreements", payload);
  const result = await postJson(apiUrl, apiKey, "/v1/agreements", payload);
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendBearPrivacy(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseBearPrivacyPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return dryRunResult("bear-privacy", apiUrl, "/v1/agreements", payload);
  const result = await postJson(apiUrl, apiKey, "/v1/agreements", payload);
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendBearContractor(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseBearContractorPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return dryRunResult("bear-contractor", apiUrl, "/v1/agreements", payload);
  const result = await postJson(apiUrl, apiKey, "/v1/agreements", payload);
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function preview(args: Args) {
  const payload = {
    recipient: {
      name: stringArg(args, "name", "receiver-name") ?? "Preview Recipient",
      email: stringArg(args, "to", "email", "receiver-email") ?? "preview@example.com"
    },
    ...baseContractPayload(args)
  };
  return writePreview(payload, { ...args, preview: true });
}

function normalizeBulkRecipients(parsed: unknown) {
  const recipients = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed && "recipients" in parsed
      ? (parsed as { recipients?: unknown }).recipients
      : undefined;
  if (!Array.isArray(recipients) || recipients.length === 0) throw new CliError("Bulk file must contain at least one recipient");

  return recipients.map((recipient, index) => {
    if (typeof recipient !== "object" || !recipient) throw new CliError(`Recipient ${index + 1} must be an object`);
    const row = recipient as Record<string, unknown>;
    const name = String(row.name ?? row.receiver_name ?? "").trim();
    const email = String(row.email ?? row.receiver_email ?? row.to ?? "").trim();
    if (!name || !email) throw new CliError(`Recipient ${index + 1} needs name and email`);
    return { ...row, name, email };
  });
}

async function bulkMnda(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const file = requireArg(stringArg(args, "file"), "--file", "Example: agentsign bulk-mnda --from janak@usebear.ai --file recipients.json --company \"Bear AI\"");
  const recipients = normalizeBulkRecipients(JSON.parse(readFileSync(file, "utf8")));
  const base = baseMndaPayload(args);
  const payload = {
    recipients,
    template_vars_default: base.template_vars,
    ...base
  };
  delete (payload as { template_vars?: unknown }).template_vars;
  if (args.preview) {
    return writePreview({
      recipient: { name: recipients[0].name, email: recipients[0].email },
      ...base
    }, args);
  }
  if (dryRun(args)) return dryRunResult("bulk-mnda", apiUrl, "/v1/agreements/bulk", payload);
  return postJson(apiUrl, apiKey, "/v1/agreements/bulk", payload);
}

async function status(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentsign status agr_123");
  return getJson(apiUrl, apiKey, `/v1/agreements/${id}`);
}

async function view(args: Args, positional: string[]) {
  const result = await status(args, positional) as {
    id: string;
    preview_url?: string;
    signing_url?: string;
    signed_pdf_url?: string | null;
  };
  const target = args.pdf && result.signed_pdf_url
    ? result.signed_pdf_url
    : args.signing
      ? result.signing_url
      : result.preview_url ?? result.signing_url;
  if (args.open && target) openTarget(target);
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { args, positional } = parseArgs(rest);

  if (!command || command === "help" || args.help) {
    usage();
    return;
  }

  let result: unknown;
  if (command === "send-mnda" || command === "send-nda") {
    result = await sendMnda(args);
  } else if (command === "send-privacy") {
    result = await sendPrivacy(args);
  } else if (command === "send-contract" || command === "send-agreement") {
    result = await sendContract(args);
  } else if (command === "bear-mnda" || command === "send-bear-mnda") {
    result = await sendBearMnda(args);
  } else if (command === "bear-privacy" || command === "send-bear-privacy") {
    result = await sendBearPrivacy(args);
  } else if (command === "bear-contractor" || command === "send-bear-contractor") {
    result = await sendBearContractor(args);
  } else if (command === "preview") {
    result = await preview(args);
  } else if (command === "bulk-mnda" || command === "bulk-nda") {
    result = await bulkMnda(args);
  } else if (command === "view") {
    result = await view(args, positional);
  } else if (command === "status") {
    result = await status(args, positional);
  } else {
    throw new CliError(`Unknown command: ${command}`, "Run agentsign help to see available commands.");
  }

  printResult(result, jsonOutput(args));
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    if (error.usageHint) console.error(`Hint: ${error.usageHint}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
