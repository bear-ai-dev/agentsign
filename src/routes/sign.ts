import { existsSync, readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { marked } from "marked";
import { addAuditEvent, getAgreementByToken, getAuditEvents, nowIso, parseJson, run } from "../lib/db.js";
import { sendCompletionEmail } from "../lib/email.js";
import { renderPDF } from "../lib/pdf.js";
import type { Agreement, FieldDefinition, SignedFields } from "../lib/types.js";
import { completedPayload, enqueueWebhook } from "./webhooks.js";

export const sign = new Hono();

const SIGN_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{document_title}} | AgentSign</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .shell { width: min(100% - 1.5rem, 1120px); margin: 0 auto; padding: 1.25rem 0 2rem; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .65rem 0 1rem; }
    .brand { font-size: .78rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: rgb(71 85 105); }
    .status-pill { border: 1px solid rgb(203 213 225); border-radius: 999px; padding: .28rem .65rem; font-size: .78rem; font-weight: 700; color: rgb(51 65 85); background: white; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 23.5rem; gap: 1rem; align-items: start; }
    .panel { border: 1px solid rgb(226 232 240); border-radius: .5rem; background: white; box-shadow: 0 1px 2px rgba(15, 23, 42, .04); }
    .contract { padding: 2rem; }
    .contract h1 { font-size: 1.65rem; line-height: 1.18; font-weight: 760; margin-bottom: 1.1rem; letter-spacing: 0; }
    .contract h2 { font-size: 1.05rem; font-weight: 720; margin-top: 1.45rem; margin-bottom: .45rem; letter-spacing: 0; }
    .contract h3 { font-size: .95rem; font-weight: 700; margin-top: 1rem; margin-bottom: .35rem; }
    .contract p { margin-bottom: .72rem; line-height: 1.64; color: rgb(30 41 59); }
    .contract ul, .contract ol { margin: .45rem 0 .8rem 1.15rem; line-height: 1.6; color: rgb(30 41 59); }
    .contract hr { margin: 1.45rem 0; border-top: 1px solid rgb(226 232 240); }
    .sign-panel { position: sticky; top: 1rem; padding: 1.05rem; }
    .sign-heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: 1rem; padding-bottom: .8rem; border-bottom: 1px solid rgb(226 232 240); }
    .sign-heading h2 { font-size: 1.05rem; line-height: 1.25; font-weight: 760; margin: 0; letter-spacing: 0; }
    .required-note { font-size: .78rem; color: rgb(100 116 139); white-space: nowrap; }
    label.field-label { display: block; margin-bottom: .8rem; color: rgb(15 23 42); font-size: .86rem; font-weight: 680; }
    input, select { display: block; width: 100%; height: 2.55rem; margin-top: .35rem; border: 1px solid rgb(203 213 225); border-radius: .42rem; padding: .52rem .65rem; font: inherit; font-size: .92rem; font-weight: 450; background: white; color: rgb(15 23 42); outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
    input:focus, select:focus { border-color: rgb(37 99 235); box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }
    input::placeholder { color: rgb(148 163 184); }
    input[type="date"] { color: rgb(15 23 42); }
    .check { display: grid; grid-template-columns: 1rem 1fr; gap: .65rem; align-items: start; margin: .9rem 0 1rem; color: rgb(30 41 59); font-size: .84rem; font-weight: 520; line-height: 1.45; }
    .check input { width: 1rem; height: 1rem; margin-top: .1rem; padding: 0; border-radius: .25rem; }
    .field-block { margin-bottom: .85rem; }
    .typed-signature-preview { margin-top: .5rem; min-height: 4.9rem; display: flex; align-items: center; border: 1px dashed rgb(148 163 184); border-radius: .46rem; background: linear-gradient(180deg, rgb(248 250 252), white); padding: .75rem .9rem; font-family: "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive; font-size: 2.1rem; line-height: 1.05; color: rgb(15 23 42); overflow-wrap: anywhere; }
    .typed-signature-preview.initials { min-height: 3.9rem; max-width: 13rem; font-size: 1.85rem; }
    .typed-signature-preview.empty { font-family: inherit; font-size: .88rem; font-weight: 560; color: rgb(100 116 139); }
    .field-hint { margin-top: .35rem; font-size: .78rem; line-height: 1.35; font-weight: 450; color: rgb(71 85 105); }
    .submit-row { display: flex; gap: .65rem; align-items: center; margin-top: 1rem; }
    .submit-row button { flex: 1; min-height: 2.8rem; border-radius: .45rem; font-size: .93rem; font-weight: 760; transition: background-color .15s ease, transform .15s ease; }
    .submit-row button:not(:disabled):active { transform: translateY(1px); }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sign-panel { position: static; }
      .contract { padding: 1.15rem; }
    }
  </style>
</head>
<body class="bg-slate-50 text-slate-950">
  <main class="shell">
    <header class="topbar">
      <div>
        <div class="brand">AgentSign</div>
        <h1 class="m-0 text-xl font-semibold tracking-normal">{{document_title}}</h1>
      </div>
      <span class="status-pill">Review and sign</span>
    </header>
    <div class="layout">
      <section class="contract panel">{{document_html}}</section>
      <form id="sign-form" class="sign-panel panel">
        <div class="sign-heading">
          <h2>Complete and Sign</h2>
          <span class="required-note">* required</span>
        </div>
        {{fields_html}}
        <label class="check">
          <input id="consent" type="checkbox" required />
          <span>I agree that my electronic signature is the legal equivalent of my handwritten signature and I am bound by this agreement under the U.S. ESIGN Act and UETA.</span>
        </label>
        <p id="error" class="hidden rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"></p>
        <div class="submit-row">
          <button id="submit" class="bg-slate-950 text-white disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500" type="submit" disabled>Sign and Submit</button>
        </div>
      </form>
    </div>
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

const PREVIEW_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{document_title}} | AgentSign Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .contract h1 { font-size: 1.75rem; line-height: 1.15; font-weight: 760; margin-bottom: 1.15rem; }
    .contract h2 { font-size: 1.08rem; font-weight: 720; margin-top: 1.45rem; margin-bottom: .45rem; }
    .contract p { margin-bottom: .74rem; line-height: 1.65; color: rgb(30 41 59); }
    .contract ul, .contract ol { margin: .45rem 0 .8rem 1.15rem; line-height: 1.6; color: rgb(30 41 59); }
    .contract hr { margin: 1.45rem 0; border-top: 1px solid rgb(226 232 240); }
  </style>
</head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-4xl px-4 py-6 sm:py-8">
    <header class="mb-4 flex items-center justify-between gap-4">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-slate-500">AgentSign preview</p>
        <h1 class="text-xl font-semibold tracking-normal">{{document_title}}</h1>
      </div>
      <a class="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700" href="/sign/{{token}}">Go to signing</a>
    </header>
    <article class="contract rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-9">{{document_html}}</article>
  </main>
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

function notificationEmailsFor(agreement: Agreement) {
  const metadata = parseJson<Record<string, unknown>>(agreement.metadata_json, {});
  const value = metadata.notification_email;
  const emails = Array.isArray(value) ? value : value ? [value] : [];
  return emails.map((email) => String(email).trim()).filter(Boolean);
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
        <label class="field-label" for="${inputId}">${escapeHtml(field.label)}${field.required ? " *" : ""}<input id="${inputId}" type="text" autocomplete="name" data-signature-input placeholder="${placeholder}" /></label>
        <div class="${previewClass}" data-signature-preview data-placeholder="${previewPlaceholder}">${previewPlaceholder}</div>
        <p class="field-hint">Typing your name creates your electronic signature for this agreement.</p>
        <input type="hidden" ${common} />
      </div>
    `;
  }

  if (field.type === "select") {
    const options = (field.options ?? []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("");
    return `<label class="field-label">${escapeHtml(field.label)}${field.required ? " *" : ""}<select ${common}><option value=""></option>${options}</select></label>`;
  }

  if (field.type === "boolean") {
    return `<label class="check"><input type="checkbox" ${common} value="true" /> ${escapeHtml(field.label)}${field.required ? " *" : ""}</label>`;
  }

  const inputType = field.type === "currency" ? "number" : field.type;
  const step = field.type === "currency" ? "0.01" : "";
  return `<label class="field-label">${escapeHtml(field.label)}${field.required ? " *" : ""}<input type="${escapeHtml(inputType)}" ${step ? `step="${step}"` : ""} ${common} /></label>`;
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

sign.get("/preview/:token", async (c) => {
  const token = c.req.param("token");
  const agreement = await getAgreementByToken(token);
  if (!agreement) return c.html("<h1>Preview not found</h1>", 404);

  const documentHtml = marked.parse(agreement.document_markdown, { async: false }) as string;
  return c.html(PREVIEW_HTML
    .replaceAll("{{document_title}}", escapeHtml(agreement.document_title))
    .replace("{{document_html}}", documentHtml)
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
  const notificationEmails = notificationEmailsFor(completed);
  if (notificationEmails.length) {
    try {
      await sendCompletionEmail({
        to: notificationEmails,
        recipientName: completed.recipient_name,
        recipientEmail: completed.recipient_email,
        documentTitle: completed.document_title,
        agreementId: completed.id,
        signedPdfUrl: `${new URL(c.req.url).origin}/sign/${token}/pdf`
      });
      await addAuditEvent({ agreementId: completed.id, eventType: "notification_sent", data: { to: notificationEmails } });
    } catch (error) {
      console.error("[AgentSign completion notification failed]", error);
      await addAuditEvent({
        agreementId: completed.id,
        eventType: "notification_failed",
        data: { to: notificationEmails, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

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
