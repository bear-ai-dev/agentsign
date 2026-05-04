import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-launch-test-"));
process.env.DATABASE_PATH = join(tempDir, "agentcontract.db");
process.env.PDF_OUTPUT_DIR = join(tempDir, "pdfs");
process.env.AGENTCONTRACT_API_KEY = "ak_bootstrap_test";
process.env.RESEND_API_KEY = "";
process.env.BASE_URL = "http://agentcontract.test";
process.env.AGENTCONTRACT_UNLIMITED_SEND_OWNERS = "unlimited@example.com";

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const fields = [
  { id: "full_name", label: "Full legal name", type: "text", required: true },
  { id: "signature", label: "Signature", type: "signature", required: true }
];
const samplePdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

async function apiModules() {
  const [{ agreements }, { createApiKey }, { all }] = await Promise.all([
    import("../src/routes/agreements.js"),
    import("../src/lib/apiKeys.js"),
    import("../src/lib/db.js")
  ]);
  return { agreements, createApiKey, all };
}

async function authModules() {
  const [{ auth }, { all }] = await Promise.all([
    import("../src/routes/auth.js"),
    import("../src/lib/db.js")
  ]);
  return { auth, all };
}

async function telemetryModules() {
  const [{ telemetry }, { createApiKey }, { all }] = await Promise.all([
    import("../src/routes/telemetry.js"),
    import("../src/lib/apiKeys.js"),
    import("../src/lib/db.js")
  ]);
  return { telemetry, createApiKey, all };
}

async function userKey(email: string) {
  const { createApiKey } = await import("../src/lib/apiKeys.js");
  const { key } = await createApiKey({ ownerEmail: email, name: `${email} CLI` });
  return key;
}

function authHeaders(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
}

function agreementBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    recipient: { name: "Recipient Person", email },
    template: "nda",
    template_vars: { company_name: "Acme Inc." },
    fields,
    ...overrides
  };
}

test("agreement APIs are scoped to the API key owner while bootstrap can see all agreements", async () => {
  const { agreements } = await apiModules();
  const ownerA = await userKey("owner-a@example.com");
  const ownerB = await userKey("owner-b@example.com");

  const createResponse = await agreements.request("http://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: authHeaders(ownerA),
    body: JSON.stringify(agreementBody("recipient-a@example.com"))
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string };

  const ownerList = await agreements.request("http://agentcontract.test/v1/agreements", {
    headers: { Authorization: `Bearer ${ownerA}` }
  });
  assert.equal(ownerList.status, 200);
  assert.equal(((await ownerList.json()) as { agreements: unknown[] }).agreements.length, 1);

  const otherList = await agreements.request("http://agentcontract.test/v1/agreements", {
    headers: { Authorization: `Bearer ${ownerB}` }
  });
  assert.equal(otherList.status, 200);
  assert.deepEqual(((await otherList.json()) as { agreements: unknown[] }).agreements, []);

  for (const [method, path, body] of [
    ["GET", `/v1/agreements/${created.id}`, undefined],
    ["GET", `/v1/agreements/${created.id}/document`, undefined],
    ["GET", `/v1/agreements/${created.id}/audit`, undefined],
    ["GET", `/v1/agreements/${created.id}/pdf`, undefined],
    ["POST", `/v1/agreements/${created.id}/cancel`, {}],
    ["POST", `/v1/agreements/${created.id}/remind`, { target: "recipient" }]
  ] as const) {
    const response = await agreements.request(`http://agentcontract.test${path}`, {
      method,
      headers: authHeaders(ownerB),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    assert.equal(response.status, 404, `${method} ${path}`);
  }

  const bootstrapResponse = await agreements.request(`http://agentcontract.test/v1/agreements/${created.id}`, {
    headers: { Authorization: "Bearer ak_bootstrap_test" }
  });
  assert.equal(bootstrapResponse.status, 200);
});

test("user-owned keys cannot spoof sender_email on agreement creation", async () => {
  const { agreements } = await apiModules();
  const key = await userKey("sender-owner@example.com");

  const response = await agreements.request("http://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify(agreementBody("recipient-spoof@example.com", {
      sender_email: "someone-else@example.com"
    }))
  });

  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /sender_email/i);
});

test("agreement creation accepts an uploaded PDF as the source document", async () => {
  const { agreements } = await apiModules();
  const key = await userKey("pdf-owner@example.com");

  const createResponse = await agreements.request("http://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      recipient: { name: "PDF Recipient", email: "pdf-recipient@example.com" },
      document_pdf_base64: samplePdf.toString("base64"),
      document_pdf_filename: "partner-sow.pdf",
      document_title: "Partner SOW",
      fields
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as { id: string; document_source?: string };
  assert.equal(created.document_source, "pdf");

  const documentResponse = await agreements.request(`http://agentcontract.test/v1/agreements/${created.id}/document`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  assert.equal(documentResponse.status, 200);
  const documentResult = await documentResponse.json() as {
    document_source?: string;
    document_pdf_filename?: string;
    document_pdf_bytes?: number;
    document_markdown?: string;
  };
  assert.equal(documentResult.document_source, "pdf");
  assert.equal(documentResult.document_pdf_filename, "partner-sow.pdf");
  assert.equal(documentResult.document_pdf_bytes, samplePdf.byteLength);
  assert.match(documentResult.document_markdown ?? "", /Partner SOW/);

  const pdfResponse = await agreements.request(`http://agentcontract.test/v1/agreements/${created.id}/original-pdf`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await pdfResponse.arrayBuffer()), samplePdf);
});

test("agreement sends are rate-limited per owner and bulk sends are capped", async () => {
  const { agreements } = await apiModules();
  const rateKey = await userKey("rate-limit@example.com");

  for (let index = 0; index < 10; index += 1) {
    const response = await agreements.request("http://agentcontract.test/v1/agreements", {
      method: "POST",
      headers: authHeaders(rateKey),
      body: JSON.stringify(agreementBody(`rate-${index}@example.com`))
    });
    assert.equal(response.status, 201, `send ${index + 1}`);
  }

  const limited = await agreements.request("http://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: authHeaders(rateKey),
    body: JSON.stringify(agreementBody("rate-limited@example.com"))
  });
  assert.equal(limited.status, 429);

  const bulkKey = await userKey("bulk-limit@example.com");
  const bulk = await agreements.request("http://agentcontract.test/v1/agreements/bulk", {
    method: "POST",
    headers: authHeaders(bulkKey),
    body: JSON.stringify({
      template: "nda",
      template_vars_default: { company_name: "Acme Inc." },
      fields,
      recipients: Array.from({ length: 26 }, (_, index) => ({
        name: `Recipient ${index}`,
        email: `bulk-${index}@example.com`
      }))
    })
  });
  assert.equal(bulk.status, 400);
  assert.match(JSON.stringify(await bulk.json()), /25/);
});

test("configured unlimited owners can send past the standard agreement cap", async () => {
  const { agreements } = await apiModules();
  const key = await userKey("unlimited@example.com");

  for (let index = 0; index < 12; index += 1) {
    const response = await agreements.request("http://agentcontract.test/v1/agreements", {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify(agreementBody(`unlimited-${index}@example.com`))
    });
    assert.equal(response.status, 201, `unlimited send ${index + 1}`);
  }
});

test("email login code starts are rate-limited by email", async () => {
  const { auth } = await authModules();
  const body = new URLSearchParams({ email: "login-limit@example.com", returnTo: "/dashboard" });

  for (let index = 0; index < 5; index += 1) {
    const response = await auth.request("http://agentcontract.test/login/email/start", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    assert.equal(response.status, 200, `login code ${index + 1}`);
  }

  const limited = await auth.request("http://agentcontract.test/login/email/start", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  assert.equal(limited.status, 429);
});

test("telemetry stores failures and explicit prompts only, with legacy sessions as no-op compatibility", async () => {
  const { telemetry, all } = await telemetryModules();
  const key = await userKey("telemetry@example.com");

  const session = await telemetry.request("http://agentcontract.test/v1/agent-sessions", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      agent: "codex",
      initial_goal: "send one NDA",
      metadata: { transcript_text: "do not store this" }
    })
  });
  assert.equal(session.status, 201);
  assert.equal((await all<{ count: number }>("SELECT COUNT(*) AS count FROM agent_sessions"))[0].count, 0);

  const success = await telemetry.request("http://agentcontract.test/v1/cli-runs", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      command: "agentcontract agreements",
      exit_code: 0,
      success: true,
      cli_version: "0.1.9"
    })
  });
  assert.equal(success.status, 202);
  assert.equal((await all<{ count: number }>("SELECT COUNT(*) AS count FROM cli_runs"))[0].count, 0);

  const failure = await telemetry.request("http://agentcontract.test/v1/cli-runs", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      command: "agentcontract send",
      exit_code: 1,
      success: false,
      error_message: "HTTP 500",
      cli_version: "0.1.9",
      prompt: "send Acme an NDA",
      transcript_text: "do not store this",
      transcript_json: { secret: "do not store this" }
    })
  });
  assert.equal(failure.status, 201);

  const rows = await all<{ command: string; error_message: string; metadata_json: string | null }>(
    "SELECT command, error_message, metadata_json FROM cli_runs"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command, "agentcontract send");
  assert.equal(rows[0].error_message, "HTTP 500");
  assert.match(rows[0].metadata_json ?? "", /send Acme an NDA/);
  assert.doesNotMatch(rows[0].metadata_json ?? "", /do not store this/);
});
