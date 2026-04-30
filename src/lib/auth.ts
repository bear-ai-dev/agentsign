import type { Context, Next } from "hono";
import { env } from "./env.js";

export async function requireApiKey(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const expected = `Bearer ${env.apiKey}`;
  if (header !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}
