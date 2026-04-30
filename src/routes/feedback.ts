import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import { verifyStoredApiKey } from "../lib/apiKeys.js";
import { requireApiKey } from "../lib/auth.js";
import { all, nowIso, parseJson, run } from "../lib/db.js";
import { env } from "../lib/env.js";
import type { ApiKeyRecord, ProductFeedback } from "../lib/types.js";

export const feedback = new Hono();

type FeedbackBody = {
  message?: string;
  note?: string;
  feedback?: string;
  reporter_email?: string;
  reporter_name?: string;
  source?: string;
  category?: string;
  severity?: string;
  command?: string;
  expected?: string;
  actual?: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const categories = new Set(["install", "login", "cli", "contract", "sending", "signing", "webhook", "dashboard", "docs", "general", "other"]);
const severities = new Set(["note", "low", "normal", "high", "blocker"]);

function cleanString(value: unknown, maxLength = 10_000) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function validEmail(value: unknown) {
  const email = cleanString(value, 320);
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function clientIp(c: Context) {
  return (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "").split(",")[0].trim() || null;
}

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function isBootstrapKey(c: Context) {
  return Boolean((c as unknown as { get(key: string): unknown }).get("apiKeyBootstrap"));
}

async function optionalOwnerEmail(c: Context) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || token === env.apiKey) return null;
  const record = await verifyStoredApiKey(token).catch(() => null);
  return record?.owner_email ?? null;
}

function publicFeedback(row: ProductFeedback) {
  return {
    id: row.id,
    owner_email: row.owner_email,
    reporter_email: row.reporter_email,
    reporter_name: row.reporter_name,
    source: row.source,
    category: row.category,
    severity: row.severity,
    command: row.command,
    message: row.message,
    expected: row.expected,
    actual: row.actual,
    context: parseJson<Record<string, unknown> | null>(row.context_json, null),
    status: row.status,
    created_at: row.created_at
  };
}

feedback.post("/v1/feedback", async (c) => {
  const body = await c.req.json<FeedbackBody>().catch(() => ({})) as FeedbackBody;
  const message = cleanString(body.message ?? body.note ?? body.feedback ?? body.actual);
  if (!message) return c.json({ error: "message is required" }, 400);

  const category = cleanString(body.category, 40) ?? "general";
  const severity = cleanString(body.severity, 40) ?? "normal";
  const createdAt = nowIso();
  const id = `fb_${nanoid(14)}`;
  const context = {
    ...(body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context : {}),
    ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? { metadata: body.metadata } : {}),
    request: {
      ip_address: clientIp(c),
      user_agent: c.req.header("user-agent") ?? null
    }
  };
  const ownerEmail = await optionalOwnerEmail(c);

  await run(
    `INSERT INTO product_feedback (
      id, owner_email, reporter_email, reporter_name, source, category, severity,
      command, message, expected, actual, context_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    id,
    ownerEmail,
    validEmail(body.reporter_email) ?? ownerEmail,
    cleanString(body.reporter_name, 200),
    cleanString(body.source, 80) ?? "agentcontract-cli",
    categories.has(category) ? category : "other",
    severities.has(severity) ? severity : "normal",
    cleanString(body.command, 2_000),
    message,
    cleanString(body.expected),
    cleanString(body.actual),
    JSON.stringify(context),
    createdAt
  );

  const row = await all<ProductFeedback>("SELECT * FROM product_feedback WHERE id = ?", id);
  return c.json({ feedback: publicFeedback(row[0]), stored: true }, 201);
});

feedback.get("/v1/feedback", requireApiKey, async (c) => {
  const current = apiKeyRecord(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const status = cleanString(c.req.query("status"), 40);
  const params: unknown[] = [];
  const where: string[] = [];

  if (status) {
    where.push("status = ?");
    params.push(status);
  }

  if (!isBootstrapKey(c)) {
    if (!current?.owner_email) {
      return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
    }
    where.push("(owner_email = ? OR reporter_email = ?)");
    params.push(current.owner_email, current.owner_email);
  }

  params.push(limit);
  const rows = await all<ProductFeedback>(
    `SELECT * FROM product_feedback ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT ?`,
    ...params
  );

  return c.json({ feedback: rows.map(publicFeedback) });
});
