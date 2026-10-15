# release: atlas and public share links

## atlas (cleanup/atlas-share-reauthor, commit "reauthor the atlas")

2026-10-15: the ordinary production worker completed job
`0788364e-6d1b-45f1-9bf1-4a0647ea119d` on `83459f1b8`/schema `0287` in
10.774572 seconds, one attempt, with `positioned: 508`, no error and the lease
cleared. receipt: campaign `coordinator/final83459/worker-live/terminal-readback.json`,
sha256 `9b0e1203a9a9b5a52285ab6d8b2d6e782886a5e816e73f04f6a9b1849d76af1b`.
this closes the live worker run; the atlas ui and sharing checks below remain pending.

- no migration, no env change, no apk or extension change.
- python deps: `numpy` becomes a declared dependency (`python/pyproject.toml`); the locked
  wheel (2.5.3) is the one pgvector already pulled in. rebuild the backend image.
- wire: `AtlasEdgeOut` loses `origin` (no client read it). the final combined
  release uses `X-Nexus-Wire: 2`; web and api deploy together.
- preflight passed on the rehearsal restore at source `1c07b5ae543644f5c9f79ae72f54c43b2e77fcd7`:
  one real `project_all` took 10.23734 s and positioned 452 media under 448 mib,
  one cpu and the normal 30 s statement limit. rollback preserved the exact original
  500-row atlas hash. root receipt `coordinator/final1c07/atlas-rollback-v3/root-review.json`
  in the book-repair campaign artifacts is
  `1e3043981753f591238741b29279bf73d9e6f92e3c7d3290cbf22f0c8496a2ad`.
  this proves owner cost on that restore. the actual worker run above separately
  proves production execution and terminal lease cleanup, without a sampled heartbeat claim.
- the oracle panes now show transport copy for a gateway timeout, an unavailable upstream,
  a rate limit or a stale build, and "Something went wrong. Try again." with the request id
  for any other answer (a 503 `E_AUTH_UNAVAILABLE` while auth is down), instead of
  crashing to the pane boundary (shared `failureCopy`).
- owner smoke (pending): `/atlas` turns, Readings layer, a folio's two taps on a phone (the first
  shows its label), a failed load's Retry.

## public share links (cleanup/atlas-share-reauthor, commit "reauthor public share links")

- no migration, no env change, no apk or extension change (`/s` is a web page).
- web and api deploy together. hard cutover: an `/s` tab open across the deploy keeps its
  document but loses epub images until reloaded (its `nxpa1_` asset urls now 404 at the
  bff). handed-out links (`nxshr1_` tokens) are untouched and keep working.
- share asset fetches no longer depend on `NEXUS_HANDLE_KEY` (release-edge's key carry-over
  is still needed for the other sealed handles).
- vercel WAF: the owner deferred the higher byte-read allowance for this release;
  the existing 120/minute rule remains enabled for all share paths. this is not a
  release blocker; see [the disposition and remaining acceptance](../tickets/public-share-byte-rate-limit-plan.md).
  the intended future configuration (cleanup/share-bytes-waf-limit, commit "give share byte reads their own rate
  limit"): byte reads (`/file`, `/assets/{n}`) get their own 600-a-minute rule; the existing
  120 rule excludes them. apply only after the deferred change is admitted (the paths do not change).
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
