# AgentInk

AgentInk is a demo-grade, agent-native contract signing API for mass-sending NDAs, privacy acknowledgements, and contractor agreements.

## Quickstart

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

The default API key is `ak_local_dev_key_change_me`. If `RESEND_API_KEY` is empty, signing emails are printed to the console.

## Send a single NDA

```bash
curl -X POST http://localhost:3000/v1/agreements \
  -H "Authorization: Bearer ak_local_dev_key_change_me" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": {"name": "Jane Doe", "email": "jane@example.com"},
    "cc": ["sid@example.com"],
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

`privacy`: `company_name`, `policy_date`, `policy_url`

`contractor`: `company_name`, `effective_date`, `scope_of_work`, `rate`, `rate_unit`, `invoice_frequency`, `start_date`, `notice_days`

## v1 limitations

- Single recipient only; no multi-signer routing.
- Webhook retries run only while the Node process is alive.
- `webhook_secret` is generated per agreement because there is no customer model yet.
- Create and bulk requests support one-off `cc`, but reminders do not persist the original CC list yet.
- Signature and initials use typed-signature capture for the v1 UI; older drawn image data URLs are still accepted by the API/PDF renderer.
- PDF rendering is optimized for local/Railway demo use, not high-volume throughput.
- Template substitution is simple `{{var}}` replacement.
- Audit logs are append-only by application behavior, not database-level immutability.
- This is not legal advice; use with your own counsel-reviewed templates before production use.
