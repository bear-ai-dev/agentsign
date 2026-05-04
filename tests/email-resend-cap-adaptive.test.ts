import assert from "node:assert/strict";
import test from "node:test";

process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "contracts@example.com";
process.env.EMAIL_FROM_NAME = "AgentContract";
process.env.RESEND_EMAILS_PER_SECOND = "30";

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("email delivery backs off when Resend reports a lower per-second cap", async () => {
  const firstRequestAt = Date.now();
  const calls: number[] = [];
  globalThis.fetch = (async () => {
    calls.push(Date.now());

    if (Date.now() - firstRequestAt < 900) {
      return new Response(JSON.stringify({
        message: "Too many requests. You can only make 5 requests per second."
      }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "0"
        }
      });
    }

    return new Response(JSON.stringify({ id: "email_after_backoff" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  const { sendCliLoginCodeEmail } = await import("../src/lib/email.js");
  await sendCliLoginCodeEmail({ to: "founder@example.com", code: "123456", expiresInMinutes: 5 });

  assert.equal(calls.length, 2);
  assert.equal(calls[1] - calls[0] >= 900, true);
});
