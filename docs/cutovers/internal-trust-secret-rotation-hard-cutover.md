# Internal Trust Secret Rotation Hard Cutover

**Status:** APPROVED SPEC · 2026-08-07

**Type:** Human-triggered hard cut. One secret, one cutover, no legacy value,
dual-secret grace period, fallback, or compatibility decoder.

## Problem and decision

`NEXUS_INTERNAL_SECRET` authenticates the trusted Next.js BFF → FastAPI hop via
`X-Nexus-Internal`. The value must never be present in access logs. Caddy now
deletes that request header from its global access-log record before emission;
the existing value is nevertheless treated as compromised and is rotated.

The new value is published to Vercel production configuration and the VPS
content-addressed configuration, then becomes live only through one exact
application release. The BFF and API therefore switch at one release boundary;
there is no period in which either side accepts both values.

## Owner and sequence

The release operator owns the cutover. `deploy/env/env-prod` remains the local
secret source; it is ignored, never committed, and never printed. The sequence
is serialized:

1. Confirm the deployed Caddyfile contains the global `X-Nexus-Internal`
   redaction filter and that a harmless probe value is absent from Caddy logs.
2. Generate a fresh cryptographically random value locally. Replace only
   `NEXUS_INTERNAL_SECRET` in the ignored shared env file; do not copy it into
   source, release records, shell history, or chat output.
3. From a clean checkout at exact `HEAD == origin/main`, run
   `deploy/vercel/sync-env.sh`. This updates Vercel's production snapshot and
   proves every non-sensitive value; the secret is verified only for presence.
4. Run `deploy/hetzner/sync-env.sh <source-sha>` for a never-published source
   SHA. It writes the new environment as one immutable content-addressed file
   and atomically advances `/etc/nexus/current.env`; it does not restart a
   service.
5. Run `deploy/hetzner/deploy.sh <source-sha>`. Candidate frontend auth smoke
   passes before host mutation; API/workers then restart with the new config;
   post-alias auth smoke, public health, and the immutable release record prove
   the cutover.
6. Verify the public source SHA and API readiness, and inspect logs for absence
   of the old value without displaying either value. Record only hashes,
   deployment IDs, and phase evidence.

## Failure and recovery

The old value is never restored after the new Vercel snapshot or VPS config is
published. A failure before a committed release is retried with the same exact
source SHA. A failure after backend activation follows the release controller's
durable forward-fix path; it is never repaired by a manual restart or by
re-introducing the compromised secret.

The cutover is complete only when Vercel and VPS hold the same new secret,
runtime health is proven, the exact source SHA is current, and no access-log
probe exposes the internal header. A later rotation repeats this sequence with a
new source SHA.
