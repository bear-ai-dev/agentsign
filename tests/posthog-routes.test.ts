import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

let routeTestDir = "";
let appModule: typeof import("../src/app.js");
let posthogModule: typeof import("../src/lib/posthog.js");

before(async () => {
  routeTestDir = await mkdtemp(join(tmpdir(), "agentcontract-posthog-routes-"));
  process.env.DATABASE_PATH = join(routeTestDir, "agentcontract.db");
  process.env.AGENTCONTRACT_API_KEY = "ak_test_posthog_routes";
  process.env.POSTHOG_PROJECT_API_KEY = "";
  [appModule, posthogModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/lib/posthog.js")
  ]);
});

after(async () => {
  await rm(routeTestDir, { recursive: true, force: true });
});

test("session start emits a product telemetry event without raw goal text", async () => {
  const events: Array<{ event: string; properties: Record<string, unknown>; distinctId?: string }> = [];
  const original = posthogModule.posthog.captureEvent;
  posthogModule.posthog.captureEvent = (event, properties = {}, distinctId) => {
    events.push({ event, properties, distinctId });
  };

  try {
    const response = await appModule.app.request("https://agentcontract.test/v1/sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer ak_test_posthog_routes",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        agent: "codex",
        goal: "send the sensitive acquisition NDA"
      })
    });

    assert.equal(response.status, 201);
    const sessionEvent = events.find((item) => item.event === "agent session started");
    assert.ok(sessionEvent);
    assert.equal(sessionEvent.properties.agent, "codex");
    assert.equal(sessionEvent.properties.source, "agentcontract-cli");
    assert.equal("goal" in sessionEvent.properties, false);
    assert.equal("initial_goal" in sessionEvent.properties, false);
  } finally {
    posthogModule.posthog.captureEvent = original;
  }
});

test("feedback submission emits a product telemetry event without raw message text", async () => {
  const events: Array<{ event: string; properties: Record<string, unknown>; distinctId?: string }> = [];
  const original = posthogModule.posthog.captureEvent;
  posthogModule.posthog.captureEvent = (event, properties = {}, distinctId) => {
    events.push({ event, properties, distinctId });
  };

  try {
    const response = await appModule.app.request("https://agentcontract.test/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "The login code exposed a private deal name",
        category: "login",
        severity: "high",
        source: "agentcontract-cli"
      })
    });

    assert.equal(response.status, 201);
    const feedbackEvent = events.find((item) => item.event === "product feedback submitted");
    assert.ok(feedbackEvent);
    assert.equal(feedbackEvent.properties.category, "login");
    assert.equal(feedbackEvent.properties.severity, "high");
    assert.equal(feedbackEvent.properties.source, "agentcontract-cli");
    assert.equal("message" in feedbackEvent.properties, false);
  } finally {
    posthogModule.posthog.captureEvent = original;
  }
});
