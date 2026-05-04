import { Hono } from "hono";
import { createEmailLoginCode, consumeCliLoginCode } from "../lib/cliLogin.js";
import { sendCliLoginCodeEmail } from "../lib/email.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { completeWorkosCallback, loginUrl, logout, readEmailAdminSession, setEmailAdminSession, workosConfigured } from "../lib/workos.js";

export const auth = new Hono();

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeReturnTo(value: string | undefined | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard";
  if (value.startsWith("/login") || value.startsWith("/auth/callback")) return "/dashboard";
  return value;
}

function validEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function clientIp(headers: Headers) {
  return (headers.get("x-forwarded-for") ?? headers.get("x-real-ip") ?? "unknown").split(",")[0].trim() || "unknown";
}

function rateLimitPage(returnTo: string, email: string | undefined, workosUrl: string | null) {
  return loginPage({
    returnTo,
    email,
    error: "Too many sign-in codes requested. Please wait and try again.",
    workosUrl
  });
}

function loginPage(input: {
  returnTo: string;
  email?: string;
  error?: string;
  sent?: boolean;
  workosUrl?: string | null;
}) {
  const workosButton = input.workosUrl
    ? `<a class="block rounded border border-slate-300 px-4 py-2.5 text-center text-sm font-semibold hover:bg-slate-50" href="${escapeHtml(input.workosUrl)}">Continue with WorkOS / Google</a>`
    : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentContract Login</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }</style>
</head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto flex min-h-screen max-w-md items-center px-5 py-10">
    <section class="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold text-slate-500">AgentContract</p>
      <h1 class="mt-2 text-2xl font-semibold">Sign in</h1>
      <p class="mt-2 text-sm leading-6 text-slate-600">Use an email code for the CLI and sender dashboard. WorkOS stays available for Google/SSO once the provider is enabled.</p>

      ${input.error ? `<p class="mt-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">${escapeHtml(input.error)}</p>` : ""}
      ${input.sent ? `<p class="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Code sent to ${escapeHtml(input.email)}.</p>` : ""}

      <form method="post" action="/login/email/start" class="mt-5 space-y-3">
        <input type="hidden" name="returnTo" value="${escapeHtml(input.returnTo)}" />
        <label class="block text-sm font-semibold">Email
          <input class="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm" type="email" name="email" value="${escapeHtml(input.email ?? "")}" placeholder="you@example.com" autocomplete="email" required />
        </label>
        <button class="w-full rounded bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white" type="submit">Send sign-in code</button>
      </form>

      ${input.sent ? `
        <form method="post" action="/login/email/verify" class="mt-4 space-y-3">
          <input type="hidden" name="returnTo" value="${escapeHtml(input.returnTo)}" />
          <input type="hidden" name="email" value="${escapeHtml(input.email ?? "")}" />
          <label class="block text-sm font-semibold">Code
            <input class="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm tracking-widest" inputmode="numeric" pattern="[0-9]{6}" name="code" placeholder="123456" autocomplete="one-time-code" required />
          </label>
          <button class="w-full rounded bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white" type="submit">Verify and continue</button>
        </form>
      ` : ""}

      ${workosButton ? `<div class="my-5 flex items-center gap-3 text-xs uppercase tracking-widest text-slate-400"><span class="h-px flex-1 bg-slate-200"></span><span>or</span><span class="h-px flex-1 bg-slate-200"></span></div>${workosButton}` : ""}
    </section>
  </main>
</body>
</html>`;
}

auth.get("/login", (c) => {
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  const emailSession = readEmailAdminSession(c);
  if (emailSession) return c.redirect(returnTo);

  if (c.req.query("workos") === "1") {
    if (!workosConfigured()) return c.text("WorkOS is not configured", 503);
    const url = loginUrl(c, returnTo);
    return url ? c.redirect(url) : c.text("WorkOS is not configured", 503);
  }

  const workosUrl = workosConfigured() ? `/login?workos=1&returnTo=${encodeURIComponent(returnTo)}` : null;
  return c.html(loginPage({ returnTo, email: c.req.query("email"), workosUrl }));
});

auth.post("/login/email/start", async (c) => {
  const body = await c.req.parseBody();
  const returnTo = safeReturnTo(typeof body.returnTo === "string" ? body.returnTo : undefined);
  const email = validEmail(body.email);
  const workosUrl = workosConfigured() ? `/login?workos=1&returnTo=${encodeURIComponent(returnTo)}` : null;
  if (!email) return c.html(loginPage({ returnTo, error: "Enter a valid email address.", workosUrl }), 400);

  const emailLimit = await checkRateLimit({ scope: "login_code_email_hour", subject: email, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!emailLimit.allowed) return c.html(rateLimitPage(returnTo, email, workosUrl), 429);

  const ipLimit = await checkRateLimit({ scope: "login_code_ip_hour", subject: clientIp(c.req.raw.headers), limit: 20, windowMs: 60 * 60 * 1000 });
  if (!ipLimit.allowed) return c.html(rateLimitPage(returnTo, email, workosUrl), 429);

  try {
    const code = await createEmailLoginCode({
      keyName: "AgentContract Admin",
      ownerEmail: email
    });
    await sendCliLoginCodeEmail({ to: email, code, expiresInMinutes: 5 });
    return c.html(loginPage({ returnTo, email, sent: true, workosUrl }));
  } catch (error) {
    console.error("[AgentContract admin email login start failed]", error);
    return c.html(loginPage({ returnTo, email, error: "Could not send a sign-in code. Try CLI login or retry in a minute.", workosUrl }), 400);
  }
});

auth.post("/login/email/verify", async (c) => {
  const body = await c.req.parseBody();
  const returnTo = safeReturnTo(typeof body.returnTo === "string" ? body.returnTo : undefined);
  const email = validEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const workosUrl = workosConfigured() ? `/login?workos=1&returnTo=${encodeURIComponent(returnTo)}` : null;
  if (!email || !/^[0-9]{6}$/.test(code)) {
    return c.html(loginPage({ returnTo, email: email ?? undefined, sent: Boolean(email), error: "Enter the six-digit code from your email.", workosUrl }), 400);
  }

  const login = await consumeCliLoginCode(code);
  if (!login || login.ownerEmail !== email) {
    return c.html(loginPage({ returnTo, email, sent: true, error: "That code is invalid or expired.", workosUrl }), 400);
  }

  setEmailAdminSession(c, email);
  return c.redirect(returnTo);
});

auth.get("/auth/callback", async (c) => {
  try {
    return await completeWorkosCallback(c);
  } catch (error) {
    console.error("[AgentContract WorkOS callback failed]", error);
    return c.redirect("/login");
  }
});

auth.get("/logout", async (c) => logout(c));
