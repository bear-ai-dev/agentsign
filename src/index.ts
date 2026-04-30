import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { env } from "./lib/env.js";

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`AgentContract running on http://localhost:${info.port}`);
});
