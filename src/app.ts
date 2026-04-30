import { Hono } from "hono";
import { logger } from "hono/logger";
import { agreements } from "./routes/agreements.js";
import { auth } from "./routes/auth.js";
import { sign } from "./routes/sign.js";
import { templates } from "./routes/templates.js";
import { startWebhookRetryWorker } from "./routes/webhooks.js";

export const app = new Hono();

app.use("*", logger());
app.onError((error, c) => {
  console.error("[AgentContract error]", error);
  return c.text("Internal Server Error", 500);
});
app.get("/", (c) => c.json({ name: "AgentContract", version: "0.1.0", ok: true }));
app.get("/favicon.ico", (c) => new Response(null, { status: 204 }));
app.route("/", auth);
app.route("/", agreements);
app.route("/", sign);
app.route("/", templates);

startWebhookRetryWorker();

export default app;
