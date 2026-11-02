# episode duration overflows int4 in milliseconds

`pe.duration_seconds * 1000` multiplies in int4. an episode longer than about 24.8
days raises in postgres, so the whole read fails for that viewer rather than one row.

evidence: `python/nexus/services/podcasts/episodes.py:43` feeds
`source_duration_ms` into `python/nexus/services/offline_catalog.py:232`.
`python/nexus/services/consumption/projection.py:52` has the same expression.
observed on 2026-11-01 at `fdd17ffd2`: `GET /offline-catalog` returned 500 once a
lab seed gave an episode a fabricated duration that long. in lab runs
`20261101-142007-e8895e5486e3` and `20261101-142607-c3b0b161612f`,
`GET /podcasts/{id}/episodes` returned 500 `integer out of range` from `episodes.py:43`
and the show's detail pane fell to `this pane stopped unexpectedly`.

impact: one feed reporting milliseconds in `itunes:duration` can break the offline
catalog for every subscriber of that show, and one overlong episode kills that show's
detail pane. no such feed is known.

fix: cast to bigint at each expression, or bound durations at ingest.

resolved when an episode with `duration_seconds` above 2147483 exports and lists.
