import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createPosthogTelemetry } from "../src/lib/posthog.js";

class FakePosthogClient {
  events: Array<{ distinctId?: string; event: string; properties?: Record<string, unknown> }> = [];
  exceptions: Array<{ error: unknown; distinctId?: string; properties?: Record<string, unknown> }> = [];
  flushes = 0;
  shutdowns = 0;

  capture(event: { distinctId?: string; event: string; properties?: Record<string, unknown> }) {
    this.events.push(event);
  }

  captureException(error: unknown, distinctId?: string, properties?: Record<string, unknown>) {
    this.exceptions.push({ error, distinctId, properties });
  }

  async flush() {
    this.flushes += 1;
  }

  async shutdown() {
    this.shutdowns += 1;
  }
}

test("PostHog telemetry stays inert without a project token", () => {
  const fake = new FakePosthogClient();
  const telemetry = createPosthogTelemetry({ projectApiKey: "", client: fake });

  telemetry.captureEvent("agreement created", { agreement_id: "agr_123" }, "user_1");

  assert.equal(telemetry.enabled, false);
  assert.deepEqual(fake.events, []);
});

test("PostHog telemetry sanitizes sensitive properties before capture", () => {
  const fake = new FakePosthogClient();
  const telemetry = createPosthogTelemetry({ projectApiKey: "phc_test", client: fake });

  telemetry.captureEvent("api key created", {
    api_key: "ak_live_secret",
    authorization: "Bearer secret",
    nested: {
      keep: "visible",
      signing_token: "tok_secret"
    }
  }, "owner@example.com");

  assert.equal(fake.events.length, 1);
  assert.equal(fake.events[0].distinctId, "owner@example.com");
  assert.equal(fake.events[0].properties?.api_key, "[redacted]");
  assert.equal(fake.events[0].properties?.authorization, "[redacted]");
  assert.deepEqual(fake.events[0].properties?.nested, {
    keep: "visible",
    signing_token: "[redacted]"
  });
});

test("PostHog Hono middleware captures request completion without raw secrets", async () => {
  const fake = new FakePosthogClient();
  const telemetry = createPosthogTelemetry({ projectApiKey: "phc_test", client: fake });
  const app = new Hono();

  app.use("*", telemetry.middleware());
  app.get("/ok", (c) => {
    c.set("posthogDistinctId", "owner@example.com");
    return c.text("ok");
  });

  const response = await app.request("https://agentcontract.test/ok?api_key=secret", {
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
      "user-agent": "Telemetry Test",
      "x-forwarded-for": "203.0.113.10"
    }
  });

  assert.equal(response.status, 200);
  assert.equal(fake.events.length, 1);
  assert.equal(fake.events[0].event, "http request completed");
  assert.equal(fake.events[0].distinctId, "owner@example.com");
  assert.equal(fake.events[0].properties?.method, "GET");
  assert.equal(fake.events[0].properties?.path, "/ok");
  assert.equal(fake.events[0].properties?.status, 200);
  assert.equal(fake.events[0].properties?.user_agent, "Telemetry Test");
  assert.equal("authorization" in (fake.events[0].properties ?? {}), false);
  assert.equal("cookie" in (fake.events[0].properties ?? {}), false);
  assert.equal("url" in (fake.events[0].properties ?? {}), false);
});

test("PostHog error capture includes Hono request context and flushes", async () => {
  const fake = new FakePosthogClient();
  const telemetry = createPosthogTelemetry({ projectApiKey: "phc_test", client: fake });
  const app = new Hono();

  app.use("*", telemetry.middleware());
  app.get("/boom", (c) => {
    c.set("posthogDistinctId", "owner@example.com");
    throw new Error("boom");
  });
  app.onError(async (error, c) => {
    await telemetry.captureException(error, c, { handled_by: "test" });
    return c.text("Internal Server Error", 500);
  });

  const response = await app.request("https://agentcontract.test/boom");

  assert.equal(response.status, 500);
  assert.equal(fake.exceptions.length, 1);
  assert.equal(fake.exceptions[0].distinctId, "owner@example.com");
  assert.equal(fake.exceptions[0].properties?.path, "/boom");
  assert.equal(fake.exceptions[0].properties?.method, "GET");
  assert.equal(fake.exceptions[0].properties?.handled_by, "test");
  assert.equal(fake.flushes, 1);
  assert.equal(fake.events.at(-1)?.event, "http request completed");
  assert.equal(fake.events.at(-1)?.properties?.status, 500);
});
