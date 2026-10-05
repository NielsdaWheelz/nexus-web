# Consumption Activity

## Scope

Consumption Activity is Nexus's personal observed-history capability. It owns
bounded reading, listening, and video-pane spans; client delivery;
exact-session exclusion and restore; first observed canonical completion facts; and the factual `/stats` and
session reads. It does not own
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
- Reading requires the eligible focused reader/input state in a visible tab.
  Listening follows the sole platform audio owner (the global browser audio
  element off Android, the native Media3 service in the Android shell) and
  counts while audio plays, hidden tab or not: audio is the evidence, not focus.
  Viewing is focused, visible video-pane time, not verified provider playback.
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
| Viewer-locked write transactions and replayed commands | `python/nexus/services/consumption/__init__.py` |
| Span ingest | `python/nexus/services/consumption/activity.py` (route: `api/routes/playback.py`) |
| Exclusion writes | `python/nexus/services/consumption/exclusions.py` |
| Current state writes, completion facts and public reads | `python/nexus/services/consumption/service.py` |
| Aggregation, filtering, sessions and the Stats and Sessions payloads | `python/nexus/services/consumption/stats.py` |
| The read-state derivation | `python/nexus/services/consumption/projection.py` |
| Strict transport shapes | capture in `python/nexus/schemas/consumption.py`, stats and exclusions in `consumption_activity.py`; the web reads them as generated wire types |
| Browser capture | `apps/web/src/lib/consumption/activityRecorder.ts` |
| Browser delivery | `activityUploader.ts` (in memory) |
| Android listening capture | `playback/ListeningRecorder.kt` |
| Android listening durability | `playback/ActivityOutbox.kt` |
| Presentation | authenticated Stats pane; shared manual continuation lifecycle in `apps/web/src/lib/api/useCursorPagination.ts` |

## Boundaries

`POST /consumption/activity` is the observation endpoint. The browser BFF
alone injects the private `nx_device`, overwriting any client value, and bounds a
batch at 48,000 bytes; FastAPI is the sole validator of the body. Each
span's `captureKey` provides fact identity, so a retried batch inserts nothing
and a reused key with different facts conflicts.

`POST /consumption/activity-exclusions` is a strict replayable `Exclude |
Restore` lifecycle union. Exclude names one exact, un-clipped session by media,
modality, sealed device handle, and interval. Restore names one sealed exclusion
handle. The service resolves viewer ownership, re-derives the session inside
the write transaction, and memoizes the result under
`Consumption.ActivityExclusions`. No command accepts a duration.

`GET /consumption/stats` and `GET /consumption/sessions` are private,
`no-store` factual reads. finite requests supply exact `YYYY-MM-DD` start and
exclusive end dates in `timeZone`; timestamp and numeric inputs are rejected.
one service resolver and calendar buckets share the existing sql three-hour
midnight rule. the resolved Scope remains utc instants; absent start remains
`None`, with the existing utc floor used by activity queries. equivalent
canonical browser-issued utc scopes retain their cursor identity.

equal civil dates and dates the zone skips entirely return empty facts,
sessions and buckets. unrepresentable endpoints or derived edges are refused
before driver decoding; thirty-minute context expansion saturates at datetime
bounds. timeline instants encode utc. PostgreSQL owns range and bucket edges
and local day/hour aggregation; Python ZoneInfo retains zone validation,
streak today, timeline labels/offsets and device first-seen dates. these retained
projections agree on the verified named calendar fixtures. session device
summaries are required because every session is observed. raw device ids and
span payloads never reach presentation.
both embedded and continuation session pages use the same `items,nextCursor` contract.
The Stats pane binds a session continuation to the exact committed Stats path
and decoded URL state, never the still-pending requested view. The shared manual
cursor owner atomically adopts first-page rows, cursor, loading, and expected
request failure; it aborts and generation-rejects an older continuation when a
new first page commits. A failed continuation preserves committed rows and
offers Retry. Owned cursor absence remains `Presence<string>` until the
pagination adapter unwraps it.

The browser recorder has one tab-local owner. Reader, non-Android global-audio,
and visible-video adapters publish observations to it; none persists, retries,
or sends its own request. Closed spans go to an in-tab uploader that batches by
(media, modality, device class) in occurrence order (≤ 120 spans, ≤ 40 kB),
retries network, 408, 429 and 5xx failures with backoff, drops a batch any other
refusal answers, and hands what it holds to the browser with `keepalive` on
pagehide. Spans of a tab closed while offline are lost; capture cannot be
paused. Android listening is durable: the service writes spans to a json outbox
file and uploads them oldest first when the network returns.

Current state remains separate: `reader_media_state`,
`reader_engagement_states`, and `podcast_listening_states` serve resume,
progress, and heartbeat behavior. `ResetProgress` replaces only current state;
it preserves activity spans and completion facts. Historical reads re-check
current media visibility. Media teardown removes exclusions and both fact
families through Consumption before deleting the parent media row.

## Operations

Real-PostgreSQL proof owns replay, exclusions, filtering, teardown, and
deterministic projection. There is no rollup or cache.

## Non-goals

No positive manual entry, timer, import, external-app or physical-book tracking,
raw interaction log, stored session, second device identity, sharing/export,
partial-span editing, genre taxonomy, badge, or LLM reflection exists in this
capability. Progress, completion, and Library time estimates never fabricate
observed duration.
