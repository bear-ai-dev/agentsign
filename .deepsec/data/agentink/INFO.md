# agentink

## What this codebase does

The repository ships AgentContract, a Node.js/Hono contract-sending service, public website, browser signing flow, and agent-oriented CLI backed by SQLite or Postgres.

- Public HTTP routes serve product pages, documentation, health metadata, CLI installers, and package tarballs.
- Bearer-authenticated `/v1` APIs create, bulk-send, inspect, remind, cancel, and download agreements; they also manage templates, API keys, and agent-session telemetry.
- Browser routes provide email-code or WorkOS login, an authenticated sender dashboard, and API-key management.
- Public capability URLs let recipients or senders preview, sign, and download completed agreements using high-entropy signing tokens.
- The CLI is the agent-facing tool surface; outbound signed webhooks use a database-backed retry queue and an in-process interval worker. There is no inbound webhook handler or configured cron surface.

## Auth shape

Authentication is split between API bearer keys, browser sessions, one-time login codes, and unguessable signing-link capabilities.

- `requireApiKey` accepts either the environment bootstrap key or a SHA-256-hashed stored API key; stored keys place `apiKeyRecord` on the Hono context.
- User-owned API keys scope agreements, sessions, feedback, and key management by `owner_email`; the bootstrap key intentionally has global access, including ownerless records.
- `requireAdminSession` accepts a signed 30-day email session cookie or a WorkOS sealed session. Cookies are HTTP-only, SameSite=Lax, and Secure when the request URL is HTTPS.
- Email and CLI login codes are hashed, expire after five minutes, and are atomically marked used before a new API key is returned.
- Signing and preview routes use `signing_token` or `sender_signing_token` as bearer capabilities rather than account sessions; anyone possessing the relevant URL can exercise that signer role.

## Threat model

The main trust boundaries are public login/signing traffic, agent-controlled API input, browser sessions, stored contract data, and outbound integrations.

- Public email-code start/verify, feedback submission, signing, PDF rendering, and installer routes are abuse targets; no application-level rate limiting or attempt counters were found in the inspected code.
- Authenticated callers can supply raw Markdown, field schemas, recipient addresses, metadata, bulk recipient lists, and webhook URLs, making stored HTML/PDF rendering and outbound delivery high-value validation boundaries.
- Agreement Markdown is rendered through `marked` and inserted into signing HTML and headless Chromium; active HTML, remote resource loading, stored XSS, and renderer-side network access deserve focused review.
- Arbitrary per-agreement webhook URLs are fetched by the server and retried without an observed URL allowlist, private-address check, redirect policy, or request timeout, creating an SSRF and resource-exhaustion boundary.
- Signing tokens, API keys, webhook secrets, signed fields, audit IP/user-agent data, and base64 PDFs are sensitive capabilities or PII; concurrency around duplicate signing, completion emails, audit events, and webhook enqueueing should also be tested.

## Project-specific patterns to flag

Review these concrete patterns before broad generic findings.

- Trace every `marked.parse` result into browser HTML and Puppeteer `page.setContent`; template substitution itself is plain string replacement and does not provide HTML sanitization.
- Trace `webhook_url` from agreement creation into `fetch(delivery.url)`, including redirects, DNS rebinding, local/cloud metadata destinations, retry amplification, and PII-bearing payloads.
- Check nullable `owner_email` behavior carefully: owned keys are tenant-scoped, while the environment bootstrap key and ownerless records intentionally bypass tenant filtering.
- Review public six-digit email-code endpoints, long-lived email-session cookies, dashboard POST routes without explicit CSRF tokens, and trust in forwarded IP headers.
- Review default-secret behavior and secret propagation: the development bootstrap key has a hard-coded fallback, email-cookie signing can fall back to that key, and webhook secrets are stored and returned with agreement data.

## Known false-positives

These implementation details can make naïve scanners noisy.

- Database request values are passed as query parameters; dynamic SQL fragments in inspected routes are constructed from fixed column names, fixed clauses, or server-selected placeholders rather than raw request strings.
- API keys and login codes are stored as SHA-256 hashes, and full API keys are returned only at creation or successful login exchange; prefixes and last-four values are intentionally display metadata.
- Template file access is allowlisted by `templateNames`, and CLI contract IDs are restricted before being joined into local paths; operator-selected CLI input/output paths are local CLI behavior, not remote HTTP traversal by themselves.
- Most server-generated HTML interpolations use local `escapeHtml` helpers. Raw agreement Markdown rendered by `marked` is the important exception and should not be dismissed with the surrounding escaped fields.
- `X-AgentInk-Signature` is for outbound callbacks over the exact stored JSON payload. The repository has no inbound webhook receiver, so missing inbound signature middleware is not itself a finding.
