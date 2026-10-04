import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { verifyStoredApiKey } from "./apiKeys.js";
import { env } from "./env.js";

export async function requireApiKey(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (env.apiKey && token && token === env.apiKey) {
    c.set("apiKeyBootstrap", true);
    await next();
    return;
  }

  const record = token ? await verifyStoredApiKey(token) : null;
  if (record) {
    c.set("apiKeyRecord", record);
    await next();
    return;
  }

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({ error: "Unauthorized" }, 401);
}

export async function requireCronSecret(c: Context, next: Next) {
  c.header("Cache-Control", "private, no-store");
  if (!env.cronSecret) return c.json({ error: "Webhook scheduler unavailable" }, 503);
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!token || !timingSafeEqual(digest(token), digest(env.cronSecret))) return c.json({ error: "Unauthorized" }, 401);
  await next();
}
