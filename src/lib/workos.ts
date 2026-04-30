import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WorkOS } from "@workos-inc/node";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "./env.js";

const sessionCookie = "agentsign_admin_session";
const stateTtlMs = 10 * 60 * 1000;

type AuthState = {
  returnTo: string;
  nonce: string;
  exp: number;
};

export function workosConfigured() {
  return Boolean(env.workosApiKey && env.workosClientId && env.workosCookiePassword);
}

function workos() {
  if (!workosConfigured()) return null;
  return new WorkOS(env.workosApiKey, { clientId: env.workosClientId });
}

function cookieOptions(c: Context) {
  return {
    path: "/",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax" as const
  };
}

function redirectUri(c: Context) {
  return env.workosRedirectUri || `${new URL(c.req.url).origin}/auth/callback`;
}

function safeReturnTo(value: string | undefined | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/templates/bear-contractor";
  if (value.startsWith("/login") || value.startsWith("/auth/callback")) return "/templates/bear-contractor";
  return value;
}

function signState(state: AuthState) {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", env.workosCookiePassword).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(state: string | undefined | null): AuthState | null {
  if (!state) return null;
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", env.workosCookiePassword).update(payload).digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthState;
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loginUrl(c: Context, returnTo?: string) {
  const client = workos();
  if (!client) return null;
  const state = signState({
    returnTo: safeReturnTo(returnTo),
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + stateTtlMs
  });
  return client.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId: env.workosClientId,
    redirectUri: redirectUri(c),
    state
  });
}

export async function completeWorkosCallback(c: Context) {
  const client = workos();
  if (!client) return c.text("WorkOS is not configured", 503);

  const code = c.req.query("code");
  const state = verifyState(c.req.query("state"));
  if (!code || !state) return c.text("Invalid sign-in callback", 400);

  const result = await client.userManagement.authenticateWithCode({
    clientId: env.workosClientId,
    code,
    ipAddress: clientIp(c) ?? undefined,
    userAgent: c.req.header("user-agent"),
    session: {
      sealSession: true,
      cookiePassword: env.workosCookiePassword
    }
  });

  if (!result.sealedSession) return c.text("WorkOS did not return a session", 401);
  setCookie(c, sessionCookie, result.sealedSession, {
    ...cookieOptions(c),
    maxAge: 60 * 60 * 24 * 30
  });
  return c.redirect(state.returnTo);
}

export async function logout(c: Context) {
  const client = workos();
  const sessionData = getCookie(c, sessionCookie);
  deleteCookie(c, sessionCookie, { path: "/" });

  if (!client || !sessionData) return c.redirect("/");

  try {
    const session = client.userManagement.loadSealedSession({
      sessionData,
      cookiePassword: env.workosCookiePassword
    });
    return c.redirect(await session.getLogoutUrl());
  } catch {
    return c.redirect("/");
  }
}

export const requireAdminSession: MiddlewareHandler = async (c, next) => {
  const client = workos();
  if (!client) {
    return c.html(authSetupHtml(), 503);
  }

  const sessionData = getCookie(c, sessionCookie);
  if (!sessionData) {
    const url = loginUrl(c, new URL(c.req.url).pathname);
    return url ? c.redirect(url) : c.text("WorkOS is not configured", 503);
  }

  try {
    const session = client.userManagement.loadSealedSession({
      sessionData,
      cookiePassword: env.workosCookiePassword
    });
    const authResult = await session.authenticate();
    if (authResult.authenticated) {
      c.set("adminUser", authResult.user);
      await next();
      return;
    }

    const refreshed = await session.refresh();
    if (refreshed.authenticated && refreshed.sealedSession) {
      setCookie(c, sessionCookie, refreshed.sealedSession, {
        ...cookieOptions(c),
        maxAge: 60 * 60 * 24 * 30
      });
      return c.redirect(new URL(c.req.url).pathname);
    }
  } catch {
    deleteCookie(c, sessionCookie, { path: "/" });
  }

  const url = loginUrl(c, new URL(c.req.url).pathname);
  return url ? c.redirect(url) : c.text("WorkOS is not configured", 503);
};

function clientIp(c: Context) {
  return (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "").split(",")[0].trim() || null;
}

function authSetupHtml() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentSign Auth Setup</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-2xl px-6 py-16">
    <div class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-widest text-slate-500">AgentSign Admin</p>
      <h1 class="mt-2 text-2xl font-semibold">WorkOS auth is not configured</h1>
      <p class="mt-3 text-slate-700">Set <code>WORKOS_API_KEY</code>, <code>WORKOS_CLIENT_ID</code>, and <code>WORKOS_COOKIE_PASSWORD</code> in the deployment environment, then redeploy.</p>
    </div>
  </main>
</body>
</html>`;
}
