import { handle } from "@hono/node-server/vercel";
import { cron } from "../src/routes/cron.js";

export default handle(cron);
