# Podcast Freshness And Pane Refresh Hard Cutover

Status: APPROVED SPEC
Date: 2026-07-30
Type: hard cutover

No blocking product question remains. This spec fixes the approved defaults:
rolling daily podcast freshness, metadata-only sync, exact named-Library scope,
mobile pull plus an accessible menu action, and Postgres `NOTIFY`/SSE completion.

## Decision

Freshness is a data capability; pull-to-refresh is one way to invoke it.

- Healthy active subscriptions are admitted for one live feed check per
  rolling day; provider and worker outages remain observable failures.
- A user may refresh one Podcast, all Podcasts, or the Podcasts in one exact
  named Library.
- Podcast refresh is truthful: the UI waits for durable work to finish over the
  existing Postgres `NOTIFY`/SSE stack, then revalidates the owning view.
- Ordinary collection refresh revalidates its existing owner in place.
- Mobile standard-scroll panes support top-edge pull-to-refresh. Every
  refreshable pane also exposes **Refresh** in its existing pane menu.
- Content, focus, and scroll position remain stable while refreshing.

The 80/20 cut is six existing, finite, standard-scroll data panes:
Libraries, Library, Author, Conversations, Podcasts, and Podcast Detail.
Every other pane remains unchanged and publishes no refresh capability.

## Goals

- Make podcast freshness automatic, bounded, durable, observable, and manually
  recoverable.
- Give refresh one pane-level interaction grammar without inventing a generic
  reload framework.
- Reuse the durable job queue, collection revisions, exhaustive pagination,
  pane publications, Postgres `NOTIFY`, SSE listener, stream-token, and direct
  SSE client owners.
- Leave one implementation path per capability and delete all superseded paths.

## Non-goals

- Audio download, transcription, history backfill, playback queue,
  notification, or playback changes.
- Browser background sync, app-open refresh, exact wall-clock scheduling, or a
  per-Podcast cadence preference.
- WebSub, Podping, conditional RSS requests, adaptive cadence, or cross-user
  feed fan-out. These are later optimizations, not foundations for this cut.
- Pull gestures for readers, editors, generation/transient panes, custom
  scrollports, desktop pointers, or nested scrollers.
- A router/window reload fallback, polling fallback, second event transport,
  cancellation API, run-history UI, analytics UI, or new workflow framework.

## Governing Rules

Follow `docs/rules/*`, especially `cleanliness`, `simplicity`, `boundaries`,
`concurrency`, `mutation-ordering`, `retries`, `timing`, `polling`, `frontend`,
`database`, `naming`, and `testing`.

Consequences:

- one owner for each transaction boundary and one event path;
- DB row state and successor job insertion commit atomically;
- no feed/network I/O inside a DB transaction;
- `NOTIFY` is invalidation only; Postgres rows are truth;
- explicit exhaustive states use PascalCase;
- no new business `CHECK` constraints or cascade deletes;
- expected feed failures are data; unexpected defects retry/dead-letter;
- no optional compatibility props, aliases, legacy handlers, fallbacks, or
  duplicated helpers.

## Final Architecture

```text
background schedule ─┐
pane Refresh ─────────┼─> admission transaction
row Check for updates ┘     scope + run/items + generation + sync job
                                    |
                     exact queue job/attempt claim
                                    |
                             fetch RSS once
                                    |
                ingest transaction: metadata + generation checkpoint
                                    |
          SERIALIZABLE final transaction: auto-queue + subscription
             + all joined items + parent runs + collection revisions
                                    |
                      AFTER trigger -> pg_notify(run id)
                                    |
             LISTEN -> snapshot SSE -> terminal done
                                    |
                awaitable owner revalidation -> stable pane
```

Ownership:

| Concern | Sole owner |
| --- | --- |
| Scope resolution, run creation, generation admission, aggregation | `services/podcasts/refresh.py` |
| One feed fetch, ingest checkpoint, exact-attempt finalization | `services/podcasts/sync.py` |
| Due admission | `podcast_refresh_due_job` |
| Durable execution, lease, retry, dead letter | existing jobs runtime |
| Run truth | `podcast_refresh_runs` and `podcast_refresh_run_items` |
| Wake-up | existing Postgres listener plus `pg_notify` trigger |
| Stream framing/reconnect/auth | existing `_sse.py`, stream route, stream token, `sseClientDirect` |
| Pane capability value | `lib/panes/panePublications.ts` |
| Gesture/menu/status presentation | `PaneShell` |
| First-page reload ordering and acknowledgement | each existing pane/list owner |

## Podcast Freshness Contract

### Cadence

- `podcast_refresh_due_job` runs every 15 minutes on the background lane.
- A healthy completion sets `next_sync_at` to 23 hours plus deterministic
  per-subscription jitter in `[0, 30m]`. Compute jitter as the first 64 bits of
  `SHA-256(subscription_id.bytes)`, interpreted big-endian, modulo `1801`
  seconds. With one scheduler tick, a healthy subscription is admitted again
  inside 24 hours.
- A modeled feed failure uses one named bounded backoff schedule; success resets
  the failure count: `15m, 1h, 6h, 24h`, capped at 24 hours. Never busy-loop or
  retry forever.
- The coordinator claims at most 100 oldest-due subscriptions ordered by
  `(next_sync_at, id)` with `FOR UPDATE SKIP LOCKED`.
- It groups claims by viewer, creates one scheduled run per viewer/batch, and
  inserts child jobs in the same transaction. No due rows creates no run. No
  global singleton lease exists.
- Manual refresh ignores `next_sync_at`. It joins an already
  `Pending`/`Running` generation; otherwise it starts the next generation.
- Subscribe and OPML call the same generation-admission primitive but create no
  refresh run; their existing commands already own user-visible completion.
- Queue priority is ascending. Single Subscribe and manual refresh use
  `PODCAST_SYNC_INTERACTIVE_PRIORITY = 75`; scheduled and OPML-batch children
  use `PODCAST_SYNC_BULK_PRIORITY = 100`.
- If manual refresh joins a pending/unclaimed scheduled job, new queue doorway
  `promote_unclaimed_job` exact-matches job id/kind/payload and sets priority
  `75` plus `available_at = now()`. Existing `update_unclaimed_job` does not
  mutate priority. A running job is not replaced.
- Every path uses `podcast_sync_subscription_job`; none inserts it directly
  outside the admission owner.

### Sync

- Identity is three-dimensional:

  ```text
  subscription_id = one subscribe -> unsubscribe epoch
  sync_generation = one refresh cycle inside that epoch
  job_id/attempt_no = one queue execution claim
  ```

State transitions are exhaustive:

| Event | Subscription | Joined run items |
| --- | --- | --- |
| new Subscribe/OPML row | new epoch, generation `1`, `Pending`, `next_sync_at = now()` | no refresh run |
| terminal admission | generation `+1`, `Pending`, clear error/job/checkpoint | new `Pending` |
| active admission | generation unchanged | new item mirrors `Pending`/`Running` |
| exact queue claim/reclaim | `Running`, new attempt/start and job-attempt fence | all nonterminal -> `Running` |
| ingest commit | `Running` with same-generation checkpoint | unchanged |
| healthy finalization | `Complete | SourceLimited`, next healthy due | all nonterminal -> same terminal status |
| modeled failure/dead letter | `Failed`, next backoff due | all nonterminal -> `Failed` |
| unsubscribe | row deleted after epoch skip | all nonterminal -> `Skipped` |
| stale epoch/generation or already-terminal replay | no write; successful job no-op | no write |

- Job payload is
  `{subscription_id, user_id, podcast_id, sync_generation}`. The subscription
  UUID is protocol identity, not a run-item foreign key.
- Dedupe key is `podcast-sync:{subscription_id}:{sync_generation}`. A
  resubscription can never collide with a retained prior-epoch job.
- `retry_serializable` around the admission transaction is the generation-bump
  linearization point. Two concurrent manual commands either join the same
  active generation or serialize into distinct later generations; they cannot
  both bump `N -> N+1`.
- Admission creates any run item and inserts the unique job in the same
  transaction as the state-table transition.
- The task receives `JobExecutionContext`. Claim requires the exact
  subscription UUID, viewer, Podcast, generation, and live queue
  `job_id/worker_id/attempt_no` lease. It writes `Running`, increments the
  existing attempt counter, and stores the exact job/attempt fence.
- Every claim, ingest, checkpoint, and finalization transaction acquires the
  queue-owned exact-attempt row fence after external I/O and holds it through
  commit. Never hold that row lock during the RSS request.
- Lock order is queue attempt -> subscription -> user row when auto-queue
  requires it -> run items/runs. A manual join may read the current job id, but
  must acquire the queue row before conditionally re-reading/updating the
  subscription; serialization drift retries the operation.
- Queue ownership replaces the duplicate subscription-running timer. Delete
  `PODCAST_SYNC_RUNNING_LEASE_SECONDS`; retain the existing attempt/start CAS as
  a second exact-write fence.
- Fetch and parse the RSS document once per attempt. Reuse that snapshot for
  episode augmentation and chapter discovery; delete the second traversal.
- Preserve canonical Podcast/episode identity, current-window limits,
  auto-queue, collection-revision bumps, and the independent backfill owner.
- The fenced ingest transaction writes episode metadata and a generation
  checkpoint containing cutoff, `Complete | SourceLimited`, and the exact newly
  inserted episode count. A retry with that checkpoint skips feed I/O and
  resumes finalization; it cannot recount.
- The existing fresh SERIALIZABLE auto-queue transaction remains separate. It
  revalidates the subscription epoch/generation plus exact live queue attempt,
  applies the checkpoint through the existing user-row/Consumption ordering,
  then atomically:
  - sets subscription `Complete | SourceLimited`;
  - clears error, exact-job, and generation-checkpoint state;
  - resets consecutive failures and schedules the next healthy check;
  - re-queries and terminalizes every currently nonterminal run item for the
    epoch/generation, including a manual join that arrived mid-flight;
  - recomputes affected runs and bumps collection revisions.
- A modeled provider/feed or auto-queue/domain failure records a stable public
  error code, advances failure count/backoff, copies any checkpointed episode
  count, terminalizes the subscription and all joined items as `Failed`,
  recomputes runs, and bumps revisions in one transaction.
- Unexpected exceptions do not fabricate `E_INTERNAL` product results. They
  leave the generation resumable for ordinary job retry.
- Run aggregation locks affected parent runs in sorted-id order before reading
  their items. Concurrent sibling completions therefore serialize their
  snapshots; a fully terminal item set cannot be stranded as `Running`.
- `podcast_sync_subscription_job` has a dead-letter handler. In the queue's
  dead-letter transaction it exact-matches the payload epoch/generation and the
  dead job/attempt, records `E_PODCAST_SYNC_RETRY_EXHAUSTED`, advances
  failure/backoff, copies any checkpointed episode count into joined items,
  terminalizes subscription/items, aggregates runs, and bumps revisions.
  Missing/stale epochs are no-ops.
- Unsubscribe calls `refresh.skip_subscription_epoch_in_txn` before deleting
  the locked subscription: every nonterminal item for that `subscription_id`
  becomes `Skipped` and its run is recomputed. It does not revoke live-sync
  jobs. A pending job exits before feed I/O; an in-flight worker fails its exact
  epoch/attempt fence. A stale fence is a successful job no-op, not a retryable
  failure. Existing backfill revocation is unchanged.

## Data Model

One irreversible migration:

### `podcast_subscriptions`

- add `sync_generation BIGINT NOT NULL DEFAULT 0`;
- add `next_sync_at TIMESTAMPTZ NOT NULL`;
- add `consecutive_sync_failures INTEGER NOT NULL DEFAULT 0`;
- add nullable protocol fields `sync_job_id UUID` and
  `sync_job_attempt_no INTEGER` without a queue FK;
- add nullable generation-checkpoint fields:
  `sync_checkpoint_status`, `sync_checkpoint_cutoff_at`,
  `sync_checkpoint_new_episode_count`, and `sync_checkpoint_completed_at`;
- rename `last_synced_at` to `last_checked_at`;
- index `(next_sync_at, id)`;
- hard-convert `sync_status` to
  `Pending | Running | Complete | SourceLimited | Failed` and change its default
  to `Pending`;
- remove dead `Partial` handling and the status `CHECK`.

Migration order is normative:

1. rename `last_synced_at`;
2. add new columns nullable;
3. convert terminal lowercase values directly and map never-written legacy
   `partial` to `SourceLimited`;
4. backfill `sync_generation = 0`,
   `consecutive_sync_failures = 0`, and `next_sync_at` as
   `COALESCE(last_checked_at + interval '23 hours', now())`; deterministic
   jitter starts after the next completion, and recent subscriptions are not
   deliberately herded due at cutover;
5. assert the deployment preflight left no `pending`/`running` row;
6. set required columns `NOT NULL` and add the due-query index.

Keep existing attempt/start/completion/error and auto-queue fields. Terminal
transitions clear only the exact job and generation-checkpoint fields; the
cumulative `sync_attempts` counter remains.

### `podcast_refresh_runs`

| Column | Contract |
| --- | --- |
| `id` | UUID PK |
| `user_id` | UUID FK, non-null |
| `idempotency_key` | text; required for manual runs, null for scheduled runs |
| `request_hash` | SHA-256 of canonical method/path/body; null for scheduled runs |
| `scope` | JSONB closed union below |
| `status` | `Running | Complete | Partial | Failed` |
| counters | requested, finished, succeeded, source-limited, failed, skipped, new episodes; non-null integers |
| timestamps | started, completed nullable, created, updated |

Unique partial index: `(user_id, idempotency_key)` where the key is non-null.
Add `(completed_at, id)` for the bounded terminal-retention query.
An exact key replay loads and returns the current run; the same key with a
different hash returns `409 E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`. This is a
30-day replay window, matching run retention.

Stored scope is exactly one of:

```text
{ kind: "Due" }
{ kind: "Podcast", podcast_id: UUID }
{ kind: "Podcasts" }
{ kind: "Library", library_id: UUID }
```

This is the typed persistence spec. The API adapter alone converts its
camelCase input aliases. `Due` already identifies scheduled provenance; the
other branches are manual. Do not add a redundant trigger/source column.

### `podcast_refresh_run_items`

| Column | Contract |
| --- | --- |
| `id` | UUID PK |
| `run_id` | UUID FK, non-null |
| `podcast_id` | UUID FK, non-null |
| `subscription_id` | epoch UUID, non-null, deliberately no FK |
| `sync_generation` | BIGINT, non-null |
| `status` | `Pending | Running | Complete | SourceLimited | Failed | Skipped` |
| `new_episode_count` | non-null integer |
| failure | nullable stable error code and bounded diagnostic message |
| timestamps | started, completed, created, updated |

Unique `(run_id, subscription_id)`. Do not foreign-key the protocol epoch to the
ephemeral subscription row and do not cascade-delete run history.

Aggregation is this ordered, total application function:

1. any `Pending | Running` item -> `Running`;
2. zero requested items -> `Complete`;
3. zero `Failed` and zero `Skipped` -> `Complete`; `SourceLimited` is a healthy
   success whose count remains available for copy;
4. at least one effective success (`Complete | SourceLimited`) plus any
   `Failed | Skipped` -> `Partial`;
5. any `Failed`, with no effective success -> `Failed`;
6. all `Skipped` -> `Complete`, announced as `Nothing to refresh`.

Delete `podcast_subscription_poll_runs`,
`podcast_subscription_poll_run_failures`, their models, constraints, and all
old telemetry code. Do not translate historical poll rows.

Terminal refresh runs and their items have 30-day retention. A daily
`podcast_refresh_run_prune_job` (`periodic_interval_seconds = 86_400`) deletes
at most 1,000 eligible item sets and then their parent runs explicitly; no
cascade and no generic retention framework. Manual idempotency keys become
reusable only after their run is pruned.

## API Contract

### Create or join a refresh

```http
POST /podcasts/refresh-runs
Idempotency-Key: <required, 1..120>
```

```text
{ kind: "Podcast", podcastId: UUID }
| { kind: "Podcasts" }
| { kind: "Library", libraryId: UUID }
```

```text
202 {
  data: {
    refreshRunHandle: PodcastRefreshRunHandle,
    status: "Running" | "Complete" | "Partial" | "Failed",
    requestedCount: integer
  }
}
```

- The service resolves the entire scope from server-owned DB facts; rendered
  rows never define command scope.
- `Podcast` requires an active viewer subscription or returns masked 404.
- `Podcasts` means every active viewer subscription.
- `Library` means active parent Podcasts in that exact readable named Library.
  The virtual All Library maps to `Podcasts`.
- Empty scope creates an immediately `Complete` run.
- Canonical idempotency bytes bind method, path, and complete scope. Exact
  replay returns the current same run; key reuse with another scope is the
  standard 409 mismatch. Reuse `podcast_control_request_bytes`; do not add a
  second JSON canonicalizer.
- The 202 response occurs only after run, items, generation transitions, and
  jobs commit.
- A terminal 202 response is authoritative; the client skips SSE and
  revalidates immediately.

Delete `POST /podcasts/subscriptions/{podcast_id}/sync` and
`PodcastSubscriptionSyncRefreshOut`. Add no alias route.

### Observe completion

```http
GET /podcasts/refresh-runs/{refreshRunHandle}
```

returns the canonical snapshot below. It exists for initial reads and one-shot
observer-loss reconciliation; clients must not poll it.

```http
GET /stream/podcast-refresh-runs/{refreshRunHandle}/events
Authorization: Bearer <stream token>
Accept: text/event-stream
```

Snapshot payload:

```text
{
  refreshRunHandle,
  status: "Running" | "Complete" | "Partial" | "Failed",
  requestedCount,
  finishedCount,
  succeededCount,
  sourceLimitedCount,
  failedCount,
  skippedCount,
  newEpisodeCount,
  startedAt,
  completedAt: Presence<IsoInstant>
}
```

Use a sealed, non-authorizing outward handle. Parse it, then assert ownership
before `LISTEN` and again on every snapshot read in a fresh DB session.

Add one `AFTER INSERT OR UPDATE` trigger on `podcast_refresh_runs`:
`pg_notify('podcast_refresh_events', NEW.id::text)`. The route uses
`open_sse_listener` and `tail_snapshot_stream`; the initial listener tick closes
the commit-before-listen race. Emit changed `state` snapshots and one terminal
`done` snapshot. The web uses `sseClientDirect`, aborts observation on
route/source replacement or unmount, and never polls. Aborting observation does
not cancel durable backend work.

`sseClientDirect` may exhaust reconnects, invoke an error, or complete without a
terminal event. Its wrapper must settle exactly once:

1. if the caller signal is aborted, terminate as `AbortError` with no
   revalidation or announcement;
2. otherwise perform one canonical GET;
3. if terminal, return that exact result;
4. if still `Running` or the GET fails, return the presentation-only
   `ObservationLost` outcome and revalidate the pane owner once.

Observer loss is not `Partial`, not a run failure, and not permission to call
`router.refresh` or hard reload. `python/nexus/stream_paths.py` already covers
the `/stream/` prefix and remains unchanged.

## Pane Refresh Capability

Extend the canonical `PanePrimaryChromePublication`:

```text
PaneRefreshPublication {
  sourceKey: string
  execute(input: {
    signal: AbortSignal
    reportProgress(progress: PaneRefreshProgress): void
  }): Promise<PaneRefreshResult>
}

PaneRefreshProgress =
  | { kind: "Indeterminate" }
  | { kind: "Determinate", finishedCount: integer, requestedCount: integer }

PaneRefreshResult =
  | { kind: "Complete", announcement: string }
  | { kind: "Partial", announcement: string }
  | { kind: "Failed", announcement: string }
  | { kind: "ObservationLost", announcement: string }
```

`panePublications.ts` owns the type and equality
(`sourceKey` plus `execute` identity). No route body implements gesture state.
`sourceKey` is the stable canonical identity of the exact refresh target and
changes whenever that target changes.

`PaneShell`:

- prepends **Refresh** to the existing pane menu when the publication exists;
- enables pull only when the pane is active, `isMobile`, `bodyMode ===
  "standard"`, a refresh publication exists, its exact `bodyRef` is at
  `scrollTop === 0`, and one touch moves downward with vertical intent;
- owns exhaustive `Idle | Pulling | Armed | Refreshing | Settled` state;
- owns the execution `AbortController` and aborts it on route/source change or
  unmount;
- uses `PANE_REFRESH_ARM_DISTANCE_PX = 72`,
  `PANE_REFRESH_MAX_OFFSET_PX = 96`,
  `PANE_REFRESH_DRAG_RESISTANCE = 0.45`, and
  `PANE_REFRESH_SETTLED_MS = 900`; cancels horizontal intent, multitouch, touch
  cancel, route/source change, and unmount;
- scopes `touch-action: pan-x pan-up` and `overscroll-behavior-y: contain` to
  an eligible published scrollport. Its non-passive `touchmove` listener calls
  `preventDefault()` only after top-edge downward intent locks, suppressing iOS
  rubber-band without blocking ordinary upward scroll;
- coexists with `usePaneReturnScrollport`: its existing capture-phase passive
  `touchstart` first cancels pending restoration; the refresh listener then
  records the gesture. Do not replace or duplicate that listener;
- coalesces concurrent menu/pull requests into one execution;
- keeps content, focus, and scroll stable;
- renders restrained `Pull to refresh`, `Release to refresh`, and `Refreshing`
  feedback plus `Refreshing X of Y` when determinate progress arrives and a
  polite live-region terminal announcement;
- respects reduced motion and preserves existing overscroll containment;
- returns quietly to `Idle` on `AbortError`;
- ignores stale completions after `routeKey` or `sourceKey` changes.

There is no desktop drag gesture, native page reload, `router.refresh`, hidden
auto-refresh-on-open, or keyboard shortcut in this cut.

### Pane composition

| Pane | `execute()` |
| --- | --- |
| Libraries | await existing exhaustive Libraries owner refresh |
| Library | await exact `Library` podcast run, then refresh that Library collection |
| Author | await existing exhaustive Author works owner refresh |
| Conversations | await existing exhaustive conversation owner refresh |
| Podcasts | await `Podcasts` run terminal, then refresh the exhaustive owner |
| Podcast Detail | when actively subscribed, await `Podcast` run terminal, then refresh detail/episodes owner; otherwise publish no refresh |

`useExhaustivePagination` remains unchanged: its `refresh: () => void` input is
only continuation-recovery policy and is not a revalidation owner.

Each of the six pane bodies instead exposes one awaitable owner-level
`revalidate(signal)` around its existing nonce/version bump. A
generation-specific deferred:

- resolves only after that generation's canonical first page is installed;
- rejects with the owned load error on first-page error;
- rejects with `AbortError` on signal, source replacement, or supersession;
- cannot be resolved by a stale prior effect.

Keep page decoding, snapshot installation, collection revisions, dedupe, and
continuation draining in the pane owner. Extract a shared deferred helper only
if implementation proves the six lifecycles identical; do not make the
pagination hook own them. When a pane refreshes multiple visible first-page
resources, resolve only after every refresh-owned constituent for that
generation is installed.

For podcast runs, revalidate after every terminal result, including `Partial`
and `Failed`, because successful siblings may have changed. On
`ObservationLost`, revalidate once and say
`Refresh is still running; showing the latest available data`. If that
revalidation fails, return `Failed` with owner-specific copy instead of
claiming the data is latest.

Terminal copy:

- podcast: `3 new episodes`, `Up to date`,
  `10 checked; 2 feeds source-limited`, `10 checked; 2 feeds failed`, or
  `Nothing to refresh`;
- ordinary pane: `Libraries refreshed`, `Library refreshed`,
  `Author refreshed`, or `Conversations refreshed`;
- owner failure: retain old content and announce that exact pane failed to
  refresh.

Keep per-row `ResourceOperation.Podcast.Refresh`, relabel it
**Check for new episodes**, and route it through the same `Podcast` run API.
Remove the duplicate Podcast Detail row/menu action; its pane **Refresh** is the
single detail affordance.

Hard-cut every old caller together:

- delete the old BFF
  `app/api/podcasts/subscriptions/[podcastId]/sync/route.ts`;
- replace `refreshPodcastSubscriptionSync` and its decoder in
  `podcastSubscriptions.ts`;
- update `usePodcastSubscriptionActions.ts`;
- replace `LibraryPaneBody`'s direct call;
- remove old endpoint assertions and fixtures.

## Hard-Cut Cleanup

- Replace `podcast_active_subscription_poll_job` with
  `podcast_refresh_due_job`; move it from maintenance to the background lane.
- Add daily background `podcast_refresh_run_prune_job`.
- Keep `podcast_sync_subscription_job`, but hard-replace its payload/fence.
- Move `run_podcast_subscription_sync_now` and its live-sync helpers from
  deleted `poll.py` into `sync.py`; do not duplicate them.
- Replace:
  - `PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS`
  - `PODCAST_ACTIVE_POLL_LIMIT`
  - `PODCAST_ACTIVE_POLL_RUN_LEASE_SECONDS`
  with:
  - `PODCAST_REFRESH_DUE_SCHEDULE_SECONDS=900`
  - `PODCAST_REFRESH_DUE_LIMIT=100`
- Production requires a positive due schedule. Delete
  `PODCAST_SYNC_RUNNING_LEASE_SECONDS`; the queue definition lease plus
  heartbeat and exact `JobExecutionContext` are the single execution lease.
- Collapse every Python Podcast subscription status literal into
  `services/podcasts/types.py` and every web status tuple/type/decoder into
  `lib/podcasts/types.ts`. Library and Podcast projections import those owners.
  Present `Failed` as exceptional, `Pending | Running` as activity, and
  `Complete | SourceLimited` as healthy; source limitation remains available
  for detail/copy.
- Hard-rename the wire field to `last_checked_at`/`lastCheckedAt`; no response
  alias remains.
- Delete `services/podcasts/poll.py`, the old task, endpoint, DTO, telemetry
  tables/models, `Partial` subscription state, duplicate feed traversal,
  duplicate detail action, obsolete tests/docs/env keys, and dead imports.
- Do not leave queue handlers, env aliases, response adapters, feature flags,
  or backward-compatible exports.

## Files

| Area | Expected owners |
| --- | --- |
| Migration/model | `migrations/alembic/versions/NNNN_*.py`, `python/nexus/db/models.py` |
| Backend contract | `schemas/{podcast,library}.py`, `api/routes/podcasts.py`, `services/podcasts/{types,refresh,sync,subscriptions,subscriptions_query,handles,control_replay,feed,ingest}.py`, `services/library_entries.py` |
| Jobs/config | `tasks/{podcast_refresh_due,podcast_refresh_run_prune,podcast_sync_subscription}.py`, `jobs/{queue,registry}.py`, `config.py` |
| SSE | `api/routes/stream.py`; reuse unchanged `db/listen.py`, `api/routes/_sse.py`, `stream_paths.py` |
| Web capability | `lib/panes/panePublications.ts`, `components/workspace/PaneShell.tsx` and styles |
| Web podcast client | new `lib/podcasts/{types,refresh}.ts`; update `podcastSubscriptions.ts`, `usePodcastSubscriptionActions.ts`, `lib/libraries/entryListItem.ts`, `lib/collections/presenters/podcast.ts` |
| Web proxy | add refresh-run POST/GET routes; delete `app/api/podcasts/subscriptions/[podcastId]/sync/route.ts` |
| Pane producers | the six pane bodies named above |
| Resource action | `lib/actions/resourceActions.ts` |
| Deployment/docs | `deploy/env/env-prod-worker.example`, `deploy/hetzner/{sync-env.sh,docker-compose.yml}`, `apps/worker/README.md`, root `deployment.md`, `docs/architecture.md`, `docs/modules/{podcast,jobs,workspace}.md` |
| Backend tests | replace `test_podcast_polling_orchestration.py`; update podcast/SSE/config/migration/factory contracts, `test_ingest_remediation_contracts.py`, `test_hetzner_env_sync_validation.py` |
| Web tests | podcast client/actions, Library decoder, resource action, pane publications, PaneShell, all six pane suites, `e2e/tests/app-navigation.spec.ts`, new real-stack podcast refresh flow |

Do not mechanically touch unrelated panes, DTOs, feeds, or worker jobs.

## Acceptance Criteria

### Backend

- Manual, scheduled, Subscribe, and OPML use one generation-admission primitive
  and one child job; only manual/scheduled paths create runs.
- Scope is exact and server-resolved. Concurrent commands linearize, overlap
  joins one generation, and resubscription creates a new epoch/dedupe key.
- An old-epoch or reclaimed-attempt worker cannot claim, ingest, checkpoint, or
  finalize a replacement subscription.
- Run/items, subscription fence, and jobs are atomically visible after 202.
- Exact idempotency replay returns the same current run; same key/different
  scope returns `409 E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`.
- Manual join promotes only a pending/unclaimed scheduled job; tests prove
  lower-number priority wins.
- Due selection is bounded, oldest-first, restart-safe, and does not claim a
  non-due or active generation.
- One RSS request/parse serves an uncheckpointed attempt. Checkpoint retry skips
  the fetch, preserves `newEpisodeCount`, and resumes the separate auto-queue
  final transaction.
- Exact queue attempt fencing rejects a zombie after lease transfer; no second
  subscription-running lease exists.
- A manual item joined after worker claim is found by finalization.
- Unsubscribe promptly produces terminal all-`Skipped`/mixed runs without
  deleting the live-sync queue row; the stale job exits without feed I/O/write.
- Modeled failure and dead-letter both terminalize subscription/items/runs,
  advance the same bounded backoff, and produce SSE completion.
- Every item/run reaches the specified terminal aggregate under success,
  source limitation, modeled failure, unsubscribe, and dead-letter paths.
- Aggregation table-tests every combination class; all-`SourceLimited` is
  `Complete`, any nonterminal is `Running`, and all-`Skipped` is `Complete`.
- SSE proves initial snapshot, commit notification, reconnect, ownership
  recheck, changed-state suppression, terminal `done`, listener cleanup, and
  one-shot GET reconciliation after observer loss.
- The daily prune deletes only terminal runs older than 30 days, items before
  parents, in bounded batches.
- Collection revisions advance only with committed domain changes.

### UX

- All six panes expose menu Refresh; only their active mobile standard
  scrollports with a refresh publication expose pull.
- Pull requires top-edge downward intent, fires once, cancels horizontal and
  multitouch gestures, suppresses eligible rubber-band only, coexists with
  return restoration, and is accessible with reduced motion.
- Old content, focus, and scroll survive refresh and failure.
- Every owner promise remains pending until its exact first-page canonical
  install; stale, errored, aborted, and superseded generations settle honestly.
- Podcast panes wait for terminal state before revalidation and announce
  accurate aggregates plus `finished/requested` progress.
- Terminal POST skips SSE. Exhausted/nonterminal observation performs one GET,
  one owner revalidation, and resolves `ObservationLost`; it never hangs or
  fabricates a durable result.
- Route/source replacement fences stale work.
- Named Library, All/Podcasts, detail, and row actions send the exact scope.
- All old endpoint callers/proxy/decoders are absent.
- No unsupported pane reloads, polling, custom `EventSource`, `router.refresh`,
  or hard reload.

### Proof and deployment

- Unit/integration tests use real Postgres for transaction, locking, trigger,
  listener, aggregation, idempotency, and revision behavior; mock only remote
  feeds.
- One real-stack browser fixture changes feed v1 to v2 and proves:
  request -> job -> `NOTIFY` -> SSE `done` -> new episode visible.
- Extend the Playwright precedent in `e2e/tests/app-navigation.spec.ts` with
  mobile viewport plus `hasTouch: true` to prove gesture state, cancellation,
  progress, menu alternative, and accessibility. A manual real iOS Safari gate
  proves elastic/rubber-band coexistence; Android instrumentation is not
  required.
- A coordinated maintenance-window deploy disables old admission, drains every
  old poll and old-payload sync job, then quiesces workers and proves no active
  sync row remains. It applies the irreversible migration, deploys
  API/worker/web together, then enables the due schedule.
- Post-deploy proof records one scheduled run, one manual run, terminal SSE,
  updated `last_checked_at`/`next_sync_at`, queue health, and no legacy-kind or
  legacy-env references.

## Ship Gate

Scope removal searches to runtime and active deployment/docs owners:
`python/nexus`, `apps/web/src`, `deploy`, `apps/worker/README.md`, root
`deployment.md`, `docs/architecture.md`, and `docs/modules/*`. Historical
migrations, cutover documents, and unrelated queue/pagination status strings
are excluded. The explicitly labeled revision-0203 preflight/postflight
commands in `deployment.md` may name legacy jobs and environment keys solely
to prove their absence; current-state guidance may not. Test fixtures that
assert strict rejection of a legacy wire field are likewise excluded.

Within that scope there is no:

- old sync endpoint/BFF/caller/DTO;
- poll service/table/model/job/config or
  `PODCAST_SYNC_RUNNING_LEASE_SECONDS`;
- runtime `last_synced_at`/`lastSyncedAt`;
- lowercase or `partial` value in the centralized Podcast sync-status owners;
- duplicate Podcast Detail refresh action;
- polling or custom EventSource in the new refresh client;
- `router.refresh`/window reload in `PaneShell` or the six refresh owners.

The cutover is complete only when focused local proof, real-stack proof, and
post-deploy proof are reported separately. A green local suite is not
production evidence.
