import { randomUUID } from "node:crypto";
import { get, nowIso, run, runTransaction } from "./db.js";

export type RateLimitInput = {
  scope: string;
  subject: string;
  limit: number;
  windowMs: number;
  cost?: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset_at: string;
  scope?: string;
};

function cleanSubject(value: string) {
  return value.trim().toLowerCase() || "unknown";
}

export async function checkRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  return checkRateLimits([input]);
}

export async function checkRateLimits(inputs: RateLimitInput[]): Promise<RateLimitResult> {
  const prepared = inputs.map((input) => ({
    ...input,
    cost: Math.max(1, Math.floor(input.cost ?? 1)),
    subject: cleanSubject(input.subject)
  }));
  const now = Date.now();
  const counts: number[] = [];
  for (const input of prepared) {
    const since = new Date(now - input.windowMs).toISOString();
    const existing = await get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM rate_limit_events WHERE scope = ? AND subject = ? AND created_at > ?",
      input.scope,
      input.subject,
      since
    );
    const count = Number(existing?.count ?? 0);
    if (count + input.cost > input.limit) {
      return {
        allowed: false,
        scope: input.scope,
        limit: input.limit,
        remaining: 0,
        reset_at: new Date(now + input.windowMs).toISOString()
      };
    }
    counts.push(count);
  }

  const createdAt = nowIso();
  const statements = prepared.flatMap((input) => Array.from({ length: input.cost }, () => ({
    sql: "INSERT INTO rate_limit_events (id, scope, subject, created_at) VALUES (?, ?, ?, ?)",
    params: [`rl_${randomUUID()}`, input.scope, input.subject, createdAt]
  })));
  statements.push({
    sql: "DELETE FROM rate_limit_events WHERE created_at < ?",
    params: [new Date(now - 24 * 60 * 60 * 1000).toISOString()]
  });
  await runTransaction(statements);

  const tightest = prepared.reduce((best, input, index) => {
    const remaining = Math.max(0, input.limit - counts[index] - input.cost);
    return !best || remaining < best.remaining
      ? { allowed: true, scope: input.scope, limit: input.limit, remaining, reset_at: new Date(now + input.windowMs).toISOString() }
      : best;
  }, null as RateLimitResult | null);
  return tightest ?? { allowed: true, limit: 0, remaining: 0, reset_at: new Date(now).toISOString() };
}

export async function checkRateLimitLegacy(input: RateLimitInput): Promise<RateLimitResult> {
  const cost = Math.max(1, Math.floor(input.cost ?? 1));
  const subject = cleanSubject(input.subject);
  const now = Date.now();
  const since = new Date(now - input.windowMs).toISOString();
  const resetAt = new Date(now + input.windowMs).toISOString();
  const existing = await get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM rate_limit_events WHERE scope = ? AND subject = ? AND created_at > ?",
    input.scope,
    subject,
    since
  );
  const count = Number(existing?.count ?? 0);
  if (count + cost > input.limit) {
    return { allowed: false, limit: input.limit, remaining: 0, reset_at: resetAt };
  }

  const createdAt = nowIso();
  for (let index = 0; index < cost; index += 1) {
    await run(
      "INSERT INTO rate_limit_events (id, scope, subject, created_at) VALUES (?, ?, ?, ?)",
      `rl_${randomUUID()}`,
      input.scope,
      subject,
      createdAt
    );
  }
  await run("DELETE FROM rate_limit_events WHERE created_at < ?", new Date(now - 24 * 60 * 60 * 1000).toISOString());
  return { allowed: true, limit: input.limit, remaining: Math.max(0, input.limit - count - cost), reset_at: resetAt };
}
