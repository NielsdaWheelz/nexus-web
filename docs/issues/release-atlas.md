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

## public share links (cleanup/atlas-share-reauthor, commit "reauthor public share links")

- no migration, no env change, no apk or extension change (`/s` is a web page).
- web and api deploy together. hard cutover: an `/s` tab open across the deploy keeps its
  document but loses epub images until reloaded (its `nxpa1_` asset urls now 404 at the
  bff). handed-out links (`nxshr1_` tokens) are untouched and keep working.
- share asset fetches no longer depend on `NEXUS_HANDLE_KEY` (release-edge's key carry-over
  is still needed for the other sealed handles).
- gate changes (every one loosens but the vacuous `video_transcript` arm): publisher-
  transcribed podcast episodes become link-shareable; an epub needs a fragment instead of
  an `epub_fragment_sources` section.
- preflight census on the rehearsal restore:
  - `SELECT mts.transcript_origin, count(*) FROM media m JOIN media_transcript_states mts
    ON mts.media_id = m.id WHERE m.kind = 'podcast_episode' GROUP BY 1` (episodes that become
    shareable: `Publisher`; NULL-origin episodes stay unshareable).
  - `SELECT count(*) FROM media_source_attempts WHERE source_type = 'video_transcript'` must
    be 0 (the ingest slice's migration refuses otherwise; the gate no longer admits them).
- owner smoke: a public link to an epub with images and a footnote (images appear; the
  footnote and a cross-chapter link move inside the reader), a large pdf (one `bytes=0-`
  stream and at most a few chunk ranges, all 206 with no cookie on them, signed in or not;
  nothing more once the stream lands), a highlight share, a publisher-
  transcribed episode (the Share overlay offers "Public link"), and a revoked link
  ("Share unavailable").
