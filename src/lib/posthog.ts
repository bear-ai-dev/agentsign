import "dotenv/config";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Context, MiddlewareHandler } from "hono";
import { PostHog } from "posthog-node";
import type { ApiKeyRecord } from "./types.js";

type CaptureMessage = {
  distinctId?: string;
  event: string;
  properties?: Record<string, unknown>;
};

type PosthogClient = {
  capture(message: CaptureMessage): void;
  captureException(error: unknown, distinctId?: string, properties?: Record<string, unknown>): void;
  flush?(): Promise<void>;
  shutdown?(): Promise<void> | void;
};

type TelemetryOptions = {
  projectApiKey?: string;
  host?: string;
  enabled?: boolean;
  client?: PosthogClient;
  service?: string;
  environment?: string;
};

const redacted = "[redacted]";
const defaultDistinctId = "agentcontract:server";
const sensitiveKeys = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "password",
  "secret",
  "token",
  "signing_token",
  "webhook_secret",
  "document_markdown",
  "signed_fields",
  "signed_fields_json"
]);

function cleanEnv(value: string | undefined, fallback = "") {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function posthogEnabledByEnv() {
  const value = cleanEnv(process.env.POSTHOG_ENABLED).toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function envOptions(): TelemetryOptions {
  return {
    projectApiKey: cleanEnv(
      process.env.POSTHOG_PROJECT_API_KEY
        ?? process.env.POSTHOG_API_KEY
        ?? process.env.POSTHOG_TOKEN
    ),
    host: cleanEnv(process.env.POSTHOG_HOST, "https://us.i.posthog.com"),
    enabled: posthogEnabledByEnv(),
    environment: cleanEnv(process.env.VERCEL_ENV ?? process.env.NODE_ENV, "development")
  };
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase().replaceAll("-", "_");
  return sensitiveKeys.has(normalized) || normalized.endsWith("_token") || normalized.endsWith("_secret");
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? redacted : sanitizeValue(nested, depth + 1);
    }
    return output;
  }
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  return value;
}

export function sanitizePosthogProperties(properties: Record<string, unknown> = {}) {
  return sanitizeValue(properties) as Record<string, unknown>;
}

function clientIp(c: Context) {
  return (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "").split(",")[0].trim() || null;
}

function anonymousDistinctId(c: Context) {
  const source = [
    clientIp(c) ?? "unknown-ip",
    c.req.header("user-agent") ?? "unknown-agent"
  ].join(":");
  return `anonymous:${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
}

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function isBootstrapKey(c: Context) {
  return Boolean((c as unknown as { get(key: string): unknown }).get("apiKeyBootstrap"));
}

export function ownerDistinctId(ownerEmail: string | null | undefined, fallback = defaultDistinctId) {
  return ownerEmail?.trim().toLowerCase() || fallback;
}

export function signerDistinctId(agreementId: string) {
  return `agreement:${agreementId}`;
}

export function setPosthogDistinctId(c: Context, distinctId: string | null | undefined) {
  if (distinctId) c.set("posthogDistinctId", distinctId);
}

export function posthogDistinctId(c: Context) {
  const explicit = (c as unknown as { get(key: string): unknown }).get("posthogDistinctId");
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  const record = apiKeyRecord(c);
  if (record?.owner_email) return ownerDistinctId(record.owner_email);
  if (record?.id) return `api_key:${record.id}`;
  if (isBootstrapKey(c)) return "agentcontract:bootstrap-key";
  return anonymousDistinctId(c);
}

function requestProperties(c: Context, startedAt: number, status: number) {
  const path = new URL(c.req.url).pathname;
  return {
    method: c.req.method,
    path,
    status,
    duration_ms: Math.round(performance.now() - startedAt),
    user_agent: c.req.header("user-agent") ?? null,
    referrer: c.req.header("referer") ?? c.req.header("referrer") ?? null,
    ip_hash: clientIp(c)
      ? createHash("sha256").update(clientIp(c)!).digest("hex").slice(0, 24)
      : null
  };
}

export function createPosthogTelemetry(options: TelemetryOptions = {}) {
  const projectApiKey = cleanEnv(options.projectApiKey);
  const enabled = Boolean(options.enabled ?? true) && Boolean(projectApiKey);
  const service = options.service ?? "agentcontract";
  const environment = options.environment ?? "development";
  const client = enabled
    ? options.client ?? new PostHog(projectApiKey, {
      host: cleanEnv(options.host, "https://us.i.posthog.com"),
      enableExceptionAutocapture: true
    })
    : null;

  function captureEvent(event: string, properties: Record<string, unknown> = {}, distinctId = defaultDistinctId) {
    if (!enabled || !client) return;
    try {
      client.capture({
        distinctId,
        event,
        properties: sanitizePosthogProperties({
          service,
          environment,
          ...properties
        })
      });
    } catch (error) {
      console.error("[AgentContract PostHog capture failed]", error);
    }
  }

  async function captureException(
    error: unknown,
    contextOrDistinctId?: Context | string,
    properties: Record<string, unknown> = {}
  ) {
    if (!enabled || !client) return;
    const isContext = typeof contextOrDistinctId !== "string" && Boolean(contextOrDistinctId);
    const c = isContext ? contextOrDistinctId as Context : null;
    const distinctId = c ? posthogDistinctId(c) : (contextOrDistinctId as string | undefined) ?? defaultDistinctId;
    const contextProperties = c
      ? {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        user_agent: c.req.header("user-agent") ?? null,
        ip_hash: clientIp(c)
          ? createHash("sha256").update(clientIp(c)!).digest("hex").slice(0, 24)
          : null
      }
      : {};

    try {
      client.captureException(error, distinctId, sanitizePosthogProperties({
        service,
        environment,
        ...contextProperties,
        ...properties
      }));
      await client.flush?.();
    } catch (captureError) {
      console.error("[AgentContract PostHog exception capture failed]", captureError);
    }
  }

  function middleware(): MiddlewareHandler {
    return async (c, next) => {
      const startedAt = performance.now();
      let thrown = false;
      try {
        await next();
      } catch (error) {
        thrown = true;
        throw error;
      } finally {
        const responseStatus = c.res.status || 200;
        const status = thrown && responseStatus < 400 ? 500 : responseStatus;
        captureEvent("http request completed", requestProperties(c, startedAt, status), posthogDistinctId(c));
      }
    };
  }

  async function shutdown() {
    if (!enabled || !client) return;
    await client.shutdown?.();
  }

  return {
    enabled,
    captureEvent,
    captureException,
    middleware,
    shutdown
  };
}

export const posthog = createPosthogTelemetry(envOptions());
