import { existsSync, readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { marked } from "marked";
import { addAuditEvent, getAgreementByToken, getAuditEvents, nowIso, parseJson, run } from "../lib/db.js";
import { renderPDF } from "../lib/pdf.js";
import type { FieldDefinition, SignedFields } from "../lib/types.js";
import { completedPayload, enqueueWebhook } from "./webhooks.js";

export const sign = new Hono();

const SIGN_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{document_title}} | AgentInk</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .contract h1 { font-size: 1.875rem; line-height: 1.15; font-weight: 700; margin-bottom: 1.5rem; }
    .contract h2 { font-size: 1.25rem; font-weight: 650; margin-top: 1.75rem; margin-bottom: .5rem; }
    .contract p { margin-bottom: .85rem; line-height: 1.7; }
    .contract hr { margin: 1.75rem 0; border-top: 1px solid rgb(203 213 225); }
    label { display: block; font-weight: 600; margin-bottom: 1rem; }
    input, select { display: block; width: 100%; margin-top: .4rem; border: 1px solid rgb(203 213 225); border-radius: .375rem; padding: .65rem .75rem; font-weight: 400; background: white; }
    .check { display: flex; gap: .65rem; align-items: flex-start; font-weight: 500; }
    .check input { width: auto; margin-top: .3rem; }
    .field-block { margin-bottom: 1.25rem; }
    .typed-signature-preview { margin-top: .65rem; min-height: 7rem; display: flex; align-items: center; border: 1px solid rgb(203 213 225); border-radius: .375rem; background: white; padding: 1rem 1.25rem; font-family: "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive; font-size: 2.75rem; line-height: 1.1; color: rgb(15 23 42); overflow-wrap: anywhere; }
    .typed-signature-preview.initials { min-height: 5rem; max-width: 18rem; font-size: 2.25rem; }
    .typed-signature-preview.empty { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: .95rem; color: rgb(100 116 139); }
    .field-hint { margin-top: .4rem; font-size: .875rem; font-weight: 400; color: rgb(71 85 105); }
  </style>
</head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-3xl px-4 py-8 sm:py-12">
    <section class="contract rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{{document_html}}</section>
    <form id="sign-form" class="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <h2 class="mb-5 text-xl font-semibold">Complete and Sign</h2>
      {{fields_html}}
      <label class="check mt-6">
        <input id="consent" type="checkbox" required />
        <span>I agree that my electronic signature is the legal equivalent of my handwritten signature and I am bound by this agreement under the U.S. ESIGN Act and UETA.</span>
      </label>
      <p id="error" class="mt-4 hidden rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"></p>
      <button id="submit" class="mt-6 w-full rounded bg-slate-950 px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-400" type="submit" disabled>Sign and Submit</button>
    </form>
  </main>
  <script>
    const form = document.getElementById("sign-form");
    const consent = document.getElementById("consent");
    const submit = document.getElementById("submit");
    const errorBox = document.getElementById("error");

    document.querySelectorAll("[data-typed-signature]").forEach((block) => {
      const typed = block.querySelector("[data-signature-input]");
      const hidden = block.querySelector("input[type=hidden]");
      const preview = block.querySelector("[data-signature-preview]");
      const placeholder = preview.dataset.placeholder || "Signature preview";
      const syncSignature = () => {
        const value = typed.value.trim();
        hidden.value = value;
        preview.textContent = value || placeholder;
        preview.classList.toggle("empty", !value);
        validate();
      };
      typed.addEventListener("input", syncSignature);
      syncSignature();
    });

    function validate() {
      let ok = consent.checked;
      form.querySelectorAll("[data-required=true]").forEach((el) => {
        if (el.type === "checkbox") ok = ok && el.checked;
        else ok = ok && Boolean(el.value);
      });
      submit.disabled = !ok;
    }

    form.addEventListener("input", validate);
    consent.addEventListener("change", validate);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      errorBox.classList.add("hidden");
      const fields = {};
      new FormData(form).forEach((value, key) => { fields[key] = value; });
      form.querySelectorAll("input[type=checkbox][name]").forEach((box) => { fields[box.name] = box.checked; });

      const response = await fetch("/sign/{{token}}/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields, consent_timestamp: new Date().toISOString() })
      });
      const result = await response.json();
      if (!response.ok) {
        errorBox.textContent = result.error || "Signing failed";
        errorBox.classList.remove("hidden");
        validate();
        return;
      }
      window.location.href = result.signed_pdf_url;
    });
    validate();
  </script>
</body>
</html>`;

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clientIp(c: Context) {
  return (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "").split(",")[0].trim() || null;
}

function renderField(field: FieldDefinition) {
  const required = field.required ? "required" : "";
  const dataRequired = field.required ? "data-required=\"true\"" : "";
  const common = `id="field-${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" ${required} ${dataRequired}`;

  if (field.type === "signature" || field.type === "initials") {
    const inputId = `field-${escapeHtml(field.id)}-typed`;
    const placeholder = field.type === "initials" ? "Type your initials" : "Type your full legal name";
    const previewPlaceholder = field.type === "initials" ? "Initials preview" : "Signature preview";
    const previewClass = field.type === "initials" ? "typed-signature-preview initials empty" : "typed-signature-preview empty";
    return `
      <div class="field-block" data-field="${escapeHtml(field.id)}" data-typed-signature>
        <label for="${inputId}">${escapeHtml(field.label)}${field.required ? " *" : ""}<input id="${inputId}" type="text" autocomplete="name" data-signature-input placeholder="${placeholder}" /></label>
        <div class="${previewClass}" data-signature-preview data-placeholder="${previewPlaceholder}">${previewPlaceholder}</div>
        <p class="field-hint">Typing your name creates your electronic signature for this agreement.</p>
        <input type="hidden" ${common} />
      </div>
    `;
  }

  if (field.type === "select") {
    const options = (field.options ?? []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("");
    return `<label>${escapeHtml(field.label)}${field.required ? " *" : ""}<select ${common}><option value=""></option>${options}</select></label>`;
  }

  if (field.type === "boolean") {
    return `<label class="check"><input type="checkbox" ${common} value="true" /> ${escapeHtml(field.label)}${field.required ? " *" : ""}</label>`;
  }

  const inputType = field.type === "currency" ? "number" : field.type;
  const step = field.type === "currency" ? "0.01" : "";
  return `<label>${escapeHtml(field.label)}${field.required ? " *" : ""}<input type="${escapeHtml(inputType)}" ${step ? `step="${step}"` : ""} ${common} /></label>`;
}

sign.get("/sign/:token", async (c) => {
  const token = c.req.param("token");
  const agreement = await getAgreementByToken(token);
  if (!agreement) return c.html("<h1>Signing link not found</h1>", 404);
  if (agreement.status === "cancelled") return c.html("<h1>This agreement has been cancelled.</h1>", 410);

  const viewedCookie = `agentink_viewed_${agreement.id}`;
  if (!getCookie(c, viewedCookie) && !agreement.viewed_at) {
    const viewedAt = nowIso();
    await run("UPDATE agreements SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'", viewedAt, agreement.id);
    await addAuditEvent({ agreementId: agreement.id, eventType: "viewed", ipAddress: clientIp(c), userAgent: c.req.header("user-agent") ?? null });
    setCookie(c, viewedCookie, "1", { httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
  }

  if (agreement.status === "completed") {
    return c.html(successHtml(token));
  }

  const fields = parseJson<FieldDefinition[]>(agreement.fields_json, []);
  const documentHtml = marked.parse(agreement.document_markdown, { async: false }) as string;
  return c.html(SIGN_HTML
    .replaceAll("{{document_title}}", escapeHtml(agreement.document_title))
    .replace("{{document_html}}", documentHtml)
    .replace("{{fields_html}}", fields.map(renderField).join("\n"))
    .replaceAll("{{token}}", escapeHtml(token)));
});

sign.post("/sign/:token/submit", async (c) => {
  const token = c.req.param("token");
  const agreement = await getAgreementByToken(token);
  if (!agreement) return c.json({ error: "Signing link not found" }, 404);
  if (agreement.status === "completed") return c.json({ error: "Agreement is already completed" }, 409);
  if (agreement.status === "cancelled") return c.json({ error: "Agreement is cancelled" }, 410);

  const body = await c.req.json<{ fields?: Record<string, unknown>; consent_timestamp?: string }>();
  const submitted = body.fields ?? {};
  const fields = parseJson<FieldDefinition[]>(agreement.fields_json, []);
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent") ?? null;
  const signedAt = nowIso();
  const signedFields: SignedFields = {};

  if (!body.consent_timestamp) return c.json({ error: "Consent is required" }, 400);

  for (const field of fields) {
    const value = submitted[field.id];

    if (field.type === "signature" || field.type === "initials") {
      const typedValue = typeof value === "string" ? value.trim() : "";
      if (field.required && !typedValue) return c.json({ error: `${field.label} is required` }, 400);
      if (typedValue.startsWith("data:image/")) {
        signedFields[field.id] = { signed: true, signed_at: signedAt, ip, data_url: typedValue, method: "drawn" };
      } else if (typedValue) {
        signedFields[field.id] = { signed: true, signed_at: signedAt, ip, typed_name: typedValue, method: "typed" };
      }
    } else {
      const missing = value === undefined || value === null || value === "" || value === false;
      if (field.required && missing) return c.json({ error: `${field.label} is required` }, 400);
      signedFields[field.id] = value;
    }
  }

  await addAuditEvent({ agreementId: agreement.id, eventType: "signed", ipAddress: ip, userAgent, data: { consent_timestamp: body.consent_timestamp } });
  await addAuditEvent({ agreementId: agreement.id, eventType: "completed", ipAddress: ip, userAgent });

  const pdfPath = await renderPDF({
    agreementId: agreement.id,
    markdown: agreement.document_markdown,
    fields,
    signedFields,
    auditEvents: await getAuditEvents(agreement.id)
  });
  const completedAt = nowIso();
  await run(
    `UPDATE agreements
     SET status = 'completed', signed_fields_json = ?, completed_at = ?, signed_pdf_path = ?
     WHERE id = ?`,
    JSON.stringify(signedFields),
    completedAt,
    pdfPath,
    agreement.id
  );

  const completed = (await getAgreementByToken(token))!;
  if (completed.webhook_url) enqueueWebhook(completed.id, completed.webhook_url, completedPayload(completed));

  return c.json({ ok: true, agreement_id: agreement.id, signed_pdf_url: `/sign/${token}/pdf` });
});

sign.get("/sign/:token/pdf", async (c) => {
  const token = c.req.param("token");
  const agreement = await getAgreementByToken(token);
  if (!agreement) return c.json({ error: "Signing link not found" }, 404);
  if (agreement.status !== "completed") return c.json({ error: "Agreement is not completed" }, 400);

  let path = agreement.signed_pdf_path;
  if (!path || !existsSync(path)) {
    path = await renderPDF({
      agreementId: agreement.id,
      markdown: agreement.document_markdown,
      fields: parseJson<FieldDefinition[]>(agreement.fields_json, []),
      signedFields: parseJson<SignedFields | undefined>(agreement.signed_fields_json, undefined),
      auditEvents: await getAuditEvents(agreement.id)
    });
    await run("UPDATE agreements SET signed_pdf_path = ? WHERE id = ?", path, agreement.id);
  }

  return new Response(readFileSync(path), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${agreement.id}.pdf"`
    }
  });
});

function successHtml(token: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script><title>Signed</title></head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-xl px-6 py-20">
    <h1 class="text-3xl font-semibold">Agreement signed</h1>
    <p class="mt-4 text-slate-700">Thank you. The completed PDF has been generated.</p>
    <a class="mt-8 inline-flex rounded bg-slate-950 px-4 py-2 text-white" href="/sign/${token}/pdf">Download PDF</a>
  </main>
</body></html>`;
}
