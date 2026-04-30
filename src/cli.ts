#!/usr/bin/env node

import { readFileSync } from "node:fs";

type Args = Record<string, string | boolean | string[]>;

const defaultApiUrl = process.env.AGENTSIGN_API_URL ?? process.env.AGENTINK_API_URL ?? "https://agentink-pied.vercel.app";
const defaultApiKey = process.env.AGENTSIGN_API_KEY ?? process.env.AGENTINK_API_KEY;

function usage() {
  console.log(`AgentSign CLI

Usage:
  agentsign send-mnda --name "Jane Doe" --email jane@example.com --company "Bear AI" [options]
  agentsign send-privacy --name "Jane Doe" --email jane@example.com [options]
  agentsign bulk-mnda --file recipients.json --company "Bear AI" [options]
  agentsign status <agreement_id> [options]

Options:
  --api-url <url>          API base URL. Defaults to AGENTSIGN_API_URL or ${defaultApiUrl}
  --api-key <key>          API key. Defaults to AGENTSIGN_API_KEY or AGENTINK_API_KEY
  --notify <email[,email]> Email sender when the agreement is signed
  --cc <email[,email]>     CC the signing request email
  --webhook-url <url>      Machine webhook for agreement.completed
  --effective-date <date>  Defaults to today
  --term-years <years>     Defaults to 2
  --service <name>         Privacy policy service name. Defaults to Bear AI
  --website <url>          Privacy policy website. Defaults to https://usebear.ai
  --contact <email>        Privacy policy contact email. Defaults to sid@usebear.ai
  --address <text>         Privacy policy company address
  --json                   Print raw JSON only

Bulk JSON can be either an array of recipients or { "recipients": [...] }.
Each recipient should have "name" and "email".`);
}

function parseArgs(argv: string[]) {
  const args: Args = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;

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

function listArg(args: Args, key: string) {
  const value = args[key];
  if (!value || value === true) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => String(entry).split(",")).map((email) => email.trim()).filter(Boolean);
}

function requireArg(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function apiConfig(args: Args) {
  const apiUrl = (stringArg(args, "api-url") ?? defaultApiUrl).replace(/\/+$/, "");
  const apiKey = stringArg(args, "api-key") ?? defaultApiKey;
  if (!apiKey) throw new Error("API key missing. Set AGENTSIGN_API_KEY or pass --api-key.");
  return { apiUrl, apiKey };
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

async function postJson(apiUrl: string, apiKey: string, path: string, body: unknown) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

async function getJson(apiUrl: string, apiKey: string, path: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

function baseMndaPayload(args: Args) {
  const company = requireArg(stringArg(args, "company"), "--company");
  const notify = listArg(args, "notify");
  if (notify.length === 0 && process.env.AGENTSIGN_NOTIFY_EMAIL) {
    notify.push(...process.env.AGENTSIGN_NOTIFY_EMAIL.split(",").map((email) => email.trim()).filter(Boolean));
  }
  const cc = listArg(args, "cc");
  const webhookUrl = stringArg(args, "webhook-url");
  return {
    cc: cc.length ? cc : undefined,
    notification_email: notify.length ? notify : undefined,
    template: "nda",
    template_vars: {
      company_name: company,
      effective_date: stringArg(args, "effective-date") ?? today(),
      term_years: Number(stringArg(args, "term-years") ?? 2)
    },
    fields: mndaFields(),
    webhook_url: webhookUrl,
    metadata: { source: "agentsign-cli" }
  };
}

function notificationArgs(args: Args) {
  const notify = listArg(args, "notify");
  if (notify.length === 0 && process.env.AGENTSIGN_NOTIFY_EMAIL) {
    notify.push(...process.env.AGENTSIGN_NOTIFY_EMAIL.split(",").map((email) => email.trim()).filter(Boolean));
  }
  return notify;
}

function basePrivacyPayload(args: Args) {
  const company = stringArg(args, "company") ?? "Bear AI";
  const notify = notificationArgs(args);
  const cc = listArg(args, "cc");
  const webhookUrl = stringArg(args, "webhook-url");
  return {
    cc: cc.length ? cc : undefined,
    notification_email: notify.length ? notify : undefined,
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
    webhook_url: webhookUrl,
    metadata: { source: "agentsign-cli", template_kind: "privacy_policy" }
  };
}

function printResult(result: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
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
    const agreement = result as { id: string; status?: string; signing_url?: string; webhook_secret?: string | null; notification_email?: string[] };
    console.log(`Sent agreement: ${agreement.id}`);
    if (agreement.status) console.log(`Status: ${agreement.status}`);
    if (agreement.signing_url) console.log(`Signing URL: ${agreement.signing_url}`);
    if (agreement.webhook_secret) console.log(`Webhook secret: ${agreement.webhook_secret}`);
    if (agreement.notification_email?.length) console.log(`Notify on signed: ${agreement.notification_email.join(", ")}`);
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

async function sendMnda(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const name = requireArg(stringArg(args, "name"), "--name");
  const email = requireArg(stringArg(args, "email", "to"), "--email");
  const payload = {
    recipient: { name, email },
    ...baseMndaPayload(args)
  };
  return postJson(apiUrl, apiKey, "/v1/agreements", payload);
}

async function sendPrivacy(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const name = requireArg(stringArg(args, "name"), "--name");
  const email = requireArg(stringArg(args, "email", "to"), "--email");
  const payload = {
    recipient: { name, email },
    ...basePrivacyPayload(args)
  };
  return postJson(apiUrl, apiKey, "/v1/agreements", payload);
}

async function bulkMnda(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args);
  const file = requireArg(stringArg(args, "file"), "--file");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const recipients = Array.isArray(parsed) ? parsed : parsed.recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error("Bulk file must contain recipients");
  const payload = {
    recipients,
    template_vars_default: baseMndaPayload(args).template_vars,
    ...baseMndaPayload(args)
  };
  delete (payload as { template_vars?: unknown }).template_vars;
  return postJson(apiUrl, apiKey, "/v1/agreements/bulk", payload);
}

async function status(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new Error("agreement_id is required");
  return getJson(apiUrl, apiKey, `/v1/agreements/${id}`);
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
  } else if (command === "bulk-mnda" || command === "bulk-nda") {
    result = await bulkMnda(args);
  } else if (command === "status") {
    result = await status(args, positional);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  printResult(result, Boolean(args.json));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
