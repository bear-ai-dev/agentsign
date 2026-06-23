import type { Context, Next } from "hono";

const cookieConsentSnippet = `
<style>
  #c15t-cookie-banner,
  #c15t-cookie-dialog {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #0f172a;
  }
  #c15t-cookie-banner[hidden],
  #c15t-cookie-dialog[hidden] {
    display: none;
  }
  #c15t-cookie-banner {
    position: fixed;
    right: 18px;
    bottom: 18px;
    left: 18px;
    z-index: 9999;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px;
    align-items: center;
    max-width: 920px;
    margin: 0 auto;
    padding: 18px;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    background: #ffffff;
    box-shadow: 0 18px 54px rgba(15, 23, 42, 0.18);
  }
  #c15t-cookie-banner h2,
  #c15t-cookie-dialog h2 {
    margin: 0;
    color: #0f172a;
    font-size: 18px;
    line-height: 1.2;
  }
  #c15t-cookie-banner p,
  #c15t-cookie-dialog p {
    margin: 6px 0 0;
    color: #475569;
    font-size: 14px;
    line-height: 1.5;
  }
  #c15t-cookie-dialog {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    padding: 18px;
    background: rgba(15, 23, 42, 0.28);
  }
  .c15t-dialog-card {
    width: min(100%, 440px);
    padding: 20px;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    background: #ffffff;
    box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);
  }
  .c15t-dialog-card label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    margin-top: 12px;
    color: #0f172a;
    font-size: 14px;
    font-weight: 600;
  }
  .c15t-dialog-card label:first-of-type {
    margin-top: 18px;
  }
  .c15t-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
  }
  .c15t-dialog-card .c15t-actions {
    margin-top: 20px;
  }
  .c15t-actions button {
    min-height: 40px;
    padding: 0 14px;
    cursor: pointer;
    border: 1px solid #0f172a;
    border-radius: 8px;
    background: #0f172a;
    color: #ffffff;
    font: inherit;
    font-size: 14px;
    font-weight: 700;
  }
  .c15t-actions button:first-child,
  .c15t-actions button[data-c15t-action="manage"] {
    border-color: #cbd5e1;
    background: #ffffff;
    color: #0f172a;
  }
  .c15t-actions button:focus-visible {
    outline: 3px solid #2563eb;
    outline-offset: 2px;
  }
  @media (max-width: 680px) {
    #c15t-cookie-banner {
      grid-template-columns: 1fr;
    }
    .c15t-actions {
      justify-content: stretch;
    }
    .c15t-actions button {
      flex: 1 1 120px;
    }
  }
</style>
<script type="module">
  import { getOrCreateConsentRuntime } from "https://esm.sh/c15t@2.1.0";

  const { consentStore } = getOrCreateConsentRuntime({
    mode: "offline",
    consentCategories: ["necessary", "measurement", "marketing", "functionality"],
  });

  window.c15tStore = consentStore;

  function mountCookieBanner() {
    if (document.getElementById("c15t-cookie-banner")) return;

    const banner = document.createElement("section");
    banner.id = "c15t-cookie-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Cookie consent");
    banner.hidden = true;
    banner.innerHTML = \`
      <div>
        <h2>Privacy choices</h2>
        <p>We use cookies to keep this site working and to understand how people use it.</p>
      </div>
      <div class="c15t-actions">
        <button type="button" data-c15t-action="reject">Reject</button>
        <button type="button" data-c15t-action="manage">Manage</button>
        <button type="button" data-c15t-action="accept">Accept all</button>
      </div>
    \`;

    const dialog = document.createElement("section");
    dialog.id = "c15t-cookie-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Cookie preferences");
    dialog.hidden = true;
    dialog.innerHTML = \`
      <div class="c15t-dialog-card">
        <h2>Cookie preferences</h2>
        <p>Choose which optional cookies this site can use.</p>
        <label><span>Necessary</span><input type="checkbox" checked disabled></label>
        <label><span>Measurement</span><input type="checkbox" data-c15t-consent="measurement"></label>
        <label><span>Marketing</span><input type="checkbox" data-c15t-consent="marketing"></label>
        <label><span>Functionality</span><input type="checkbox" data-c15t-consent="functionality"></label>
        <div class="c15t-actions">
          <button type="button" data-c15t-action="reject">Reject</button>
          <button type="button" data-c15t-action="save">Save choices</button>
          <button type="button" data-c15t-action="accept">Accept all</button>
        </div>
      </div>
    \`;

    document.body.append(banner, dialog);

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const action = target.dataset.c15tAction;
      if (!action) return;

      if (action === "accept") void consentStore.getState().saveConsents("all");
      if (action === "reject") void consentStore.getState().saveConsents("necessary");
      if (action === "manage") consentStore.getState().setActiveUI("dialog");
      if (action === "save") void consentStore.getState().saveConsents("custom");
    });

    dialog.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.dataset.c15tConsent) return;

      consentStore
        .getState()
        .setSelectedConsent(target.dataset.c15tConsent, target.checked);
    });

    function render() {
      const state = consentStore.getState();
      banner.hidden = state.activeUI !== "banner";
      dialog.hidden = state.activeUI !== "dialog";

      dialog.querySelectorAll("[data-c15t-consent]").forEach((input) => {
        if (!(input instanceof HTMLInputElement)) return;
        const consent = input.dataset.c15tConsent;
        input.checked = Boolean(
          state.selectedConsents[consent] ?? state.consents[consent]
        );
      });
    }

    consentStore.subscribe(render);
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountCookieBanner, { once: true });
  } else {
    mountCookieBanner();
  }
</script>
`;

export async function cookieConsentMiddleware(c: Context, next: Next) {
  await next();

  if (c.req.method !== "GET") return;

  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return;

  const html = await c.res.text();
  if (!html.includes("</body>") || html.includes("c15t-cookie-banner")) return;

  const headers = new Headers(c.res.headers);
  headers.delete("content-length");

  c.res = new Response(html.replace("</body>", `${cookieConsentSnippet}</body>`), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
}
