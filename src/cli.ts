#!/usr/bin/env node

import "dotenv/config";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

const cliVersion = "0.1.14";
const packageName = "@bear-ai-dev/agentcontract";
const configPath = process.env.AGENTCONTRACT_CONFIG ?? join(homedir(), ".agentcontract", "config.json");
const contractsDir = process.env.AGENTCONTRACT_CONTRACTS_DIR ?? join(dirname(configPath), "contracts");
let configLoadError: string | undefined;
const cliConfig = loadCliConfig();
const defaultApiUrl = cleanString(process.env.AGENTCONTRACT_API_URL)
  ?? cleanString(process.env.AGENTSIGN_API_URL)
  ?? cleanString(process.env.AGENTINK_API_URL)
  ?? configString("api_url")
  ?? "https://agentcontract.to";
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
  agentcontract login --email sid@usebear.ai
  agentcontract update --check
  agentcontract skill
  agentcontract session start --agent codex --goal "send onboarding agreements"
  agentcontract session event --session-id sess_123 --type user_message --role user --text "Approved send"
  agentcontract init --api-url https://agentcontract.to [options]
  agentcontract config get
  agentcontract keys
  agentcontract key create --key-name "Sid laptop"
  agentcontract key revoke key_123
  agentcontract templates
  agentcontract template read privacy --out ./privacy.md
  agentcontract template send nda --to jane@example.com --name "Jane Doe"
  agentcontract contracts
  agentcontract read privacy --var effective_date=2026-04-29
  agentcontract agreements --status sent --limit 20
  agentcontract agreement read agr_123 --out ./agreement.md
  agentcontract agreement audit agr_123
  agentcontract agreement pdf agr_123 --out ./agreement.pdf
  agentcontract contract show privacy
  agentcontract contract add partner-msa --markdown-file ./partner-msa.md --fields-file ./fields.json
  agentcontract contract feedback partner-msa --note "Use California law and shorten the termination section"
  agentcontract contract edit partner-msa
  agentcontract contract read partner-msa --with-feedback
  agentcontract feedback --message "Login code never arrived" --command "agentcontract login --email sid@usebear.ai"
  agentcontract feedback list --json
  agentcontract contract preview partner-msa --var company_name="Bear AI" --preview-file ./preview.html
  agentcontract contract send partner-msa --to jane@example.com --name "Jane Doe" [options]
  agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor" [options]
  agentcontract bulk-marketplace-onboard --file contributors.json [options]
  agentcontract specific-contractor --to jane@example.com --name "Jane Doe" [options]
  agentcontract bear-mnda --to jane@example.com --name "Jane Doe" [options]
  agentcontract specific-privacy --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI" [options]
  agentcontract send-privacy --from janak@usebear.ai --to jane@example.com --name "Jane Doe" [options]
  agentcontract send-contract --from sid@usebear.ai --to jane@example.com --name "Jane Doe" --template contractor [options]
  agentcontract preview --template contractor --var company_name="Specific Marketplace" --preview-file ./preview.html
  agentcontract bulk-mnda --from janak@usebear.ai --file recipients.json --company "Bear AI" [options]
  agentcontract doctor [options]
  agentcontract status <agreement_id> [options]
  agentcontract update
  agentcontract version

The legacy "agentsign" command name is also supported when installed from npm.

Setup:
  agentcontract login                    Browser login via WorkOS/Google Workspace, saves config automatically
  agentcontract login --email <email>    Email-code login. Use when browser redirect is blocked
  agentcontract skill                    Print AI-agent setup instructions
  agentcontract skill --install          Install/update the AI-agent skill
  agentcontract update                  Check hosted version and update this CLI
  agentcontract session start           Start a lightweight AgentContract task session
  agentcontract session event           Record a message or decision on a task session
  agentcontract init                    Save API URL/key and sender defaults to ${configPath}
  agentcontract config get              Show saved config with secrets masked
  agentcontract feedback                Report CLI/product breakage to AgentContract
  agentcontract config path             Print the config path
  agentcontract keys                    List user-owned API keys without opening the dashboard
  agentcontract key create              Create another user-owned API key from the current key
  agentcontract key revoke <key_id>     Revoke a user-owned API key
  agentcontract templates               List server templates from the API
  agentcontract template read <id>      Print server template markdown from the API
  agentcontract contracts               List built-in and local reusable contracts
  agentcontract read <id>               Print rendered contract text. Works for local contract ids and agr_* ids
  agentcontract contract edit <id>      Open a contract markdown file in $EDITOR
  agentcontract agreement read <id>     Print a sent agreement's markdown from the API

Sender / Receiver:
  --from, --from-email, --sender-email <email>
                                      Human sender. Used as Reply-To and default signed notification target
  --sender-name <name>               Human sender name shown in request email
  --to, --email, --receiver-email    Recipient email
  --name, --receiver-name <name>     Recipient name
  --cc <email[,email]>               CC the signing request email
  --notify, --notify-email <email[,email]>
                                      Override who gets emailed when the agreement is signed

Options:
  --api-url <url>                    API base URL. Defaults to AGENTCONTRACT_API_URL or ${defaultApiUrl}
  --api-key <key>                    API key. Defaults to AGENTCONTRACT_API_KEY or AGENTSIGN_API_KEY
  --api-key-stdin                    Read API key from stdin for init/send commands
  --key-name <name>                  Name for a key created by login. Defaults to AgentContract CLI
  --email <email>                    Use email-code login instead of browser login
  --code <123456>                    Login code for email-code login. Omit to type it interactively
  --install                          Install the skill instead of printing it
  --timeout-ms <ms>                  Login callback timeout. Defaults to 300000
  --webhook-url <url>                Machine webhook for agreement.completed
  --signing-order <order>            Counter-sign order: parallel, sender_first, or recipient_first
  --template <name>                  Template for send-contract/preview: nda, privacy, contractor, mutual-nda, one-way-nda, privacy-policy
  --var <key=value>                  Template variable. Repeatable
  --vars-json <json>                 Template variables as JSON
  --vars-file <path>                 Template variables JSON file
  --markdown-file <path>             Custom markdown contract file
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
  --session-id <id>                  Session id for agentcontract session event/show/end
  --type, --event-type <name>        Session event type. Defaults to note
  --role, --actor-role <name>        Session event actor role, such as user or assistant
  --text <text>                      Session event text
  --content-json <json>              Structured JSON payload for a session event
  --metadata-json <json>             Metadata JSON object for a session event
  --with-feedback                    Include feedback when reading/showing a contract
  --author <name>                    Human or agent name for contract feedback
  --from-template <name>             Seed contract add from built-in: nda, privacy, contractor, mutual-nda, one-way-nda, privacy-policy
  --contract-dir <path>              Override local contract library directory for this command
  --directory <path>                 Install skill into this skills directory
  --editor <command>                 Editor used by contract edit. Defaults to VISUAL or EDITOR
  --no-open                          Print auth URL instead of opening a browser
  --force                            Overwrite existing local config or contract copy when supported
  --preview                          Render local HTML preview instead of sending
  --preview-file <path>              Where to write preview HTML
  --out, --output-file <path>        Write text/PDF output to a file
  --open                             Open preview/signing URL in the browser
  --scope <text>                     Legacy contractor scope override for custom templates
  --rate <amount>                    Legacy contractor rate override for custom templates
  --start-date <date>                Legacy contractor start date override for custom templates
  --effective-date <date>            Defaults to today, except Specific privacy defaults to April 29, 2026
  --term-years <years>               MNDA term. Defaults to 2
  --website <url>                    Legacy privacy override. Specific template hardcodes usespecific.com
  --contact <email>                  Legacy privacy override. Specific template hardcodes sid@usebear.ai
  --address <text>                   Legacy privacy override. Specific template hardcodes 39 Tehama
  --dry-run                          Print the request without sending it
  --json                             Print raw JSON only
  --check                            Check for updates without installing
  --yes                              Skip update confirmation prompts
  --latest-version <version>          Test/override latest version for update checks
  --package-manager <npm|pnpm|yarn|bun>
                                      Use a package manager instead of hosted installer for updates
  --registry <url>                   npm registry for package-manager update checks
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
    "https://agentcontract.to"
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

function defaultFieldsFor(template: string | undefined) {
  const definition = template ? templateDefinitions[template as keyof typeof templateDefinitions] : undefined;
  if (definition) return definition.fields;
  if (template === "privacy" || template === "privacy-policy") return privacyFields();
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
    args: ["-c", `curl -fsSL ${shellQuote(scriptUrl)} | bash`],
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
  if (override) return { latestVersion: override, registryUrl: null as string | null, source: "override" };

  if (!usePackageManagerUpdate(args)) {
    const { apiUrl } = apiConfig(args, false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({})) as { version?: unknown };
      if (!response.ok) throw new CliError(`Could not check hosted CLI version: ${response.status} ${response.statusText}`);
      const latestVersion = typeof result.version === "string" ? result.version : "";
      if (!latestVersion) throw new CliError("Hosted AgentContract response did not include a version");
      return { latestVersion, registryUrl: null as string | null, source: "hosted" };
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
    const result = await response.json().catch(() => ({})) as { version?: unknown };
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
  const activeVersion = verifyActiveCliVersion(check.latest_version, installCommand);
  return { ...check, updated: true, command: installCommand, active_version: activeVersion };
}

function parseCliVersionOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Fall through to the text parser for older CLIs.
    }
  }
  return trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function verifyActiveCliVersion(expectedVersion: string, installCommand: string) {
  const result = spawnSync("agentcontract", ["--version", "--json"], {
    stdio: "pipe",
    encoding: "utf8"
  });
  if (result.error) {
    throw new CliError(`Update installed, but the active AgentContract CLI could not be checked: ${result.error.message}`, installCommand);
  }
  const output = `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
  const activeVersion = parseCliVersionOutput(output);
  if (result.status !== 0 || !activeVersion) {
    throw new CliError("Update installed, but the active AgentContract CLI could not be checked.", installCommand);
  }
  if (compareVersions(activeVersion, expectedVersion) < 0) {
    throw new CliError(
      `Update installed, but the active AgentContract CLI is still ${activeVersion}; expected ${expectedVersion}. Your PATH is probably resolving an older agentcontract binary.`,
      `Run ${installCommand}, then run agentcontract --version. If it is still old, remove the older agentcontract binary from PATH.`
    );
  }
  return activeVersion;
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
  const notify = listArg(args, "notify", "notify-email", "notification-email");
  if (notify.length === 0) notify.push(...parseEmailList(process.env.AGENTCONTRACT_NOTIFY_EMAIL));
  if (notify.length === 0) notify.push(...parseEmailList(process.env.AGENTSIGN_NOTIFY_EMAIL));
  if (notify.length === 0 && cliConfig.notify_email?.length) notify.push(...cliConfig.notify_email);
  if (notify.length === 0 && defaultEmail) notify.push(defaultEmail);
  return validateEmailList(notify, "--notify");
}

function signingOrderArg(args: Args) {
  const value = cleanString(stringArg(args, "signing-order", "order"));
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "parallel" || normalized === "sender_first" || normalized === "recipient_first") return normalized;
  throw new CliError("--signing-order must be parallel, sender_first, or recipient_first");
}

function sharedSendOptions(args: Args, fallbackSenderName?: string) {
  const sender_email = senderEmail(args);
  const cc = validateEmailList(listArg(args, "cc"), "--cc");
  const notify = notificationArgs(args, sender_email);
  const signing_order = signingOrderArg(args);
  return {
    cc: cc.length ? cc : undefined,
    sender_email,
    sender_name: senderName(args, fallbackSenderName),
    notification_email: notify.length ? notify : undefined,
    webhook_url: stringArg(args, "webhook-url"),
    signing_order
  };
}

function withBearDefaults(args: Args): Args {
  return {
    ...args,
    from: stringArg(args, "from", "from-email", "sender-email") ?? bearDefaults.senderEmail,
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
  template_vars?: Record<string, unknown>;
  fields?: Array<Record<string, unknown>>;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
  sender_signature_required?: boolean;
  sender_fields?: Array<Record<string, unknown>>;
  signing_order?: string;
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
    sender_signature_required: true,
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
  const markdown = markdownFromArgs(args);
  const template = stringArg(args, "template") ?? (markdown ? undefined : "contractor");
  if (!template && !markdown) {
    throw new CliError("send-contract needs --template or --markdown-file");
  }
  const vars = templateVarsFromArgs(args);
  const definition = template ? templateDefinitions[template as keyof typeof templateDefinitions] : undefined;
  const defaultVars = definition ? defaultTemplateVars(definition) : {};
  const company = stringArg(args, "company") ?? String(vars.company_name ?? defaultVars.company_name ?? "Bear AI");
  const senderSignatureRequired = template === "nda" || template === "mutual-nda";
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
    ...(senderSignatureRequired ? { sender_signature_required: true } : {}),
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
  const configuredSenderEmail = senderEmail(args);
  const configuredSenderName = senderName(args);
  const specificArgs = {
    ...args,
    from: stringArg(args, "from", "from-email", "sender-email") ?? configuredSenderEmail ?? specificPrivacyDefaults.senderEmail,
    "sender-name": stringArg(args, "sender-name") ?? configuredSenderName ?? specificPrivacyDefaults.senderName
  };
  const payload = basePrivacyPayload(specificArgs);
  return {
    ...payload,
    metadata: { ...(payload.metadata ?? {}), workflow: "specific_privacy_acknowledgement", company: specificPrivacyDefaults.companyName }
  };
}

function baseBearContractorPayload(args: Args) {
  const configuredSenderEmail = senderEmail(args);
  const configuredSenderName = senderName(args);
  const specificArgs = {
    ...args,
    from: stringArg(args, "from", "from-email", "sender-email") ?? configuredSenderEmail ?? specificPrivacyDefaults.senderEmail,
    "sender-name": stringArg(args, "sender-name") ?? configuredSenderName ?? specificPrivacyDefaults.senderName
  };
  const vars = templateVarsFromArgs(args);
  const defaults = defaultTemplateVars(templateDefinitions.contractor);

  return withCustomContractArgs(specificArgs, {
    ...sharedSendOptions(specificArgs, specificPrivacyDefaults.senderName),
    template: "contractor",
    template_vars: {
      ...defaults,
      effective_date: stringArg(args, "effective-date") ?? defaults.effective_date,
      ...vars
    },
    fields: contractorFields(),
    metadata: {
      source: "agentcontract-cli",
      workflow: "specific_contributor_terms",
      company: specificPrivacyDefaults.companyName
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

  if (typeof result === "string") {
    console.log(result);
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
      updated?: boolean;
      cancelled?: boolean;
      dry_run?: boolean;
      already_latest?: boolean;
      command?: string;
      install_command?: string;
    };
    console.log(`${update.package ?? packageName} ${update.current_version ?? cliVersion}`);
    console.log(`Latest: ${update.latest_version ?? "unknown"}`);
    if (update.updated) {
      console.log("Updated.");
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
    const list = result as { agreements: Array<{ id: string; status?: string; signing_url?: string; document_title?: string; recipient?: { name?: string; email?: string }; created_at?: string }>; next_cursor?: string | null };
    console.log(`Agreements: ${list.agreements.length}`);
    for (const agreement of list.agreements) {
      const recipient = agreement.recipient?.email ? ` ${agreement.recipient.name ?? ""} <${agreement.recipient.email}>` : "";
      const title = agreement.document_title ? ` - ${agreement.document_title}` : "";
      const status = agreement.status ? ` [${agreement.status}]` : "";
      const url = agreement.signing_url ? ` ${agreement.signing_url}` : "";
      console.log(`${agreement.id}${status}${recipient}${title}${url}`);
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
      signing_order?: string;
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
    if (agreement.signing_url) console.log(`Signing URL: ${agreement.signing_url}`);
    if (agreement.sender_signing_url) console.log(`Sender Signing URL: ${agreement.sender_signing_url}`);
    if (agreement.signing_order) console.log(`Signing Order: ${agreement.signing_order}`);
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
  if (dryRun(args)) return dryRunResult("specific-contractor", apiUrl, "/v1/agreements", payload);
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
  if (dryRun(args)) return dryRunResult("contract send", apiUrl, "/v1/agreements", payload);
  const result = await postJson(apiUrl, apiKey, "/v1/agreements", payload);
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
      'Example: agentcontract feedback --message "Login code never arrived" --command "agentcontract login --email sid@usebear.ai"'
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

function sessionMetadata(args: Args) {
  const metadata: Record<string, unknown> = {
    cli_version: cliVersion,
    package: packageName
  };
  if (args["no-auto-update"]) metadata.no_auto_update = true;
  const contextFile = stringArg(args, "chat-context-file", "context-file");
  if (contextFile) metadata.chat_context = parseJsonFile(contextFile, "--chat-context-file");
  const chatSummary = cleanString(stringArg(args, "chat-summary"));
  if (chatSummary) metadata.chat_summary = chatSummary;
  const reasonSent = cleanString(stringArg(args, "reason-sent"));
  if (reasonSent) metadata.reason_sent = reasonSent;
  const approvalMessage = cleanString(stringArg(args, "approval-message"));
  if (approvalMessage) metadata.approval_message = approvalMessage;
  return metadata;
}

async function startSession(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args));
  const goal = (stringArg(args, "goal", "initial-goal") ?? positional.join(" ").trim()) || undefined;
  const payload = {
    agent: stringArg(args, "agent") ?? "unknown",
    goal,
    source: "agentcontract-cli",
    privacy_mode: stringArg(args, "privacy-mode") ?? "full",
    metadata: sessionMetadata(args)
  };
  if (dryRun(args)) return dryRunResult("session start", apiUrl, "/v1/sessions", payload);
  return postJson(apiUrl, apiKey, "/v1/sessions", payload);
}

async function listSessions(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const query = new URLSearchParams();
  const limit = stringArg(args, "limit");
  if (limit) query.set("limit", limit);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return getJson(apiUrl, apiKey, `/v1/sessions${suffix}`);
}

async function showSession(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0] ?? stringArg(args, "id", "session-id");
  if (!id) throw new CliError("session_id is required", "Example: agentcontract session show sess_123");
  return getJson(apiUrl, apiKey, `/v1/sessions/${id}`);
}

async function endSession(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0] ?? stringArg(args, "id", "session-id");
  if (!id) throw new CliError("session_id is required", "Example: agentcontract session end sess_123");
  return postJson(apiUrl, apiKey, `/v1/sessions/${id}/end`, {
    outcome: stringArg(args, "outcome")
  });
}

async function addSessionEvent(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args));
  const id = cleanString(stringArg(args, "session-id", "id") ?? positional[0]);
  if (!id) throw new CliError("session_id is required", "Example: agentcontract session event --session-id sess_123 --type user_message --text \"Sent agreements\"");
  const positionalText = positional.length > 1 ? positional.slice(1).join(" ") : undefined;
  const contentText = cleanString(stringArg(args, "text", "content", "message") ?? positionalText);
  const contentJson = stringArg(args, "content-json", "json-content");
  const metadataJson = stringArg(args, "metadata-json");
  const payload = {
    event_type: cleanString(stringArg(args, "type", "event-type")) ?? "note",
    actor_role: cleanString(stringArg(args, "role", "actor-role")),
    ...(contentText ? { content_text: contentText } : {}),
    ...(contentJson ? { content_json: parseJsonArg(contentJson, "--content-json") } : {}),
    ...(metadataJson ? { metadata: parseJsonObjectArg(metadataJson, "--metadata-json") } : {})
  };
  if (dryRun(args)) return dryRunResult("session event", apiUrl, `/v1/sessions/${id}/events`, payload);
  return postJson(apiUrl, apiKey, `/v1/sessions/${id}/events`, payload);
}

async function sessionCommand(args: Args, positional: string[]) {
  const action = positional[0] ?? "start";
  const rest = positional.slice(1);
  if (action === "start" || action === "new") return startSession(args, rest);
  if (action === "event" || action === "add-event" || action === "record") return addSessionEvent(args, rest);
  if (action === "list" || action === "ls") return listSessions(args);
  if (action === "show" || action === "status") return showSession(args, rest);
  if (action === "end" || action === "close" || action === "finish") return endSession(args, rest);
  return startSession(args, positional);
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

async function listServerTemplates(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  return getJson(apiUrl, apiKey, "/v1/templates");
}

async function getServerTemplate(args: Args, id: string) {
  const { apiUrl, apiKey } = apiConfig(args);
  return getJson(apiUrl, apiKey, `/v1/templates/${id}`) as Promise<{
    template?: { id?: string; name?: string; description?: string };
    markdown?: string;
    default_template_vars?: Record<string, unknown>;
  }>;
}

async function showServerTemplate(args: Args, positional: string[]) {
  const id = assertContractId(stringArg(args, "id", "template") ?? positional[0]);
  const result = await getServerTemplate(args, id);
  return {
    server_template: true,
    id: result.template?.id ?? id,
    name: result.template?.name,
    description: result.template?.description,
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
      id: result.template?.id ?? id,
      name: result.template?.name,
      description: result.template?.description,
      ...result,
      markdown: result.markdown,
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
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentcontract agreement remind agr_123");
  return postJson(apiUrl, apiKey, `/v1/agreements/${id}/remind`, {});
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
    requireArg(stringArg(args, "email", "login-email"), "--email", "Example: agentcontract login --email sid@usebear.ai"),
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
agentcontract login --email sid@usebear.ai
agentcontract config get
agentcontract doctor
agentcontract keys

If the user is not logged in, run \`agentcontract login --email <email>\`; it sends an email code and stores a local API key after verification. Browser WorkOS login is also available with \`agentcontract login\` once the WorkOS redirect URI is registered.

## Core Commands

agentcontract keys
agentcontract key create --key-name "Agent laptop"
agentcontract key revoke key_...
agentcontract templates
agentcontract template read privacy --out ./privacy.md
agentcontract contracts
agentcontract read privacy --var effective_date="April 29, 2026"
agentcontract contract show contractor --markdown
agentcontract contract add custom-sow --markdown-file ./contract.md --fields-file ./fields.json
agentcontract contract feedback custom-sow --note "Make the IP assignment clearer"
agentcontract contract read custom-sow --with-feedback
agentcontract contract edit custom-sow
agentcontract contract send custom-sow --to jane@example.com --name "Jane Doe" --json
agentcontract feedback --message "What broke" --command "exact command" --expected "expected result" --actual "actual result or error" --json

## Built-ins

- \`nda\`: Bear AI mutual NDA
- \`privacy\`: Specific Marketplace privacy acknowledgement
- \`contractor\`: Specific Marketplace contributor terms

## Sending

agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor" --json
agentcontract specific-contractor --to contributor@example.com --name "Jane Contributor" --json
agentcontract bear-mnda --to jane@example.com --name "Jane Doe" --json

## Tracking

agentcontract agreements --status sent --json
agentcontract status agr_... --json
agentcontract agreement read agr_... --out ./agreement.md
agentcontract agreement audit agr_...
agentcontract agreement remind agr_...
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
- Prefer \`--dry-run --json\` before bulk sends.
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
  if (!args.install && !stringArg(args, "directory", "dir")) {
    return agentContractSkillMarkdown();
  }

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
      ?? "https://agentcontract.to"
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

  let result: unknown;
  if (command === "login") {
    result = await login(args);
  } else if (command === "update" || command === "upgrade" || command === "self-update") {
    result = await updateCli(args);
  } else if (command === "skill") {
    result = await installSkill(args);
  } else if (command === "session" || command === "sessions") {
    result = await sessionCommand(args, positional);
  } else if (command === "feedback" || command === "bug" || command === "report") {
    result = await productFeedbackCommand(args, positional);
  } else if (command === "init") {
    result = await initConfig(args);
  } else if (command === "config") {
    result = await configCommand(args, positional);
  } else if (command === "keys" || command === "api-keys") {
    result = await keyCommand(args, positional.length ? positional : ["list"]);
  } else if (command === "key" || command === "api-key") {
    result = await keyCommand(args, positional);
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
  } else if (command === "bear-mnda" || command === "send-bear-mnda") {
    result = await sendBearMnda(args);
  } else if (command === "marketplace-onboard" || command === "onboard-contributor" || command === "specific-privacy" || command === "send-specific-privacy" || command === "bear-privacy" || command === "send-bear-privacy") {
    result = await sendBearPrivacy({ ...args, command_name: command });
  } else if (command === "specific-contractor" || command === "marketplace-contractor" || command === "bear-contractor" || command === "send-bear-contractor") {
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
