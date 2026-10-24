# long episode progress duration can overflow

status: open; source-confirmed, runtime reproduction pending.

`python/nexus/services/consumption/projection.py:30-31` multiplies postgres
`podcast_episodes.duration_seconds` by 1000 before promotion. that column is an
integer (`migrations/alembic/versions/0306_baseline_schema.sql:1520`). an episode
longer than 2,147,483 seconds with a listening row whose duration is null can
overflow the progress projection (`projection.py:103-107`) and fail composed reads.
the listening wire also admits only int32 milliseconds (`schemas/consumption.py:41`).

compact-facts duration qualification uses feed durations without listening rows
for extreme ranges; this proves formatting, not long-episode playback support.
backend/wire changes are outside that presentation change.

resolve at the duration owner: specify the supported range, use arithmetic and
wire/storage representations that preserve it, and qualify a real long-episode
listening update plus listing/summary reads. no clipping or fabricated duration.
