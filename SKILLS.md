---
name: agentcontract-marketplace-onboarding
description: Use AgentContract to preview, send, and track marketplace onboarding contracts, privacy acknowledgements, MNDAs, and contractor agreements from an API-first CLI.
---

# AgentContract Marketplace Onboarding

Use this skill when a human asks an agent to send a contract, onboard a marketplace contributor, preview a privacy acknowledgement, bulk-send MNDAs, or check whether an agreement was signed.

## Install

YC-style setup for a new machine:

```bash
curl -fsSL https://agentcontract.to/cli/install.sh | bash
agentcontract login --email you@example.com --api-url https://agentcontract.to
agentcontract skill
```

Requires Node.js 20+ and npm. The install script uses the hosted prebuilt package, so a remote tester does not need the repo or local build setup.

`agentcontract login --email` sends a six-digit AgentContract email code and saves a local config after verification. This is the preferred remote-agent login path. Browser WorkOS login is also available with `agentcontract login --api-url https://agentcontract.to` once the WorkOS provider is enabled. `agentcontract skill` prints setup instructions for an AI agent. Use `agentcontract skill --install` to install or update this skill for the selected AI agent.

Until the npm package is published, install directly:

```bash
npm install -g github:bear-ai-dev/agentsign
```

After publishing:

```bash
npm install -g @bear-ai-dev/agentcontract
```

Manual config is still available for CI or secret-manager flows. Never print or commit the API key.

```bash
agentcontract init \
  --api-url https://agentcontract.to \
  --sender-email sid@usebear.ai \
  --sender-name "Sid from Specific" \
  --notify sid@usebear.ai
```

When pulling from a secret manager, pipe the key instead of putting it in argv:

```bash
printf '%s' "$AGENTCONTRACT_API_KEY" | agentcontract init \
  --api-url https://agentcontract.to \
  --api-key-stdin \
  --sender-email sid@usebear.ai
```

Validate the install:

```bash
agentcontract doctor --json
agentcontract keys --json
```

## Project Memory

Sid is the picky remote acceptance tester. Assume he has no repo context and will bounce off anything vague. Keep flows CLI-first, give exactly copy-pasteable commands, verify from a clean install, and capture breakage with `agentcontract feedback`.

Schema changes must use explicit migrations. `npm run migrate` targets local SQLite by default and Supabase/Postgres when `DATABASE_URL` is present; do not rely on boot-time schema repair as the production migration plan.

## Default Workflow

1. Read or dry-run first. Use local preview files only if the human asks for visual rendering.
2. List or inspect the contract before sending if the human did not specify an exact contract id.
3. Send only after the recipient name, recipient email, sender email, and template variables are specific to the recipient.
4. Use `--json` for all agent-to-agent or script usage.
5. Store the returned `id`, `signing_url`, and `webhook_secret` in the calling system if a webhook is configured.
6. Check status with `agentcontract status <agreement_id> --json`, then read the sent agreement with `agentcontract agreement read <agreement_id>`.

## Agent-Native Commands

Stay in the terminal unless a recipient needs to sign:

```bash
agentcontract keys --json
agentcontract key create --key-name "Agent laptop" --json
agentcontract templates --json
agentcontract template read privacy --out ./privacy.md
agentcontract read privacy --var effective_date="April 29, 2026"
agentcontract agreements --status sent --limit 20 --json
agentcontract agreement read agr_... --out ./agreement.md
agentcontract agreement audit agr_...
agentcontract agreement remind agr_...
agentcontract agreement cancel agr_...
agentcontract agreement pdf agr_... --out ./agreement.pdf
agentcontract feedback --message "Login code never arrived" --command "agentcontract login --email sid@usebear.ai" --category login --severity high --json
```

Record agent context when you are doing a multi-step send:

```bash
agentcontract session start --agent codex --goal "send onboarding agreements" --json
agentcontract session event --session-id sess_... --type user_message --role user --text "Human approved the recipient list." --json
agentcontract session end sess_... --outcome "Sent all requested agreements." --json
```

The sender dashboard is optional. Prefer CLI/API commands for all agent and sender workflows.

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
  --var company_name="Bear AI" \
  --var effective_date=2026-04-29 \
  --json
```

Agents can create contracts directly from generated markdown and structured fields:

```bash
cat ./draft-contract.md | agentcontract contract add custom-sow \
  --markdown-stdin \
  --fields-json '[{"id":"full_name","label":"Full legal name","type":"text","required":true},{"id":"signature","label":"Signature","type":"signature","required":true}]' \
  --json
```

Capture human feedback as structured local review notes before revising:

```bash
agentcontract contract feedback custom-sow \
  --author "Sid" \
  --note "Make the IP assignment clearer and shorten the termination section." \
  --json

agentcontract contract read custom-sow --with-feedback
agentcontract contract edit custom-sow
```

When feedback is added to a built-in contract, AgentContract creates an editable local copy first. Always re-read with `--with-feedback` before sending a revised contract.

Seed from a built-in contract and edit the local copy:

```bash
agentcontract contract add marketplace-mnda --from-template nda --var company_name="Specific Marketplace"
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

## Send Specific Marketplace Privacy Acknowledgement

This is the default marketplace onboarding contract. It uses:

- Company: `Specific Marketplace`
- Service: `Specific`
- Website: `usespecific.com`
- Contact: `sid@usebear.ai`
- Address: `39 Tehama, San Francisco, CA`

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
  --cc sid@usebear.ai \
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
  --cc sid@usebear.ai \
  --json
```

## Send Other Contracts

Bear MNDA:

```bash
agentcontract bear-mnda \
  --to jane@example.com \
  --name "Jane Doe" \
  --json
```

Specific contributor terms:

```bash
agentcontract specific-contractor \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --preview \
  --preview-file ./specific-contractor-preview.html
```

Filesystem purchase agreement:

```bash
agentcontract template read filesystem-purchase-agreement \
  --out ./filesystem-purchase-agreement.md

agentcontract template send filesystem-purchase-agreement \
  --to seller@example.com \
  --name "Seller Person" \
  --json
```

Custom contract from markdown:

```bash
agentcontract send-contract \
  --to jane@example.com \
  --name "Jane Doe" \
  --from sid@usebear.ai \
  --markdown-file ./contract.md \
  --vars-file ./vars.json \
  --fields-file ./fields.json \
  --dry-run \
  --json
```

## Notifications

For human signed notifications, pass `--notify` or configure it with `agentcontract init --notify sid@usebear.ai`.

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
- Use `--dry-run --json` before any bulk send.
- Use `contract read`, `template read`, or `--dry-run --json` before sending changed wording.
- Treat AgentContract as demo-grade e-sign infrastructure until counsel-reviewed templates, auth, storage, and operational controls are finalized.
