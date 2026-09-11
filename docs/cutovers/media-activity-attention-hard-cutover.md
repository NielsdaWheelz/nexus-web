# Media Activity attention hard cutover

**Status:** Superseded · 2026-09-08 by
[`imports-workspace-hard-cutover.md`](imports-workspace-hard-cutover.md), which
replaced `GET /media/activity`, the Nexus Activity task, and the Account
total-open badge with the `/imports` workspace pane. This document is retained
as the historical record of the attention model those surfaces used; the file
paths it names no longer exist.

**Type:** One-release hard cutover. No flag, dual response, compatibility
decoder, fallback, or legacy presentation survives.

## Decision

Activity is a viewer-scoped exception queue over existing canonical ingest
state. Store execution evidence; project current obligations.

- Active work is transient and never badges.
- Successful, superseded, and otherwise complete work is absent.
- Current actionable failure remains until retry, repair, removal, or a newer
  canonical generation resolves it.
- Opening Activity does not acknowledge or clear anything.
- Clearing is projection removal, never deletion of attempts or job history.

This document supersedes only the Activity API, badge, presentation, and refresh
contract in
[bounded-resource-media-processing-hard-cutover.md](bounded-resource-media-processing-hard-cutover.md).
Source attempts, jobs, content-index state, repair, resource actions, and media
visibility keep their current owners.

## Goals and scope

In scope:

- one canonical `Active | NeedsAttention | Complete` classification;
- failure-only badge and automatically clearing success;
- a strict replacement Activity wire contract;
- closed-panel and cross-tab convergence while known work is active;
- stale-read safety, accessibility, copy, tests, and legacy deletion.

Non-goals:

- a new table, event log, notification center, inbox, acknowledgement, snooze,
  dismissal, retention job, or history screen;
- pagination, filters, search, bulk actions, push notifications, email, or OS
  notifications;
- Redis, Temporal, Vercel Workflow, another queue, or a new SSE/WebSocket plane;
- changes to ingest, retry, repair, indexing, deletion, queue, or capability
  semantics;
- operator-health presentation, job-history cleanup, or a shared browser
  lifecycle framework.

No database migration is required.

## Rules and invariants

Follow `docs/rules/*`, especially `boundaries`, `cleanliness`, `control-flow`,
`correctness`, `database`, `frontend`, `polling`, `simplicity`, and `testing`.

1. `python/nexus/services/media_activity.py` is the sole Activity classifier.
   Counts, membership, ordering, and item state use the same classified CTE;
   clients never reconstruct lifecycle state.
2. One viewer-visible media item produces at most one Activity item. The latest
   source attempt is the root; source state takes precedence over derivative
   search state.
3. `Complete` rows are filtered before ordering and `LIMIT`. New successes can
   never crowd out an older failure.
4. Queue `failed` means automatic retry/backoff and is `Active`, not attention.
   Only a modeled terminal source failure or exact current dead source/search
   operation needs attention.
5. A succeeded/superseded source attempt wins over a dead stale source-job
   anomaly. The anomaly belongs to operator health unless user capability is
   degraded.
6. A media content-index `failed` state without its exact current dead operation
   is an invariant defect: public Search repair cannot act on it. Do not invent a
   user-facing fallback.
7. `needs_attention_count` is the exact badge predicate. `active_count` controls
   progress refresh only. Neither is derived from the returned page length.
8. Failed refresh preserves the last successful snapshot. Unknown is never
   presented as zero.
9. Activity persists nothing. Attempt/job pruning cannot change a still-current
   modeled source failure; exact retained dead jobs remain the repair boundary.

## Classification

Evaluate current source evidence first, then current search evidence:

| Canonical evidence | Projection | Badge |
| --- | --- | --- |
| accepted attempt, including pre-enqueue `job_id = NULL` | `Active/Queued/Validate` | no |
| exact source job `pending` or retryable `failed` | `Active/Queued` | no |
| exact source job `running` | `Active/Processing` | no |
| source attempt terminal `failed`, with no automatic retry running | `NeedsAttention/Source` | yes |
| exact current source job `dead` and source not published | `NeedsAttention/Source` | yes |
| source published; current index pending/retrying/running | `Active/Queued|Processing/Index` | no |
| source published; exact current index job `dead` | `NeedsAttention/Search` | yes |
| source and current index complete, `no_text`, or `ocr_required` | `Complete` and omitted | no |
| source published but its source job is dead | ignore source anomaly; evaluate search | no |

`RetryBackoff`, `Capacity`, and `Queue` remain waiting reasons. A reclaimed
running job may expose only the exact `E_WORKER_INTERRUPTED` evidence; never
infer OOM, percentage, or ETA.

## Capability and API contract

Retain `GET /media/activity?limit=20`; `limit` remains `1..20`, default `20`.
The authenticated repeatable-read route stays thin and viewer-filtered.

Hard-replace the response with:

```text
MediaActivityOut {
  needs_attention_count: integer >= 0
  active_count: integer >= 0
  has_more: boolean
  items: MediaActivityItem[]
}

MediaActivityItem {
  media_id, title, media_kind, source_attempt_id
  state:
    Active {
      kind: Active
      status: Queued | Processing
      stage: Validate | Extract | Finalize | Index
      waiting_reason: Presence<Queue | Capacity | RetryBackoff>
      progress: Presence<SourceProgress>
      status_code: Presence<nonempty string>
    }
  | NeedsAttention {
      kind: NeedsAttention
      scope: Source | Search
      stage: Validate | Extract | Finalize | Index
      failure_code: Presence<nonempty string>
    }
  request_id: Presence<nonempty string>
  run_count, queue_attempts, queue_max_attempts: integer >= 0
  created_at, updated_at
  capabilities: can_open, can_repair_source, can_repair_search, can_remove
}
```

The nested closed union makes invalid field combinations unrepresentable. Use
`Presence`; do not introduce nullable compatibility shapes. `SourceProgress`
and `POST /media/{media_id}/repair` are unchanged.

Return attention items first, oldest failure first, then active items newest
first. Counts cover all matching media; `has_more` is true exactly when
`needs_attention_count + active_count > len(items)`. No pagination is added in
this cut. The UI states the shown/total count when truncated.

Delete `nonterminal_count`, `nonterminalCount`, top-level Activity lifecycle
fields, and the `Ready` Activity variant. Backend and frontend ship atomically;
old payloads must fail the new exact decoder.

## Composition and refresh

```text
existing attempts + exact jobs + current index state
  -> viewer-scoped classified CTE
  -> strict Activity snapshot
  -> one authenticated-shell provider
  -> Activity cards + every nav badge
```

Reuse the existing Activity service/schema/route, exact client decoder,
authenticated-shell provider, `useIntervalPoll`, `activityPolling.ts`, library
placement revision, repair service, resource action menu, and shared status-copy
owner. Do not add a second store or client-side filter.

The provider owns one last-good snapshot and one invalidation lane:

- read once on mount and whenever Activity becomes visible;
- re-read after accepted import, repair, or removal;
- re-read on visible, focus, pageshow, and online resume;
- replace the accepted-only event with one `Media.ActivityInvalidated` signal;
- deliver it in-tab and through one native `BroadcastChannel`; it is a wake hint,
  never truth, and has no storage-event fallback;
- if invalidated during an in-flight read, mark dirty and perform exactly one
  trailing read after settlement; requests never overlap;
- poll every five seconds only while the last good snapshot has
  `active_count > 0`, for the existing bounded 15-minute window; Activity open
  or a lifecycle/invalidation signal starts a fresh window;
- an automatic read failure ends that polling window; manual, lifecycle, or
  invalidation refresh may start a new one without discarding the last good data;
- stop immediately at `active_count = 0`; after expiry, manual or lifecycle
  refresh remains available.

This is the sole `justify-polling`: Activity is a composed Postgres snapshot and
the cut adds no server push plane. If freshness beyond the bounded window becomes
a measured problem, the next layer is Postgres invalidation as a wake hint plus
snapshot re-read over SSE—not durable duplicate notification state.

## Product structure

- Keep Activity as a Nexus switchboard workflow.
- Header: `Activity`; summary: `N imports need attention · M in progress`, with
  zero terms omitted.
- Render attention cards first with danger emphasis; render active cards with
  quiet neutral treatment. Never render a success card or success tombstone.
- Empty state: `No imports need attention.` If work is active, show its cards;
  otherwise add `New import failures will appear here.`
- The nav badge exists only when `needs_attention_count > 0`, caps visually at
  `99+`, and uses the same count in desktop, mobile, and accessible labels:
  `Activity, N imports need attention`.
- Retry stays in the canonical resource action flow. Exact dead work exposes
  existing Source/Search Repair; Remove stays in `ResourceActionMenu`.
- Opening, refreshing, or reading a card never clears it. Repair acceptance
  moves it to active; success removes it; renewed dead failure restores it.
- Replace row-level live regions with one polite page-level count announcement.
  Request and mutation errors remain assertive.
- Keep factual stage, attempt, timestamp, request-ID, and safe-code details. Do
  not expose raw queue errors, payloads, stack traces, or host paths.

## Files and non-overlapping work

### A. Projection/API

Own only:

- `python/nexus/services/media_activity.py`
- `python/nexus/schemas/media_activity.py`
- `python/nexus/api/routes/media_activity.py` if its declared response changes
- `python/tests/service/test_media_activity.py`

Build the single classified query, strict schema, count/limit behavior, and
service tests. Do not edit queue, ingest, repair, index, or frontend owners.

### B. Client synchronization

Own only:

- `apps/web/src/lib/media/activityClient.ts`
- `apps/web/src/lib/media/activityClient.unit.test.ts`
- `apps/web/src/lib/media/MediaActivityProvider.tsx`
- `apps/web/src/lib/media/activityPolling.ts` and its unit test
- Activity invalidation calls in `apps/web/src/lib/media/ingestionClient.ts`

Implement the strict decoder, invalidation channel, trailing-edge single flight,
last-good state, lifecycle refresh, and active-only polling. Move placement
invalidation into the provider. Do not edit rendering or backend files.

### C. Presentation/navigation

Own only:

- `apps/web/src/lib/status/mediaActivity.ts`
- `apps/web/src/components/nexus/MediaActivityPage.{tsx,module.css}`
- `apps/web/src/components/appnav/{AppNav,NavRail,MobilePaneBar}.tsx`
- `apps/web/src/components/nexus/MediaActivityPage.browser.test.tsx`
- `apps/web/src/components/nexus/MediaActivityNavigation.browser.test.tsx`

Implement copy, ordering-preserving rendering, failure-only badges, overflow,
actions, and accessibility. Do not classify, filter, or refetch lifecycle state.

### D. Integration/cleanup

After A-C, align the superseded clauses in the bounded-resource cutover doc, run
focused plus repository-standard gates, and delete orphaned Activity symbols,
branches, copy, styles, fixtures, and tests. Redesign no owner.

Order: A -> B -> C -> D. A-C may use the contract above in parallel but may not
share file ownership. No partial state is production-admissible.

## Acceptance criteria

Projection/API:

- complete successes never appear, including when newer than a failure;
- auto-retry is active and never counted; terminal Source/Search failure is
  counted once per media;
- a published source plus dead source-job anomaly does not badge;
- list membership and both counts share one exhaustive classification;
- viewer isolation, failure-first ordering, limit, and `has_more` are exact;
- pruning completed jobs does not resurrect or erase user attention.

Convergence:

- accepted -> active -> success clears while Activity is closed;
- accepted -> active -> terminal failure produces a badge while closed;
- repair failure -> active -> success clears; renewed dead failure reappears;
- an invalidation during a read forces one trailing read;
- another tab's acceptance or repair wakes this tab;
- resume/open/manual refresh converges work that outlives the polling window;
- a failed refresh retains the prior nonzero badge and exposes retry.

Product:

- active work never badges; all nav surfaces and labels use only
  `needs_attention_count`;
- no success, `Ready`, `open items`, or `recent media work` presentation remains;
- empty, active-only, failure-only, mixed, and truncated states are explicit;
- only meaningful attention-count changes announce politely;
- Retry, Repair, Open, and Remove remain capability-gated by their existing
  canonical owners.

Hard-cut residue:

- repository search finds no Activity use of `nonterminal_count`,
  `nonterminalCount`, `MediaActivityItem.status`, or the Activity `Ready` branch;
- no client-side lifecycle filter, legacy decoder, alias, fallback transport,
  manual clear, new persistence, or duplicate repair/action path exists;
- backend service, strict decoder/copy, provider synchronization, component, and
  navigation behavior tests pass, followed by standard repository gates.
