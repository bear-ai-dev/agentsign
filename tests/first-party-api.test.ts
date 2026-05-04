import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-first-party-test-"));
process.env.DATABASE_PATH = join(tempDir, "agentcontract.db");
process.env.PDF_OUTPUT_DIR = join(tempDir, "pdfs");
process.env.AGENTCONTRACT_API_KEY = "ak_bootstrap_first_party";
process.env.RESEND_API_KEY = "re_test";
process.env.VERCEL_API_TOKEN = "vercel_test";
process.env.VERCEL_PROJECT_ID = "agentcontract-project";
process.env.BASE_URL = "http://agentcontract.test";

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

const fields = [
  { id: "full_name", label: "Full legal name", type: "text", required: true },
  { id: "signature", label: "Signature", type: "signature", required: true }
];

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function installProviderFetchMock() {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = rawBody ? JSON.parse(rawBody) as unknown : undefined;
    calls.push({ url, method, body });

    if (url.includes("api.resend.com/domains") && method === "POST" && !url.endsWith("/verify")) {
      return jsonResponse({
        id: "resend_dom_acme",
        name: "acme.com",
        status: "pending",
        records: [
          { type: "TXT", name: "@", value: "v=spf1 include:amazonses.com ~all", status: "pending" },
          { type: "CNAME", name: "resend._domainkey", value: "resend._domainkey.acme.com", status: "pending" }
        ]
      });
    }

    if (url.includes("api.resend.com/domains") && url.endsWith("/verify")) {
      return jsonResponse({
        id: "resend_dom_acme",
        name: "acme.com",
        status: "verified",
        records: [
          { type: "TXT", name: "@", value: "v=spf1 include:amazonses.com ~all", status: "verified" }
        ]
      });
    }

    if (url.includes("api.resend.com/domains/resend_dom_acme") && method === "GET") {
      return jsonResponse({
        id: "resend_dom_acme",
        name: "acme.com",
        status: "verified",
        records: [
          { type: "TXT", name: "@", value: "v=spf1 include:amazonses.com ~all", status: "verified" }
        ]
      });
    }

    if (url.includes("api.vercel.com") && method === "POST") {
      return jsonResponse({ name: "contracts.acme.com", verified: false });
    }

    if (url.includes("api.vercel.com") && method === "GET") {
      return jsonResponse({ name: "contracts.acme.com", verified: true });
    }

    if (url.includes("api.resend.com/emails")) {
      return jsonResponse({ id: `email_${calls.length}` });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
  return calls;
}

async function appModules() {
  const [{ app }, { createApiKey }] = await Promise.all([
    import("../src/app.js"),
    import("../src/lib/apiKeys.js")
  ]);
  return { app, createApiKey };
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

async function createVerifiedProfile(ownerEmail: string) {
  const { app } = await appModules();
  const key = await userKey(ownerEmail);
  const setup = await app.request("http://agentcontract.test/v1/sender-profile", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      email_domain: "acme.com",
      signing_domain: "contracts.acme.com",
      from_email: "legal@acme.com",
      from_name: "Acme Legal"
    })
  });
  assert.equal(setup.status, 201, await setup.clone().text());

  const verify = await app.request("http://agentcontract.test/v1/sender-profile/verify", {
    method: "POST",
    headers: authHeaders(key)
  });
  assert.equal(verify.status, 200, await verify.clone().text());
  return { app, key };
}

test("sender profile setup stores Resend DNS records and Vercel signing-domain status", async () => {
  const calls = installProviderFetchMock();
  const { app } = await appModules();
  const key = await userKey("founder-setup@example.com");

  const response = await app.request("http://agentcontract.test/v1/sender-profile", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      email_domain: "acme.com",
      signing_domain: "contracts.acme.com",
      from_email: "legal@acme.com",
      from_name: "Acme Legal"
    })
  });

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json() as {
    profile: {
      owner_email: string;
      email_domain: string;
      signing_domain: string;
      default_from_email: string;
      email_domain_status: string;
      signing_domain_status: string;
    };
    email_dns_records: Array<{ type: string; name: string; value: string }>;
    signing_dns_records: Array<{ type: string; name: string; value: string }>;
  };
  assert.equal(body.profile.owner_email, "founder-setup@example.com");
  assert.equal(body.profile.email_domain, "acme.com");
  assert.equal(body.profile.signing_domain, "contracts.acme.com");
  assert.equal(body.profile.default_from_email, "legal@acme.com");
  assert.equal(body.profile.email_domain_status, "pending");
  assert.equal(body.profile.signing_domain_status, "pending");
  assert.equal(body.email_dns_records.some((record) => record.type === "TXT"), true);
  assert.deepEqual(body.signing_dns_records[0], {
    type: "CNAME",
    name: "contracts.acme.com",
    value: "cname.vercel-dns.com"
  });
  assert.equal(calls.some((call) => call.url.includes("api.resend.com/domains")), true);
  assert.equal(calls.some((call) => call.url.includes("api.vercel.com")), true);
});

test("verified domain can send from a customer legal address with branded signing links", async () => {
  installProviderFetchMock();
  const { app, key } = await createVerifiedProfile("founder-send@example.com");

  const response = await app.request("http://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      recipient: { name: "Recipient Person", email: "recipient@example.com" },
      sender_email: "legal@acme.com",
      sender_name: "Acme Legal",
      template: "nda",
      template_vars: { company_name: "Acme Inc." },
      fields
    })
  });

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json() as {
    signing_url: string;
    preview_url: string;
    sender_profile_id: string;
  };
  assert.match(body.sender_profile_id, /^sp_/);
  assert.match(body.signing_url, /^https:\/\/contracts\.acme\.com\/sign\//);
  assert.match(body.preview_url, /^https:\/\/contracts\.acme\.com\/preview\//);
});

test("verified sender profile allows a 15-recipient NDA batch", async () => {
  installProviderFetchMock();
  const { app, key } = await createVerifiedProfile("founder-bulk@example.com");

  const response = await app.request("http://agentcontract.test/v1/agreements/bulk", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      template: "nda",
      template_vars_default: { company_name: "Acme Inc." },
      sender_email: "legal@acme.com",
      sender_name: "Acme Legal",
      fields,
      recipients: Array.from({ length: 15 }, (_, index) => ({
        name: `Recipient ${index + 1}`,
        email: `recipient-${index + 1}@example.com`
      }))
    })
  });

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json() as {
    batch_id: string;
    batch: { id: string; total_count: number; sent_count: number; failed_count: number };
    agreements: unknown[];
    failed: unknown[];
  };
  assert.match(body.batch_id, /^bat_/);
  assert.equal(body.batch.id, body.batch_id);
  assert.equal(body.batch.total_count, 15);
  assert.equal(body.batch.sent_count, 15);
  assert.equal(body.batch.failed_count, 0);
  assert.equal(body.agreements.length, 15);
  assert.deepEqual(body.failed, []);
});

test("custom signing host renders matching agreement and rejects mismatched host", async () => {
  installProviderFetchMock();
  const { app, key } = await createVerifiedProfile("founder-host@example.com");
  const create = await app.request("http://agentcontract.test/v1/agreements", {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify({
      recipient: { name: "Recipient Person", email: "recipient-host@example.com" },
      sender_email: "legal@acme.com",
      sender_name: "Acme Legal",
      template: "nda",
      template_vars: { company_name: "Acme Inc." },
      fields
    })
  });
  assert.equal(create.status, 201, await create.clone().text());
  const created = await create.json() as { signing_url: string };
  const signingUrl = new URL(created.signing_url);

  const good = await app.request(signingUrl.toString(), {
    headers: { Host: "contracts.acme.com" }
  });
  assert.equal(good.status, 200);

  const bad = await app.request(`https://other.example.com${signingUrl.pathname}`, {
    headers: { Host: "other.example.com" }
  });
  assert.equal(bad.status, 404);
});
