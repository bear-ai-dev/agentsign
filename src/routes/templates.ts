import { Hono } from "hono";
import { marked } from "marked";
import { requireApiKey } from "../lib/auth.js";
import { applyTemplateVars, defaultTemplateVars, loadTemplate, privacyTemplateDefinition, templateDefinitions } from "../lib/templates.js";

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

templates.get("/templates/privacy", (c) => {
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
  <title>Privacy Policy Template | AgentSign</title>
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
        <p class="text-sm font-semibold text-slate-500">AgentSign Templates</p>
        <h1 class="text-2xl font-semibold">Bear AI Privacy Policy</h1>
      </div>
      <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/">API Health</a>
    </div>
  </header>

  <main class="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[27rem_1fr]">
    <section class="space-y-5">
      <form id="template-form" class="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <h2 class="text-lg font-semibold">Send Privacy Policy</h2>
          <p class="mt-1 text-sm text-slate-600">Creates a signable privacy-policy acknowledgement with full legal name, acknowledgement date, typed signature, audit trail, and signed notification.</p>
        </div>

        <label><span>API key</span><input name="api_key" type="password" value="ak_local_dev_key_change_me" required /></label>
        <label><span>Recipient name</span><input name="recipient_name" placeholder="Jane Contributor" required /></label>
        <label><span>Recipient email</span><input name="recipient_email" type="email" placeholder="jane@example.com" required /></label>
        <label><span>Notify when signed</span><input name="notification_email" type="email" value="janak@usebear.ai" /></label>
        <label><span>CC on request</span><input name="cc" type="email" placeholder="sid@usebear.ai" /></label>

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
          <p class="text-sm text-slate-600">Variables are shown with safe defaults from the PDF reconstruction.</p>
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
        notification_email: values.notification_email ? [values.notification_email] : undefined,
        template: "privacy",
        template_vars: templateVars,
        fields,
        metadata: { source: "privacy-template-ui" }
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
      const response = await fetch("/v1/agreements", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + values.api_key,
          "Content-Type": "application/json"
        },
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
});
