# Consumption Activity

## Scope

Consumption Activity is Nexus's personal observed-history capability. It owns
bounded reading, listening, and video-pane spans; durable client delivery;
add/exclude/retract corrections; first observed canonical completion facts;
capture/sync health; and the factual `/stats` and session reads. It does not
own the reader cursor, current reader engagement, audio heartbeat state, or
explicit consumption state. The current implementing cutover is
[`durable-consumption-activity-hard-cutover.md`](../cutovers/durable-consumption-activity-hard-cutover.md).

## Facts and semantics

- `consumption_activity_spans` stores bounded observed intervals. Active time
  is their additive duration; it is not de-duplicated wall-clock time. Each
  client-minted capture key identifies one semantic fact across regrouped
  retries.
- `consumption_activity_adjustments` stores additive manual time and exact
  observed-session exclusions. Retraction restores the prior projection;
  observed spans are never edited by correction.
- `consumption_completion_facts` stores the first post-cutover canonical
  `Finished` transition for one viewer/media. Exact completion Undo may remove
  the fact it created; ordinary later Unread and `ResetProgress` do not rewrite
  history.
- Reading requires the eligible focused reader/input state. Listening follows
  the sole platform audio owner: the global browser audio element off Android
  and the native Media3 service in the Android shell. Viewing is focused,
  visible video-pane time, not verified provider playback.
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
| Browser durability and health | `apps/web/src/lib/consumption/activityOutbox.ts` and `activityRuntime.ts` |
| Android listening capture | `apps/android/app/src/main/java/app/nexus/android/playback/NativeConsumptionRecorder.kt` |
| Android listening durability | `apps/android/app/src/main/java/app/nexus/android/playback/NativeActivityOutbox.kt` |
| Stats presentation | `apps/web/src/app/(authenticated)/stats/` |

`POST /consumption/activity` is a replayable `Consumption.Activity` mutation;
request identity remains `clientMutationId`, while each span's `captureKey`
provides regroupable fact identity. `POST /consumption/activity-adjustments`
owns replayable Add, Exclude, and Retract.
`GET /consumption/stats` and `GET /consumption/sessions` are private,
`no-store` factual reads. The BFF alone injects the httpOnly `nx_device` value;
browser requests and responses never expose it. Reads use sealed device handles
and safe labels only.

## Boundaries

The browser recorder has one tab-local owner. Reader, non-Android global-audio,
and visible-video adapters publish observations to it; none persists, retries,
or sends its own request. Closed spans commit to an account-scoped IndexedDB
outbox before delivery. Android listening bypasses the browser adapter and
commits to the service-owned SQLite outbox. Both stores retain Pending or
Failed rows across restart, enforce the same bounded capacity, and expose one
merged health vocabulary. Neither has a memory fallback.

Current state remains separate: `reader_media_state`,
`reader_engagement_states`, and `podcast_listening_states` serve resume,
progress, and heartbeat behavior. `ResetProgress` replaces only that current
state; it preserves activity spans and completion facts. Historical fact reads
re-check current media visibility and media teardown removes adjustments and
both fact families before parent deletion.

## Operations

Run `python -m nexus.ops.consumption_activity_counts` with the normal server
database configuration to print global counts for activity spans, completion
facts, adjustments, capture-key anomalies, and Consumption replay outcomes. It
is read-only. Capacity thresholds request an operator review; they are advisory
and never make the command fail. The command exits nonzero only when its count
query fails.

Stats and session reads emit privacy-safe `activity_projection_read` latency
and row-count fields. The real-Postgres ledger proof covers replay,
corrections, filtering, and deterministic projections; the read-only operator
command exposes cardinalities and observed query latency. No unverified latency
budget or speculative index is claimed for this one-user prototype.

## Non-goals

No rollup/cache, raw interaction log, stored session, second device identity,
sharing/export, generic timer, genre taxonomy, badges, or LLM reflection exists
in this capability. Year in Reading is deterministic presentation over the
same living facts.
