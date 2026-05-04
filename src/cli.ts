#!/usr/bin/env node

import "dotenv/config";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { marked } from "marked";
import { nanoid } from "nanoid";
import { applyTemplateVars, defaultTemplateVars, loadTemplate, templateDefinitions, titleFromMarkdown } from "./lib/templates.js";

type Args = Record<string, string | boolean | string[]>;
type CliConfig = {
  api_url?: string;
  api_key?: string;
  sender_email?: string;
  sender_name?: string;
  notify_email?: string[];
};
type AutoUpdateState = {
  api_url?: string;
  current_version?: string;
  latest_version?: string;
  update_available?: boolean;
  last_checked_at?: string;
  last_error?: string;
  last_error_at?: string;
  updated_at?: string;
};
type SavedContractDefinition = {
  id: string;
  name: string;
  description?: string;
  fields: Array<Record<string, unknown>>;
  template_vars_default?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  source?: string;
};
type ContractDefinitionForCli = SavedContractDefinition & {
  kind: "built-in" | "local";
  markdown: string;
  path?: string;
};
type ContractFeedback = {
  id: string;
  contract_id: string;
  note: string;
  author?: string;
  created_at: string;
  source: string;
  status: "open";
};
type ProductFeedbackForCli = {
  id: string;
  reporter_email?: string | null;
  reporter_name?: string | null;
  source: string;
  category: string;
  severity: string;
  command?: string | null;
  message: string;
  expected?: string | null;
  actual?: string | null;
  status: string;
  created_at: string;
};
type ReminderTarget = "recipient" | "sender" | "all";

const cliVersion = "0.1.9";
const packageName = "agent-contract";
const configPath = process.env.AGENTCONTRACT_CONFIG ?? join(homedir(), ".agentcontract", "config.json");
const autoUpdateStatePath = process.env.AGENTCONTRACT_UPDATE_STATE ?? join(dirname(configPath), "update.json");
const contractsDir = process.env.AGENTCONTRACT_CONTRACTS_DIR ?? join(dirname(configPath), "contracts");
let configLoadError: string | undefined;
let activeCliTelemetry: {
  id: string;
  command: string;
  argv: string[];
  args: Args;
  startedAt: string;
  startedMs: number;
} | null = null;
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
const demoDefaults = {
  companyName: "Acme Inc.",
  senderEmail: "you@example.com",
  senderName: "Sender from Acme",
  websiteUrl: "https://example.com",
  contactEmail: "you@example.com",
  companyAddress: "123 Market Street, San Francisco, CA",
  termsName: "Contributor Terms of Use",
  dataUsePolicyName: "Data Use Policy"
};
const demoMarketplaceDefaults = {
  companyName: "Acme Marketplace",
  serviceName: "Acme",
  senderEmail: "you@example.com",
  senderName: "Sender from Acme",
  websiteUrl: "example.com",
  contactEmail: "you@example.com",
  companyAddress: "123 Market Street, San Francisco, CA",
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

function contractLibraryDir(args: Args = {}) {
  return resolve(stringArg(args, "contract-dir", "contracts-dir") ?? contractsDir);
}

function assertContractId(value: string | undefined) {
  if (!value) {
    throw new CliError("contract id is required", "Example: agentcontract contract show privacy");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(value)) {
    throw new CliError("contract id must use letters, numbers, dashes, or underscores", "Example: partner-msa");
  }
  return value.toLowerCase();
}

function contractDir(id: string, args: Args = {}) {
  return join(contractLibraryDir(args), id);
}

function contractMetaPath(id: string, args: Args = {}) {
  return join(contractDir(id, args), "contract.json");
}

function contractMarkdownPath(id: string, args: Args = {}) {
  return join(contractDir(id, args), "contract.md");
}

function contractFeedbackPath(id: string, args: Args = {}) {
  return join(contractDir(id, args), "feedback.jsonl");
}

function builtInContract(id: string): ContractDefinitionForCli | undefined {
  const definition = templateDefinitions[id as keyof typeof templateDefinitions];
  if (!definition) return undefined;
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    fields: definition.fields,
    template_vars_default: defaultTemplateVars(definition),
    created_at: "built-in",
    updated_at: "built-in",
    source: "built-in",
    kind: "built-in",
    markdown: loadTemplate(definition.id)
  };
}

function builtInContracts() {
  return Object.keys(templateDefinitions)
    .map((id) => builtInContract(id))
    .filter(Boolean) as ContractDefinitionForCli[];
}

function readLocalContract(id: string, args: Args = {}): ContractDefinitionForCli | undefined {
  const metaPath = contractMetaPath(id, args);
  const markdownPath = contractMarkdownPath(id, args);
  if (!existsSync(metaPath) || !existsSync(markdownPath)) return undefined;
  const parsed = parseJsonObjectFile(metaPath, `contract ${id} metadata`);
  const meta = parsed as Partial<SavedContractDefinition>;
  if (!meta.id || !meta.name || !Array.isArray(meta.fields)) {
    throw new CliError(`Contract ${id} metadata is invalid`, `${metaPath} must include id, name, and fields.`);
  }
  return {
    id: String(meta.id),
    name: String(meta.name),
    description: typeof meta.description === "string" ? meta.description : undefined,
    fields: meta.fields as Array<Record<string, unknown>>,
    template_vars_default: meta.template_vars_default && typeof meta.template_vars_default === "object" && !Array.isArray(meta.template_vars_default)
      ? meta.template_vars_default as Record<string, unknown>
      : {},
    created_at: typeof meta.created_at === "string" ? meta.created_at : "",
    updated_at: typeof meta.updated_at === "string" ? meta.updated_at : "",
    source: typeof meta.source === "string" ? meta.source : undefined,
    kind: "local",
    markdown: readTextFile(markdownPath, `contract ${id} markdown`),
    path: markdownPath
  };
}

function readLocalContracts(args: Args = {}) {
  const dir = contractLibraryDir(args);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readLocalContract(entry.name, args);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean) as ContractDefinitionForCli[];
}

function loadContract(id: string, args: Args = {}) {
  const contract = readLocalContract(id, args) ?? builtInContract(id);
  if (!contract) {
    throw new CliError(`Unknown contract: ${id}`, "Run agentcontract contracts to see available contracts.");
  }
  return contract;
}

function contractSummary(contract: ContractDefinitionForCli) {
  return {
    id: contract.id,
    name: contract.name,
    kind: contract.kind,
    description: contract.description,
    variables: Object.keys(contract.template_vars_default ?? {}),
    fields: contract.fields.map((field) => ({
      id: field.id,
      type: field.type,
      required: field.required === true
    })),
    path: contract.path
  };
}

function extractTemplateVariables(markdown: string) {
  const variables = new Set<string>();
  for (const match of markdown.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const key = match[1];
    if (key !== "recipient_name" && key !== "recipient_email") variables.add(key);
  }
  return [...variables].sort();
}

function defaultContractVars(markdown: string, seed: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(extractTemplateVariables(markdown).map((key) => [key, ""])),
    ...seed
  };
}

function writeLocalContract(contract: SavedContractDefinition, markdown: string, args: Args = {}) {
  const id = assertContractId(contract.id);
  const dir = contractDir(id, args);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(contractMarkdownPath(id, args), markdown);
  writeFileSync(contractMetaPath(id, args), `${JSON.stringify({ ...contract, id }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(contractMetaPath(id, args), 0o600);
  return readLocalContract(id, args)!;
}

function ensureLocalContract(id: string, args: Args = {}) {
  const local = readLocalContract(id, args);
  if (local) return { contract: local, cloned: false };

  const builtIn = builtInContract(id);
  if (!builtIn) throw new CliError(`Unknown contract: ${id}`, "Run agentcontract contracts to see available contracts.");

  const now = new Date().toISOString();
  const contract = writeLocalContract({
    id: builtIn.id,
    name: builtIn.name,
    description: builtIn.description,
    fields: builtIn.fields,
    template_vars_default: builtIn.template_vars_default,
    created_at: now,
    updated_at: now,
    source: `built-in:${builtIn.id}`
  }, builtIn.markdown, args);
  return { contract, cloned: true };
}

function readContractFeedback(id: string, args: Args = {}) {
  const path = contractFeedbackPath(id, args);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as ContractFeedback;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(`Could not parse feedback line ${index + 1} for ${id}: ${message}`, path);
      }
    });
}

function writeContractFeedback(id: string, feedback: ContractFeedback, args: Args = {}) {
  const dir = contractDir(id, args);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = contractFeedbackPath(id, args);
  appendFileSync(path, `${JSON.stringify(feedback)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function feedbackMarkdown(feedback: ContractFeedback[]) {
  if (!feedback.length) return "";
  const lines = [
    "## Contract Feedback",
    "",
    ...feedback.map((item, index) => {
      const author = item.author ? ` by ${item.author}` : "";
      return `${index + 1}. [${item.created_at}${author}] ${item.note}`;
    })
  ];
  return `${lines.join("\n")}\n`;
}

function usage() {
  console.log(`AgentContract CLI

Usage:
  agentcontract login
  agentcontract login --email you@example.com
  agentcontract skill
  agentcontract init --api-url https://agentink-pied.vercel.app [options]
  agentcontract config get
  agentcontract keys
  agentcontract key create --key-name "Agent laptop"
  agentcontract key revoke key_123
  agentcontract domain setup --email-domain acme.com --signing-domain contracts.acme.com --from legal@acme.com
  agentcontract domain status
  agentcontract domain verify
  agentcontract templates
  agentcontract template read privacy --out ./privacy.md
  agentcontract template send nda --to jane@example.com --name "Jane Doe"
  agentcontract contracts
  agentcontract read privacy --var effective_date=2026-04-29
  agentcontract agreements --status sent --limit 20
  agentcontract batches
  agentcontract batch read bat_123
  agentcontract agreement read agr_123 --out ./agreement.md
  agentcontract agreement audit agr_123
  agentcontract agreement remind agr_123 --remind-recipient
  agentcontract agreement pdf agr_123 --out ./agreement.pdf
  agentcontract contract show privacy
  agentcontract contract add partner-msa --markdown-file ./partner-msa.md --fields-file ./fields.json
  agentcontract contract feedback partner-msa --note "Use California law and shorten the termination section"
  agentcontract contract edit partner-msa
  agentcontract contract read partner-msa --with-feedback
  agentcontract feedback --message "Login code never arrived" --command "agentcontract login --email you@example.com"
  agentcontract feedback list --json
  agentcontract update
  agentcontract update --check
  agentcontract dashboard
  agentcontract dashboard contractor
  agentcontract contract preview partner-msa --var company_name="Acme Inc." --preview-file ./preview.html
  agentcontract contract send partner-msa --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-pdf ./agreement.pdf --to jane@example.com --name "Jane Doe" [options]
  agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor" [options]
  agentcontract bulk-marketplace-onboard --file contributors.json [options]
  agentcontract bulk-contractor --file contractors.json [options]
  agentcontract marketplace-contractor --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-mnda --to jane@example.com --name "Jane Doe" [options]
  agentcontract marketplace-onboard --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-mnda --from legal@example.com --to jane@example.com --name "Jane Doe" --company "Acme Inc." [options]
  agentcontract send-privacy --from legal@example.com --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-contract --from you@example.com --to jane@example.com --name "Jane Doe" --template contractor [options]
  agentcontract preview --template contractor --var company_name="Acme Marketplace" --preview-file ./preview.html
  agentcontract bulk-mnda --from legal@example.com --file recipients.json --company "Acme Inc." [options]
  agentcontract bulk-contractor --from you@example.com --file contractors.json [options]
  agentcontract doctor [options]
  agentcontract status <agreement_id> [options]
  agentcontract version

The legacy "agentsign" command name is also supported when installed from npm.

Setup:
  agentcontract login                    Browser login via WorkOS/Google Workspace, saves config automatically
  agentcontract login --email <email>    Email-code login. Use when browser redirect is blocked
  agentcontract skill                    Install/update the AI-agent skill
  agentcontract init                    Save API URL/key and sender defaults to ${configPath}
  agentcontract config get              Show saved config with secrets masked
  agentcontract feedback                Report CLI/product breakage to AgentContract
  agentcontract update                  Check npm and update this global CLI install
  agentcontract dashboard               Open the sender dashboard or template UI
  agentcontract config path             Print the config path
  agentcontract keys                    List user-owned API keys without opening the dashboard
  agentcontract key create              Create another user-owned API key from the current key
  agentcontract key revoke <key_id>     Revoke a user-owned API key
  agentcontract domain setup            Configure first-party email and signing domains
  agentcontract domain status           Show sender domain verification status and DNS records
  agentcontract domain verify           Re-check Resend and Vercel domain verification
  agentcontract templates               List server templates from the API
  agentcontract template read <id>      Print server template markdown from the API
  agentcontract contracts               List built-in and local reusable contracts
  agentcontract read <id>               Print rendered contract text. Works for local contract ids and agr_* ids
  agentcontract contract edit <id>      Open a contract markdown file in $EDITOR
  agentcontract agreement read <id>     Print a sent agreement's markdown from the API

Sender / Receiver:
  --from, --from-email, --sender-email <email>
                                      Human sender. Receives sender signing link and default completion notification
  --sender-name <name>               Human sender name shown in request and sender signing emails
  --to, --email, --receiver-email    Recipient email
  --name, --receiver-name <name>     Recipient name
  --cc <email[,email]>               CC the signing request email
  --notify, --notify-email <email[,email]>
                                      Override who gets emailed when all required parties sign

Options:
  --api-url <url>                    API base URL. Defaults to AGENTCONTRACT_API_URL or ${defaultApiUrl}
  --api-key <key>                    API key. Defaults to AGENTCONTRACT_API_KEY or AGENTSIGN_API_KEY
  --api-key-stdin                    Read API key from stdin for init/send commands
  --key-name <name>                  Name for a key created by login. Defaults to AgentContract CLI
  --email <email>                    Use email-code login instead of browser login
  --code <123456>                    Login code for email-code login. Omit to type it interactively
  --timeout-ms <ms>                  Login callback timeout. Defaults to 300000
  --webhook-url <url>                Machine webhook for agreement.completed
  --email-domain <domain>            Email domain for first-party sending, for example acme.com
  --signing-domain <domain>          Signing CNAME, for example contracts.acme.com
  --template <name>                  Template for send-contract/preview: nda, privacy, contractor
  --var <key=value>                  Template variable. Repeatable
  --vars-json <json>                 Template variables as JSON
  --vars-file <path>                 Template variables JSON file
  --markdown-file <path>             Custom markdown contract file
  --pdf-file <path>                  Upload an existing PDF and wrap it in the signing flow
  --title, --document-title <text>   Title for a custom markdown or uploaded PDF agreement
  --markdown-stdin                   Read custom contract markdown from stdin
  --fields-json <json>               JSON field definitions array
  --fields-file <path>               JSON field definitions file
  --note, --feedback <text>          Add feedback to a local contract review thread
  --feedback-file <path>             Read contract feedback text from a file
  --feedback-stdin                   Read contract feedback text from stdin
  --message <text>                   Product feedback message for agentcontract feedback
  --command, --cmd <text>            Command that broke for agentcontract feedback
  --expected <text>                  Expected result for product feedback
  --actual <text>                    Actual result or error for product feedback
  --category <name>                  Feedback area: install, login, cli, sending, signing, docs
  --severity <level>                 Feedback severity: note, low, normal, high, blocker
  --reporter-email <email>           Reporter email for unauthenticated feedback
  --reporter-name <name>             Reporter name for feedback
  --prompt, --goal <text>             Explicit agent/user goal saved with a sent agreement or failed run
  --chat-summary <text>               Short summary saved with a sent agreement
  --reason-sent <text>                Why this contract was sent
  --approval-message <text>           User approval message before sending
  --agent <name>                      Agent name for failure reporting, for example codex or claude
  --no-telemetry                     Skip best-effort failed-run reporting for this invocation
  --with-feedback                    Include feedback when reading/showing a contract
  --author <name>                    Human or agent name for contract feedback
  --from-template <name>             Seed contract add from built-in: nda, privacy, contractor
  --contract-dir <path>              Override local contract library directory for this command
  --directory <path>                 Install skill into this skills directory
  --editor <command>                 Editor used by contract edit. Defaults to VISUAL or EDITOR
  --no-open                          Print auth/dashboard URL instead of opening a browser
  --force                            Overwrite existing local config or contract copy when supported
  --preview                          Render local HTML preview instead of sending
  --preview-file <path>              Where to write preview HTML
  --out, --output-file <path>        Write text/PDF output to a file
  --open                             Open preview/signing URL in the browser
  --scope <text>                     Legacy contractor scope override for custom templates
  --rate <amount>                    Legacy contractor rate override for custom templates
  --start-date <date>                Legacy contractor start date override for custom templates
  --effective-date <date>            Defaults to today, except Acme privacy defaults to April 29, 2026
  --term-years <years>               MNDA term. Defaults to 2
  --website <url>                    Legacy privacy override. Acme template hardcodes example.com
  --contact <email>                  Legacy privacy override. Acme template hardcodes you@example.com
  --address <text>                   Legacy privacy override. Acme template hardcodes 123 Market Street
  --dry-run                          Print the request without sending it
  --json                             Print raw JSON only
  --show-secrets                     Show saved API key in config output
  --check                            Check for updates without installing
  --remind-recipient, --remind-others
                                      Send a reminder to the recipient / everyone else
  --remind-self, --remind-sender     Send a reminder to the sender's own signing link
  --remind-all                       Send reminder emails to all signing parties
  --yes                              Skip update prompts and confirm noninteractive bulk/reminder-all emails
  --no-auto-update                   Skip the automatic pre-command update check
  --package-manager <npm|pnpm|yarn|bun>
                                      Use a package manager for agentcontract update instead of hosted installer
  --registry <url>                   npm registry for package-manager update checks
  --version                          Print CLI version

Environment:
  AGENTCONTRACT_API_URL, AGENTCONTRACT_API_KEY, AGENTCONTRACT_SENDER_EMAIL, AGENTCONTRACT_SENDER_NAME, AGENTCONTRACT_NOTIFY_EMAIL, AGENTCONTRACT_CONFIG
  AGENTCONTRACT_AUTO_UPDATE=0 disables automatic CLI update checks
  AGENTCONTRACT_AGENT names the local agent in failure reports
  AGENTCONTRACT_TELEMETRY=0 disables best-effort failed-run reporting
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

function cleanString(value: unknown, maxLength = 10_000) {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
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

function listArg(args: Args, ...keys: string[]) {
  const values = keys.flatMap((key) => {
    const value = args[key];
    if (!value || value === true) return [];
    return Array.isArray(value) ? value : [value];
  });
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
      "API key missing. Run agentcontract login --email you@example.com, set AGENTCONTRACT_API_KEY, or pass --api-key-stdin.",
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
    { id: "company_entity", label: "Company / Entity (if applicable)", type: "text" },
    { id: "title", label: "Title", type: "text" },
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
    { id: "acknowledgement_date", label: "Acknowledgement date", type: "date", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ];
}

function pdfFields() {
  return [
    { id: "full_name", label: "Full legal name", type: "text", required: true },
    { id: "signature", label: "Signature", type: "signature", required: true }
  ];
}

function defaultFieldsFor(template: string | undefined) {
  if (template === "pdf") return pdfFields();
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

async function postPublicJson(apiUrl: string, path: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal
  });
  clearTimeout(timeout);

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new CliError(result.error ?? `HTTP ${response.status}`);
  return result;
}

async function postMaybeAuthJson(apiUrl: string, apiKey: string | undefined, path: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers,
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

async function downloadBinary(apiUrl: string, apiKey: string, path: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new CliError(result.error ?? `HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function dryRun(args: Args) {
  return Boolean(args["dry-run"]);
}

function jsonOutput(args: Args) {
  return Boolean(args.json) || stringArg(args, "output") === "json";
}

function normalizeReminderTarget(value: string | undefined): ReminderTarget | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!normalized) return undefined;
  if (["recipient", "recipients", "other", "others", "everyone-else", "counterparty", "counterparties"].includes(normalized)) return "recipient" as const;
  if (["sender", "self", "me", "myself"].includes(normalized)) return "sender" as const;
  if (["all", "both", "everyone", "all-signers"].includes(normalized)) return "all" as const;
  throw new CliError(
    `Unknown reminder target: ${value}`,
    "Use --remind-recipient, --remind-self, --remind-all, or --target recipient|sender|all."
  );
}

function reminderTargetFromArgs(args: Args): ReminderTarget | undefined {
  const candidates: ReminderTarget[] = [];
  const targetArg = normalizeReminderTarget(stringArg(args, "target", "reminder-target", "remind-target", "to-role"));
  if (targetArg) candidates.push(targetArg);
  if (args["remind-recipient"] || args["to-recipient"] || args.recipient || args["remind-others"] || args["to-others"] || args["everyone-else"]) {
    candidates.push("recipient");
  }
  if (args["remind-self"] || args["to-self"] || args.self || args["remind-sender"] || args["to-sender"] || args.sender) {
    candidates.push("sender");
  }
  if (args["remind-all"] || args["to-all"] || args.all || args.both) {
    candidates.push("all");
  }

  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw new CliError(
      "Choose one reminder target.",
      "Use exactly one of --remind-recipient, --remind-self, or --remind-all."
    );
  }
  return unique[0];
}

async function promptReminderTarget(args: Args, apiUrl: string, apiKey: string, id: string): Promise<ReminderTarget> {
  const explicit = reminderTargetFromArgs(args);
  if (explicit) return explicit;

  if (!process.stdin.isTTY || jsonOutput(args)) {
    throw new CliError(
      "Reminder target confirmation required.",
      "Choose who should receive the reminder: --remind-self for your own signing link, --remind-recipient for everyone else, or --remind-all."
    );
  }

  const detail = await getJson(apiUrl, apiKey, `/v1/agreements/${id}`) as {
    recipient?: { name?: string; email?: string };
    metadata?: { sender_email?: unknown; sender_name?: unknown };
  };
  const recipient = detail.recipient?.email
    ? `${detail.recipient.name ?? "Recipient"} <${detail.recipient.email}>`
    : "recipient / everyone else";
  const senderEmail = typeof detail.metadata?.sender_email === "string" ? detail.metadata.sender_email : "";
  const senderName = typeof detail.metadata?.sender_name === "string" ? detail.metadata.sender_name : "";
  const sender = senderEmail ? `${senderName || "Sender"} <${senderEmail}>` : "sender / yourself";

  console.log(`Who should receive the reminder email for ${id}?`);
  console.log(`  recipient: ${recipient}`);
  console.log(`  sender: ${sender}`);
  console.log("  all: all signing parties");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Reminder target [recipient/sender/all/cancel]: ")).trim().toLowerCase();
    if (!answer || answer === "cancel" || answer === "c" || answer === "no" || answer === "n") {
      throw new CliError("Reminder cancelled.");
    }
    const target = normalizeReminderTarget(answer);
    if (!target) throw new CliError("Reminder cancelled.");
    return target;
  } finally {
    rl.close();
  }
}

async function confirmMassEmail(args: Args, command: string, recipientCount: number, label = "emails"): Promise<boolean> {
  if (recipientCount <= 1 || dryRun(args) || args.preview) return true;
  if (args.yes) return true;

  const hint = `Review with ${command} --dry-run --json, then rerun with --yes only after the user explicitly confirms sending ${recipientCount} ${label}.`;
  if (!process.stdin.isTTY || jsonOutput(args)) {
    throw new CliError("Bulk email confirmation required.", hint);
  }

  const phrase = `SEND ${recipientCount}`;
  console.log(`${command} will send ${recipientCount} ${label}.`);
  console.log(`Type ${phrase} to confirm.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Confirm mass email: ")).trim();
    return answer === phrase;
  } finally {
    rl.close();
  }
}

function telemetryDisabled(args: Args) {
  const value = cleanString(process.env.AGENTCONTRACT_TELEMETRY)?.toLowerCase();
  return Boolean(args["no-telemetry"] || value === "0" || value === "false" || value === "off" || value === "no");
}

function sessionId(args: Args) {
  return cleanString(stringArg(args, "session-id", "agent-session-id"))
    ?? cleanString(process.env.AGENTCONTRACT_SESSION_ID)
    ?? cleanString(process.env.AGENTCONTRACT_AGENT_SESSION_ID);
}

function agentName(args: Args) {
  return cleanString(stringArg(args, "agent"))
    ?? cleanString(process.env.AGENTCONTRACT_AGENT)
    ?? cleanString(process.env.CURSOR_TRACE_ID ? "cursor" : undefined)
    ?? cleanString(process.env.CODEX_HOME ? "codex" : undefined);
}

function sha256Short(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function sanitizedArgv(argv: string[]) {
  const sensitive = new Set(["api-key", "webhook-secret", "secret", "token", "password"]);
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result.push(item);
      continue;
    }
    const raw = item.slice(2);
    const [key] = raw.split("=", 1);
    if (sensitive.has(key)) {
      result.push(item.includes("=") ? `--${key}=REDACTED` : `--${key}`);
      if (!item.includes("=") && argv[index + 1] && !argv[index + 1].startsWith("--")) {
        result.push("REDACTED");
        index += 1;
      }
      continue;
    }
    result.push(item);
  }
  return result;
}

function commandText(argv: string[]) {
  return ["agentcontract", ...argv].map(shellQuote).join(" ");
}

function readMaybeJsonFile(path: string, label: string) {
  const text = readTextFile(path, label);
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    return { json: undefined, text };
  }
}

function contextFromArgs(args: Args) {
  const contextFile = cleanString(stringArg(args, "chat-context-file", "context-file"))
    ?? cleanString(process.env.AGENTCONTRACT_CHAT_CONTEXT_FILE)
    ?? cleanString(process.env.AGENTCONTRACT_CONTEXT_FILE);
  const prompt = cleanString(stringArg(args, "prompt", "goal", "initial-goal"));
  const chatSummary = cleanString(stringArg(args, "chat-summary", "summary"))
    ?? cleanString(process.env.AGENTCONTRACT_CHAT_SUMMARY);
  const reasonSent = cleanString(stringArg(args, "reason-sent", "reason"));
  const approvalMessage = cleanString(stringArg(args, "approval-message", "approval"));

  let contextJson: unknown;
  let contextText: string | undefined;
  if (contextFile) {
    const parsed = readMaybeJsonFile(contextFile, "--chat-context-file");
    contextJson = parsed.json;
    contextText = parsed.text;
  }

  const contextObject = contextJson && typeof contextJson === "object" && !Array.isArray(contextJson)
    ? contextJson as Record<string, unknown>
    : {};
  const summaryFromContext = typeof contextObject.chat_summary === "string"
    ? contextObject.chat_summary
    : typeof contextObject.summary === "string"
      ? contextObject.summary
      : typeof contextObject.prompt === "string"
        ? contextObject.prompt
        : typeof contextObject.goal === "string"
          ? contextObject.goal
          : undefined;
  const promptText = prompt ?? chatSummary ?? summaryFromContext;

  const metadata: Record<string, unknown> = {
    agent: agentName(args) ?? contextObject.agent ?? null,
    ...(promptText ? { prompt: promptText } : {})
  };
  if (contextFile) metadata.context_file_sha256 = sha256Short(contextText ?? "");

  const payload = {
    source: cleanString(String(contextObject.source ?? contextObject.agent ?? agentName(args) ?? "agentcontract-cli"), 80),
    reason_sent: reasonSent ?? cleanString(contextObject.reason_sent as string | undefined) ?? cleanString(contextObject.reason as string | undefined),
    approval_message: approvalMessage ?? cleanString(contextObject.approval_message as string | undefined),
    chat_summary: promptText,
    metadata
  };

  const hasContext = Boolean(
    payload.reason_sent
    || payload.approval_message
    || payload.chat_summary
  );
  return hasContext ? payload : undefined;
}

function promptFromArgs(args: Args) {
  const context = contextFromArgs(args);
  return context?.chat_summary
    ?? context?.reason_sent
    ?? cleanString(stringArg(args, "goal", "initial-goal"))
    ?? undefined;
}

function attachAgreementTelemetry(args: Args, payload: AgreementPayload) {
  const agent = agentName(args);
  const context = contextFromArgs(args);
  return {
    ...payload,
    ...(context ? { agreement_context: context } : {}),
    metadata: {
      ...(payload.metadata ?? {}),
      ...(agent ? { agent } : {})
    }
  };
}

async function postAgreementJson(apiUrl: string, apiKey: string, path: string, body: AgreementPayload, args: Args, command: string) {
  void command;
  return postJson(apiUrl, apiKey, path, attachAgreementTelemetry(args, body));
}

function agreementDryRunResult(command: string, apiUrl: string, path: string, body: AgreementPayload, args: Args) {
  return dryRunResult(command, apiUrl, path, attachAgreementTelemetry(args, body));
}

function agreementIdsFromResult(result: unknown) {
  if (typeof result !== "object" || !result) return [];
  if ("id" in result && typeof (result as { id?: unknown }).id === "string") return [(result as { id: string }).id];
  if ("agreements" in result && Array.isArray((result as { agreements?: unknown }).agreements)) {
    return (result as { agreements: Array<{ id?: unknown }> }).agreements
      .map((agreement) => typeof agreement.id === "string" ? agreement.id : null)
      .filter((id): id is string => Boolean(id));
  }
  return [];
}

function cliErrorFingerprint(error: unknown) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return sha256Short(`${name}:${message.replace(/\s+/g, " ").toLowerCase()}`);
}

async function recordCliTelemetry(exitCode: number, result?: unknown, error?: unknown) {
  if (exitCode === 0) return;
  const telemetry = activeCliTelemetry;
  if (!telemetry || telemetryDisabled(telemetry.args)) return;
  const { apiUrl, apiKey } = apiConfig(telemetry.args, false);
  if (!apiKey) return;

  const agreementIds = agreementIdsFromResult(result);
  const argv = sanitizedArgv(telemetry.argv);
  const prompt = promptFromArgs(telemetry.args);
  const payload = {
    id: telemetry.id,
    agreement_id: agreementIds[0],
    command: commandText(argv),
    argv,
    started_at: telemetry.startedAt,
    ended_at: new Date().toISOString(),
    duration_ms: Date.now() - telemetry.startedMs,
    exit_code: exitCode,
    success: exitCode === 0,
    error_name: error instanceof Error ? error.name : error ? "Error" : undefined,
    error_message: error instanceof Error ? error.message : error ? String(error) : undefined,
    error_fingerprint: error ? cliErrorFingerprint(error) : undefined,
    cli_version: cliVersion,
    package_name: packageName,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd_hash: sha256Short(process.cwd()),
    agreement_ids: agreementIds,
    prompt,
    metadata: {
      agent: agentName(telemetry.args) ?? null,
      ...(prompt ? { prompt } : {}),
      config_loaded: !configLoadError,
      json_output: jsonOutput(telemetry.args),
      dry_run: dryRun(telemetry.args)
    }
  };

  await postJson(apiUrl, apiKey, "/v1/cli-runs", payload).catch(() => undefined);
}

function senderEmail(args: Args) {
  const value = cleanString(stringArg(args, "from", "from-email", "sender-email"))
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
    'Example: agentcontract send-mnda --from legal@example.com --to jane@example.com --name "Jane Doe" --company "Acme Inc."'
  );
}

function receiverEmail(args: Args) {
  const email = requireArg(
    stringArg(args, "to", "email", "receiver-email"),
    "--to / --email / --receiver-email",
    'Example: agentcontract send-privacy --from legal@example.com --to jane@example.com --name "Jane Doe"'
  );
  return validateEmail(email, "--to / receiver email");
}

function notificationArgs(args: Args, defaultEmail?: string) {
  const notify = listArg(args, "notify", "notify-email", "notification-email");
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

function withDemoDefaults(args: Args): Args {
  return {
    ...args,
    from: stringArg(args, "from", "from-email", "sender-email") ?? demoDefaults.senderEmail,
    "sender-name": stringArg(args, "sender-name") ?? demoDefaults.senderName,
    company: stringArg(args, "company") ?? demoDefaults.companyName,
    website: stringArg(args, "website") ?? demoDefaults.websiteUrl,
    contact: stringArg(args, "contact") ?? demoDefaults.contactEmail,
    address: stringArg(args, "address") ?? demoDefaults.companyAddress,
    "terms-name": stringArg(args, "terms-name") ?? demoDefaults.termsName,
    "data-use-policy-name": stringArg(args, "data-use-policy-name") ?? demoDefaults.dataUsePolicyName
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

function readBinaryFile(path: string, label: string) {
  try {
    return readFileSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`${label} could not be read: ${message}`);
  }
}

function cleanPdfFilename(path: string) {
  const filename = basename(path).trim() || "uploaded-document.pdf";
  return filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`;
}

function titleFromPdfPath(path: string) {
  const filename = cleanPdfFilename(path);
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  return stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Uploaded PDF Agreement";
}

function pdfFileFromArgs(args: Args, positional: string[] = []) {
  return stringArg(args, "pdf-file", "pdf", "document-pdf") ?? positional[0];
}

function pdfDocumentFromFile(path: string) {
  const buffer = readBinaryFile(path, "--pdf-file");
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new CliError("--pdf-file must point to a PDF file");
  }
  return {
    base64: buffer.toString("base64"),
    filename: cleanPdfFilename(path),
    title: titleFromPdfPath(path)
  };
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
  const fieldsJson = stringArg(args, "fields-json");
  if (fieldsJson) {
    const parsed = parseJsonArg(fieldsJson, "--fields-json") as unknown;
    if (!Array.isArray(parsed)) throw new CliError("--fields-json must be a JSON array of field definitions");
    return parsed as Array<Record<string, unknown>>;
  }
  const fieldsFile = stringArg(args, "fields-file");
  if (!fieldsFile) return fallback;
  const parsed = parseJsonFile(fieldsFile, "--fields-file") as unknown;
  if (!Array.isArray(parsed)) throw new CliError("--fields-file must contain a JSON array of field definitions");
  return parsed as Array<Record<string, unknown>>;
}

function markdownFromArgs(args: Args) {
  const cached = args.__markdown_content;
  if (typeof cached === "string") return cached;
  if (args["markdown-stdin"]) {
    const markdown = readFileSync(0, "utf8");
    args.__markdown_content = markdown;
    return markdown;
  }
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
  document_pdf_base64?: string;
  document_pdf_filename?: string;
  document_title?: string;
  template_vars?: Record<string, unknown>;
  fields?: Array<Record<string, unknown>>;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
  session_id?: string;
  cli_run_id?: string;
  agreement_context?: Record<string, unknown>;
};

function withCustomContractArgs(args: Args, payload: AgreementPayload) {
  const templateOverride = stringArg(args, "template");
  const markdown = markdownFromArgs(args);
  const pdfFile = pdfFileFromArgs(args);
  const pdf = pdfFile ? pdfDocumentFromFile(pdfFile) : null;
  const template = markdown ? undefined : templateOverride ?? payload.template;
  const fallbackFields = payload.fields ?? defaultFieldsFor(pdf ? "pdf" : template);
  const customized: AgreementPayload = {
    ...payload,
    ...(template && !pdf ? { template } : {}),
    ...(markdown && !pdf ? { document_markdown: markdown } : {}),
    ...(pdf ? {
      document_pdf_base64: pdf.base64,
      document_pdf_filename: pdf.filename,
      document_title: stringArg(args, "title", "document-title") ?? pdf.title
    } : {}),
    template_vars: {
      ...(payload.template_vars ?? {}),
      ...templateVarsFromArgs(args)
    },
    fields: fieldsFromArgs(args, fallbackFields)
  };
  if (markdown || pdf) delete customized.template;
  if (pdf) {
    delete customized.document_markdown;
    delete customized.template_vars;
    customized.metadata = {
      ...(customized.metadata ?? {}),
      workflow: "byo_pdf",
      document_pdf_filename: pdf.filename
    };
  }
  return customized;
}

function baseMndaPayload(args: Args) {
  const company = stringArg(args, "company") ?? String(defaultTemplateVars(templateDefinitions.nda).company_name ?? demoDefaults.companyName);
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template: "nda",
    template_vars: {
      company_name: company
    },
    fields: mndaFields(),
    metadata: { source: "agentcontract-cli" }
  });
}

function basePrivacyPayload(args: Args) {
  const company = stringArg(args, "company") ?? demoMarketplaceDefaults.companyName;
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template: "privacy",
    template_vars: {
      effective_date: stringArg(args, "effective-date") ?? demoMarketplaceDefaults.effectiveDate
    },
    fields: privacyFields(),
    metadata: { source: "agentcontract-cli", template_kind: "privacy_policy", company }
  });
}

function baseContractPayload(args: Args) {
  const markdown = markdownFromArgs(args);
  const template = stringArg(args, "template") ?? (markdown ? undefined : "contractor");
  if (!template && !markdown) {
    throw new CliError("send-contract needs --template or --markdown-file");
  }
  const vars = templateVarsFromArgs(args);
  const definition = template ? templateDefinitions[template as keyof typeof templateDefinitions] : undefined;
  const defaultVars = definition ? defaultTemplateVars(definition) : {};
  const company = stringArg(args, "company") ?? String(vars.company_name ?? defaultVars.company_name ?? "Acme Inc.");
  return withCustomContractArgs(args, {
    ...sharedSendOptions(args, company),
    template,
    template_vars: {
      ...defaultVars,
      company_name: company,
      effective_date: stringArg(args, "effective-date") ?? defaultVars.effective_date ?? today(),
      ...vars
    },
    fields: defaultFieldsFor(template),
    metadata: { source: "agentcontract-cli", template_kind: template ?? "custom_markdown" }
  });
}

function baseDemoNdaPayload(args: Args) {
  const demoArgs = withDemoDefaults(args);
  const payload = baseMndaPayload(demoArgs);
  return {
    ...payload,
    metadata: { ...(payload.metadata ?? {}), workflow: "demo_nda", company: demoDefaults.companyName }
  };
}

function baseDemoPrivacyPayload(args: Args) {
  const specificArgs = {
    ...args,
    from: stringArg(args, "from", "from-email", "sender-email") ?? demoMarketplaceDefaults.senderEmail,
    "sender-name": stringArg(args, "sender-name") ?? demoMarketplaceDefaults.senderName
  };
  const payload = basePrivacyPayload(specificArgs);
  return {
    ...payload,
    metadata: { ...(payload.metadata ?? {}), workflow: "privacy_acknowledgement", company: demoMarketplaceDefaults.companyName }
  };
}

function baseDemoContractorPayload(args: Args) {
  const specificArgs = {
    ...args,
    from: stringArg(args, "from", "from-email", "sender-email") ?? demoMarketplaceDefaults.senderEmail,
    "sender-name": stringArg(args, "sender-name") ?? demoMarketplaceDefaults.senderName
  };
  const vars = templateVarsFromArgs(args);
  const defaults = defaultTemplateVars(templateDefinitions.contractor);

  return withCustomContractArgs(specificArgs, {
    ...sharedSendOptions(specificArgs, demoMarketplaceDefaults.senderName),
    template: "contractor",
    template_vars: {
      ...defaults,
      effective_date: stringArg(args, "effective-date") ?? defaults.effective_date,
      ...vars
    },
    fields: contractorFields(),
    metadata: {
      source: "agentcontract-cli",
      workflow: "contractor_terms",
      company: demoMarketplaceDefaults.companyName
    }
  });
}

function previewHtmlFor(payload: AgreementPayload) {
  if (payload.document_pdf_base64) {
    const title = payload.document_title ?? payload.document_pdf_filename ?? "Uploaded PDF Agreement";
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} | AgentContract Preview</title>
  <style>
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(100% - 32px, 960px); margin: 32px auto; }
    header { margin-bottom: 16px; color: #475569; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    iframe { display: block; width: 100%; min-height: 78vh; border: 1px solid #cbd5e1; border-radius: 8px; background: white; }
  </style>
</head>
<body><main><header>AgentContract PDF preview</header><iframe title="${escapeHtml(title)}" src="data:application/pdf;base64,${payload.document_pdf_base64}"></iframe></main></body>
</html>`;
  }

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
  return {
    preview: true,
    path: output,
    opened: Boolean(args.open),
    title: payload.document_pdf_base64
      ? payload.document_title ?? payload.document_pdf_filename
      : titleFromMarkdown(applyTemplateVars(payload.document_markdown ?? loadTemplate(payload.template ?? "nda"), payload.template_vars ?? {}))
  };
}

function writeTextOutput(text: string, args: Args, title?: string) {
  const outputArg = stringArg(args, "out", "output-file", "output");
  if (!outputArg) return { text_output: true, title, text };
  const output = resolve(outputArg);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, text);
  if (args.open) openTarget(output);
  return { text_output: true, title, path: output, opened: Boolean(args.open), bytes: Buffer.byteLength(text) };
}

function writeBinaryOutput(data: Buffer, args: Args, defaultFilename: string) {
  const output = resolve(stringArg(args, "out", "output-file", "output") ?? defaultFilename);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, data);
  if (args.open) openTarget(output);
  return { file_output: true, path: output, opened: Boolean(args.open), bytes: data.byteLength };
}

function openTarget(target: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error) throw new CliError(`Could not open ${target}: ${result.error.message}`);
}

function shellQuote(value: string) {
  if (/^[a-zA-Z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseVersion(version: string) {
  const [core] = version.replace(/^v/, "").split(/[+-]/);
  return core.split(".").map((part) => {
    const number = Number.parseInt(part.replace(/\D.*$/, ""), 10);
    return Number.isFinite(number) ? number : 0;
  });
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function npmPackageUrl(registry: string) {
  const base = registry.replace(/\/+$/, "");
  return `${base}/${packageName.replace("/", "%2F")}/latest`;
}

function usePackageManagerUpdate(args: Args) {
  return Boolean(stringArg(args, "package-manager", "pm") || stringArg(args, "registry"));
}

function packageManagerForUpdate(args: Args) {
  const explicit = cleanString(stringArg(args, "package-manager", "pm"));
  if (explicit) return explicit;

  const userAgent = process.env.npm_config_user_agent?.toLowerCase() ?? "";
  if (userAgent.startsWith("pnpm/")) return "pnpm";
  if (userAgent.startsWith("yarn/")) return "yarn";
  if (userAgent.startsWith("bun/")) return "bun";
  return "npm";
}

function updateCommand(args: Args, targetVersion = "latest") {
  const packageSpec = `${packageName}@${targetVersion}`;
  const manager = packageManagerForUpdate(args);
  if (manager === "npm") return { manager, command: "npm", args: ["install", "-g", packageSpec] };
  if (manager === "pnpm") return { manager, command: "pnpm", args: ["add", "-g", packageSpec] };
  if (manager === "yarn") return { manager, command: "yarn", args: ["global", "add", packageSpec] };
  if (manager === "bun") return { manager, command: "bun", args: ["add", "-g", packageSpec] };
  throw new CliError(`Unsupported package manager: ${manager}`, "Use --package-manager npm, pnpm, yarn, or bun.");
}

function hostedUpdateCommand(args: Args) {
  const { apiUrl } = apiConfig(args, false);
  const scriptUrl = `${apiUrl}/cli/install.sh`;
  return {
    manager: "hosted-installer",
    command: "bash",
    args: ["-lc", `curl -fsSL ${shellQuote(scriptUrl)} | bash`],
    installCommand: `curl -fsSL ${shellQuote(scriptUrl)} | bash`,
    installer_url: scriptUrl
  };
}

function installCommandForUpdate(args: Args) {
  if (!usePackageManagerUpdate(args)) return hostedUpdateCommand(args);
  const install = updateCommand(args, "latest");
  return {
    ...install,
    installCommand: [install.command, ...install.args].map(shellQuote).join(" "),
    installer_url: null
  };
}

async function latestVersionForUpdate(args: Args) {
  const override = cleanString(stringArg(args, "latest-version"));
  if (override) return { latestVersion: override, registryUrl: null, source: "override" };

  if (!usePackageManagerUpdate(args)) {
    const { apiUrl } = apiConfig(args, false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${apiUrl}/healthz`, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new CliError(`Could not check hosted CLI version: ${response.status} ${response.statusText}`);
      const latestVersion = typeof result.version === "string" ? result.version : "";
      if (!latestVersion) throw new CliError("Hosted AgentContract response did not include a version");
      return { latestVersion, registryUrl: null, source: "hosted" };
    } catch (error) {
      if (error instanceof CliError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`Could not check hosted CLI version: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  const registry = cleanString(stringArg(args, "registry")) ?? cleanString(process.env.NPM_CONFIG_REGISTRY) ?? "https://registry.npmjs.org";
  const registryUrl = npmPackageUrl(registry);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(registryUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new CliError(`Could not check npm for updates: ${response.status} ${response.statusText}`);
    const latestVersion = typeof result.version === "string" ? result.version : "";
    if (!latestVersion) throw new CliError("npm registry response did not include a version");
    return { latestVersion, registryUrl, source: "npm" };
  } catch (error) {
    if (error instanceof CliError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not check npm for updates: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function updateCheck(args: Args) {
  const { latestVersion, registryUrl, source } = await latestVersionForUpdate(args);
  const updateAvailable = compareVersions(latestVersion, cliVersion) > 0;
  const install = installCommandForUpdate(args);
  return {
    update_check: true,
    package: packageName,
    current_version: cliVersion,
    latest_version: latestVersion,
    update_available: updateAvailable,
    update_source: source,
    registry_url: registryUrl,
    installer_url: install.installer_url,
    install_command: install.installCommand
  };
}

async function confirmUpdateInstall(args: Args, commandText: string) {
  if (args.yes || args.force) return true;
  if (!process.stdin.isTTY || jsonOutput(args)) {
    throw new CliError("Use --yes to run the updater non-interactively.", `Run agentcontract update --yes or run ${commandText}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Run ${commandText}? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function updateCli(args: Args) {
  const check = await updateCheck(args);
  if (args.check) return check;

  if (!check.update_available && !args.force) {
    return { ...check, updated: false, already_latest: true };
  }

  const install = installCommandForUpdate(args);
  const installCommand = install.installCommand;
  if (dryRun(args)) return { ...check, dry_run: true, updated: false, command: installCommand };

  const confirmed = await confirmUpdateInstall(args, installCommand);
  if (!confirmed) return { ...check, updated: false, cancelled: true };

  const result = spawnSync(install.command, install.args, {
    stdio: jsonOutput(args) ? "pipe" : "inherit",
    encoding: "utf8"
  });
  if (result.error) throw new CliError(`Update failed: ${result.error.message}`, installCommand);
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new CliError(`Update failed with exit code ${result.status}${stderr ? `: ${stderr}` : ""}`, installCommand);
  }

  return { ...check, updated: true, command: installCommand };
}

function autoUpdateEnvDisabled() {
  const value = cleanString(process.env.AGENTCONTRACT_AUTO_UPDATE)?.toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

function autoUpdateIntervalMs() {
  const hours = Number(process.env.AGENTCONTRACT_AUTO_UPDATE_INTERVAL_HOURS ?? 24);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

function loadAutoUpdateState(): AutoUpdateState {
  if (!existsSync(autoUpdateStatePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(autoUpdateStatePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as AutoUpdateState : {};
  } catch {
    return {};
  }
}

function writeAutoUpdateState(state: AutoUpdateState) {
  try {
    mkdirSync(dirname(autoUpdateStatePath), { recursive: true, mode: 0o700 });
    writeFileSync(`${autoUpdateStatePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(`${autoUpdateStatePath}.tmp`, 0o600);
    renameSync(`${autoUpdateStatePath}.tmp`, autoUpdateStatePath);
    chmodSync(autoUpdateStatePath, 0o600);
  } catch {
    // Auto-update state is best-effort and should never block a contract command.
  }
}

function isFreshAutoUpdateState(state: AutoUpdateState, apiUrl: string) {
  if (state.api_url !== apiUrl || state.current_version !== cliVersion || state.update_available) return false;
  const checkedAt = state.last_checked_at ? Date.parse(state.last_checked_at) : Number.NaN;
  return Number.isFinite(checkedAt) && Date.now() - checkedAt < autoUpdateIntervalMs();
}

function isLocalCheckoutRun() {
  if (process.env.AGENTCONTRACT_AUTO_UPDATE_LOCAL === "1") return false;
  const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
  const cwd = resolve(process.cwd());
  return entrypoint.startsWith(join(cwd, "dist"))
    || entrypoint.startsWith(join(cwd, "src"));
}

function shouldAutoUpdate(command: string, args: Args) {
  if (process.env.AGENTCONTRACT_SKIP_AUTO_UPDATE === "1") return false;
  if (autoUpdateEnvDisabled() || args["no-auto-update"] || args["no-update"]) return false;
  if (dryRun(args) || args.preview) return false;
  if (isLocalCheckoutRun()) return false;

  const skipped = new Set(["help", "--help", "-h", "version", "--version", "-v", "update", "upgrade", "self-update", "feedback", "bug", "report"]);
  return !skipped.has(command);
}

function warnAutoUpdate(message: string, args: Args) {
  if (!jsonOutput(args)) console.error(message);
}

async function autoUpdateAndMaybeRerun(command: string, args: Args, originalArgv: string[]) {
  if (!shouldAutoUpdate(command, args)) return;

  const { apiUrl } = apiConfig(args, false);
  const state = loadAutoUpdateState();
  if (isFreshAutoUpdateState(state, apiUrl)) return;

  let check: Awaited<ReturnType<typeof updateCheck>>;
  try {
    check = await updateCheck(args);
    writeAutoUpdateState({
      api_url: apiUrl,
      current_version: cliVersion,
      latest_version: check.latest_version,
      update_available: check.update_available,
      last_checked_at: new Date().toISOString()
    });
  } catch (error) {
    writeAutoUpdateState({
      ...state,
      api_url: apiUrl,
      current_version: cliVersion,
      last_error: error instanceof Error ? error.message : String(error),
      last_error_at: new Date().toISOString()
    });
    warnAutoUpdate(`AgentContract auto-update check failed; continuing with ${cliVersion}.`, args);
    return;
  }

  if (!check.update_available) return;

  const install = installCommandForUpdate(args);
  warnAutoUpdate(`AgentContract ${check.latest_version} is available. Auto-updating before running ${command}...`, args);

  const update = spawnSync(install.command, install.args, {
    stdio: jsonOutput(args) ? "pipe" : "inherit",
    encoding: "utf8"
  });
  if (update.error || update.status !== 0) {
    const detail = update.error?.message ?? (typeof update.stderr === "string" ? update.stderr.trim() : "");
    writeAutoUpdateState({
      api_url: apiUrl,
      current_version: cliVersion,
      latest_version: check.latest_version,
      update_available: true,
      last_checked_at: new Date().toISOString(),
      last_error: detail || `installer exited with ${update.status}`,
      last_error_at: new Date().toISOString()
    });
    warnAutoUpdate(`AgentContract auto-update failed; continuing with ${cliVersion}. Run: ${install.installCommand}`, args);
    return;
  }

  writeAutoUpdateState({
    api_url: apiUrl,
    current_version: check.latest_version,
    latest_version: check.latest_version,
    update_available: false,
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const entrypoint = process.argv[1];
  if (!entrypoint) return;
  warnAutoUpdate("AgentContract updated. Restarting the command with the new CLI...", args);
  const rerun = spawnSync(process.argv[0], [entrypoint, ...originalArgv], {
    stdio: "inherit",
    env: { ...process.env, AGENTCONTRACT_SKIP_AUTO_UPDATE: "1" },
    encoding: "utf8"
  });
  if (rerun.error) {
    warnAutoUpdate(`AgentContract updated, but command restart failed: ${rerun.error.message}`, args);
    return;
  }
  process.exit(rerun.status ?? 0);
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

  if (typeof result === "object" && result && "dry_run" in result && "payload" in result) {
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

  if (typeof result === "object" && result && "text_output" in result) {
    const text = result as unknown as { title?: string; text?: string; path?: string; opened?: boolean; bytes?: number };
    if (text.path) {
      console.log(`Wrote text: ${text.path}`);
      if (text.bytes !== undefined) console.log(`Bytes: ${text.bytes}`);
      if (text.opened) console.log("Opened");
    } else {
      console.log(text.text ?? "");
    }
    return;
  }

  if (typeof result === "object" && result && "file_output" in result) {
    const file = result as unknown as { path: string; opened?: boolean; bytes?: number };
    console.log(`Wrote file: ${file.path}`);
    if (file.bytes !== undefined) console.log(`Bytes: ${file.bytes}`);
    if (file.opened) console.log("Opened");
    return;
  }

  if (typeof result === "object" && result && "dashboard_url" in result) {
    const dashboard = result as { dashboard_url: string; target?: string; opened?: boolean };
    console.log(`Dashboard URL: ${dashboard.dashboard_url}`);
    if (dashboard.target) console.log(`Target: ${dashboard.target}`);
    if (dashboard.opened) console.log("Opened in browser");
    return;
  }

  if (typeof result === "object" && result && "login_complete" in result) {
    const login = result as unknown as { config_path: string; api_url: string; owner_email?: string; config?: CliConfig };
    console.log("Authenticated.");
    console.log(`Config saved: ${login.config_path}`);
    console.log(`API URL: ${login.api_url}`);
    if (login.owner_email) console.log(`Account: ${login.owner_email}`);
    if (login.config?.sender_email) console.log(`Sender email: ${login.config.sender_email}`);
    console.log("Next: agentcontract skill");
    return;
  }

  if (typeof result === "object" && result && "skill_installed" in result) {
    const skill = result as unknown as { skill_path: string; directory: string; command_hint?: string };
    console.log(`Skill installed: ${skill.skill_path}`);
    console.log(`Skills directory: ${skill.directory}`);
    if (skill.command_hint) console.log(`Next: ${skill.command_hint}`);
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

  if (typeof result === "object" && result && "api_keys" in result && Array.isArray(result.api_keys)) {
    const keys = result as { owner_email?: string; api_keys: Array<{ id: string; name?: string; key_prefix?: string; last4?: string; created_at?: string; last_used_at?: string | null; revoked_at?: string | null }> };
    console.log(`API keys: ${keys.api_keys.length}`);
    if (keys.owner_email) console.log(`Owner: ${keys.owner_email}`);
    for (const key of keys.api_keys) {
      const status = key.revoked_at ? "revoked" : "active";
      console.log(`${key.id} [${status}] ${key.name ?? "AgentContract CLI"} ${key.key_prefix ?? ""}...${key.last4 ?? ""}`);
      if (key.created_at) console.log(`  created: ${key.created_at}`);
      if (key.last_used_at) console.log(`  last used: ${key.last_used_at}`);
    }
    return;
  }

  if (typeof result === "object" && result && "api_key_created" in result) {
    const created = result as unknown as { api_key: string; record?: { id?: string; name?: string; key_prefix?: string; last4?: string } };
    console.log(`Created API key: ${created.record?.id ?? ""}`);
    if (created.record?.name) console.log(`Name: ${created.record.name}`);
    if (created.record?.key_prefix) console.log(`Prefix: ${created.record.key_prefix}...${created.record.last4 ?? ""}`);
    console.log("Copy this key now. AgentContract only stores a hash:");
    console.log(created.api_key);
    return;
  }

  if (typeof result === "object" && result && "api_key_revoked" in result) {
    const revoked = result as { id?: string };
    console.log(`Revoked API key: ${revoked.id ?? ""}`);
    return;
  }

  if (typeof result === "object" && result && "feedback" in result) {
    const feedbackResult = result as { stored?: boolean; feedback?: ProductFeedbackForCli | ProductFeedbackForCli[] };
    const feedbackItems = Array.isArray(feedbackResult.feedback)
      ? feedbackResult.feedback
      : feedbackResult.feedback
        ? [feedbackResult.feedback]
        : [];
    if (feedbackResult.stored && feedbackItems[0]) {
      const item = feedbackItems[0];
      console.log(`Feedback stored: ${item.id}`);
      console.log(`Severity: ${item.severity}`);
      console.log(`Category: ${item.category}`);
      if (item.command) console.log(`Command: ${item.command}`);
      console.log(`Message: ${item.message}`);
      return;
    }
    console.log(`Feedback: ${feedbackItems.length}`);
    for (const item of feedbackItems) {
      const command = item.command ? ` command="${item.command}"` : "";
      console.log(`${item.id} [${item.status}/${item.severity}/${item.category}] ${item.created_at}${command}`);
      console.log(`  ${item.message}`);
    }
    return;
  }

  if (typeof result === "object" && result && "update_check" in result) {
    const update = result as {
      package?: string;
      current_version?: string;
      latest_version?: string;
      update_available?: boolean;
      install_command?: string;
      updated?: boolean;
      already_latest?: boolean;
      cancelled?: boolean;
      dry_run?: boolean;
      command?: string;
    };
    console.log(`${update.package ?? packageName} ${update.current_version ?? cliVersion}`);
    console.log(`Latest: ${update.latest_version ?? "unknown"}`);
    if (update.updated) {
      console.log("Updated successfully.");
    } else if (update.cancelled) {
      console.log("Update cancelled.");
    } else if (update.dry_run && update.command) {
      console.log(`Dry run: ${update.command}`);
    } else if (update.already_latest || !update.update_available) {
      console.log("Already up to date.");
    } else {
      console.log("Update available.");
      if (update.install_command) console.log(`Run: ${update.install_command}`);
    }
    return;
  }

  if (typeof result === "object" && result && "version" in result && "package" in result) {
    const version = result as { package: string; version: string };
    console.log(`${version.package} ${version.version}`);
    return;
  }

  if (typeof result === "object" && result && "templates" in result && Array.isArray(result.templates)) {
    const catalog = result as { templates: Array<{ id: string; name: string; description?: string; variables?: Array<{ key?: string; required?: boolean }> }> };
    console.log(`Templates: ${catalog.templates.length}`);
    for (const template of catalog.templates) {
      const variables = template.variables?.length ? ` vars: ${template.variables.map((item) => item.key).filter(Boolean).join(", ")}` : "";
      console.log(`${template.id} - ${template.name}${variables}`);
      if (template.description) console.log(`  ${template.description}`);
    }
    return;
  }

  if (typeof result === "object" && result && "server_template" in result) {
    const detail = result as { template?: { id?: string; name?: string; description?: string; variables?: Array<{ key?: string; label?: string; defaultValue?: string; required?: boolean }>; fields?: Array<{ id?: string; type?: string; required?: boolean }> }; default_template_vars?: Record<string, unknown>; markdown?: string };
    const template = detail.template ?? {};
    console.log(`${template.id ?? ""} - ${template.name ?? "Template"}`);
    if (template.description) console.log(template.description);
    if (template.variables?.length) {
      console.log("Variables:");
      for (const variable of template.variables) {
        console.log(`  ${variable.key ?? ""}${variable.required ? " *" : ""}: ${variable.defaultValue ?? ""}`);
      }
    }
    if (template.fields?.length) {
      console.log("Fields:");
      for (const field of template.fields) {
        console.log(`  ${field.id ?? ""} (${field.type ?? "text"}${field.required ? ", required" : ""})`);
      }
    }
    if (detail.markdown) {
      console.log("\n--- markdown ---\n");
      console.log(detail.markdown);
    }
    return;
  }

  if (typeof result === "object" && result && "contracts" in result && Array.isArray(result.contracts)) {
    const catalog = result as { contracts_dir?: string; contracts: Array<{ id: string; name: string; kind: string; description?: string; variables?: string[]; path?: string }> };
    console.log(`Contracts: ${catalog.contracts.length}`);
    if (catalog.contracts_dir) console.log(`Local library: ${catalog.contracts_dir}`);
    for (const contract of catalog.contracts) {
      const variables = contract.variables?.length ? ` vars: ${contract.variables.join(", ")}` : "";
      console.log(`${contract.id} [${contract.kind}] - ${contract.name}${variables}`);
      if (contract.description) console.log(`  ${contract.description}`);
      if (contract.path) console.log(`  ${contract.path}`);
    }
    return;
  }

  if (typeof result === "object" && result && "contract_saved" in result) {
    const saved = result as unknown as { contract: { id: string; name: string; kind: string }; markdown_path: string; metadata_path: string };
    console.log(`Saved contract: ${saved.contract.id} - ${saved.contract.name}`);
    console.log(`Markdown: ${saved.markdown_path}`);
    console.log(`Metadata: ${saved.metadata_path}`);
    return;
  }

  if (typeof result === "object" && result && "contract_edit" in result) {
    const edit = result as unknown as { contract: { id: string; name: string }; cloned_from_builtin?: boolean; markdown_path: string; metadata_path: string; editor_opened?: boolean; hint?: string };
    console.log(`${edit.cloned_from_builtin ? "Created editable copy" : "Editable contract"}: ${edit.contract.id} - ${edit.contract.name}`);
    console.log(`Markdown: ${edit.markdown_path}`);
    console.log(`Metadata: ${edit.metadata_path}`);
    if (edit.editor_opened) console.log("Editor opened");
    if (edit.hint) console.log(`Next: ${edit.hint}`);
    return;
  }

  if (typeof result === "object" && result && "contract_feedback" in result) {
    const feedbackResult = result as unknown as {
      added?: boolean;
      cloned_from_builtin?: boolean;
      contract: { id: string; name: string; kind: string };
      feedback?: ContractFeedback;
      feedback_count?: number;
      feedback_path?: string;
      next?: string;
    };
    if (feedbackResult.added && feedbackResult.feedback) {
      console.log(`Added feedback: ${feedbackResult.contract.id} - ${feedbackResult.contract.name}`);
      if (feedbackResult.cloned_from_builtin) console.log("Created editable local copy from built-in contract.");
      console.log(`Feedback: ${feedbackResult.feedback.note}`);
      if (feedbackResult.feedback.author) console.log(`Author: ${feedbackResult.feedback.author}`);
      if (feedbackResult.feedback_path) console.log(`Feedback file: ${feedbackResult.feedback_path}`);
      if (feedbackResult.feedback_count !== undefined) console.log(`Open feedback: ${feedbackResult.feedback_count}`);
      if (feedbackResult.next) console.log(`Next: ${feedbackResult.next}`);
    } else {
      console.log(`Feedback: ${feedbackResult.contract.id} - ${feedbackResult.contract.name}`);
      const items = Array.isArray((feedbackResult as { feedback?: unknown }).feedback) ? (feedbackResult as unknown as { feedback: ContractFeedback[] }).feedback : [];
      if (!items.length) {
        console.log("No feedback yet.");
      } else {
        for (const item of items) {
          const author = item.author ? ` by ${item.author}` : "";
          console.log(`- ${item.created_at}${author}: ${item.note}`);
        }
      }
      if (feedbackResult.feedback_path) console.log(`Feedback file: ${feedbackResult.feedback_path}`);
    }
    return;
  }

  if (typeof result === "object" && result && "contract" in result) {
    const detail = result as { contract: { id: string; name: string; kind: string; description?: string; variables?: string[]; path?: string; fields?: Array<{ id?: unknown; type?: unknown; required?: boolean }> }; template_vars_default?: Record<string, unknown>; feedback?: ContractFeedback[]; markdown?: string };
    console.log(`${detail.contract.id} [${detail.contract.kind}] - ${detail.contract.name}`);
    if (detail.contract.description) console.log(detail.contract.description);
    if (detail.contract.path) console.log(`Path: ${detail.contract.path}`);
    if (detail.contract.variables?.length) console.log(`Variables: ${detail.contract.variables.join(", ")}`);
    if (detail.contract.fields?.length) {
      console.log("Fields:");
      for (const field of detail.contract.fields) {
        console.log(`  ${field.id ?? ""} (${field.type ?? "text"}${field.required ? ", required" : ""})`);
      }
    }
    if (detail.template_vars_default && Object.keys(detail.template_vars_default).length) {
      console.log("Default vars:");
      console.log(JSON.stringify(detail.template_vars_default, null, 2));
    }
    if (detail.feedback) {
      console.log("Feedback:");
      if (!detail.feedback.length) {
        console.log("  none");
      } else {
        for (const item of detail.feedback) {
          const author = item.author ? ` by ${item.author}` : "";
          console.log(`  - ${item.created_at}${author}: ${item.note}`);
        }
      }
    }
    if (detail.markdown) {
      console.log("\n--- markdown ---\n");
      console.log(detail.markdown);
    }
    return;
  }

  if (typeof result === "object" && result && "agreements" in result && Array.isArray(result.agreements)) {
    const list = result as { agreements: Array<{ id: string; status?: string; signing_url?: string; sender_signing_url?: string | null; document_title?: string; recipient?: { name?: string; email?: string }; created_at?: string }>; next_cursor?: string | null };
    console.log(`Agreements: ${list.agreements.length}`);
    for (const agreement of list.agreements) {
      const recipient = agreement.recipient?.email ? ` ${agreement.recipient.name ?? ""} <${agreement.recipient.email}>` : "";
      const title = agreement.document_title ? ` - ${agreement.document_title}` : "";
      const status = agreement.status ? ` [${agreement.status}]` : "";
      const url = agreement.signing_url ? ` ${agreement.signing_url}` : "";
      console.log(`${agreement.id}${status}${recipient}${title}${url}`);
      if (agreement.sender_signing_url) console.log(`  sender signing: ${agreement.sender_signing_url}`);
    }
    if (list.next_cursor) console.log(`Next cursor: ${list.next_cursor}`);
    return;
  }

  if (typeof result === "object" && result && "id" in result) {
    const agreement = result as {
      id: string;
      status?: string;
      signing_url?: string;
      sender_signing_url?: string | null;
      preview_url?: string;
      signed_pdf_url?: string | null;
      signed_pdf_saved?: boolean;
      signed_pdf_sha256?: string | null;
      signed_pdf_bytes?: number | null;
      webhook_secret?: string | null;
      notification_email?: string[];
    };
    console.log(`Sent agreement: ${agreement.id}`);
    if (agreement.status) console.log(`Status: ${agreement.status}`);
    if (agreement.preview_url) console.log(`Preview URL: ${agreement.preview_url}`);
    if (agreement.signing_url) console.log(`Recipient signing URL: ${agreement.signing_url}`);
    if (agreement.sender_signing_url) console.log(`Sender signing URL: ${agreement.sender_signing_url}`);
    if (agreement.signed_pdf_url) console.log(`Signed PDF: ${agreement.signed_pdf_url}`);
    if (typeof agreement.signed_pdf_saved === "boolean") console.log(`Signed PDF saved: ${agreement.signed_pdf_saved ? "yes" : "no"}`);
    if (agreement.signed_pdf_bytes) console.log(`Signed PDF bytes: ${agreement.signed_pdf_bytes}`);
    if (agreement.signed_pdf_sha256) console.log(`Signed PDF SHA-256: ${agreement.signed_pdf_sha256}`);
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
  if (dryRun(args)) return agreementDryRunResult("send-mnda", apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, "send-mnda");
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
  if (dryRun(args)) return agreementDryRunResult("send-privacy", apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, "send-privacy");
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
  if (dryRun(args)) return agreementDryRunResult("send-contract", apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, "send-contract");
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendDemoNda(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseDemoNdaPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return agreementDryRunResult("send-mnda", apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, "send-mnda");
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendDemoPrivacy(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseDemoPrivacyPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return agreementDryRunResult(String(args.command_name ?? "marketplace-onboard"), apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, String(args.command_name ?? "marketplace-onboard"));
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function sendDemoContractor(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseDemoContractorPayload(args)
  };
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return agreementDryRunResult("marketplace-contractor", apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, "marketplace-contractor");
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

function renderedContractMarkdown(args: Args, contract: ContractDefinitionForCli, requireRecipient = false) {
  const recipientName = requireRecipient
    ? receiverName(args)
    : stringArg(args, "name", "receiver-name") ?? "Preview Recipient";
  const recipientEmail = requireRecipient
    ? receiverEmail(args)
    : stringArg(args, "to", "email", "receiver-email")
      ? validateEmail(stringArg(args, "to", "email", "receiver-email")!, "--to / receiver email")
      : "preview@example.com";
  return applyTemplateVars(contract.markdown, {
    ...(contract.template_vars_default ?? {}),
    ...templateVarsFromArgs(args),
    recipient_name: recipientName,
    recipient_email: recipientEmail
  });
}

function contractPayload(args: Args, contract: ContractDefinitionForCli, requireRecipient: boolean) {
  const recipientName = requireRecipient
    ? receiverName(args)
    : stringArg(args, "name", "receiver-name") ?? "Preview Recipient";
  const recipientEmail = requireRecipient
    ? receiverEmail(args)
    : stringArg(args, "to", "email", "receiver-email")
      ? validateEmail(stringArg(args, "to", "email", "receiver-email")!, "--to / receiver email")
      : "preview@example.com";
  return {
    recipient: { name: recipientName, email: recipientEmail },
    ...sharedSendOptions(args),
    document_markdown: contract.markdown,
    template_vars: {
      ...(contract.template_vars_default ?? {}),
      ...templateVarsFromArgs(args)
    },
    fields: fieldsFromArgs(args, contract.fields),
    metadata: {
      source: "agentcontract-cli",
      workflow: "contract_library",
      contract_id: contract.id,
      contract_kind: contract.kind,
      contract_name: contract.name
    }
  };
}

async function listContracts(args: Args) {
  const local = readLocalContracts(args);
  const localIds = new Set(local.map((contract) => contract.id));
  return {
    contracts_dir: contractLibraryDir(args),
    contracts: [
      ...local.map(contractSummary),
      ...builtInContracts()
        .filter((contract) => !localIds.has(contract.id))
        .map(contractSummary)
    ]
  };
}

async function showContract(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "contract") ?? positional[0]);
  const contract = loadContract(id, args);
  const feedback = args.feedback || args["with-feedback"] ? readContractFeedback(id, args) : undefined;
  return {
    contract: contractSummary(contract),
    template_vars_default: contract.template_vars_default ?? {},
    feedback,
    markdown: args.markdown || args.raw ? contract.markdown : undefined
  };
}

async function addContract(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "contract") ?? positional[0]);
  const fromTemplate = stringArg(args, "from-template", "template");
  if (fromTemplate && !builtInContract(fromTemplate)) {
    throw new CliError(`Unknown built-in template: ${fromTemplate}`, "Use nda, privacy, or contractor.");
  }
  const existingLocal = readLocalContract(id, args);
  const existingBuiltIn = builtInContract(id);
  if ((existingLocal || existingBuiltIn) && !args.force) {
    throw new CliError(
      `Contract ${id} already exists${existingBuiltIn && !existingLocal ? " as a built-in contract" : ""}.`,
      "Choose a new id or pass --force to create/replace the local copy."
    );
  }

  const seeded = fromTemplate ? builtInContract(fromTemplate)! : undefined;
  const markdown = markdownFromArgs(args) ?? seeded?.markdown;
  if (!markdown) {
    throw new CliError(
      "--markdown-file or --from-template is required",
      "Example: agentcontract contract add partner-msa --markdown-file ./partner-msa.md"
    );
  }

  const now = new Date().toISOString();
  const vars = defaultContractVars(markdown, {
    ...(seeded?.template_vars_default ?? {}),
    ...templateVarsFromArgs(args)
  });
  const fallbackFields = seeded?.fields ?? defaultFieldsFor(stringArg(args, "field-preset") ?? "nda");
  const contract = writeLocalContract({
    id,
    name: stringArg(args, "contract-name", "title") ?? stringArg(args, "name") ?? seeded?.name ?? titleFromMarkdown(applyTemplateVars(markdown, vars)),
    description: stringArg(args, "description") ?? seeded?.description,
    fields: fieldsFromArgs(args, fallbackFields),
    template_vars_default: vars,
    created_at: existingLocal?.created_at || now,
    updated_at: now,
    source: fromTemplate ? `built-in:${fromTemplate}` : stringArg(args, "source") ?? "local"
  }, markdown, args);

  return {
    contract_saved: true,
    contract: contractSummary(contract),
    template_vars_default: contract.template_vars_default,
    markdown_path: contract.path,
    metadata_path: contractMetaPath(id, args)
  };
}

async function editContract(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "contract") ?? positional[0]);
  let contract = readLocalContract(id, args);
  let cloned = false;
  if (!contract) {
    const builtIn = builtInContract(id);
    if (!builtIn) throw new CliError(`Unknown contract: ${id}`, "Run agentcontract contracts to see available contracts.");
    const now = new Date().toISOString();
    contract = writeLocalContract({
      id: builtIn.id,
      name: builtIn.name,
      description: builtIn.description,
      fields: builtIn.fields,
      template_vars_default: builtIn.template_vars_default,
      created_at: now,
      updated_at: now,
      source: `built-in:${builtIn.id}`
    }, builtIn.markdown, args);
    cloned = true;
  }

  const editor = stringArg(args, "editor") ?? process.env.VISUAL ?? process.env.EDITOR;
  const shouldOpenEditor = !args["no-open"] && !args["print-path"] && !jsonOutput(args) && editor;
  if (shouldOpenEditor) {
    const result = spawnSync(editor, [contract.path!], { stdio: "inherit" });
    if (result.error) throw new CliError(`Could not open editor ${editor}: ${result.error.message}`);
    if (result.status && result.status !== 0) throw new CliError(`Editor exited with status ${result.status}`);
    const current = readLocalContract(id, args)!;
    writeLocalContract({ ...current, updated_at: new Date().toISOString() }, readTextFile(contract.path!, `contract ${id} markdown`), args);
    contract = readLocalContract(id, args)!;
  } else if (args.open) {
    openTarget(contract.path!);
  }

  return {
    contract_edit: true,
    cloned_from_builtin: cloned,
    contract: contractSummary(contract),
    markdown_path: contract.path,
    metadata_path: contractMetaPath(id, args),
    editor_opened: Boolean(shouldOpenEditor || args.open),
    hint: shouldOpenEditor || args.open ? undefined : `Edit ${contract.path} and then run agentcontract contract read ${id}`
  };
}

async function previewContract(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "contract") ?? positional[0]);
  const contract = loadContract(id, args);
  return writePreview(contractPayload(args, contract, false), { ...args, preview: true });
}

async function readContract(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "contract") ?? positional[0]);
  const contract = loadContract(id, args);
  let text = args.raw ? contract.markdown : renderedContractMarkdown(args, contract, false);
  if (args["with-feedback"] || args.feedback) {
    const feedback = feedbackMarkdown(readContractFeedback(id, args));
    text = feedback ? `${text.trimEnd()}\n\n---\n\n${feedback}` : `${text.trimEnd()}\n\n---\n\n## Contract Feedback\n\nNo feedback yet.\n`;
  }
  return writeTextOutput(text, args, contract.name);
}

function feedbackNoteFromArgs(args: Args, rest: string[]) {
  const fromArg = stringArg(args, "note", "feedback", "message");
  if (fromArg) return fromArg.trim();
  const feedbackFile = stringArg(args, "feedback-file", "note-file");
  if (feedbackFile) return readTextFile(feedbackFile, "--feedback-file").trim();
  if (args["feedback-stdin"]) return readFileSync(0, "utf8").trim();
  const fromRest = rest.join(" ").trim();
  return fromRest || undefined;
}

async function feedbackContract(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "contract") ?? positional[0]);
  const rest = positional.slice(1);
  const note = feedbackNoteFromArgs(args, rest);

  if (!note) {
    const contract = loadContract(id, args);
    return {
      contract_feedback: true,
      contract: contractSummary(contract),
      feedback: readContractFeedback(id, args),
      feedback_path: existsSync(contractFeedbackPath(id, args)) ? contractFeedbackPath(id, args) : undefined
    };
  }

  const { contract, cloned } = ensureLocalContract(id, args);
  const feedback: ContractFeedback = {
    id: `fb_${nanoid(10)}`,
    contract_id: contract.id,
    note,
    author: stringArg(args, "author", "by") ?? configString("sender_name") ?? undefined,
    created_at: new Date().toISOString(),
    source: "agentcontract-cli",
    status: "open"
  };
  const feedbackPath = writeContractFeedback(contract.id, feedback, args);
  return {
    contract_feedback: true,
    added: true,
    cloned_from_builtin: cloned,
    contract: contractSummary(contract),
    feedback,
    feedback_count: readContractFeedback(contract.id, args).length,
    feedback_path: feedbackPath,
    next: `agentcontract contract read ${contract.id} --with-feedback`
  };
}

async function sendSavedContract(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "contract") ?? positional[0]);
  const contract = loadContract(id, args);
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = contractPayload(args, contract, true);
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return agreementDryRunResult("contract send", apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, "contract send");
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

function pdfPayload(args: Args, positional: string[]) {
  const pdfFile = requireArg(
    pdfFileFromArgs(args, positional),
    "--pdf-file or PDF path",
    'Example: agentcontract send-pdf ./agreement.pdf --to jane@example.com --name "Jane Doe"'
  );
  const pdf = pdfDocumentFromFile(pdfFile);
  const title = stringArg(args, "title", "document-title") ?? pdf.title;
  return {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...sharedSendOptions(args, title),
    document_pdf_base64: pdf.base64,
    document_pdf_filename: pdf.filename,
    document_title: title,
    fields: fieldsFromArgs(args, pdfFields()),
    metadata: {
      source: "agentcontract-cli",
      workflow: "byo_pdf",
      document_pdf_filename: pdf.filename
    }
  };
}

async function sendPdf(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const payload = pdfPayload(args, positional);
  if (args.preview) return writePreview(payload, args);
  if (dryRun(args)) return agreementDryRunResult("send-pdf", apiUrl, "/v1/agreements", payload, args);
  const result = await postAgreementJson(apiUrl, apiKey, "/v1/agreements", payload, args, "send-pdf");
  if (args.open && typeof result === "object" && result && "preview_url" in result) openTarget(String((result as { preview_url: string }).preview_url));
  return result;
}

async function contractCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "list";
  const rest = positional.slice(1);
  if (action === "list" || action === "ls") return listContracts(args);
  if (action === "show" || action === "inspect" || action === "cat") return showContract(args, rest);
  if (action === "add" || action === "new" || action === "import") return addContract(args, rest);
  if (action === "edit") return editContract(args, rest);
  if (action === "read" || action === "text" || action === "render") return readContract(args, rest);
  if (action === "feedback" || action === "note" || action === "comment" || action === "review-note") return feedbackContract(args, rest);
  if (action === "preview" || action === "review") return previewContract(args, rest);
  if (action === "send") return sendSavedContract(args, rest);
  throw new CliError(`Unknown contract command: ${action}`, "Run agentcontract help to see contract commands.");
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
  const file = requireArg(stringArg(args, "file"), "--file", "Example: agentcontract bulk-mnda --from legal@example.com --file recipients.json --company \"Acme Inc.\"");
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
  if (dryRun(args)) return agreementDryRunResult("bulk-mnda", apiUrl, "/v1/agreements/bulk", payload, args);
  if (!await confirmMassEmail(args, "bulk-mnda", recipients.length, "signing request emails")) {
    return { bulk_email_cancelled: true, command: "bulk-mnda", recipients: recipients.length };
  }
  return postAgreementJson(apiUrl, apiKey, "/v1/agreements/bulk", payload, args, "bulk-mnda");
}

async function bulkMarketplaceOnboard(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const file = requireArg(stringArg(args, "file"), "--file", "Example: agentcontract bulk-marketplace-onboard --file contributors.json --from you@example.com");
  const recipients = normalizeBulkRecipients(parseJsonFile(file, "--file"));
  const base = baseDemoPrivacyPayload(args);
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
  if (dryRun(args)) return agreementDryRunResult("bulk-marketplace-onboard", apiUrl, "/v1/agreements/bulk", payload, args);
  if (!await confirmMassEmail(args, "bulk-marketplace-onboard", recipients.length, "signing request emails")) {
    return { bulk_email_cancelled: true, command: "bulk-marketplace-onboard", recipients: recipients.length };
  }
  return postAgreementJson(apiUrl, apiKey, "/v1/agreements/bulk", payload, args, "bulk-marketplace-onboard");
}

async function bulkDemoContractor(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args) && !args.preview);
  const file = requireArg(stringArg(args, "file"), "--file", "Example: agentcontract bulk-contractor --file contractors.json --from you@example.com");
  const recipients = normalizeBulkRecipients(parseJsonFile(file, "--file"));
  const base = baseDemoContractorPayload(args);
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
  if (dryRun(args)) return agreementDryRunResult("bulk-contractor", apiUrl, "/v1/agreements/bulk", payload, args);
  if (!await confirmMassEmail(args, "bulk-contractor", recipients.length, "signing request emails")) {
    return { bulk_email_cancelled: true, command: "bulk-contractor", recipients: recipients.length };
  }
  return postAgreementJson(apiUrl, apiKey, "/v1/agreements/bulk", payload, args, "bulk-contractor");
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

function inferFeedbackCategory(command: string | undefined, message: string) {
  const text = `${command ?? ""} ${message}`.toLowerCase();
  if (text.includes("install") || text.includes("npm ") || text.includes("curl ")) return "install";
  if (text.includes("login") || text.includes("auth") || text.includes("code")) return "login";
  if (text.includes("signing") || text.includes("signature") || text.includes("/sign/")) return "signing";
  if (text.includes("send") || text.includes("onboard") || text.includes("email")) return "sending";
  if (text.includes("webhook")) return "webhook";
  if (text.includes("dashboard") || text.includes("ui")) return "dashboard";
  if (text.includes("docs") || text.includes("skill")) return "docs";
  return "cli";
}

function inferFeedbackSeverity(message: string) {
  const text = message.toLowerCase();
  if (text.includes("block") || text.includes("can't") || text.includes("cannot") || text.includes("crash")) return "blocker";
  if (text.includes("fail") || text.includes("error") || text.includes("broken") || text.includes("broke")) return "high";
  return "normal";
}

function productFeedbackContext(args: Args, apiUrl: string) {
  const context: Record<string, unknown> = {
    cli_version: cliVersion,
    package: packageName,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    api_url: apiUrl,
    config_loaded: !configLoadError,
    config_custom_path: Boolean(process.env.AGENTCONTRACT_CONFIG)
  };
  if (configLoadError) context.config_error = configLoadError;
  if (args["include-cwd"]) context.cwd = process.cwd();
  return context;
}

async function submitProductFeedback(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args, false);
  const commandText = cleanString(stringArg(args, "command", "cmd"));
  const message = feedbackNoteFromArgs(args, positional);
  if (!message) {
    throw new CliError(
      "feedback message is required",
      'Example: agentcontract feedback --message "Login code never arrived" --command "agentcontract login --email you@example.com"'
    );
  }

  const reporterEmail = cleanString(stringArg(args, "reporter-email"))
    ?? cleanString(stringArg(args, "email"))
    ?? configString("sender_email");
  const reporterName = cleanString(stringArg(args, "reporter-name", "author", "by"))
    ?? configString("sender_name");
  const payload = {
    message,
    reporter_email: reporterEmail,
    reporter_name: reporterName,
    source: "agentcontract-cli",
    category: stringArg(args, "category") ?? inferFeedbackCategory(commandText, message),
    severity: stringArg(args, "severity") ?? inferFeedbackSeverity(message),
    command: commandText,
    expected: stringArg(args, "expected"),
    actual: stringArg(args, "actual", "error"),
    context: productFeedbackContext(args, apiUrl)
  };

  if (dryRun(args)) return dryRunResult("feedback", apiUrl, "/v1/feedback", payload);
  return postMaybeAuthJson(apiUrl, apiKey, "/v1/feedback", payload);
}

async function listProductFeedback(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const query = new URLSearchParams();
  const statusFilter = stringArg(args, "status");
  const limit = stringArg(args, "limit");
  if (statusFilter) query.set("status", statusFilter);
  if (limit) query.set("limit", limit);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson(apiUrl, apiKey, `/v1/feedback${suffix}`);
}

async function productFeedbackCommand(args: Args, positional: string[]) {
  const action = positional[0];
  if (action === "list" || action === "ls") return listProductFeedback(args);
  return submitProductFeedback(args, positional);
}

function eventTextFromArgs(args: Args, positional: string[]) {
  const fromArg = cleanString(stringArg(args, "text", "message", "content"));
  if (fromArg) return fromArg;
  const file = cleanString(stringArg(args, "file", "text-file", "message-file"));
  if (file) return readTextFile(file, "--file");
  if (args.stdin) return readFileSync(0, "utf8");
  return positional.join(" ").trim() || undefined;
}

async function sessionCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "start";
  const rest = positional.slice(1);
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args));

  if (action === "start" || action === "new") {
    const payload = {
      agent: agentName(args) ?? "unknown",
      source: stringArg(args, "source") ?? "agentcontract-cli",
      initial_goal: stringArg(args, "goal", "initial-goal") ?? cleanString(rest.join(" ")),
      privacy_mode: stringArg(args, "privacy-mode") ?? "full",
      metadata: {
        cli_version: cliVersion,
        package: packageName,
        node: process.version,
        platform: process.platform,
        arch: process.arch
      }
    };
    if (dryRun(args)) return dryRunResult("session start", apiUrl, "/v1/agent-sessions", payload);
    return postJson(apiUrl, apiKey, "/v1/agent-sessions", payload);
  }

  if (action === "event" || action === "log" || action === "message") {
    const id = requireArg(sessionId(args) ?? rest[0], "--session-id", "Example: agentcontract session event --session-id sess_... --type user_message --text \"send the NDA\"");
    const text = eventTextFromArgs(args, sessionId(args) ? rest : rest.slice(1));
    const jsonFile = cleanString(stringArg(args, "json-file", "content-json-file"));
    const content = jsonFile ? parseJsonFile(jsonFile, "--json-file") : undefined;
    const payload = {
      event_type: stringArg(args, "type", "event-type") ?? "message",
      role: stringArg(args, "role") ?? "user",
      content_text: text,
      content_json: content,
      metadata: {
        cli_version: cliVersion,
        agent: agentName(args) ?? null
      }
    };
    if (dryRun(args)) return dryRunResult("session event", apiUrl, `/v1/agent-sessions/${id}/events`, payload);
    return postJson(apiUrl, apiKey, `/v1/agent-sessions/${id}/events`, payload);
  }

  if (action === "end" || action === "finish" || action === "close") {
    const id = requireArg(sessionId(args) ?? rest[0], "--session-id", "Example: agentcontract session end --session-id sess_... --outcome sent");
    const payload = {
      outcome: stringArg(args, "outcome") ?? cleanString(sessionId(args) ? rest.join(" ") : rest.slice(1).join(" ")),
      metadata: {
        cli_version: cliVersion,
        agent: agentName(args) ?? null
      }
    };
    if (dryRun(args)) return dryRunResult("session end", apiUrl, `/v1/agent-sessions/${id}/end`, payload);
    return postJson(apiUrl, apiKey, `/v1/agent-sessions/${id}/end`, payload);
  }

  throw new CliError(`Unknown session command: ${action}`, "Run agentcontract session start --goal \"...\" or agentcontract session event --session-id sess_...");
}

async function listApiKeys(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  return getJson(apiUrl, apiKey, "/v1/api-keys");
}

async function createApiKeyCommand(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const result = await postJson(apiUrl, apiKey, "/v1/api-keys", {
    name: stringArg(args, "key-name", "name") ?? "AgentContract CLI"
  }) as { api_key?: string; record?: unknown };
  if (!result.api_key) throw new CliError("API did not return a new key");
  return {
    api_key_created: true,
    api_key: result.api_key,
    record: result.record
  };
}

async function revokeApiKeyCommand(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0] ?? stringArg(args, "id", "key-id");
  if (!id) throw new CliError("key_id is required", "Example: agentcontract key revoke key_123");
  const result = await postJson(apiUrl, apiKey, `/v1/api-keys/${id}/revoke`, {}) as { revoked?: boolean; id?: string };
  return {
    api_key_revoked: true,
    ...result
  };
}

async function keyCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "list";
  const rest = positional.slice(1);
  if (action === "list" || action === "ls") return listApiKeys(args);
  if (action === "create" || action === "new") return createApiKeyCommand(args);
  if (action === "revoke" || action === "delete" || action === "rm") return revokeApiKeyCommand(args, rest);
  throw new CliError(`Unknown key command: ${action}`, "Run agentcontract help to see key commands.");
}

async function domainCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "status";
  const { apiUrl, apiKey } = apiConfig(args);
  if (action === "setup" || action === "configure" || action === "create") {
    const payload = {
      email_domain: requireArg(stringArg(args, "email-domain", "domain"), "--email-domain", "Example: agentcontract domain setup --email-domain acme.com --signing-domain contracts.acme.com --from legal@acme.com"),
      signing_domain: requireArg(stringArg(args, "signing-domain", "sign-domain"), "--signing-domain", "Example: agentcontract domain setup --email-domain acme.com --signing-domain contracts.acme.com --from legal@acme.com"),
      from_email: senderEmail(args),
      from_name: senderName(args)
    };
    if (!payload.from_email) {
      throw new CliError("--from / --sender-email is required", "Example: agentcontract domain setup --email-domain acme.com --signing-domain contracts.acme.com --from legal@acme.com");
    }
    if (dryRun(args)) return dryRunResult("domain setup", apiUrl, "/v1/sender-profile", payload);
    return postJson(apiUrl, apiKey, "/v1/sender-profile", payload);
  }
  if (action === "status" || action === "show" || action === "dns") {
    return getJson(apiUrl, apiKey, "/v1/sender-profile");
  }
  if (action === "verify" || action === "check") {
    if (dryRun(args)) return dryRunResult("domain verify", apiUrl, "/v1/sender-profile/verify", {});
    return postJson(apiUrl, apiKey, "/v1/sender-profile/verify", {});
  }
  throw new CliError(`Unknown domain command: ${action}`, "Run agentcontract domain setup, domain status, or domain verify.");
}

async function listServerTemplates(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  return getJson(apiUrl, apiKey, "/v1/templates");
}

async function getServerTemplate(args: Args, id: string) {
  const { apiUrl, apiKey } = apiConfig(args);
  return getJson(apiUrl, apiKey, `/v1/templates/${id}`) as Promise<{
    template?: { id?: string; name?: string };
    markdown?: string;
    default_template_vars?: Record<string, unknown>;
  }>;
}

async function showServerTemplate(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "template") ?? positional[0]);
  const result = await getServerTemplate(args, id);
  return {
    server_template: true,
    ...result,
    markdown: args.markdown || args.raw ? result.markdown : undefined
  };
}

async function readServerTemplate(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "template") ?? positional[0]);
  const result = await getServerTemplate(args, id);
  const vars = {
    ...(result.default_template_vars ?? {}),
    ...templateVarsFromArgs(args)
  };
  const markdown = applyTemplateVars(result.markdown ?? "", vars);
  if (jsonOutput(args) && !stringArg(args, "out", "output-file", "output")) {
    return {
      server_template: true,
      ...result,
      rendered_markdown: markdown
    };
  }
  return writeTextOutput(markdown, args, result.template?.name);
}

async function templateCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "list";
  const rest = positional.slice(1);
  if (action === "list" || action === "ls") return listServerTemplates(args);
  if (action === "show" || action === "inspect") return showServerTemplate(args, rest);
  if (action === "read" || action === "text" || action === "render") return readServerTemplate(args, rest);
  if (action === "preview" || action === "review") {
    const id = assertContractId(stringArg(args, "id", "template") ?? rest[0]);
    return sendContract({ ...args, template: id, preview: true });
  }
  if (action === "send") {
    const id = assertContractId(stringArg(args, "id", "template") ?? rest[0]);
    return sendContract({ ...args, template: id });
  }
  if (!["create", "new", "revoke", "delete", "rm"].includes(action)) return showServerTemplate(args, [action, ...rest]);
  throw new CliError(`Unknown template command: ${action}`, "Run agentcontract help to see template commands.");
}

async function status(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract status agr_123");
  return getJson(apiUrl, apiKey, `/v1/agreements/${id}`);
}

async function listAgreements(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const query = new URLSearchParams();
  const statusFilter = stringArg(args, "status");
  const limit = stringArg(args, "limit");
  const cursor = stringArg(args, "cursor");
  if (statusFilter) query.set("status", statusFilter);
  if (limit) query.set("limit", limit);
  if (cursor) query.set("cursor", cursor);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson(apiUrl, apiKey, `/v1/agreements${suffix}`);
}

async function listBatches(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const query = new URLSearchParams();
  const limit = stringArg(args, "limit");
  const cursor = stringArg(args, "cursor");
  if (limit) query.set("limit", limit);
  if (cursor) query.set("cursor", cursor);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson(apiUrl, apiKey, `/v1/agreement-batches${suffix}`);
}

async function readBatch(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0] ?? stringArg(args, "id", "batch-id");
  if (!id) throw new CliError("batch_id is required", "Example: agentcontract batch read bat_123 --json");
  return getJson(apiUrl, apiKey, `/v1/agreement-batches/${id}`);
}

async function batchCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "list";
  const rest = positional.slice(1);
  if (action === "list" || action === "ls") return listBatches(args);
  if (action === "read" || action === "show" || action === "status") return readBatch(args, rest);
  if (action.startsWith("bat_")) return readBatch(args, [action, ...rest]);
  throw new CliError(`Unknown batch command: ${action}`, "Run agentcontract batches or agentcontract batch read bat_...");
}

async function readAgreement(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract agreement read agr_123");
  const result = await getJson(apiUrl, apiKey, `/v1/agreements/${id}/document`) as {
    document_title?: string;
    document_markdown?: string;
  };
  if (jsonOutput(args) && !stringArg(args, "out", "output-file", "output")) return result;
  return writeTextOutput(result.document_markdown ?? "", args, result.document_title);
}

async function auditAgreement(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract agreement audit agr_123");
  const result = await getJson(apiUrl, apiKey, `/v1/agreements/${id}/audit`) as {
    agreement_id?: string;
    audit_events?: Array<{ event_type?: string; created_at?: string; ip_address?: string | null; user_agent?: string | null; data?: unknown }>;
  };
  if (jsonOutput(args)) return result;
  const lines = [
    `Audit Trail: ${result.agreement_id ?? id}`,
    "",
    ...(result.audit_events ?? []).map((event) => {
      const ip = event.ip_address ? ` ip=${event.ip_address}` : "";
      const ua = event.user_agent ? ` ua=${event.user_agent}` : "";
      return `- ${event.created_at ?? ""} ${event.event_type ?? "event"}${ip}${ua}`;
    })
  ];
  return writeTextOutput(`${lines.join("\n")}\n`, args, `Audit ${result.agreement_id ?? id}`);
}

async function remindAgreement(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args));
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract agreement remind agr_123 --remind-recipient");
  const target = await promptReminderTarget(args, apiUrl, apiKey, id);
  if (target === "all" && !await confirmMassEmail(args, "agreement remind", 2, "reminder emails")) {
    return { reminder_cancelled: true, agreement_id: id, target };
  }
  const payload = { target };
  if (dryRun(args)) return dryRunResult("agreement remind", apiUrl, `/v1/agreements/${id}/remind`, payload);
  return postJson(apiUrl, apiKey, `/v1/agreements/${id}/remind`, payload);
}

async function cancelAgreement(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract agreement cancel agr_123");
  return postJson(apiUrl, apiKey, `/v1/agreements/${id}/cancel`, {});
}

async function pdfAgreement(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract agreement pdf agr_123 --out agreement.pdf");
  const pdf = await downloadBinary(apiUrl, apiKey, `/v1/agreements/${id}/pdf`);
  return writeBinaryOutput(pdf, args, `${id}.pdf`);
}

async function agreementCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "list";
  const rest = positional.slice(1);
  if (action === "list" || action === "ls") return listAgreements(args);
  if (action === "show" || action === "status") return status(args, rest);
  if (action === "read" || action === "text" || action === "document") return readAgreement(args, rest);
  if (action === "audit") return auditAgreement(args, rest);
  if (action === "remind") return remindAgreement(args, rest);
  if (action === "cancel") return cancelAgreement(args, rest);
  if (action === "pdf" || action === "download-pdf") return pdfAgreement(args, rest);
  throw new CliError(`Unknown agreement command: ${action}`, "Run agentcontract help to see agreement commands.");
}

async function readTarget(args: Args, positional: string[]) {
  const target = positional[0] ?? stringArg(args, "id", "contract", "agreement");
  if (!target) throw new CliError("id is required", "Example: agentcontract read privacy");
  if (target.startsWith("agr_")) return readAgreement(args, [target]);
  return readContract(args, [target]);
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

function dashboardPath(target: string | undefined) {
  const key = (target ?? "home").toLowerCase();
  if (key === "home" || key === "dashboard" || key === "agreements") return "/dashboard";
  if (key === "templates" || key === "template") return "/templates";
  if (key === "privacy" || key === "bear-privacy" || key === "specific-privacy") return "/templates/privacy";
  if (key === "contractor" || key === "specific-contractor" || key === "bear-contractor") return "/templates/contractor";
  if (key === "nda" || key === "mnda" || key === "bear-mnda") return "/templates/nda";
  if (key === "api-keys" || key === "keys") return "/dashboard/api-keys";
  if (key === "login" || key === "auth") return "/login";
  if (key === "cli" || key === "install") return "/cli";
  throw new CliError(`Unknown dashboard target: ${target}`, "Use dashboard, templates, privacy, contractor, nda, api-keys, login, or cli.");
}

function dashboardCommand(args: Args, positional: string[]) {
  const { apiUrl } = apiConfig(args, false);
  const target = stringArg(args, "target", "page") ?? positional[0];
  const url = `${apiUrl}${dashboardPath(target)}`;
  if (!args["no-open"]) openTarget(url);
  return {
    dashboard_url: url,
    target: target ?? "dashboard",
    opened: !args["no-open"]
  };
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

type CliExchangeResponse = {
  api_key?: string;
  owner_email?: string;
  owner_id?: string;
};

async function promptSecret(question: string) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return cleanString(await rl.question(question));
  } finally {
    rl.close();
  }
}

async function loginWithEmailCode(args: Args) {
  if (configLoadError && !args.force) {
    throw new CliError(
      `Existing config at ${configPath} could not be read: ${configLoadError}`,
      "Pass --force to overwrite it."
    );
  }

  const apiUrl = normalizeApiUrl(cleanString(stringArg(args, "api-url")) ?? cliConfig.api_url ?? defaultApiUrl);
  const email = validateEmail(
    requireArg(stringArg(args, "email", "login-email"), "--email", "Example: agentcontract login --email you@example.com"),
    "--email"
  );
  const keyName = cleanString(stringArg(args, "key-name")) ?? "AgentContract CLI";

  await postPublicJson(apiUrl, "/cli/magic/start", { email });
  if (!jsonOutput(args)) {
    console.error(`Sent an AgentContract login code to ${email}.`);
  }

  const code = cleanString(stringArg(args, "code")) ?? await promptSecret("Enter 6-digit login code: ");
  if (!code) throw new CliError("Login code is required", "Run agentcontract login --email you@example.com again.");

  const exchanged = await postPublicJson(apiUrl, "/cli/magic/verify", { email, code, name: keyName }) as CliExchangeResponse;
  if (!exchanged.api_key) throw new CliError("Email-code login did not return an API key");
  const ownerEmail = cleanString(exchanged.owner_email) ?? email;
  const nextConfig: CliConfig = {
    ...cliConfig,
    api_url: apiUrl,
    api_key: exchanged.api_key,
    sender_email: validateEmail(ownerEmail, "owner_email")
  };
  writeCliConfig(nextConfig);

  return {
    login_complete: true,
    config_path: configPath,
    api_url: apiUrl,
    owner_email: ownerEmail,
    config: publicConfig(false, nextConfig)
  };
}

async function login(args: Args) {
  if (stringArg(args, "email", "login-email")) {
    return loginWithEmailCode(args);
  }

  if (configLoadError && !args.force) {
    throw new CliError(
      `Existing config at ${configPath} could not be read: ${configLoadError}`,
      "Pass --force to overwrite it."
    );
  }

  const apiUrl = normalizeApiUrl(cleanString(stringArg(args, "api-url")) ?? cliConfig.api_url ?? defaultApiUrl);
  const state = nanoid(24);
  const timeoutMs = Number(stringArg(args, "timeout-ms") ?? 300_000);
  const keyName = cleanString(stringArg(args, "key-name")) ?? "AgentContract CLI";

  let settled = false;
  let timeout: NodeJS.Timeout;
  const server = createServer();
  const loginResult = new Promise<unknown>((resolvePromise, rejectPromise) => {
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      rejectPromise(new CliError("Login timed out", "Run agentcontract login again."));
    }, timeoutMs);

    server.on("request", (req, res) => {
      void (async () => {
        const address = server.address() as AddressInfo;
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${address.port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end("Not found");
          return;
        }

        if (url.searchParams.get("state") !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end("<h1>Invalid login state</h1>");
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end("<h1>Missing login code</h1>");
          return;
        }

        try {
          const exchanged = await postPublicJson(apiUrl, "/cli/exchange", { code }) as CliExchangeResponse;
          if (!exchanged.api_key) throw new CliError("CLI exchange did not return an API key");
          const ownerEmail = cleanString(exchanged.owner_email);
          const browserName = cleanString(url.searchParams.get("name") ?? undefined);
          const nextConfig: CliConfig = {
            ...cliConfig,
            api_url: apiUrl,
            api_key: exchanged.api_key,
            ...(ownerEmail ? { sender_email: validateEmail(ownerEmail, "owner_email") } : {}),
            ...(browserName ? { sender_name: browserName } : {})
          };
          writeCliConfig(nextConfig);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html><head><meta charset="utf-8"><title>AgentContract CLI Login</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:48px">
  <h1>AgentContract CLI authenticated</h1>
  <p>You can close this tab and return to your terminal.</p>
</body></html>`);

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            server.close();
            resolvePromise({
              login_complete: true,
              config_path: configPath,
              api_url: apiUrl,
              owner_email: ownerEmail,
              config: publicConfig(false, nextConfig)
            });
          }
        } catch (error) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end("<h1>AgentContract CLI login failed</h1><p>Return to your terminal and retry.</p>");
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            server.close();
            rejectPromise(error);
          }
        }
      })();
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const browserUrl = new URL(`${apiUrl}/cli/login`);
  browserUrl.searchParams.set("redirect_uri", redirectUri);
  browserUrl.searchParams.set("state", state);
  browserUrl.searchParams.set("name", keyName);

  if (!jsonOutput(args)) {
    console.log("Opening browser for authentication...");
    console.log(`If it doesn't open, visit: ${browserUrl.toString()}`);
  }
  if (!args["no-open"]) openTarget(browserUrl.toString());

  return loginResult;
}

function agentContractSkillMarkdown() {
  return `---
name: agentcontract-cli
description: |
  AgentContract CLI helper — knows how to authenticate, inspect, draft,
  revise, send, and track contracts from an agent-native CLI.
allowed-tools:
  - Bash
---

# AgentContract CLI

Use AgentContract when a user asks to send a contract, onboard a marketplace contributor,
draft/revise a contract, capture contract feedback, check signing status, or download a signed PDF.

## Setup

agentcontract login
agentcontract login --email you@example.com
agentcontract config get
agentcontract doctor
agentcontract update --check
agentcontract keys

If the user is not logged in, run \`agentcontract login --email <email>\`; it sends an email code and stores a local API key after verification. Browser WorkOS login is also available with \`agentcontract login\` once the WorkOS redirect URI is registered.

## Auto Update

Before sending, reading, reminding, cancelling, or checking status, run:

agentcontract update --check --json

If \`update_available\` is true, run:

agentcontract update --yes
agentcontract skill

Then continue with the user's original AgentContract task. If \`agentcontract update\` is not recognized, run \`curl -fsSL https://agentink-pied.vercel.app/cli/install.sh | bash\`, then run \`agentcontract skill\`, then continue. If the update check fails because npm/network is unavailable, continue with the current CLI and report the update failure with \`agentcontract feedback\`.

## Prompt And Failure Logging

Do not upload chat transcripts or conversation events. For a real send, pass only a short explicit goal or user prompt when it helps the sender understand why the contract was sent:

agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor" --prompt "Send the approved onboarding privacy acknowledgement" --json

The CLI reports failed commands only. Successful sends with no \`--prompt\`, \`--goal\`, or \`--chat-summary\` should not create CLI run telemetry.

## Core Commands

agentcontract keys
agentcontract key create --key-name "Agent laptop"
agentcontract key revoke key_...
agentcontract templates
agentcontract template read privacy --out ./privacy.md
agentcontract contracts
agentcontract dashboard contractor
agentcontract read privacy --var effective_date="April 29, 2026"
agentcontract contract show contractor --markdown
agentcontract contract add custom-sow --markdown-file ./contract.md --fields-file ./fields.json
agentcontract contract feedback custom-sow --note "Make the IP assignment clearer"
agentcontract contract read custom-sow --with-feedback
agentcontract contract edit custom-sow
agentcontract contract send custom-sow --to jane@example.com --name "Jane Doe" --json
agentcontract send-pdf ./agreement.pdf --to jane@example.com --name "Jane Doe" --title "Partner SOW" --json
agentcontract update --yes
agentcontract dashboard contractor
agentcontract feedback --message "What broke" --command "exact command" --expected "expected result" --actual "actual result or error" --json

## Built-ins

- \`nda\`: Acme Inc. nondisclosure agreement
- \`privacy\`: Acme Marketplace privacy acknowledgement
- \`contractor\`: Acme Marketplace contributor terms

## Sending

agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor" --json
agentcontract marketplace-contractor --to contributor@example.com --name "Jane Contributor" --json
agentcontract bulk-contractor --file contractors.json --json
agentcontract send-pdf ./agreement.pdf --to jane@example.com --name "Jane Doe" --title "Partner SOW" --json
agentcontract send-mnda --to jane@example.com --name "Jane Doe" --json
agentcontract dashboard contractor

## Tracking

agentcontract agreements --status sent --json
agentcontract status agr_... --json
agentcontract agreement read agr_... --out ./agreement.md
agentcontract agreement audit agr_...
agentcontract agreement remind agr_... --remind-recipient
agentcontract agreement cancel agr_...
agentcontract agreement pdf agr_... --out ./signed.pdf

## Failure Feedback

If any AgentContract command breaks, immediately store concise feedback before trying workarounds:

agentcontract feedback \\
  --command "paste the exact command that failed" \\
  --expected "what should have happened" \\
  --actual "the error, confusing output, or bad behavior" \\
  --message "one sentence summary" \\
  --severity high \\
  --json

Use \`--category install\`, \`--category login\`, \`--category sending\`, \`--category signing\`, or \`--category docs\` when obvious. The feedback command works before login; if logged in, it also attaches the user's account email.

## Rules

- Do not send placeholder values.
- Keep the CLI fresh with the Auto Update flow before doing contract work.
- Before sending a reminder, explicitly ask whether the email should go to the sender/themselves, the recipient/everyone else, or all signing parties. Use \`--remind-self\`, \`--remind-recipient\`, or \`--remind-all\`; do not run a plain \`agreement remind\` in noninteractive mode.
- Prefer \`--dry-run --json\` before bulk sends, then ask the user for explicit approval before rerunning with \`--yes\`.
- Use \`contract read --with-feedback\` before sending revised contracts.
- When something fails or feels confusing, run \`agentcontract feedback\` with the command, expected result, and actual result.
- Prefer CLI/API commands over sender dashboard or template forms.
- Never print or commit API keys.
`;
}

function skillTargets() {
  return [
    { label: "Claude Code project", directory: join(process.cwd(), ".claude", "skills") },
    { label: "Claude Code user", directory: join(homedir(), ".claude", "skills") },
    { label: "Codex user", directory: join(homedir(), ".codex", "skills") },
    { label: "Agents user", directory: join(homedir(), ".agents", "skills") }
  ];
}

async function chooseSkillDirectory(args: Args) {
  const explicit = cleanString(stringArg(args, "directory", "dir"));
  if (explicit) return resolve(explicit);

  const targets = skillTargets();
  if (!jsonOutput(args)) {
    console.log("Install the AgentContract CLI skill for your AI coding agent.");
    console.log("");
    targets.forEach((target, index) => console.log(`  ${index + 1}) ${target.label} (${target.directory})`));
    console.log("");
  }

  let choice = "2";
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    choice = (await rl.question("Choose install target [2]: ")).trim() || "2";
    rl.close();
  } else {
    choice = readFileSync(0, "utf8").trim() || "2";
  }

  const selected = targets[Number(choice) - 1];
  if (!selected) throw new CliError(`Invalid skill target: ${choice}`, "Pass --directory /path/to/skills to choose manually.");
  return selected.directory;
}

async function installSkill(args: Args) {
  const directory = await chooseSkillDirectory(args);
  const skillDir = join(directory, "agentcontract-cli");
  const skillPath = join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  writeFileSync(skillPath, agentContractSkillMarkdown(), { mode: 0o600 });
  chmodSync(skillPath, 0o600);
  return {
    skill_installed: true,
    directory,
    skill_path: skillPath,
    command_hint: "agentcontract contracts"
  };
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

  const from = cleanString(stringArg(args, "from", "from-email", "sender-email"))
    ?? cleanString(process.env.AGENTCONTRACT_SENDER_EMAIL)
    ?? cleanString(process.env.AGENTSIGN_SENDER_EMAIL)
    ?? cliConfig.sender_email;
  const sender_name = cleanString(stringArg(args, "sender-name"))
    ?? cleanString(process.env.AGENTCONTRACT_SENDER_NAME)
    ?? cleanString(process.env.AGENTSIGN_SENDER_NAME)
    ?? cliConfig.sender_name;
  const notifyFromArgs = listArg(args, "notify", "notify-email", "notification-email");
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
    const { args } = parseArgs(rest);
    printResult(args.check ? await updateCheck(args) : versionResult(), jsonOutput(args));
    return;
  }

  const { args, positional } = parseArgs(rest);

  if (args.help) {
    usage();
    return;
  }

  activeCliTelemetry = {
    id: `run_${nanoid(14)}`,
    command,
    argv,
    args,
    startedAt: new Date().toISOString(),
    startedMs: Date.now()
  };

  await autoUpdateAndMaybeRerun(command, args, argv);

  let result: unknown;
  if (command === "login") {
    result = await login(args);
  } else if (command === "update" || command === "upgrade" || command === "self-update") {
    result = await updateCli(args);
  } else if (command === "skill") {
    result = await installSkill(args);
  } else if (command === "feedback" || command === "bug" || command === "report") {
    result = await productFeedbackCommand(args, positional);
  } else if (command === "session" || command === "sessions" || command === "telemetry") {
    result = await sessionCommand(args, positional);
  } else if (command === "init") {
    result = await initConfig(args);
  } else if (command === "config") {
    result = await configCommand(args, positional);
  } else if (command === "dashboard" || command === "ui" || command === "admin") {
    result = dashboardCommand(args, positional);
  } else if (command === "keys" || command === "api-keys") {
    result = await keyCommand(args, positional.length ? positional : ["list"]);
  } else if (command === "key" || command === "api-key") {
    result = await keyCommand(args, positional);
  } else if (command === "domain" || command === "sender-domain" || command === "sender-profile") {
    result = await domainCommand(args, positional);
  } else if (command === "templates" || command === "template-list") {
    result = await listServerTemplates(args);
  } else if (command === "template" || command === "server-template") {
    result = await templateCommand(args, positional);
  } else if (command === "contracts" || command === "contract-list") {
    result = await listContracts(args);
  } else if (command === "contract" || command === "contracts-lib") {
    result = await contractCommand(args, positional);
  } else if (command === "agreements" || command === "agreement-list") {
    result = await listAgreements(args);
  } else if (command === "batches" || command === "batch-list") {
    result = await listBatches(args);
  } else if (command === "batch" || command === "agreement-batch") {
    result = await batchCommand(args, positional);
  } else if (command === "agreement" || command === "agreements-api") {
    result = await agreementCommand(args, positional);
  } else if (command === "read") {
    result = await readTarget(args, positional);
  } else if (command === "send-mnda" || command === "send-nda") {
    result = await sendMnda(args);
  } else if (command === "send-privacy") {
    result = await sendPrivacy(args);
  } else if (command === "send-contract" || command === "send-agreement") {
    result = await sendContract(args);
  } else if (command === "send-pdf" || command === "send-document" || command === "send-uploaded-pdf") {
    result = await sendPdf(args, positional);
  } else if (command === "bear-mnda" || command === "send-bear-mnda") {
    result = await sendDemoNda(args);
  } else if (command === "marketplace-onboard" || command === "onboard-contributor" || command === "specific-privacy" || command === "send-specific-privacy" || command === "bear-privacy" || command === "send-bear-privacy") {
    result = await sendDemoPrivacy({ ...args, command_name: command });
  } else if (command === "specific-contractor" || command === "marketplace-contractor" || command === "bear-contractor" || command === "send-bear-contractor") {
    result = await sendDemoContractor(args);
  } else if (command === "preview") {
    result = await preview(args);
  } else if (command === "bulk-mnda" || command === "bulk-nda") {
    result = await bulkMnda(args);
  } else if (command === "bulk-marketplace-onboard" || command === "bulk-onboard-contributors") {
    result = await bulkMarketplaceOnboard(args);
  } else if (command === "bulk-specific-contractor" || command === "bulk-contractor" || command === "bulk-bear-contractor" || command === "bulk-marketplace-contractor") {
    result = await bulkDemoContractor(args);
  } else if (command === "doctor") {
    result = await doctor(args);
  } else if (command === "view") {
    result = await view(args, positional);
  } else if (command === "status") {
    result = await status(args, positional);
  } else {
    throw new CliError(`Unknown command: ${command}`, "Run agentcontract help to see available commands.");
  }

  await recordCliTelemetry(0, result);
  printResult(result, jsonOutput(args));
}

main().catch(async (error) => {
  await recordCliTelemetry(1, undefined, error);
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    if (error.usageHint) console.error(`Hint: ${error.usageHint}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
