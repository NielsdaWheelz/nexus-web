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
- vercel WAF (cleanup/share-bytes-waf-limit, commit "give share byte reads their own rate
  limit"): byte reads (`/file`, `/assets/{n}`) get their own 600-a-minute rule; the existing
  120 rule now excludes them. apply before or with the deploy (the paths do not change).
  the project must allow two rate-limit rules (hobby allows one, pro forty). from
  `apps/web` (linked project, authenticated cli), stage both, then publish once, so byte
  reads are never unlimited between the two changes:
  - `vercel firewall rules add --json "$(cat ../../deploy/vercel/firewall/resource-sharing-bytes.json)" --yes`
  - `vercel firewall rules edit "Nexus public resource sharing" --json "$(cat ../../deploy/vercel/firewall/resource-sharing.json)" --yes`
  - `vercel firewall diff` (one rule added, one gaining the negated byte-path condition and
    the new description), then `vercel firewall publish --yes`.
  - check: `vercel firewall rules list --expand` shows both active with the files'
    conditions and limits (120, 600; fixed window 60 s, ip, deny), and the smoke below
    opens the large pdf and every epub image with no 403.
- gate changes (every one loosens but the vacuous `video_transcript` arm): publisher-
  transcribed podcast episodes become link-shareable; an epub needs a fragment instead of
  an `epub_fragment_sources` section.
- preflight census on the rehearsal restore:
  - `SELECT mts.transcript_origin, count(*) FROM media m JOIN media_transcript_states mts
    ON mts.media_id = m.id WHERE m.kind = 'podcast_episode' GROUP BY 1` (episodes that become
    shareable: `Publisher`; NULL-origin episodes stay unshareable).
  - the `video_transcript` census is the ingest release's (`release-ingest.md`; its 0282
    refuses any such attempt).
- owner smoke: a public link to an epub with images and a footnote (images appear; the
  footnote and a cross-chapter link move inside the reader), a large pdf (one `bytes=0-`
  stream and at most a few chunk ranges, all 206 with no cookie on them, signed in or not;
  nothing more once the stream lands), a highlight share, a publisher-
  transcribed episode (the Share overlay offers "Public link"), and a revoked link
  ("Share unavailable").
