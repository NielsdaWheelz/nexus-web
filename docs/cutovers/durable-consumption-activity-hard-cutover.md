# Durable Consumption Activity — Hard Cutover

**Status:** IMPLEMENTED IN SOURCE · 2026-08-10. Changed-tree, real-Postgres,
real-Chromium, production-bundle, and Android host proofs pass. Android device
instrumentation is registered for nightly but remains unexecuted without a
connected device.

**Type:** Hard cutover — no legacy payload, in-memory delivery path, fallback,
compatibility decoder, dual write, or feature flag.

The whole of [`docs/rules/index.md`](../rules/index.md) and
[`docs/local-rules/testing-standards.md`](../local-rules/testing-standards.md)
governs this cutover.

## Questions and fixed decisions

Questions requiring a user answer: none.

| Decision | Contract |
| --- | --- |
| Canonical fact | Keep bounded semantic spans; do not add raw interaction events or stored sessions. |
| Durability | Persist every closed span locally before network delivery. |
| Offline window | Accept and retain observed spans for 30 days. |
| Freshness | Reuse the process-local Consumption revision and lifecycle revalidation; no server revision, SSE, or polling. |
| Correction | Add, exclude one observed session, and undo either correction. |
| Explicit timer | Out of scope; manual Add supplies the repair outcome without another lifecycle state machine. |
| Concurrency | Preserve additive observations; do not silently deduplicate simultaneous devices. |
| Device identity | Keep BFF-injected `nx_device`; add no browser-visible or second device identity. |
| Native scope | WebView owns Android reading; native code owns Android listening only. |

## Target

Consumption Activity becomes trustworthy personal history:

```text
semantic observation
  -> bounded closed span
  -> account-scoped durable local outbox
  -> regroupable idempotent upload
  -> existing Consumption span ledger
  -> deterministic Stats/sessions
```

The user can always distinguish `Recording`, `Idle`, `Paused`, `Waiting to
sync`, and `Needs attention`. Progress and completion never fabricate time.

## Goals

- **G1 — Durable capture.** Closed browser and native listening spans survive
  offline, reload, process death, suspension, and ambiguous upload outcomes.
  An abrupt browser kill without a lifecycle event may lose only the current
  sub-checkpoint partial interval; committed checkpoints remain facts.
- **G2 — Regroupable idempotency.** A span has one stable capture key; any later
  batch may replay it without duplicating the fact.
- **G3 — Complete reading coverage.** Web article, EPUB, PDF, and transcript use
  one format-neutral reader-activity source contract.
- **G4 — Fresh presentation.** Same-process acceptance refreshes mounted Stats;
  activation, focus, pageshow, visibility, and online revalidate cross-process
  state.
- **G5 — Visible health.** Pending, failed, paused, and blocked capture is
  inspectable and actionable; zero never silently means broken.
- **G6 — Minimal repair.** The user may add time, exclude an observed session,
  and undo either action without rewriting observed spans.
- **G7 — One owner.** Consumption owns capture, delivery, corrections, factual
  projection, health vocabulary, and their strict boundaries.

## Non-goals

- No raw gestures, page-view events, generic analytics SDK, event-sourcing
  framework, warehouse, CRDT, rollup, aggregate cache, or stored session rows.
- No reconstruction from cursor, chapter, progress, completion, highlights, or
  historical timestamps.
- No live manual timer, physical-book catalog, imports, external-app tracking,
  OS idle API, gaze, attention/comprehension claim, ML, or confidence score.
- No server-side queue, service worker, Background Sync dependency, SSE,
  WebSocket, polling, or real-time cross-device promise.
- No cross-tab/device overlap reconciliation. A future deduplicated attention
  view must remain a separately labeled projection.
- No change to completion facts, current reader/listening state, Stats charts,
  streak policy, Year in Reading, Library reading-time estimates, or retention.
- No background Android reading claim. WebView timers may stop in background;
  only durably closed foreground spans are facts.
- No raw-span inspector, export, sharing, arbitrary partial-span editing, or
  free-text correction notes in this cutover.

## Rules and invariants

1. Duration uses monotonic time. Wall time places the interval only.
2. Observed spans remain right-open, positive, and at most 30 seconds.
3. A closed span is captured only after its local durable write commits.
4. Network delivery never owns correctness; `keepalive` is deleted from the
   capture path.
5. `captureKey` is a canonical UUID minted once when the span closes. It is
   persisted locally, sent on every replay, stored server-side, and never
   exposed by Stats.
6. `clientMutationId` remains request replay identity. It does not replace
   `captureKey`; crash recovery may regroup the same capture keys under a new
   mutation ID.
7. Exact capture-key replay is a no-op. Reuse with different semantic bytes is
   a conflict/defect. No partial batch succeeds.
8. The outbox is partitioned by the existing authenticated `accountId`.
   Another account never drains those rows.
9. The BFF remains the sole `nx_device` reader/injector. Queued spans are
   attributed to the stable current cookie when delivered.
10. IndexedDB/native-store unavailability blocks capture visibly. There is no
    memory-only fallback.
11. Expected offline/auth/media-loss states are modeled. Malformed same-system
    payloads and capture-key conflicts defect and remain inspectable; later
    batches continue.
12. Sessions, totals, streaks, and annual views remain deterministic
    projections. Corrections are inputs to those projections, not mutations of
    observed spans.
13. All owned wire shapes are strict camelCase, reject extras, use PascalCase
    variants, preserve `Presence<T>`, and expose handles rather than database
    IDs.

## Final ownership and composition

| Concern | Sole owner | Reuse |
| --- | --- | --- |
| Eligibility and monotonic span closure | `activityRecorder.ts` | Current lane/observer semantics and timing constants |
| Browser durability, upload, retry, pause, health | new `activityOutbox.ts` | Account context, activity transport, categorical retry shape |
| Browser lifecycle/runtime composition | new `activityRuntime.ts` + `ActivityCaptureLifecycle.tsx` | Authenticated shell, viewport hydration, lifecycle events |
| Reader semantic source | `ReaderActivityAdapter.ts` | Canonical viewport intent and current reader roots |
| Native listening durability | new `NativeActivityOutbox.kt` | Service lifetime, origin client, account/network recovery |
| Span/correction DML | `_activity_store.py` | Existing Consumption transaction/replay boundary |
| Effective metrics and sessions | `_activity_stats.py` | Existing clipping, filtering, gap-and-island queries |
| Strict schemas and handles | `consumption_activity.py` + `handles.py` | Existing BFF/API conventions |
| Same-process freshness | `projectionRevision.ts` | Existing `useSyncExternalStore` owner |
| Product surface | media pane chrome + Stats | Existing header actions, view menu, session rows, tokens |

Adapters publish observations only. They never persist, retry, upload, refresh
Stats, or emit operational telemetry. HTTP/BFF code parses, injects, and calls
Consumption only; it owns no activity rules.

## Capability contracts

### Recorder

```text
registerObserver(key, observation) -> unregister
observe(key, observation) -> void
setCaptureReady(ready) -> void
closeForLifecycle(reason) -> void

closedSpan(spanWithCaptureKey) -> ActivityOutbox.enqueue(span)
```

Delete recorder-owned pending arrays, frozen batches, HTTP, retry counters,
lane degradation, and pagehide upload. The recorder remains a pure bounded
state machine with one injected closed-span sink.

### Browser activity runtime

```text
open(accountId) -> Promise<void>
enqueue(span) -> Promise<void>
drain(trigger) -> Promise<void>
setPaused(paused) -> Promise<void>
retryFailed() -> Promise<void>
discardFailed() -> Promise<void>
snapshot() / subscribe(listener)
```

One runtime serializes IndexedDB writes and allows one upload in flight. It
drains after enqueue, startup, foreground, focus, pageshow, and online. A
self-bounding retry cycle uses the existing `2s, 5s, 15s, 60s` cadence, then
retains the rows until the next lifecycle/network/manual trigger.

```text
ActivityRuntimeSnapshot {
  capture: Recording | Idle | Paused | Blocked(StorageUnavailable|CapacityReached)
  sync: Synced | Pending(count, oldestAt) | Failed(count)
}
```

Status is derived, never separately persisted. The pause preference is
account-scoped and durable. Capacity is `ACTIVITY_OUTBOX_MAX_SPANS = 100_000`;
reaching it blocks new capture and never evicts history silently.

### Reader source

Every readable projection supplies exactly:

```text
mediaRef
actual activity scrollport/root
semantic viewport { intent, progress, wordPosition }
trusted input deadline
pane/document focus and visibility
```

Transcript supplies its transcript viewport as the activity root. EPUB/Web and
PDF keep their current canonical-position owners. Restore/navigation intent is
ineligible; genuine input returns the source to `Reader`.

### Native listening

`NativeActivityOutbox` is a Consumption-owned SQLite store, not Room and not
the Media3 download database. It mirrors browser capture keys, batching,
account partitioning, retry classification, and 100,000-span bound. The
existing serialized service/coroutine owner remains the concurrency boundary.

Delete `NativeConsumptionRecorder`'s in-memory `activityQueue`, frozen request,
and activity retry loop. Extend the existing Android player bridge with one
strict activity-sync snapshot so the web shell can merge native listening
health with browser reading health. Progress-heartbeat persistence remains
separate.

## Local storage

### Browser IndexedDB

Database: `nexus-consumption-activity`, version 1.

```text
spans
  key: [accountId, captureKey]
  accountId, captureKey, mediaRef, modality, deviceClass
  span                         # exact strict activity-span branch
  createdAt
  state: Pending | Failed(MediaUnavailable|Expired|Defect)

settings
  key: accountId
  paused: boolean
```

Indexes exist only for `[accountId, state, createdAt]`. The outbox reads at most
120 same-media/modality/device-class rows and preserves their capture keys.
Successful 204 deletes exactly the uploaded local rows. Authentication loss
retains Pending. Media loss, expiry, and defects mark only the affected rows
Failed and do not wedge later work.

### Android SQLite

One `activity_outbox` table mirrors the browser `spans` fields using canonical
JSON only for the already-discriminated strict span body. It is internal
protocol state, not a product ledger. The app upgrades it in place through the
store's own schema version and deletes acknowledged rows transactionally.

## Server storage

Migration: next revision after current `0212`, assigned at implementation time.

### `consumption_activity_spans`

Add:

```text
capture_key uuid not null
unique (user_id, capture_key)
```

The migration assigns unique keys to existing rows. Future database row `id`
remains server-owned UUIDv7; `capture_key` is client delivery identity, not an
outward row handle. No other existing column or index changes without measured
query-plan evidence.

### `consumption_activity_adjustments`

```text
id            uuid primary key
user_id       uuid not null -> users.id
media_id      uuid not null -> media.id
kind          text not null                 # Add | Exclude
modality      text not null
device_id     text null                     # required only for Exclude
occurred_at   timestamptz not null
duration_ms   bigint not null
created_at    timestamptz not null default now()
retracted_at  timestamptz null
```

Application code owns branch invariants; add no CHECK, cascade, JSON, note,
updated timestamp, session ID, confidence, or generic metadata. Add only proven
range/teardown indexes:

```text
(user_id, occurred_at, id)
(user_id, media_id, device_id, occurred_at, id)
(media_id, id)
```

`Add` has no device and is user-confirmed time. `Exclude` targets one exact
observed `(media, modality, device, session-start, session-end)` projection.
Retraction sets `retracted_at`; edit is retract then create. Media teardown
explicitly removes adjustments before parent deletion.

## API hard cut

### Durable observed activity

```text
POST /consumption/activity
{
  clientMutationId,
  mediaRef,
  deviceClass,
  batch: {
    modality,
    spans: [{ captureKey, occurredAt, durationMs, ...modality fields }]
  }
}
-> 204
```

The BFF injects `deviceId` exactly as today. Batch limits remain 120 spans and
48,000 bytes. Maximum observed age becomes 30 days; future skew remains five
minutes.

Inside one replayable serializable mutation: lock viewer, check request replay,
validate media visibility, select existing capture keys, compare exact semantic
fields, insert missing facts, record the replay memo, and commit. Do not use
`ON CONFLICT`, per-row transactions, partial success, or a new replay table.

### Adjustments

```text
POST /consumption/activity-adjustments

Add {
  kind=Add, clientMutationId, mediaRef, occurredAt, durationMs
}

Exclude {
  kind=Exclude, clientMutationId,
  mediaRef, modality, deviceHandle, startedAt, endedAt
}

Retract {
  kind=Retract, clientMutationId, adjustmentHandle
}

-> { data: { outcome: Added|Excluded|Retracted,
             adjustmentHandle: Presence<ActivityAdjustmentHandle> } }
```

Add duration is `1..86,400,000ms`, cannot end in the future, and may be
historical. Modality is derived from canonical media policy. Exclude accepts
only an observed session returned by the sessions API, resolves the sealed
device handle, and excludes its constituent spans. Retract is exact,
viewer-owned, and replayable. Reusing a mutation ID with different bytes
conflicts.

### Reads

Keep the existing Stats and sessions routes. Hard-cut their activity DTOs:

```text
totals {
  recordedActiveMs       # accepted observed spans before exclusions
  excludedActiveMs       # observed span duration removed by active exclusions
  observedActiveMs       # recorded - excluded
  manualActiveMs         # active Add adjustments
  activeMs               # observed + manual
  ...existing totals
}

session {
  source: Observed | Manual
  device: Presence<DeviceSummary>
  adjustmentHandle: Presence<ActivityAdjustmentHandle>
  ...existing fields
}

activeExclusions[] {
  adjustmentHandle, mediaRef, title, modality,
  device, startedAt, endedAt, excludedActiveMs
}
```

An active Exclude removes observed spans wholly contained in its exact session
interval before sessionization and aggregation. Overlapping exclusions use
`NOT EXISTS`, never double-subtract. Add adjustments are each one derived
Manual session. Device filters omit manual time and declare it inapplicable;
media, modality, contributor, time, visibility, and teardown rules apply.

## Freshness

- Accepted browser upload or adjustment publishes
  `publishConsumptionProjectionChange()`.
- Mounted Stats subscribes through `useConsumptionProjectionRevision()` and
  refetches its exact URL-owned query.
- Stats also revalidates when its pane becomes active and on document-visible,
  window-focus, pageshow, and online transitions, coalescing concurrent reads.
- Android activity acceptance reaches the web runtime through the existing
  bridge and publishes the same process-local revision.
- No server revision, cache-key version field, timer, SSE, or polling exists.

## Product surface

### Media pane

- Publish one existing `PaneHeaderAction`: `Activity: <state>`.
- Show the standard status marker only for Pending, Failed, or Blocked.
- Activation opens `/stats` and preserves pane/focus conventions.
- Add `Add reading/listening/viewing time…` to the existing reader/media view
  menu, prefilled for the current media. The dialog asks start and duration
  only; canonical media policy supplies modality.

### Stats

Add one compact Activity health strip above existing factual content:

```text
Recording | Idle | Paused | Waiting to sync | Needs attention
pending count/oldest or failed count (failure takes precedence)
Pause/Resume · Retry now · Discard failed
```

The summary renders `activeMs` and a concise provenance line, for example:
`1 h 42 m · 1 h 27 m observed · 15 m added`. Session rows label Observed or
Manual. Exact, un-clipped Observed rows offer `Don't count this`; range-clipped
rows direct the user to All time. Manual rows offer `Remove`; active exclusions
offer `Restore`. All mutations use existing confirmation,
feedback, focus-return, duration, date, button, and design-token primitives.

No new dashboard, overlay framework, chart dependency, route, icon family, or
gamification surface is added.

## Operational diagnostics

Keep one privacy-safe event chain:

```text
activity_span_closed
activity_span_enqueued
activity_upload_attempted
activity_upload_accepted
activity_upload_rejected
activity_projection_read
```

Record app version, platform, modality, counts, queue age, latency, and reason.
Never record device values, titles, URLs, passages, measurements, or payloads.
Extend the existing read-only operator count with adjustments, capture-key
duplicates/conflicts, accepted/deduplicated counts, and query latency. Do not
add an analytics SDK or telemetry table.

## Hard-cut cleanup

- Delete browser recorder HTTP/retry/frozen-buffer/pagehide-keepalive ownership.
- Delete native in-memory activity queue and retry ownership.
- Reject every activity span without `captureKey`; add no old decoder.
- Replace active documentation claiming capture is best-effort or has no
  durable queue. Add a supersession note to the implemented 2026-07-24 cutover;
  preserve it as historical record.
- Keep `reading_sessions`, `services/attention.py`, raw interaction logs, stored
  sessions, alternate device IDs, and attention-derived read state absent.
- Keep current reader cursor, engagement, listening heartbeat, completion,
  Stats query, timezone, device-handle, and sessionization owners.
- Remove every orphaned constant, type, test seam, diagnostic, and comment from
  the deleted in-memory delivery design.

## Non-overlapping implementation lanes

| Lane | Owns | Must not modify |
| --- | --- | --- |
| **A — Backend ledger** | migration, models, Python schemas/handles, store/service, API route, stats SQL, backend tests | Web, Android, presentation |
| **B — Web capture runtime** | `lib/consumption/*`, shell lifecycle, activity BFF routes, browser-storage tests | Media/Stats components, Python, Android |
| **C — Reader and Stats product** | reader adapter/root wiring, media-pane actions/dialog, Stats refresh/health/corrections, component tests | Outbox internals, backend, Android |
| **D — Android listening** | native outbox, recorder, origin transport, player bridge/protocol, Android tests | Web reader/Stats, Python |
| **E — Integration and contract** | real-stack journey, proof registry, active docs/residue gates | Production behavior already owned by A–D |

Lane A fixes the wire contract first. B and D consume it independently. C
depends only on B's public runtime/contract. E starts after A–D are green.

## Files

Create during implementation:

- next Alembic migration;
- `apps/web/src/lib/consumption/activityOutbox.ts`;
- `apps/web/src/lib/consumption/activityRuntime.ts`;
- `apps/web/src/lib/consumption/activityAdjustments.ts`;
- `apps/web/src/app/api/consumption/activity-adjustments/route.ts`;
- `apps/web/src/app/(authenticated)/stats/ActivityHealth.tsx`;
- `apps/android/app/src/main/java/app/nexus/android/playback/NativeActivityOutbox.kt`;
- focused unit/browser/real-Postgres/Android tests and one real-stack journey.

Modify:

- browser: `activityRecorder.ts`, `activityContract.ts`,
  `ActivityCaptureLifecycle.tsx`, `projectionRevision.ts`,
  `AuthenticatedShell.tsx`;
- reader/UI: `ReaderActivityAdapter.ts`, `MediaPaneBody.tsx`,
  `StatsPaneBody.tsx`, its module CSS, and pane/component tests;
- BFF: current activity route and history helpers;
- backend: `db/models.py`, `schemas/consumption_activity.py`,
  `services/consumption/{_activity_store,_activity_stats,service,handles}.py`,
  `api/routes/consumption_activity.py`, teardown, operator counts, tests;
- Android: `NativeConsumptionRecorder.kt`, `NexusOriginClient.kt`,
  `NexusPlaybackService.kt`, `NexusPlayerBridge.kt`, `PlayerProtocol.kt`, and
  matching web Android protocol/runtime decoders;
- docs: architecture, Consumption Activity module, implemented activity
  cutover supersession note, and proof registry.

Delete no historical migration or historical cutover document.

## Implementation and release order

1. Write sensitive failing proofs for transcript capture, stale Stats,
   crash/reload delivery, regrouped replay, adjustment projection, and native
   process recovery.
2. Ship migration/storage/service/API hard cut and real-Postgres proof.
3. Cut browser recorder to durable outbox; delete ephemeral delivery.
4. Cut native listening to durable outbox; delete native memory queue.
5. Fix the reader source contract and Stats freshness.
6. Add health, Add/Exclude/Retract presentation.
7. Run the real-stack journey, residue gates, docs, and scoped validation.

Production uses one exact release SHA. Run the migration/backend before
activating the new clients, then deploy web immediately. There is no dual
payload decoder. Old Android builds are unsupported after cutover and must be
updated; this prototype accepts that hard boundary.

## Acceptance criteria

- **AC1 — Durable web.** A closed span commits to IndexedDB before upload.
  Offline read, reload/process death, reconnect, and drain produce each durable
  server fact exactly once; abrupt termination can lose at most the active
  sub-checkpoint partial interval described in G1.
- **AC2 — Durable native.** Native listening survives service/process death and
  account reconnect through SQLite with the same exactly-once result.
- **AC3 — Regrouping.** Same capture keys under a new mutation/batch are no-ops;
  changed bytes conflict; unrelated later batches continue.
- **AC4 — Coverage.** First genuine post-restore interaction records Web,
  transcript, EPUB, and PDF Reading on desktop and mobile. Restore alone does
  not record.
- **AC5 — Lifecycle.** Hidden/background/suspension closes and durably stores
  only defensible elapsed time. No unload/pagehide network assumption remains.
- **AC6 — Health.** Offline, auth loss, media loss, expiry, capacity, storage
  failure, and same-system rejection produce the specified observable state;
  no capture silently degrades or falls back to memory.
- **AC7 — Freshness.** Same-process upload updates mounted Stats without reload;
  pane activation/focus/pageshow/visible/online revalidates cross-process data
  without polling or remounting.
- **AC8 — Correction.** Add changes manual and total time; Exclude removes one
  observed session without deleting spans; Retract restores the exact prior
  projection. Replay and concurrency are linearized.
- **AC9 — Semantics.** `activeMs = recordedActiveMs - excludedActiveMs +
  manualActiveMs`; filters, buckets, DST, sessions, streaks, devices,
  contributors, visibility, and teardown remain coherent.
- **AC10 — Account/device privacy.** Outboxes are account-partitioned;
  `nx_device` remains BFF-only; browser storage/API/diagnostics expose no raw
  device value or reading content.
- **AC11 — UX/accessibility.** Status, dialog, actions, feedback, focus return,
  keyboard, screen reader, narrow pane, zoom, forced colors, and reduced motion
  pass through existing primitives.
- **AC12 — Hard cut.** No memory-only activity queue, direct adapter upload,
  compatibility payload, alternate identity, fallback, raw interaction log,
  stored session, poller, SSE, service worker, or dead legacy symbol remains.
- **AC13 — Proof.** Sensitive pure state-machine, real Chromium IndexedDB,
  real-Postgres replay/projection, Android persistence, and one capture-to-Stats
  real-stack journey pass in their repository-owned gates.
