# Consumption Activity and Stats Hard Cutover

**Status:** IMPLEMENTED AND VERIFIED · 2026-07-24
**Type:** Hard cutover — no legacy session model, dual capture, fallback read,
compatibility payload, feature flag, backfill, or aggregate cache.

The whole of [`docs/rules/index.md`](../rules/index.md) governs this cutover.
The rules with the most direct design consequences are boundaries, cleanliness,
codebase, concurrency, database, frontend, keys and identities, operation
types, resource lifecycle, retries, simplicity, testing, and timing.

## Council verdict

Questions requiring a user answer: none.

The product need is real, but the first draft's storage and replay design was
not approvable. This validated design ships one Consumption-owned history
capability, one factual **Stats** surface, and one living **Year in Reading**
view. Deterministic queries and presentation own the complete first cutover.

This cutover supersedes only the “no session/device/span/dwell history” target
in
[`default-library-virtualization-and-transient-state-pruning-hard-cutover.md`](default-library-virtualization-and-transient-state-pruning-hard-cutover.md)
and its current-state echoes. It does not revive `reading_sessions`,
`services/attention.py`, JSON span arrays, attention-derived read state, or any
other machinery from
[`attention-ledger-hard-cutover.md`](attention-ledger-hard-cutover.md).

### Adversarial decisions

| Rejected draft premise | Validated decision |
|---|---|
| One `Span | Completion` table is “one ledger.” | Span and completion have different required fields, write paths, query behavior, and uniqueness. Store them in two coherent fact tables under one Consumption capability. |
| Client event IDs can replace operation replay. | The activity POST is a replayable mutation with one payload-owned `clientMutationId`; the current Consumption command pattern and `resource_mutations` own exact response memoization and stable retry behavior. Span row IDs are not wire data. |
| A client session ID is a durable fact. | A session is a query-time gap-and-island projection over spans. Derive it on the server; do not store a session ID or coordinate session state through `localStorage`. |
| Focused YouTube embed time is “watching.” | The observable fact is **video-pane time**. Persist modality `Viewing` and never label it verified playback or watch time. |
| Document-global word ordinals already exist. | Stored fragment/section word counts exist, but global prefix ordinals do not. Extend the canonical text owner and prove browser/database word-policy parity before capture ships. |
| Existing source rows form immutable authoring history. | They describe currently retained highlights, note blocks, and neutral Links. Deletion removes them from historical results; the UI must say so. |
| Every filter can honestly scope every number. | Modality, device, media, and contributor filters scope Consumption facts only. Retained-artifact counts are a separate period-wide section and never pretend to have unsupported attribution. |
| The current render environment owns browser timezone. | It is server-seeded with `UTC`. Add one browser-timezone owner, share it with Notes, and wait for hydration before issuing timezone-sensitive reads. |
| Raw `nx_device` values can be returned as filters. | The httpOnly identity stays server-only. Reads expose a sealed `DeviceHandle`, a safe label, and `isCurrent`; the browser never receives the cookie value. |
| `SetUnread` can never affect first completion. | Ordinary later Unread preserves history, but the product's existing exact ten-second completion Undo must undo the fact it just created. Add an explicit replayable `UndoCompletion` command rather than making every Unread destructive. |

## Validated pre-cutover state

| Claim | Evidence and attribution | Verdict |
|---|---|---|
| Before this cutover, Nexus could not answer historical time/session questions. | `docs/architecture.md`, `docs/modules/player.md`, `ReaderEngagementState`, and `PodcastListeningState` explicitly retained current resume/engagement state and no span history. | Real problem. |
| Explicit and derived completion already have a canonical owner. | `services/consumption/service.py`, `_projection.py`, `_state_store.py`, and `_listening_store.py` own `Unread`/`Finished`, reader progression, and natural audio completion. | Reuse this owner; do not infer completion from new dwell. |
| The Finished threshold is duplicated. | `_projection.py` owns `0.95`; `MediaPaneBody.tsx` repeats it for the Lectern prompt. | Remove the browser threshold. Drive the prompt from canonical projected state. |
| Audio activity is observable. | `lib/player/globalPlayer.tsx` owns the app-wide `<audio>` element and its playing/pause/end lifecycle. | Listening spans are supportable. |
| Provider-certified video playback is not observable. | `TranscriptPlaybackPanel.tsx` renders an opaque YouTube iframe without provider state integration. | Only focused visible pane dwell is supportable. |
| Stable server-owned device identity exists. | `lib/auth/deviceCookie.ts` defines the httpOnly `nx_device`; the workspace BFF demonstrates server injection. | Reuse it without exposing it to browser code. |
| Canonical word totals exist. | Migration `0187_library_reading_time_word_counts.py` and `services/media_document_metrics.py` own stored non-whitespace word counts. | Reuse the policy, but add prefix-position data and parity tests. |
| Browser IANA timezone is not globally owned. | `renderEnvironment/server.ts` sets `displayTimeZone = "UTC"`; `lib/notes/api.ts` has a private browser detector. | Extract one browser owner; do not claim existing render-environment reuse. |
| Highlights, note blocks, and Links already own creation times. | `Highlight`, `NoteBlock`, and `ResourceEdge` own database-clock `created_at`; neutral Link shape is defined by `resource_graph.schemas.is_neutral_link_shape`. | Query through narrow owner ports; do not duplicate rows. |
| Those authoring facts are not an immutable activity log. | All three resources can be deleted, and `NoteBlock` does not distinguish human from tool-created prose. | Label counts as retained highlights, retained note blocks, and retained user Links. |
| Navigation has explicit owners. | `navigation/destinations.ts`, `components/appnav/navModel.ts`, pane route model/table/render registry, and `docs/modules/app-navigation.md` define identity, fixed order, and pane projection. | Add Stats through every owner and parity test. |

## Goals

- Measure observed reading time, listening time, and video-pane time by local
  bucket, media, current contributor credits, modality, derived session, and
  device.
- Retain bounded semantic activity spans so future deterministic statistics are
  possible without raw interaction logs.
- Record progress, forward timed-position change, forward text-position change,
  and the first post-cutover observation of canonical `Finished`.
- Count currently retained highlights, note blocks, and user-authored neutral
  Links without copying them into the activity store.
- Present a rigorous inspectable Stats surface and a visually distinct annual
  ritual without overstating what Nexus observed.
- Reuse the current Consumption owner, reader/player lifecycles, canonical text
  and word-count policy, contributor credits, `nx_device`, `Presence<T>`, pane
  routing, BFF, and design tokens.

## Non-goals

- No backfill or synthetic historical activity.
- No immutable history of deleted highlights, note blocks, Links, or media.
- No corrections, per-span deletion UI, recomputation workflow, imports,
  external-app tracking, export, or sharing.
- No reading/rereading cycles, seek classification, unique-word coverage,
  cross-tab/device overlap reconciliation, goals, badges, grace days, or
  leaderboards.
- No verified YouTube playback integration. `Viewing` is focused, visible
  in-app video-pane dwell.
- No exact PDF word traversal. PDF time and progress remain supported.
- No timezone preference, picker, or historical travel-timezone model.
- No rollup table, aggregate cache, stream, durable browser queue, or retention
  job.
- No generic analytics/telemetry platform, chart framework, or shared chart kit.
- No genre taxonomy, recommendations, social feed, or notifications.
- No instrumentation-coverage lifecycle, first-recorded marker, partial-year
  state, or historical completeness claim.

## Semantic contract

These names are product promises:

- **Active time** is the sum of accepted span durations. Simultaneous
  modalities, tabs, or devices are additive; it is not de-duplicated wall-clock
  time.
- **Reading time** means the active reader pane met all focus, visibility, and
  recent-input gates.
- **Listening time** means the owned global audio element reported playing.
- **Video-pane time** means the active embedded-video pane was visible and the
  window focused. It does not prove the provider was playing.
- **Forward word-position change** and **forward media-position change** are
  cursor deltas. They are not unique words read, audio heard, or seek-free
  consumption.
- **First completion** means the first canonical `Finished` transition Nexus
  observes after this cutover. It is not a historical publication or real-world
  completion date. The exact completion Undo retracts only the fact created by
  the action it reverses; ordinary later `SetUnread` preserves the date.
- **Retained artifacts** are surviving source rows created in the selected
  period. Deleting a source row removes it from past totals.

Stats empty state and help text state these limits in plain language. No chart,
card, accessible label, or exportable same-system DTO uses the stronger
rejected terms.

## Capture

### Recorder state machine

One browser module owns one recorder instance per tab. Reader, global audio,
and video adapters publish observations into it; they do not send requests.

- Use `performance.now()` for elapsed duration and an ISO wall instant only for
  span placement. Never calculate duration from `Date.now()`.
- Emit right-open spans `[occurredAt, occurredAt + duration)` no longer than
  `ACTIVITY_SPAN_MAX_MS = 30_000`.
- Check eligibility at `ACTIVITY_CHECKPOINT_MS = 10_000` and flush at
  `ACTIVITY_FLUSH_MS = 30_000` or an earlier semantic boundary. A delayed
  callback never licenses a span over the maximum; a monotonic checkpoint gap
  above `ACTIVITY_SUSPENSION_AFTER_MS = 35_000` resets every baseline.
- Every modality closes immediately on its applicable eligibility transition,
  media change, viewport-class change, or page hide. A monotonic jump above the
  maximum is a suspension gap and is discarded, never clamped.
- Reading accrues only while the media pane is active, the document is visible,
  the window is focused, and genuine pointer, keyboard-navigation, touch, wheel,
  or scroll input occurred within `READING_IDLE_AFTER_MS = 300_000`.
  Programmatic restore/navigation does not reset idleness. The recorder stores
  the monotonic idle deadline and clips at that deadline even if its timer wakes
  later.
- Listening starts on the owned audio element's `playing` event, not the
  optimistic app `Playing` phase. It ignores pane, focus, and document
  visibility and stops on `waiting`, `stalled`, `pause`, `ended`, `error`,
  `emptied`, media replacement, or teardown. Background time accrues only while
  browser JavaScript continues executing; a browser-suspended interval is
  unobservable and omitted even if audio continued.
- Viewing starts only after the local iframe `load` event while at least 50% of
  the embed intersects its actual document viewport, its pane is active, and
  the top-level document is visible and `document.hasFocus()`. It stops on
  intersection loss, invalid/unavailable source, locally observed error, pane
  deactivation, document hide/focus loss, or unmount. Provider-internal pause,
  end, buffering, and failure remain opaque and therefore continue to count as
  pane dwell. Focusing the iframe is not treated as leaving the app merely
  because a parent `window.blur` event fired.
- Adapters register observers by `(paneInstance, media, modality)`. Multiple
  panes may observe the same media, but the recorder selects exactly one
  currently eligible observer for each `(media, modality)` lane. An eligibility
  handoff closes the prior span and opens a new baseline. More than one
  simultaneously eligible observer for the same lane is a same-system defect:
  close that lane, emit one sanitized diagnostic, and accrue nothing until the
  ambiguity clears. The app-wide audio owner naturally registers one observer.
  Different tabs and devices remain additive by declared policy.
- Capture starts only after viewport hydration. `desktop | mobile` is mapped
  once at the wire boundary to `Desktop | Mobile`, an open span splits when
  the breakpoint changes, and the UI calls this **viewport class**, not a
  physical-device classification.

The recorder keeps a bounded lane per active
`(media, modality, viewport class)`. Each lane has one current pending buffer
and at most one immutable retry batch; one shared scheduler allows only one HTTP
request in flight and may service another ready lane while a failed lane is in
backoff. Activity continues into that lane's pending buffer while its frozen
body retries. A retry reuses the identical `clientMutationId` and bytes. Success
discards only that frozen batch.

There are at most `ACTIVITY_MAX_LANES = 8`; each lane is bounded by
`ACTIVITY_BATCH_MAX_SPANS = 120` and
`ACTIVITY_BATCH_MAX_BYTES = 48_000`, below browser `keepalive` limits. Lane or
buffer overflow stops new capture for that source and records one sanitized
degraded-capture diagnostic rather than silently mutating or partially
replaying a batch.

`clientMutationId` is minted only with `crypto.randomUUID()` through the
existing UUID boundary and capture fails closed when unavailable; no weaker
random-string fallback is valid for replay identity.

Flush on the named cadence, batch ceiling, semantic stop, and page hide. Page
hide gets one best-effort `keepalive` attempt of the exact in-flight payload.
There is no `localStorage`, IndexedDB, service-worker, or durable offline
activity queue.

Network/timeout/429/5xx failures retain the immutable retry batch and use the
bounded categorical activity-capture schedule
`ACTIVITY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000]`. Exhaustion stops
and degrades that lane; this browser component is not a connection maintainer
and does not retry forever. The local schedule carries the repository-required
`justify-retry-schedule` because ephemeral browser capture has no server
dependency category or durable queue.

A typed visibility loss terminally drops that single-media batch and stops its
source. A 400 or replay conflict is a same-system recorder defect: stop capture,
retain no poison retry loop, and emit one sanitized diagnostic. Authentication
failure follows the existing auth boundary. No terminal response can wedge all
other media because one upload batch contains exactly one
`(media, modality, viewport class)`.

### Ingress

The BFF accepts the exact browser batch, reads `nx_device`, injects the
server-only device ID, and forwards one strict backend batch. A missing
authenticated device cookie is an invariant defect, matching workspace-session
behavior. The browser supplies the existing hydrated viewport kind as
`Desktop | Mobile`; no user-agent classifier or second breakpoint is added.

The backend strictly decodes and structurally validates the whole batch before
calling the service facade:

- one media, modality, and viewport class; `1..120` ordered spans; and the
  serialized byte ceiling;
- finite ranges, paired optional measurements, allowed media/modality fields,
  positive duration no greater than 30 seconds, and non-negative positions;
- `ACTIVITY_MAX_AGE_MS = 86_400_000` and
  `ACTIVITY_MAX_FUTURE_SKEW_MS = 300_000`;
- no overlap or out-of-order interval inside the batch.

After the viewer lock and replay lookup, a first execution validates viewer
visibility through the canonical media-visibility relation inside the
transaction. An exact replay returns its memo without re-evaluating visibility;
it is the same logical operation, not a new historical read. Malformed input is
a typed request error. Same-system impossible states defect. No partial batch
succeeds.

## Metrics and attribution

### Span-derived metrics

- `activeMs = SUM(durationMs)`.
- `forwardMediaPositionMs =
  SUM(max(0, mediaPositionEndMs - mediaPositionStartMs))`.
- `forwardWordPosition =
  SUM(max(0, wordEnd - wordStart))`.
- Seeks, backward movement, repeats, and concurrent observation receive no
  inferred classification beyond those formulas.
- For podcast episodes, the contributor relation unions direct media credits
  with parent-podcast credits. For all other media it uses direct credits.
  Within a media row, deduplicate by contributor, retain the union of current
  roles for display, and fully credit the media's activity once to each
  contributor. Contributor totals are therefore non-additive; `other` is the
  sum of attributed contributor rows after the top 25, never overall activity
  minus top contributors. Later credit correction changes prior attribution.

For a span `S`, query interval `Q`, and bucket `B`, duration contribution is:

```text
max(0, min(S.end, Q.end, B.end) - max(S.start, Q.start, B.start))
```

Select spans by overlap (`S.start < Q.end AND S.end > Q.start`), not start-time
containment. Clip first to the query and then to buckets. Integer word/media
position deltas are allocated in proportion to intersected duration using
largest-remainder allocation with `(bucketStart, spanId)` as the deterministic
tie-break. Bucket sums exactly equal the clipped range allocation, and an
unclipped range exactly equals the accepted whole-span delta. Clipped progress
endpoints use the same linear interpolation and remain descriptive session
fields, not additive bucket metrics.

### Word positions

The canonical owner must expose, for each web/transcript fragment and EPUB
section, its stored word count and document-global starting word ordinal.
Browser code maps the active canonical-text code-point offset only; it never
scans preceding full text at runtime.

`wordBoundaryOrdinal(offset)` is the count of canonical non-whitespace tokens
whose first code point is before `offset`, producing a boundary in
`[0, documentWordCount]`. A shared golden corpus covering ASCII and Unicode
whitespace, astral code points, empty text, and fragment boundaries must pass
the migration expression, Python owner, and browser helper. If parity fails,
the canonical policy is corrected once before capture ships; no fallback policy
is added. Word positions are `Absent` for PDF and any content without a
canonical resolvable text position.

### Derived sessions

Sessions are not rows or client identities. SQL considers the query interval
extended by the session gap, partitions spans by
`(user, media, modality, device)` in event order and starts a new island when a
span begins at or after the running prior maximum end plus
`ACTIVITY_SESSION_GAP_MS = 1_800_000`. A gap strictly below 30 minutes stays in
the island; exactly 30 minutes starts another.

A session returns minimum start, maximum end, summed active duration, first/last
progress, forward-position deltas, and its media/modality/device projection.
The extended context decides island identity, but returned timestamps, duration,
progress/deltas, and longest-session ranking are clipped to the requested
interval. `continuesBeforeRange` / `continuesAfterRange` disclose a clipped
island. Gaps do not count as active time. Longest session means greatest clipped
summed active duration, not wall-clock extent, with start instant and the full
group key as tie-breaks.

The first sessions page captures database `asOfCreatedAt`; every page includes
only spans received at or before that cutoff. The versioned opaque cursor seals
that cutoff, a canonical hash of viewer/range/timezone/filters, and the full
descending outward `(sessionStart, mediaRef, modality, deviceHandle)` key.
Cursor decode validates the envelope and unseals the handles once at ingress to
recover the private SQL key. Even when the cursor codec is authenticated rather
than confidential, its payload contains no raw media or device ID. Mismatched
cursors are rejected, pages fetch `limit + 1`, and `limit` is `1..100`. Raw
group IDs, span IDs, and device IDs never leave the service.

### Days, streaks, and timezones

- An active local day has at least
  `ACTIVE_DAY_MINIMUM_MS = 300_000` after Consumption filters.
- Longest streak is the longest run of qualifying local days in the requested
  range. For a live range, current streak may end yesterday until today itself
  qualifies; that is an unclosed-day rule, not a grace day. Historical ranges
  label the equivalent value **ending streak**, not current streak.
- Browser-detected IANA timezone is query context, not stored event data. The
  same instant history re-buckets when queried from another timezone.
- Week buckets start Monday. Ranges and buckets are right-open.
- DST-aware bucket rows carry start/end instants plus local label and UTC
  offset. Fall-back repeated hours remain distinct on timelines; the 24-hour
  distribution deliberately combines them under the same wall-clock hour.
  Spring-forward missing hours are zero.

### Completion and retained artifacts

Each owning mutation derives effective canonical pre-state and post-state after
explicit-override precedence. Insert a completion fact only for
`pre != Finished && post == Finished`. The complete path set is explicit
Finished, reader engagement crossing the sole backend 95% policy, listening
heartbeat crossing that policy, and natural audio end. An already-Finished
pre-cutover row does not gain a fact on its next idempotent save. Media kind and
canonical activation map to modality in `_policy.py`; callers never choose it:
web article/EPUB/PDF → Reading, podcast episode → Listening, and video →
Viewing.

Concurrent transitions linearize under serializable retry and the schema unique
key. Every single-media Finished command result carries
`completionHandle: Presence<CompletionHandle>` when that command inserted the
fact. This includes the existing `FinishLecternItem` and `EnsureMediaFinished`
commands regardless of whether their caller is an explicit UI action or the
natural-audio path; the backend cannot distinguish caller intent. Only the
explicit completion UI consumes the Presence and offers Undo. Natural callers
discard it and show no Undo. Batch and threshold-internal paths expose no
handle.

The existing ten-second toast invokes a new replayable `UndoCompletion` command
with the viewer-owned handle when Present; that command atomically
verifies/consumes the handle, deletes exactly that fact, and establishes Unread.
When the handle is Absent, the toast calls ordinary `SetUnread`, because an
older first-completion fact must survive.

Ordinary `SetUnread` and batch Unread preserve completion history. A later
effective completion can become the new first fact only when exact Undo removed
the original one.

Owner read ports return:

- retained highlights by database `created_at`;
- retained `NoteBlock` rows by database `created_at` (not Pages and not a claim
  of human-only authorship; empty retained blocks still count as rows);
- retained neutral Links matching
  `is_neutral_link_shape(...)` by database `created_at`.

Those three counts are period-wide and unaffected by modality, device, media,
or contributor filters. They render in a separate **Created and kept** section
with that scope visible. No activity row duplicates them.

Every span/session/breakdown/completion and activity portion of the annual view
begins from `visible_media_ids_cte_sql()` for the viewer. Retained-artifact
ports enforce viewer ownership and canonical visibility of the row and any
referenced endpoints; where a fact has a direct media owner, it also intersects
that media relation. No transitive graph attribution is invented. Revoked
membership, viewer tombstone, or armed teardown therefore cannot leak a title,
credit, excerpt, or historical total. Media teardown explicitly removes its
spans and completion fact, so the living annual view can change after deletion.
There is no library ownership or library filter.

## Final architecture

```text
reader / global audio / visible video pane
  -> one tab-local recorder
  -> Next BFF (inject nx_device)
  -> replayable Consumption activity mutation
  -> consumption_activity_spans

canonical Finished transitions
  -> Consumption invariant
  -> consumption_completion_facts

span + completion facts + narrow owner read ports
  -> Consumption stats queries
  -> Stats / Sessions APIs
  -> Stats pane + Year in Reading
```

### Ownership

| Capability | Sole owner |
|---|---|
| Span/completion DML | `services/consumption/_activity_store.py` |
| Activity operations and public queries | `services/consumption/service.py` |
| Aggregation, sessionization, bucket, and filter policy | `services/consumption/_activity_stats.py` |
| Completion/threshold policy | `services/consumption/_policy.py` |
| Reader cursor/current engagement | existing reader and Consumption stores |
| Audio position/current listening state | existing listening heartbeat/store |
| Canonical word totals and prefix ordinals | canonical text owners plus `services/media_document_metrics.py` |
| Contributor attribution | `services/contributor_credits.py` |
| Retained highlight/note/Link facts | their existing owning services |
| Browser timing and batching | `lib/consumption/activityRecorder.ts` |
| Browser timezone | new shared `lib/time/browserTimeZone.ts` |
| Wire decoding | `lib/consumption/activityContract.ts` |
| Stats and annual presentation | `/stats` pane |

Operational diagnostics and `resource_edges` own none of the activity ledger.
`reader_engagement_states` and `podcast_listening_states` remain current-state
owners; they are not legacy storage and are not replaced.

## Storage

Create two tables because the facts have different shapes:

```text
consumption_activity_spans
  id                          uuid primary key
  user_id                     uuid not null -> users.id
  media_id                    uuid not null -> media.id
  modality                    text not null  # Reading | Listening | Viewing
  device_id                   text not null  # internal nx_device value
  device_class                text not null  # Desktop | Mobile
  occurred_at                 timestamptz not null
  duration_ms                 bigint not null
  progress_start/end          double precision null
  word_start/end              bigint null
  media_position_start/end_ms bigint null
  created_at                  timestamptz not null default now()

consumption_completion_facts
  id                          uuid primary key
  user_id                     uuid not null -> users.id
  media_id                    uuid not null -> media.id
  modality                    text not null
  created_at                  timestamptz not null default now()
  unique (user_id, media_id)
```

Rules:

- Each table owns its UUIDv7 ID generated through `nexus.ids.new_uuid7`; the
  current database has no UUIDv7 function. Generate span IDs inside the
  retryable database body. Generate a completion candidate only on its new-row
  path, and include its sealed handle in the same atomic replay-memo response
  when a single-media Finished command inserts it.
- The completion unique key is a real schema-owned fact: at most one first
  completion per viewer/media.
- Nullable measurement pairs are raw storage nullability. Application types
  convert them immediately to paired `Presence<T>` values and defect on trusted
  impossible rows.
- Completion time uses the database's authoritative clock at the canonical
  transition. Span `occurred_at` is the validated browser observation;
  `created_at` is database receipt time.
- Add the proven range/filter indexes
  `(user_id, occurred_at, id)`,
  `(user_id, media_id, occurred_at, id)`, and
  `(user_id, device_id, occurred_at, id)` on spans, plus
  `(user_id, created_at, id)` on completion facts. Its database-clock
  `created_at` is the first-completion date; no duplicate semantic timestamp is
  stored. Add `(media_id, id)`
  on both tables for the known media-wide teardown path. Do not add speculative
  indexes; focused real-Postgres query plans must justify any change.
- Add no `CHECK`, cascade, JSON payload, session ID, update timestamp, raw URL,
  user agent, text, source revision, rollup, or aggregate column.
- Both tables are insert-only during ordinary capture/projection. Exact
  `UndoCompletion` may delete the fact it proves; explicit media lifecycle
  teardown may delete both fact families. “Append-only” is not used to conceal
  those exceptions.
- Media teardown calls Consumption cleanup explicitly before parent deletion.
  There is no current product user-delete flow; any future one must compose
  explicit Consumption cleanup before deleting the user. Historical migrations
  remain untouched.
- The migration creates empty tables and reads no cursor, engagement, listening,
  override, or historical attention data.

## Operation and capability contract

The public service exposes replayable operations and read queries, not raw
transaction plumbing:

```text
record_activity_batch(viewer, clientMutationId, media, device, batch) -> None
get_activity_stats(viewer, query) -> ConsumptionStats
get_activity_sessions(viewer, query) -> ActivitySessionPage
```

These are additions to the existing public Consumption boundary; Lectern,
listening, engagement, and projection capabilities remain. The existing narrow
media-teardown integration is extended for both tables.
Module-private in-transaction helpers for first completion are permitted only
inside Consumption-owned Finished/engagement mutations where the committed
state would otherwise be false.

`record_activity_batch` follows the current Consumption command pattern. Its
public facade opens a fresh service-owned `Session` and calls
`retry_serializable`; the transaction body locks the viewer, derives canonical
request bytes with `canonical_json_bytes`, and uses
`lookup_replay`/`record_replay` in the existing `resource_mutations` table under
`CONSUMPTION_ACTIVITY_SCOPE = "Consumption.Activity"`. An exact replay returns
the memoized empty success without re-running visibility checks or writes. A
new operation validates current visibility, inserts the already structurally
validated batch, records the empty success memo, and commits once. Reusing a
key with different canonical bytes conflicts.

One accepted `clientMutationId` therefore retains one activity-scope replay
memo. This cutover introduces no generic managed-operation runtime, `ON
CONFLICT`, per-row transaction, client row ID, bespoke idempotency table, or
replay-retention behavior.

Every path that can establish `Finished` composes the pre/post-state completion
invariant, including listening heartbeat threshold crossing. The browser's
duplicate 95% literal is deleted; completion-dependent UI consumes canonical
projected state. Add `UndoCompletion` to the closed command union and extend
only single-media Finished command results with the sealed handle Presence
needed by the existing exact Undo; do not widen unrelated current-state DTOs.

Highlight, note, resource-graph, and contributor modules expose narrow
policy-neutral read operations. Stats composes those operations; it does not
read another owner's private model/table or copy the facts.

## API

All owned bodies are strict camelCase, reject extras, use PascalCase domain
variants, preserve `Presence<T>`, and expose sealed handles rather than private
IDs.

### Activity write

```text
POST /consumption/activity
{
  clientMutationId,
  mediaRef,
  deviceClass,
  batch: ActivityBatchIn
}
-> 204
```

The browser shape contains exactly one media, modality, hydrated viewport
class, and `1..120` ordered samples. It contains no user, device, event, or
session ID. The BFF produces a separate strict backend batch by injecting
`deviceId`; it never mutates individual semantic fields.

```text
ActivityBatchIn =
  ReadingBatch {
    modality=Reading,
    spans: ReadingSpan {
      occurredAt, durationMs,
      progressStart/End: Presence<float>,
      wordStart/End: Presence<int>
    }[1..120]
  }
| ListeningBatch {
    modality=Listening,
    spans: ListeningSpan {
      occurredAt, durationMs,
      progressStart/End: Presence<float>,
      mediaPositionStartMs/EndMs: Presence<int>
    }[1..120]
  }
| ViewingBatch {
    modality=Viewing,
    spans: ViewingSpan { occurredAt, durationMs }[1..120]
  }
```

Each pair has the same Presence branch on both ends. Irrelevant fields do not
exist on that union branch and persist as SQL `NULL`; Viewing has no provider
position fields in this cutover.

### Reads

```text
GET /consumption/stats
  ?start=<optional>&end=&bucket=Hour|Day|Week|Month|Year
  &timeZone=
  &modality=&mediaRef=&contributorHandle=&deviceHandle=
-> ConsumptionStatsOut

GET /consumption/sessions
  ?start=<optional>&end=&timeZone=
  &modality=&mediaRef=&contributorHandle=&deviceHandle=
  &cursor=&limit=
-> ActivitySessionPageOut
```

The frontend resolves presentation presets into right-open instants; only All
omits the lower bound. The API does not duplicate Today/Week/etc. Require
`start < end` when start exists, a validated IANA zone no longer than 100 code
points, a response ceiling of 400 timeline buckets, `limit=1..100`, and strict
rejection of unknown query parameters. Internal query types normalize the
intentional omitted All-time start to `Presence`. Resource/device handles are
unsealed once at ingress and authorized in scope.

Presentation-to-query mapping is fixed: Day → Hour, Week → Day, Month → Day,
Year → Month, and All → Year. There is no automatic coarsening or alternate
fallback mapping.

Activity, stats, and sessions are private personal-history routes. Every FastAPI
and BFF success/error response sets `Cache-Control: private, no-store`; no
framework or intermediary cache owns them.

`ConsumptionStatsOut` has three explicit sections:

- `activity`: `appliedFilters`, totals, active/ending streaks,
  `longestSession: Presence<ActivitySessionSummary>`, modality-stacked
  timeline, 24 local-hour distribution, local calendar days, top 25
  media/current contributors plus `other`, and safe device projections;
- `completion`: first-completion totals/dates and media/current-contributor
  breakdowns; `appliedFilters` includes time, modality, media, and contributor,
  while device is declared inapplicable;
- `retainedArtifacts`: period-wide retained highlight, note-block, and neutral
  Link counts with only the time filter applied and every Consumption filter
  declared inapplicable.

Each device projection carries a sealed `deviceHandle`, derived label,
first/last observed instants, observed device classes, and `isCurrent`. It never
contains `deviceId`. Reads also BFF-inject the current raw cookie so the backend
can derive `isCurrent`. Labels are `This device` for the match; other devices
use observed viewport class plus all-time first-seen local date, with a
server-derived ordinal only when those labels collide. The opaque handle is the
filter value and never renders.

`ActivitySessionPageOut` returns derived sessions and an opaque keyset cursor,
never raw spans. SQL owns filtering, visibility, joins, timezone-aware interval
intersection, proportional delta allocation, gap-and-island sessionization,
ordering, and aggregation. Python owns response policy and sealed projections.
Each factual response materializes in one read-only `REPEATABLE READ` snapshot
so owners cannot drift within a result.

### Deferred follow-up: Year Reflection

No model call, LLM vocabulary, generation route, prompt, operation state,
result memo, or Reflection UI ships in this cutover. Deterministic Year in
Reading is complete without it. A separately approved cutover must define its
LLM owner, operation/replay and uncertain-transition policy, evidence
visibility after dispatch, and result lifecycle against the then-current shared
LLM boundary. Do not scaffold those decisions here.

## Frontend

Add **Stats** to fixed navigation after Notes and before Atlas through
`DESTINATION_REGISTRY`, `APP_NAVIGATION`, pane route model, route metadata,
render registry, Launcher/keybinding projections, command-palette history
allowlist, and parity tests. This intentionally changes the fixed-nav product
contract: Stats is the feedback leg of the daily consume → think → reflect loop,
not a feature directory entry. Its placement beside Notes makes that daily
reflection loop one gesture away; the app-navigation module must record this
rationale and exact new order. `/stats` is one pane route.

### URL and loading

Navigable state is URL-owned:

```text
/stats?view=stats&period=day&anchor=2026-07-24
       &modality=...&media=...&contributor=...&device=...
/stats?view=year&year=2026
```

Stats periods are Day, Week, Month, Year, and All; **Today** is the initial Day
anchor/action, not a duplicate period. Day/ISO-Monday-week/calendar-month/
calendar-year are the local calendar periods containing `anchor`, never rolling
windows. Previous/next is absent for All.
Next is disabled when it would move wholly beyond the current local period.
Invalid/unknown URL values are rejected into one canonical default; Year view
ignores and canonicalizes away Stats-only filters. Years are `1970..current
local year`; future years are invalid. A year with no recorded facts renders the
ordinary loaded-empty state.

The server renders deterministic pane chrome and a loading skeleton. After
hydration, the shared browser-timezone owner resolves one validated IANA zone,
canonicalizes a missing local anchor into the URL, and enables the standard
query primitive. It rechecks on `pageshow` and window focus; a changed zone
updates the visible zone, canonical local anchor, and query exactly once. No
component effect performs ad-hoc route-entry fetching, and no server-rendered
UTC result flashes as local data.

Query strings currently participate in workspace `routeKey` and keyed content
mounting. Add a typed Stats-only in-place query-navigation policy:
history/URL/pane identity still sees the full canonical href, while the Stats
content mount key is pathname-stable. `StatsPaneBody` consumes
`usePaneSearchParams()`, never ambient location. Browser coverage proves a
period/filter/view update does not remount, reset scroll, lose focus, or flash
route fallback.

The pane always displays the active timezone. Its state matrix is explicit:
initial skeleton; loaded-empty; loaded-data; filter-empty; recoverable read
error with Retry; and invariant defect. Previously loaded deterministic data
remains visible during an in-range refetch with a non-blocking busy state; it
is never mixed with stale filter labels.

### Stats

- Summary: active time, active days, current/ending and longest streak,
  sessions, forward word/media-position change, and first completions.
- Charts: modality-stacked timeline, local-day heatmap, and hour-of-day
  distribution.
- Breakdowns: media, current contributors, devices, and paginated sessions.
- Separate **Created and kept** section: retained highlights, note blocks, and
  neutral Links, explicitly period-wide.
- Every non-additive or inapplicable filter relationship is visible beside the
  affected section, not hidden in a tooltip.
- Every chart is presentation-only (`aria-hidden`) over the same view model as
  a semantic heading, concise textual summary, and HTML data table. Tables and
  row activation provide keyboard interaction; SVG marks do not invent a
  second interaction model.
- Modality uses label, shape/pattern, and color. Respect forced colors, reduced
  motion, zoom, narrow panes, large values, empty data, DST labels, and
  locale-aware number/duration formatting.
- Media/contributor rows use existing pane activation. Device labels never
  reveal handles or cookie values.
- The Stats root is an inline-size container and uses container queries; a
  narrow desktop pane does not inherit wide layout merely because the viewport
  is desktop. No page-level horizontal overflow is permitted.

### Year in Reading

The selected year renders from the same deterministic contract in a distinct
editorial composition: cover field, monthly rhythm, peak day/hour, top
works/current contributors, longest session, retained artifacts, completions,
and modality composition.

**Year in Reading** is the deliberate reading-first ritual name, with listening
and viewing presented as explicitly labeled ways Nexus accompanied a work. It
is not allowed to collapse those modalities into literal pages/words read.

It is live: no preview, seal, snapshot, version, cutoff, stored annual row, or
generated copy. It applies the selected year and current timezone to the same
deterministic facts, current visibility/current contributor credits, and
surviving-artifact semantics as Stats. An empty year is simply empty; the
product adds no coverage-completeness model.

Use existing warm editorial tokens and pane primitives. Stats is neutral,
dense, and inspectable. Year may be nocturnal and theatrical but cannot import
Oracle-owned theme or illustration semantics. Build the three bounded visuals
with local HTML/CSS/SVG after the semantic view models exist; do not add a chart
dependency or premature shared kit.

## Operations, privacy, and trust

- Emit sanitized structured diagnostics for accepted span/batch counts,
  replay/conflict outcomes, capture degradation, query latency, and bucket
  count. Never log raw URLs, cookie/device values, or span payloads.
- Stats queries get focused real-Postgres plans and a named one-user latency
  budget before release. Optimize measured owners only; add no speculative
  rollup or index.
- Record span, completion, and `Consumption.Activity` replay-memo cardinality in
  the operator check. At 500,000 retained spans, 100,000 activity replay memos,
  or a sustained latency-budget breach, remeasure storage/query plans and write
  a separate retention/rollup decision; crossing a review threshold does not
  activate hidden behavior.
- Auth, media visibility, sealed handles, and owner read ports are rechecked on
  every read.

Deployment rollback is explicit. Before recorder activation, schema/backend/BFF
may roll back with empty tables left in place. After any capture, disable the
recorder/UI first and roll application code forward to a fix; never down-migrate
or delete captured facts as a rollback shortcut.

## Hard-cut cleanup

- Keep `reading_sessions`, `services/attention.py`, `schemas/attention.py`, and
  attention payloads absent.
- Replace current claims that Nexus stores no session/device/span/dwell history
  in architecture, player, reader, model comments, and active cutover docs with
  the precise current-state/history split.
- Link this cutover from the transient-state-pruning supersession note.
  Preserve historical migrations and the historical attention-ledger document.
- Keep the negative gate forbidding `reading_sessions`; add gates that both new
  tables' DML exists only in `_activity_store.py`, no activity route writes
  operational telemetry, and no third activity table/client recorder exists.
- Reuse `nx_device`; add no second cookie or local-storage identity.
- Extend canonical word-count owners; add no runtime preceding-document scan or
  second word policy.
- Preserve `reader_engagement_states`, `podcast_listening_states`, cursor saves,
  and listening heartbeat fencing as the resume/current-state path.
- Keep web-vitals/search telemetry and `resource_edges` schema unchanged.

## Files

Create:

- the next Alembic migration for both Consumption fact tables;
- `python/nexus/schemas/consumption_activity.py`;
- `python/nexus/services/consumption/{_activity_store,_activity_stats,_policy,handles}.py`;
- `python/nexus/api/routes/consumption_activity.py`;
- focused real-database service/API/query-plan tests;
- `apps/web/src/lib/consumption/{activityContract,activityRecorder,canonicalWordPosition}.ts`
  and focused tests;
- `apps/web/src/lib/time/browserTimeZone.ts` and tests;
- BFF routes for activity, stats, and sessions;
- `apps/web/src/app/(authenticated)/stats/{page,StatsPaneBody}.tsx`,
  `StatsPaneBody.module.css`, and focused component tests;
- `docs/modules/consumption-activity.md`.

Modify:

- backend: `db/models.py`, Consumption `service.py`/`_projection.py`, API route
  registry, `schemas/consumption.py`, media teardown, reader/listening
  completion composition, `schemas/media.py`, `services/media.py`, canonical
  document metric outputs, private-no-store middleware, and narrow
  retained-fact/contributor read ports;
- reader/player/video: `MediaPaneBody.tsx`, `PdfReader.tsx`,
  `lib/media/{transcriptView,readerNavigation}.ts`, EPUB section schemas,
  `lib/lectern/{contract,useCompletionUndo}.ts`, `globalPlayer.tsx`, and
  `TranscriptPlaybackPanel.tsx`;
- shell: destination registry, `APP_NAVIGATION`, pane model/meta/render
  registries, Stats pathname-stable mount policy in pane identity/workspace,
  Launcher/keybinding projections, command-palette canonical href allowlist,
  and parity/integration tests;
- timezone consumer: replace Notes' private detector with the shared owner;
- transport: BFF proxy deadline ownership and `privateNoStoreResponse` use for
  every activity/stats/sessions route;
- docs: architecture, player, reader implementation, app navigation, dreams,
  transient-state-pruning supersession, and negative gates.

Do not modify historical migrations or unrelated current-state response shapes,
`resource_edges` schema, Library reading-time semantics, or unrelated telemetry.

## Implementation order

1. Fact tables/models, store, replayable batch mutation, completion invariant,
   cleanup, API, and focused integration tests.
2. Canonical word-prefix contract and cross-language golden corpus.
3. Recorder state machine and reader/audio/video adapters.
4. Stats/session queries, timezone/DST contract, owner read ports, handles, and
   query-plan tests.
5. `/stats` navigation, factual UI, semantic tables, charts, and accessibility.
6. Deterministic Year in Reading composition.
7. Documentation, residue gates, and focused real-stack verification.

No slice ships a dual path. Schema and BFF deploy before recorder activation;
empty fact tables make that ordering safe without compatibility code.

## Acceptance criteria

- **AC1 — Storage shape.** Exactly two new Consumption product tables exist:
  coherent spans and unique first completions. They are empty after migration,
  non-cascading, and contain no event discriminator, session ID, JSON payload,
  or aggregate.
- **AC2 — Replay.** Retrying identical activity bytes and
  `clientMutationId` returns the memoized 204 and writes the batch once. Reusing
  the key with different bytes conflicts. Each accepted batch owns one
  `Consumption.Activity` replay memo; no client row ID participates.
- **AC3 — Recorder.** Monotonic bounded spans close on every semantic stop;
  suspension gaps are discarded; immutable in-flight bytes survive retry;
  observer handoff preserves one eligible `(media, modality)` source; ambiguity
  accrues nothing; overflow degrades explicitly; no durable/offline store
  exists.
- **AC4 — Reading.** Only focused visible active-pane reading with recent
  genuine input accrues. Web/transcript/EPUB positions use proven
  document-global ordinals; PDF word positions are Absent.
- **AC5 — Listening/viewing.** Global audio accrues from `playing` until every
  listed buffer/stop transition, independent of focus/visibility; suspended-JS
  gaps are omitted and disclosed. Viewing follows loaded 50%-intersection
  dwell and is never labeled provider playback/watch time.
- **AC6 — Sessions.** SQL gap-and-island derivation keeps gaps strictly below
  30 minutes and splits at 30 minutes. Active duration sums spans and excludes
  gaps; pagination is snapshot-stable under late inserts; no session state
  exists in browser/storage, and its cursor contains outward handles rather
  than raw group IDs.
- **AC7 — Time.** Boundary-crossing spans divide exactly across local buckets;
  duration and proportionally allocated integer deltas equal unbucketed totals.
  DST spring/fall, repeated-hour labels, Monday weeks, and timezone travel
  rebucketing have real-Postgres coverage.
- **AC8 — Attribution.** Consumption filters scope only declared Consumption
  sections. Current contributor co-credit is labeled non-additive. Retained
  artifact counts remain visibly period-wide. Every section and annual
  composition begins from current viewer visibility, so revocation, tombstone,
  and armed teardown leak no historical metadata.
- **AC9 — Completion.** Effective pre/post projection tests cover explicit
  override precedence, reader/listening 95% crossings, natural end,
  already-Finished pre-cut rows, and concurrent transitions. Ordinary Unread
  preserves the database-clock date; exact Undo removes only its returned fact
  and permits a later first completion. Every single-media Finished command
  returns the handle Presence when it inserts the fact; only explicit UI offers
  Undo. The frontend threshold literal is gone.
- **AC10 — Retained facts.** Counts come from owner read ports for highlights,
  `NoteBlock`s, and exact neutral Links. Deletion changes historical counts; no
  duplicate activity rows are written.
- **AC11 — Identity.** `nx_device` is BFF-injected only. Browser DTOs contain
  sealed device handles/labels, never cookie values or private row IDs.
- **AC12 — UI.** URL state, route-owned loading, all required periods,
  summaries, charts, breakdowns, and sessions work in narrow panes, keyboard,
  screen reader, zoom, forced-colors, and reduced-motion modes. Every chart has
  a semantic table from the same view model.
- **AC13 — Annual view.** Any selected year renders live deterministic facts
  with no annual lifecycle or instrumentation-coverage model.
- **AC14 — Operations.** Sanitized diagnostics, no-store response coverage,
  focused query-plan/latency/cardinality checks, and the rollback contract
  exist; logs contain no device value, source content, or span payload.
- **AC15 — Hard cut and ownership.** No production `reading_sessions`,
  attention service, compatibility decoder, fallback read, alternate device
  identity, activity telemetry write, rollup, backfill, third activity table,
  or second recorder remains. Fact DML is confined to `_activity_store.py`;
  HTTP/BFF are transport-only.

Verification is focused:

- pure state-machine/ordinal tests use injected instants and the shared
  cross-language word corpus;
- Chromium component tests cover reader input/idle, visibility/focus, iframe
  intersection, audio playing/buffering/stop events, page hide/keepalive,
  terminal/retry behavior, viewport hydration/breakpoint splits, URL stability,
  and narrow-pane accessibility;
- real-Postgres integration covers replay/concurrency, effective completion and
  exact Undo, range clipping/allocation, DST, visibility revocation/tombstone/
  armed teardown, current-credit edits, retained-row deletion, stable session
  pagination, query plans, and limits;
- real-stack E2E covers BFF cookie injection and raw-device non-exposure,
  reading capture-to-Stats, background audio, visible video dwell, URL restore,
  fixed-nav/Launcher history, and private no-store;
- migration/schema tests, path-scoped lint/type checks, `git diff --check`, and
  residue greps close the slice.

Do not run broad suites once these owners are green.
