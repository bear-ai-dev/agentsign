---
name: agentcontract-marketplace-onboarding
description: Use AgentContract to preview, send, and track marketplace onboarding contracts, privacy acknowledgements, MNDAs, and contractor agreements from an API-first CLI.
---

# AgentContract Marketplace Onboarding

Use this skill when a human asks an agent to send a contract, onboard a marketplace contributor, preview a privacy acknowledgement, bulk-send MNDAs, or check whether an agreement was signed.

## Install

Until the npm package is published:

```bash
npm install -g github:bear-ai-dev/agentsign
```

After publishing:

```bash
npm install -g @bear-ai-dev/agentcontract
```

Configure once. Never print or commit the API key.

```bash
export AGENTCONTRACT_API_KEY=<production-api-key>
agentcontract init \
  --api-url https://agentink-pied.vercel.app \
  --sender-email sid@usebear.ai \
  --sender-name "Sid from Specific" \
  --notify sid@usebear.ai
```

When pulling from a secret manager, pipe the key instead of putting it in argv:

```bash
printf '%s' "$AGENTCONTRACT_API_KEY" | agentcontract init \
  --api-url https://agentink-pied.vercel.app \
  --api-key-stdin \
  --sender-email sid@usebear.ai
```

Validate the install:

```bash
agentcontract doctor --json
```

## Default Workflow

1. Preview or dry-run first.
2. List or inspect the contract before sending if the human did not specify an exact contract id.
3. Send only after the recipient name, recipient email, sender email, and template variables are specific to the recipient.
4. Use `--json` for all agent-to-agent or script usage.
5. Store the returned `id`, `signing_url`, and `webhook_secret` in the calling system if a webhook is configured.
6. Check status with `agentcontract status <agreement_id> --json`.

## Contract Library

List current contracts:

```bash
agentcontract contracts --json
```

Inspect the exact text before sending:

```bash
agentcontract contract show privacy --markdown
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

Seed from a built-in contract and edit the local copy:

```bash
agentcontract contract add marketplace-mnda --from-template nda --var company_name="Specific Marketplace"
agentcontract contract edit marketplace-mnda
```

Editing a built-in id creates a local editable copy:

```bash
agentcontract contract edit privacy
```

Preview and send a saved contract:

```bash
agentcontract contract preview partner-msa \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --open

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

Preview:

```bash
agentcontract marketplace-onboard \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --preview \
  --open
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

Bear contractor agreement:

```bash
agentcontract bear-contractor \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --scope "Backend engineering" \
  --rate 150 \
  --start-date 2026-05-01 \
  --preview \
  --open
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
- Use `--preview --open` when contract wording has changed.
- Treat AgentContract as demo-grade e-sign infrastructure until counsel-reviewed templates, auth, storage, and operational controls are finalized.
