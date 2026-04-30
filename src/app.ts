import { Hono } from "hono";
import { logger } from "hono/logger";
import { agreements } from "./routes/agreements.js";
import { sign } from "./routes/sign.js";
import { startWebhookRetryWorker } from "./routes/webhooks.js";

export const app = new Hono();

app.use("*", logger());
app.onError((error, c) => {
  console.error("[AgentInk error]", error);
  return c.text("Internal Server Error", 500);
});
app.get("/", (c) => c.json({ name: "AgentInk", version: "0.1.0", ok: true }));
app.route("/", agreements);
app.route("/", sign);

startWebhookRetryWorker();

export default app;
