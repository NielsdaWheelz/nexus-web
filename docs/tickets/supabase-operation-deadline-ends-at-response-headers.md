# supabase operation deadline ends at response headers

status: open · origin: 2026-09-21 auth audit / server-fetch review · area: web auth

`apps/web/src/lib/supabase/client-config.ts:23-38` gives sdk fetches a shared
five-second budget, but clears each abort timer when fetch returns headers.
the sdk reads the body afterward. a stalled body can therefore hold refresh,
callback or sign-in beyond the advertised operation deadline. the separate
two-second race in `lib/auth/dal.ts` bounds verification's caller, not this
underlying transfer. source-confirmed; no hosted provider stall was induced.

additional actual qualification, 2026-10-02: a held loopback refresh request
aborts at the configured five-second fetch budget, but auth-js 2.108.2
`dist/main/GoTrueClient.js:3896-3921` converts that abort to a retryable fetch
failure and continues exponential local backoff within its 30-second refresh
retry window. initial observation established retry continuation; the completed
`explicit-deadline` cell in
`/tmp/nexus-auth-startup.E0TlcS/credential.receipt.json` measured 17,605 ms before
`AuthRetryableFetchError`, one actual provider request and zero cookie writes.
later fetch attempts were rejected after the shared budget without network.
this uses the actual locked sdk and client fetch wrapper with synthetic
credentials and a loopback provider, not hosted auth. the configured fetch
budget does not bound full sdk settlement, even without a stalled response body.
the later `current-operation.receipt.json` in the same directory measured actual
link completion at 17,614 ms directly versus 17,609 ms after `getSession`;
same-token failure caching prevented a second retry window. no additional
pre-read latency defect is claimed.

fix: give the full sdk operation an owned deadline that covers body transfer
and sdk retry/backoff, and preserves exact dependency-failure classification.
the credential-input cleanup must state any readiness-join latency; this ticket
does not authorize expanding that cleanup into a deadline repair. avoid adding another
independent timer or changing the verifier's budget incidentally.

acceptance: a controlled provider sends headers then stalls; every affected
operation terminates within its budget, including retryable abort/backoff,
aborts transfer and preserves browser
credentials on dependency failure. normal cookie publication still completes;
pass `./scripts/test` and delete the temporary probe.
