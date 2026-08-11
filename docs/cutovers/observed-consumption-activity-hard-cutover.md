# Observed Consumption Activity — Hard Cutover

**Status:** IMPLEMENTED IN SOURCE · 2026-08-11. Focused policy/static,
real-Postgres, real-Chromium, and migration proofs pass. The production bundle
and real-stack journey are locally blocked by repeated SIGTERM under shared-host
memory pressure; clean-commit PR/full and physical Android proofs remain
unexecuted.

**Type:** Hard cutover — no positive manual time, legacy endpoint, legacy
payload, compatibility decoder, dual schema, fallback, or feature flag.

[`docs/rules/index.md`](../rules/index.md) governs this cutover. This is the
active source contract; the automatic-capture predecessor remains documented by
[`durable-consumption-activity-hard-cutover.md`](durable-consumption-activity-hard-cutover.md),
and [`consumption-activity.md`](../modules/consumption-activity.md) owns the
current module boundary.

## Fixed decision

Questions requiring a user answer: none.

Nexus records what Nexus observed. The user does not maintain a timesheet.
Corrections may subtract a falsely observed session and restore that exact
subtraction; they can never manufacture activity.

## Target behavior

- Reading, listening, and video-pane time continue to appear automatically.
- No surface can add, edit, import, or run a timer for consumption time.
- Stats labels the headline **Observed time** and never says “added” or
  “manual.”
- A full, exact observed session has a quiet overflow action: **Don’t count
  this session**. Existing `ActionMenu`, confirmation, feedback, and focus
  restoration primitives are reused.
- **Excluded activity** appears only when an active exclusion exists and
  offers **Restore**.
- Pause/Resume, pending/failed health, Retry, Discard failed, progress,
  completion, and Library time estimates remain unchanged. They are not manual
  history entry.
- Zero means no accepted observed activity in the selected view. Capture health
  remains visible so zero does not silently mean broken capture.

## Goals

- Remove every positive user-authored duration from UI, transport, domain,
  storage, projections, tests, and active docs.
- Make additive manual time unrepresentable in final types and schema.
- Preserve automatic capture, local-first durability, idempotency, factual
  exclusions, and deterministic Stats.
- Reduce branches, fields, labels, and correction prominence.

## Non-goals

- No change to recorder eligibility, 30-second spans, capture keys, browser
  IndexedDB, Android SQLite, retry policy, or freshness triggers.
- No provider imports, physical-book tracking, OS activity, generic timer,
  video playback certification, overlap deduplication, ML, gaze, confidence,
  rollup, cache, queue, workflow engine, export, or backfill.
- No change to completion facts, current progress/state, retained artifacts,
  charts, streak policy, Year period semantics, or Library reading-time
  estimates.
- No arbitrary interval editing or partial-span correction.

## Final architecture

```text
reader / owned audio / visible video pane
  -> existing recorder
  -> existing durable browser or Android outbox
  -> POST /consumption/activity
  -> immutable consumption_activity_spans
  -> exclusions subtract exact observed sessions
  -> deterministic Stats and session projections
```

| Concern | Sole owner | Final rule |
| --- | --- | --- |
| Observation and delivery | Existing browser/Android capture owners | Unchanged |
| Span and exclusion DML | `_activity_store.py` | No other module writes either table |
| Exclusion policy/replay | Consumption `service.py` | Exact session only; one serializable mutation |
| Aggregation/sessionization | `_activity_stats.py` | Observed spans minus active exclusions |
| Strict API shapes | Python schema + web decoder | One exact shape; reject extras |
| Presentation | Stats | Correction is secondary, not a primary metric |

HTTP and BFF code only decode, translate, and invoke Consumption. Adapters only
publish observations. Progress and completion never create time.

## Capability contract

### Observed activity

The existing `POST /consumption/activity`, recorder, outboxes, and span schema
do not change. `consumption_activity_spans` remains the sole positive-duration
fact family.

For every query:

```text
recordedActiveMs = accepted visible span duration before exclusions
excludedActiveMs = recorded span duration removed by active exclusions
activeMs         = recordedActiveMs - excludedActiveMs
```

All timeline, day, hour, media, contributor, device, session, and streak
metrics use effective `activeMs`. There is no second `observedActiveMs` alias.

### Exclude and restore

- Exclude accepts only one exact, current, all-time, un-clipped observed
  gap-and-island session returned by the sessions API.
- The target identity is `(viewer, media, modality, device, startedAt,
  endedAt)`. The service resolves the device handle, rechecks media visibility,
  and re-derives the session inside the write transaction.
- An active exclusion removes only spans wholly contained in its right-open
  `[startedAt, endedAt)` interval. Overlapping exclusions never double-subtract.
- Restore marks that exact viewer-owned exclusion restored. It does not edit or
  recreate spans.
- Excluding a missing/already-excluded session and restoring a missing/already-
  restored exclusion are typed request/conflict errors.
- Exact replay returns the memoized result; reuse of a `clientMutationId` with
  different canonical bytes conflicts.
- Media teardown deletes exclusions through the existing Consumption teardown
  owner before deleting the media row.

## Storage hard cut

Add `0214_observed_consumption_activity.py`; do not edit historical migration
`0213_durable_consumption_activity.py`. The new migration has no downgrade.

Final table:

```text
consumption_activity_exclusions
  id           uuid primary key
  user_id      uuid not null -> users.id
  media_id     uuid not null -> media.id
  modality     text not null
  device_id    text not null
  started_at   timestamptz not null
  ended_at     timestamptz not null
  created_at   timestamptz not null default now()
  restored_at  timestamptz null
```

Indexes, and only these proven query-path indexes:

```text
(user_id, started_at, id)
(user_id, media_id, device_id, started_at, id)
(media_id, id)
```

Migration procedure:

1. Fail if an existing row has an unknown kind or an invalid Exclude shape.
2. Delete all `kind = 'Add'` rows. Do not archive or translate them into spans.
3. Delete `resource_mutations` rows for
   `Consumption.ActivityAdjustments`.
4. Delete no Exclude row. Rename the table to
   `consumption_activity_exclusions`; preserve its IDs and `created_at`.
5. Rename `occurred_at -> started_at` and
   `retracted_at -> restored_at`; materialize
   `ended_at = started_at + duration_ms`; make `device_id` non-null.
6. Drop `kind` and `duration_ms`; rename every FK/index to exclusion language.

Application code owns interval and branch invariants. Add no CHECK, cascade,
JSON, note, confidence, updated timestamp, session row, or audit table.

## API hard cut

Delete `POST /consumption/activity-adjustments` in FastAPI and the BFF. Add:

```text
POST /consumption/activity-exclusions

Exclude {
  kind=Exclude, clientMutationId,
  mediaRef, modality, deviceHandle, startedAt, endedAt
}

Restore {
  kind=Restore, clientMutationId, exclusionHandle
}

-> { data: {
     outcome: Excluded | Restored,
     exclusionHandle: ActivityExclusionHandle
   } }
```

The command is a real two-state lifecycle union, not a generic adjustment
extension point. Bodies are strict camelCase, reject extras, use PascalCase
variants, canonical UUID replay IDs, sealed `nce1` exclusion handles, and
private `no-store` responses. There is no Add variant or old-handle decoder.
The BFF forwards the decoded body unchanged; it does not read or expose
`nx_device`. Successful mutations publish the existing process-local
Consumption projection revision.

Use replay scope `Consumption.ActivityExclusions`. Reuse the current viewer
lock, serializable retry, canonical request hashing, resource-mutation replay,
media visibility, device sealing, and exact-session helpers. Rename/adapt them;
do not introduce a second correction service or replay mechanism.

Stats and session reads hard-cut to:

```text
totals {
  recordedActiveMs, excludedActiveMs, activeMs,
  activeDays, streak, longestStreak, sessionCount,
  forwardWordPosition, forwardMediaPositionMs
}

session {
  mediaRef, title, modality,
  device: DeviceSummary,
  startedAt, endedAt, activeMs,
  forwardWordPosition, forwardMediaPositionMs,
  firstProgress, lastProgress,
  continuesBeforeRange, continuesAfterRange
}

activeExclusions[] {
  exclusionHandle, mediaRef, title, modality, device,
  startedAt, endedAt, excludedActiveMs
}
```

Delete session `source`, session `adjustmentHandle`, `manualActiveMs`, and
`observedActiveMs`. Session device Presence becomes a required `DeviceSummary`
because every remaining session is observed. Remove `source` from the opaque
session cursor; old cursors are invalid and receive no compatibility decoder.

## Product cut

- Delete `AddActivityDialog`, its state, action descriptor, helper, CSS, and
  dedicated browser test from the media pane.
- Stats summary and Year hero show one observed duration; delete the
  observed/added provenance line.
- Session rows omit the redundant “Observed” source label.
- Delete the permanent **Correction** column. For exact un-clipped sessions,
  render the existing `ActionMenu` in the Session cell with one accessible
  `ActionDescriptor`: **Don’t count this session**. Clipped sessions expose no
  correction control.
- Keep the conditional **Excluded activity** section and Restore action, renamed
  to exclusion handles throughout.
- Reuse existing confirmation, HUD/error mapping, duration/date formatting,
  buttons, tokens, and projection refresh. Add no dialog, table abstraction,
  icon family, or product/navigation route.

## Files

Create:

- `migrations/alembic/versions/0214_observed_consumption_activity.py`;
- `apps/web/src/lib/consumption/activityExclusions.ts` and focused unit test;
- `apps/web/src/app/api/consumption/activity-exclusions/route.ts` and route
  test;
- focused migration proof for `0213 -> 0214`.

Delete:

- `apps/web/src/lib/consumption/activityAdjustments.ts`;
- `apps/web/src/app/api/consumption/activity-adjustments/route.ts` and its
  test;
- `MediaPaneBody.activity.browser.test.tsx`.

Modify:

- backend: `db/models.py`, `schemas/consumption_activity.py`,
  `services/consumption/{_activity_store,_activity_stats,service,handles}.py`,
  `api/routes/consumption_activity.py`,
  `ops/consumption_activity_counts.py`, teardown and focused tests;
- web transport: `historyBff.server.ts`, `statsContract.ts`, and their tests;
- product: `MediaPaneBody.tsx`, media `page.module.css`, `StatsPaneBody.tsx`,
  its browser test and module CSS;
- integration: `durable-consumption-activity.journey.spec.ts`,
  `resourceActionProductOracle.ts`, its ActionMenu policy inventory,
  `testdata/proofs.json`, and
  `python/nexus_test_control/model.py`'s independently frozen ownership digest;
- release proof fixtures: `python/tests/kernel/test_production_release.py` and
  `python/tests/testkit/{production_deploy,release_bundle}.py` advance their
  candidate database revision to `0214`;
- docs: `architecture.md`, `modules/consumption-activity.md`, and a
  supersession note in the implemented durable-activity cutover.

Pin the historical 0213 migration test to revision `0213`; it must not treat
0213 as repository head. Historical migrations and cutover documents remain.
The read-only operator report renames its adjustment count to exclusions and
counts the new exclusion replay scope; add no telemetry path.

## Non-overlapping work packages

| Package | Owns | Must not modify |
| --- | --- | --- |
| A — Backend/storage | 0214 migration, models, Python schema/handle/store/service/API/ops, Python tests | Web or product UI |
| B — Web boundary | `activityExclusions`, BFF/route, Stats decoder, unit/route tests | Python, components, CSS |
| C — Product UI | Media/Stats components, CSS, browser tests | Python, BFF, decoder internals |
| D — Integration/docs | E2E, active docs, residue gates, final proof | A–C production owners |

A fixes the wire contract. B implements that exact contract. C consumes only
B's exports. D starts after A–C are green. No package creates a transitional
adapter.

## Acceptance criteria

- **AC1 — Positive facts.** Only automatic activity ingestion can increase
  consumption time. No user-facing or correction API operation accepts a
  duration.
- **AC2 — Schema.** Add rows and old replay memos are deleted; Exclude rows
  retain identity and semantics in the exact final exclusion table. No
  adjustments table or kind column remains.
- **AC3 — Projection.** `activeMs = recordedActiveMs - excludedActiveMs` for
  totals and all breakdowns; no manual union/query/session exists.
- **AC4 — API.** Exclude/Restore are strict, viewer-owned, replayable, sealed,
  private/no-store, and the only correction commands. Old route/payload/handle
  shapes fail.
- **AC5 — Sessions.** Every session is observed and has a required safe device;
  clipped sessions cannot be excluded; exact exclusion and restore refresh the
  mounted Stats view.
- **AC6 — UI.** Media and Stats contain no Add/edit-time affordance or
  added/manual copy. The rare session action is keyboard/screen-reader
  operable and returns focus correctly.
- **AC7 — Capture.** Browser reading/audio/video and native Android listening
  retain their current durable capture, offline replay, health, and identity
  behavior. Physical Android proof remains required for native claims.
- **AC8 — Teardown/privacy.** Visibility filtering and media teardown cover
  exclusions; raw device values and span payloads never reach UI/logs.
- **AC9 — Proof.** Migration, real-Postgres service/API, strict decoder/route,
  Chromium component, real-stack E2E, path-scoped static checks, production
  build, Android host/device checks, `git diff --check`, and residue gates pass.

## Residue gates

The following names may appear only in historical migration `0213`, historical
cutover documents, destructive migration `0214`, its focused migration proof,
this cutover's destructive inventory, and strict negative boundary proofs. They
are absent from active production owners, module/architecture contracts, and
positive fixtures:

```text
consumption_activity_adjustments
Consumption.ActivityAdjustments
ActivityAdjustment
activity-adjustments
AddActivityDialog
ViewAction.Consumption.AddTime
manualActiveMs / manual_active_ms
Consumption session source = Manual / source: "Manual"
adjustmentHandle
Add reading time / Add listening time / Add viewing time / added time
```

`consumption_activity_exclusions` DML exists only in `_activity_store.py`
(plus migration SQL). Focused strict-boundary proofs may submit one removed
payload to prove fail-closed rejection. No positive legacy fixture, manual-
duration parser, compatibility decoder, hidden admin/import path, dead style,
or stale active-doc claim remains.

## Release

Implement red/green by package, then ship migration, backend, BFF, and web UI as
one exact release SHA. Clients calling the removed adjustment route are
unsupported; automatic activity clients are unchanged. Do not down-migrate,
restore deleted Add facts, or deploy a dual decoder as rollback; roll forward
from the final schema.
