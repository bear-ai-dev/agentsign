import { Hono } from "hono";
import { logger } from "hono/logger";
import { cookieConsentMiddleware } from "./lib/cookieConsent.js";
import { posthog } from "./lib/posthog.js";
import { agreements } from "./routes/agreements.js";
import { apiKeys } from "./routes/apiKeys.js";
import { auth } from "./routes/auth.js";
import { cli } from "./routes/cli.js";
import { feedback } from "./routes/feedback.js";
import { sign } from "./routes/sign.js";
import { sessions } from "./routes/sessions.js";
import { site } from "./routes/site.js";
import { templates } from "./routes/templates.js";
import { startWebhookRetryWorker } from "./routes/webhooks.js";

export const app = new Hono();

app.use("*", logger());
app.use("*", posthog.middleware());
app.use("*", cookieConsentMiddleware);
app.onError(async (error, c) => {
  console.error("[AgentContract error]", error);
  await posthog.captureException(error, c, { handled_by: "app.onError" });
  return c.text("Internal Server Error", 500);
});
app.get("/favicon.ico", (c) => new Response(null, { status: 204 }));
app.route("/", site);
app.route("/", auth);
app.route("/", cli);
app.route("/", apiKeys);
app.route("/", feedback);
app.route("/", sessions);
app.route("/", agreements);
app.route("/", sign);
app.route("/", templates);

startWebhookRetryWorker();

export default app;
