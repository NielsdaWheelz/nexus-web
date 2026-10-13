# release: api edge (streams behind the bff, one wire revision)

The commit "move streams behind the bff and gate every request on one wire
revision" changes every client request: each carries `X-Nexus-Wire: 1`, the api
refuses a missing or different one with 426 before routing, live streams go
through `/api/stream/...` on the web origin, and the device is a header the bff
stamps. Production sends no wire header today, so `WIRE_REVISION = 1` refuses
every pre-campaign client; no slice bumps it during the campaign.

## preflight

1. **vercel duration (owner).** Confirm fluid compute is on for the project, so
   `maxDuration = 300` deploys on `app/api/stream/[...path]` and
   `app/api/media/[id]/reading-copy`. If it cannot be: set both to 60 and
   `LONG_MS` in `apps/web/src/lib/api/proxy.ts` to 50_000, and accept a
   reconnect a minute per open stream; reading copies over ~50 s then fail.
2. **podcasts in prod (owner).** Confirm prod's current `PODCASTS_ENABLED`. If
   it was false, podcast routes become reachable for the first time; without
   PodcastIndex keys a podcast search answers 503 with copy.
3. **email ingest.** `/ingest/email` now answers 503 unless
   `EMAIL_INGEST_HMAC_SECRET`, `EMAIL_INGEST_ADDRESS_SLUG`,
   `EMAIL_INGEST_DOMAIN` and `EMAIL_INGEST_OWNER_USER_ID` are all set (it was
   404 while `EMAIL_INGEST_ENABLED` was false); the profile shows the address
   when slug and domain are set.

## env

- hetzner (`deploy/env/env-prod-backend`): add `NEXUS_HANDLE_KEY` = the current
  `STREAM_TOKEN_SIGNING_KEY` value, byte for byte (share asset handles, device
  handles and every sealed entity handle stay valid). Remove
  `STREAM_TOKEN_SIGNING_KEY`, `STREAM_BASE_URL`, `PODCASTS_ENABLED`,
  `EMAIL_INGEST_ENABLED` and `NEXUS_FABLE_RETENTION_ACCEPTED_AT`; from the
  shared `deploy/env/env-prod`, remove `STREAM_CORS_ORIGINS`. Run
  `deploy/hetzner/sync-env.sh` (it now requires `NEXUS_HANDLE_KEY`). The api
  refuses to boot in staging/prod without a strict-base64 key of 32+ bytes.
- vercel: remove `STREAM_CORS_ORIGINS` (no longer required by
  `deploy/vercel/sync-env.sh`). `FASTAPI_BASE_URL` stays (the bff's upstream);
  it must be an https origin, checked when the build resolves its env.

## order

1. Owner opens the phone app online and waits for "synced": the pre-release apk
   treats 426 as final and would drop queued listening writes and activity
   batches.
2. Deploy the api, then the web, back to back. Between them every request
   answers 426; open tabs show the update copy and the workspace may show its
   error region.
3. Install the apk built from the release sha (it sends the wire, treats 426 as
   retryable and fetches reading copies from a signed url). Do not play on the
   phone between steps 2 and 3.
4. Install the signed extension built from the release sha (an old one answers
   "Update the Nexus extension to keep capturing.").

## caddy

`deploy/hetzner/Caddyfile` loses the reading-copy block (the copy is built by
`POST /media/{id}/reading-copy` and fetched from storage). The api origin needs
no browser exposure any more: only vercel and the operator reach it.

## storage

Reading copies are stored under `media/{media_id}/reading-copies/{uuid}.zip`,
owned by no row, so the storage orphan sweep reclaims them after its minimum
age (24 h; at most ~30 h). No lifecycle rule.

## release gates carried by the android slice

On a device or emulator with the release apk: J7, listening and activity queued
offline survive a 426 (simulate by pointing the debug apk at a server with
another `WIRE_REVISION`) and drain after the update; J8, an offline copy of an
epub and of a pdf downloads through `POST /api/media/{id}/reading-copy` and the
signed url, and opens offline.

## smoke after deploy

- a chat answer streams and survives a network toggle; a tab opened before the
  deploy reloads itself once;
- reader epub images and proxied images answer `private, max-age=86400`
  (devtools) and the second view is a cache hit;
- phone: listening sync and one offline copy (epub and pdf);
- one extension capture; one `/s` link with a pdf range request;
- vercel usage for the first week: every open media pane holds a metadata
  stream invocation that reconnects every 280 s
  ([metadata-stream-never-terminates](metadata-stream-never-terminates.md)).
