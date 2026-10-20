# media reads take ~0.65 s in the refs harness, ~25x their earlier latency

status: open; measured, cause not located · origin: resource references re-slice port onto main, 2026-10-19 · area: media reads (api)

the refs harness keeps the api log of a run. on the slice's base `d6b73c712`
(`refs/harness/state/baseline-2-evidence/logs/api.log`) `GET /media/{id}` and
`GET /resource-items/media:{id}/actions` answered in a median 9-25 ms; on the port onto
`0c6da7f32` (`state/final-1-evidence/api.log`) the median is ~640 ms for every media
read: `GET /media/{id}` (638), the media actions (636), `GET /libraries/{id}/entries`
(671), `POST /media/summaries/resolve` (667), `GET /imports` (1,026), podcast episodes
(636). non-media reads did not move (highlight actions 3 ms). under a second host load
(`state/final-2-evidence/api.log`) the media actions reached 15 s and four journeys timed
out. afaict the cause is on main's media read path, not the re-slice: `GET /media/{id}`,
library entries, summaries and imports run no re-slice code; it was not bisected.

impact: every media list and pane read is slower; in production the size depends on
data volume, unmeasured here.

resolved when: the slow statement is located (bisect `d6b73c712..main` in the harness,
or `EXPLAIN ANALYZE` the media read) and media reads return to their earlier latency, or
the slowdown is shown to be the harness's alone.
