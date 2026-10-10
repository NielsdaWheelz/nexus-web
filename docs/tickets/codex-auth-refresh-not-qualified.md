# codex auth refresh not qualified

status: open · origin: 2026-09-25 latest-model cutover · area: codex host credentials

## problem and evidence

the host runs stock codex app-server 0.160.0 with the host-only account
directory writable, so native codex owns token refresh. no refresh of a real
credential has been observed. the codex host harness (2026-10-10, journey C10)
witnesses the mechanics against a fake `auth.openai.com`: with an expired access
token, the next turn makes codex post `grant_type=refresh_token` to
`/oauth/token` through the egress allowlist; it rewrites `auth.json` (in place,
see [codex-auth-json-rewritten-in-place](codex-auth-json-rewritten-in-place.md)),
keeps it `0600` uid 10001, and the host accepts it after a restart. a live
access token that is merely old (30-day `last_refresh`) is not refreshed.

what remains is the real token rotation: that openai accepts the refresh and
the rotated refresh token keeps working. forcing refresh on a byte copy of the
live profile could rotate the shared remote refresh token and strand the
original, so that is not a safe fixture.

## prerequisite and acceptance

with a near-expiry enrolled credential in a disposable profile, observe a real
refresh through the pinned app-server, then a turn on the rotated token after a
host restart.
