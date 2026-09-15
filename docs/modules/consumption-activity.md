# Consumption Activity

## Scope

Consumption Activity is Nexus's personal observed-history capability. It owns
bounded reading, listening, and video-pane spans; durable client delivery;
exact-session exclusion and restore; first observed canonical completion facts;
capture/sync health; and the factual `/stats` and session reads. It does not own
the reader cursor, current reader engagement, audio heartbeat state, explicit
consumption state, or user-authored time. The implementing cutover is
[`observed-consumption-activity-hard-cutover.md`](../cutovers/observed-consumption-activity-hard-cutover.md).

## Facts and semantics

- `consumption_activity_spans` is the sole positive-duration fact family. It
  stores bounded observations; stable client capture keys make regrouped retry
  idempotent.
- `consumption_activity_exclusions` stores a viewer's decision not to count one
  exact observed gap-and-island session. Restore reactivates the underlying
  spans; neither operation edits or creates observation facts.
- `consumption_completion_facts` stores the first post-cutover canonical
  `Finished` transition for one viewer/media. Exact completion Undo may remove
  the fact it created; ordinary later Unread and `ResetProgress` do not rewrite
  history.
- Reading requires the eligible focused reader/input state. Listening follows
  the sole platform audio owner: the global browser audio element off Android
  and the native Media3 service in the Android shell. Viewing is focused,
  visible video-pane time, not verified provider playback.
- Sessions are read-time projections over spans, never stored rows or browser
  identities. Forward word/media-position change is a cursor delta, not unique
  consumption.
- Retained highlights, note blocks, and neutral Links remain their own source
  rows. Their Stats counts are current retained facts, not immutable activity.

For every Stats query:

```text
recordedActiveMs = accepted visible observed duration
excludedActiveMs = recorded duration removed by active exclusions
activeMs         = recordedActiveMs - excludedActiveMs
```

All breakdowns, sessions, streaks, and Year presentation derive from effective
`activeMs`. There is no manual or alternate observed-time projection.

## Owners

| Concern | Owner |
| --- | --- |
| Span and exclusion DML | `python/nexus/services/consumption/_activity_store.py` |
| Replayable writes and public reads | `python/nexus/services/consumption/service.py` |
| Aggregation, filtering, sessions | `python/nexus/services/consumption/_activity_stats.py` |
| Completion policy | `python/nexus/services/consumption/_policy.py` |
| Strict transport shapes | Python activity schema and web Consumption decoders |
| Browser capture | `apps/web/src/lib/consumption/activityRecorder.ts` |
| Browser durability and health | `activityOutbox.ts` and `activityRuntime.ts` |
| Android listening capture | `NativeConsumptionRecorder.kt` |
| Android listening durability | `NativeActivityOutbox.kt` |
| Presentation | authenticated Stats pane; shared manual continuation lifecycle in `apps/web/src/lib/api/useCursorPagination.ts` |

## Boundaries

`POST /consumption/activity` is the unchanged replayable observation endpoint.
The browser BFF alone injects the private `nx_device`; each span's `captureKey`
provides fact identity.

`POST /consumption/activity-exclusions` is a strict replayable `Exclude |
Restore` lifecycle union. Exclude names one exact, un-clipped session by media,
modality, sealed device handle, and interval. Restore names one sealed exclusion
handle. The service resolves viewer ownership, re-derives the session inside
the write transaction, and memoizes the result under
`Consumption.ActivityExclusions`. No command accepts a duration.

`GET /consumption/stats` and `GET /consumption/sessions` are private,
`no-store` factual reads. Session device summaries are required because every
session is observed. Raw device IDs and span payloads never reach presentation.
The Stats pane binds a session continuation to the exact committed Stats path
and decoded URL state, never the still-pending requested view. The shared manual
cursor owner atomically adopts first-page rows, cursor, loading, and expected
request failure; it aborts and generation-rejects an older continuation when a
new first page commits. A failed continuation preserves committed rows and
offers Retry. Same-system decoder failures remain defects, and owned cursor
absence remains `Presence<string>` until the pagination adapter unwraps it.

The browser recorder has one tab-local owner. Reader, non-Android global-audio,
and visible-video adapters publish observations to it; none persists, retries,
or sends its own request. Closed spans commit to an account-scoped IndexedDB
outbox before delivery. Android listening commits to the service-owned SQLite
outbox. Both retain Pending or Failed rows across restart, enforce the same
bounded capacity, and expose one merged health vocabulary. Neither has a memory
fallback.

Current state remains separate: `reader_media_state`,
`reader_engagement_states`, and `podcast_listening_states` serve resume,
progress, and heartbeat behavior. `ResetProgress` replaces only current state;
it preserves activity spans and completion facts. Historical reads re-check
current media visibility. Media teardown removes exclusions and both fact
families through Consumption before deleting the parent media row.

## Operations

Run `python -m nexus.ops.consumption_activity_counts` with normal server
database configuration to print global counts for spans, completion facts,
exclusions, capture-key anomalies, and Consumption replay outcomes. It is
read-only. Advisory capacity thresholds never make the command fail; query
failure does.

Stats and session reads emit privacy-safe `activity_projection_read` latency
and row-count fields. Real-PostgreSQL proof owns replay, exclusions, filtering,
teardown, and deterministic projection. There is no rollup or cache.

## Non-goals

No positive manual entry, timer, import, external-app or physical-book tracking,
raw interaction log, stored session, second device identity, sharing/export,
partial-span editing, genre taxonomy, badge, or LLM reflection exists in this
capability. Progress, completion, and Library time estimates never fabricate
observed duration.
