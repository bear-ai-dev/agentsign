import assert from "node:assert/strict";
import test from "node:test";

delete process.env.RESEND_EMAILS_PER_SECOND;

test("Resend email delivery defaults to the standard 5 requests per second cap", async () => {
  const { env } = await import("../src/lib/env.js");

  assert.equal(env.resendEmailsPerSecond, 5);
});
