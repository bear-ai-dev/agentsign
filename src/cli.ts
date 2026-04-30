#!/usr/bin/env node

import "dotenv/config";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { marked } from "marked";
import { applyTemplateVars, loadTemplate, titleFromMarkdown } from "./lib/templates.js";

type Args = Record<string, string | boolean | string[]>;
type CliConfig = {
  api_url?: string;
  api_key?: string;
  sender_email?: string;
  sender_name?: string;
  notify_email?: string[];
};

const cliVersion = "0.1.0";
const packageName = "@bear-ai-dev/agentcontract";
const configPath = process.env.AGENTCONTRACT_CONFIG ?? join(homedir(), ".agentcontract", "config.json");
let configLoadError: string | undefined;
const cliConfig = loadCliConfig();
const defaultApiUrl = cleanString(process.env.AGENTCONTRACT_API_URL)
  ?? cleanString(process.env.AGENTSIGN_API_URL)
  ?? cleanString(process.env.AGENTINK_API_URL)
  ?? configString("api_url")
  ?? "https://agentink-pied.vercel.app";
const defaultApiKey = cleanString(process.env.AGENTCONTRACT_API_KEY)
  ?? cleanString(process.env.AGENTSIGN_API_KEY)
  ?? cleanString(process.env.AGENTINK_API_KEY)
  ?? configString("api_key");
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
const specificPrivacyDefaults = {
  companyName: "Specific Marketplace",
  serviceName: "Specific",
  senderEmail: "sid@usebear.ai",
  senderName: "Sid from Specific",
  websiteUrl: "usespecific.com",
  contactEmail: "sid@usebear.ai",
  companyAddress: "39 Tehama, San Francisco, CA",
  effectiveDate: "April 29, 2026"
};

class CliError extends Error {
  usageHint?: string;

  constructor(message: string, usageHint?: string) {
    super(message);
    this.name = "CliError";
    this.usageHint = usageHint;
  }
}

function loadCliConfig(): CliConfig {
  if (!existsSync(configPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config must be a JSON object");
    }
    const raw = parsed as Record<string, unknown>;
    return {
      ...(typeof raw.api_url === "string" ? { api_url: raw.api_url } : {}),
      ...(typeof raw.api_key === "string" ? { api_key: raw.api_key } : {}),
      ...(typeof raw.sender_email === "string" ? { sender_email: raw.sender_email } : {}),
      ...(typeof raw.sender_name === "string" ? { sender_name: raw.sender_name } : {}),
      ...(Array.isArray(raw.notify_email) ? { notify_email: raw.notify_email.map(String) } : {})
    };
  } catch (error) {
    configLoadError = error instanceof Error ? error.message : String(error);
    return {};
  }
}

function configString(key: keyof CliConfig) {
  const value = cliConfig[key];
  return typeof value === "string" ? cleanString(value) : undefined;
}

function writeCliConfig(nextConfig: CliConfig) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(`${configPath}.tmp`, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  chmodSync(`${configPath}.tmp`, 0o600);
  renameSync(`${configPath}.tmp`, configPath);
  chmodSync(configPath, 0o600);
}

function maskSecret(value: string | undefined) {
  if (!value) return undefined;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function publicConfig(showSecrets = false, config: CliConfig = cliConfig) {
  return {
    api_url: config.api_url,
    api_key: showSecrets ? config.api_key : maskSecret(config.api_key),
    sender_email: config.sender_email,
    sender_name: config.sender_name,
    notify_email: config.notify_email ?? []
  };
}

function usage() {
  console.log(`AgentContract CLI

Usage:
  agentcontract init --api-url https://agentink-pied.vercel.app [options]
  agentcontract config get
  agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor" [options]
  agentcontract bulk-marketplace-onboard --file contributors.json [options]
  agentcontract bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01 [options]
  agentcontract bear-mnda --to jane@example.com --name "Jane Doe" [options]
  agentcontract specific-privacy --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI" [options]
  agentcontract send-privacy --from janak@usebear.ai --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-contract --from sid@usebear.ai --to jane@example.com --name "Jane Doe" --template contractor --var rate=150 [options]
  agentcontract preview --template contractor --var company_name="Bear AI" --var rate=150 --open
  agentcontract bulk-mnda --from janak@usebear.ai --file recipients.json --company "Bear AI" [options]
  agentcontract doctor [options]
  agentcontract view <agreement_id> --open
  agentcontract status <agreement_id> [options]
  agentcontract version

The legacy "agentsign" command name is also supported when installed from npm.

Setup:
  agentcontract init                    Save API URL/key and sender defaults to ${configPath}
  agentcontract config get              Show saved config with secrets masked
  agentcontract config path             Print the config path

Sender / Receiver:
  --from, --sender-email <email>     Human sender. Used as Reply-To and default signed notification target
  --sender-name <name>               Human sender name shown in request email
  --to, --email, --receiver-email    Recipient email
  --name, --receiver-name <name>     Recipient name
  --cc <email[,email]>               CC the signing request email
  --notify <email[,email]>           Override who gets emailed when the agreement is signed

Options:
  --api-url <url>                    API base URL. Defaults to AGENTCONTRACT_API_URL or ${defaultApiUrl}
  --api-key <key>                    API key. Defaults to AGENTCONTRACT_API_KEY or AGENTSIGN_API_KEY
  --api-key-stdin                    Read API key from stdin for init/send commands
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
  --effective-date <date>            Defaults to today, except Specific privacy defaults to April 29, 2026
  --term-years <years>               MNDA term. Defaults to 2
  --website <url>                    Legacy privacy override. Specific template hardcodes usespecific.com
  --contact <email>                  Legacy privacy override. Specific template hardcodes sid@usebear.ai
  --address <text>                   Legacy privacy override. Specific template hardcodes 39 Tehama
  --dry-run                          Print the request without sending it
  --json                             Print raw JSON only
  --show-secrets                     Show saved API key in config output
  --version                          Print CLI version

Environment:
  AGENTCONTRACT_API_URL, AGENTCONTRACT_API_KEY, AGENTCONTRACT_SENDER_EMAIL, AGENTCONTRACT_SENDER_NAME, AGENTCONTRACT_NOTIFY_EMAIL, AGENTCONTRACT_CONFIG
  Legacy aliases: AGENTSIGN_API_URL, AGENTSIGN_API_KEY, AGENTSIGN_SENDER_EMAIL, AGENTSIGN_SENDER_NAME, AGENTSIGN_NOTIFY_EMAIL

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

function stringArgSource(args: Args, keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return { value, source: `flag:${key}` };
    if (Array.isArray(value)) return { value: value.at(-1), source: `flag:${key}` };
  }
  return undefined;
}

function cleanString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envString(...names: string[]) {
  for (const name of names) {
    const value = cleanString(process.env[name]);
    if (value) return { value, source: `env:${name}` };
  }
  return undefined;
}

function configStringWithSource(key: keyof CliConfig) {
  const value = configString(key);
  return value ? { value, source: `config:${configPath}` } : undefined;
}

function resolveStringOption(
  args: Args,
  argKeys: string[],
  envKeys: string[],
  configKey?: keyof CliConfig,
  fallback?: string
) {
  const fromArg = stringArgSource(args, argKeys);
  if (fromArg?.value) return fromArg;
  const fromEnv = envString(...envKeys);
  if (fromEnv) return fromEnv;
  const fromConfig = configKey ? configStringWithSource(configKey) : undefined;
  if (fromConfig) return fromConfig;
  return fallback ? { value: fallback, source: "default" } : { value: undefined, source: "missing" };
}

function apiKeyFromStdin(args: Args) {
  if (!args["api-key-stdin"]) return undefined;
  return cleanString(readFileSync(0, "utf8"));
}

function validateEmail(value: string, label: string) {
  const trimmed = value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new CliError(`${label} must be a valid email address: ${value}`);
  }
  return trimmed;
}

function validateEmailList(values: string[], label: string) {
  return values.map((email, index) => validateEmail(email, `${label}${values.length > 1 ? ` #${index + 1}` : ""}`));
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
  const apiUrlOption = resolveStringOption(
    args,
    ["api-url"],
    ["AGENTCONTRACT_API_URL", "AGENTSIGN_API_URL", "AGENTINK_API_URL"],
    "api_url",
    "https://agentink-pied.vercel.app"
  );
  const stdinApiKey = apiKeyFromStdin(args);
  const apiKeyOption = stdinApiKey
    ? { value: stdinApiKey, source: "stdin" }
    : resolveStringOption(
      args,
      ["api-key"],
      ["AGENTCONTRACT_API_KEY", "AGENTSIGN_API_KEY", "AGENTINK_API_KEY"],
      "api_key"
    );
  const apiUrl = normalizeApiUrl(apiUrlOption.value ?? defaultApiUrl);
  const apiKey = apiKeyOption.value ?? defaultApiKey;
  if (requireKey && !apiKey) {
    throw new CliError(
      "API key missing. Run agentcontract init, set AGENTCONTRACT_API_KEY, or pass --api-key-stdin.",
      "For a non-sending preview, run the same command with --dry-run or --preview."
    );
  }
  return { apiUrl, apiKey: apiKey ?? "", apiUrlSource: apiUrlOption.source, apiKeySource: apiKeyOption.source };
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
  const value = cleanString(stringArg(args, "from", "sender-email"))
    ?? cleanString(process.env.AGENTCONTRACT_SENDER_EMAIL)
    ?? cleanString(process.env.AGENTSIGN_SENDER_EMAIL)
    ?? configString("sender_email");
  return value ? validateEmail(value, "--from / sender_email") : undefined;
}

function senderName(args: Args, fallback?: string) {
  return cleanString(stringArg(args, "sender-name"))
    ?? cleanString(process.env.AGENTCONTRACT_SENDER_NAME)
    ?? cleanString(process.env.AGENTSIGN_SENDER_NAME)
    ?? configString("sender_name")
    ?? fallback;
}

function receiverName(args: Args) {
  return requireArg(
    stringArg(args, "name", "receiver-name"),
    "--name / --receiver-name",
    'Example: agentcontract send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI"'
  );
}

function receiverEmail(args: Args) {
  const email = requireArg(
    stringArg(args, "to", "email", "receiver-email"),
    "--to / --email / --receiver-email",
    'Example: agentcontract send-privacy --from janak@usebear.ai --to jane@example.com --name "Jane Doe"'
  );
  return validateEmail(email, "--to / receiver email");
}

function notificationArgs(args: Args, defaultEmail?: string) {
  const notify = listArg(args, "notify");
  if (notify.length === 0) notify.push(...parseEmailList(process.env.AGENTCONTRACT_NOTIFY_EMAIL));
  if (notify.length === 0) notify.push(...parseEmailList(process.env.AGENTSIGN_NOTIFY_EMAIL));
  if (notify.length === 0 && cliConfig.notify_email?.length) notify.push(...cliConfig.notify_email);
  if (notify.length === 0 && defaultEmail) notify.push(defaultEmail);
  return validateEmailList(notify, "--notify");
}

function sharedSendOptions(args: Args, fallbackSenderName?: string) {
  const sender_email = senderEmail(args);
  const cc = validateEmailList(listArg(args, "cc"), "--cc");
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
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${label} must be valid JSON: ${message}`);
  }
}

function parseJsonObjectArg(value: string, label: string) {
  const parsed = parseJsonArg(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readTextFile(path: string, label: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${label} could not be read: ${message}`);
  }
}

function parseJsonFile(path: string, label: string) {
  return parseJsonArg(readTextFile(path, label), label);
}

function parseJsonObjectFile(path: string, label: string) {
  return parseJsonObjectArg(readTextFile(path, label), label);
}

function templateVarsFromArgs(args: Args) {
  const vars: Record<string, unknown> = {};
  const varsFile = stringArg(args, "vars-file");
  if (varsFile) Object.assign(vars, parseJsonObjectFile(varsFile, "--vars-file"));
  const varsJson = stringArg(args, "vars-json");
  if (varsJson) Object.assign(vars, parseJsonObjectArg(varsJson, "--vars-json"));

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
  const parsed = parseJsonFile(fieldsFile, "--fields-file") as unknown;
  if (!Array.isArray(parsed)) throw new CliError("--fields-file must contain a JSON array of field definitions");
  return parsed as Array<Record<string, unknown>>;
}

function markdownFromArgs(args: Args) {
  const markdownFile = stringArg(args, "markdown-file", "document-file", "contract-file");
  if (markdownFile) return readTextFile(markdownFile, "--markdown-file");
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
  const company = requireArg(stringArg(args, "company"), "--company", 'Example: agentcontract send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI"');
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template: "nda",
    template_vars: {
      company_name: company,
      effective_date: stringArg(args, "effective-date") ?? today(),
      term_years: Number(stringArg(args, "term-years") ?? 2)
    },
    fields: mndaFields(),
    metadata: { source: "agentcontract-cli" }
  });
}

function basePrivacyPayload(args: Args) {
  const company = stringArg(args, "company") ?? specificPrivacyDefaults.companyName;
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template: "privacy",
    template_vars: {
      effective_date: stringArg(args, "effective-date") ?? specificPrivacyDefaults.effectiveDate
    },
    fields: privacyFields(),
    metadata: { source: "agentcontract-cli", template_kind: "privacy_policy", company }
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
    metadata: { source: "agentcontract-cli", template_kind: template ?? "custom_markdown" }
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
  const specificArgs = {
    ...args,
    from: stringArg(args, "from", "sender-email") ?? specificPrivacyDefaults.senderEmail,
    "sender-name": stringArg(args, "sender-name") ?? specificPrivacyDefaults.senderName
  };
  const payload = basePrivacyPayload(specificArgs);
  return {
    ...payload,
    metadata: { ...(payload.metadata ?? {}), workflow: "specific_privacy_acknowledgement", company: specificPrivacyDefaults.companyName }
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
      'Example: agentcontract bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01 --preview --open'
    );
  }
  if (!rate) {
    throw new CliError(
      "--rate is required for Bear contractor agreements",
      'Example: agentcontract bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01'
    );
  }
  if (!startDate) {
    throw new CliError(
      "--start-date is required for Bear contractor agreements",
      'Example: agentcontract bear-contractor --to jane@example.com --name "Jane Doe" --scope "Backend engineering" --rate 150 --start-date 2026-05-01'
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
      source: "agentcontract-cli",
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
  <title>${escapeHtml(title)} | AgentContract Preview</title>
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
<body><main><header>AgentContract preview</header><article>${html}</article></main></body>
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
  const output = resolve(stringArg(args, "preview-file", "output-file", "out") ?? join(tmpdir(), "agentcontract-preview.html"));
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

  if (typeof result === "object" && result && "config_saved" in result) {
    const configResult = result as unknown as { config_path: string; config?: CliConfig };
    console.log(`Config saved: ${configResult.config_path}`);
    if (configResult.config?.api_url) console.log(`API URL: ${configResult.config.api_url}`);
    if (configResult.config?.api_key) console.log(`API key: ${configResult.config.api_key}`);
    if (configResult.config?.sender_email) console.log(`Sender email: ${configResult.config.sender_email}`);
    if (configResult.config?.sender_name) console.log(`Sender name: ${configResult.config.sender_name}`);
    if (configResult.config?.notify_email?.length) console.log(`Notify on signed: ${configResult.config.notify_email.join(", ")}`);
    return;
  }

  if (typeof result === "object" && result && "config_path" in result && "config" in result) {
    const configResult = result as { config_path: string; loaded?: boolean; error?: string; config?: CliConfig };
    console.log(`Config path: ${configResult.config_path}`);
    if (configResult.loaded === false && configResult.error) console.log(`Config error: ${configResult.error}`);
    if (configResult.config?.api_url) console.log(`API URL: ${configResult.config.api_url}`);
    if (configResult.config?.api_key) console.log(`API key: ${configResult.config.api_key}`);
    if (configResult.config?.sender_email) console.log(`Sender email: ${configResult.config.sender_email}`);
    if (configResult.config?.sender_name) console.log(`Sender name: ${configResult.config.sender_name}`);
    if (configResult.config?.notify_email?.length) console.log(`Notify on signed: ${configResult.config.notify_email.join(", ")}`);
    return;
  }

  if (typeof result === "object" && result && "config_path" in result) {
    const configResult = result as { config_path: string; exists?: boolean };
    console.log(configResult.config_path);
    if (configResult.exists === false) console.log("No config file exists yet. Run agentcontract init.");
    return;
  }

  if (typeof result === "object" && result && "version" in result && "package" in result) {
    const version = result as { package: string; version: string };
    console.log(`${version.package} ${version.version}`);
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
  if (dryRun(args)) return dryRunResult(String(args.command_name ?? "specific-privacy"), apiUrl, "/v1/agreements", payload);
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
    return { ...row, name, email: validateEmail(email, `Recipient ${index + 1} email`) };
  });
}

async function bulkMnda(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const file = requireArg(stringArg(args, "file"), "--file", "Example: agentcontract bulk-mnda --from janak@usebear.ai --file recipients.json --company \"Bear AI\"");
  const recipients = normalizeBulkRecipients(parseJsonFile(file, "--file"));
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

async function bulkMarketplaceOnboard(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const file = requireArg(stringArg(args, "file"), "--file", "Example: agentcontract bulk-marketplace-onboard --file contributors.json --from sid@usebear.ai");
  const recipients = normalizeBulkRecipients(parseJsonFile(file, "--file"));
  const base = baseBearPrivacyPayload(args);
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
  if (dryRun(args)) return dryRunResult("bulk-marketplace-onboard", apiUrl, "/v1/agreements/bulk", payload);
  return postJson(apiUrl, apiKey, "/v1/agreements/bulk", payload);
}

async function doctor(args: Args) {
  const { apiUrl, apiKey, apiUrlSource, apiKeySource } = apiConfig(args, false);
  const root = await fetch(apiUrl).then(async (response) => ({
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => null)
  })).catch((error: unknown) => ({
    ok: false,
    status: null,
    error: error instanceof Error ? error.message : String(error)
  }));

  const template = apiKey
    ? await getJson(apiUrl, apiKey, "/v1/templates/privacy").then((result) => ({
      ok: true,
      name: typeof result === "object" && result && "template" in result
        ? (result as { template?: { name?: string } }).template?.name
        : undefined
    })).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    : { ok: false, error: "API key is not set. Run agentcontract init --api-key <key>." };

  return {
    cli: "agentcontract",
    package: packageName,
    version: cliVersion,
    config_path: configPath,
    config_loaded: !configLoadError,
    ...(configLoadError ? { config_error: configLoadError } : {}),
    api_url: apiUrl,
    api_url_source: apiUrlSource,
    api_key_present: Boolean(apiKey),
    api_key_source: apiKeySource,
    api: root,
    privacy_template: template
  };
}

async function status(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract status agr_123");
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

function normalizeApiUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("must start with http:// or https://");
    return trimmed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`--api-url must be a valid HTTP(S) URL: ${message}`);
  }
}

async function initConfig(args: Args) {
  if (configLoadError && !args.force) {
    throw new CliError(
      `Existing config at ${configPath} could not be read: ${configLoadError}`,
      "Pass --force to overwrite it."
    );
  }

  const apiUrl = normalizeApiUrl(
    cleanString(stringArg(args, "api-url"))
      ?? cleanString(process.env.AGENTCONTRACT_API_URL)
      ?? cleanString(process.env.AGENTSIGN_API_URL)
      ?? cleanString(process.env.AGENTINK_API_URL)
      ?? cliConfig.api_url
      ?? "https://agentink-pied.vercel.app"
  );
  const apiKey = apiKeyFromStdin(args)
    ?? cleanString(stringArg(args, "api-key"))
    ?? cleanString(process.env.AGENTCONTRACT_API_KEY)
    ?? cleanString(process.env.AGENTSIGN_API_KEY)
    ?? cleanString(process.env.AGENTINK_API_KEY)
    ?? cliConfig.api_key;

  if (!apiKey && !args["no-api-key"]) {
    throw new CliError(
      "--api-key is required to initialize a sending config",
      "Use --no-api-key only for preview-only installs."
    );
  }

  const from = cleanString(stringArg(args, "from", "sender-email"))
    ?? cleanString(process.env.AGENTCONTRACT_SENDER_EMAIL)
    ?? cleanString(process.env.AGENTSIGN_SENDER_EMAIL)
    ?? cliConfig.sender_email;
  const sender_name = cleanString(stringArg(args, "sender-name"))
    ?? cleanString(process.env.AGENTCONTRACT_SENDER_NAME)
    ?? cleanString(process.env.AGENTSIGN_SENDER_NAME)
    ?? cliConfig.sender_name;
  const notifyFromArgs = listArg(args, "notify");
  const notify_email = notifyFromArgs.length
    ? notifyFromArgs
    : parseEmailList(process.env.AGENTCONTRACT_NOTIFY_EMAIL).length
      ? parseEmailList(process.env.AGENTCONTRACT_NOTIFY_EMAIL)
      : parseEmailList(process.env.AGENTSIGN_NOTIFY_EMAIL).length
        ? parseEmailList(process.env.AGENTSIGN_NOTIFY_EMAIL)
        : cliConfig.notify_email ?? [];

  const nextConfig: CliConfig = {
    api_url: apiUrl,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(from ? { sender_email: validateEmail(from, "--sender-email") } : {}),
    ...(sender_name ? { sender_name } : {}),
    ...(notify_email.length ? { notify_email: validateEmailList(notify_email, "--notify") } : {})
  };

  writeCliConfig(nextConfig);
  return {
    config_saved: true,
    config_path: configPath,
    config: publicConfig(Boolean(args["show-secrets"]), nextConfig)
  };
}

async function configCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "get";
  if (action === "path") {
    return { config_path: configPath, exists: existsSync(configPath) };
  }
  if (action === "get" || action === "show") {
    return {
      config_path: configPath,
      loaded: !configLoadError,
      ...(configLoadError ? { error: configLoadError } : {}),
      config: publicConfig(Boolean(args["show-secrets"]))
    };
  }
  throw new CliError(`Unknown config command: ${action}`, "Run agentcontract config get or agentcontract config path.");
}

function versionResult() {
  return { cli: "agentcontract", package: packageName, version: cliVersion };
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    printResult(versionResult(), argv.includes("--json") || argv.includes("-j"));
    return;
  }

  const { args, positional } = parseArgs(rest);

  if (args.help) {
    usage();
    return;
  }

  let result: unknown;
  if (command === "init") {
    result = await initConfig(args);
  } else if (command === "config") {
    result = await configCommand(args, positional);
  } else if (command === "send-mnda" || command === "send-nda") {
    result = await sendMnda(args);
  } else if (command === "send-privacy") {
    result = await sendPrivacy(args);
  } else if (command === "send-contract" || command === "send-agreement") {
    result = await sendContract(args);
  } else if (command === "bear-mnda" || command === "send-bear-mnda") {
    result = await sendBearMnda(args);
  } else if (command === "marketplace-onboard" || command === "onboard-contributor" || command === "specific-privacy" || command === "send-specific-privacy" || command === "bear-privacy" || command === "send-bear-privacy") {
    result = await sendBearPrivacy({ ...args, command_name: command });
  } else if (command === "bear-contractor" || command === "send-bear-contractor") {
    result = await sendBearContractor(args);
  } else if (command === "preview") {
    result = await preview(args);
  } else if (command === "bulk-mnda" || command === "bulk-nda") {
    result = await bulkMnda(args);
  } else if (command === "bulk-marketplace-onboard" || command === "bulk-onboard-contributors") {
    result = await bulkMarketplaceOnboard(args);
  } else if (command === "doctor") {
    result = await doctor(args);
  } else if (command === "view") {
    result = await view(args, positional);
  } else if (command === "status") {
    result = await status(args, positional);
  } else {
    throw new CliError(`Unknown command: ${command}`, "Run agentcontract help to see available commands.");
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
