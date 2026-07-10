# Nexus Post Room — Cloudflare Email Worker

This worker bridges Cloudflare Email Routing to the Nexus `/ingest/email`
endpoint. It is the sole SMTP/Email-Routing interface; the API endpoint is
tested independently via curl + `.eml` fixtures (zero worker dependency).

## Prerequisites

- A Cloudflare account with Email Routing enabled on your domain.
- The Nexus backend deployed and reachable at a public HTTPS URL.
- `wrangler` CLI installed: `npm install -g wrangler`.

## Setup

### 1. DNS — add MX record

In your Cloudflare DNS dashboard, add an MX record pointing to Cloudflare's
mail infrastructure (Cloudflare Email Routing handles this automatically when
you enable Email Routing for the domain).

### 2. Cloudflare Email Routing

1. In the Cloudflare dashboard, go to **Email → Email Routing**.
2. Enable routing for your domain.
3. Under **Custom Addresses**, add a routing rule:
   - **Email address:** `<EMAIL_INGEST_ADDRESS_SLUG>@<EMAIL_INGEST_DOMAIN>`
   - **Action:** Send to Worker → `nexus-post-room`.

### 3. Provision secrets

Generate a random HMAC secret (32 hex bytes):

```sh
python -c "import secrets; print(secrets.token_hex(32))"
```

Set it both here and in the backend env (`EMAIL_INGEST_HMAC_SECRET`):

```sh
wrangler secret put EMAIL_INGEST_HMAC_SECRET
# paste the secret when prompted

wrangler secret put EMAIL_INGEST_API_URL
# paste: https://api.example.com/ingest/email
```

### 4. Backend env

In `deploy/env/env-prod-backend` (from `.example`):

```env
EMAIL_INGEST_ENABLED=true
EMAIL_INGEST_HMAC_SECRET=<same secret as above>
EMAIL_INGEST_ADDRESS_SLUG=<local-part, e.g. letters-abc123>
EMAIL_INGEST_DOMAIN=<mail.example.com>
EMAIL_INGEST_OWNER_USER_ID=<prod-user-uuid>
```

Run `deploy/hetzner/sync-env.sh` to push the env.

### 5. Deploy the worker

```sh
cd deploy/cloudflare/email-worker
wrangler deploy
```

### 6. Smoke test

Forward one newsletter to `<slug>@<domain>` and confirm it appears in your
default library as a `web_article` within normal ingest latency (~30 s).

## Rotation

To rotate the ingest address (slug):

1. Update `EMAIL_INGEST_ADDRESS_SLUG` in the backend env and redeploy.
2. Update the Cloudflare Email Routing rule to the new address.
3. The old slug is immediately invalid; no grace period.

The HMAC secret rotation follows the same pattern: update both the worker
secret (`wrangler secret put`) and the backend env, then redeploy both.

## Security

- **HMAC** — the raw body is HMAC-SHA256-signed with a shared secret before
  POST. The endpoint verifies this before any MIME parsing (constant-time
  compare). A leaked endpoint URL without the secret cannot ingest mail.
- **Slug** — the recipient slug is a rotatable capability secret. A leaked
  slug lets anyone send mail to the address, but not to forge the HMAC. The
  blast radius is bounded: every message is size-capped (2 MB), Message-ID
  deduped, and junk shows up as a deletable failed media.
- **Size cap** — messages > 2 MB are bounced at the worker AND re-checked at
  the endpoint (never trust the transport).

## HMAC algorithm

`HMAC-SHA256(raw_mime_bytes, EMAIL_INGEST_HMAC_SECRET)` — hex-encoded,
transmitted in `X-Nexus-Email-Signature`. The endpoint verifies with
`hmac.compare_digest`.
