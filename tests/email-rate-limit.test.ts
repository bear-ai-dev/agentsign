import assert from "node:assert/strict";
import test from "node:test";

process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "contracts@example.com";
process.env.EMAIL_FROM_NAME = "AgentContract";
process.env.RESEND_EMAILS_PER_SECOND = "1000";

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("email delivery retries once after a Resend rate-limit response", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    calls.push({ url, method });

    if (calls.length === 1) {
      return new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "0"
        }
      });
    }

    return new Response(JSON.stringify({ id: "email_retry_ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  const { sendCliLoginCodeEmail } = await import("../src/lib/email.js");
  await sendCliLoginCodeEmail({ to: "founder@example.com", code: "123456", expiresInMinutes: 5 });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);
  assert.equal(calls.every((call) => call.url === "https://api.resend.com/emails"), true);
});
