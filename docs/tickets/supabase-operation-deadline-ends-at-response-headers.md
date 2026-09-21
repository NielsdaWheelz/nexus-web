# supabase operation deadline ends at response headers

status: open · origin: 2026-09-21 auth audit / server-fetch review · area: web auth

`apps/web/src/lib/supabase/client-config.ts:23-38` gives sdk fetches a shared
five-second budget, but clears each abort timer when fetch returns headers.
the sdk reads the body afterward. a stalled body can therefore hold refresh,
callback or sign-in beyond the advertised operation deadline. the separate
two-second race in `lib/auth/dal.ts` bounds verification's caller, not this
underlying transfer. source-confirmed; no hosted provider stall was induced.

fix: give the full sdk operation an owned deadline that covers body transfer
and preserves exact dependency-failure classification. avoid adding another
independent timer or changing the verifier's budget incidentally.

acceptance: a controlled provider sends headers then stalls; every affected
operation terminates within its budget, aborts transfer and preserves browser
credentials on dependency failure. normal cookie publication still completes;
pass `./scripts/test` and delete the temporary probe.
