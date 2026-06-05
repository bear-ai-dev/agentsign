import { Hono, type Context } from "hono";
import { createApiKey, listApiKeysForOwner, revokeApiKeyForOwner } from "../lib/apiKeys.js";
import { requireApiKey } from "../lib/auth.js";
import { ownerDistinctId, posthog, setPosthogDistinctId } from "../lib/posthog.js";
import { requireAdminSession } from "../lib/workos.js";
import type { ApiKeyRecord } from "../lib/types.js";

export const apiKeys = new Hono();

apiKeys.use("/v1/api-keys", requireApiKey);
apiKeys.use("/v1/api-keys/*", requireApiKey);
apiKeys.use("/dashboard/api-keys", requireAdminSession);
apiKeys.use("/dashboard/api-keys/*", requireAdminSession);

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

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function publicApiKey(key: ApiKeyRecord) {
  return {
    id: key.id,
    key_prefix: key.key_prefix,
    last4: key.last4,
    name: key.name,
    owner_email: key.owner_email,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    revoked_at: key.revoked_at
  };
}

function userName(user: WorkosUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email || "AgentContract user";
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function keyRows(keys: Awaited<ReturnType<typeof listApiKeysForOwner>>) {
  if (!keys.length) {
    return `<tr><td colspan="5" class="py-8 text-center text-sm text-slate-500">No API keys yet. Create one for the CLI.</td></tr>`;
  }

  return keys.map((key) => `
    <tr class="border-b border-slate-100 last:border-0">
      <td class="px-4 py-3 align-top">
        <div class="font-semibold">${escapeHtml(key.name)}</div>
        <div class="mt-1 font-mono text-xs text-slate-500">${escapeHtml(key.key_prefix)}...${escapeHtml(key.last4)}</div>
      </td>
      <td class="py-3 pr-4 align-top text-sm text-slate-600">${escapeHtml(key.created_at)}</td>
      <td class="py-3 pr-4 align-top text-sm text-slate-600">${escapeHtml(key.last_used_at ?? "never")}</td>
      <td class="py-3 pr-4 align-top">
        ${key.revoked_at
          ? `<span class="rounded bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">revoked</span>`
          : `<span class="rounded bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">active</span>`}
      </td>
      <td class="py-3 pr-4 align-top">
        ${key.revoked_at ? "" : `
          <form method="post" action="/dashboard/api-keys/${escapeHtml(key.id)}/revoke">
            <button class="rounded border border-slate-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-50" type="submit">Revoke</button>
          </form>
        `}
      </td>
    </tr>
  `).join("");
}

apiKeys.get("/v1/api-keys", async (c) => {
  const current = apiKeyRecord(c);
  if (!current?.owner_email) {
    return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  }

  const keys = await listApiKeysForOwner(current.owner_email);
  return c.json({
    owner_email: current.owner_email,
    api_keys: keys.map(publicApiKey)
  });
});

apiKeys.post("/v1/api-keys", async (c) => {
  const current = apiKeyRecord(c);
  if (!current?.owner_email) {
    return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  }

  const body = await c.req.json<{ name?: string }>().catch(() => ({})) as { name?: string };
  const { key, record } = await createApiKey({
    name: body.name || "AgentContract CLI",
    ownerId: current.owner_id,
    ownerEmail: current.owner_email
  });
  const distinctId = ownerDistinctId(current.owner_email, record.id);

  setPosthogDistinctId(c, distinctId);
  posthog.captureEvent("api key created", {
    key_id: record.id,
    key_name: record.name,
    key_prefix: record.key_prefix,
    owner_has_email: Boolean(record.owner_email),
    surface: "api"
  }, distinctId);
  return c.json({
    api_key: key,
    record: publicApiKey(record)
  }, 201);
});

apiKeys.post("/v1/api-keys/:id/revoke", async (c) => {
  const current = apiKeyRecord(c);
  if (!current?.owner_email) {
    return c.json({ error: "This API key has no owner. Run agentcontract login to create a user-owned key." }, 403);
  }

  const id = c.req.param("id");
  const revoked = await revokeApiKeyForOwner(id, current.owner_email);
  if (!revoked) return c.json({ error: "API key not found" }, 404);
  const distinctId = ownerDistinctId(current.owner_email, id);

  setPosthogDistinctId(c, distinctId);
  posthog.captureEvent("api key revoked", {
    key_id: id,
    surface: "api"
  }, distinctId);
  return c.json({
    revoked: true,
    id
  });
});

async function renderApiKeysPage(c: Context, newKey?: string) {
  const user = adminUser(c);
  const ownerEmail = user.email ?? "";
  const keys = await listApiKeysForOwner(ownerEmail);
  const origin = new URL(c.req.url).origin;
  const senderName = userName(user);
  const initCommand = newKey
    ? `printf '%s' ${shellQuote(newKey)} | agentcontract init --api-url ${shellQuote(origin)} --api-key-stdin --sender-email ${shellQuote(ownerEmail)} --sender-name ${shellQuote(senderName)}`
    : `agentcontract init --api-url ${shellQuote(origin)} --sender-email ${shellQuote(ownerEmail)} --sender-name ${shellQuote(senderName)}`;

  return c.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Keys | AgentContract</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; } pre { white-space: pre-wrap; }</style>
</head>
<body class="bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
      <div>
        <p class="text-sm font-semibold text-slate-500">AgentContract</p>
        <h1 class="text-2xl font-semibold">API Keys</h1>
        <p class="mt-1 text-sm text-slate-500">${escapeHtml(ownerEmail)}</p>
      </div>
      <nav class="flex flex-wrap items-center gap-2">
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="/dashboard">Dashboard</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="/logout">Sign out</a>
      </nav>
    </div>
  </header>

  <main class="mx-auto max-w-5xl px-5 py-6">
    ${newKey ? `
      <section class="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <h2 class="font-semibold text-emerald-900">Copy this key now</h2>
        <p class="mt-1 text-sm text-emerald-800">AgentContract stores only a SHA-256 hash, so this full key is shown once.</p>
        <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100"><code>${escapeHtml(newKey)}</code></pre>
        <p class="mt-3 text-sm font-semibold text-emerald-900">CLI setup</p>
        <pre class="mt-2 overflow-x-auto rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100"><code>${escapeHtml(initCommand)}</code></pre>
      </section>
    ` : ""}

    <section class="grid gap-4 md:grid-cols-[1fr_22rem]">
      <div class="rounded-lg border border-slate-200 bg-white">
        <div class="border-b border-slate-200 px-4 py-3">
          <h2 class="font-semibold">Your Keys</h2>
          <p class="text-sm text-slate-500">Use these for CLI, agents, scripts, and server-to-server calls.</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[680px] text-left">
            <thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th class="px-4 py-3 font-semibold">Key</th>
                <th class="py-3 pr-4 font-semibold">Created</th>
                <th class="py-3 pr-4 font-semibold">Last used</th>
                <th class="py-3 pr-4 font-semibold">Status</th>
                <th class="py-3 pr-4 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody class="text-sm">${keyRows(keys)}</tbody>
          </table>
        </div>
      </div>

      <form method="post" action="/dashboard/api-keys" class="h-fit rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="font-semibold">Create Key</h2>
        <p class="mt-1 text-sm leading-6 text-slate-600">Name it for the agent or machine that will use it.</p>
        <label class="mt-4 block text-sm font-semibold">Name
          <input class="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm" name="name" value="Sid CLI" required />
        </label>
        <button class="mt-4 w-full rounded bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white" type="submit">Create API Key</button>
      </form>
    </section>
  </main>
</body>
</html>`);
}

apiKeys.get("/dashboard/api-keys", async (c) => renderApiKeysPage(c));

apiKeys.post("/dashboard/api-keys", async (c) => {
  const user = adminUser(c);
  if (!user.email) return c.text("Signed-in user has no email address", 400);

  const body = await c.req.parseBody();
  const name = typeof body.name === "string" ? body.name : "AgentContract CLI";
  const { key, record } = await createApiKey({
    name,
    ownerId: user.id ?? null,
    ownerEmail: user.email
  });
  const distinctId = ownerDistinctId(user.email, "dashboard-api-key");

  setPosthogDistinctId(c, distinctId);
  posthog.captureEvent("api key created", {
    key_id: record.id,
    key_name: name,
    owner_has_email: Boolean(user.email),
    surface: "dashboard"
  }, distinctId);
  return renderApiKeysPage(c, key);
});

apiKeys.post("/dashboard/api-keys/:id/revoke", async (c) => {
  const user = adminUser(c);
  const id = c.req.param("id");
  if (id) {
    const revoked = await revokeApiKeyForOwner(id, user.email);
    if (revoked) {
      const distinctId = ownerDistinctId(user.email, id);
      setPosthogDistinctId(c, distinctId);
      posthog.captureEvent("api key revoked", {
        key_id: id,
        surface: "dashboard"
      }, distinctId);
    }
  }
  return c.redirect("/dashboard/api-keys");
});
