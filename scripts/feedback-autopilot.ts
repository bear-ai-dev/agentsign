import "dotenv/config";
import { execFileSync } from "node:child_process";
import pg from "pg";

type FeedbackStatus = "open" | "in_progress" | "closed";

type ProductFeedback = {
  id: string;
  owner_email: string | null;
  reporter_email: string | null;
  reporter_name: string | null;
  source: string;
  category: string;
  severity: string;
  command: string | null;
  message: string;
  expected: string | null;
  actual: string | null;
  context_json: string | null;
  status: FeedbackStatus;
  created_at: string;
};

type ResendEmail = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
};

const severityOrder = `
  CASE severity
    WHEN 'blocker' THEN 5
    WHEN 'high' THEN 4
    WHEN 'normal' THEN 3
    WHEN 'low' THEN 2
    WHEN 'note' THEN 1
    ELSE 0
  END DESC,
  created_at ASC
`;

function cleanEnv(value: string | undefined, fallback = "") {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function cleanUrl(value: string | undefined, fallback: string) {
  return cleanEnv(value, fallback).replace(/\/+$/, "");
}

function flag(args: string[], ...names: string[]) {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1] ?? "";
    const prefix = `${name}=`;
    const match = args.find((arg) => arg.startsWith(prefix));
    if (match) return match.slice(prefix.length);
  }
  return "";
}

function hasFlag(args: string[], ...names: string[]) {
  return names.some((name) => args.includes(name));
}

function numberFlag(args: string[], name: string, fallback: number) {
  const value = Number(flag(args, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function json(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function postgresSsl(databaseUrl: string) {
  const sslSetting = (process.env.PGSSLMODE ?? process.env.DATABASE_SSL ?? "").toLowerCase();
  if (sslSetting === "disable" || sslSetting === "false" || sslSetting === "0") return false;

  const hostname = new URL(databaseUrl).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
  return { rejectUnauthorized: false };
}

async function withPg<T>(run: (client: pg.PoolClient) => Promise<T>) {
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);
  if (!databaseUrl) throw new Error("DATABASE_URL is required for direct feedback table access");

  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
    await pool.end();
  }
}

function apiUrl() {
  return cleanUrl(process.env.AGENTCONTRACT_API_URL ?? process.env.AGENTSIGN_API_URL ?? process.env.BASE_URL, "https://agentcontract.to");
}

function apiKey() {
  return cleanEnv(process.env.AGENTCONTRACT_API_KEY ?? process.env.AGENTSIGN_API_KEY ?? process.env.AGENTINK_API_KEY);
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("AGENTCONTRACT_API_KEY is required when DATABASE_URL is not set");

  const response = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...init.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : response.statusText);
  }
  return body as T;
}

async function listOpenFeedback(limit: number) {
  if (process.env.DATABASE_URL) {
    return withPg(async (client) => {
      const result = await client.query<ProductFeedback>(
        `SELECT * FROM product_feedback WHERE status = 'open' ORDER BY ${severityOrder} LIMIT $1`,
        [limit]
      );
      return result.rows;
    });
  }

  const response = await apiRequest<{ feedback: ProductFeedback[] }>(`/v1/feedback?status=open&limit=${limit}`);
  return response.feedback;
}

async function getFeedback(id: string) {
  if (process.env.DATABASE_URL) {
    return withPg(async (client) => {
      const result = await client.query<ProductFeedback>("SELECT * FROM product_feedback WHERE id = $1 LIMIT 1", [id]);
      return result.rows[0] ?? null;
    });
  }

  const response = await apiRequest<{ feedback: ProductFeedback[] }>("/v1/feedback?limit=100");
  return response.feedback.find((item) => item.id === id) ?? null;
}

async function setFeedbackStatus(id: string, status: FeedbackStatus) {
  if (process.env.DATABASE_URL) {
    return withPg(async (client) => {
      const result = await client.query<ProductFeedback>(
        "UPDATE product_feedback SET status = $1 WHERE id = $2 RETURNING *",
        [status, id]
      );
      return result.rows[0] ?? null;
    });
  }

  const response = await apiRequest<{ feedback: ProductFeedback }>(`/v1/feedback/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  return response.feedback;
}

async function claimFeedback(id?: string) {
  if (process.env.DATABASE_URL) {
    return withPg(async (client) => {
      await client.query("BEGIN");
      try {
        const result = id
          ? await client.query<ProductFeedback>(
              "UPDATE product_feedback SET status = 'in_progress' WHERE id = $1 AND status = 'open' RETURNING *",
              [id]
            )
          : await client.query<ProductFeedback>(`
              WITH picked AS (
                SELECT id FROM product_feedback
                WHERE status = 'open'
                ORDER BY ${severityOrder}
                LIMIT 1
                FOR UPDATE SKIP LOCKED
              )
              UPDATE product_feedback feedback
              SET status = 'in_progress'
              FROM picked
              WHERE feedback.id = picked.id
              RETURNING feedback.*
            `);
        await client.query("COMMIT");
        return result.rows[0] ?? null;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  const feedback = id ? await getFeedback(id) : (await listOpenFeedback(1))[0] ?? null;
  if (!feedback || feedback.status !== "open") return null;
  return setFeedbackStatus(feedback.id, "in_progress");
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function gitConfigEmail() {
  try {
    return execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function notificationRecipients(args: string[]) {
  const configured = [
    flag(args, "--to", "--recipient"),
    process.env.AGENTCONTRACT_AUTOPILOT_NOTIFY_EMAIL,
    process.env.AGENTCONTRACT_NOTIFY_EMAIL,
    process.env.AGENTSIGN_NOTIFY_EMAIL,
    process.env.AGENTCONTRACT_SENDER_EMAIL,
    process.env.AGENTSIGN_SENDER_EMAIL,
    process.env.EMAIL_TO,
    gitConfigEmail()
  ];
  return configured
    .flatMap((value) => cleanEnv(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildNotificationEmail(input: {
  recipients: string[];
  feedback?: ProductFeedback | null;
  prUrl: string;
  deploymentUrl: string;
  mergeCommit: string;
  summary: string;
}) {
  const feedback = input.feedback;
  const feedbackTitle = feedback ? `${feedback.id} (${feedback.severity}/${feedback.category})` : "feedback item";
  const subject = `AgentContract feedback fix merged and deployed: ${feedback?.id ?? "complete"}`;
  const lines = [
    "Merged and deployed an AgentContract feedback fix.",
    "",
    `Feedback: ${feedbackTitle}`,
    feedback?.message ? `Message: ${feedback.message}` : "",
    feedback?.command ? `Command: ${feedback.command}` : "",
    input.summary ? `Summary: ${input.summary}` : "",
    input.prUrl ? `PR: ${input.prUrl}` : "",
    input.deploymentUrl ? `Deployment: ${input.deploymentUrl}` : "",
    input.mergeCommit ? `Merge commit: ${input.mergeCommit}` : ""
  ].filter(Boolean);
  const html = [
    "<p>Merged and deployed an AgentContract feedback fix.</p>",
    "<ul>",
    `<li><strong>Feedback:</strong> ${escapeHtml(feedbackTitle)}</li>`,
    feedback?.message ? `<li><strong>Message:</strong> ${escapeHtml(feedback.message)}</li>` : "",
    feedback?.command ? `<li><strong>Command:</strong> <code>${escapeHtml(feedback.command)}</code></li>` : "",
    input.summary ? `<li><strong>Summary:</strong> ${escapeHtml(input.summary)}</li>` : "",
    input.prUrl ? `<li><strong>PR:</strong> <a href="${escapeHtml(input.prUrl)}">${escapeHtml(input.prUrl)}</a></li>` : "",
    input.deploymentUrl ? `<li><strong>Deployment:</strong> <a href="${escapeHtml(input.deploymentUrl)}">${escapeHtml(input.deploymentUrl)}</a></li>` : "",
    input.mergeCommit ? `<li><strong>Merge commit:</strong> <code>${escapeHtml(input.mergeCommit)}</code></li>` : "",
    "</ul>"
  ].filter(Boolean).join("");

  return {
    from: `${cleanEnv(process.env.EMAIL_FROM_NAME, "Bear AI")} <${cleanEnv(process.env.EMAIL_FROM, "contracts@yourdomain.com")}>`,
    to: input.recipients,
    subject,
    html,
    text: lines.join("\n")
  } satisfies ResendEmail;
}

async function sendResendEmail(email: ResendEmail) {
  const resendApiKey = cleanEnv(process.env.RESEND_API_KEY);
  if (!resendApiKey) throw new Error("RESEND_API_KEY is required to send the merge/deploy notification");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resendApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(email)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : response.statusText);
  }
  return body;
}

async function notify(args: string[]) {
  const recipients = notificationRecipients(args);
  if (recipients.length === 0) {
    throw new Error("No notification recipient found. Set AGENTCONTRACT_AUTOPILOT_NOTIFY_EMAIL or pass --to.");
  }

  const feedbackId = flag(args, "--feedback-id", "--id");
  const feedback = feedbackId ? await getFeedback(feedbackId) : null;
  const email = buildNotificationEmail({
    recipients,
    feedback,
    prUrl: flag(args, "--pr-url", "--pr"),
    deploymentUrl: flag(args, "--deployment-url", "--deploy-url", "--deployment"),
    mergeCommit: flag(args, "--merge-commit", "--commit"),
    summary: flag(args, "--summary")
  });

  if (hasFlag(args, "--dry-run")) {
    json({ dry_run: true, email });
    return;
  }

  const result = await sendResendEmail(email);
  json({ sent: true, id: (result as { id?: string }).id ?? null, to: email.to });
}

async function main() {
  const [command = "claim", ...args] = process.argv.slice(2);

  if (command === "open" || command === "list-open") {
    const feedback = await listOpenFeedback(numberFlag(args, "--limit", 10));
    json({ feedback });
    return;
  }

  if (command === "claim") {
    const id = args.find((arg) => !arg.startsWith("-"));
    const feedback = await claimFeedback(id);
    json({ claimed: Boolean(feedback), feedback });
    return;
  }

  if (command === "start" || command === "in-progress") {
    const id = args.find((arg) => !arg.startsWith("-"));
    if (!id) throw new Error("feedback id is required");
    json({ feedback: await setFeedbackStatus(id, "in_progress") });
    return;
  }

  if (command === "close") {
    const id = args.find((arg) => !arg.startsWith("-"));
    if (!id) throw new Error("feedback id is required");
    json({ feedback: await setFeedbackStatus(id, "closed") });
    return;
  }

  if (command === "reopen") {
    const id = args.find((arg) => !arg.startsWith("-"));
    if (!id) throw new Error("feedback id is required");
    json({ feedback: await setFeedbackStatus(id, "open") });
    return;
  }

  if (command === "notify") {
    await notify(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1]?.endsWith("feedback-autopilot.ts") || process.argv[1]?.endsWith("feedback-autopilot.js")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
