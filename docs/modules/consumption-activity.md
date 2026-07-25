# Consumption Activity

## Scope

Consumption Activity is Nexus's personal observed-history capability. It owns
bounded reading, listening, and video-pane spans; first observed canonical
completion facts; and the factual `/stats` and session reads. It does not own
the reader cursor, current reader engagement, audio heartbeat state, queue, or
explicit consumption state. The implementing cutover is
[`consumption-activity-stats-hard-cutover.md`](../cutovers/consumption-activity-stats-hard-cutover.md).

## Facts and semantics

- `consumption_activity_spans` stores bounded observed intervals. Active time
  is their additive duration; it is not de-duplicated wall-clock time.
- `consumption_completion_facts` stores the first post-cutover canonical
  `Finished` transition for one viewer/media. Exact completion Undo may remove
  the fact it created; ordinary later Unread does not rewrite history.
- Reading requires the eligible focused reader/input state. Listening follows
  the owned global audio element. Viewing is focused, visible video-pane time,
  not verified provider playback.
- Sessions are read-time gap-and-island projections over spans, never stored
  rows or browser identities. Forward word/media-position change is a cursor
  delta, not unique consumption.
- Retained highlights, note blocks, and neutral Links remain their own source
  rows. Their Stats counts are current retained facts, not immutable activity.

## Owners

| Concern | Owner |
| --- | --- |
| Fact-table DML | `python/nexus/services/consumption/_activity_store.py` |
| Replayable activity operation and public reads | `python/nexus/services/consumption/service.py` |
| Aggregation, filtering, and derived sessions | `python/nexus/services/consumption/_activity_stats.py` |
| Completion policy | `python/nexus/services/consumption/_policy.py` |
| Strict transport shapes | `python/nexus/schemas/consumption_activity.py` and `apps/web/src/lib/consumption/activityContract.ts` |
| Browser capture | `apps/web/src/lib/consumption/activityRecorder.ts` |
| Stats presentation | `apps/web/src/app/(authenticated)/stats/` |

`POST /consumption/activity` is a replayable `Consumption.Activity` mutation.
`GET /consumption/stats` and `GET /consumption/sessions` are private,
`no-store` factual reads. The BFF alone injects the httpOnly `nx_device` value;
browser requests and responses never expose it. Reads use sealed device handles
and safe labels only.

## Boundaries

The recorder has one tab-local owner. Reader, global-audio, and visible-video
adapters publish observations to it; none sends its own request or writes
operational telemetry. Capture is bounded and best-effort: an unavailable or
ambiguous interval is omitted rather than guessed or persisted for later retry.

Current state remains separate: `reader_media_state`,
`reader_engagement_states`, and `podcast_listening_states` serve resume,
progress, and heartbeat behavior. Historical fact reads re-check current media
visibility and media teardown removes both fact families before parent deletion.

## Operations

Run `python -m nexus.ops.consumption_activity_counts` with the normal server
database configuration to print global counts for activity spans, completion
facts, and `Consumption.Activity` replay rows. It is read-only. The 500,000
span and 100,000 activity-replay thresholds request an operator capacity review;
they are advisory and never make the command fail. The command exits nonzero
only when its count query fails.

The one-user Stats read budget is 500 ms on the modest Postgres fixture covered
by `python/tests/test_consumption_activity_operations.py`. The fixture runs
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the timeline, session, and
completion relations. It detects query regressions before an index is justified;
no speculative index is maintained for this prototype.

## Non-goals

No backfill, rollup/cache, durable browser queue, raw interaction log, stored
session, second device identity, sharing/export, genre taxonomy, badges, or LLM
reflection exists in this capability. Year in Reading is deterministic
presentation over the same living facts.
