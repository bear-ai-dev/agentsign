# AgentSign

AgentSign is a demo-grade, agent-native contract signing API for mass-sending NDAs, privacy acknowledgements, and contractor agreements.

## Quickstart

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

The default API key is `ak_local_dev_key_change_me`. If `RESEND_API_KEY` is empty, signing and completion emails are printed to the console.

## CLI: send an MNDA

The fastest path is Bear-specific. These commands bake in Bear AI, Sid as sender, `usebear.ai`, and signed notifications back to Sid.

Preview a specific contractor agreement before sending:

```bash
npm run cli -- bear-contractor \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --scope "Backend engineering" \
  --rate 150 \
  --start-date 2026-05-01 \
  --preview \
  --open
```

Send the same Bear contractor agreement:

```bash
npm run cli -- bear-contractor \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --scope "Backend engineering" \
  --rate 150 \
  --start-date 2026-05-01
```

Send Bear MNDA or privacy acknowledgement:

```bash
npm run cli -- bear-mnda --to jane@example.com --name "Jane Doe"
npm run cli -- bear-privacy --to jane@example.com --name "Jane Doe"
```

Open the Bear contractor UI:

```bash
open https://agentink-pied.vercel.app/templates/bear-contractor
```

The lower-level CLI is still available for agents and scripts that need to send custom templates without hand-writing JSON.

```bash
export AGENTSIGN_API_URL=https://agentink-pied.vercel.app
export AGENTSIGN_API_KEY=ak_local_dev_key_change_me
export AGENTSIGN_SENDER_EMAIL=janak@usebear.ai
export AGENTSIGN_SENDER_NAME="Bear AI"

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

Customize and preview a contract before sending:

```bash
npm run cli -- send-contract \
  --from sid@usebear.ai \
  --sender-name "Sid from Bear AI" \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --template contractor \
  --company "Bear AI" \
  --var scope_of_work="Backend engineering" \
  --var rate=150 \
  --var start_date=2026-05-01 \
  --preview \
  --open
```

Send the same customized contractor agreement:

```bash
npm run cli -- send-contract \
  --from sid@usebear.ai \
  --sender-name "Sid from Bear AI" \
  --to contractor@example.com \
  --name "Jane Contractor" \
  --template contractor \
  --company "Bear AI" \
  --var scope_of_work="Backend engineering" \
  --var rate=150 \
  --var start_date=2026-05-01
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

View a sent contract without marking it viewed by the signer:

```bash
npm run cli -- view agr_... --open
```

Check state:

```bash
npm run cli -- status agr_...
```

CLI design choices for agents:

- `--from` and `--to` map to the human model agents expect, while the API still keeps email deliverability details separate.
- `--json` produces machine-readable output for agent chains.
- `--dry-run` prints the exact API payload without requiring an API key or sending email.
- `--preview` renders local HTML before sending; `view --open` opens the read-only contract preview after sending.
- Errors go to stderr with a concrete example command.

## Privacy policy template

Open the browser template UI:

```bash
open http://localhost:3000/templates/privacy
```

The UI exposes the variables inferred from the Bear AI privacy-policy PDF:

- `company_name`
- `service_name`
- `website_url`
- `effective_date`
- `terms_name`
- `data_use_policy_name`
- `contact_email`
- `company_address`

It sends a `privacy` template agreement with these required signing fields:

- `full_name`
- `acknowledgement_date`
- `signature`

Agents can send the same privacy policy directly:

```bash
npm run cli -- send-privacy \
  --from janak@usebear.ai \
  --to jane@example.com \
  --name "Jane Doe" \
  --cc sid@usebear.ai
```

Template metadata is available through the API:

```bash
curl http://localhost:3000/v1/templates/privacy \
  -H "Authorization: Bearer ak_local_dev_key_change_me"
```

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

## Bulk send contractor agreements

```bash
curl -X POST http://localhost:3000/v1/agreements/bulk \
  -H "Authorization: Bearer ak_local_dev_key_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "contractor",
    "template_vars_default": {
      "company_name": "Bear AI",
      "effective_date": "2026-04-29",
      "rate_unit": "hour",
      "invoice_frequency": "biweekly",
      "notice_days": "14"
    },
    "recipients": [
      {
        "name": "Alice Smith",
        "email": "alice@example.com",
        "template_vars": {"rate": "150", "scope_of_work": "Backend engineering", "start_date": "2026-05-01"}
      },
      {
        "name": "Bob Jones",
        "email": "bob@example.com",
        "template_vars": {"rate": "175", "scope_of_work": "ML engineering", "start_date": "2026-05-15"}
      }
    ],
    "fields": [
      {"id": "full_name", "label": "Full legal name", "type": "text", "required": true},
      {"id": "address", "label": "Address", "type": "text", "required": true},
      {"id": "tax_id", "label": "SSN or EIN (last 4)", "type": "text", "required": true},
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

`privacy`: `company_name`, `service_name`, `website_url`, `effective_date`, `terms_name`, `data_use_policy_name`, `contact_email`, `company_address`

`contractor`: `company_name`, `effective_date`, `scope_of_work`, `rate`, `rate_unit`, `invoice_frequency`, `start_date`, `notice_days`

## v1 limitations

- Single recipient only; no multi-signer routing.
- Webhook retries run only while the Node process is alive.
- `webhook_secret` is generated per agreement because there is no customer model yet.
- Create and bulk requests support one-off `cc`, but reminders do not persist the original CC list yet.
- `sender_email` is stored per agreement, used as request `Reply-To`, and used as the signed-notification target unless `notification_email` is provided.
- `notification_email` sends a completion email when the recipient signs; webhooks are still the source of truth for machine callbacks.
- Signature and initials use typed-signature capture for the v1 UI; older drawn image data URLs are still accepted by the API/PDF renderer.
- PDF rendering is optimized for local/Railway demo use, not high-volume throughput.
- Template substitution is simple `{{var}}` replacement.
- Audit logs are append-only by application behavior, not database-level immutability.
- This is not legal advice; use with your own counsel-reviewed templates before production use.
