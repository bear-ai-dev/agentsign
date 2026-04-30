#!/usr/bin/env node

import "dotenv/config";
import { readFileSync } from "node:fs";

type Args = Record<string, string | boolean | string[]>;

const defaultApiUrl = process.env.AGENTSIGN_API_URL ?? process.env.AGENTINK_API_URL ?? "https://agentink-pied.vercel.app";
const defaultApiKey = process.env.AGENTSIGN_API_KEY ?? process.env.AGENTINK_API_KEY;

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
  agentsign send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI" [options]
  agentsign send-privacy --from janak@usebear.ai --to jane@example.com --name "Jane Doe" [options]
  agentsign bulk-mnda --from janak@usebear.ai --file recipients.json --company "Bear AI" [options]
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

function baseMndaPayload(args: Args) {
  const company = requireArg(stringArg(args, "company"), "--company", 'Example: agentsign send-mnda --from janak@usebear.ai --to jane@example.com --name "Jane Doe" --company "Bear AI"');
  return {
    ...sharedSendOptions(args, company),
    template: "nda",
    template_vars: {
      company_name: company,
      effective_date: stringArg(args, "effective-date") ?? today(),
      term_years: Number(stringArg(args, "term-years") ?? 2)
    },
    fields: mndaFields(),
    metadata: { source: "agentsign-cli" }
  };
}

function basePrivacyPayload(args: Args) {
  const company = stringArg(args, "company") ?? "Bear AI";
  return {
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
  };
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
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args));
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...baseMndaPayload(args)
  };
  if (dryRun(args)) return dryRunResult("send-mnda", apiUrl, "/v1/agreements", payload);
  return postJson(apiUrl, apiKey, "/v1/agreements", payload);
}

async function sendPrivacy(args: Args) {
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args));
  const payload = {
    recipient: { name: receiverName(args), email: receiverEmail(args) },
    ...basePrivacyPayload(args)
  };
  if (dryRun(args)) return dryRunResult("send-privacy", apiUrl, "/v1/agreements", payload);
  return postJson(apiUrl, apiKey, "/v1/agreements", payload);
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
  const { apiUrl, apiKey } = apiConfig(args, !dryRun(args));
  const file = requireArg(stringArg(args, "file"), "--file", "Example: agentsign bulk-mnda --from janak@usebear.ai --file recipients.json --company \"Bear AI\"");
  const recipients = normalizeBulkRecipients(JSON.parse(readFileSync(file, "utf8")));
  const base = baseMndaPayload(args);
  const payload = {
    recipients,
    template_vars_default: base.template_vars,
    ...base
  };
  delete (payload as { template_vars?: unknown }).template_vars;
  if (dryRun(args)) return dryRunResult("bulk-mnda", apiUrl, "/v1/agreements/bulk", payload);
  return postJson(apiUrl, apiKey, "/v1/agreements/bulk", payload);
}

async function status(args: Args, positional: string[]) {
  const { apiUrl, apiKey } = apiConfig(args);
  const id = positional[0];
  if (!id) throw new CliError("agreement_id is required", "Example: agentsign status agr_123");
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
