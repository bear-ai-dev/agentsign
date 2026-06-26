import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("user-owned API keys cannot read or mutate another owner's agent sessions", async () => {
  const { createApiKey } = await import("../src/lib/apiKeys.js");
  const keyA = (await createApiKey({ ownerEmail: "session-a@example.com", name: "Session A" })).key;
  const keyB = (await createApiKey({ ownerEmail: "session-b@example.com", name: "Session B" })).key;

  const createResponse = await appModule.app.request("https://agentcontract.test/v1/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${keyA}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      agent: "codex",
      goal: "private session goal",
      metadata: { secret: "session-a-secret" }
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { session: { id: string } };

  const listResponse = await appModule.app.request("https://agentcontract.test/v1/sessions?limit=100", {
    headers: { authorization: `Bearer ${keyB}` }
  });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as { sessions: Array<{ id: string }> };
  assert.equal(listed.sessions.some((session) => session.id === created.session.id), false);

  for (const path of [
    `/v1/sessions/${created.session.id}`,
    `/v1/sessions/${created.session.id}/events`,
    `/v1/sessions/${created.session.id}/end`
  ]) {
    const response = await appModule.app.request(`https://agentcontract.test${path}`, {
      method: path.endsWith("/events") || path.endsWith("/end") ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${keyB}`,
        "content-type": "application/json"
      },
      body: path.endsWith("/events")
        ? JSON.stringify({ event_type: "tamper", content_text: "not allowed" })
        : path.endsWith("/end")
          ? JSON.stringify({ outcome: "not allowed" })
          : undefined
    });
    assert.equal(response.status, 404, path);
  }
});

test("email login verification with the wrong email does not consume the code", async () => {
  const { createEmailLoginCode } = await import("../src/lib/cliLogin.js");
  const code = await createEmailLoginCode({
    ownerEmail: "login-victim@example.com",
    keyName: "Victim login"
  });

  const wrongEmailResponse = await appModule.app.request("https://agentcontract.test/cli/magic/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "login-attacker@example.com",
      code
    })
  });
  assert.equal(wrongEmailResponse.status, 400);

  const victimResponse = await appModule.app.request("https://agentcontract.test/cli/magic/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "login-victim@example.com",
      code
    })
  });
  assert.equal(victimResponse.status, 200);
  const body = await victimResponse.json() as { owner_email?: string; api_key?: string };
  assert.equal(body.owner_email, "login-victim@example.com");
  assert.match(body.api_key ?? "", /^ak_/);
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

test("CLI session event dry run posts to the session events API", async () => {
  const { stdout } = await execFileAsync("npm", [
    "run",
    "cli",
    "--",
    "session",
    "event",
    "--session-id",
    "sess_feedback123",
    "--type",
    "user_message",
    "--role",
    "user",
    "--text",
    "Send the three agreements",
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
    payload?: { event_type?: string; actor_role?: string; content_text?: string };
  };
  assert.equal(result.dry_run, true);
  assert.equal(result.url?.endsWith("/v1/sessions/sess_feedback123/events"), true);
  assert.equal(result.payload?.event_type, "user_message");
  assert.equal(result.payload?.actor_role, "user");
  assert.equal(result.payload?.content_text, "Send the three agreements");
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
  assert.equal(result.url?.startsWith("https://agentcontract.to/"), true);
  assert.equal(result.command, "specific-privacy");
  assert.equal(result.url?.endsWith("/v1/agreements"), true);
  assert.equal(result.payload?.template, "privacy");
  assert.equal(result.payload?.metadata?.workflow, "specific_privacy_acknowledgement");
});

test("CLI marketplace onboarding uses logged-in sender defaults when configured", async () => {
  const config = join(tmpdir(), `agentcontract-configured-sender-${Date.now()}.json`);
  await writeFile(config, JSON.stringify({
    api_url: "https://agentcontract.to",
    api_key: "ak_test_configured_sender",
    sender_email: "jake@agentmail.to",
    sender_name: "Jake Agent"
  }));

  const { stdout } = await execFileAsync("npm", [
    "run",
    "cli",
    "--",
    "marketplace-onboard",
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
      AGENTCONTRACT_CONFIG: config,
      AGENTCONTRACT_SENDER_EMAIL: "",
      AGENTSIGN_SENDER_EMAIL: ""
    }
  });
  const result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    payload?: { sender_email?: string; sender_name?: string; notification_email?: string[] };
  };
  assert.equal(result.payload?.sender_email, "jake@agentmail.to");
  assert.equal(result.payload?.sender_name, "Jake Agent");
  assert.deepEqual(result.payload?.notification_email, ["jake@agentmail.to"]);
});

test("CLI skill prints instructions by default without installing", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcontract-skill-home-"));
  const { stdout } = await execFileAsync("npm", [
    "run",
    "cli",
    "--",
    "skill"
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      AGENTCONTRACT_CONFIG: join(home, ".agentcontract", "config.json")
    }
  });

  assert.match(stdout, /Use AgentContract when a user asks to send a contract/);
  await assert.rejects(readFile(join(home, ".claude", "skills", "agentcontract-cli", "SKILL.md")));
  await rm(home, { recursive: true, force: true });
});

test("install script uses the hosted tarball and writable npm prefix fallback", async () => {
  const response = await appModule.app.request("https://agentcontract.test/cli/install.sh");
  assert.equal(response.status, 200);
  const script = await response.text();
  const tarball = await readFile(join(process.cwd(), "public", "agentcontract-0.1.14.tgz"));
  const tarballSha256 = createHash("sha256").update(tarball).digest("hex");
  assert.match(script, /agentcontract-0\.1\.14\.tgz/);
  assert.match(script, /package_url="https:\/\/agentcontract\.test\/cli\/agentcontract-0\.1\.14\.tgz"/);
  assert.doesNotMatch(script, /package_url="https:\/\/agentcontract\.test\/agentcontract-/);
  assert.match(script, new RegExp(`package_sha256="${tarballSha256}"`));
  assert.match(script, /shasum -a 256 -c -/);
  assert.match(script, /AGENTCONTRACT_NPM_PREFIX/);
  assert.match(script, /agentcontract_existing_prefix/);
  assert.match(script, /\[ -n "\$existing_prefix" \]/);
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
    "0.1.15",
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
  assert.equal(result.latest_version, "0.1.15");
  assert.equal(result.update_available, true);
});

test("CLI update refuses to report success when the active command stays old", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "agentcontract-fake-bin-"));
  await writeFile(join(fakeBin, "bash"), "#!/bin/sh\nexit 0\n");
  await writeFile(
    join(fakeBin, "agentcontract"),
    "#!/bin/sh\nprintf '%s\\n' '{\"cli\":\"agentcontract\",\"package\":\"@bear-ai-dev/agentcontract\",\"version\":\"0.1.12\"}'\n"
  );
  await Promise.all([
    chmod(join(fakeBin, "bash"), 0o755),
    chmod(join(fakeBin, "agentcontract"), 0o755)
  ]);

  try {
    await assert.rejects(
      execFileAsync("npm", [
        "run",
        "cli",
        "--",
        "update",
        "--yes",
        "--latest-version",
        "0.1.15",
        "--json"
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          AGENTCONTRACT_CONFIG: join(tmpdir(), `agentcontract-update-shell-${Date.now()}.json`)
        }
      }),
      /active AgentContract CLI is still 0\.1\.12/
    );
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});
