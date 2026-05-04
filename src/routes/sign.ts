import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { marked } from "marked";
import { nanoid } from "nanoid";
import { addAuditEvent, all, getAgreementByToken, getAuditEvents, nowIso, parseJson, run, runTransaction } from "../lib/db.js";
import { sendCompletionEmail } from "../lib/email.js";
import { renderCompletedPDFResult } from "../lib/pdf.js";
import { metadataWithSignedPdfRendererVersion, pdfBufferForAgreement, pdfSha256 } from "../lib/pdfStorage.js";
import { agreementHasOriginalPdf, originalPdfBufferForAgreement } from "../lib/originalPdf.js";
import { agreementUrl, signingHostMatches } from "../lib/signingUrls.js";
import { mergeSignedFieldsForRole, signerHasRequiredFields, signerRoleLabel } from "../lib/signing.js";
import type { Agreement, AuditEvent, FieldDefinition, SignedFields, SignerRole } from "../lib/types.js";
import { completedPayload, enqueueWebhook } from "./webhooks.js";

export const sign = new Hono();

const SIGN_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{document_title}} | AgentContract</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @font-face { font-family: "AgentContract Signature"; src: url("https://fonts.gstatic.com/s/greatvibes/v21/RWmMoKWR9v4ksMfaWd_JN-XC.ttf") format("truetype"); font-weight: 400; font-style: normal; font-display: swap; }
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
    .pdf-frame { display: block; width: 100%; min-height: 72vh; border: 1px solid rgb(203 213 225); border-radius: .4rem; background: white; }
    .sign-panel { position: sticky; top: 1rem; padding: 1.05rem; }
    .sign-heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: 1rem; padding-bottom: .8rem; border-bottom: 1px solid rgb(226 232 240); }
    .sign-heading h2 { font-size: 1.05rem; line-height: 1.25; font-weight: 760; margin: 0; letter-spacing: 0; }
    .required-note { font-size: .78rem; color: rgb(100 116 139); white-space: nowrap; }
    label.field-label { display: block; margin-bottom: .8rem; color: rgb(15 23 42); font-size: .86rem; font-weight: 680; }
    input, select { display: block; width: 100%; height: 2.55rem; margin-top: .35rem; border: 1px solid rgb(203 213 225); border-radius: .42rem; padding: .52rem .65rem; font: inherit; font-size: .92rem; font-weight: 400; background: white; color: rgb(15 23 42); outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
    input:focus, select:focus { border-color: rgb(37 99 235); box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }
    input::placeholder { color: rgb(148 163 184); }
    input[type="date"] { color: rgb(15 23 42); }
    .check { display: grid; grid-template-columns: 1rem 1fr; gap: .65rem; align-items: start; margin: .9rem 0 1rem; color: rgb(30 41 59); font-size: .84rem; font-weight: 520; line-height: 1.45; }
    .check input { width: 1rem; height: 1rem; margin-top: .1rem; padding: 0; border-radius: .25rem; }
    .field-block { margin-bottom: .85rem; }
    .typed-signature-preview { margin-top: .5rem; min-height: 4.9rem; display: flex; align-items: center; border: 1px dashed rgb(148 163 184); border-radius: .46rem; background: linear-gradient(180deg, rgb(248 250 252), white); padding: .75rem .9rem; font-family: "AgentContract Signature", "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive; font-size: 2.6rem; font-weight: 400; line-height: 1.05; color: rgb(15 23 42); overflow-wrap: anywhere; }
    .typed-signature-preview.initials { min-height: 3.9rem; max-width: 13rem; font-size: 1.85rem; }
    .typed-signature-preview.empty { font-family: inherit; font-size: .88rem; font-weight: 400; color: rgb(100 116 139); }
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
        <div class="brand">AgentContract</div>
        <h1 class="m-0 text-xl font-semibold tracking-normal">{{document_title}}</h1>
      </div>
      <span class="status-pill">{{status_label}}</span>
    </header>
    <div class="layout">
      <section class="contract panel">{{document_html}}</section>
      <form id="sign-form" class="sign-panel panel">
        <div class="sign-heading">
          <h2>{{signer_heading}}</h2>
          <span class="required-note">* required</span>
        </div>
        <p class="mb-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">{{signer_note}}</p>
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
      const initials = block.dataset.signatureKind === "initials";
      const syncSignature = () => {
        const value = typed.value.trim();
        hidden.value = value ? JSON.stringify({ typed_name: value, method: "typed" }) : "";
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
      window.location.href = result.signed_pdf_url || result.next_url || "/sign/{{token}}";
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
  <title>{{document_title}} | AgentContract Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .contract h1 { font-size: 1.75rem; line-height: 1.15; font-weight: 760; margin-bottom: 1.15rem; }
    .contract h2 { font-size: 1.08rem; font-weight: 720; margin-top: 1.45rem; margin-bottom: .45rem; }
    .contract p { margin-bottom: .74rem; line-height: 1.65; color: rgb(30 41 59); }
    .contract ul, .contract ol { margin: .45rem 0 .8rem 1.15rem; line-height: 1.6; color: rgb(30 41 59); }
    .contract hr { margin: 1.45rem 0; border-top: 1px solid rgb(226 232 240); }
    .pdf-frame { display: block; width: 100%; min-height: 75vh; border: 1px solid rgb(203 213 225); border-radius: .4rem; background: white; }
  </style>
</head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-4xl px-4 py-6 sm:py-8">
    <header class="mb-4 flex items-center justify-between gap-4">
      <div>
        <p class="text-xs font-bold uppercase tracking-widest text-slate-500">AgentContract preview</p>
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

function uniqueEmails(emails: string[]) {
  const seen = new Set<string>();
  return emails.filter((email) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function executedCopyEmailsFor(agreement: Agreement) {
  const metadata = agreementMetadata(agreement);
  return uniqueEmails([
    agreement.recipient_email,
    metadataString(metadata, "sender_email"),
    ...notificationEmailsFor(agreement)
  ]);
}

type SigningRequest = {
  agreement: Agreement;
  role: SignerRole;
  signer: {
    name: string;
    email: string;
  };
};

function requestHostAllowed(c: Context, agreement: Agreement) {
  return signingHostMatches(agreement, c.req.url, c.req.header("host"));
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .slice(0, 4)
    .toUpperCase();
}

function defaultValueForField(field: FieldDefinition, signer: SigningRequest["signer"]) {
  const fieldKey = `${field.id} ${field.label}`.toLowerCase();
  if (field.type === "email" || fieldKey.includes("email")) return signer.email;
  if (fieldKey.includes("full legal name") || fieldKey === "full_name full legal name" || field.id === "full_name") return signer.name;
  return "";
}

function renderField(field: FieldDefinition, signer: SigningRequest["signer"]) {
  const required = field.required ? "required" : "";
  const dataRequired = field.required ? "data-required=\"true\"" : "";
  const common = `id="field-${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" ${required} ${dataRequired}`;

  if (field.type === "signature" || field.type === "initials") {
    const inputId = `field-${escapeHtml(field.id)}-typed`;
    const placeholder = field.type === "initials" ? "Type your initials" : "Type your full legal name";
    const previewPlaceholder = field.type === "initials" ? "Initials preview" : "Signature preview";
    const previewClass = field.type === "initials" ? "typed-signature-preview initials empty" : "typed-signature-preview empty";
    const typedValue = field.type === "initials" ? initialsFor(signer.name) : signer.name;
    return `
      <div class="field-block" data-field="${escapeHtml(field.id)}" data-signature-kind="${escapeHtml(field.type)}" data-typed-signature>
        <label class="field-label" for="${inputId}">${escapeHtml(field.label)}${field.required ? " *" : ""}<input id="${inputId}" type="text" autocomplete="name" data-signature-input placeholder="${placeholder}" value="${escapeHtml(typedValue)}" /></label>
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
  const value = defaultValueForField(field, signer);
  return `<label class="field-label">${escapeHtml(field.label)}${field.required ? " *" : ""}<input type="${escapeHtml(inputType)}" ${step ? `step="${step}"` : ""} ${value ? `value="${escapeHtml(value)}"` : ""} ${common} /></label>`;
}

function documentHtmlForSigning(agreement: Agreement, token: string) {
  if (agreementHasOriginalPdf(agreement)) {
    const pdfUrl = `/sign/${encodeURIComponent(token)}/original-pdf`;
    return `
      <iframe class="pdf-frame" src="${escapeHtml(pdfUrl)}" title="${escapeHtml(agreement.document_title)}"></iframe>
      <p class="mt-3 text-sm text-slate-600"><a class="font-semibold text-slate-900 underline" href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener">Open PDF in a new tab</a></p>
    `;
  }

  return marked.parse(agreement.document_markdown, { async: false }) as string;
}

function agreementMetadata(agreement: Agreement) {
  return parseJson<Record<string, unknown>>(agreement.metadata_json, {});
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function senderSignatureRequired(agreement: Agreement) {
  const metadata = agreementMetadata(agreement);
  return metadata.sender_signature_required === true
    && Boolean(metadataString(metadata, "sender_email"))
    && Boolean(metadataString(metadata, "sender_signing_token"));
}

function signerForRole(agreement: Agreement, role: SignerRole) {
  const metadata = agreementMetadata(agreement);
  if (role === "sender") {
    const email = metadataString(metadata, "sender_email");
    const name = metadataString(metadata, "sender_name") || email;
    return { name, email };
  }
  return { name: agreement.recipient_name, email: agreement.recipient_email };
}

function likePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

async function signingRequestForToken(token: string): Promise<SigningRequest | null> {
  const recipientAgreement = await getAgreementByToken(token);
  if (recipientAgreement) {
    return { agreement: recipientAgreement, role: "recipient", signer: signerForRole(recipientAgreement, "recipient") };
  }

  const candidates = await all<Agreement>(
    "SELECT * FROM agreements WHERE metadata_json LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 25",
    likePattern(token)
  );
  for (const agreement of candidates) {
    const metadata = agreementMetadata(agreement);
    if (metadataString(metadata, "sender_signing_token") === token) {
      return { agreement, role: "sender", signer: signerForRole(agreement, "sender") };
    }
  }
  return null;
}

function signedFieldsForAgreement(agreement: Agreement) {
  return parseJson<SignedFields | null>(agreement.signed_fields_json, null);
}

function roleAlreadySigned(agreement: Agreement, role: SignerRole, fields: FieldDefinition[]) {
  return signerHasRequiredFields({ signedFields: signedFieldsForAgreement(agreement), role, fields });
}

function completionState(agreement: Agreement, fields: FieldDefinition[]) {
  const signedFields = signedFieldsForAgreement(agreement);
  const recipientSigned = signerHasRequiredFields({ signedFields, role: "recipient", fields });
  const senderRequired = senderSignatureRequired(agreement);
  const senderSigned = !senderRequired || signerHasRequiredFields({ signedFields, role: "sender", fields });
  return { recipientSigned, senderRequired, senderSigned, complete: recipientSigned && senderSigned };
}

function parseSignatureSubmission(value: unknown) {
  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        parsed = trimmed;
      }
    } else {
      parsed = trimmed;
    }
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const typedName = typeof record.typed_name === "string" ? record.typed_name.trim() : "";
    const dataUrl = typeof record.data_url === "string" && record.data_url.startsWith("data:image/") ? record.data_url : "";
    return { typedName, dataUrl };
  }

  if (typeof parsed === "string" && parsed.startsWith("data:image/")) return { typedName: "", dataUrl: parsed };
  return { typedName: typeof parsed === "string" ? parsed.trim() : "", dataUrl: "" };
}

sign.get("/sign/:token", async (c) => {
  const token = c.req.param("token");
  const request = await signingRequestForToken(token);
  if (!request) return c.html("<h1>Signing link not found</h1>", 404);
  const { agreement, role, signer } = request;
  if (!requestHostAllowed(c, agreement)) return c.html("<h1>Signing link not found</h1>", 404);
  if (agreement.status === "cancelled") return c.html("<h1>This agreement has been cancelled.</h1>", 410);

  const viewedCookie = `agentink_viewed_${agreement.id}_${role}`;
  if (!getCookie(c, viewedCookie)) {
    const viewedAt = nowIso();
    if (!agreement.viewed_at) {
      await run("UPDATE agreements SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'", viewedAt, agreement.id);
    }
    await addAuditEvent({ agreementId: agreement.id, eventType: "viewed", ipAddress: clientIp(c), userAgent: c.req.header("user-agent") ?? null, data: { role } });
    setCookie(c, viewedCookie, "1", { httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
  }

  if (agreement.status === "completed") {
    return c.html(successHtml(token, "completed"));
  }

  const fields = parseJson<FieldDefinition[]>(agreement.fields_json, []);
  if (roleAlreadySigned(agreement, role, fields)) {
    return c.html(successHtml(token, completionState(agreement, fields).complete ? "completed" : "pending"));
  }
  const documentHtml = documentHtmlForSigning(agreement, token);
  const roleLabel = signerRoleLabel(role);
  return c.html(SIGN_HTML
    .replaceAll("{{document_title}}", escapeHtml(agreement.document_title))
    .replace("{{status_label}}", escapeHtml(`${roleLabel} signature requested`))
    .replace("{{signer_heading}}", escapeHtml(`Complete and Sign as ${roleLabel}`))
    .replace("{{signer_note}}", escapeHtml(`Signing as ${signer.name}${signer.email ? ` (${signer.email})` : ""}. This agreement is complete only after all required parties have signed.`))
    .replace("{{document_html}}", documentHtml)
    .replace("{{fields_html}}", fields.map((field) => renderField(field, signer)).join("\n"))
    .replaceAll("{{token}}", escapeHtml(token)));
});

sign.get("/preview/:token", async (c) => {
  const token = c.req.param("token");
  const agreement = await getAgreementByToken(token);
  if (!agreement) return c.html("<h1>Preview not found</h1>", 404);
  if (!requestHostAllowed(c, agreement)) return c.html("<h1>Preview not found</h1>", 404);

  const documentHtml = documentHtmlForSigning(agreement, token);
  return c.html(PREVIEW_HTML
    .replaceAll("{{document_title}}", escapeHtml(agreement.document_title))
    .replace("{{document_html}}", documentHtml)
    .replaceAll("{{token}}", escapeHtml(token)));
});

sign.get("/sign/:token/original-pdf", async (c) => {
  const token = c.req.param("token");
  const request = await signingRequestForToken(token);
  if (!request) return c.json({ error: "Signing link not found" }, 404);
  if (!requestHostAllowed(c, request.agreement)) return c.json({ error: "Signing link not found" }, 404);
  const buffer = originalPdfBufferForAgreement(request.agreement);
  if (!buffer) return c.json({ error: "Agreement does not have an uploaded PDF" }, 404);

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${request.agreement.original_pdf_filename ?? `${request.agreement.id}.pdf`}"`
    }
  });
});

sign.post("/sign/:token/submit", async (c) => {
  const token = c.req.param("token");
  const request = await signingRequestForToken(token);
  if (!request) return c.json({ error: "Signing link not found" }, 404);
  const { agreement, role } = request;
  if (!requestHostAllowed(c, agreement)) return c.json({ error: "Signing link not found" }, 404);
  if (agreement.status === "completed") return c.json({ error: "Agreement is already completed" }, 409);
  if (agreement.status === "cancelled") return c.json({ error: "Agreement is cancelled" }, 410);

  let body: { fields?: Record<string, unknown>; consent_timestamp?: string };
  try {
    body = await c.req.json<{ fields?: Record<string, unknown>; consent_timestamp?: string }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const submitted = body.fields ?? {};
  const fields = parseJson<FieldDefinition[]>(agreement.fields_json, []);
  if (roleAlreadySigned(agreement, role, fields)) return c.json({ error: `${signerRoleLabel(role)} has already signed this agreement` }, 409);

  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent") ?? null;
  const signedAt = nowIso();
  const signerFields: SignedFields = {};

  if (!body.consent_timestamp) return c.json({ error: "Consent is required" }, 400);

  for (const field of fields) {
    const value = submitted[field.id];

    if (field.type === "signature" || field.type === "initials") {
      const signature = parseSignatureSubmission(value);
      if (field.required && !signature.typedName && !signature.dataUrl) return c.json({ error: `${field.label} is required` }, 400);
      if (signature.typedName || signature.dataUrl) {
        signerFields[field.id] = {
          signed: true,
          signed_at: signedAt,
          ip,
          ...(signature.typedName ? { typed_name: signature.typedName } : {}),
          ...(signature.dataUrl ? { data_url: signature.dataUrl } : {}),
          method: signature.dataUrl && !signature.typedName ? "drawn" : "typed"
        };
      }
    } else {
      const missing = value === undefined || value === null || value === "" || value === false;
      if (field.required && missing) return c.json({ error: `${field.label} is required` }, 400);
      signerFields[field.id] = value;
    }
  }

  const existingSignedFields = signedFieldsForAgreement(agreement);
  const nextSignedFields = mergeSignedFieldsForRole({
    current: existingSignedFields,
    role,
    fields: signerFields,
    multiParty: senderSignatureRequired(agreement)
  });
  const recipientSigned = signerHasRequiredFields({ signedFields: nextSignedFields, role: "recipient", fields });
  const senderRequired = senderSignatureRequired(agreement);
  const senderSigned = !senderRequired || signerHasRequiredFields({ signedFields: nextSignedFields, role: "sender", fields });
  const isComplete = recipientSigned && senderSigned;
  const completedAt = isComplete ? nowIso() : null;
  const signedEvent: AuditEvent = {
    id: `evt_${nanoid(16)}`,
    agreement_id: agreement.id,
    event_type: "signed",
    ip_address: ip,
    user_agent: userAgent,
    data_json: JSON.stringify({ consent_timestamp: body.consent_timestamp, role }),
    created_at: signedAt
  };
  const completedEvent: AuditEvent = {
    id: `evt_${nanoid(16)}`,
    agreement_id: agreement.id,
    event_type: "completed",
    ip_address: ip,
    user_agent: userAgent,
    data_json: null,
    created_at: completedAt ?? signedAt
  };

  try {
    const auditEvents = await getAuditEvents(agreement.id);
    const statements: Array<{ sql: string; params?: unknown[] }> = [
      {
        sql: `INSERT INTO audit_events (id, agreement_id, event_type, ip_address, user_agent, data_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [signedEvent.id, signedEvent.agreement_id, signedEvent.event_type, signedEvent.ip_address, signedEvent.user_agent, signedEvent.data_json, signedEvent.created_at]
      }
    ];

    if (!isComplete) {
      statements.push({
        sql: `UPDATE agreements
              SET signed_fields_json = ?
              WHERE id = ?`,
        params: [JSON.stringify(nextSignedFields), agreement.id]
      });
      await runTransaction(statements);
      return c.json({
        ok: true,
        agreement_id: agreement.id,
        status: "awaiting_other_signature",
        next_url: `/sign/${token}`
      });
    }

    const pdf = await renderCompletedPDFResult({
      agreementId: agreement.id,
      markdown: agreement.document_markdown,
      originalPdf: originalPdfBufferForAgreement(agreement) ?? undefined,
      fields,
      signedFields: nextSignedFields,
      auditEvents: [...auditEvents, signedEvent, completedEvent]
    });
    statements.push(
      {
        sql: `INSERT INTO audit_events (id, agreement_id, event_type, ip_address, user_agent, data_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [completedEvent.id, completedEvent.agreement_id, completedEvent.event_type, completedEvent.ip_address, completedEvent.user_agent, completedEvent.data_json, completedEvent.created_at]
      },
      {
        sql: `UPDATE agreements
              SET status = 'completed',
                  signed_fields_json = ?,
                  completed_at = ?,
                  signed_pdf_path = ?,
                  signed_pdf_base64 = ?,
                  signed_pdf_sha256 = ?,
                  signed_pdf_bytes = ?,
                  metadata_json = ?
              WHERE id = ?`,
        params: [
          JSON.stringify(nextSignedFields),
          completedAt,
          pdf.path,
          pdf.buffer.toString("base64"),
          pdfSha256(pdf.buffer),
          pdf.buffer.byteLength,
          metadataWithSignedPdfRendererVersion(agreement.metadata_json),
          agreement.id
        ]
      }
    );
    await runTransaction(statements);
  } catch (error) {
    console.error("[AgentContract signing failed before completion]", error);
    try {
      await addAuditEvent({
        agreementId: agreement.id,
        eventType: "signing_failed",
        ipAddress: ip,
        userAgent,
        data: { error: error instanceof Error ? error.message : String(error) }
      });
    } catch (auditError) {
      console.error("[AgentContract signing failure audit failed]", auditError);
    }
    return c.json({ error: "Signing failed before completion. Please try again." }, 500);
  }

  const completedRequest = (await signingRequestForToken(token))!;
  const completed = completedRequest.agreement;
  if (completed.webhook_url) enqueueWebhook(completed.id, completed.webhook_url, completedPayload(completed));
  const executedCopyEmails = executedCopyEmailsFor(completed);
  if (executedCopyEmails.length) {
    try {
      const executedPdf = await pdfBufferForAgreement(completed);
      await sendCompletionEmail({
        to: executedCopyEmails,
        senderName: metadataString(agreementMetadata(completed), "sender_name"),
        fromEmail: metadataString(agreementMetadata(completed), "sender_email") || undefined,
        recipientName: completed.recipient_name,
        recipientEmail: completed.recipient_email,
        documentTitle: completed.document_title,
        agreementId: completed.id,
        signedPdfUrl: agreementUrl(completed, `/sign/${token}/pdf`),
        signedPdfBase64: executedPdf.toString("base64")
      });
      await addAuditEvent({ agreementId: completed.id, eventType: "executed_copy_sent", data: { to: executedCopyEmails, attached_pdf: true } });
    } catch (error) {
      console.error("[AgentContract executed copy email failed]", error);
      await addAuditEvent({
        agreementId: completed.id,
        eventType: "executed_copy_failed",
        data: { to: executedCopyEmails, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  return c.json({ ok: true, agreement_id: agreement.id, signed_pdf_url: `/sign/${token}/pdf` });
});

sign.get("/sign/:token/pdf", async (c) => {
  const token = c.req.param("token");
  const request = await signingRequestForToken(token);
  if (!request) return c.json({ error: "Signing link not found" }, 404);
  const { agreement } = request;
  if (!requestHostAllowed(c, agreement)) return c.json({ error: "Signing link not found" }, 404);
  if (agreement.status !== "completed") return c.json({ error: "Agreement is not completed" }, 400);

  const buffer = await pdfBufferForAgreement(agreement);

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${agreement.id}.pdf"`
    }
  });
});

function successHtml(token: string, mode: "completed" | "pending") {
  const completed = mode === "completed";
  return `<!doctype html>
<html><head><meta charset="utf-8"><script src="https://cdn.tailwindcss.com"></script><title>Signed</title></head>
<body class="bg-slate-50 text-slate-950">
  <main class="mx-auto max-w-xl px-6 py-20">
    <h1 class="text-3xl font-semibold">${completed ? "Agreement signed" : "Signature saved"}</h1>
    <p class="mt-4 text-slate-700">${completed ? "Thank you. The completed PDF has been generated." : "Thank you. This agreement is waiting for the other required signature before the completed PDF is generated."}</p>
    ${completed
      ? `<a class="mt-8 inline-flex rounded bg-slate-950 px-4 py-2 text-white" href="/sign/${escapeHtml(token)}/pdf">Download PDF</a>`
      : `<a class="mt-8 inline-flex rounded border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700" href="/sign/${escapeHtml(token)}">Refresh status</a>`}
  </main>
</body></html>`;
}
