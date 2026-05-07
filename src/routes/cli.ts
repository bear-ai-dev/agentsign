import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApiKey } from "../lib/apiKeys.js";
import { createCliLoginCode, createEmailLoginCode, consumeCliLoginCode } from "../lib/cliLogin.js";
import { sendCliLoginCodeEmail } from "../lib/email.js";
import { requireAdminSession } from "../lib/workos.js";

export const cli = new Hono();

const primaryOrigin = "https://agentcontract.to";
const cliTarballName = "agentcontract-0.1.13.tgz";
const cliPageTitle = "AgentContract CLI | Send contracts from local AI agents";
const cliPageDescription = "Install the AgentContract CLI to send approved contracts, inspect templates, track agreements, and report failures from local AI agent workflows.";

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

function canonicalUrl(origin: string, path: string) {
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
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

function validEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function clientIp(c: Context) {
  return (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "").split(",")[0].trim() || null;
}

function cliTarballInfo() {
  const candidates = [
    join(process.cwd(), "public", cliTarballName),
    join(process.cwd(), cliTarballName)
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return null;
  const bytes = readFileSync(path);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function installScript(origin: string, packageSha256: string) {
  const packageUrl = `${origin}/cli/${cliTarballName}`;
  return `#!/usr/bin/env bash
set -euo pipefail

echo "Installing AgentContract CLI..."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it first: https://nodejs.org/" >&2
  exit 1
fi

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Current version: $(node -v)" >&2
  echo "Install Node.js 20+ first: https://nodejs.org/" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 20+ first: https://nodejs.org/" >&2
  exit 1
fi

agentcontract_npm_install() {
  npm install -g "$@"
}

agentcontract_existing_prefix() {
  existing_agentcontract="$(command -v agentcontract 2>/dev/null || true)"
  if [ -z "$existing_agentcontract" ]; then
    return 1
  fi
  existing_bin_dir="$(dirname "$existing_agentcontract")"
  existing_prefix="$(dirname "$existing_bin_dir")"
  if [ -d "$existing_prefix" ]; then
    printf '%s\\n' "$existing_prefix"
    return 0
  fi
  return 1
}

agentcontract_use_user_prefix() {
  existing_prefix="$(agentcontract_existing_prefix || true)"
  user_prefix="\${AGENTCONTRACT_NPM_PREFIX:-\${existing_prefix:-\${npm_config_prefix:-$HOME/.npm-global}}}"
  mkdir -p "$user_prefix/bin"
  npm_config_prefix="$user_prefix"
  export npm_config_prefix
  export PATH="$user_prefix/bin:$PATH"
}

agentcontract_verify_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s  %s\\n' "$package_sha256" "$package_file" | shasum -a 256 -c - >/dev/null
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\\n' "$package_sha256" "$package_file" | sha256sum -c - >/dev/null
  else
    echo "shasum or sha256sum is required to verify the AgentContract package." >&2
    exit 1
  fi
}

global_root="$(npm root -g 2>/dev/null || true)"
global_prefix="$(npm prefix -g 2>/dev/null || true)"
existing_prefix="$(agentcontract_existing_prefix || true)"
if [ -n "\${AGENTCONTRACT_NPM_PREFIX:-}" ] || [ -n "$existing_prefix" ]; then
  agentcontract_use_user_prefix
  echo "Installing AgentContract under $user_prefix"
elif [ -z "$global_root" ] || { [ ! -w "$global_root" ] && [ ! -w "$(dirname "$global_root")" ]; }; then
  agentcontract_use_user_prefix
  echo "Global npm directory is not writable; installing AgentContract under $user_prefix"
  echo "If agentcontract is not found later, add this to PATH: $user_prefix/bin"
elif [ -n "$global_prefix" ]; then
  export PATH="$global_prefix/bin:$PATH"
fi

package_url="${packageUrl}"
package_sha256="${packageSha256}"
package_dir="$(mktemp -d "\${TMPDIR:-/tmp}/agentcontract.XXXXXX")"
package_file="$package_dir/${cliTarballName}"

cleanup_agentcontract_installer() {
  rm -rf "$package_dir"
}
trap cleanup_agentcontract_installer EXIT INT TERM

echo "Downloading AgentContract package..."
curl -fsSL "$package_url" -o "$package_file"
agentcontract_verify_sha256

if agentcontract_npm_install "$package_file"; then
  :
else
  agentcontract_use_user_prefix
  echo "Packaged install failed; retrying under $user_prefix..."
  if agentcontract_npm_install "$package_file"; then
    :
  else
    echo "Packaged install failed after retry." >&2
    exit 1
  fi
fi

echo
echo "AgentContract CLI installed."
echo "Next:"
if ! command -v agentcontract >/dev/null 2>&1; then
  echo "  Add AgentContract to your PATH for future shells:"
  printf '    export PATH="%s/bin:$PATH"\\n' "\${npm_config_prefix:-\${AGENTCONTRACT_NPM_PREFIX:-$HOME/.npm-global}}"
fi
echo "  agentcontract login --email you@example.com --api-url ${origin}"
echo "  agentcontract skill"
`;
}

cli.get("/cli/install.sh", (c) => {
  const packageInfo = cliTarballInfo();
  if (!packageInfo) return c.text("AgentContract CLI package not found", 404);
  return c.text(installScript(new URL(c.req.url).origin, packageInfo.sha256), 200, {
    "Content-Type": "text/x-shellscript; charset=utf-8",
    "Cache-Control": "no-store"
  });
});

function cliTarball(c: Context) {
  const packageInfo = cliTarballInfo();
  if (!packageInfo) return c.text("AgentContract CLI package not found", 404);
  return new Response(packageInfo.bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${cliTarballName}"`
    }
  });
}

cli.get(`/${cliTarballName}`, cliTarball);
cli.get(`/cli/${cliTarballName}`, cliTarball);

cli.get("/cli", (c) => {
  const origin = new URL(c.req.url).origin;
  const canonical = canonicalUrl(primaryOrigin, "/cli");
  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(cliPageTitle)}</title>
  <meta name="description" content="${escapeHtml(cliPageDescription)}" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:site_name" content="AgentContract" />
  <meta property="og:title" content="${escapeHtml(cliPageTitle)}" />
  <meta property="og:description" content="${escapeHtml(cliPageDescription)}" />
  <meta name="twitter:card" content="summary" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; } pre { white-space: pre-wrap; }</style>
</head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-3xl px-5 py-10">
    <p class="text-sm font-semibold text-slate-500">AgentContract</p>
    <h1 class="mt-2 text-3xl font-semibold">CLI for agent-native contract sending</h1>
    <p class="mt-3 text-slate-700">Install, authenticate with an email code, then send and track contracts from Claude Code or any local agent. WorkOS/Google can be enabled as an optional browser login.</p>

    <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Install</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>curl -fsSL ${escapeHtml(origin)}/cli/install.sh | bash</code></pre>
    </section>

    <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Authenticate</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>agentcontract login --email you@example.com --api-url ${escapeHtml(origin)}</code></pre>
    </section>

    <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Agent skill</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>agentcontract skill</code></pre>
    </section>

    <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Examples</h2>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-sm text-slate-100"><code>agentcontract marketplace-onboard --to contributor@example.com --name "Jane Contributor"
agentcontract contract read privacy --var effective_date="April 29, 2026"
agentcontract agreements --status sent --json
agentcontract feedback --message "Login code never arrived" --category login --severity high --json</code></pre>
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

cli.post("/cli/magic/start", async (c) => {
  const body = await c.req.json<{ email?: string; name?: string }>().catch(() => ({})) as { email?: string; name?: string };
  const email = validEmail(body.email);
  if (!email) return c.json({ error: "A valid email is required" }, 400);

  try {
    const code = await createEmailLoginCode({
      keyName: body.name || "AgentContract CLI",
      ownerEmail: email
    });
    await sendCliLoginCodeEmail({ to: email, code, expiresInMinutes: 5 });
    return c.json({
      ok: true,
      email,
      expires_in_minutes: 5
    });
  } catch (error) {
    console.error("[AgentContract email login start failed]", error);
    return c.json({ error: "Could not start email-code login" }, 400);
  }
});

cli.post("/cli/magic/verify", async (c) => {
  const body = await c.req.json<{ email?: string; code?: string; name?: string }>().catch(() => ({})) as {
    email?: string;
    code?: string;
    name?: string;
  };
  const email = validEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!email) return c.json({ error: "A valid email is required" }, 400);
  if (!/^[0-9]{6}$/.test(code)) return c.json({ error: "A 6-digit login code is required" }, 400);

  try {
    const login = await consumeCliLoginCode(code);
    if (!login || login.ownerEmail !== email) return c.json({ error: "Invalid or expired login code" }, 400);
    const { key } = await createApiKey({
      name: body.name || login.keyName || "AgentContract CLI",
      ownerId: login.ownerId ?? null,
      ownerEmail: email
    });
    console.info(`[AgentContract email login verified] ${email} from ${clientIp(c) ?? "unknown ip"}`);
    return c.json({
      api_key: key,
      owner_email: email,
      owner_id: login.ownerId
    });
  } catch (error) {
    console.error("[AgentContract email login verify failed]", error);
    return c.json({ error: "Invalid or expired login code" }, 400);
  }
});
