import { Hono, type Context } from "hono";
import { marked } from "marked";
import { requireApiKey } from "../lib/auth.js";
import { applyTemplateVars, contractorTemplateDefinition, defaultTemplateVars, loadTemplate, privacyTemplateDefinition, templateDefinitions } from "../lib/templates.js";
import { requireAdminSession } from "../lib/workos.js";
import { createAgreement } from "./agreements.js";

export const templates = new Hono();

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

templates.use("/v1/templates/*", requireApiKey);
templates.use("/templates/*", requireAdminSession);

templates.get("/v1/templates", (c) => {
  return c.json({ templates: Object.values(templateDefinitions) });
});

templates.get("/v1/templates/privacy", (c) => {
  return c.json({
    template: privacyTemplateDefinition,
    markdown: loadTemplate("privacy"),
    default_template_vars: defaultTemplateVars(privacyTemplateDefinition)
  });
});

templates.get("/v1/templates/contractor", (c) => {
  return c.json({
    template: contractorTemplateDefinition,
    markdown: loadTemplate("contractor"),
    default_template_vars: defaultTemplateVars(contractorTemplateDefinition)
  });
});

templates.post("/templates/agreements", async (c) => {
  try {
    const result = await createAgreement(await c.req.json(), new URL(c.req.url).origin);
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
});

templates.get("/templates/bear-privacy", renderPrivacyTemplatePage);
templates.get("/templates/privacy", renderPrivacyTemplatePage);

function renderPrivacyTemplatePage(c: Context) {
  const defaults = defaultTemplateVars(privacyTemplateDefinition);
  const previewVars = {
    ...defaults,
    recipient_name: "Jane Contributor",
    recipient_email: "jane@example.com"
  };
  const previewHtml = marked.parse(applyTemplateVars(loadTemplate("privacy"), previewVars), { async: false }) as string;
  const variables = privacyTemplateDefinition.variables.map((variable) => `
    <label>
      <span>${escapeHtml(variable.label)}</span>
      <input name="${escapeHtml(variable.key)}" value="${escapeHtml(variable.defaultValue)}" ${variable.required ? "required" : ""} />
    </label>
  `).join("");

  return c.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Specific Privacy Policy | AgentSign</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    label { display: block; font-weight: 600; font-size: .875rem; color: rgb(15 23 42); }
    input { display: block; width: 100%; margin-top: .35rem; border: 1px solid rgb(203 213 225); border-radius: .375rem; padding: .55rem .7rem; font-weight: 400; background: white; }
    textarea { width: 100%; min-height: 13rem; border: 1px solid rgb(203 213 225); border-radius: .375rem; padding: .7rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
    .preview h1 { font-size: 1.75rem; line-height: 1.15; font-weight: 750; margin-bottom: 1rem; }
    .preview h2 { font-size: 1.15rem; font-weight: 700; margin-top: 1.6rem; margin-bottom: .55rem; }
    .preview h3 { font-size: 1rem; font-weight: 700; margin-top: 1rem; margin-bottom: .35rem; }
    .preview p { margin-bottom: .8rem; line-height: 1.65; }
    .preview ul { margin: .5rem 0 1rem 1.25rem; list-style: disc; }
    .preview li { margin-bottom: .3rem; }
  </style>
</head>
<body class="bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div class="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
      <div>
        <p class="text-sm font-semibold text-slate-500">Specific Contributor Agreements</p>
        <h1 class="text-2xl font-semibold">Specific Marketplace Privacy Policy</h1>
      </div>
      <div class="flex items-center gap-2">
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/templates/bear-contractor">Contractor</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/logout">Sign out</a>
      </div>
    </div>
  </header>

  <main class="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[27rem_1fr]">
    <section class="space-y-5">
      <form id="template-form" class="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 class="text-lg font-semibold">Send Specific Privacy Policy</h2>
          <p class="mt-1 text-sm text-slate-600">Creates the Specific Marketplace privacy-policy acknowledgement from the PDF with recipient name, acknowledgement date, typed signature, audit trail, and signed notification.</p>
        </div>

        <label><span>Sender name</span><input name="sender_name" value="Sid from Specific" required /></label>
        <label><span>Sender email</span><input name="sender_email" type="email" value="sid@usebear.ai" required /></label>
        <label><span>Receiver name</span><input name="recipient_name" placeholder="Jane Contributor" required /></label>
        <label><span>Receiver email</span><input name="recipient_email" type="email" placeholder="jane@example.com" required /></label>
        <label><span>CC on request</span><input name="cc" type="email" placeholder="janak@usebear.ai" /></label>

        <div class="grid gap-3">
          ${variables}
        </div>

        <button class="w-full rounded bg-slate-950 px-4 py-3 font-semibold text-white disabled:bg-slate-400" type="submit">Send Privacy Policy</button>
        <p id="status" class="hidden rounded border px-3 py-2 text-sm"></p>
      </form>

      <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 class="text-lg font-semibold">API Payload</h2>
        <p class="mt-1 text-sm text-slate-600">This is what an agent can send to <code>/v1/agreements</code>.</p>
        <textarea id="payload" readonly></textarea>
      </section>
    </section>

    <section class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between gap-4 border-b border-slate-200 pb-3">
        <div>
          <h2 class="text-lg font-semibold">Live Preview</h2>
          <p class="text-sm text-slate-600">The company, website, contact email, and address are fixed to the PDF text.</p>
        </div>
        <span class="rounded bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">ready</span>
      </div>
      <article id="preview" class="preview max-w-3xl">${previewHtml}</article>
    </section>
  </main>

  <script>
    const markdown = ${JSON.stringify(loadTemplate("privacy"))};
    const fields = ${JSON.stringify(privacyTemplateDefinition.fields)};
    const form = document.getElementById("template-form");
    const payloadBox = document.getElementById("payload");
    const preview = document.getElementById("preview");
    const statusBox = document.getElementById("status");

    function escapeHtml(value) {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    }

    function renderMarkdownLite(source) {
      return source
        .split("\\n")
        .map((line) => {
          if (line.startsWith("# ")) return "<h1>" + escapeHtml(line.slice(2)) + "</h1>";
          if (line.startsWith("## ")) return "<h2>" + escapeHtml(line.slice(3)) + "</h2>";
          if (line.startsWith("### ")) return "<h3>" + escapeHtml(line.slice(4)) + "</h3>";
          if (line.startsWith("- ")) return "<li>" + escapeHtml(line.slice(2)) + "</li>";
          if (!line.trim()) return "";
          return "<p>" + escapeHtml(line).replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>") + "</p>";
        })
        .join("\\n")
        .replace(/(<li>.*?<\\/li>\\n?)+/gs, (match) => "<ul>" + match + "</ul>");
    }

    function formValues() {
      return Object.fromEntries(new FormData(form).entries());
    }

    function buildPayload() {
      const values = formValues();
      const templateVars = {};
      ${JSON.stringify(privacyTemplateDefinition.variables.map((variable) => variable.key))}.forEach((key) => {
        templateVars[key] = values[key] || "";
      });
      return {
        recipient: { name: values.recipient_name || "", email: values.recipient_email || "" },
        cc: values.cc ? [values.cc] : undefined,
        sender_email: values.sender_email || undefined,
        sender_name: values.sender_name || undefined,
        notification_email: values.sender_email ? [values.sender_email] : undefined,
        template: "privacy",
        template_vars: templateVars,
        fields,
        metadata: { source: "specific-privacy-template-ui", workflow: "specific_privacy_acknowledgement", company: "Specific Marketplace" }
      };
    }

    function sync() {
      const payload = buildPayload();
      payloadBox.value = JSON.stringify(payload, null, 2);
      const vars = { ...payload.template_vars, recipient_name: payload.recipient.name || "Jane Contributor", recipient_email: payload.recipient.email || "jane@example.com" };
      const rendered = markdown.replace(/\\{\\{\\s*([a-zA-Z0-9_]+)\\s*\\}\\}/g, (_, key) => vars[key] ?? "");
      preview.innerHTML = renderMarkdownLite(rendered);
    }

    form.addEventListener("input", sync);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      statusBox.className = "rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700";
      statusBox.textContent = "Sending...";
      const values = formValues();
      const response = await fetch("/templates/agreements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload())
      });
      const result = await response.json();
      if (!response.ok) {
        statusBox.className = "rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700";
        statusBox.textContent = result.error || "Send failed";
        return;
      }
      statusBox.className = "rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700";
      statusBox.innerHTML = "Sent <strong>" + result.id + "</strong><br><a class=\\"underline\\" href=\\"" + result.signing_url + "\\">Open signing link</a>";
    });

    sync();
  </script>
</body>
</html>`);
}

templates.get("/templates/bear-contractor", (c) => {
  const defaults = defaultTemplateVars(contractorTemplateDefinition);
  const previewVars = {
    ...defaults,
    recipient_name: "Jane Contractor",
    recipient_email: "jane@example.com"
  };
  const previewHtml = marked.parse(applyTemplateVars(loadTemplate("contractor"), previewVars), { async: false }) as string;
  const variableKeys = contractorTemplateDefinition.variables.map((variable) => variable.key);

  return c.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bear Contractor Agreement | AgentSign</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    label { display: block; font-weight: 650; font-size: .875rem; color: rgb(15 23 42); }
    input { display: block; width: 100%; margin-top: .35rem; border: 1px solid rgb(203 213 225); border-radius: .4rem; padding: .56rem .7rem; font-weight: 420; background: white; }
    textarea { width: 100%; min-height: 14rem; border: 1px solid rgb(203 213 225); border-radius: .4rem; padding: .7rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
    .preview h1 { font-size: 1.65rem; line-height: 1.15; font-weight: 760; margin-bottom: 1rem; }
    .preview h2 { font-size: 1.08rem; font-weight: 720; margin-top: 1.45rem; margin-bottom: .45rem; }
    .preview p { margin-bottom: .75rem; line-height: 1.65; color: rgb(30 41 59); }
    .preview hr { margin: 1.35rem 0; border-top: 1px solid rgb(226 232 240); }
  </style>
</head>
<body class="bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div class="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
      <div>
        <p class="text-sm font-semibold text-slate-500">Bear AI Onboarding</p>
        <h1 class="text-2xl font-semibold">Contractor Agreement</h1>
      </div>
      <div class="flex items-center gap-2">
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/templates/bear-privacy">Privacy Policy</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/logout">Sign out</a>
      </div>
    </div>
  </header>

  <main class="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[27rem_1fr]">
    <section class="space-y-5">
      <form id="template-form" class="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 class="text-lg font-semibold">Send Bear Contractor Agreement</h2>
          <p class="mt-1 text-sm text-slate-600">Built for Sid sending a specific Bear AI 1099 agreement with scope, rate, start date, audit trail, and signed notification.</p>
        </div>

        <label><span>Sender name</span><input name="sender_name" value="Sid from Bear AI" required /></label>
        <label><span>Sender email</span><input name="sender_email" type="email" value="sid@usebear.ai" required /></label>
        <label><span>Receiver name</span><input name="recipient_name" placeholder="Jane Contractor" required /></label>
        <label><span>Receiver email</span><input name="recipient_email" type="email" placeholder="jane@example.com" required /></label>
        <label><span>Scope of work</span><input name="scope_of_work" value="${escapeHtml(defaults.scope_of_work)}" required /></label>
        <div class="grid grid-cols-2 gap-3">
          <label><span>Hourly rate</span><input name="rate" type="number" min="0" step="1" value="${escapeHtml(defaults.rate)}" required /></label>
          <label><span>Start date</span><input name="start_date" type="date" value="${escapeHtml(defaults.start_date)}" required /></label>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label><span>Effective date</span><input name="effective_date" type="date" value="${escapeHtml(defaults.effective_date)}" required /></label>
          <label><span>Notice days</span><input name="notice_days" type="number" value="${escapeHtml(defaults.notice_days)}" required /></label>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label><span>Rate unit</span><input name="rate_unit" value="${escapeHtml(defaults.rate_unit)}" required /></label>
          <label><span>Invoice frequency</span><input name="invoice_frequency" value="${escapeHtml(defaults.invoice_frequency)}" required /></label>
        </div>
        <label><span>CC on request</span><input name="cc" type="email" placeholder="janak@usebear.ai" /></label>

        <button class="w-full rounded bg-slate-950 px-4 py-3 font-semibold text-white disabled:bg-slate-400" type="submit">Send Contractor Agreement</button>
        <p id="status" class="hidden rounded border px-3 py-2 text-sm"></p>
      </form>

      <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 class="text-lg font-semibold">API Payload</h2>
        <p class="mt-1 text-sm text-slate-600">This is the Bear-specific payload an agent can send.</p>
        <textarea id="payload" readonly></textarea>
      </section>
    </section>

    <section class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between gap-4 border-b border-slate-200 pb-3">
        <div>
          <h2 class="text-lg font-semibold">Filled Contract Preview</h2>
          <p class="text-sm text-slate-600">This preview uses the specific recipient, scope, rate, and dates above.</p>
        </div>
        <span class="rounded bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">Bear ready</span>
      </div>
      <article id="preview" class="preview max-w-3xl">${previewHtml}</article>
    </section>
  </main>

  <script>
    const markdown = ${JSON.stringify(loadTemplate("contractor"))};
    const fields = ${JSON.stringify(contractorTemplateDefinition.fields)};
    const variableKeys = ${JSON.stringify(variableKeys)};
    const form = document.getElementById("template-form");
    const payloadBox = document.getElementById("payload");
    const preview = document.getElementById("preview");
    const statusBox = document.getElementById("status");

    function escapeHtml(value) {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    }

    function renderMarkdownLite(source) {
      return source
        .split("\\n")
        .map((line) => {
          if (line.startsWith("# ")) return "<h1>" + escapeHtml(line.slice(2)) + "</h1>";
          if (line.startsWith("## ")) return "<h2>" + escapeHtml(line.slice(3)) + "</h2>";
          if (!line.trim()) return "";
          if (line === "---") return "<hr>";
          return "<p>" + escapeHtml(line).replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>") + "</p>";
        })
        .join("\\n");
    }

    function formValues() {
      return Object.fromEntries(new FormData(form).entries());
    }

    function buildPayload() {
      const values = formValues();
      const templateVars = { company_name: "Bear AI" };
      variableKeys.forEach((key) => {
        templateVars[key] = values[key] || templateVars[key] || "";
      });
      return {
        recipient: { name: values.recipient_name || "", email: values.recipient_email || "" },
        cc: values.cc ? [values.cc] : undefined,
        sender_email: values.sender_email || "sid@usebear.ai",
        sender_name: values.sender_name || "Sid from Bear AI",
        notification_email: values.sender_email ? [values.sender_email] : ["sid@usebear.ai"],
        template: "contractor",
        template_vars: templateVars,
        fields,
        metadata: { source: "bear-contractor-template-ui", workflow: "bear_contractor_onboarding", company: "Bear AI" }
      };
    }

    function sync() {
      const payload = buildPayload();
      payloadBox.value = JSON.stringify(payload, null, 2);
      const vars = { ...payload.template_vars, recipient_name: payload.recipient.name || "Jane Contractor", recipient_email: payload.recipient.email || "jane@example.com" };
      const rendered = markdown.replace(/\\{\\{\\s*([a-zA-Z0-9_]+)\\s*\\}\\}/g, (_, key) => vars[key] ?? "");
      preview.innerHTML = renderMarkdownLite(rendered);
    }

    form.addEventListener("input", sync);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      statusBox.className = "rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700";
      statusBox.textContent = "Sending...";
      const values = formValues();
      const response = await fetch("/templates/agreements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload())
      });
      const result = await response.json();
      if (!response.ok) {
        statusBox.className = "rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700";
        statusBox.textContent = result.error || "Send failed";
        return;
      }
      statusBox.className = "rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700";
      statusBox.innerHTML = "Sent <strong>" + result.id + "</strong><br><a class=\\"underline\\" href=\\"" + result.preview_url + "\\">Preview</a> · <a class=\\"underline\\" href=\\"" + result.signing_url + "\\">Signing link</a>";
    });

    sync();
  </script>
</body>
</html>`);
});
