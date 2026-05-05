import { Hono } from "hono";
import { marked } from "marked";
import { applyTemplateVars, defaultTemplateVars, loadTemplate, templateDefinitions, type TemplateDefinition } from "../lib/templates.js";

export const site = new Hono();

const primaryOrigin = "https://agentcontract.to";
const cliPackageName = "@bear-ai-dev/agentcontract";
const currentCliVersion = "0.1.9";
const pageTitle = "AgentContract | Contract signing API and CLI for AI agents";
const pageDescription = "AgentContract is a contract signing API and CLI that lets AI agents send approved NDAs, privacy acknowledgements, and contractor agreements for human e-signature.";
const publicTemplateIds = ["mutual-nda", "one-way-nda", "privacy-policy"] as const;
type PublicTemplateId = typeof publicTemplateIds[number];

type PublicSeoPage = {
  path: string;
  title: string;
  description: string;
  eyebrow: string;
  h1: string;
  intro: string;
  proof: string;
  sections: Array<{ heading: string; body: string }>;
};

const publicSeoPages: PublicSeoPage[] = [
  {
    path: "/ai-agent-contracts",
    title: "AI Agent Contracts | AgentContract",
    description: "Use AgentContract to send contracts for AI agents while keeping approved legal language, human review, and human signatures in the loop.",
    eyebrow: "AI Agent Contracts",
    h1: "AI agent contracts that humans still control",
    intro: "AgentContract gives software agents a narrow contract workflow: inspect approved packets, fill known variables, send signing links, and report status. It is built for contracts for AI agents without making the agent a signer, lawyer, or contract author.",
    proof: "Agents send approved NDAs, privacy acknowledgements, contractor agreements, and marketplace onboarding packets. People review and sign them.",
    sections: [
      {
        heading: "What an AI agent is allowed to do",
        body: "The agent can select an approved template, pass recipient details, run a dry run, send the packet, remind the signer, and download the signed record. The agent does not rewrite terms or decide whether someone should sign."
      },
      {
        heading: "What your team gets back",
        body: "Your workflow receives status, audit events, signed PDF bytes, SHA-256 hashes, and webhook callbacks so the next automation step can continue with a verifiable record."
      },
      {
        heading: "Where this fits",
        body: "Use it for marketplace onboarding, vendor packets, contractor agreements, privacy acknowledgements, and repeatable internal paperwork where the same approved language is sent many times."
      }
    ]
  },
  {
    path: "/contract-sending-api",
    title: "Contract Sending API for AI Agents | AgentContract",
    description: "A contract sending API for AI agents, scripts, and backend workflows that need to send approved agreements and receive signed records.",
    eyebrow: "Contract Sending API",
    h1: "Contract sending API for agent workflows",
    intro: "AgentContract exposes API and CLI rails to send approved contracts from an AI agent without turning the model into a legal drafter. Your backend controls templates, recipients, metadata, webhooks, and completion records.",
    proof: "Use the API when an onboarding workflow needs a contract sent now and a signed PDF returned later.",
    sections: [
      {
        heading: "Create agreements from approved packets",
        body: "Send template ids, known variables, signer fields, recipients, and metadata. AgentContract creates a signing link and records every meaningful status change."
      },
      {
        heading: "Track completion by machine",
        body: "Poll agreement status or receive signed webhook callbacks when the signer completes, cancels, or needs follow-up. Signed PDFs and hashes remain tied to the agreement."
      },
      {
        heading: "Keep private workflows private",
        body: "Dashboards, signing links, auth routes, and API routes stay out of the sitemap and robots allowlist while public product and documentation pages remain indexable."
      }
    ]
  },
  {
    path: "/agent-contract-cli",
    title: "Agent Contract CLI | AgentContract",
    description: "Install the AgentContract CLI so local AI coding agents can inspect templates, send approved contracts, and track signed records.",
    eyebrow: "Agent Contract CLI",
    h1: "Agent contract CLI for local AI workflows",
    intro: "The agentcontract CLI lets Claude Code, Codex, scripts, and other local agent workflows read approved packets, dry-run sends, authenticate with email codes, and track agreements from the terminal.",
    proof: "Install the agentcontract CLI, run the agent skill command, then give your local agent a controlled contract-sending tool.",
    sections: [
      {
        heading: "Built for local agents",
        body: "The CLI prints structured JSON, supports dry runs, saves login config locally, and gives agents explicit commands for reading, sending, reminding, cancelling, and reporting failures."
      },
      {
        heading: "Human-signature boundary",
        body: "Local agents can prepare and send approved packets, but the recipient signs in the browser. AgentContract keeps the contract action separate from model reasoning."
      },
      {
        heading: "Fast first test",
        body: "A tester can install from the hosted CLI page, log in with an email code, run doctor, inspect templates, and send a dry-run marketplace onboarding packet."
      }
    ]
  },
  {
    path: "/esignature-for-ai-agents",
    title: "E-signature for AI Agents | AgentContract",
    description: "AgentContract provides e-signature for AI agents that send approved packets while humans review, consent, and sign in the browser.",
    eyebrow: "E-signature for AI Agents",
    h1: "E-signature for AI agents, with people in the signing loop",
    intro: "AgentContract gives agent workflows an e-signature path that keeps the final human action explicit. Agents can send the packet. People review the document, consent, type or draw a signature, and submit the signed record.",
    proof: "Use e-signature for AI agents when automation should move paperwork forward but not replace the human signer.",
    sections: [
      {
        heading: "Browser signing pages",
        body: "Recipients open a signing URL, review the agreement, complete required fields, consent to electronic signature, and submit the signed packet."
      },
      {
        heading: "Executed records",
        body: "After completion, AgentContract stores signer fields, audit events, signed PDF bytes, completion timestamps, and SHA-256 hashes for later verification."
      },
      {
        heading: "Agent-safe workflow design",
        body: "The product avoids legal advice and contract drafting. It focuses on controlled delivery, human review, human signature, and machine-readable completion."
      }
    ]
  }
];

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function canonicalOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === "agentink-pied.vercel.app" || hostname.endsWith(".vercel.app")) return "https://agentcontract.to";
  } catch {
    return origin;
  }
  return origin;
}

function canonicalUrl(origin: string, path = "/") {
  return `${canonicalOrigin(origin)}${path.startsWith("/") ? path : `/${path}`}`;
}

function publicUrl(path = "/") {
  return canonicalUrl(primaryOrigin, path);
}

function jsonLd(value: unknown) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function structuredData(origin: string) {
  const homeUrl = canonicalUrl(origin);
  const organizationId = `${homeUrl}#organization`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: "AgentContract",
        url: homeUrl,
        description: pageDescription
      },
      {
        "@type": "WebSite",
        "@id": `${homeUrl}#website`,
        name: "AgentContract",
        url: homeUrl,
        description: pageDescription,
        inLanguage: "en-US",
        publisher: { "@id": organizationId }
      },
      {
        "@type": "Service",
        "@id": `${homeUrl}#service`,
        name: "AgentContract",
        serviceType: "Contract signing API and CLI for AI agents",
        url: homeUrl,
        description: pageDescription,
        provider: { "@id": organizationId },
        audience: {
          "@type": "Audience",
          audienceType: "AI agent builders, marketplace operators, compliance teams"
        }
      }
    ]
  };
}

function robotsTxt(_origin: string) {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /dashboard/",
    "Disallow: /auth/",
    "Disallow: /cli/login",
    "Disallow: /cli/magic/",
    "Disallow: /sign/",
    "Disallow: /v1/",
    `Sitemap: ${publicUrl("/sitemap.xml")}`,
    ""
  ].join("\n");
}

function sitemapXml(_origin: string) {
  const urls = [
    { loc: publicUrl(), priority: "1.0", changefreq: "weekly" },
    { loc: publicUrl("/cli"), priority: "0.8", changefreq: "monthly" },
    ...publicSeoPages.map((page) => ({ loc: publicUrl(page.path), priority: "0.75", changefreq: "monthly" })),
    { loc: publicUrl("/templates"), priority: "0.7", changefreq: "monthly" },
    ...publicTemplateIds.map((id) => ({ loc: publicUrl(`/templates/${id}`), priority: "0.6", changefreq: "monthly" }))
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url>
    <loc>${escapeXml(url.loc)}</loc>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`).join("\n")}
</urlset>
`;
}

function llmsTxt(_origin: string) {
  return `# AgentContract

> Contract signing API and CLI for AI agents.

AgentContract lets AI agent workflows send approved NDAs, privacy acknowledgements, and contractor agreements. Agents send approved packets only; humans sign contracts in the browser. The system returns signed PDFs, SHA-256 hashes, webhooks, status, and audit trails.

## Primary Links

- [Homepage](${publicUrl()}): Product overview for agent-sent, human-signed contracts.
- [AI agent contracts](${publicUrl("/ai-agent-contracts")}): Search-focused overview of controlled contracts for AI agents.
- [Contract sending API](${publicUrl("/contract-sending-api")}): API page for sending approved contracts from agent workflows.
- [Agent contract CLI](${publicUrl("/agent-contract-cli")}): CLI overview for local AI coding agents and scripts.
- [E-signature for AI agents](${publicUrl("/esignature-for-ai-agents")}): Human-in-the-loop e-signature workflow page.
- [CLI docs](${publicUrl("/cli")}): Install, authenticate, inspect templates, send agreements, track status, and report failures.
- [Template library](${publicUrl("/templates")}): Public previews for standard mutual NDA, one-way NDA, and website/app privacy policy templates.
- [CLI installer](${publicUrl("/cli/install.sh")}): Shell installer for Node.js 20+ environments.
- [Status and version metadata](${publicUrl("/healthz")}): Current AgentContract service and CLI version metadata.

## Agent Guidance

- Use AgentContract for sending approved contract templates from agent workflows.
- Do not use AgentContract to let agents draft legal terms or sign contracts.
- Run \`agentcontract skill\` after installing the CLI to print agent integration instructions.
- Prefer preview, dry-run, and template read commands before sending email to signers.

## Useful Concepts

- Approved template API
- Recipient browser signing
- Signed PDF storage
- SHA-256 PDF hashes
- Webhook completion events
- Audit events for contract status changes
`;
}

function publicTemplateKind(id: PublicTemplateId) {
  if (id === "privacy-policy") return "Privacy policy";
  if (id === "one-way-nda") return "One-way NDA";
  return "Mutual NDA";
}

function publicTemplateResearch(id: PublicTemplateId) {
  if (id === "privacy-policy") {
    return [
      { label: "FTC consumer privacy guidance", href: "https://www.ftc.gov/business-guidance/privacy-security/consumer-privacy" },
      { label: "California DOJ CCPA overview", href: "https://www.oag.ca.gov/privacy/ccpa" },
      { label: "ICO privacy notice guidance", href: "https://ico.org.uk/for-organisations/advice-for-small-organisations/privacy-notices-and-cookies/how-to-write-a-privacy-notice-and-what-goes-in-it/" }
    ];
  }
  return [
    { label: "GOV.UK NDA guidance and examples", href: "https://www.gov.uk/government/publications/non-disclosure-agreements" },
    { label: "oneNDA mutual NDA standard", href: "https://www.lawinsider.com/standards/onenda" },
    { label: "Stanford one-way NDA sample", href: "https://nonprofitdocuments.law.stanford.edu/non-disclosure/non-disclosure-agreement-one-way/" }
  ];
}

function publicTemplateCss() {
  return `
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1b2433;
      --muted: #697386;
      --quiet: #929aab;
      --line: #d9dfeb;
      --line-dark: #aeb7c8;
      --blue: #194fe5;
      --green: #0d7659;
      --amber: #8a5a00;
      --amber-soft: #fff7df;
      --shadow: 0 24px 70px rgba(15, 23, 42, .1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(8, 11, 18, .04) 1px, transparent 1px),
        linear-gradient(180deg, rgba(8, 11, 18, .04) 1px, transparent 1px),
        var(--bg);
      background-size: 4.5rem 4.5rem;
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    code, pre { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
    .shell { width: min(100% - 2rem, 1120px); margin: 0 auto; }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      min-height: 4.25rem;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-weight: 750;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }
    .nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: .45rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 750;
      text-transform: uppercase;
    }
    .nav a {
      border: 1px solid var(--line-dark);
      background: rgba(255,255,255,.72);
      padding: .58rem .7rem;
    }
    .nav a.primary { background: var(--ink); color: white; border-color: var(--ink); }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, .92fr) minmax(22rem, 1.08fr);
      gap: clamp(1.75rem, 4vw, 3.5rem);
      align-items: center;
      padding: clamp(2.4rem, 5vw, 4.2rem) 0 clamp(1.6rem, 3vw, 2.4rem);
    }
    .eyebrow {
      display: inline-flex;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--muted);
      padding: .4rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .74rem;
      font-weight: 750;
      text-transform: uppercase;
    }
    h1 {
      margin: 1rem 0 0;
      max-width: 12ch;
      color: var(--ink);
      font-size: clamp(2.45rem, 4.2vw, 4.1rem);
      line-height: 1;
      font-weight: 650;
      letter-spacing: 0;
    }
    .hero p {
      margin: 1rem 0 0;
      color: var(--muted);
      font-size: 1.05rem;
      line-height: 1.62;
      max-width: 44rem;
    }
    .notice {
      border: 1px solid var(--line-dark);
      background: var(--amber-soft);
      padding: 1rem;
      color: #4a3300;
      line-height: 1.55;
      max-width: 40rem;
    }
    .template-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1rem;
      margin: 0 auto clamp(2.4rem, 5vw, 4rem);
    }
    .template-card {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: .85rem;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      min-height: 14.5rem;
      padding: 1.15rem;
      box-shadow: 0 12px 40px rgba(15, 23, 42, .06);
    }
    .template-card h2,
    .content h2 {
      margin: 0;
      color: var(--ink);
      font-size: 1.15rem;
      line-height: 1.25;
    }
    .template-card p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
      font-size: .94rem;
    }
    .tag {
      display: inline-flex;
      width: fit-content;
      border: 1px solid var(--line);
      background: #eef3ff;
      color: var(--blue);
      padding: .25rem .42rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .72rem;
      font-weight: 750;
      text-transform: uppercase;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.55rem;
      border: 1px solid var(--ink);
      background: var(--ink);
      color: white;
      padding: .64rem .85rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .78rem;
      font-weight: 750;
      text-transform: uppercase;
      width: fit-content;
      align-self: end;
    }
    .detail {
      display: grid;
      grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
      gap: 1.25rem;
      align-items: start;
      padding-bottom: 3rem;
    }
    .panel,
    .content {
      border: 1px solid var(--line-dark);
      background: var(--paper);
      box-shadow: var(--shadow);
    }
    .panel { padding: 1rem; }
    .panel h2 { margin: 0 0 .7rem; color: var(--ink); font-size: 1rem; }
    .panel ul { margin: 0; padding: 0; list-style: none; display: grid; gap: .55rem; }
    .panel li { color: var(--muted); font-size: .9rem; line-height: 1.4; }
    .panel b { color: var(--ink); }
    .panel a { color: var(--blue); font-weight: 700; }
    .command {
      margin-top: 1rem;
      background: #0c111d;
      color: #f8fafc;
      padding: .9rem;
      overflow-x: auto;
      font-size: .78rem;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .content {
      padding: clamp(1.1rem, 3vw, 2rem);
      overflow: hidden;
    }
    .document {
      max-width: 48rem;
      color: #1e293b;
    }
    .document h1 {
      margin: 0 0 1rem;
      font-size: clamp(1.85rem, 3vw, 2.5rem);
      line-height: 1.08;
    }
    .document h2 {
      margin-top: 1.45rem;
      margin-bottom: .5rem;
    }
    .document p,
    .document li {
      line-height: 1.66;
    }
    .document ul { padding-left: 1.2rem; }
    .document hr {
      border: 0;
      border-top: 1px solid var(--line);
      margin: 1.4rem 0;
    }
    .footer {
      border-top: 1px solid var(--line);
      padding: 1.3rem 0;
      color: var(--muted);
      font-size: .9rem;
    }
    .footer a { color: var(--ink); font-weight: 700; }
    @media (max-width: 920px) {
      .hero,
      .detail,
      .template-grid {
        grid-template-columns: 1fr;
      }
      h1 { max-width: 13ch; }
      .notice { max-width: none; }
    }
    @media (max-width: 620px) {
      .shell { width: min(100% - 1rem, 1120px); }
      .topbar { align-items: flex-start; flex-direction: column; padding: .85rem 0; }
      h1 { font-size: 2.35rem; }
      .hero { padding-top: 1.65rem; }
      .template-card { min-height: auto; }
    }
  `;
}

function publicTemplateHead(title: string, description: string, canonical: string) {
  return `<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${publicTemplateCss()}</style>
</head>`;
}

function publicTemplateTopbar() {
  return `<header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="Template navigation">
      <a href="/templates">Templates</a>
      <a href="/cli">CLI</a>
      <a class="primary" href="/dashboard">Dashboard</a>
    </nav>
  </header>`;
}

function publicTemplateCard(id: PublicTemplateId) {
  const definition = templateDefinitions[id];
  return `<article class="template-card">
    <span class="tag">${escapeHtml(publicTemplateKind(id))}</span>
    <h2>${escapeHtml(definition.name)}</h2>
    <p>${escapeHtml(definition.description)}</p>
    <a class="button" href="/templates/${escapeHtml(id)}">Read Template</a>
  </article>`;
}

function renderPublicTemplatesPage(_origin: string) {
  const description = "Read public standard templates for mutual NDAs, one-way NDAs, and website/app privacy policies before sending them through AgentContract.";
  return `<!doctype html>
<html lang="en">
${publicTemplateHead("Standard Legal Templates | AgentContract", description, publicUrl("/templates"))}
<body>
  ${publicTemplateTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow">Public Template Library</span>
        <h1>Standard templates people can read first.</h1>
      </div>
      <div>
        <p>These generic templates are visible without logging in and can be inspected through the CLI or API before anyone sends a signing request.</p>
        <p class="notice">Template only, not legal advice. Review with counsel before using in production, especially for regulated data, employment terms, consumers, health data, financial data, international users, or state-specific privacy rights.</p>
      </div>
    </section>

    <section class="shell template-grid" aria-label="Public templates">
      ${publicTemplateIds.map(publicTemplateCard).join("")}
    </section>
  </main>
  <footer class="footer">
    <div class="shell">AgentContract public templates: <a href="/templates/mutual-nda">Mutual NDA</a> · <a href="/templates/one-way-nda">One-way NDA</a> · <a href="/templates/privacy-policy">Privacy Policy</a></div>
  </footer>
</body>
</html>`;
}

function templateVariablesList(definition: TemplateDefinition) {
  return definition.variables.map((variable) => `<li><b>${escapeHtml(variable.key)}</b>: ${escapeHtml(variable.defaultValue)}</li>`).join("");
}

function templateResearchList(id: PublicTemplateId) {
  return publicTemplateResearch(id).map((source) => `<li><a href="${escapeHtml(source.href)}">${escapeHtml(source.label)}</a></li>`).join("");
}

function renderPublicTemplatePage(_origin: string, id: PublicTemplateId) {
  const definition = templateDefinitions[id];
  const defaults = {
    ...defaultTemplateVars(definition),
    recipient_name: "Jane Recipient",
    recipient_email: "jane@example.com"
  };
  const markdown = applyTemplateVars(loadTemplate(id), defaults);
  const documentHtml = marked.parse(markdown, { async: false }) as string;
  const command = `agentcontract template read ${id} --out ./${id}.md
agentcontract template send ${id} --to jane@example.com --name "Jane Recipient"`;
  const description = `${definition.name} public preview and template variables for AgentContract.`;

  return `<!doctype html>
<html lang="en">
${publicTemplateHead(`${definition.name} | AgentContract Templates`, description, publicUrl(`/templates/${id}`))}
<body>
  ${publicTemplateTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow">${escapeHtml(publicTemplateKind(id))}</span>
        <h1>${escapeHtml(definition.name)}</h1>
      </div>
      <div>
        <p>${escapeHtml(definition.description)}</p>
        <p class="notice">Template only, not legal advice. The preview uses sample values. Replace variables, confirm governing law, and review with counsel before sending.</p>
      </div>
    </section>

    <section class="shell detail">
      <aside class="panel">
        <h2>Variables</h2>
        <ul>${templateVariablesList(definition)}</ul>
        <h2 style="margin-top:1.2rem;">Research Basis</h2>
        <ul>${templateResearchList(id)}</ul>
        <pre class="command"><code>${escapeHtml(command)}</code></pre>
      </aside>
      <section class="content">
        <article class="document">${documentHtml}</article>
      </section>
    </section>
  </main>
  <footer class="footer">
    <div class="shell"><a href="/templates">All templates</a> · <a href="/cli">CLI docs</a> · <a href="/dashboard">Dashboard</a></div>
  </footer>
</body>
</html>`;
}

function seoPageCss() {
  return `
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1b2433;
      --muted: #667085;
      --line: #d9dfeb;
      --blue: #194fe5;
      --green: #0d7659;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        var(--bg);
      background-size: 4.6rem 4.6rem;
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0;
    }
    a { color: inherit; text-decoration: none; }
    .shell {
      width: min(100% - 2rem, 1120px);
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 4.5rem;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-weight: 700;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 2.05rem;
      height: 2.05rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }
    .nav {
      display: flex;
      align-items: center;
      gap: .35rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .nav a {
      border: 1px solid transparent;
      padding: .62rem .75rem;
    }
    .nav .primary {
      border-color: var(--ink);
      background: var(--ink);
      color: white;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, .92fr) minmax(24rem, 1.08fr);
      gap: clamp(2rem, 5vw, 4.8rem);
      align-items: start;
      padding: clamp(3rem, 7vw, 5.2rem) 0 clamp(2.2rem, 5vw, 4rem);
    }
    .eyebrow {
      display: inline-flex;
      border: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: .42rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    h1 {
      margin: 1rem 0 0;
      max-width: 13ch;
      color: var(--ink);
      font-size: clamp(2.65rem, 5.1vw, 5rem);
      line-height: 1;
      font-weight: 600;
      letter-spacing: 0;
    }
    .lede {
      margin: 1.25rem 0 0;
      color: var(--muted);
      font-size: 1.08rem;
      line-height: 1.68;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: .7rem;
      margin-top: 1.4rem;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.85rem;
      border: 1px solid var(--ink);
      padding: .72rem 1rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .button.primary {
      background: var(--ink);
      color: white;
    }
    .button.secondary {
      background: var(--paper);
      color: var(--ink);
    }
    .preview {
      border: 1px solid var(--ink);
      background: var(--paper);
      box-shadow: 0 30px 90px rgba(15, 23, 42, .12);
      padding: 1rem;
    }
    .preview header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid var(--line);
      padding-bottom: .85rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .preview h2 {
      margin: 1rem 0 .55rem;
      color: var(--ink);
      font-size: 1.15rem;
      line-height: 1.25;
    }
    .line {
      height: .55rem;
      border-radius: 999px;
      background: #dfe5ef;
      margin-top: .62rem;
    }
    .line:nth-child(4) { width: 88%; }
    .line:nth-child(5) { width: 72%; }
    .line:nth-child(6) { width: 94%; }
    .proof {
      border-left: 3px solid var(--green);
      margin-top: 1rem;
      background: #edf8f3;
      color: #184e3d;
      padding: .85rem;
      line-height: 1.5;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      border: 1px solid var(--ink);
      background: var(--ink);
      margin-bottom: clamp(3rem, 7vw, 5rem);
    }
    .card {
      background: var(--paper);
      padding: 1.1rem;
      min-height: 12rem;
    }
    .card h2 {
      margin: 0;
      color: var(--ink);
      font-size: 1.05rem;
      line-height: 1.25;
    }
    .card p {
      margin: .65rem 0 0;
      color: var(--muted);
      font-size: .94rem;
      line-height: 1.58;
    }
    .footer {
      border-top: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: 1.3rem 0;
      font-size: .9rem;
    }
    .footer a { color: var(--ink); font-weight: 700; }
    @media (max-width: 900px) {
      .hero,
      .grid {
        grid-template-columns: 1fr;
      }
      .nav { flex-wrap: wrap; justify-content: flex-end; }
    }
    @media (max-width: 620px) {
      .shell { width: min(100% - 1rem, 1120px); }
      .topbar { align-items: flex-start; flex-direction: column; padding: .85rem 0; }
      h1 { font-size: 2.55rem; }
      .actions .button { width: 100%; }
    }
  `;
}

function seoTopbar() {
  return `<header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="SEO page navigation">
      <a href="/ai-agent-contracts">AI Contracts</a>
      <a href="/contract-sending-api">API</a>
      <a href="/agent-contract-cli">CLI</a>
      <a href="/esignature-for-ai-agents">E-sign</a>
      <a class="primary" href="/cli">Docs</a>
    </nav>
  </header>`;
}

function renderSeoPage(page: PublicSeoPage) {
  const canonical = publicUrl(page.path);
  const sectionCards = page.sections.map((section) => `<article class="card">
      <h2>${escapeHtml(section.heading)}</h2>
      <p>${escapeHtml(section.body)}</p>
    </article>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:site_name" content="AgentContract" />
  <meta property="og:title" content="${escapeHtml(page.title)}" />
  <meta property="og:description" content="${escapeHtml(page.description)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(page.title)}" />
  <meta name="twitter:description" content="${escapeHtml(page.description)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>${seoPageCss()}</style>
</head>
<body>
  ${seoTopbar()}
  <main>
    <section class="shell hero">
      <div>
        <span class="eyebrow">${escapeHtml(page.eyebrow)}</span>
        <h1>${escapeHtml(page.h1)}</h1>
        <p class="lede">${escapeHtml(page.intro)}</p>
        <div class="actions">
          <a class="button primary" href="/cli">Start with CLI</a>
          <a class="button secondary" href="/templates">Read templates</a>
        </div>
      </div>
      <aside class="preview" aria-label="AgentContract workflow preview">
        <header><span>Approved packet</span><span>Human signed</span></header>
        <h2>Agent-sent agreement</h2>
        <div class="line"></div>
        <div class="line"></div>
        <div class="line"></div>
        <p class="proof">${escapeHtml(page.proof)}</p>
      </aside>
    </section>
    <section class="shell grid" aria-label="AgentContract details">
      ${sectionCards}
    </section>
  </main>
  <footer class="footer">
    <div class="shell">
      Related: <a href="/ai-agent-contracts">AI agent contracts</a> · <a href="/contract-sending-api">Contract sending API</a> · <a href="/agent-contract-cli">Agent contract CLI</a> · <a href="/esignature-for-ai-agents">E-signature for AI agents</a>
    </div>
  </footer>
</body>
</html>`;
}

function cliVersionMetadata(origin: string) {
  return {
    name: "AgentContract",
    ok: true,
    version: currentCliVersion,
    cli: {
      package: cliPackageName,
      version: currentCliVersion,
      minimum_version: currentCliVersion,
      install_url: `${origin}/cli/install.sh`,
      install_command: `curl -fsSL ${origin}/cli/install.sh | bash`
    }
  };
}

function wantsJson(accept: string, format: string | undefined) {
  if (format === "json") return true;
  return accept
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === "application/json" || part.startsWith("application/json;"));
}

function homePage(origin: string) {
  const safeOrigin = escapeHtml(origin);
  const safeCanonical = escapeHtml(publicUrl());
  const installCommand = `curl -fsSL ${origin}/cli/install.sh | bash`;
  const structuredDataJson = jsonLd(structuredData(primaryOrigin));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(pageDescription)}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <link rel="canonical" href="${safeCanonical}" />
  <link rel="alternate" type="text/plain" href="${escapeHtml(publicUrl("/llms.txt"))}" title="llms.txt" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${safeCanonical}" />
  <meta property="og:site_name" content="AgentContract" />
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(pageDescription)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(pageDescription)}" />
  <script type="application/ld+json">${structuredDataJson}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #080b12;
      --text: #1b2433;
      --muted: #697386;
      --quiet: #929aab;
      --line: #d9dfeb;
      --line-dark: #aeb7c8;
      --blue: #194fe5;
      --blue-soft: #eef3ff;
      --green: #0d7659;
      --green-soft: #e9f7f1;
      --amber: #9b6400;
      --amber-soft: #fff6df;
      --dark: #0c111d;
      --shadow: 0 30px 90px rgba(15, 23, 42, .12);
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      background:
        linear-gradient(90deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(8, 11, 18, .045) 1px, transparent 1px),
        var(--bg);
      background-size: 4.6rem 4.6rem;
      color: var(--text);
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0;
    }

    a { color: inherit; text-decoration: none; }
    button { font: inherit; }
    code, pre { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }

    .shell {
      width: min(100% - 2rem, 1180px);
      margin: 0 auto;
    }

    .notice {
      border-bottom: 1px solid var(--line);
      background: var(--paper);
      color: var(--ink);
      font-size: .86rem;
      text-align: center;
      padding: .58rem 1rem;
    }

    .notice a {
      border-bottom: 1px solid currentColor;
      font-weight: 700;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-height: 4.5rem;
      border-bottom: 1px solid var(--line);
      background: rgba(247, 248, 251, .82);
      backdrop-filter: blur(14px);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: .7rem;
      color: var(--ink);
      font-size: 1rem;
      font-weight: 700;
    }

    .mark {
      display: grid;
      place-items: center;
      width: 2.05rem;
      height: 2.05rem;
      border: 1px solid var(--ink);
      background: var(--paper);
    }

    .mark svg { display: block; }

    .nav {
      display: flex;
      align-items: center;
      gap: .35rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .nav a {
      border: 1px solid transparent;
      padding: .62rem .75rem;
    }

    .nav a:hover {
      border-color: var(--line-dark);
      color: var(--ink);
      background: rgba(255,255,255,.65);
    }

    .nav .docs {
      border-color: var(--line-dark);
      color: var(--ink);
      background: rgba(255,255,255,.78);
    }

    .nav .start {
      border-color: var(--ink);
      background: var(--ink);
      color: white;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, .9fr) minmax(31rem, 1.1fr);
      gap: clamp(2rem, 5vw, 4.8rem);
      align-items: start;
      padding: clamp(3.2rem, 6vw, 5rem) 0 clamp(2.2rem, 5vw, 4rem);
    }

    .yc {
      display: inline-flex;
      align-items: center;
      gap: .48rem;
      margin-bottom: 1.15rem;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--muted);
      padding: .42rem .55rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .yc b {
      display: inline-grid;
      place-items: center;
      width: 1.15rem;
      height: 1.15rem;
      background: var(--blue);
      color: white;
      font-family: "IBM Plex Sans", ui-sans-serif, sans-serif;
      font-size: .75rem;
      line-height: 1;
    }

    .hero h1 {
      margin: 0;
      max-width: 11ch;
      color: var(--ink);
      font-size: clamp(2.85rem, 4.8vw, 4.85rem);
      line-height: 1;
      font-weight: 600;
      letter-spacing: 0;
    }

    .hero h1 span {
      color: var(--blue);
    }

    .hero p {
      margin: 1.25rem 0 0;
      max-width: 34rem;
      color: var(--muted);
      font-size: clamp(1.03rem, 1.45vw, 1.18rem);
      line-height: 1.6;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: .72rem;
      margin-top: 1.55rem;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.9rem;
      border: 1px solid var(--ink);
      padding: .72rem 1rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .82rem;
      font-weight: 700;
      text-transform: uppercase;
      white-space: nowrap;
      transition: transform .15s ease, background .15s ease;
    }

    .button:active { transform: translateY(1px); }
    .button.primary { background: var(--ink); color: white; }
    .button.primary:hover { background: #000; }
    .button.secondary { background: var(--paper); color: var(--ink); }
    .button.secondary:hover { background: #eef1f6; }

    .fine-print {
      margin-top: 1rem;
      color: var(--quiet);
      font-size: .9rem;
    }

    .hero-product {
      display: grid;
      gap: 1rem;
    }

    .code-window,
    .live-window {
      border: 1px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--shadow);
    }

    .code-tabs {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--line-dark);
    }

    .tabs {
      display: flex;
      min-width: 0;
    }

    .tab {
      border-right: 1px solid var(--line);
      padding: .78rem .9rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
    }

    .tab.active {
      color: var(--ink);
      background: var(--blue-soft);
      box-shadow: inset 0 -2px 0 var(--blue);
    }

    .copy-button {
      margin-right: .75rem;
      border: 1px solid var(--line-dark);
      background: var(--paper);
      color: var(--ink);
      cursor: pointer;
      padding: .34rem .48rem;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .7rem;
      font-weight: 700;
    }

    .code-window pre {
      margin: 0;
      min-height: 16rem;
      overflow-x: auto;
      padding: 1.25rem;
      color: #1f2937;
      font-size: .9rem;
      line-height: 1.72;
      white-space: pre-wrap;
    }

    .kw { color: var(--blue); font-weight: 700; }
    .str { color: var(--green); }
    .dim { color: var(--quiet); }

    .live-window {
      display: grid;
      grid-template-columns: .92fr 1.08fr;
      min-height: 12rem;
      box-shadow: 0 16px 50px rgba(15, 23, 42, .08);
    }

    .live-head {
      grid-column: 1 / -1;
      border-bottom: 1px solid var(--line-dark);
      padding: .78rem .9rem;
      color: var(--muted);
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .76rem;
      font-weight: 700;
    }

    .packet {
      border-right: 1px solid var(--line);
      padding: .9rem;
    }

    .packet b {
      display: block;
      max-width: 14rem;
      color: var(--ink);
      font-size: 1rem;
      line-height: 1.2;
    }

    .packet span {
      display: block;
      margin-top: .45rem;
      color: var(--muted);
      font-size: .82rem;
      line-height: 1.4;
    }

    .proof {
      display: grid;
      gap: .62rem;
      padding: .9rem;
    }

    .proof-row {
      display: grid;
      grid-template-columns: 3.7rem 1fr;
      gap: .6rem;
      align-items: start;
      border-bottom: 1px solid var(--line);
      padding-bottom: .62rem;
    }

    .proof-row:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }

    .proof-row code {
      color: var(--blue);
      font-size: .7rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    .proof-row strong {
      display: block;
      color: var(--ink);
      font-size: .86rem;
      line-height: 1.25;
    }

    .proof-row small {
      display: block;
      margin-top: .16rem;
      color: var(--muted);
      font-size: .76rem;
      line-height: 1.35;
    }

    .logos {
      margin-top: 2rem;
      color: var(--muted);
      text-align: center;
      font-size: .98rem;
    }

    .logo-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      margin-top: .9rem;
    }

    .logo {
      border-right: 1px solid var(--line);
      padding: 1.15rem .6rem;
      color: var(--ink);
      font-weight: 700;
      opacity: .66;
    }

    .logo:last-child { border-right: 0; }

    .section {
      padding: clamp(3rem, 7vw, 5.5rem) 0;
      border-top: 1px solid var(--line);
      background: rgba(255,255,255,.42);
    }

    .section-head {
      display: grid;
      grid-template-columns: .78fr .58fr;
      gap: 2rem;
      align-items: end;
      margin-bottom: 1.6rem;
    }

    .section h2 {
      margin: 0;
      max-width: 13ch;
      color: var(--ink);
      font-size: clamp(2rem, 3.8vw, 3.25rem);
      line-height: 1.04;
      font-weight: 600;
      letter-spacing: 0;
    }

    .section-head p {
      margin: 0;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.62;
    }

    .offer {
      display: grid;
      grid-template-columns: .72fr 1.28fr;
      border: 1px solid var(--ink);
      background: var(--paper);
    }

    .offer-nav {
      border-right: 1px solid var(--ink);
    }

    .offer-item {
      border-bottom: 1px solid var(--line);
      padding: 1rem;
      color: var(--muted);
      font-weight: 700;
    }

    .offer-item.active {
      color: var(--ink);
      background: var(--blue-soft);
    }

    .offer-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      padding: 1rem;
    }

    .offer-copy h3 {
      margin: 0;
      color: var(--ink);
      font-size: 1.35rem;
      line-height: 1.2;
    }

    .offer-copy p {
      margin: .65rem 0 0;
      color: var(--muted);
      line-height: 1.55;
    }

    .contract-card {
      border: 1px solid var(--line-dark);
      background: #fbfcff;
      padding: .9rem;
    }

    .contract-card h4 {
      margin: 0;
      color: var(--ink);
      line-height: 1.22;
    }

    .contract-line {
      height: .5rem;
      border-radius: 999px;
      background: #dfe5ef;
      margin-top: .58rem;
    }

    .contract-line:nth-child(3) { width: 88%; }
    .contract-line:nth-child(4) { width: 74%; }
    .contract-line:nth-child(5) { width: 92%; }

    .numbers {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      border: 1px solid var(--ink);
      background: var(--ink);
    }

    .metric {
      background: var(--paper);
      padding: 1.25rem;
    }

    .metric b {
      display: block;
      color: var(--ink);
      font-size: clamp(1.65rem, 3vw, 2.55rem);
      line-height: 1;
      letter-spacing: 0;
    }

    .metric span {
      display: block;
      margin-top: .5rem;
      color: var(--muted);
      font-size: .92rem;
      line-height: 1.45;
    }

    .dark {
      background: var(--dark);
      color: white;
    }

    .dark .section {
      background: transparent;
      border-top-color: rgba(255,255,255,.12);
    }

    .dark h2 { color: white; }
    .dark .section-head p { color: #aeb8c9; }

    .cli-grid {
      display: grid;
      grid-template-columns: 1.05fr .95fr;
      gap: 1rem;
    }

    .dark-code,
    .use-case {
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.045);
    }

    .dark-code {
      overflow: hidden;
      background: #0f172a;
    }

    .dark-code header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      border-bottom: 1px solid rgba(255,255,255,.14);
      padding: .82rem .95rem;
      color: #aeb8c9;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: .74rem;
      font-weight: 700;
    }

    .dark-code pre {
      margin: 0;
      padding: 1rem;
      color: #eef2ff;
      font-size: .82rem;
      line-height: 1.65;
      white-space: pre-wrap;
      overflow-x: auto;
    }

    .use-cases {
      display: grid;
      gap: .75rem;
    }

    .use-case {
      padding: 1rem;
    }

    .use-case b {
      display: block;
      color: white;
      font-size: .98rem;
    }

    .use-case span {
      display: block;
      margin-top: .34rem;
      color: #aeb8c9;
      font-size: .88rem;
      line-height: 1.5;
    }

    .faq-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      border: 1px solid var(--ink);
      background: var(--paper);
    }

    .faq {
      min-height: 9rem;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      padding: 1rem;
    }

    .faq:nth-child(2n) { border-right: 0; }
    .faq:nth-last-child(-n + 2) { border-bottom: 0; }

    .faq h3 {
      margin: 0;
      color: var(--ink);
      font-size: 1.02rem;
    }

    .faq p {
      margin: .5rem 0 0;
      color: var(--muted);
      font-size: .9rem;
      line-height: 1.5;
    }

    .final {
      display: grid;
      grid-template-columns: .85fr 1.15fr;
      gap: 2rem;
      align-items: center;
      padding: clamp(3rem, 7vw, 5.4rem) 0;
      border-top: 1px solid var(--line);
    }

    .final h2 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(2rem, 3.8vw, 3.25rem);
      line-height: 1.04;
      font-weight: 600;
    }

    .final p {
      margin: .9rem 0 0;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.58;
    }

    .cta {
      border: 1px solid var(--ink);
      background: var(--paper);
      padding: 1rem;
    }

    .cta code {
      display: block;
      border: 1px solid var(--line);
      background: #fbfcff;
      color: var(--ink);
      padding: .9rem;
      font-size: .84rem;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .footer {
      border-top: 1px solid var(--line);
      background: var(--paper);
      color: var(--muted);
      padding: 1.5rem 0;
      font-size: .88rem;
    }

    .footer-inner {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .footer a {
      color: var(--ink);
      font-weight: 700;
    }

    @media (max-width: 980px) {
      .nav { display: none; }
      .hero,
      .section-head,
      .offer,
      .offer-body,
      .cli-grid,
      .final {
        grid-template-columns: 1fr;
      }
      .hero { min-height: auto; }
      .offer-nav { border-right: 0; border-bottom: 1px solid var(--ink); }
      .live-window { grid-template-columns: 1fr; }
      .packet { border-right: 0; border-bottom: 1px solid var(--line); }
      .logo-grid { grid-template-columns: repeat(2, 1fr); }
      .logo { border-bottom: 1px solid var(--line); }
      .numbers { grid-template-columns: 1fr; }
    }

    @media (max-width: 620px) {
      .shell { width: min(100% - 1rem, 1180px); }
      .notice { font-size: .76rem; }
      .topbar { min-height: 3.8rem; }
      .hero { padding: 2.2rem 0; }
      .hero h1 { font-size: 2.65rem; }
      .actions .button { width: 100%; }
      .tabs { overflow-x: auto; }
      .tab { padding: .68rem .72rem; }
      .code-window pre,
      .dark-code pre,
      .cta code {
        font-size: .72rem;
      }
      .logo-grid,
      .faq-grid {
        grid-template-columns: 1fr;
      }
      .faq,
      .faq:nth-child(2n),
      .faq:nth-last-child(-n + 2) {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .faq:last-child { border-bottom: 0; }
      .section h2,
      .final h2 {
        font-size: 2.15rem;
      }
    }
  </style>
</head>
<body>
  <div class="notice">AgentContract is for <strong>sending</strong> approved contracts from agent workflows. People still sign in the browser. <a href="/cli">Install the CLI</a></div>

  <header class="shell topbar">
    <a class="brand" href="/" aria-label="AgentContract home">
      <span class="mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M7 3.8h7.5L18 7.3v12.9H7V3.8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14.2 4.1v3.4h3.4M9.8 11h4.8M9.8 14h4.2M9.8 17h3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      AgentContract
    </a>
    <nav class="nav" aria-label="Primary navigation">
      <a href="#offer">Enterprise</a>
      <a href="#scale">Proof</a>
      <a href="#api">API</a>
      <a href="/templates">Templates</a>
      <a class="docs" href="/cli">Docs</a>
      <a class="start" href="/dashboard">Dashboard</a>
    </nav>
  </header>

  <main>
    <section class="shell hero">
      <div>
        <div class="yc"><b>A</b> For agent-run onboarding</div>
        <h1>Agents send contracts. <span>People sign.</span></h1>
        <p>AgentContract lets an AI agent send an approved NDA, privacy acknowledgement, or contractor agreement. The recipient signs in the browser. Your app gets the signed PDF, hash, webhook, and audit trail.</p>
        <div class="actions">
          <a class="button primary" href="/cli">Start with CLI</a>
          <a class="button secondary" href="/templates">View templates</a>
        </div>
        <div class="fine-print">Agents do not sign. Agents do not write legal terms. They only send approved packets.</div>
      </div>

      <div class="hero-product" aria-label="AgentContract product preview">
        <div class="code-window">
          <div class="code-tabs">
            <div class="tabs" aria-label="Code examples">
              <div class="tab active">CLI</div>
              <div class="tab">cURL</div>
              <div class="tab">TypeScript</div>
              <div class="tab">Webhook</div>
            </div>
            <button class="copy-button" type="button" data-copy="${escapeHtml(installCommand)}">Copy</button>
          </div>
          <pre><code><span class="kw">$</span> agentcontract marketplace-onboard \\
  --to jane@example.com \\
  --name <span class="str">"Jane Contributor"</span> \\
  --cc legal@example.com

<span class="dim">sent</span> agr_7ks9p2p8a4qv
<span class="dim">signing_url</span> ${safeOrigin}/sign/...
<span class="dim">status</span> waiting_on_recipient</code></pre>
        </div>

        <div class="live-window">
          <div class="live-head">Live Agreement</div>
          <div class="packet">
            <b>Acme Marketplace Privacy Acknowledgement</b>
            <span>Recipient: Jane Contributor</span>
            <span>Status: waiting on recipient signature</span>
          </div>
          <div class="proof">
            <div class="proof-row">
              <code>Send</code>
              <div><strong>Agent sent approved packet</strong><small>Template and required fields locked.</small></div>
            </div>
            <div class="proof-row">
              <code>Sign</code>
              <div><strong>Recipient signs in browser</strong><small>ESIGN consent and timestamp captured.</small></div>
            </div>
            <div class="proof-row">
              <code>Store</code>
              <div><strong>Signed PDF archived</strong><small>PDF bytes and SHA-256 hash saved.</small></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="shell logos" aria-label="Use cases">
      <p>Built for the agent workflows where paperwork blocks the next step.</p>
      <div class="logo-grid">
        <div class="logo">Onboarding</div>
        <div class="logo">Marketplaces</div>
        <div class="logo">Contractors</div>
        <div class="logo">Compliance</div>
        <div class="logo">Internal Ops</div>
      </div>
    </section>

    <section class="shell section" id="offer">
      <div class="section-head">
        <h2>What AgentContract does.</h2>
        <p>It gives agents a controlled way to send approved contracts. Humans stay responsible for signing, and your system keeps the record.</p>
      </div>
      <div class="offer">
        <div class="offer-nav">
          <div class="offer-item active">Approved template API</div>
          <div class="offer-item">Recipient signing pages</div>
          <div class="offer-item">Signed PDF storage</div>
          <div class="offer-item">Webhooks and audit</div>
        </div>
        <div class="offer-body">
          <div class="offer-copy">
            <h3>Approved packets in. Signed records out.</h3>
            <p>Agents fill known variables, send signing links, track status, and report outcomes without drafting or changing legal language.</p>
          </div>
          <div class="contract-card">
            <h4>Acme Marketplace Privacy Acknowledgement</h4>
            <div class="contract-line"></div>
            <div class="contract-line"></div>
            <div class="contract-line"></div>
            <div class="contract-line"></div>
          </div>
        </div>
      </div>
    </section>

    <section class="shell section" id="scale">
      <div class="section-head">
        <h2>Built for repeatable contract sends.</h2>
        <p>Start with one agent sending one agreement. Use the same API and audit trail when the workflow repeats across contributors, contractors, and customers.</p>
      </div>
      <div class="numbers">
        <div class="metric">
          <b>1</b>
          <span>command to send a real contract from a local agent workflow.</span>
        </div>
        <div class="metric">
          <b>SHA-256</b>
          <span>hashes stored with signed PDFs for later verification.</span>
        </div>
        <div class="metric">
          <b>API</b>
          <span>for creating agreements, checking status, fetching PDFs, and receiving webhooks.</span>
        </div>
      </div>
    </section>

    <div class="dark" id="api">
      <section class="shell section">
        <div class="section-head">
          <h2>Give your agent a send command.</h2>
          <p>The dashboard is for humans. The CLI and API are for agents, scripts, and backend workflows that need to send approved contracts.</p>
        </div>
        <div class="cli-grid">
          <div class="dark-code">
            <header>
              <span>quickstart</span>
              <button class="copy-button" type="button" data-copy="${escapeHtml(installCommand)}">Copy</button>
            </header>
            <pre><code>${escapeHtml(installCommand)}
agentcontract login --email you@example.com --api-url ${safeOrigin}
agentcontract skill
agentcontract marketplace-onboard --to jane@example.com --name "Jane Contributor"</code></pre>
          </div>
          <div class="use-cases">
            <div class="use-case">
              <b>Read before sending</b>
              <span>Agents can inspect exact contract text and dry-run sends before an email goes out.</span>
            </div>
            <div class="use-case">
              <b>Track without the dashboard</b>
              <span>List agreements, read audit events, remind signers, cancel stale packets, and download PDFs.</span>
            </div>
            <div class="use-case">
              <b>Report failures immediately</b>
              <span>Feedback works before login, so install and auth issues still get captured.</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <section class="shell section">
      <div class="section-head">
        <h2>Questions people ask first.</h2>
        <p>The most important distinction is simple: AgentContract lets agents send contracts. It does not make agents legal signers.</p>
      </div>
      <div class="faq-grid">
        <div class="faq">
          <h3>Do agents sign contracts?</h3>
          <p>No. Agents prepare approved packets and send signing links. Recipients and required human parties sign in the browser.</p>
        </div>
        <div class="faq">
          <h3>Can I use custom templates?</h3>
          <p>Yes. The API supports approved markdown templates, variables, required fields, metadata, and webhook URLs.</p>
        </div>
        <div class="faq">
          <h3>What gets stored?</h3>
          <p>Status, structured signer fields, audit events, signed PDF bytes, PDF hashes, and completion timestamps.</p>
        </div>
        <div class="faq">
          <h3>Is this only a dashboard?</h3>
          <p>No. AgentContract is CLI/API-first, with a dashboard for inspection, sender workflows, and API key management.</p>
        </div>
      </div>
    </section>

    <section class="shell final">
      <div>
        <h2>Let an agent send the next contract.</h2>
        <p>Install the CLI, log in with an email code, and give your local agent a simple contract-sending workflow.</p>
      </div>
      <div class="cta">
        <code>${escapeHtml(installCommand)}</code>
        <div class="actions">
          <a class="button primary" href="/cli">Set up CLI</a>
          <a class="button secondary" href="/templates">Open templates</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="shell footer-inner">
      <span>AgentContract turns agent-sent paperwork into signed records.</span>
      <span>Contact: <a href="mailto:janak@withspecific.com">janak@withspecific.com</a></span>
      <span><a href="/cli">CLI</a> · <a href="/dashboard">Dashboard</a> · <a href="/healthz">Status</a></span>
    </div>
  </footer>

  <script>
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const value = button.getAttribute("data-copy") || "";
        const original = button.textContent;
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = "Copied";
          setTimeout(() => { button.textContent = original; }, 1300);
        } catch {
          button.textContent = "Select";
          setTimeout(() => { button.textContent = original; }, 1300);
        }
      });
    });
  </script>
</body>
</html>`;
}

site.get("/", (c) => {
  const origin = new URL(c.req.url).origin;
  if (wantsJson(c.req.header("accept") ?? "", c.req.query("format"))) return c.json(cliVersionMetadata(origin));
  return c.html(homePage(origin));
});

site.get("/templates", (c) => c.html(renderPublicTemplatesPage(new URL(c.req.url).origin)));

for (const id of publicTemplateIds) {
  site.get(`/templates/${id}`, (c) => c.html(renderPublicTemplatePage(new URL(c.req.url).origin, id)));
}

for (const page of publicSeoPages) {
  site.get(page.path, (c) => c.html(renderSeoPage(page)));
}

site.get("/healthz", (c) => c.json(cliVersionMetadata(new URL(c.req.url).origin)));

site.get("/robots.txt", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(robotsTxt(origin), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  });
});

site.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  return new Response(sitemapXml(origin), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
});

site.get("/llms.txt", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(llmsTxt(origin), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  });
});
