---
name: agentcontract-marketplace-onboarding
description: Use AgentContract to preview, send, and track marketplace onboarding contracts, privacy acknowledgements, MNDAs, and contractor agreements from an API-first CLI.
---

# AgentContract Marketplace Onboarding

Use this skill when a human asks an agent to send a contract, onboard a marketplace contributor, preview a privacy acknowledgement, bulk-send MNDAs, or check whether an agreement was signed.

## Install

YC-style setup for a new machine:

```bash
curl -fsSL https://agentink-pied.vercel.app/cli/install.sh | bash
agentcontract login --email you@example.com --api-url https://agentink-pied.vercel.app
agentcontract skill
```

Requires Node.js 20+ and npm. The install script uses the hosted prebuilt package, so a remote tester does not need the repo or local build setup.

`agentcontract login --email` sends a six-digit AgentContract email code and saves a local config after verification. This is the preferred remote-agent login path. Browser WorkOS login is also available with `agentcontract login --api-url https://agentink-pied.vercel.app` once the WorkOS provider is enabled. `agentcontract skill` installs or updates this skill for the selected AI agent.

`agentcontract update --check` checks npm for a newer CLI. `agentcontract update --yes` self-updates the global npm install with the detected package manager.

Until the npm package is published, install directly:

```bash
npm install -g github:bear-ai-dev/agentsign
```

After publishing:

```bash
npm install -g agent-contract
```

Manual config is still available for CI or secret-manager flows. Never print or commit the API key.

```bash
agentcontract init \
  --api-url https://agentink-pied.vercel.app \
  --sender-email you@example.com \
  --sender-name "Sender from Acme" \
  --notify you@example.com
```

When pulling from a secret manager, pipe the key instead of putting it in argv:

```bash
printf '%s' "$AGENTCONTRACT_API_KEY" | agentcontract init \
  --api-url https://agentink-pied.vercel.app \
  --api-key-stdin \
  --sender-email you@example.com
```

Validate the install:

```bash
agentcontract doctor --json
agentcontract update --check
agentcontract keys --json
```

## Project Memory

The remote acceptance tester is picky. Assume they have no repo context and will bounce off anything vague. Keep flows CLI-first, give exactly copy-pasteable commands, verify from a clean install, and capture breakage with `agentcontract feedback`.

Schema changes must use explicit migrations. `npm run migrate` targets local SQLite by default and Supabase/Postgres when `DATABASE_URL` is present; do not rely on boot-time schema repair as the production migration plan.

## Default Workflow

0. Before sending, reading, reminding, cancelling, or checking status, run `agentcontract update --check --json`. If `update_available` is true, run `agentcontract update --yes`, then `agentcontract skill`, then continue with the original task. If `agentcontract update` is not recognized, run `curl -fsSL https://agentink-pied.vercel.app/cli/install.sh | bash`, then `agentcontract skill`, then continue. If npm/network is unavailable, continue with the current CLI and report the update failure with `agentcontract feedback`.
1. For any contract/onboarding/signing task, keep the context small. Pass a one-line `--prompt`, `--goal`, or `--chat-summary` only when there is an explicit user/agent goal worth attaching to the send. Do not upload chat transcripts, message logs, or tool event dumps.
2. Read or dry-run first. Use local preview files only if the human asks for visual rendering.
3. List or inspect the contract before sending if the human did not specify an exact contract id.
4. Send only after the recipient name, recipient email, sender email, and template variables are specific to the recipient.
5. Use `--json` for all agent-to-agent or script usage.
6. Store the returned `id`, `signing_url`, and `webhook_secret` in the calling system if a webhook is configured.
7. After a send, store the returned `id`, `signing_url`, and `webhook_secret` in the calling system when needed; use the agreement id for future status checks.
8. Check status with `agentcontract status <agreement_id> --json`, then read the sent agreement with `agentcontract agreement read <agreement_id>`.
9. Before sending any reminder, explicitly ask whether the reminder should go to the sender/themselves, the recipient/everyone else, or all signing parties. Use `--remind-self`, `--remind-recipient`, or `--remind-all`; never run a plain `agreement remind` from an agent.

## Agent-Native Commands

Stay in the terminal unless a recipient needs to sign:

```bash
agentcontract keys --json
agentcontract key create --key-name "Agent laptop" --json
agentcontract domain setup --email-domain acme.com --signing-domain contracts.acme.com --from legal@acme.com --sender-name "Acme Legal" --json
agentcontract domain status --json
agentcontract domain verify --json
agentcontract templates --json
agentcontract template read privacy --out ./privacy.md
agentcontract read privacy --var effective_date="April 29, 2026"
agentcontract send-pdf ./agreement.pdf --to jane@example.com --name "Jane Doe" --title "Partner SOW" --json
agentcontract dashboard contractor
agentcontract agreements --status sent --limit 20 --json
agentcontract batches --json
agentcontract batch read bat_... --json
agentcontract agreement read agr_... --out ./agreement.md
agentcontract agreement audit agr_...
agentcontract agreement remind agr_... --remind-recipient
agentcontract agreement cancel agr_...
agentcontract agreement pdf agr_... --out ./agreement.pdf
agentcontract update --yes
agentcontract feedback --message "Login code never arrived" --command "agentcontract login --email you@example.com" --category login --severity high --json
```

The sender dashboard is optional. Prefer CLI/API commands for all agent and sender workflows.

## Prompt Context

AgentContract does not need full transcripts. Add only an explicit short prompt, goal, or summary when it materially explains the send:

```bash
agentcontract send-mnda \
  --to jane@example.com \
  --name "Jane Doe" \
  --prompt "Send the approved NDA for contributor onboarding" \
  --json
```

Successful commands without explicit prompt context should not store a CLI run record. Failed commands are reported automatically unless `AGENTCONTRACT_TELEMETRY=0` or `--no-telemetry` is set.

## First-Party Domains

Before an agent sends from `legal@customer.com` or uses `contracts.customer.com` signing links, check the sender profile:

```bash
agentcontract domain status --json
```

If no verified profile exists, ask the human for the email domain, signing domain, and sender address, then run:

```bash
agentcontract domain setup \
  --email-domain customer.com \
  --signing-domain contracts.customer.com \
  --from legal@customer.com \
  --sender-name "Customer Legal" \
  --json
```

Tell the human to add the returned DNS records, then run `agentcontract domain verify --json`. Agents may use `--from legal@customer.com` only after both `email_domain_status` and `signing_domain_status` are `verified`.

## Failure Feedback

When any AgentContract command fails, feels confusing, or blocks the user, report it before trying workarounds:

```bash
agentcontract feedback \
  --command "paste the exact command that failed" \
  --expected "what should have happened" \
  --actual "the error, confusing output, or bad behavior" \
  --message "one sentence summary" \
  --severity high \
  --json
```

Use `--category install`, `--category login`, `--category sending`, `--category signing`, or `--category docs` when obvious. `agentcontract feedback` works before login, and if the user is logged in it attaches the local account email. Feedback is stored in the hosted AgentContract database so the product team can review it later.

## Contract Library

List current contracts:

```bash
agentcontract contracts --json
```

Inspect the exact text before sending:

```bash
agentcontract contract show privacy --markdown
agentcontract contract read privacy --var effective_date="April 29, 2026"
```

Add a reusable contract from markdown:

```bash
agentcontract contract add partner-msa \
  --markdown-file ./contracts/partner-msa.md \
  --fields-file ./contracts/signing-fields.json \
  --var company_name="Acme Inc." \
  --var effective_date=2026-04-29 \
  --json
```

Agents can save human-approved custom markdown with structured fields:

```bash
cat ./approved-contract.md | agentcontract contract add custom-sow \
  --markdown-stdin \
  --fields-json '[{"id":"full_name","label":"Full legal name","type":"text","required":true},{"id":"signature","label":"Signature","type":"signature","required":true}]' \
  --json
```

Bring your own PDF when the document already exists:

```bash
agentcontract send-pdf ./contracts/partner-sow.pdf \
  --to jane@example.com \
  --name "Jane Doe" \
  --title "Partner SOW" \
  --json
```

The recipient reviews the uploaded PDF in the browser. AgentContract collects the configured signing fields and stores an executed PDF with the original pages, signing certificate, and audit trail.

Capture human feedback as structured local review notes before revising:

```bash
agentcontract contract feedback custom-sow \
  --author "Agent" \
  --note "Make the IP assignment clearer and shorten the termination section." \
  --json

agentcontract contract read custom-sow --with-feedback
agentcontract contract edit custom-sow
```

When feedback is added to a built-in contract, AgentContract creates an editable local copy first. Always re-read with `--with-feedback` before sending a revised contract.

Seed from a built-in contract and edit the local copy:

```bash
agentcontract contract add marketplace-mnda --from-template nda --var company_name="Acme Marketplace"
agentcontract contract edit marketplace-mnda
```

Editing a built-in id creates a local editable copy:

```bash
agentcontract contract edit privacy
```

Read and send a saved contract. Use `contract preview` only when a human needs local HTML rendering.

```bash
agentcontract contract read partner-msa \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --out ./partner-msa.md

agentcontract contract send partner-msa \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --json
```

## Send Acme Marketplace Privacy Acknowledgement

This is the default marketplace onboarding contract. It uses:

- Company: `Acme Marketplace`
- Service: `Acme`
- Website: `example.com`
- Contact: `you@example.com`
- Address: `123 Market Street, San Francisco, CA`

Read:

```bash
agentcontract read privacy \
  --var effective_date="April 29, 2026"
```

Dry-run:

```bash
agentcontract marketplace-onboard \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --dry-run \
  --json
```

Send:

```bash
agentcontract marketplace-onboard \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --cc you@example.com \
  --json
```

## Bulk Onboarding

Use a JSON file with an array or `{ "recipients": [...] }`.

```json
[
  { "name": "Alice Contributor", "email": "alice@example.com" },
  { "name": "Bob Contributor", "email": "bob@example.com" }
]
```

Then send:

```bash
agentcontract bulk-marketplace-onboard \
  --file contributors.json \
  --cc you@example.com \
  --json
```

For Acme contributor terms/contractor agreements, use the same JSON shape:

```bash
agentcontract bulk-contractor \
  --file contractors.json \
  --json
```

## Send Other Contracts

Acme MNDA:

```bash
agentcontract send-mnda \
  --to jane@example.com \
  --name "Jane Doe" \
  --json
```

Acme contributor terms:

```bash
agentcontract marketplace-contractor \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --preview \
  --preview-file ./contractor-preview.html
```

Custom contract from markdown:

```bash
agentcontract send-contract \
  --to jane@example.com \
  --name "Jane Doe" \
  --from you@example.com \
  --markdown-file ./contract.md \
  --vars-file ./vars.json \
  --fields-file ./fields.json \
  --dry-run \
  --json
```

## Notifications

After all required signatures are collected, AgentContract emails the executed PDF to the recipient, sender, and any `--notify` addresses. Pass `--notify` or configure it with `agentcontract init --notify you@example.com` for extra completion recipients.

For machine notifications, pass a webhook URL:

```bash
agentcontract marketplace-onboard \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --webhook-url https://example.com/webhooks/agentcontract \
  --json
```

Webhook payloads are signed with `X-AgentInk-Signature` using HMAC-SHA256 and the returned `webhook_secret`.

## Safety Rules

- Do not send a contract with placeholder values like `{{company_name}}`, `TBD`, or fake recipient emails.
- Do not expose API keys in chat, logs, git commits, screenshots, or README examples.
- Before any bulk or other mass email, show the human the count and target audience, ask for explicit approval, then rerun with `--yes`. Use `--dry-run --json` before any bulk send.
- Store the `batch_id` returned by bulk sends. Use `agentcontract batch read bat_... --json` to inspect per-recipient status and failures.
- Before any reminder email, ask who should get it: the sender/themselves (`--remind-self`), the recipient/everyone else (`--remind-recipient`), or all signing parties (`--remind-all`).
- Use `contract read`, `template read`, or `--dry-run --json` before sending changed wording.
- Do not use AgentContract to give legal advice, explain legal risk to a signer, or let an agent sign a contract.
- Treat AgentContract as demo-grade e-sign infrastructure until counsel-reviewed templates, auth, storage, and operational controls are finalized.
