import type { Context, Next } from "hono";
import { verifyStoredApiKey } from "./apiKeys.js";
import { env } from "./env.js";

export async function requireApiKey(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (token && token === env.apiKey) {
    await next();
    return;
  }

  if (token && await verifyStoredApiKey(token)) {
    await next();
    return;
  }

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({ error: "Unauthorized" }, 401);
}
