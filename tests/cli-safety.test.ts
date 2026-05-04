import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type CapturedRequest = {
  method: string;
  url: string;
  body: unknown;
};

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function startMockApi() {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawBody = await readBody(req);
    const body = rawBody ? JSON.parse(rawBody) as unknown : {};
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      body
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/v1/sender-profile" && req.method === "POST") {
      res.end(JSON.stringify({
        profile: {
          id: "sp_cli",
          owner_email: "owner@example.com",
          email_domain: (body as { email_domain?: string }).email_domain,
          signing_domain: (body as { signing_domain?: string }).signing_domain,
          default_from_email: (body as { from_email?: string }).from_email,
          default_from_name: (body as { from_name?: string }).from_name,
          email_domain_status: "pending",
          signing_domain_status: "pending"
        },
        email_dns_records: [{ type: "TXT", name: "@", value: "v=spf1 include:amazonses.com ~all" }],
        signing_dns_records: [{ type: "CNAME", name: "contracts.acme.com", value: "cname.vercel-dns.com" }]
      }));
      return;
    }
    if (req.url === "/v1/sender-profile" && req.method === "GET") {
      res.end(JSON.stringify({
        profile: {
          id: "sp_cli",
          owner_email: "owner@example.com",
          email_domain: "acme.com",
          signing_domain: "contracts.acme.com",
          default_from_email: "legal@acme.com",
          default_from_name: "Acme Legal",
          email_domain_status: "verified",
          signing_domain_status: "verified"
        },
        email_dns_records: [],
        signing_dns_records: []
      }));
      return;
    }
    if (req.url === "/v1/sender-profile/verify" && req.method === "POST") {
      res.end(JSON.stringify({
        profile: {
          id: "sp_cli",
          owner_email: "owner@example.com",
          email_domain: "acme.com",
          signing_domain: "contracts.acme.com",
          default_from_email: "legal@acme.com",
          default_from_name: "Acme Legal",
          email_domain_status: "verified",
          signing_domain_status: "verified"
        },
        email_dns_records: [],
        signing_dns_records: []
      }));
      return;
    }
    if (req.url === "/v1/agreements/bulk" && req.method === "POST") {
      res.end(JSON.stringify({
        batch_id: "bat_cli",
        batch: { id: "bat_cli", status: "completed", total_count: 2, sent_count: 2, failed_count: 0 },
        agreements: [{ id: "agr_cli_1" }, { id: "agr_cli_2" }],
        failed: []
      }));
      return;
    }
    if (req.url === "/v1/agreement-batches/bat_cli" && req.method === "GET") {
      res.end(JSON.stringify({
        batch: { id: "bat_cli", status: "completed", total_count: 2, sent_count: 2, failed_count: 0 },
        items: [{ agreement_id: "agr_cli_1", status: "sent" }, { agreement_id: "agr_cli_2", status: "sent" }]
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true, target: (body as { target?: string }).target }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert(address && typeof address === "object");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("domain setup, status, and verify call the sender profile APIs", async () => {
  const api = await startMockApi();
  try {
    const setup = await runCli([
      "domain",
      "setup",
      "--email-domain",
      "acme.com",
      "--signing-domain",
      "contracts.acme.com",
      "--from",
      "legal@acme.com",
      "--sender-name",
      "Acme Legal",
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-telemetry"
    ]);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /"email_domain": "acme\.com"/);

    const status = await runCli([
      "domain",
      "status",
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-telemetry"
    ]);
    assert.equal(status.code, 0, status.stderr);

    const verify = await runCli([
      "domain",
      "verify",
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-telemetry"
    ]);
    assert.equal(verify.code, 0, verify.stderr);

    assert.equal(api.requests[0].method, "POST");
    assert.equal(api.requests[0].url, "/v1/sender-profile");
    assert.deepEqual(api.requests[0].body, {
      email_domain: "acme.com",
      signing_domain: "contracts.acme.com",
      from_email: "legal@acme.com",
      from_name: "Acme Legal"
    });
    assert.equal(api.requests[1].method, "GET");
    assert.equal(api.requests[1].url, "/v1/sender-profile");
    assert.equal(api.requests[2].method, "POST");
    assert.equal(api.requests[2].url, "/v1/sender-profile/verify");
  } finally {
    await api.close();
  }
});

function runCli(argv: string[], input = "") {
  const configDir = mkdtempSync(join(tmpdir(), "agentcontract-cli-test-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...argv], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTCONTRACT_AUTO_UPDATE: "0",
      AGENTCONTRACT_CONFIG: join(configDir, "config.json"),
      AGENTCONTRACT_UPDATE_STATE: join(configDir, "update.json")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => {
      rmSync(configDir, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

test("agreement remind requires an explicit reminder target before sending email", async () => {
  const api = await startMockApi();
  try {
    const result = await runCli([
      "agreement",
      "remind",
      "agr_123",
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-telemetry"
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Reminder target confirmation required/);
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test("agreement remind sends the selected reminder target to the API", async () => {
  const api = await startMockApi();
  try {
    const result = await runCli([
      "agreement",
      "remind",
      "agr_123",
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--remind-self",
      "--json",
      "--no-telemetry"
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "POST");
    assert.equal(api.requests[0].url, "/v1/agreements/agr_123/remind");
    assert.deepEqual(api.requests[0].body, { target: "sender" });
    assert.match(result.stdout, /"target": "sender"/);
  } finally {
    await api.close();
  }
});

test("specific-privacy sends saved privacy contract markdown instead of the server privacy template", async () => {
  const api = await startMockApi();
  const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-specific-privacy-test-"));
  try {
    const privacyDir = join(tempDir, "privacy");
    mkdirSync(privacyDir, { recursive: true });
    writeFileSync(join(privacyDir, "contract.md"), [
      "# Specific Marketplace Privacy Policy",
      "",
      "**Specific Marketplace**",
      "",
      "Specific uses https://www.specific.com and privacy@specific.com for contributor privacy notices."
    ].join("\n"));
    writeFileSync(join(privacyDir, "contract.json"), JSON.stringify({
      id: "privacy",
      name: "Specific Marketplace Privacy Policy",
      fields: [
        { id: "full_name", label: "Full legal name", type: "text", required: true },
        { id: "acknowledgement_date", label: "Acknowledgement date", type: "date", required: true },
        { id: "signature", label: "Signature", type: "signature", required: true }
      ],
      template_vars_default: { effective_date: "May 4, 2026" },
      created_at: "test",
      updated_at: "test"
    }));

    const result = await runCli([
      "specific-privacy",
      "--to",
      "frankiew@ucla.edu",
      "--name",
      "Frankie Wu",
      "--sender-name",
      "Sid from Specific",
      "--contract-dir",
      tempDir,
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-session",
      "--no-telemetry"
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "POST");
    assert.equal(api.requests[0].url, "/v1/agreements");
    const body = api.requests[0].body as {
      template?: string;
      document_markdown?: string;
      document_title?: string;
      metadata?: Record<string, unknown>;
    };
    assert.equal(body.template, undefined);
    assert.match(body.document_markdown ?? "", /# Specific Marketplace Privacy Policy/);
    assert.doesNotMatch(body.document_markdown ?? "", /Acme|example\.com|you@example\.com/);
    assert.equal(body.document_title, "Specific Marketplace Privacy Policy");
    assert.equal(body.metadata?.workflow, "specific_privacy_acknowledgement");
    assert.equal(body.metadata?.company, "Specific Marketplace");
    assert.equal(body.metadata?.contract_id, "privacy");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("specific-privacy refuses a placeholder privacy contract before posting", async () => {
  const api = await startMockApi();
  const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-specific-privacy-bad-test-"));
  try {
    const privacyDir = join(tempDir, "privacy");
    mkdirSync(privacyDir, { recursive: true });
    writeFileSync(join(privacyDir, "contract.md"), [
      "# Acme Marketplace Privacy Policy",
      "",
      "Contact us at you@example.com or visit example.com."
    ].join("\n"));
    writeFileSync(join(privacyDir, "contract.json"), JSON.stringify({
      id: "privacy",
      name: "Acme Marketplace Privacy Policy",
      fields: [
        { id: "full_name", label: "Full legal name", type: "text", required: true },
        { id: "signature", label: "Signature", type: "signature", required: true }
      ],
      template_vars_default: {},
      created_at: "test",
      updated_at: "test"
    }));

    const result = await runCli([
      "specific-privacy",
      "--to",
      "frankiew@ucla.edu",
      "--name",
      "Frankie Wu",
      "--contract-dir",
      tempDir,
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-session",
      "--no-telemetry"
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Specific privacy contract contains Acme placeholder content/);
    assert.equal(api.requests.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("bulk sends require explicit confirmation before mass email", async () => {
  const api = await startMockApi();
  const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-bulk-test-"));
  try {
    const recipientsPath = join(tempDir, "recipients.json");
    writeFileSync(recipientsPath, JSON.stringify([
      { name: "Alice Contributor", email: "alice@example.com" },
      { name: "Bob Contributor", email: "bob@example.com" }
    ]));

    const result = await runCli([
      "bulk-specific-contractor",
      "--file",
      recipientsPath,
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-session",
      "--no-telemetry"
    ]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Bulk email confirmation required/);
    assert.equal(api.requests.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("bulk sends proceed after explicit noninteractive confirmation", async () => {
  const api = await startMockApi();
  const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-bulk-test-"));
  try {
    const recipientsPath = join(tempDir, "recipients.json");
    writeFileSync(recipientsPath, JSON.stringify([
      { name: "Alice Contributor", email: "alice@example.com" },
      { name: "Bob Contributor", email: "bob@example.com" }
    ]));

    const result = await runCli([
      "bulk-specific-contractor",
      "--file",
      recipientsPath,
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--yes",
      "--json",
      "--no-session",
      "--no-telemetry"
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"batch_id": "bat_cli"/);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "POST");
    assert.equal(api.requests[0].url, "/v1/agreements/bulk");
    assert.equal((api.requests[0].body as { recipients?: unknown[] }).recipients?.length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("batch read fetches a durable agreement batch", async () => {
  const api = await startMockApi();
  try {
    const result = await runCli([
      "batch",
      "read",
      "bat_cli",
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-telemetry"
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"id": "bat_cli"/);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "GET");
    assert.equal(api.requests[0].url, "/v1/agreement-batches/bat_cli");
  } finally {
    await api.close();
  }
});

test("send-pdf wraps a local PDF in an agreement payload", async () => {
  const api = await startMockApi();
  const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-pdf-test-"));
  try {
    const pdfPath = join(tempDir, "partner-sow.pdf");
    const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    writeFileSync(pdfPath, pdfBytes);

    const result = await runCli([
      "send-pdf",
      pdfPath,
      "--to",
      "jane@example.com",
      "--name",
      "Jane Doe",
      "--title",
      "Partner SOW",
      "--api-url",
      api.apiUrl,
      "--api-key",
      "ak_test",
      "--json",
      "--no-session",
      "--no-telemetry"
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "POST");
    assert.equal(api.requests[0].url, "/v1/agreements");
    const body = api.requests[0].body as {
      document_pdf_base64?: string;
      document_pdf_filename?: string;
      document_title?: string;
      fields?: Array<{ id?: string; type?: string }>;
      metadata?: Record<string, unknown>;
    };
    assert.equal(body.document_pdf_base64, pdfBytes.toString("base64"));
    assert.equal(body.document_pdf_filename, "partner-sow.pdf");
    assert.equal(body.document_title, "Partner SOW");
    assert.equal(body.fields?.some((field) => field.id === "signature" && field.type === "signature"), true);
    assert.equal(body.metadata?.workflow, "byo_pdf");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    await api.close();
  }
});
