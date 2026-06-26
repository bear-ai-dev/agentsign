# AgentContract

AgentContract is an agent-native contract sending API and public CLI for marketplace onboarding. It can send NDAs, privacy acknowledgements, and contractor agreements, then notify your app or sender when a recipient signs.

## Quickstart

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

The default local API key is `ak_local_dev_key_change_me`. Do not use that key in production. If `RESEND_API_KEY` is empty, signing and completion emails are printed to the console.

## Analytics

AgentContract uses PostHog server-side telemetry through `posthog-node`. Set `POSTHOG_PROJECT_API_KEY` and `POSTHOG_HOST` to capture request completion, errors, feedback, API key lifecycle, agent sessions, agreement lifecycle, and signing milestones. Set `POSTHOG_ENABLED=false` to disable analytics in an environment.

## Production migrations

`npm run migrate` is production-aware. With no `DATABASE_URL`, it migrates local SQLite. When `DATABASE_URL` is set, it migrates the Supabase/Postgres database, records each SQL file in `schema_migrations`, stores a SHA-256 checksum, and uses a Postgres advisory lock so two deploys cannot migrate at the same time.

For production:

```bash
vercel env pull /tmp/agentcontract-prod.env --environment=production
set -a
source /tmp/agentcontract-prod.env
set +a
npm run migrate
```

Useful checks:

```bash
npm run migrate -- --status
npm run migrate -- --dry-run
```

Do not commit pulled env files. `.env*.local` is ignored, and `/tmp/agentcontract-prod.env` keeps production secrets out of the repo.

## Public CLI

The npm package is prepared as `@bear-ai-dev/agentcontract` because the unscoped `agentcontract` package name is already taken on npm. The installed commands are both `agentcontract` and the backwards-compatible `agentsign` alias.

YC-style setup:

```bash
curl -fsSL https://agentcontract.to/cli/install.sh | bash
agentcontract login --email you@example.com --api-url https://agentcontract.to
agentcontract skill
```

Requires Node.js 20+ and npm. The install script uses the prebuilt AgentContract package served from the hosted app, so remote testers do not need this repo checked out or any local build tools.

`agentcontract login --email` sends a six-digit AgentContract code, creates a user-owned API key after verification, and saves `~/.agentcontract/config.json` with file mode `0600`. WorkOS browser login is still available with `agentcontract login`, but the email-code flow is the reliable default for remote agents and first-time users:

```bash
agentcontract login --email you@example.com --api-url https://agentcontract.to
```

`agentcontract skill` prints AI-agent setup instructions so Claude Code, Codex, or another local agent knows how to inspect, draft, revise, send, and track contracts from the CLI. Use `agentcontract skill --install` to install or update the local skill file explicitly.

The browser onboarding page is:

```bash
open https://agentcontract.to/cli
```

After npm publishing, the install script uses:

```bash
npm install -g @bear-ai-dev/agentcontract
```

Before npm publishing, it can be installed directly from GitHub:

```bash
npm install -g github:bear-ai-dev/agentsign
agentcontract --version
agentcontract doctor
```

Env vars and command flags still override saved config, which is useful for CI or one-off sends. Run `agentcontract config get` to inspect config with the API key masked. For secret managers, you can also pipe a manually created key with `--api-key-stdin`.

API key management is also CLI-first after login:

```bash
agentcontract keys
agentcontract key create --key-name "Sid laptop"
agentcontract key revoke key_...
```

API keys created this way are stored as SHA-256 hashes. The env `AGENTCONTRACT_API_KEY` remains a bootstrap key for server ops, but day-to-day users should use email-code or WorkOS-issued user keys.

For agent installation and operating instructions, see [SKILLS.md](./SKILLS.md).

## Production acceptance bar

Treat Sid as a remote, picky first user with no local context. Every shipped CLI/server change should be verifiable from a clean machine with only the install command, should have explicit Supabase/Postgres migrations when schema changes, and should give Claude Code a one-command feedback path when anything breaks.

## Remote tester handoff

Sid can test without Janak or Codex around:

```bash
curl -fsSL https://agentcontract.to/cli/install.sh | bash
agentcontract login --email you@example.com --api-url https://agentcontract.to
agentcontract doctor --json
agentcontract feedback --message "Install/login worked" --category install --severity note --json
agentcontract templates
agentcontract template read privacy --out ./privacy.md
agentcontract marketplace-onboard --to sid@usebear.ai --name "Sid Test" --dry-run --json
```

The login command emails a six-digit AgentContract code. Paste it into the terminal when prompted. Browser WorkOS login is also supported once the WorkOS redirect URI is registered:

```bash
agentcontract login --api-url https://agentcontract.to
```

After login, he can send a real test to himself:

```bash
agentcontract marketplace-onboard --to sid@usebear.ai --name "Sid Test" --cc janak@usebear.ai
```

He should send feedback as: command run, expected result, actual result, and what felt confusing. Claude Code can store that directly:

```bash
agentcontract feedback \
  --command "paste the exact command that failed" \
  --expected "what should have happened" \
  --actual "the error, confusing output, or bad behavior" \
  --message "one sentence summary" \
  --severity high \
  --json
```

`agentcontract feedback` works before login so install/auth failures can still be reported. When logged in, feedback is attached to the account and stored in the hosted database/Supabase-backed production store. Review logged-in feedback with `agentcontract feedback list --json`.

Marketplace onboarding sends the Specific Marketplace privacy acknowledgement:

```bash
agentcontract marketplace-onboard \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --cc sid@usebear.ai
```

Bulk marketplace onboarding from a JSON file:

```json
[
  { "name": "Alice Contributor", "email": "alice@example.com" },
  { "name": "Bob Contributor", "email": "bob@example.com" }
]
```

```bash
agentcontract bulk-marketplace-onboard --file contributors.json --cc sid@usebear.ai
```

Read the contract text without opening a browser:

```bash
agentcontract read privacy \
  --var effective_date="April 29, 2026"

agentcontract contract read privacy \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --out ./specific-privacy.md
```

Use `--dry-run --json` before a real send when an agent is preparing a contract:

```bash
agentcontract marketplace-onboard \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --dry-run \
  --json
```

After sending, agents can stay in the terminal:

```bash
agentcontract agreements --status sent --limit 20
agentcontract agreement read agr_... --out ./sent-contract.md
agentcontract agreement audit agr_...
agentcontract agreement remind agr_...
agentcontract agreement cancel agr_...
agentcontract agreement pdf agr_... --out ./signed.pdf
```

Longer agent runs can attach a lightweight transcript to the work:

```bash
agentcontract session start --agent codex --goal "send onboarding agreements" --json
agentcontract session event --session-id sess_... --type user_message --role user --text "Human approved the send." --json
agentcontract session end sess_... --outcome "Sent the requested agreements." --json
```

When an agreement is signed, AgentContract stores the structured field values and the final signed PDF in the database. The API also stores `signed_pdf_sha256` and `signed_pdf_bytes`, so the CLI can prove the downloadable PDF matches the saved document even on Vercel where local files are temporary.

Server templates can be inspected and used without opening the template UI:

```bash
agentcontract templates
agentcontract template show privacy --markdown
agentcontract template read privacy --out ./privacy.md
agentcontract template send nda --to jane@example.com --name "Jane Doe"
```

Public standard templates are available without dashboard access:

- `/templates/mutual-nda` - two-way confidentiality template for collaborations where both parties disclose sensitive information.
- `/templates/one-way-nda` - unilateral confidentiality template for sales demos, contractor interviews, invention reviews, and diligence.
- `/templates/privacy-policy` - website/app privacy policy acknowledgement covering collection, use, sharing, retention, rights, security, and contact details.

They can also be read or sent through the CLI:

```bash
agentcontract template read mutual-nda --out ./mutual-nda.md
agentcontract template read one-way-nda --out ./one-way-nda.md
agentcontract template read privacy-policy --out ./privacy-policy.md
agentcontract template send privacy-policy --to jane@example.com --name "Jane Doe"
```

## CLI contract library

The CLI has a local contract workspace for reusable contracts. It stores editable markdown and metadata under `~/.agentcontract/contracts` by default. Override that with `AGENTCONTRACT_CONTRACTS_DIR` or `--contract-dir`.

List current contracts before sending:

```bash
agentcontract contracts
agentcontract contract show privacy --markdown
agentcontract contract read privacy --var effective_date="April 29, 2026"
```

Create a new reusable contract from markdown and signing fields:

```bash
agentcontract contract add partner-msa \
  --markdown-file ./contracts/partner-msa.md \
  --fields-file ./contracts/signing-fields.json \
  --var company_name="Bear AI" \
  --var effective_date=2026-04-29
```

Agents that draft markdown on the fly can save it directly from stdin:

```bash
cat ./draft-contract.md | agentcontract contract add custom-sow \
  --markdown-stdin \
  --fields-json '[{"id":"full_name","label":"Full legal name","type":"text","required":true},{"id":"signature","label":"Signature","type":"signature","required":true}]' \
  --var company_name="Specific Marketplace"
```

Capture feedback before sending, then let an agent revise against the note:

```bash
agentcontract contract feedback custom-sow \
  --author "Sid" \
  --note "Make the IP assignment clearer and shorten the termination section."

agentcontract contract read custom-sow --with-feedback
agentcontract contract edit custom-sow
agentcontract contract read custom-sow --with-feedback
```

`contract feedback` also works on built-ins like `nda`, `privacy`, and `contractor`; the CLI creates an editable local copy before storing the feedback.

Seed a new contract from a built-in, then edit it:

```bash
agentcontract contract add marketplace-mnda --from-template nda --var company_name="Specific Marketplace"
agentcontract contract edit marketplace-mnda
```

Editing a built-in such as `privacy` automatically creates a local copy first, so package files stay untouched:

```bash
agentcontract contract edit privacy
```

Read or preview the edited contract, then send it. `contract read` is the agent-native path; `contract preview` writes local HTML only when a human wants visual rendering.

```bash
agentcontract contract read marketplace-mnda \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --out ./marketplace-mnda.md

agentcontract contract send marketplace-mnda \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --cc sid@usebear.ai \
  --json
```

## CLI-first sender workflows

Everything a sender needs can be done from the CLI: authenticate, manage API keys, list templates, read contracts, create/edit reusable contracts, capture feedback, preview locally, send, bulk send, remind, cancel, check status, read sent text, view audit events, and download PDFs. The sender dashboard and template forms are optional convenience views only.

Recipient signing still uses the public token link in the email because the recipient must review, consent, and type their signature. Agents should use `agentcontract read`, `agentcontract contract send`, `agentcontract agreement read`, `agentcontract agreement audit`, and webhooks instead of browser flows.

## WorkOS Auth

`agentcontract login --email` uses AgentContract email-code auth and requires no browser. Browser login uses WorkOS AuthKit with a localhost callback, similar to the YC CLI flow. The optional sender/admin UI routes under `/dashboard`, `/dashboard/api-keys`, and `/templates/*` accept either an AgentContract email-code session or a WorkOS session. Recipient signing links stay public. In WorkOS, configure AuthKit with the Bear/Specific Google Workspace connection so Sid can sign in with Google directly.

Required production env vars:

```bash
WORKOS_API_KEY=sk_...
WORKOS_CLIENT_ID=client_...
WORKOS_COOKIE_PASSWORD=<32+ character random secret>
WORKOS_REDIRECT_URI=https://agentcontract.to/auth/callback
```

In the WorkOS dashboard, configure:

- Redirect URI: `https://agentcontract.to/auth/callback`
- Sign-in endpoint: `https://agentcontract.to/login`
- Sign-out redirect: `https://agentcontract.to/`
- Google Workspace / Google OAuth connection for the allowed company domain

Current production fallback: `/login` presents an email-code sign-in first and a WorkOS/Google button second. This is intentional so Sid can use the CLI and dashboard even if WorkOS SSO/social login still needs a dashboard-side provider toggle.

Generate a cookie password locally:

```bash
openssl rand -base64 32
```

## CLI: send contracts

The fastest paths are the Sid/Bear helpers. MNDA defaults to Bear AI. The privacy and contributor-terms commands bake in the Specific Marketplace documents from the PDFs: `Specific Marketplace`, `Specific`, `usespecific.com`, `sid@usebear.ai`, and `39 Tehama, San Francisco, CA`.

Preview the Specific contributor terms before sending:

```bash
npm run cli -- specific-contractor \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --preview \
  --preview-file ./specific-contractor-preview.html
```

Send the same Specific contributor terms:

```bash
npm run cli -- specific-contractor \
  --to contractor@example.com \
  --name "Jane Contractor"
```

Send Bear MNDA or the Specific privacy acknowledgement:

```bash
npm run cli -- bear-mnda --to jane@example.com --name "Jane Doe"
npm run cli -- specific-privacy --to jane@example.com --name "Jane Doe"
```

Agents and scripts should use the CLI or `/v1/agreements` with Bearer auth. The lower-level CLI is available for custom templates without hand-writing JSON.

```bash
export AGENTCONTRACT_API_URL=https://agentcontract.to
export AGENTCONTRACT_API_KEY=<your production API key>
export AGENTCONTRACT_SENDER_EMAIL=janak@usebear.ai
export AGENTCONTRACT_SENDER_NAME="Bear AI"

npm run cli -- send-mnda \
  --from janak@usebear.ai \
  --to jane@example.com \
  --name "Jane Doe" \
  --company "Bear AI" \
  --cc sid@usebear.ai
```

`--from` is the human sender. The verified `EMAIL_FROM` address is still used for deliverability, while `--from` becomes the email `Reply-To` and the default completion notification address. `--to` is the receiver email. `--email` still works as a backwards-compatible alias.

Use `--json` when another agent or script should parse the result:

```bash
npm run cli -- send-mnda \
  --from janak@usebear.ai \
  --to jane@example.com \
  --name "Jane Doe" \
  --company "Bear AI" \
  --json
```

Use `--dry-run` to let an agent inspect the exact payload before sending:

```bash
npm run cli -- send-privacy \
  --from janak@usebear.ai \
  --to jane@example.com \
  --name "Jane Doe" \
  --dry-run \
  --json
```

Preview the built-in Specific contributor terms before sending:

```bash
npm run cli -- send-contract \
  --from sid@usebear.ai \
  --sender-name "Sid from Specific" \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --template contractor \
  --preview \
  --preview-file ./specific-contractor-preview.html
```

Send the same contributor terms:

```bash
npm run cli -- send-contract \
  --from sid@usebear.ai \
  --sender-name "Sid from Specific" \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --template contractor
```

Use custom markdown and fields from files:

```bash
npm run cli -- send-contract \
  --from sid@usebear.ai \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --markdown-file ./contracts/custom.md \
  --vars-file ./contracts/jane-vars.json \
  --fields-file ./contracts/signing-fields.json \
  --dry-run \
  --json
```

Agents can also draft a one-off contract through stdin and structured fields, inspect the payload, then send:

```bash
cat ./draft-contract.md | npm run cli -- send-contract \
  --from sid@usebear.ai \
  --to jane@example.com \
  --name "Jane Doe" \
  --markdown-stdin \
  --fields-json '[{"id":"full_name","label":"Full legal name","type":"text","required":true},{"id":"signature","label":"Signature","type":"signature","required":true}]' \
  --dry-run \
  --json
```

Read a sent contract without marking it viewed by the signer:

```bash
npm run cli -- agreement read agr_... --out ./sent-contract.md
```

Check state:

```bash
npm run cli -- status agr_...
```

CLI design choices for agents:

- `--from` and `--to` map to the human model agents expect, while the API still keeps email deliverability details separate.
- `agentcontract init` creates a reusable local config so humans and agents do not need to paste keys into every command.
- `--json` produces machine-readable output for agent chains.
- `--dry-run` prints the exact API payload without requiring an API key or sending email.
- `--preview` renders local HTML before sending; `agreement read` keeps sent-contract review in the terminal.
- Errors go to stderr with a concrete example command.

## Specific privacy policy template

Inspect the template from the CLI:

```bash
agentcontract template show privacy --markdown
agentcontract template read privacy --out ./specific-privacy.md
```

The privacy document body is fixed to the local PDF named `Bear AI Privacy Policy with Jason Zeng.pdf`. The reusable template intentionally does not copy Jason's Common Paper audit block; it only uses the policy text and adds a fresh AgentContract audit trail for each new recipient.

The fixed policy values are:

- Company: `Specific Marketplace`
- Service: `Specific`
- Website: `usespecific.com`
- Contact email: `sid@usebear.ai`
- Address: `39 Tehama, San Francisco, CA`

The only template variable exposed by default is `effective_date`, defaulting to `April 29, 2026`.

It sends a `privacy` template agreement with these required signing fields:

- `full_name`
- `acknowledgement_date`
- `signature`

Agents can send the same privacy policy directly:

```bash
npm run cli -- specific-privacy \
  --to jane@example.com \
  --name "Jane Doe" \
  --cc janak@usebear.ai
```

Template metadata is available through the CLI or API:

```bash
agentcontract templates
agentcontract template show privacy --json
```

```bash
curl http://localhost:3000/v1/templates/privacy \
  -H "Authorization: Bearer ak_local_dev_key_change_me"
```

## Specific contributor terms template

The contractor/contributor document is reconstructed from `Bear AI Contractor with Jason Zeng.pdf` as reusable Specific Marketplace contributor terms. The template keeps the company/service/website/contact placeholders specific and excludes the old Common Paper signature/audit block so each send gets a fresh AgentContract audit trail.

Agents can inspect or send it without a browser:

```bash
npm run cli -- template show contractor --markdown
npm run cli -- read contractor --var effective_date="April 29, 2026"
npm run cli -- specific-contractor \
  --to contributor@example.com \
  --name "Jane Contributor" \
  --cc sid@usebear.ai
```

The built-in templates available to agents are:

- `nda`: Bear AI mutual NDA
- `privacy`: Specific Marketplace privacy acknowledgement
- `contractor`: Specific Marketplace contributor terms
- `filesystem-purchase-agreement`: Bear AI filesystem data purchase agreement with seller-first countersignature fields

Bulk send MNDAs from a JSON file:

```json
[
  { "name": "Alice Smith", "email": "alice@example.com" },
  { "name": "Bob Jones", "email": "bob@example.com" }
]
```

```bash
npm run cli -- bulk-mnda --from janak@usebear.ai --file recipients.json --company "Bear AI"
```

## Send a single NDA

```bash
curl -X POST http://localhost:3000/v1/agreements \
  -H "Authorization: Bearer ak_local_dev_key_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": {"name": "Jane Doe", "email": "jane@example.com"},
    "cc": ["sid@example.com"],
    "sender_email": "sender@example.com",
    "sender_name": "Bear AI",
    "notification_email": ["sender@example.com"],
    "template": "nda",
    "template_vars": {
      "company_name": "Bear AI",
      "effective_date": "2026-04-29",
      "term_years": 2
    },
    "fields": [
      {"id": "full_name", "label": "Full legal name", "type": "text", "required": true},
      {"id": "signature", "label": "Signature", "type": "signature", "required": true}
    ],
    "webhook_url": "https://webhook.site/your-test-url"
  }'
```

## Bulk send Specific contributor terms

```bash
curl -X POST http://localhost:3000/v1/agreements/bulk \
  -H "Authorization: Bearer ak_local_dev_key_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "contractor",
    "template_vars_default": {
      "company_name": "Specific Marketplace",
      "service_name": "Specific",
      "website_url": "usespecific.com",
      "contact_email": "sid@usebear.ai",
      "company_address": "39 Tehama, San Francisco, CA",
      "effective_date": "April 29, 2026"
    },
    "recipients": [
      {
        "name": "Alice Smith",
        "email": "alice@example.com"
      },
      {
        "name": "Bob Jones",
        "email": "bob@example.com"
      }
    ],
    "fields": [
      {"id": "full_name", "label": "Full legal name", "type": "text", "required": true},
      {"id": "acknowledgement_date", "label": "Acknowledgement date", "type": "date", "required": true},
      {"id": "signature", "label": "Signature", "type": "signature", "required": true}
    ],
    "webhook_url": "https://webhook.site/your-test-url"
  }'
```

## Raw markdown agreement

```bash
curl -X POST http://localhost:3000/v1/agreements \
  -H "Authorization: Bearer ak_local_dev_key_change_me" \
  -H "Content-Type: application/json" \
  -d '{"recipient":{"name":"Jane Doe","email":"jane@example.com"},"document_markdown":"# Test Agreement\n\nHello {{name}}","template_vars":{"name":"Jane"},"fields":[{"id":"full_name","label":"Full legal name","type":"text","required":true},{"id":"signature","label":"Signature","type":"signature","required":true}]}'
```

## Read agreement text

```bash
curl http://localhost:3000/v1/agreements/agr_.../document \
  -H "Authorization: Bearer ak_local_dev_key_change_me"
```

The CLI wrapper is usually easier for agents:

```bash
agentcontract agreement read agr_... --out ./agreement.md
```

## Webhook signature verification

Node:

```js
import crypto from "node:crypto";

function verify(rawBody, header, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

Python:

```python
import hmac
import hashlib

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header, expected)
```

## Template variables

`nda`: `company_name`, `effective_date`, `term_years`

`privacy`: `effective_date`

`contractor`: `company_name`, `service_name`, `website_url`, `contact_email`, `company_address`, `effective_date`

## v1 limitations

- Single recipient only; no multi-signer routing.
- Sender/admin workflows are CLI-complete; the browser dashboard and template forms are optional convenience views.
- Recipient signing still uses the public token link so the recipient can review, consent, and type their electronic signature.
- Webhook retries run only while the Node process is alive.
- `webhook_secret` is generated per agreement because there is no customer model yet.
- Create and bulk requests support one-off `cc`, but reminders do not persist the original CC list yet.
- `sender_email` is stored per agreement, used as request `Reply-To`, and used as the signed-notification target unless `notification_email` is provided.
- `notification_email` sends a completion email when the recipient signs; webhooks are still the source of truth for machine callbacks.
- Signature and initials use typed-signature capture for the v1 UI; older drawn image data URLs are still accepted by the API/PDF renderer.
- Signed PDFs are persisted in SQLite/Postgres as base64 plus SHA-256 for v1 durability; high-volume production should move the PDF bytes to object storage while keeping the hash and metadata in the database.
- PDF rendering is optimized for local/Railway demo use, not high-volume throughput.
- Template substitution is simple `{{var}}` replacement.
- Audit logs are append-only by application behavior, not database-level immutability.
- The public package is ready to publish, but npm publishing still requires `npm login` and a final license decision.
- This is not legal advice; use with your own counsel-reviewed templates before production use.
