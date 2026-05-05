import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let routeTestDir = "";
let appModule: typeof import("../src/app.js");
let dbModule: typeof import("../src/lib/db.js");

before(async () => {
  routeTestDir = await mkdtemp(join(tmpdir(), "agentcontract-feedback-"));
  process.env.DATABASE_PATH = join(routeTestDir, "agentcontract.db");
  process.env.AGENTCONTRACT_API_KEY = "ak_test_feedback_fixes";
  process.env.BASE_URL = "https://agentcontract.to\n";
  [appModule, dbModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/lib/db.js")
  ]);
});

after(async () => {
  await rm(routeTestDir, { recursive: true, force: true });
});

test("agreement list responses are compact and normalize base URLs", async () => {
  const createResponse = await appModule.app.request("https://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: {
      authorization: "Bearer ak_test_feedback_fixes",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      recipient: { name: "List Test", email: "list@example.com" },
      document_markdown: "# Test Agreement\n\nHello {{recipient_name}}.",
      fields: [{ id: "signature", label: "Signature", type: "signature", required: true }]
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string };

  await dbModule.run(
    "UPDATE agreements SET signed_fields_json = ? WHERE id = ?",
    JSON.stringify({
      signature: {
        signed: true,
        data_url: `data:image/png;base64,${"a".repeat(5000)}`
      }
    }),
    created.id
  );

  const listResponse = await appModule.app.request("https://agentcontract.test/v1/agreements?limit=100", {
    headers: { authorization: "Bearer ak_test_feedback_fixes" }
  });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as {
    agreements: Array<{
      preview_url: string;
      signing_url: string;
      signed_fields?: unknown;
      signed_fields_saved?: boolean;
    }>;
  };

  assert.equal(listed.agreements[0].preview_url.includes("\n"), false);
  assert.equal(listed.agreements[0].signing_url.includes("\n"), false);
  assert.equal("signed_fields" in listed.agreements[0], false);
  assert.equal(listed.agreements[0].signed_fields_saved, true);
});

test("session start creates an agent session", async () => {
  const response = await appModule.app.request("https://agentcontract.test/v1/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer ak_test_feedback_fixes",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      agent: "codex",
      goal: "send Specific Marketplace agreements"
    })
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { session?: { id?: string; agent?: string; initial_goal?: string } };
  assert.match(body.session?.id ?? "", /^sess_/);
  assert.equal(body.session?.agent, "codex");
  assert.equal(body.session?.initial_goal, "send Specific Marketplace agreements");
});

test("CLI session start dry run works before login", async () => {
  const { stdout } = await execFileAsync("npm", [
    "run",
    "cli",
    "--",
    "session",
    "start",
    "--agent",
    "codex",
    "--goal",
    "check agreements",
    "--dry-run",
    "--json"
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTCONTRACT_CONFIG: join(tmpdir(), `agentcontract-empty-${Date.now()}.json`),
      AGENTCONTRACT_API_KEY: "",
      AGENTSIGN_API_KEY: "",
      AGENTINK_API_KEY: ""
    }
  });
  const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    dry_run?: boolean;
    url?: string;
    payload?: { goal?: string };
  };
  assert.equal(result.dry_run, true);
  assert.equal(result.url?.endsWith("/v1/sessions"), true);
  assert.equal(result.payload?.goal, "check agreements");
});

test("CLI specific privacy dry run posts to the agreements API", async () => {
  const { stdout } = await execFileAsync("npm", [
    "run",
    "cli",
    "--",
    "specific-privacy",
    "--to",
    "contributor@example.com",
    "--name",
    "Specific Contributor",
    "--dry-run",
    "--json"
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTCONTRACT_CONFIG: join(tmpdir(), `agentcontract-specific-${Date.now()}.json`),
      AGENTCONTRACT_API_KEY: "",
      AGENTSIGN_API_KEY: "",
      AGENTINK_API_KEY: ""
    }
  });
  const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    dry_run?: boolean;
    command?: string;
    url?: string;
    payload?: { template?: string; metadata?: { workflow?: string } };
  };
  assert.equal(result.dry_run, true);
  assert.equal(result.command, "specific-privacy");
  assert.equal(result.url?.endsWith("/v1/agreements"), true);
  assert.equal(result.payload?.template, "privacy");
  assert.equal(result.payload?.metadata?.workflow, "specific_privacy_acknowledgement");
});

test("install script uses the hosted tarball and writable npm prefix fallback", async () => {
  const response = await appModule.app.request("https://agentcontract.test/cli/install.sh");
  assert.equal(response.status, 200);
  const script = await response.text();
  assert.match(script, /agentcontract-0\.1\.9\.tgz/);
  assert.match(script, /AGENTCONTRACT_NPM_PREFIX/);
  assert.match(script, /Global npm directory is not writable/);
});

test("email delivery retries Resend rate limits", async () => {
  const { env } = await import("../src/lib/env.js");
  const { sendSigningEmail } = await import("../src/lib/email.js");
  const originalFetch = globalThis.fetch;
  const originalKey = env.resendApiKey;
  let calls = 0;

  env.resendApiKey = "re_test";
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" }
      });
    }
    return new Response(JSON.stringify({ id: "email_ok" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await sendSigningEmail({
      to: "recipient@example.com",
      recipientName: "Recipient",
      documentTitle: "Retry Test",
      signingUrl: "https://example.com/sign/test"
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    env.resendApiKey = originalKey;
  }
});

test("CLI update check reports hosted updates without using npm", async () => {
  const { stdout } = await execFileAsync("npm", [
    "run",
    "cli",
    "--",
    "update",
    "--check",
    "--latest-version",
    "0.1.10",
    "--json"
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTCONTRACT_CONFIG: join(tmpdir(), `agentcontract-test-${Date.now()}.json`)
    }
  });
  const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    update_check?: boolean;
    latest_version?: string;
    update_available?: boolean;
  };
  assert.equal(result.update_check, true);
  assert.equal(result.latest_version, "0.1.10");
  assert.equal(result.update_available, true);
});
