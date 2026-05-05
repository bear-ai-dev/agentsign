import assert from "node:assert/strict";
import test from "node:test";

import { cli } from "../src/routes/cli.js";
import { site } from "../src/routes/site.js";

function jsonLdBlocks(html: string) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1] ?? "{}") as Record<string, unknown>);
}

test("root renders crawlable SEO metadata for the marketing page", async () => {
  const response = await site.request("https://agentcontract.to/");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /<title>AgentContract \| Contract signing API and CLI for AI agents<\/title>/);
  assert.match(html, /<meta name="description" content="AgentContract is a contract signing API and CLI that lets AI agents send approved NDAs, privacy acknowledgements, and contractor agreements for human e-signature\." \/>/);
  assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/agentcontract\.to\/" \/>/);
  assert.match(html, /<link rel="alternate" type="text\/plain" href="https:\/\/agentcontract\.to\/llms\.txt" title="llms\.txt" \/>/);
  assert.match(html, /<meta property="og:type" content="website" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/agentcontract\.to\/" \/>/);
  assert.match(html, /<meta property="og:title" content="AgentContract \| Contract signing API and CLI for AI agents" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary" \/>/);
});

test("root footer includes the contact email", async () => {
  const response = await site.request("https://agentcontract.to/");
  const html = await response.text();

  assert.match(html, /<footer class="footer">[\s\S]*href="mailto:janak@withspecific\.com"[\s\S]*janak@withspecific\.com[\s\S]*<\/footer>/);
});

test("root exposes brand and service structured data without unsupported FAQ markup", async () => {
  const response = await site.request("https://agentcontract.to/");
  const html = await response.text();
  const blocks = jsonLdBlocks(html);
  const graph = blocks.flatMap((block) => Array.isArray(block["@graph"]) ? block["@graph"] as Array<Record<string, unknown>> : [block]);
  const types = graph.map((item) => item["@type"]);

  assert.ok(types.includes("Organization"));
  assert.ok(types.includes("WebSite"));
  assert.ok(types.includes("Service"));
  assert.ok(!types.includes("FAQPage"));

  const service = graph.find((item) => item["@type"] === "Service");
  assert.equal(service?.name, "AgentContract");
  assert.equal(service?.serviceType, "Contract signing API and CLI for AI agents");
});

test("robots.txt points crawlers to the sitemap and keeps private workflows out", async () => {
  const response = await site.request("https://agentcontract.to/robots.txt");
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(body, /^User-agent: \*/m);
  assert.match(body, /^Allow: \/$/m);
  assert.match(body, /^Disallow: \/dashboard\/$/m);
  assert.match(body, /^Disallow: \/sign\/$/m);
  assert.match(body, /^Disallow: \/v1\/$/m);
  assert.doesNotMatch(body, /^Disallow: \/templates\/$/m);
  assert.match(body, /^Sitemap: https:\/\/agentcontract\.to\/sitemap\.xml$/m);
});

test("sitemap.xml lists public indexable pages with canonical URLs", async () => {
  const response = await site.request("https://agentcontract.to/sitemap.xml");
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/xml/);
  assert.match(body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/cli<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/templates<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/templates\/mutual-nda<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/templates\/one-way-nda<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/templates\/privacy-policy<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/ai-agent-contracts<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/contract-sending-api<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/agent-contract-cli<\/loc>/);
  assert.match(body, /<loc>https:\/\/agentcontract\.to\/esignature-for-ai-agents<\/loc>/);
  assert.doesNotMatch(body, /dashboard/);
  assert.doesNotMatch(body, /sign\//);
});

test("public SEO pages target AI-agent contract search intents", async () => {
  const pages = [
    {
      path: "/ai-agent-contracts",
      title: "AI Agent Contracts | AgentContract",
      h1: "AI agent contracts that humans still control",
      phrase: "contracts for AI agents"
    },
    {
      path: "/contract-sending-api",
      title: "Contract Sending API for AI Agents | AgentContract",
      h1: "Contract sending API for agent workflows",
      phrase: "send approved contracts from an AI agent"
    },
    {
      path: "/agent-contract-cli",
      title: "Agent Contract CLI | AgentContract",
      h1: "Agent contract CLI for local AI workflows",
      phrase: "agentcontract CLI"
    },
    {
      path: "/esignature-for-ai-agents",
      title: "E-signature for AI Agents | AgentContract",
      h1: "E-signature for AI agents, with people in the signing loop",
      phrase: "e-signature for AI agents"
    }
  ];

  for (const page of pages) {
    const response = await site.request(`https://agentink-pied.vercel.app${page.path}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, new RegExp(`<title>${page.title.replaceAll("|", "\\|")}<\\/title>`));
    assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large" \/>/);
    assert.match(html, new RegExp(`<link rel="canonical" href="https:\\/\\/agentcontract\\.to${page.path}" \\/>`));
    assert.match(html, new RegExp(`<h1>${page.h1}<\\/h1>`));
    assert.match(html, new RegExp(page.phrase, "i"));
    assert.match(html, /href="\/cli"/);
  }
});

test("public canonical metadata uses the primary domain on preview hosts", async () => {
  const response = await site.request("https://agentink-pied.vercel.app/");
  const html = await response.text();

  assert.match(html, /<link rel="canonical" href="https:\/\/agentcontract\.to\/" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/agentcontract\.to\/" \/>/);
});

test("llms.txt summarizes the public agent-facing documentation", async () => {
  const response = await site.request("https://agentcontract.to/llms.txt");
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(body, /^# AgentContract$/m);
  assert.match(body, /^> Contract signing API and CLI for AI agents\./m);
  assert.match(body, /- \[Homepage\]\(https:\/\/agentcontract\.to\/\):/);
  assert.match(body, /- \[CLI docs\]\(https:\/\/agentcontract\.to\/cli\):/);
  assert.match(body, /- \[Template library\]\(https:\/\/agentcontract\.to\/templates\):/);
  assert.match(body, /- \[CLI installer\]\(https:\/\/agentcontract\.to\/cli\/install\.sh\):/);
  assert.match(body, /Agents send approved packets only; humans sign contracts in the browser\./);
  assert.doesNotMatch(body, /dashboard/);
  assert.doesNotMatch(body, /sign\//);
});

test("public template library and previews are crawlable without dashboard auth", async () => {
  const listResponse = await site.request("https://agentcontract.to/templates");
  const listHtml = await listResponse.text();

  assert.equal(listResponse.status, 200);
  assert.match(listHtml, /<title>Standard Legal Templates \| AgentContract<\/title>/);
  assert.match(listHtml, /href="\/templates\/mutual-nda"/);
  assert.match(listHtml, /href="\/templates\/one-way-nda"/);
  assert.match(listHtml, /href="\/templates\/privacy-policy"/);
  assert.match(listHtml, /Template only, not legal advice/);

  const detailResponse = await site.request("https://agentcontract.to/templates/privacy-policy");
  const detailHtml = await detailResponse.text();

  assert.equal(detailResponse.status, 200);
  assert.match(detailHtml, /<title>Standard Website\/App Privacy Policy \| AgentContract Templates<\/title>/);
  assert.match(detailHtml, /agentcontract template read privacy-policy/);
  assert.match(detailHtml, /FTC consumer privacy guidance/);
  assert.match(detailHtml, /<h1>Privacy Policy<\/h1>/);
});

test("CLI docs page has its own indexable search metadata", async () => {
  const response = await cli.request("https://agentink-pied.vercel.app/cli");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<title>AgentContract CLI \| Send contracts from local AI agents<\/title>/);
  assert.match(html, /<meta name="description" content="Install the AgentContract CLI to send approved contracts, inspect templates, track agreements, and report failures from local AI agent workflows\." \/>/);
  assert.match(html, /<meta name="robots" content="index,follow" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/agentcontract\.to\/cli" \/>/);
});
