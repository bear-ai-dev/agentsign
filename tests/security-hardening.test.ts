import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { rootCertificates } from "node:tls";

const repoDir = process.cwd();
const tsxLoader = join(repoDir, "node_modules", "tsx", "dist", "loader.mjs");
let testDir = "";
let appModule: typeof import("../src/app.js");
let dbModule: typeof import("../src/lib/db.js");

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "agentcontract-security-"));
  process.env.DATABASE_PATH = join(testDir, "agentcontract.db");
  process.env.AGENTCONTRACT_API_KEY = "security-hardening-bootstrap-key-for-tests";
  process.env.WORKOS_COOKIE_PASSWORD = "security-hardening-cookie-secret-for-tests";
  process.env.BASE_URL = "https://agentcontract.test";
  [appModule, dbModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/lib/db.js")
  ]);
});

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("production refuses missing or shared authentication secrets", () => {
  const baseEnv = {
    ...process.env,
    NODE_ENV: "production",
    VERCEL: "",
    AGENTCONTRACT_API_KEY: "",
    AGENTSIGN_API_KEY: "",
    AGENTINK_API_KEY: "",
    WORKOS_COOKIE_PASSWORD: ""
  };
  const args = ["--import", tsxLoader, "--input-type=module", "--eval", "import('./src/lib/env.ts')"];
  const missing = spawnSync(process.execPath, args, { cwd: repoDir, env: baseEnv, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /AGENTCONTRACT_API_KEY must be a unique secret/);

  const shared = spawnSync(process.execPath, args, {
    cwd: repoDir,
    env: {
      ...baseEnv,
      AGENTCONTRACT_API_KEY: "same-production-secret-that-is-long-enough",
      WORKOS_COOKIE_PASSWORD: "same-production-secret-that-is-long-enough"
    },
    encoding: "utf8"
  });
  assert.notEqual(shared.status, 0);
  assert.match(`${shared.stdout}${shared.stderr}`, /WORKOS_COOKIE_PASSWORD must be a separate secret/);
});

test("HTML responses do not import a runtime module from a third-party CDN", async () => {
  const response = await appModule.app.request("https://agentcontract.test/");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /esm\.sh\/c15t|import\s+\{\s*getOrCreateConsentRuntime/i);
  assert.match(html, /agentcontract_cookie_consent_v1/);
});

test("project-local dotenv cannot redirect the global CLI", async () => {
  const maliciousProject = await mkdtemp(join(tmpdir(), "agentcontract-malicious-project-"));
  const config = join(maliciousProject, "config.json");
  await writeFile(join(maliciousProject, ".env"), [
    "AGENTCONTRACT_API_URL=https://attacker.invalid",
    "VISUAL=attacker-editor"
  ].join("\n"));
  const stdout = execFileSync(process.execPath, [
    "--import", tsxLoader,
    join(repoDir, "src", "cli.ts"),
    "session", "start", "--agent", "codex", "--goal", "security test", "--dry-run", "--json"
  ], {
    cwd: maliciousProject,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTCONTRACT_CONFIG: config,
      AGENTCONTRACT_API_URL: "",
      AGENTSIGN_API_URL: "",
      AGENTINK_API_URL: "",
      AGENTCONTRACT_API_KEY: "",
      AGENTSIGN_API_KEY: "",
      AGENTINK_API_KEY: ""
    }
  });
  const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { url: string };
  assert.equal(new URL(result.url).origin, "https://agentcontract.to");
  await rm(maliciousProject, { recursive: true, force: true });
});

test("hosted self-update stays pinned to the AgentContract origin", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "agentcontract-updater-bin-"));
  const logPath = join(fakeBin, "bash-args.txt");
  await writeFile(join(fakeBin, "bash"), `#!/bin/sh\nprintf '%s' "$*" > "${logPath}"\nexit 1\n`);
  await chmod(join(fakeBin, "bash"), 0o755);
  spawnSync(process.execPath, [
    "--import", tsxLoader,
    join(repoDir, "src", "cli.ts"),
    "update", "--yes", "--latest-version", "99.0.0", "--json"
  ], {
    cwd: repoDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      AGENTCONTRACT_API_URL: "https://attacker.invalid",
      AGENTCONTRACT_CONFIG: join(fakeBin, "config.json")
    }
  });
  const args = await readFile(logPath, "utf8");
  assert.match(args, /https:\/\/agentcontract\.to\/cli\/install\.sh/);
  assert.doesNotMatch(args, /attacker\.invalid/);
  await rm(fakeBin, { recursive: true, force: true });
});

test("hosted CLI artifact contains the hardened updater", () => {
  const cli = execFileSync("tar", [
    "-xOzf",
    join(repoDir, "public", "agentcontract-0.1.15.tgz"),
    "package/dist/src/cli.js"
  ], { encoding: "utf8" });
  assert.doesNotMatch(cli, /dotenv\/config/);
  assert.match(cli, /officialHostedOrigin\s*=\s*["']https:\/\/agentcontract\.to["']/);
});

test("agreement HTML strips active content and network resources", async () => {
  const { renderContractBodyHtml } = await import("../src/lib/pdf.js");
  const { body } = renderContractBodyHtml({
    markdown: "# Safe\n<script>alert(1)</script><img src=\"https://169.254.169.254/latest\"><iframe src=\"https://internal\"></iframe>[bad](javascript:alert(1))"
  });
  assert.match(body, /<h1>Safe<\/h1>/);
  assert.doesNotMatch(body, /<script|<img|<iframe|href=["']javascript:/i);
});

test("template substitutions cannot inject active HTML", async () => {
  const { applyTemplateVars } = await import("../src/lib/templates.js");
  const rendered = applyTemplateVars("Hello {{recipient_name}}", {
    recipient_name: "<img src=x onerror=alert(1)>\n<script>alert(2)</script>"
  });
  assert.doesNotMatch(rendered, /<img|<script/i);
  assert.match(rendered, /&lt;img/);
});

test("webhook validation rejects loopback and cloud metadata destinations", async () => {
  const { isPrivateNetworkAddress, validateWebhookUrl } = await import("../src/lib/safeWebhook.js");
  assert.equal(isPrivateNetworkAddress("169.254.169.254"), true);
  assert.equal(isPrivateNetworkAddress("::1"), true);
  assert.equal(isPrivateNetworkAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateNetworkAddress("64:ff9b::7f00:1"), true);
  assert.equal(isPrivateNetworkAddress("198.18.0.1"), true);
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
  await assert.rejects(validateWebhookUrl("http://example.com/hook"), /HTTPS/);
  await assert.rejects(validateWebhookUrl("https://127.0.0.1/hook"), /public network/);
  await assert.rejects(validateWebhookUrl("https://169.254.169.254/latest/meta-data"), /public network/);
});

test("agreement creation rejects duplicate field IDs and private webhooks", async () => {
  const request = (body: Record<string, unknown>) => appModule.app.request("https://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: {
      authorization: "Bearer security-hardening-bootstrap-key-for-tests",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      recipient: { name: "Security Test", email: "security@example.com" },
      document_markdown: "# Security test",
      fields: [{ id: "signature", label: "Signature", type: "signature", required: true }],
      ...body
    })
  });
  const duplicate = await request({
    fields: [
      { id: "signature", label: "Recipient", type: "signature", required: true, signerRole: "recipient" },
      { id: "signature", label: "Sender", type: "signature", required: true, signerRole: "sender" }
    ],
    sender_email: "sender@example.com"
  });
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /Duplicate field id/);

  const coercedDuplicate = await request({
    fields: [
      { id: { role: "recipient" }, label: "Recipient", type: "signature", required: true, signerRole: "recipient" },
      { id: { role: "sender" }, label: "Sender", type: "signature", required: true, signerRole: "sender" }
    ],
    sender_email: "sender@example.com"
  });
  assert.equal(coercedDuplicate.status, 400);
  assert.match(await coercedDuplicate.text(), /field ids must be strings/);

  const webhook = await request({ webhook_url: "https://127.0.0.1/internal" });
  assert.equal(webhook.status, 400);
  assert.match(await webhook.text(), /public network/);
});

test("email login codes throttle issuance and lock after five wrong guesses", async () => {
  const { createEmailLoginCode, consumeEmailLoginCode, LoginCodeRateLimitError } = await import("../src/lib/cliLogin.js");
  const email = "login-hardening@example.com";
  const code = await createEmailLoginCode({ ownerEmail: email });
  await assert.rejects(createEmailLoginCode({ ownerEmail: email }), LoginCodeRateLimitError);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await consumeEmailLoginCode("000000", email), null);
  }
  assert.equal(await consumeEmailLoginCode(code, email), null);
});

test("remote PostgreSQL always verifies certificates", async () => {
  const { verifiedPostgresSsl } = await import("../src/lib/postgres.js");
  assert.deepEqual(verifiedPostgresSsl("postgres://user:pass@db.example.com/app"), { rejectUnauthorized: true });
  const ca = rootCertificates[0]!;
  assert.deepEqual(verifiedPostgresSsl("postgres://user:pass@db.example.com/app", ca), {
    rejectUnauthorized: true,
    ca
  });
  assert.deepEqual(verifiedPostgresSsl("postgres://user:pass@db.example.com/app", ca.replace(/\n/g, "\\n")), {
    rejectUnauthorized: true,
    ca
  });
  assert.throws(
    () => verifiedPostgresSsl("postgres://user:pass@db.example.com/app", "not a certificate"),
    /valid PEM-encoded X\.509 certificate/
  );
  assert.equal(verifiedPostgresSsl("postgres://user:pass@localhost/app"), false);
});

test("feedback status endpoint is authenticated, tenant-scoped, and conditional", async () => {
  const { createApiKey } = await import("../src/lib/apiKeys.js");
  const ownerKey = (await createApiKey({ ownerEmail: "feedback-owner@example.com", name: "Owner" })).key;
  const otherKey = (await createApiKey({ ownerEmail: "feedback-other@example.com", name: "Other" })).key;
  const created = await appModule.app.request("https://agentcontract.test/v1/feedback", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ message: "Status endpoint regression" })
  });
  const id = (await created.json() as { feedback: { id: string } }).feedback.id;

  const mutate = (key: string, expected = "open") => appModule.app.request(`https://agentcontract.test/v1/feedback/${id}/status`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "triaged", expected_status: expected })
  });
  assert.equal((await mutate(otherKey)).status, 409);
  const updated = await mutate(ownerKey);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as { feedback: { status: string } }).feedback.status, "triaged");
  assert.equal((await mutate(ownerKey)).status, 409);
});

test("persisted agreements return a stable ID when delivery fails", async () => {
  const { env } = await import("../src/lib/env.js");
  const originalKey = env.resendApiKey;
  const originalFetch = globalThis.fetch;
  env.resendApiKey = "re_security_test";
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: "rejected" }), {
    status: 400,
    headers: { "content-type": "application/json" }
  })) as typeof fetch;
  try {
    const response = await appModule.app.request("https://agentcontract.test/v1/agreements", {
      method: "POST",
      headers: {
        authorization: "Bearer security-hardening-bootstrap-key-for-tests",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        recipient: { name: "Delivery Failure", email: "delivery@example.com" },
        document_markdown: "# Delivery failure",
        fields: [{ id: "signature", label: "Signature", type: "signature", required: true }]
      })
    });
    assert.equal(response.status, 201);
    const result = await response.json() as { id: string; delivery_status: string };
    assert.match(result.id, /^agr_/);
    assert.equal(result.delivery_status, "failed");
    assert.ok(await dbModule.getAgreement(result.id));
  } finally {
    env.resendApiKey = originalKey;
    globalThis.fetch = originalFetch;
  }
});

test("bulk agreement requests validate every recipient before persisting or sending", async () => {
  const recipientEmail = "bulk-preflight@example.com";
  const before = await dbModule.all<{ count: number }>("SELECT COUNT(*) AS count FROM agreements WHERE recipient_email = ?", recipientEmail);
  const response = await appModule.app.request("https://agentcontract.test/v1/agreements/bulk", {
    method: "POST",
    headers: {
      authorization: "Bearer security-hardening-bootstrap-key-for-tests",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      document_markdown: "# Bulk preflight",
      fields: [{ id: "signature", label: "Signature", type: "signature", required: true }],
      recipients: [
        { name: "Valid First", email: recipientEmail },
        { name: "Missing Email" }
      ]
    })
  });
  assert.equal(response.status, 400);
  const after = await dbModule.all<{ count: number }>("SELECT COUNT(*) AS count FROM agreements WHERE recipient_email = ?", recipientEmail);
  assert.equal(after[0].count, before[0].count);
});
