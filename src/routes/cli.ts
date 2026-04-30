import { Hono, type Context } from "hono";
import { createApiKey } from "../lib/apiKeys.js";
import { createCliLoginCode, consumeCliLoginCode } from "../lib/cliLogin.js";
import { requireAdminSession } from "../lib/workos.js";

export const cli = new Hono();

type WorkosUser = {
  id?: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function adminUser(c: Context): WorkosUser {
  return ((c as unknown as { get(key: string): unknown }).get("adminUser") ?? {}) as WorkosUser;
}

function userName(user: WorkosUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email || "AgentContract user";
}

function allowedLocalRedirect(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowedHost = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    if (url.protocol !== "http:" || !allowedHost) return null;
    return url;
  } catch {
    return null;
  }
}

function installScript(origin: string) {
  return `#!/usr/bin/env bash
set -euo pipefail

echo "Installing AgentContract CLI..."

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 20+ first: https://nodejs.org/" >&2
  exit 1
fi

if npm install -g @bear-ai-dev/agentcontract; then
  :
else
  echo "npm package install failed; falling back to GitHub install..."
  npm install -g github:bear-ai-dev/agentsign
fi

echo
echo "AgentContract CLI installed."
echo "Next:"
echo "  agentcontract login --api-url ${origin}"
echo "  agentcontract skill"
`;
}

cli.get("/cli/install.sh", (c) => {
  return c.text(installScript(new URL(c.req.url).origin), 200, {
    "Content-Type": "text/x-shellscript; charset=utf-8",
    "Cache-Control": "no-store"
  });
});

cli.get("/cli", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentContract CLI</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; } pre { white-space: pre-wrap; }</style>
</head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-3xl px-5 py-10">
    <p class="text-sm font-semibold text-slate-500">AgentContract</p>
    <h1 class="mt-2 text-3xl font-semibold">CLI for agent-native contract sending</h1>
    <p class="mt-3 text-slate-700">Install, authenticate with WorkOS/Google Workspace, then send and track contracts from Claude Code or any local agent.</p>

    <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Install</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>curl -fsSL ${escapeHtml(origin)}/cli/install.sh | bash</code></pre>
    </section>

    <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Authenticate</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>agentcontract login --api-url ${escapeHtml(origin)}</code></pre>
    </section>

    <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Agent skill</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>agentcontract skill</code></pre>
    </section>

    <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Examples</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor"
agentcontract contract read privacy --var effective_date="April 29, 2026"
agentcontract agreements --status sent --json</code></pre>
    </section>
  </main>
</body>
</html>`);
});

cli.get("/cli/login", requireAdminSession, async (c) => {
  const redirectUri = allowedLocalRedirect(c.req.query("redirect_uri"));
  const state = c.req.query("state") ?? "";
  if (!redirectUri || !state) return c.text("Invalid CLI login request", 400);

  const user = adminUser(c);
  if (!user.email) return c.text("Signed-in user has no email address", 400);

  const keyName = c.req.query("name") || "AgentContract CLI";
  const code = await createCliLoginCode({
    keyName,
    ownerId: user.id ?? null,
    ownerEmail: user.email
  });

  redirectUri.searchParams.set("code", code);
  redirectUri.searchParams.set("state", state);
  redirectUri.searchParams.set("email", user.email);
  redirectUri.searchParams.set("name", userName(user));
  return c.redirect(redirectUri.toString());
});

cli.post("/cli/exchange", async (c) => {
  const body = await c.req.json<{ code?: string }>().catch(() => ({})) as { code?: string };
  if (!body.code) return c.json({ error: "code is required" }, 400);

  const result = await consumeCliLoginCode(body.code);
  if (!result) return c.json({ error: "Invalid or expired code" }, 400);

  const { key } = await createApiKey({
    name: result.keyName,
    ownerId: result.ownerId,
    ownerEmail: result.ownerEmail
  });

  return c.json({
    api_key: key,
    owner_email: result.ownerEmail,
    owner_id: result.ownerId
  });
});
