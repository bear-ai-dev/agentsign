import { Hono } from "hono";
import { completeWorkosCallback, loginUrl, logout, workosConfigured } from "../lib/workos.js";

export const auth = new Hono();

auth.get("/login", (c) => {
  if (!workosConfigured()) return c.redirect("/templates/bear-contractor");
  const url = loginUrl(c, c.req.query("returnTo"));
  return url ? c.redirect(url) : c.text("WorkOS is not configured", 503);
});

auth.get("/auth/callback", async (c) => {
  try {
    return await completeWorkosCallback(c);
  } catch (error) {
    console.error("[AgentContract WorkOS callback failed]", error);
    return c.redirect("/login");
  }
});

auth.get("/logout", async (c) => logout(c));
