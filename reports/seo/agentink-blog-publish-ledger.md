# AgentInk / AgentContract SEO Blog Publish Ledger

Date: 2026-06-05

## Current goal

Research, write, publish, and request indexing for 15 GEO/SEO optimized AgentContract blog posts.

## Artifacts

- DataForSEO research: `reports/seo/agentink-dataforseo-research.json`
- Blog queue summary: `reports/seo/agentink-blog-plan.md`
- Indexing/API report: `reports/seo/agentink-indexing-results.json`
- Manual Search Console links: `reports/seo/agentink-search-console-inspection-links.md`
- Visual QA screenshots: `reports/seo/screenshots/`
- Production deploy: `https://agentcontract.to`
- Vercel deployment: `https://agentink-r1p2pou0h-siddhant-paliwals-projects.vercel.app`

## Published posts

1. `https://agentcontract.to/blog/esignature-api-for-ai-agent-workflows`
2. `https://agentcontract.to/blog/contract-signing-api-checklist`
3. `https://agentcontract.to/blog/document-signing-api-vs-dashboard`
4. `https://agentcontract.to/blog/api-to-send-documents-for-signature`
5. `https://agentcontract.to/blog/docusign-api-alternative-for-agent-workflows`
6. `https://agentcontract.to/blog/contract-automation-software-for-repeatable-packets`
7. `https://agentcontract.to/blog/contract-management-api-for-small-teams`
8. `https://agentcontract.to/blog/vendor-onboarding-process-contracts`
9. `https://agentcontract.to/blog/marketplace-onboarding-contract-workflow`
10. `https://agentcontract.to/blog/contractor-agreement-template-agent-workflow`
11. `https://agentcontract.to/blog/mutual-nda-template-before-you-send`
12. `https://agentcontract.to/blog/one-way-nda-template-sales-demos-contractors`
13. `https://agentcontract.to/blog/privacy-policy-template-for-marketplace-onboarding`
14. `https://agentcontract.to/blog/ai-agent-contracts-operating-model`
15. `https://agentcontract.to/blog/human-in-the-loop-ai-contract-signing`

## Verification completed

- DataForSEO keyword/search-volume research completed.
- `npx tsx --test tests/*.test.ts` passed: 29/29 tests.
- `npm run build` passed.
- Production deploy completed and aliased to `https://agentcontract.to`.
- Production `curl` verified 200, canonical URL, BlogPosting JSON-LD, keyword badge, and source links for the first new post.
- Production sitemap includes the new post URLs.
- Desktop and mobile screenshots verified with local Chrome/Puppeteer fallback because Codex-in-Chrome MCP was unavailable.
- Search Console URL Inspection API succeeded for all 15 new URLs under `sc-domain:agentcontract.to`.

## Indexing blocker

The Search Console "Request indexing" UI is blocked on Chrome Google sign-in.

API attempts:

- Google Indexing API with `GOOGLE_SERVICE_ACCOUNT_JSON`: failed with `invalid_grant: Invalid JWT Signature`, likely stale or revoked service-account key.
- Google Indexing API with existing GSC OAuth refresh token: failed with `403 Insufficient Permission`.
- Search Console sitemap submit with existing OAuth token: failed with `403 Insufficient Permission`.
- Search Console URL Inspection API: succeeded for all 15 URLs.

Continuation attempt on 2026-06-05:

- Production was rechecked: all 15 URLs returned 200 with canonical URLs, indexable robots metadata, BlogPosting JSON-LD, and sitemap inclusion.
- Codex-in-Chrome MCP was still unavailable, so Chrome/computer-use fallback was attempted.
- Chrome still showed the Janak account signed out at the Google account chooser.
- `computer_use.click` refused to interact after state capture, and macOS `osascript` / `cliclick` click fallback was blocked by missing Accessibility privileges.
- Existing service-account JSON parses correctly, but token acquisition fails with `invalid_grant: Invalid JWT Signature`.
- Existing GSC OAuth can list sites and inspect URLs, but cannot write indexing/sitemap actions.
- Search Console already lists `https://agentcontract.to/sitemap.xml` with 0 errors/warnings, last submitted on 2026-05-08, but its submitted count has not refreshed to the expanded sitemap yet.

Final unblock audit on 2026-06-05:

- Production was rechecked again: all 15 post URLs returned 200, had canonical URLs, indexable robots tags, BlogPosting JSON-LD, and sitemap inclusion.
- Existing GSC OAuth token scope is exactly `https://www.googleapis.com/auth/webmasters.readonly`, proving the current refresh token cannot perform write actions.
- Local credential search found no alternate Search Console write credential.
- `Bear/Blogs/token.pickle` is spreadsheets-only.
- `Bear/Blogs/credentials.json` is an OAuth client, not a service-account key.
- Existing `GOOGLE_SERVICE_ACCOUNT_JSON` still fails at token acquisition with `invalid_grant: Invalid JWT Signature`.
- UI route remains inaccessible: Codex-in-Chrome MCP is unavailable; Chrome showed the account chooser signed out; `computer_use` click could not interact; macOS `osascript` / `cliclick` are blocked by missing Accessibility privileges; latest computer-use state returned `cgWindowNotFound`.

## Resume action

Sign into Chrome as the Search Console owner account, then open each URL Inspection link in `reports/seo/agentink-search-console-inspection-links.md` and click "Request indexing".

Direct first URL:

`https://search.google.com/search-console/inspect?resource_id=sc-domain%3Aagentcontract.to&id=https%3A%2F%2Fagentcontract.to%2Fblog%2Fesignature-api-for-ai-agent-workflows`

Alternative API fix:

1. Create a fresh Google service-account key for `usebear-blog-automation`.
2. Confirm the service account has access to `sc-domain:agentcontract.to` in Search Console.
3. Replace `GOOGLE_SERVICE_ACCOUNT_JSON` in `/Users/janaksunil/Documents/Bear-GEO/.env.local`.
4. Rerun the indexing request script from this session or adapt `reports/seo/agentink-indexing-results.json` URL list.
