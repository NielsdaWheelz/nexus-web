# every podcast listening write moves the podcast collection families

status: open · origin: 2026-10-10 podcasts/browse web rewrite (spec D6) · area: consumption / collection revisions

`_PODCAST_FAMILIES` (`python/nexus/services/consumption/service.py:55-59`) is
bumped by `_bump` (`:590-592`) on every podcast listening write, which the
browser sends every 15 s while audio plays (`apps/web/src/lib/player/browserEngine.ts:58`).
That moves `PodcastEpisodes` and `PodcastSubscriptions` for the viewer, so any
podcast list continuation issued more than ~15 s after its first page answers
409 `E_COLLECTION_CHANGED`. Episode ingest and backfill bump the same families,
but since the 2026-10-10 python reauthor only for the show's audience and only
when an episode was inserted or changed (`services/podcasts/ingest.py`).

impact: while anything plays, Load more on a podcast list always costs a 409
and a prefix reload (`useServerList`, design T3). bounded, but wasted reads.

fix: bump the podcast families only when list membership or order can change
(state transitions, not position heartbeats), or retire the revisions with
keyset continuations (ticket `podcast-lists-need-keyset-continuations`).

acceptance: playing an episode for 20 s and then pressing Load more on a
130-episode show issues one continuation that answers 200 (harness D6 records
no 409).
