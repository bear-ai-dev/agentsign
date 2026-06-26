import { Hono, type Context } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { marked } from "marked";
import { requireApiKey } from "../lib/auth.js";
import { all, getAuditEvents, parseJson, run } from "../lib/db.js";
import { auditEventsForApi } from "../lib/audit.js";
import { renderPDF } from "../lib/pdf.js";
import { applyTemplateVars, contractorTemplateDefinition, defaultTemplateVars, loadTemplate, privacyTemplateDefinition, templateDefinitions } from "../lib/templates.js";
import { requireAdminSession } from "../lib/workos.js";
import { createAgreement } from "./agreements.js";
import type { Agreement, FieldDefinition, SignedFields } from "../lib/types.js";

export const templates = new Hono();

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

type WorkosUser = {
  id?: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
};

function adminUser(c: Context): WorkosUser {
  return ((c as unknown as { get(key: string): unknown }).get("adminUser") ?? {}) as WorkosUser;
}

function userName(user: WorkosUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email || "AgentContract user";
}

async function getDashboardAgreement(c: Context, id: string) {
  const ownerEmail = adminUser(c).email;
  if (!ownerEmail) return undefined;
  return all<Agreement>("SELECT * FROM agreements WHERE id = ? AND owner_email = ? LIMIT 1", id, ownerEmail)
    .then((rows) => rows[0]);
}

templates.use("/v1/templates", requireApiKey);
templates.use("/v1/templates/*", requireApiKey);
templates.use("/dashboard", requireAdminSession);
templates.use("/dashboard/*", requireAdminSession);
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

templates.get("/v1/templates/nda", (c) => {
  const template = templateDefinitions.nda;
  return c.json({
    template,
    markdown: loadTemplate("nda"),
    default_template_vars: defaultTemplateVars(template)
  });
});

templates.get("/v1/templates/:id", (c) => {
  const id = c.req.param("id") as keyof typeof templateDefinitions;
  const template = templateDefinitions[id];
  if (!template) return c.json({ error: "Template not found" }, 404);
  return c.json({
    template,
    markdown: loadTemplate(id),
    default_template_vars: defaultTemplateVars(template)
  });
});

templates.post("/templates/agreements", async (c) => {
  try {
    const user = adminUser(c);
    const result = await createAgreement(await c.req.json(), new URL(c.req.url).origin, {
      ownerEmail: user.email ?? null
    });
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
});

templates.get("/templates", (c) => c.redirect("/dashboard"));
templates.get("/dashboard", renderDashboard);
templates.get("/dashboard/agreements/:id/document", renderDashboardDocument);
templates.get("/dashboard/agreements/:id/pdf", renderDashboardPdf);
templates.get("/dashboard/agreements/:id/audit", renderDashboardAudit);
templates.get("/templates/nda", (c) => renderSimpleTemplatePage(c, "nda"));

function statusClass(status: string) {
  if (status === "completed") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "cancelled" || status === "declined" || status === "expired") return "bg-rose-50 text-rose-700 ring-rose-200";
  if (status === "viewed") return "bg-sky-50 text-sky-700 ring-sky-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function metadataValue(agreement: Agreement, key: string) {
  const metadata = parseJson<Record<string, unknown>>(agreement.metadata_json, {});
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function agreementRow(agreement: Agreement) {
  const fields = parseJson<FieldDefinition[]>(agreement.fields_json, []);
  const signedFields = parseJson<SignedFields | null>(agreement.signed_fields_json, null);
  const sender = metadataValue(agreement, "sender_email") || "—";
  const workflow = metadataValue(agreement, "workflow") || metadataValue(agreement, "template_kind") || "custom";
  const signedCount = signedFields ? Object.keys(signedFields).length : 0;
  return `
    <tr class="border-b border-slate-100 last:border-0">
      <td class="py-3 pr-4 align-top">
        <div class="font-mono text-xs text-slate-500">${escapeHtml(agreement.id)}</div>
        <div class="mt-1 font-semibold">${escapeHtml(agreement.document_title)}</div>
        <div class="mt-1 text-xs text-slate-500">${escapeHtml(workflow)}</div>
      </td>
      <td class="py-3 pr-4 align-top">
        <div class="font-medium">${escapeHtml(agreement.recipient_name)}</div>
        <div class="text-sm text-slate-500">${escapeHtml(agreement.recipient_email)}</div>
      </td>
      <td class="py-3 pr-4 align-top text-sm text-slate-600">${escapeHtml(sender)}</td>
      <td class="py-3 pr-4 align-top">
        <span class="inline-flex rounded px-2 py-1 text-xs font-semibold ring-1 ${statusClass(agreement.status)}">${escapeHtml(agreement.status)}</span>
      </td>
      <td class="py-3 pr-4 align-top text-sm text-slate-600">
        <div>${formatDate(agreement.created_at)}</div>
        <div class="text-xs text-slate-400">${signedCount}/${fields.length} fields</div>
      </td>
      <td class="py-3 align-top">
        <div class="flex flex-wrap gap-2">
          <a class="rounded border border-slate-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-50" href="/preview/${escapeHtml(agreement.signing_token)}">Preview</a>
          <a class="rounded border border-slate-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-50" href="/dashboard/agreements/${escapeHtml(agreement.id)}/document">Text</a>
          <a class="rounded border border-slate-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-50" href="/dashboard/agreements/${escapeHtml(agreement.id)}/pdf">PDF</a>
          <a class="rounded border border-slate-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-50" href="/dashboard/agreements/${escapeHtml(agreement.id)}/audit">Audit</a>
        </div>
      </td>
    </tr>
  `;
}

function templateCard(templateId: keyof typeof templateDefinitions, href: string, command: string) {
  const definition = templateDefinitions[templateId];
  return `
    <article class="rounded-lg border border-slate-200 bg-white p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="font-semibold">${escapeHtml(definition.name)}</h3>
          <p class="mt-1 text-sm leading-6 text-slate-600">${escapeHtml(definition.description)}</p>
        </div>
        <a class="shrink-0 rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="${href}">Open</a>
      </div>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100"><code>${escapeHtml(command)}</code></pre>
    </article>
  `;
}

async function renderDashboard(c: Context) {
  const ownerEmail = adminUser(c).email;
  if (!ownerEmail) return c.text("Signed-in user has no email address", 400);
  const rows = await all<Agreement>("SELECT * FROM agreements WHERE owner_email = ? ORDER BY created_at DESC LIMIT 100", ownerEmail);
  const counts = rows.reduce<Record<string, number>>((acc, agreement) => {
    acc[agreement.status] = (acc[agreement.status] ?? 0) + 1;
    return acc;
  }, {});
  const completed = counts.completed ?? 0;
  const active = (counts.sent ?? 0) + (counts.viewed ?? 0);
  const cancelled = (counts.cancelled ?? 0) + (counts.declined ?? 0) + (counts.expired ?? 0);
  const bodyRows = rows.length
    ? rows.map(agreementRow).join("")
    : `<tr><td colspan="6" class="py-10 text-center text-sm text-slate-500">No contracts sent yet. Start with the CLI commands below.</td></tr>`;

  return c.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sender Dashboard | AgentContract</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    pre { white-space: pre-wrap; }
  </style>
</head>
<body class="bg-slate-50 text-slate-950">
  <header class="border-b border-slate-200 bg-white">
    <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4">
      <div>
        <p class="text-sm font-semibold text-slate-500">AgentContract</p>
        <h1 class="text-2xl font-semibold">Sender Dashboard</h1>
      </div>
      <nav class="flex flex-wrap items-center gap-2">
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="/templates/bear-privacy">Privacy</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="/templates/nda">NDA</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="/templates/specific-contractor">Contractor</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="/dashboard/api-keys">API Keys</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50" href="/logout">Sign out</a>
      </nav>
    </div>
  </header>

  <main class="mx-auto max-w-7xl px-5 py-6">
    <section class="grid gap-3 sm:grid-cols-4">
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <p class="text-sm font-medium text-slate-500">Total</p>
        <p class="mt-1 text-3xl font-semibold">${rows.length}</p>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <p class="text-sm font-medium text-slate-500">Active</p>
        <p class="mt-1 text-3xl font-semibold">${active}</p>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <p class="text-sm font-medium text-slate-500">Completed</p>
        <p class="mt-1 text-3xl font-semibold">${completed}</p>
      </div>
      <div class="rounded-lg border border-slate-200 bg-white p-4">
        <p class="text-sm font-medium text-slate-500">Closed</p>
        <p class="mt-1 text-3xl font-semibold">${cancelled}</p>
      </div>
    </section>

    <section class="mt-6 rounded-lg border border-slate-200 bg-white">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 class="font-semibold">Contracts</h2>
          <p class="text-sm text-slate-500">Latest 100 agreements for ${escapeHtml(ownerEmail)} across CLI, API, and sender UI.</p>
        </div>
        <code class="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">agentcontract agreements --limit 100</code>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[880px] text-left">
          <thead class="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="px-4 py-3 font-semibold">Document</th>
              <th class="py-3 pr-4 font-semibold">Recipient</th>
              <th class="py-3 pr-4 font-semibold">Sender</th>
              <th class="py-3 pr-4 font-semibold">Status</th>
              <th class="py-3 pr-4 font-semibold">Created</th>
              <th class="py-3 pr-4 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody class="text-sm">
            ${bodyRows}
          </tbody>
        </table>
      </div>
    </section>

    <section class="mt-6 grid gap-4 lg:grid-cols-3">
      ${templateCard("nda", "/templates/nda", "agentcontract read nda --var company_name=\\\"Specific Marketplace\\\"\\nagentcontract contract send nda --to jane@example.com --name \\\"Jane Doe\\\" --var company_name=\\\"Specific Marketplace\\\" --json")}
      ${templateCard("privacy", "/templates/bear-privacy", "agentcontract read privacy --var effective_date=\\\"April 29, 2026\\\"\\nagentcontract marketplace-onboard --to jane@example.com --name \\\"Jane Doe\\\" --json")}
      ${templateCard("contractor", "/templates/specific-contractor", "agentcontract read contractor --var effective_date=\\\"April 29, 2026\\\"\\nagentcontract contract send contractor --to jane@example.com --name \\\"Jane Doe\\\" --json")}
    </section>

    <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Draft Contracts With Agents</h2>
      <p class="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Claude Code or any local agent can draft markdown, inspect it as text, save it as a reusable local contract, and send it through the API without opening this dashboard.</p>
      <pre class="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100"><code>agentcontract contract add custom-sow --markdown-file ./draft.md --fields-json '[{"id":"full_name","label":"Full legal name","type":"text","required":true},{"id":"signature","label":"Signature","type":"signature","required":true}]'
agentcontract contract read custom-sow --to jane@example.com --name "Jane Doe"
agentcontract contract send custom-sow --to jane@example.com --name "Jane Doe" --json</code></pre>
    </section>
  </main>
</body>
</html>`);
}

async function renderDashboardDocument(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.text("Agreement id is required", 400);
  const agreement = await getDashboardAgreement(c, id);
  if (!agreement) return c.text("Agreement not found", 404);
  return new Response(agreement.document_markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `inline; filename="${agreement.id}.md"`
    }
  });
}

async function renderDashboardPdf(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Agreement id is required" }, 400);
  const agreement = await getDashboardAgreement(c, id);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);

  let path = agreement.signed_pdf_path;
  if (!path || !existsSync(path)) {
    path = await renderPDF({
      agreementId: agreement.id,
      markdown: agreement.document_markdown,
      fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
      signedFields: parseJson<SignedFields | undefined>(agreement.signed_fields_json, undefined),
      auditEvents: await getAuditEvents(agreement.id)
    });
    if (agreement.status === "completed") {
      await run("UPDATE agreements SET signed_pdf_path = ? WHERE id = ?", path, agreement.id);
    }
  }

  return new Response(readFileSync(path), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${agreement.id}.pdf"`
    }
  });
}

async function renderDashboardAudit(c: Context) {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Agreement id is required" }, 400);
  const agreement = await getDashboardAgreement(c, id);
  if (!agreement) return c.json({ error: "Agreement not found" }, 404);
  return c.json({ agreement_id: agreement.id, audit_events: auditEventsForApi(await getAuditEvents(agreement.id)) });
}

function renderSimpleTemplatePage(c: Context, templateId: keyof typeof templateDefinitions) {
  const definition = templateDefinitions[templateId];
  const user = adminUser(c);
  const senderEmail = user.email || "";
  const senderName = userName(user);
  const defaults = defaultTemplateVars(definition);
  const previewVars = {
    ...defaults,
    recipient_name: "Jane Recipient",
    recipient_email: "jane@example.com"
  };
  const previewHtml = marked.parse(applyTemplateVars(loadTemplate(templateId), previewVars), { async: false }) as string;
  const variables = definition.variables.map((variable) => `
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
  <title>${escapeHtml(definition.name)} | AgentContract</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    label { display: block; font-weight: 650; font-size: .875rem; color: rgb(15 23 42); }
    input { display: block; width: 100%; margin-top: .35rem; border: 1px solid rgb(203 213 225); border-radius: .4rem; padding: .56rem .7rem; font-weight: 420; background: white; }
    textarea { width: 100%; min-height: 12rem; border: 1px solid rgb(203 213 225); border-radius: .4rem; padding: .7rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
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
        <p class="text-sm font-semibold text-slate-500">AgentContract Template</p>
        <h1 class="text-2xl font-semibold">${escapeHtml(definition.name)}</h1>
      </div>
      <div class="flex items-center gap-2">
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/dashboard">Dashboard</a>
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/logout">Sign out</a>
      </div>
    </div>
  </header>
  <main class="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[27rem_1fr]">
    <form id="template-form" class="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <p class="text-sm leading-6 text-slate-600">${escapeHtml(definition.description)}</p>
      <label><span>Sender name</span><input name="sender_name" value="${escapeHtml(senderName)}" required /></label>
      <label><span>Sender email</span><input name="sender_email" type="email" value="${escapeHtml(senderEmail)}" required /></label>
      <label><span>Receiver name</span><input name="recipient_name" placeholder="Jane Recipient" required /></label>
      <label><span>Receiver email</span><input name="recipient_email" type="email" placeholder="jane@example.com" required /></label>
      <div class="grid gap-3">${variables}</div>
      <label><span>CC on request</span><input name="cc" type="email" placeholder="janak@usebear.ai" /></label>
      <button class="w-full rounded bg-slate-950 px-4 py-3 font-semibold text-white" type="submit">Send</button>
      <p id="status" class="hidden rounded border px-3 py-2 text-sm"></p>
      <textarea id="payload" readonly></textarea>
    </form>
    <section class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <article id="preview" class="preview max-w-3xl">${previewHtml}</article>
    </section>
  </main>
  <script>
    const markdown = ${JSON.stringify(loadTemplate(templateId))};
    const fields = ${JSON.stringify(definition.fields)};
    const variableKeys = ${JSON.stringify(definition.variables.map((variable) => variable.key))};
    const form = document.getElementById("template-form");
    const payloadBox = document.getElementById("payload");
    const preview = document.getElementById("preview");
    const statusBox = document.getElementById("status");
    function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
    function renderMarkdownLite(source) {
      return source.split("\\n").map((line) => {
        if (line.startsWith("# ")) return "<h1>" + escapeHtml(line.slice(2)) + "</h1>";
        if (line.startsWith("## ")) return "<h2>" + escapeHtml(line.slice(3)) + "</h2>";
        if (!line.trim()) return "";
        if (line === "---") return "<hr>";
        return "<p>" + escapeHtml(line).replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>") + "</p>";
      }).join("\\n");
    }
    function formValues() { return Object.fromEntries(new FormData(form).entries()); }
    function buildPayload() {
      const values = formValues();
      const templateVars = {};
      variableKeys.forEach((key) => { templateVars[key] = values[key] || ""; });
      return {
        recipient: { name: values.recipient_name || "", email: values.recipient_email || "" },
        cc: values.cc ? [values.cc] : undefined,
        sender_email: values.sender_email || undefined,
        sender_name: values.sender_name || undefined,
        notification_email: values.sender_email ? [values.sender_email] : undefined,
        template: ${JSON.stringify(templateId)},
        template_vars: templateVars,
        fields,
        metadata: { source: "template-ui", workflow: ${JSON.stringify(templateId)} }
      };
    }
    function sync() {
      const payload = buildPayload();
      payloadBox.value = JSON.stringify(payload, null, 2);
      const vars = { ...payload.template_vars, recipient_name: payload.recipient.name || "Jane Recipient", recipient_email: payload.recipient.email || "jane@example.com" };
      preview.innerHTML = renderMarkdownLite(markdown.replace(/\\{\\{\\s*([a-zA-Z0-9_]+)\\s*\\}\\}/g, (_, key) => vars[key] ?? ""));
    }
    form.addEventListener("input", sync);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      statusBox.className = "rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700";
      statusBox.textContent = "Sending...";
      const response = await fetch("/templates/agreements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload()) });
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
}

templates.get("/templates/bear-privacy", renderPrivacyTemplatePage);
templates.get("/templates/privacy", renderPrivacyTemplatePage);

function renderPrivacyTemplatePage(c: Context) {
  const user = adminUser(c);
  const senderEmail = user.email || "";
  const senderName = userName(user);
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
  <title>Specific Privacy Policy | AgentContract</title>
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
        <a class="rounded border border-slate-300 px-3 py-2 text-sm font-semibold" href="/templates/specific-contractor">Contractor</a>
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

        <label><span>Sender name</span><input name="sender_name" value="${escapeHtml(senderName)}" required /></label>
        <label><span>Sender email</span><input name="sender_email" type="email" value="${escapeHtml(senderEmail)}" required /></label>
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

templates.get("/templates/specific-contractor", renderContractorTemplatePage);
templates.get("/templates/bear-contractor", renderContractorTemplatePage);

function renderContractorTemplatePage(c: Context) {
  const user = adminUser(c);
  const senderEmail = user.email || "";
  const senderName = userName(user);
  const defaults = defaultTemplateVars(contractorTemplateDefinition);
  const previewVars = {
    ...defaults,
    recipient_name: "Jane Contractor",
    recipient_email: "jane@example.com"
  };
  const previewHtml = marked.parse(applyTemplateVars(loadTemplate("contractor"), previewVars), { async: false }) as string;
  const variableKeys = contractorTemplateDefinition.variables.map((variable) => variable.key);
  const variables = contractorTemplateDefinition.variables.map((variable) => `
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
  <title>Specific Contributor Terms | AgentContract</title>
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
        <p class="text-sm font-semibold text-slate-500">Specific Marketplace Onboarding</p>
        <h1 class="text-2xl font-semibold">Contributor Terms</h1>
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
          <h2 class="text-lg font-semibold">Send Specific Contributor Terms</h2>
          <p class="mt-1 text-sm text-slate-600">Creates the Specific Marketplace contributor/contractor terms from the PDF with typed signature, acknowledgement date, audit trail, and signed notification.</p>
        </div>

        <label><span>Sender name</span><input name="sender_name" value="${escapeHtml(senderName)}" required /></label>
        <label><span>Sender email</span><input name="sender_email" type="email" value="${escapeHtml(senderEmail)}" required /></label>
        <label><span>Receiver name</span><input name="recipient_name" placeholder="Jane Contractor" required /></label>
        <label><span>Receiver email</span><input name="recipient_email" type="email" placeholder="jane@example.com" required /></label>
        <div class="grid gap-3">
          ${variables}
        </div>
        <label><span>CC on request</span><input name="cc" type="email" placeholder="janak@usebear.ai" /></label>

        <button class="w-full rounded bg-slate-950 px-4 py-3 font-semibold text-white disabled:bg-slate-400" type="submit">Send Contributor Terms</button>
        <p id="status" class="hidden rounded border px-3 py-2 text-sm"></p>
      </form>

      <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 class="text-lg font-semibold">API Payload</h2>
        <p class="mt-1 text-sm text-slate-600">This is the Specific contributor-terms payload an agent can send.</p>
        <textarea id="payload" readonly></textarea>
      </section>
    </section>

    <section class="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div class="mb-4 flex items-center justify-between gap-4 border-b border-slate-200 pb-3">
        <div>
          <h2 class="text-lg font-semibold">Filled Contract Preview</h2>
          <p class="text-sm text-slate-600">This preview uses the specific recipient and terms variables above.</p>
        </div>
        <span class="rounded bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">Specific ready</span>
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
      const templateVars = {};
      variableKeys.forEach((key) => {
        templateVars[key] = values[key] || templateVars[key] || "";
      });
      return {
        recipient: { name: values.recipient_name || "", email: values.recipient_email || "" },
        cc: values.cc ? [values.cc] : undefined,
        sender_email: values.sender_email || undefined,
        sender_name: values.sender_name || undefined,
        notification_email: values.sender_email ? [values.sender_email] : undefined,
        template: "contractor",
        template_vars: templateVars,
        fields,
        metadata: { source: "specific-contributor-terms-template-ui", workflow: "specific_contributor_terms", company: "Specific Marketplace" }
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
}
