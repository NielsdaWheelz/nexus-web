# deploy auth smoke misparses quoted environment urls

status: open · origin: 2026-09-15, pr #261 owned release · area: deployment inputs

## evidence

`deploy/hetzner/deploy.sh:634–635` extracts `FASTAPI_BASE_URL` and
`NEXT_PUBLIC_SUPABASE_URL` with raw `awk -F=`. outer quotes remain in the
arguments passed to auth smoke, unlike the quote-aware environment reader in
`deploy/supabase/verify-auth-config.sh`.

the first owned deployment of `06677a684ba7e30bab987319d11e5dd45537ac37`
with `--no-database-backup` ran at 17:11:27–17:11:36 utc and exited 1.
supabase auth verification passed, then smoke rejected
`--supabase-url must be a Supabase project origin` and deployment reported
`staged frontend auth smoke failed before host activation`. owned inspection
reported status `new`, phase `null`, and current source
`a1f59a755c91bdc22e77e33c12b93dde829a8e6e`.

private mac receipts: `/tmp/nexus-release-255/deploy-06677a68.log`,
`deploy-06677a68-operator-receipt.json`, and
`deploy-06677a68-env-normalization.json`. both frontend url values had outer
double quotes. a separate task-private input removes only those syntactic
quotes; decoded urls and every other line remain identical. this permits a
same-source replay without repairing the frozen deployment code.

## prerequisites and fix

change source after the active release freeze. reuse the existing environment
reader and quote-decoding semantics through one shared deployment-input owner;
feed its parsed origins to both verification and auth smoke. replace the raw
awk extraction, including the api url consumed after alias promotion. retain
strict origin validation and do not execute environment files as shell code.

## acceptance

a cheap deterministic kernel regression, run through `./scripts/test`, proves
that bare, single-quoted, and double-quoted valid url values produce identical
smoke arguments while malformed origins remain rejected. verification and
smoke consume the same parsed values. no hosted smoke or deployment harness is
added to the automated test portfolio.
