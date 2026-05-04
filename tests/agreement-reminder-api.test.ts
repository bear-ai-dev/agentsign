import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("sender reminder resends the sender signing link after recipient has signed", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-api-test-"));
  process.env.DATABASE_PATH = join(tempDir, "agentcontract.db");
  process.env.PDF_OUTPUT_DIR = join(tempDir, "pdfs");
  process.env.AGENTCONTRACT_API_KEY = "ak_test";
  process.env.RESEND_API_KEY = "";
  process.env.BASE_URL = "http://agentcontract.test";

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...items: unknown[]) => {
    logs.push(items.map(String).join(" "));
  };

  try {
    const [{ createAgreement, agreements }, { run }] = await Promise.all([
      import("../src/routes/agreements.js"),
      import("../src/lib/db.js")
    ]);

    const agreement = await createAgreement({
      recipient: { name: "Recipient Person", email: "recipient@example.com" },
      sender_email: "sender@example.com",
      sender_name: "Sender Person",
      template: "nda",
      template_vars: { company_name: "Acme Inc." },
      fields: [
        { id: "full_name", label: "Full legal name", type: "text", required: true },
        { id: "signature", label: "Signature", type: "signature", required: true }
      ]
    }, "http://agentcontract.test");

    assert.equal(typeof agreement.sender_signing_url, "string");

    await run(
      "UPDATE agreements SET signed_fields_json = ? WHERE id = ?",
      JSON.stringify({
        recipient: {
          full_name: "Recipient Person",
          signature: { typed_name: "Recipient Person" }
        }
      }),
      agreement.id
    );

    logs.length = 0;
    const response = await agreements.request(`http://agentcontract.test/v1/agreements/${agreement.id}/remind`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ak_test",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ target: "sender" })
    });

    assert.equal(response.status, 200);
    const body = await response.json() as {
      target?: string;
      reminded?: Array<{ role?: string; email?: string }>;
    };
    assert.equal(body.target, "sender");
    assert.deepEqual(body.reminded, [{ role: "sender", email: "sender@example.com" }]);

    const output = logs.join("\n");
    assert.match(output, /To: sender@example\.com/);
    assert.match(output, new RegExp(agreement.sender_signing_url!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output, /To: recipient@example\.com/);
  } finally {
    console.log = originalLog;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
