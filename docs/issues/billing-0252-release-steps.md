# billing deletion (0252) needs owner steps around the release

status: open · origin: 2026-09-28 cleanup pr-03 (#404, delete billing) · area: release / billing

`migrations/alembic/versions/0252_delete_billing.py` irreversibly drops
`billing_accounts`, `billing_entitlement_overrides`, `stripe_webhook_events`,
`podcast_transcription_usage_daily`, three `podcast_transcription_jobs`
columns and the `/settings/billing` palette history. the release backup is the
only copy. stripe stays the system of record for payments, but a live
subscription and the webhook endpoint outlive the code.

recorded read-only on production, 2026-09-28, at alembic 0241 (the same six counts:
billing_accounts, billing_entitlement_overrides, stripe_webhook_events,
podcast_transcription_usage_daily, failed_quota transcript states, billing palette usages):
`0, 1, 0, 0, 0, 0`. the one override is the owner's `ai_pro` with unlimited transcription
(no expiry, not revoked), so the old backend already lets the owner share and transcribe.
no stripe customer, subscription or webhook event was ever recorded, so the dropped data
is that one override row. of the three users, one is the system user and one is a dormant
account with only its default library. after the release, every account holds every
capability.

cancelling stripe does not depend on the release: entitlements come from the override,
not from a subscription row.

after the release:

1. delete the stripe webhook endpoint (it now 404s and stripe would retry), and
   confirm stripe has no active subscription (the owner cancels it).
2. once the rollback window closes, remove `BILLING_ENABLED`, `STRIPE_*` and
   `BILLING_AI_*` from `deploy/env/env-prod-backend` and re-run
   `deploy/hetzner/sync-env.sh`. not earlier: a pre-#404 image defaults
   `BILLING_ENABLED=true` and in production demands all five `STRIPE_*` keys.

acceptance: stripe shows no active subscription and
no webhook endpoint, and `env-prod-backend` holds no billing or stripe keys.
delete this ticket then.
