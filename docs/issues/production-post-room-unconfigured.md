# production post room activation

status: open optional activation; not a release blocker
origin: 2026-10-15 book release, exact source `1c07b5ae`
area: email ingest / cloudflare worker

the fresh production config has none of the four required email-ingest inputs: hmac secret, address slug, domain or owner. the final api therefore answers `email_ingest_not_configured` (503), by `config.py:127` and `api/routes/email_ingest.py:41`. receipt: book campaign `coordinator/final1c07/email-configuration.json`.

the new email worker and actual delivery/defer behavior are unqualified. this release preserves the inactive feature; it does not provision an address or claim email acceptance.

prerequisites: owner address/domain choice and cloudflare worker/email-routing access. configure the four inputs and matching worker secrets through the documented publication owners, then deploy the exact worker source.

acceptance: ordinary mail lands once in the intended library; a temporary storage failure is deferred instead of bounced; the actual worker version and delivery evidence are retained. if cloudflare bounces the temporary failure instead, restore the bounce on 5xx and record it. see `deploy/cloudflare/email-worker/README.md`.
