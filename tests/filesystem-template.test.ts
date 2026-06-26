import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadTemplate, templateDefinitions } from "../src/lib/templates.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("filesystem purchase agreement template has 39 Tehama language and counter-sign fields", () => {
  const template = templateDefinitions["filesystem-purchase-agreement"];
  const markdown = loadTemplate("filesystem-purchase-agreement");

  assert.equal(template.name, "Filesystem Purchase Agreement");
  assert.equal(template.fields.length, 9);
  assert.equal(template.fields.find((field) => field.id === "seller_signature")?.signerRole, "recipient");
  assert.equal(template.fields.find((field) => field.id === "buyer_signature")?.signerRole, "sender");
  assert.match(markdown, /Bear AI Inc\., 39 Tehama St, San Francisco, CA 94105/);
  assert.match(markdown, /JAMS Streamlined Arbitration Rules and Procedures/);
  assert.match(markdown, /ARBITRATION NOTICE AND CLASS ACTION WAIVER/);
  assert.match(markdown, /\{\{signed:buyer_signature\}\}/);
  assert.match(markdown, /\{\{signed:seller_signature\}\}/);
  assert.doesNotMatch(markdown, /2261 Market/);
});

test("template send dry-run defaults filesystem agreement to recipient-first countersignature", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "template",
    "send",
    "filesystem-purchase-agreement",
    "--to",
    "seller@example.com",
    "--name",
    "Seller Person",
    "--from",
    "janak@usebear.ai",
    "--sender-name",
    "Janak",
    "--dry-run",
    "--json"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTCONTRACT_API_URL: "https://agentcontract.test"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const dryRun = JSON.parse(result.stdout) as {
    payload: {
      template: string;
      sender_signature_required?: boolean;
      signing_order?: string;
      fields: Array<{ id: string; signerRole?: string }>;
    };
  };

  assert.equal(dryRun.payload.template, "filesystem-purchase-agreement");
  assert.equal(dryRun.payload.sender_signature_required, true);
  assert.equal(dryRun.payload.signing_order, "recipient_first");
  assert.equal(dryRun.payload.fields.find((field) => field.id === "seller_signature")?.signerRole, "recipient");
  assert.equal(dryRun.payload.fields.find((field) => field.id === "buyer_signature")?.signerRole, "sender");
});
