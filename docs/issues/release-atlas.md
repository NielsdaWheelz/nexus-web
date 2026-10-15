# release: atlas and public share links

## atlas (cleanup/atlas-share-reauthor, commit "reauthor the atlas")

- no migration, no env change, no apk or extension change.
- python deps: `numpy` becomes a declared dependency (`python/pyproject.toml`); the locked
  wheel (2.5.3) is the one pgvector already pulled in. rebuild the backend image.
- wire: `AtlasEdgeOut` loses `origin` (no client read it). no `X-Nexus-Wire` bump: web and
  api deploy together.
- preflight on the rehearsal restore: time one `project_all` (issue
  `atlas-sweep-cost-unmeasured`).
- after deploy: run `atlas_project_job` once (or wait for the 86,400 s period) and read
  `{"positioned": n}` and its duration from the job row. every position is rewritten; values
  change only by float rounding (≤ 1e-15), so no star moves visibly.
- the oracle panes now show transport copy for a gateway timeout, an unavailable upstream,
  a rate limit or a stale build, and "Something went wrong. Try again." with the request id
  for any other answer (a 503 `E_AUTH_UNAVAILABLE` while auth is down), instead of
  crashing to the pane boundary (shared `failureCopy`).
- owner smoke: `/atlas` turns, Readings layer, a folio's two taps on a phone (the first
  shows its label), a failed load's Retry.
