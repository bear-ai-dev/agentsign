import { Hono } from "hono";
import { requireCronSecret } from "../lib/auth.js";
import { retryDueWebhooks } from "./webhooks.js";

export const cron = new Hono();
const paths = ["/internal/cron/webhooks", "/api/webhook-cron"];
for (const path of paths) cron.use(path, requireCronSecret);
cron.on(["GET", "POST"], paths, async c => {
  const result = await retryDueWebhooks();
  return c.json({ ok: result.failed === 0, ...result }, result.failed ? 503 : 200);
});
