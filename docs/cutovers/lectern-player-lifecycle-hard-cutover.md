# Lectern + Global Player Lifecycle — Hard Cutover

**Status:** Approved specification, revision 2 · 2026-07-16
**Posture:** one final contract; no aliases, fallbacks, dual reads/writes, or backward compatibility.

No blocking question remains.

This is the sole runtime contract. `lectern-hard-cutover.md` §§2–4 and 6–16
are superseded; its §5 is historical DDL provenance only.
`attention-ledger-hard-cutover.md`'s One-line owner claim, §2 explicit-finished
actions, §3 G-3/G-5, §§4.1/4.4 consumption ownership/projection, §6 override
route (not the listening heartbeat), §7 consumption actions, §8 D-4, §9
listening owner claim, §11 affected owner/HTTP slices, §12 AC-9, §13
consumption-owner gates G-5/G-8, and §15 corresponding files are superseded.
Its `reading_sessions`, 30-minute session continuity, attention aggregation,
and audio-while-playing dwell rule remain canonical. This document replaces the
listening heartbeat's request encoding, write owner, fencing, and failure
disposition while retaining that dwell behavior.

**Superseded by default-library-virtualization-and-transient-state-pruning-hard-cutover.md
(2026-07-17):** that later cutover supersedes only this document's
`reading_sessions`/dwell ownership, the listening heartbeat's dwell-write
composition (§5.4's `dwellMsDelta`/`deviceId` request fields and the
piggybacked dwell write), the four-store media-teardown fold (§7 and every
`attention.delete_media_state`/`attention.py` reference in this file), and
the matching file/gate clauses. It remains normative for everything else here
— Lectern ordering, the two command ports, replay, and the dock/footer
contract are unchanged. `services/attention.py` and `reading_sessions` are
deleted outright, not relocated: the listening heartbeat now writes only
position/duration/speed/fencing and carries no elapsed-time delta or
client-supplied device identifier, and media teardown composes one
consumption call, not two. Document engagement recency moves to a fifth
consumption store, `reader_engagement_states`
(`services/consumption/_reader_engagement_store.py`), fed by the reader-state
PUT rather than by any session/dwell derivation (see
`docs/modules/{player,reader-implementation}.md`).

## 1. Target behavior

- **Lectern** is the one ordered, mixed-media list of outstanding intentions.
  Podcast, video, reader, agent, and Launcher actions all address it.
- **Now Playing** is one device-local audio session, not a second durable list.
- The authenticated shell owns one activity-conditional bottom dock. It remains
  across pane navigation, occupies layout space, and never overlays content.
- The Lectern pane is the sole full-list editor. The dock has transport plus one
  read-only “Next on the Lectern” preview; it is not an editor.
- Only explicit terminal commands may remove for completion. Progress/dwell
  derivation never prunes Lectern.

| Event | Consumption | Lectern | Player/navigation |
|---|---|---|---|
| Lectern-origin audio ends | `Finished` | remove exact origin | play selected next `FooterAudio` |
| Direct audio ends | `Finished` | unchanged | paused at end |
| Single Mark finished / Done | `Finished` | remove exact observed item, if supplied | active origin becomes Direct |
| Done & open next | `Finished` | remove exact item | open returned next `Readable` |
| Batch Mark played | `Finished` | unchanged | unchanged |
| Early Next | unchanged | retain item in place | next audio; no wrap |
| Remove | unchanged | remove only | active origin becomes Direct |
| Mark unread / unplayed | `Unread` | never add | active same-media session seeks to zero; play/pause retained |
| Re-add finished media | preserve consumption state | move existing row or add new row | explicit audio Play starts at zero |
| Activate video | unchanged | retain | open media pane; never bind to `<audio>` |

Previous restarts current audio after three seconds; before three seconds it
uses device-session history. Stop means **paused at end with the session, dock,
history, and Walknotes retained**. Reload intentionally restores no session.

## 2. Scope

### Goals

1. One backend consumption owner and one browser Lectern owner.
2. Atomic, semantic-idempotent terminal state plus exact-item disposition.
3. Capability-derived activation; no video-as-audio path.
4. One editor, explicit Play, and a shell-resident player session.
5. Remove more code and mutation paths than this cutover adds.

### In scope

- Lectern commands/order/DTO, explicit state, exact completion, next selection,
  replay, optimistic UI, and concurrency.
- The retained listening heartbeat and its position/resume authority.
- Auto-subscription eligibility watermarking and naturally idempotent insertion.
- Media teardown intent, reference exclusion, durable storage cleanup, and
  viewer-hide state preservation.
- Reader, podcast, media, library, Launcher, agent, footer, shortcuts, Media
  Session, and one real-stack mixed-media E2E path.
- Canonical owned-absence encoding for new or modified same-system contracts.

### Non-goals

- Embedded-video transport, YouTube IFrame control, PiP, or background video.
- Reload/cross-device restoration of the player session or device history.
- Durable playback-session history, queue cursor, completion receipts,
  tombstones, or state columns on Lectern rows.
- Automatic readable-media advance or heuristic completion pruning.
- Generic event/query/command frameworks, media-ID migration, player visual
  redesign, attention-heuristic redesign, or migration of unrelated nullable DTOs.
- User-account teardown; in-scope user FKs become non-cascading and restrict the
  nonexistent delete operation until a complete account-lifecycle cutover.
- Clear-all. Its only current caller is deleted with the footer list panel.

## 3. Ownership and architecture

```text
HTTP/BFF -> services/consumption/service.py
              -> _state_store      explicit state + podcast terminal state
              -> _lectern_store    membership/order + canonical snapshot
              -> _listening_store  position/duration/speed heartbeat
              -> _projection       explicit + attention-derived read model

attention.py -> reading_sessions writes, dwell aggregate, attention_on_day

AuthenticatedShell
  -> LecternProvider (one AsyncResource + one mutation lane)
       -> Launcher/workspace leaves
       -> GlobalPlayerProvider (one PlayerSession)
            -> WorkspaceHost + GlobalPlayerFooter
```

`services/consumption/` is the sole ordinary writer of
`consumption_queue_items`, `consumption_overrides`, and
`podcast_listening_states`. `attention.py` remains the sole writer of
`reading_sessions`, including audio dwell, and exposes only derived attention
inputs to the consumption projection. The listening-state route survives; its
facade composes the consumption position write and attention dwell write in one
fresh unreplayable `retry_serializable` transaction.

Narrow consumption transaction-body operations exist only for media lifecycle
cleanup and the auto-subscription step that must share its watermark commit.
`media_deletion.py` and podcast sync compose those owner methods and never write
consumption tables directly. Media teardown also composes
`attention.delete_media_state`. These are the complete exceptions to ordinary
command ownership.

Viewer-only removal/hide now preserves consumption and latent Lectern rows; the
visibility projection hides them. Explicit re-add clears that viewer's hide
marker after the teardown check. This is a behavior change, not a claim that
current restore behavior was intentional. Last-reference physical deletion
removes all child state.

### 3.1 Media teardown

The existing `DELETE /media/{mediaId}` remains document-only (`WebArticle`,
`Epub`, `Pdf`) and returns exactly one `MediaDeleteResult` variant:

```text
{ kind: "Removed", removedFromLibraryIds, remainingReferenceCount }
| { kind: "Hidden", removedFromLibraryIds, remainingReferenceCount }
| { kind: "Deleting" }
```

Removing a scoped library reference returns `Removed` only when at least one
lifetime reference remains. Whole-workspace removal records the viewer hide
marker and returns `Hidden` while references remain. Removing the last reference
atomically installs the intent + job and returns `Deleting` only after commit. A
later void preserves the initiating viewer's hide; explicit re-add can restore
it. Episode/video physical deletion is not added here.

One migration adds:

```text
media_teardown_intents {
  id: application-generated UUIDv7 primary key
  media_id: UUID unique FK -> media.id
  created_at: timestamptz = database now()
}
```

Python 3.12 has no standard UUIDv7 generator. Pin `uuid6`, expose only
`nexus.ids.new_uuid7()`, and test the version/time-order contract; intent creation
uses that owner rather than an unavailable database function.

Intent presence excludes the media from every public visibility query and makes
new references fail with `E_MEDIA_DELETING` (409). Ordinary reads continue to
return non-leaking `E_NOT_FOUND`.

Reference creation and teardown claim use one shared serializable-equivalent
protocol instead of nine fresh-session rewrites:

1. Immediately before a lifetime-reference insert, its owner locks the media row
   with `SELECT ... FOR UPDATE`, checks the intent, then inserts in that transaction.
2. Claim locks only that media row, checks zero committed references, inserts the
   intent, and enqueues one addressable `media_teardown` job in that transaction.

Thus creator-first makes claim observe a reference; claim-first makes creator
return `E_MEDIA_DELETING`. The two actual reference owners
(`library_entries`, `default_library_closure`) enforce the barrier. Audit their
nine callers: `library_entries.py`, `default_library_closure.py`,
`media_source_ingest.py`, `x_ingest.py`, `podcasts/ingest.py`,
`email_ingest_service.py`, `agent_tools/writes.py`, `oracle_corpus.py`, and
`web_article_ingest.py`. No caller may insert around the owners. The claim does
not lock library rows, so this protocol does not invent a global cross-owner lock
order for callers that already hold library state.

The job payload is exact and tagged:

```text
MediaTeardownJob {
  mediaId, intentId,
  checkpoint:
    Unprepared
    | PathsPrepared(storagePaths, cleanupNotBefore)
    | DeletionCommitted(storagePaths, cleanupNotBefore)
    | Voided | NoOp | Stale
}
```

Every intent lookup/delete matches both `intentId` and `mediaId`; an old job
never acts on a later intent. The worker supplies
`JobExecutionContext(jobId, workerId, attemptNo)`. Queue-owned checkpoint writes
from a worker require that exact running attempt, claimant, and unexpired lease.
For a future-dated, unclaimed `Armed` cleanup job only, the queue owner exposes
exact pre-claim CAS methods to renew its deadline or mark it `Retained`; they
match job/media/path and fail once claimed. Domain code never writes
`background_jobs` raw.

Job execution is:

1. Reload the current job row. From `Unprepared`, exact intent + media reuses the
   existing path enumerator and lease-fences a sorted/deduplicated
   `PathsPrepared` checkpoint in one short transaction. Intent absent + media
   present records `NoOp`; a different intent records `Stale`; media absent
   defects. Terminal checkpoints skip this preparation.
2. From `PathsPrepared`, run one fresh `retry_serializable` transaction. With the exact intent:
   references present deletes only that intent and atomically records `Voided`;
   zero references deletes child state through owners, then intent/media, and
   atomically records `DeletionCommitted`. Absent intent + present media records
   `NoOp`; a different intent records `Stale`. Media absent before the atomic
   deletion checkpoint and all other impossible combinations defect. No public
   consumption-cleanup phase exists.
3. `DeletionCommitted` reschedules itself until `cleanupNotBefore`, then deletes
   its persisted paths. Failure fails and retries the job; retry reloads the
   checkpoint and deletion is idempotent. No other disposition performs storage
   cleanup.

Every in-process object write in `media_source_ingest.py`,
`email_ingest_service.py`, `epub_ingest.py`, and upload confirmation's
staging-to-final copy in `upload.py` first locks media, rejects an intent, and
enqueues this durable final-sweep record before the bounded external call:

```text
StorageObjectCleanupJob {
  mediaId, storagePath, writeMayLandUntil,
  checkpoint: Armed | Retained | DeleteRequired | Deleted
}
```

Reservation permits at most one nonterminal cleanup job per
`(mediaId, storagePath)`; a competing writer reschedules until that job is
terminal. The storage-client timeout is shorter than `writeMayLandUntil`; a delayed writer
renews under the media lock or aborts before calling storage. Teardown preparation
includes every Armed path and `writeMayLandUntil` in its storage paths and
`cleanupNotBefore`. After writing,
one short transaction rechecks media + no-intent + committed path ownership and
records `Retained`; rejection leaves `Armed` and best-effort deletes the object.
At its deadline, an Armed handler locks media: committed live ownership records
`Retained`; a live intent reschedules until deletion or void; absent media or an
unowned path records `DeleteRequired`. That checkpoint is an exclusive
queue-owned hold on `(mediaId, storagePath)`: it is installed only when no other
nonterminal writer targets the path, and pre-write reservation rejects the path until
the holder deletes outside the transaction and records `Deleted`. This closes
the delete/new-write gap without an external call inside a transaction. Deletion
is idempotent and failure retries. Only
`Retained|Deleted` success is prunable. Thus a crash after a late PUT still has
a durable final sweep.

Browser direct upload is the exception because the server cannot perform its
post-write check. Signing locks the media row, rejects an intent, and persists
the staging path plus `media_source_attempts.signed_upload_expires_at` before
returning the URL; replayed init may extend that timestamp, but cannot sign after
claim. Signed upload TTL is capped at 300 seconds; migration conservatively
backfills every pending upload attempt to DB `now() + 300 seconds`. Preparation
sets `cleanupNotBefore` to the latest signed expiry plus the
named 60-second object-store clock-skew grace, or any later Armed writer drain.
Confirmation also rejects intent/missing media.

URL expiry does not terminate a PUT that already began, and a timed-out SDK call
has an unknown provider outcome. Therefore two durable backstops are load-bearing:
the existing one-day R2 lifecycle on `uploads/`, and a singleton
`storage_orphan_sweep` job for canonical media prefixes. The sweep durably pages
objects, ignores those modified within 24 hours, acquires the same exclusive path
hold, and deletes only paths with no live DB owner or Armed writer. It atomically
schedules its six-hour successor on success; dead jobs remain unpruned and use
`requeue_dead_job`. A write completing after one pass gets a new modified time
and is caught by a later pass. Deployment verifies the bucket lifecycle, and
storage listing/timeout config is tested. These durable convergers, not URL
expiry or a process-local memo, prevent orphans.

On dead-letter, a live media row causes only the exact matching intent to be
voided. `DeletionCommitted` media jobs and failed path-cleanup jobs are never
pruned; the queue's internal `requeue_dead_job(job_id)` is their repair
transition, and success makes them prunable. Paths therefore remain
operator-discoverable.

### 3.2 Core invariants

1. Lectern row presence means On Lectern; completion is never stored on that row.
2. Remove is not completion; Unread is not requeue; Next is not completion.
3. Moving preserves `itemId`; removal followed by re-add creates a new `itemId`.
4. Returned snapshots are canonical and replaced wholesale; leaves never merge caches.
5. `FooterAudio` is the only footer-playable activation.
6. Only Play/history/advance replaces a player session; pane mount never does.
7. Every Lectern mutation locks the viewer row before membership/order reads and
   writes. This linearizes auto-sync with manual commands.
8. Every listening/explicit-state mutation also locks the viewer row; media
   teardown deletes consumption/attention children only through their owners.

## 4. Capability and wire contracts

Owned absence has one repository-wide forward encoding:

```text
Presence<T> = { kind: "Absent" } | { kind: "Present", value: T }
```

The field is always present. `null`, omission, and alternate casing are rejected.
Shared Python/TypeScript definitions are used by every owned field introduced or
modified here. Existing unrelated nullable APIs migrate only in their owner
cutovers; no decoder accepts both forms. `docs/rules` records this ratchet.
All new HTTP JSON uses the camelCase keys and PascalCase discriminator values
shown below, forbids unknown keys, and requires each command's `kind`. Python
snake_case exists only behind schema aliases.
Bounded identity exception: this cutover preserves the existing raw media/item
UUID wire families only, decodes each into a distinct branded
type, and introduces no additional untyped ID exposure. Replacing those wire
IDs with sealed handles is named follow-up debt and is not mixed into this
cutover.

```text
ChapterOut { title: string[1..300], startMs: int, endMs: Presence<int> }

LecternItemOut {
  itemId: LecternItemId
  mediaId: MediaId
  kind: web_article | epub | pdf | video | podcast_episode
  title: string
  subtitle: Presence<string>
  href: AppHref
  consumption: {
    state: Unread | InProgress | Finished
    progress: Presence<Fraction>       # finite, 0..1
  }
  activation:
    { kind: "FooterAudio",
      streamUrl: string, sourceUrl: string,
      positionMs: int, writeRevision: int, resetEpoch: int, playbackSpeed: number,
      durationMs: Presence<int>, artworkUrl: Presence<string>,
      chapters: ChapterOut[0..100] }
    | { kind: "Readable" }
    | { kind: "OpenPane" }
}

LecternSnapshot { items: LecternItemOut[0..2000] }
PlayerDescriptor { mediaId, title, subtitle, activation: FooterAudio }
```

Derivation is exhaustive: playable podcast/audio -> `FooterAudio`; web article,
EPUB, PDF -> `Readable`; video or podcast without audio -> `OpenPane`; unsupported
kind -> `E_INVALID_KIND` on add. Reuse `derive_playback_source`; delete kind lists,
URL guessing, empty-URL fallbacks, and client playback-source reconstruction.
The projection validates order/ranges, selects the first 100 by canonical
ordinal, and clamps presentation titles to 300 characters; stored chapter data
is not rewritten.

New domain/wire enums use PascalCase. Persistence adapters alone map
`Manual|Assistant|AutoSubscription` and `Unread|Finished` to their lowercase
stored values and defect on unknown values. Migration preflight asserts zero
`auto_playlist` rows and aborts if provenance needs an explicit disposition;
then remove that dead constant. Drop (do not replace)
`ck_consumption_queue_items_source` and `ck_consumption_overrides_status`.
Lectern `source` remains internal provenance for agent undo/trust and
auto-subscription diagnostics; it is intentionally absent from the snapshot.
Moving an existing row does not rewrite that creation provenance.
Do not introduce a nominal `Text` brand.

## 5. Command and heartbeat contracts

```http
GET  /lectern
POST /lectern/commands
POST /consumption/commands
GET  /media/{id}/listening-state
PUT  /media/{id}/listening-state
```

The two POST routes are bounded aggregate command ports, not a generic command
bus: each tagged family shares one transaction/replay scope and one canonical
response. POST is semantic-idempotent through `clientMutationId`. Scopes are
exactly `Lectern.Commands` and `Consumption.Commands`.

Each of the two POST command facades creates a fresh session and owns one
`retry_serializable` transaction containing replay claim, validation, domain
writes, semantic memo, and snapshot read. Callers cannot pass sessions or invoke
transaction bodies. GET uses the standard read-only operation boundary;
heartbeat PUT is the separately specified unreplayable CAS mutation, and media
DELETE retains its lifecycle contract.

Every UI command carries one bounded `clientMutationId`, reused for every retry
of that logical action: a client-generated UUIDv4, keyed by
`(viewerId, mutationScope, clientMutationId)`. Same key/different validated wire JSON returns
`E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`. Extract the duplicated ledger mechanics to
`services/resource_mutation_replay.py`; the helper accepts already-serialized
canonical JSON bytes. Existing adapters preserve their exact old bytes
(contributor remains alias-free) and existing scopes retain their response
memos. New adapters supply sorted, compact, wire-alias JSON.

Only the two new scopes memo semantic outcomes, never snapshots. A replay hit
performs no writes, rebuilds the current `LecternSnapshot`, and resolves a stored
next ID only if it is still present and still matches the requested capability;
it also reads current listening states for memoized reset-media IDs. Background additions
therefore cannot disappear after a lost response.

### 5.1 Lectern commands

```text
PlaceItems { kind: "PlaceItems", clientMutationId,
             mediaIds: MediaId[1..200],
             placement: { kind: "First" } | { kind: "After", itemId } | { kind: "Last" } }
RemoveItem { kind: "RemoveItem", clientMutationId, itemId }
SetOrder   { kind: "SetOrder", clientMutationId, itemIds: LecternItemId[0..2000] }

LecternResult {
  outcome:
    { kind: "Placed", itemIds: LecternItemId[] }
    | { kind: "Removed", itemId: LecternItemId }
    | { kind: "Ordered" }
  lectern: LecternSnapshot
}
```

- `PlaceItems` is manual. It input-deduplicates, moves existing rows without
  changing `itemId`, and places the ordered block. `After` requires a visible
  anchor outside that block; no head fallback. A targeted teardown intent is
  `E_MEDIA_DELETING`, not a masked add failure.
- `SetOrder` requires the exact visible permutation and changes only visible
  slots; hidden rows keep latent slots and relative order.
- Placement uses visible boundaries without exposing hidden IDs. Hidden rows
  retain relative order; with no visible row, First prepends, Last appends, and
  After is invalid.
- The 2,000-row aggregate limit is enforced on every add/ensure. Success returns
  `LecternResult`; new-key absent/cross-user item is `E_NOT_FOUND`; same-key replay
  returns the memoized outcome plus fresh state.
- Add to Lectern maps to `Last`. Play next maps to `After(currentOrigin.itemId)`
  for an exact Lectern origin, otherwise `First`; targeting the current origin
  is disabled/no-op.

### 5.2 Consumption commands

```text
EnsureMediaFinished { kind: "EnsureMediaFinished", clientMutationId, mediaId }
FinishLecternItem {
  kind: "FinishLecternItem", clientMutationId, mediaId, itemId,
  nextCapability: "Stop" | "FooterAudio" | "Readable"
}
SetUnread { kind: "SetUnread", clientMutationId, mediaId }
SetBatchState { kind: "SetBatchState", clientMutationId,
                mediaIds: MediaId[1..1000], state: "Finished" | "Unread" }

ConsumptionResult {
  outcome:
    { kind: "StateOnly" }
    | { kind: "Removed", itemId, nextItemId: Presence<LecternItemId> }
  lectern: LecternSnapshot
  nextItem: Presence<LecternItemOut>
  listeningStates: { mediaId: MediaId, state: ListeningStateOut }[]
}
```

- `EnsureMediaFinished` is state-only. Direct natural end uses it.
- `FinishLecternItem` requires exact viewer/item/media agreement, writes terminal
  state, removes that item, then selects from its pre-removal suffix. `Stop`
  returns Absent; the other values return the first still-current matching item
  and never wrap. Capability is a selection filter, never a precondition that
  can block the terminal write.
- `SetUnread` is state-only and never adds. For podcast state it resets position
  and advances both `writeRevision` and `resetEpoch` in the same transaction.
  Replay advances neither again; the memo stores affected media IDs and the
  response reads their full current listening state, so an older replay adopts
  later progress instead of pairing a fresh revision with stale zero.
- `SetBatchState` is podcast-episode-only and state-only for both values; any
  other kind is `E_INVALID_KIND`. Only the podcast pane currently needs batch;
  it never removes Lectern rows.
- Podcast `Finished` sets `is_completed=true` without moving position. `Unread`
  clears completion and resets position to zero. `listeningStates` contains the
  current rows reset by that logical Unread command and is otherwise empty.
  Explicit override remains the highest-priority state input.

### 5.3 Trusted ensure and auto-subscription

`EnsureMissingItems(mediaIds, source: Assistant | AutoSubscription)` is an
internal consumption command, not HTTP. It input-deduplicates, appends absent
rows at `Last`, never moves existing rows, and returns ordered inserted
`{mediaId,itemId}` pairs. Any teardown intent rejects the whole batch with
`E_MEDIA_DELETING`; exceeding the aggregate limit is `E_LIMIT`; either writes
nothing. It has no replay memo because the unique
membership plus ensure semantics are naturally idempotent. Add
`uq_consumption_queue_items_user_media` to the generically named retryable unique
constraint allowlist for concurrent first-sight races.

The Assistant entry owns a fresh mutation boundary. AutoSubscription alone uses
the scoped `_lectern_store` transaction body below so insertion and watermark
are one database fact; callers cannot choose the trusted source value.

`podcast_subscriptions.auto_queue_watermark_at` is nullable `timestamptz`.
The existing subscription claim returns its persisted fence
`{subscriptionId, syncAttemptNo, syncStartedAt}`; use `syncStartedAt` as the
database-authored `syncCutoffAt`. It is not a domain idempotency key. Episode
ingest immediately before commit locks the subscription row `FOR UPDATE`, then
validates `status=running`, that exact attempt/start pair, and the derived lease
against database `clock_timestamp()` while retaining the lock through commit; a
stale/reclaimed worker rolls back. If its lease expires after ingest, the next
claim sees those committed rows because no watermark advanced.

Then run one fresh database-only `retry_serializable` step that revalidates the
same fence, locks subscription then viewer, ensures eligible rows, and sets the
watermark to `max(current, syncCutoffAt)` and marks that exact claim complete in
the same commit. An older/equal cutoff skips ensure/advance but completes the
exact claim. Failure/status writes
also match the exact attempt/start pair and never clobber a replacement. Null
watermark selects the configured initial window with
`publishedAt <= syncCutoffAt`; later runs select
`watermark < publishedAt <= syncCutoffAt`; missing `publishedAt` is ineligible.
Disabled auto-queue neither inserts nor advances and preserves the watermark, so
re-enable resumes its interval. Failure advances nothing. This is an intentional
policy change; no batch or stable domain attempt is persisted.

### 5.4 Listening heartbeat

```text
ListeningStateOut {
  positionMs: int[0..2147483647],
  durationMs: Presence<int[0..2147483647]>, playbackSpeed: number[0.25..3],
  writeRevision: int[0..2147483647], resetEpoch: int[0..2147483647]
}
ListeningHeartbeatIn {
  positionMs: int[0..2147483647],
  durationMs: Presence<int[0..2147483647]>, playbackSpeed: number[0.25..3],
  dwellMsDelta: int[0..17000], deviceId: string[1..128],
  expectedWriteRevision: int[0..2147483647],
  expectedResetEpoch: int[0..2147483647],
  heartbeatGeneration: UUID, heartbeatSequence: int[0..2147483647]
}
ListeningHeartbeatResult {
  listeningState: ListeningStateOut,
  heartbeatGeneration: UUID, heartbeatSequence: int[0..2147483647]
}
```

All request fields are required; duration is the strict Presence encoding. GET
returns `ListeningStateOut`; PUT accepts no completion field and returns
`ListeningHeartbeatResult`. Consumption owns position/duration/speed;
attention owns the piggybacked `reading_sessions` dwell write. The 95%-threshold
Finished signal is projection-only and never sets `is_completed` or prunes.

`podcast_listening_states.{write_revision,reset_epoch}` are non-null and start at
zero. PUT locks the viewer row, then loads or creates the listening row. Only an
exact expected revision + reset epoch may atomically write position+dwell and
increment the revision; mismatch returns
`E_STALE_LISTENING_REVISION` (409) and writes nothing. SetUnread holds the same
viewer lock while incrementing both counters and resetting position, so a
pre-reset heartbeat either commits first or is rejected later. This makes an
ambiguous PUT retry incapable of double-counting dwell or overwriting newer
position.

The provider runs one in-flight heartbeat per media, coalesces later samples,
and installs a response only when generation + sequence still match. Heartbeats
bypass the command FIFO but have a named 20-second browser deadline. Timeout or
network failure never blocks playback or mutations: retire that generation,
discard its ambiguous dwell delta, and GET current state. If `resetEpoch` is
unchanged, retain the newest position for a new generation; if it changed,
discard old samples and adopt the canonical reset. Before active-media Unread, the provider
closes and drains the old generation for at most that deadline, then issues the
command. It adopts the returned full state, seeks to its position, replaces the
old overlay, and starts a new generation. A stale-revision response takes the same GET path;
old-revision samples are never resubmitted under the new revision.
Heartbeat dwell is intentionally at-most-once: an unknown-outcome delta may be
lost, but is never replayed or double-counted. Explicit state remains authoritative.

## 6. Frontend and UX

Reuse the house load contract and add explicit mutation/session states:

```ts
type MutationAttempt = LecternCommand | ConsumptionCommand;
type PlaybackPhase = "Playing" | "Paused" | "Buffering";
type PlayAudioInput = PlayerDescriptor;
type PlayerError = { code: string; message: string };

interface LecternCapability {
  resource: AsyncResource<LecternSnapshot>;
  mutation:
    | { kind: "Idle" }
    | { kind: "Pending"; attempt: MutationAttempt; presentedSnapshot: LecternSnapshot }
    | { kind: "RetryableFailure"; attempt: MutationAttempt; error: ApiError; retry: () => void }
    | { kind: "ReconciliationFailed"; attempt: MutationAttempt;
        error: ApiError; retryGet: () => void };
  placeItems(input: { mediaIds: MediaId[]; placement: Placement }): Promise<LecternResult>;
  removeItem(itemId: LecternItemId): Promise<LecternResult>;
  setOrder(itemIds: LecternItemId[]): Promise<LecternResult>;
  ensureMediaFinished(mediaId: MediaId): Promise<ConsumptionResult>;
  finishLecternItem(input: { mediaId: MediaId; itemId: LecternItemId;
                            nextCapability: NextCapability }): Promise<ConsumptionResult>;
  setUnread(mediaId: MediaId): Promise<ConsumptionResult>;
  setBatchState(input: { mediaIds: MediaId[];
                         state: "Finished" | "Unread" }): Promise<ConsumptionResult>;
}

type PlayerSessionState =
  | { kind: "Absent" }
  | { kind: "Active"; session: AudioSession; phase: PlaybackPhase }
  | { kind: "Completing"; session: AudioSession; attempt: CompletionAttempt }
  | { kind: "CompletionFailed"; session: AudioSession; attempt: CompletionAttempt;
      error: ApiError; retry: () => void }
  | { kind: "PlaybackFailed"; session: AudioSession; error: PlayerError;
      retry: () => void }
  | { kind: "PausedAtEnd"; session: AudioSession };

interface GlobalPlayerCapability {
  state: PlayerSessionState;
  persistence:
    | { kind: "Ready" }
    | { kind: "Suspended"; mediaId: MediaId; error: ApiError;
        retryGet: () => void };
  presentation: {
    positionMs: number; durationMs: number; bufferedMs: number;
    volume: number; playbackRate: number; currentChapter: Presence<ChapterOut>;
    audioEffects: AudioEffectsState; audioEffectsAvailable: boolean;
    isSilenceTrimming: boolean; silenceTimeSavedMs: number;
  };
  playAudio(input: PlayAudioInput): void;
  resume(): void;
  pause(): void;
  seekTo(positionMs: number): void;
  skipBy(deltaMs: number): void;
  previous(): void;
  next(): void;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  setAudioEffects(patch: Partial<AudioEffectsState>): void;
  bindAudioElement(node: HTMLAudioElement | null): void;
}
```

- `AsyncResource` supplies initial error + Retry. Play and mutation wait for
  Ready; initial GET therefore cannot overwrite later command installs.
- The provider mints mutation IDs; leaves invoke only the semantic methods above
  and render `presentedSnapshot` while Pending (canonical for non-optimistic
  commands, provider-owned optimistic state for Remove/reorder). Public player
  activation is `playAudio(decoded PlayerDescriptor)`, never `setTrack`
  or raw URLs. Lectern, podcast, and media DTOs reuse the same server-derived
  title/subtitle + `FooterAudio` descriptor, including artwork and chapters.
- A capability promise represents one logical attempt: it remains pending across
  unknown outcome and same-ID Retry, resolves only after canonical state and
  provider effects are installed, and rejects only after definitive
  reconciliation (or provider unmount with an abort error). Callers may inspect
  results but never install them; this makes Undo's two awaited commands exact.
- One provider FIFO owns every Lectern/consumption mutation and reconciliation
  GET. Remove/reorder are optimistic in the provider; leaves have no cache.
  Pending is set synchronously, suppressing double gestures.
- Initial load and revalidation GETs use that same lane. On focus,
  visible-document, or online transitions, revalidate if no successful install
  occurred within `LECTERN_REVALIDATE_MIN_INTERVAL_MS = 60_000`; coalesce
  triggers and never poll. A GET cannot overtake or overwrite a mutation result,
  and no public refresh method exists.
- Each command has a named 35-second browser deadline (beyond the 30-second BFF
  timeout) and unmount abort. Timeout/network failure is unknown outcome and
  stops being in flight, renders provider-owned same-ID Retry, and visibly blocks
  later commands until reconciliation; it never remains silently Pending.
- A definitive typed 4xx runs one serialized reconciliation GET, returns to Idle,
  and surfaces its product message without a meaningless Retry; exact-end
  `E_NOT_FOUND` follows the narrower recovery below. Retryable/unknown failures
  retain the exact attempt.
- If a required reconciliation GET fails, expose GET-only Retry and keep the
  logical command/exact-end promise pending; never rerun its known command.
  Heartbeat GET failure leaves playback usable but sets persistence Suspended and
  sends no further heartbeat until GET-only Retry succeeds. Provider abort is the
  only non-reconciled terminal disposition.
- Every Play—including Previous, forward history, advance, and Media Session—
  resolves origin against the latest canonical snapshot. History stores a
  descriptor, not a trusted origin: replay uses the current snapshot descriptor
  and exact origin when that media is present, otherwise its stored descriptor
  as Direct. Only a canonical server install may downgrade a missing/mismatched
  origin; optimistic presentation never changes origin, so failed Remove rollback
  preserves it. Direct never upgrades until a new Play. Moving the same `itemId`
  preserves an active exact origin.
- Resume authority is: `Finished -> 0`; otherwise the provider-lifetime
  same-media position overlay; otherwise latest snapshot/media DTO position. The overlay is a
  provider-lifetime `Map<mediaId, {positionMs, writeRevision, resetEpoch}>`, updates on
  time/seek/switch/heartbeat. Unread installs the returned full listening state
  (zero on first execution, possibly later progress on replay); Finished records
  a provider-local zero-start override without seeking
  an already-active session. These facts also govern descriptor-only history and
  replace absence rather than clearing to a stale fallback. History replay
  therefore cannot be rewound by a stale snapshot.
- One `CompletionAttempt` mints `exactId` and `fallbackStateOnlyId` once, queues
  ended-session identity, derives and freezes the chosen body at FIFO head, and
  reuses it on Retry.
  Any exact-end `E_NOT_FOUND` terminates that item attempt regardless of reload
  contents, reloads once, downgrades Direct, runs state-only completion with its
  second stable ID, and stops without advance.
- While Completing/CompletionFailed, the dock and Walknotes remain; session-
  replacing transport is disabled and Retry is the failure action. On success,
  install the response snapshot before resolving origin/starting returned audio.
  No eligible automatic successor ends in `PausedAtEnd`.
- Playing from `PausedAtEnd` creates a new session/attempt. Removing or finishing
  an active origin downgrades it to Direct so a later `ended` cannot touch a re-add.
- Any non-history action that replaces a different current session—explicit
  Play, Lectern-selected manual Next, or automatic advance—pushes the outgoing
  descriptor onto back history and clears forward history. Manual Previous after
  three seconds restarts; at or before three seconds it pops back and pushes the
  current descriptor forward. Manual Next pops forward and pushes current back;
  with no forward entry it selects the first `FooterAudio` after an exact origin
  or from the head for Direct, excluding current media, with no wrap. Natural end
  never consumes forward history.
- Explicit exact completion offers a ten-second Undo toast: serialize `SetUnread`,
  then `PlaceItems` after the nearest surviving pre-completion predecessor, else
  `First`. The restored membership gets a new `itemId` and never reattaches the
  active Direct session. If SetUnread commits but PlaceItems fails, retain the
  canonical unread state and show **Marked unread; could not restore to
  Lectern**. Unknown placement outcome retries the same ID; a definitive lost
  anchor offers a new Restore action with freshly resolved placement. No new API.
- Footer primary transport includes Previous/Next and one presentation-only
  preview of the actual manual-Next target: **Forward: _title_** for history or
  **Next on the Lectern: _title_** for Lectern selection. Add scoped
  `Shift+ArrowLeft/Right` shortcuts and announce resulting track changes in the
  existing polite live region.
- All **Open Lectern** navigation affordances use `requestOpenInAppPane`; mutation
  buttons perform their named action. Delete the footer list/dialog. Preserve
  effects, Walknotes, mobile sheet, existing spacing tokens, direct
  `env(safe-area-inset-bottom)`, and shell flex-column layout.
- Copy is **Lectern**, **Add to Lectern**, **On Lectern**, **Play next**, and
  **Remove from Lectern**. The dock is a `region` labelled **Media player**.

## 7. Files and deletion map

### Create

- `python/nexus/services/consumption/{service,_state_store,_lectern_store,_listening_store,_projection}.py`
- `python/nexus/services/resource_mutation_replay.py`
- `python/nexus/ids.py`
- `python/nexus/tasks/{media_teardown,storage_object_cleanup,storage_orphan_sweep}.py`
- one Alembic revision: intent; `auto_queue_watermark_at`;
  `media_source_attempts.signed_upload_expires_at`; source/state CHECK removal;
  `podcast_listening_states.{write_revision,reset_epoch}`; non-cascading
  user/media FKs for `consumption_queue_items`, `consumption_overrides`,
  `podcast_listening_states`, and `reading_sessions`; user deletion remains
  restricted pending a complete account-lifecycle cutover
- `python/nexus/schemas/{consumption,presence}.py` and
  `python/nexus/api/routes/lectern.py`
- `apps/web/src/lib/api/{presence,presence.test}.ts`
- `apps/web/src/lib/lectern/{contract,client}.ts`,
  `apps/web/src/lib/lectern/LecternProvider.tsx`, and
  `apps/web/src/lib/player/playerSession.ts`
- `apps/web/src/app/api/lectern/route.ts`,
  `apps/web/src/app/api/lectern/commands/route.ts`, and
  `apps/web/src/app/api/consumption/commands/route.ts`; focused
  provider/session tests; and
  `e2e/tests/lectern-player.spec.ts`

### Modify

- Backend owners: models/migration tests, errors, permissions, route registration,
  `config.py`, `db/retries.py`, `jobs/{queue,registry,worker}.py`, `attention.py`,
  `media_deletion.py`, `upload.py`,
  `storage/client.py`,
  `api/routes/{consumption,listening_state}.py`, `library_entries.py`,
  `default_library_closure.py`, `epub_ingest.py`, all nine audited reference
  callers, podcast ingest/poll/subscription schemas, agent writes, media schemas,
  `python/{pyproject.toml,uv.lock}` for pinned `uuid6`, and integration tests.
- Projection adopters: `services/media.py`, `services/library_entries.py`,
  `services/podcasts/{episodes,subscriptions_query}.py`; no direct consumption
  projection read remains outside `_projection` or attention's aggregate owner.
- Schemas: `python/nexus/schemas/{attention,media}.py`; job/pruner and teardown
  recovery tests; `tasks/{prune_background_jobs,reconcile_stale_ingest_media}.py`;
  upload/email/source/EPUB late-writer tests.
- Replay callers: `notes.py`, `_contributor_replay.py`, `contributors.py`,
  `resource_items/{mutations,surfaces}.py`; preserve hash-basis regression tests in
  `test_{notes,contributors,resource_item_surfaces}.py`.
- Frontend owners: `AuthenticatedShell.tsx`; player
  `{audioEffects,chapters,globalPlayer,listeningState,mediaSession,subscriptionPlaybackSpeed,usePlayerKeyboardShortcuts}`;
  `app/api/media/[id]/listening-state/route.ts`;
  `GlobalPlayerFooter.tsx` + CSS; Lectern pane/prompt; media pane/transcript;
  podcast `PodcastDetailPaneBody`, `PodcastEpisodeList`, `EpisodeControls`,
  `episodeTranscript`; library pane; Launcher controller/model/providers/dispatch;
  resource actions, attention client, proxy guard, audio helper, and matching tests.
- Explicitly retarget `python/tests/test_cutover_negative_gates.py`.
- Docs: `docs/rules/{boundaries,json-values,frontend}.md`, `docs/modules/player.md`,
  `docs/modules/storage.md`, `docs/architecture.md`, `docs/scriptorium.md`, both
  superseded cutovers; `deploy/cloudflare/{apply-r2-lifecycle.sh,r2-lifecycle.example.json}`
  and its drift test; plus
  stale claims in `amanuensis`, `mobile-sheet-keyboard-unification`, and
  `walknotes` cutovers.

### Delete

- `python/nexus/services/{consumption_queue,listening_state}.py` after owner extraction and
  `python/nexus/schemas/queue.py`.
- `python/nexus/api/routes/queue.py`; old consumption-override and listening
  batch handlers/tests. Keep singular listening-state GET/PUT in its route file.
- BFF `apps/web/src/app/api/queue/**`,
  `apps/web/src/app/api/media/[id]/consumption-override/route.ts`, and
  `apps/web/src/app/api/media/listening-state/batch/route.ts`.
- `apps/web/src/lib/player/{consumptionQueueClient,usePodcastTrackSeeding}.ts`, all audio-kind lists,
  event invalidation, next-fetch helpers, and empty-stream fallback.
- `apps/web/src/components/GlobalPlayerConsumptionPanel.tsx` + test and only its
  selectors from `GlobalPlayerFooter.module.css`; there is no standalone queue CSS file.

## 8. Acceptance

1. Lectern-origin end installs the returned snapshot, removes only the exact origin, then
   plays its eligible next audio; no successor and Direct end retain `PausedAtEnd`.
2. Single completion removes only an observed exact item. Batch is state-only.
   Remove/Next never finish; Unread never adds; derived state never prunes.
3. Lost-response replay applies effects once but returns fresh state; intervening
   auto-sync additions remain. Hash mismatch and exact identity mismatch write nothing.
4. Concurrent Place/Ensure cannot 500, duplicate, or exceed 2,000 rows. Move keeps
   `itemId`; order/hidden slots remain deterministic.
5. Auto-sync proves null/disabled/re-enabled watermark rules, cutoff boundaries,
   missing publication time, monotonic atomic advance, stale-claim fencing, and
   no persisted batch memo.
6. Creator/claim and stale-job/new-intent races linearize; ref recheck voids only
   the exact intent; deleting media rejects new references with `E_MEDIA_DELETING`.
7. Crash at every teardown/write-cleanup checkpoint recovers. Timed-out direct
   and in-process writes receive a final post-drain sweep; failed cleanup/deletion
   stays named, retryable, requeueable, and unpruned. R2 lifecycle plus recurring
   orphan sweep catch writes completing after expiry or an earlier delete.
8. Initial-load failure has Retry; Play/mutation cannot run while Loading. Pending
   suppresses double Remove; reorder is optimistic; deadline exits in-flight state
   and shows same-ID Retry while the lane remains visibly blocked. Failed active
   Remove restores its row without changing the exact player origin. Failed
   reconciliation exposes GET-only Retry and never repeats a definitive command.
9. Heartbeats are single-flight/generation-keyed and server-revision-fenced. Active
   Unread resets server + retained player to zero; old/late PUTs write neither
   position nor dwell. Replay adopts full current state; failed GET suspends only
   persistence with GET-only Retry. Deadline/stale recovery terminate cleanly.
   History switches cannot rewind the provider position map.
10. Previous/Next/forward/Media Session follow the exact history/head/suffix rules,
    populate both history stacks, re-resolve activation/origin, and handle no
    candidate. Moving an active row preserves origin. Focus/online revalidation
    discovers background additions without racing mutation installs.
11. CompletionFailed retains dock/Walknotes and same-ID Retry. Both reload branches
    after exact-end `E_NOT_FOUND` terminate exact retry and finish state-only.
12. Successful Undo restores after the nearest surviving predecessor (else First),
    uses a new `itemId`, and never reattaches the Direct player session. Partial
    failure truthfully retains Unread and exposes only the remaining restore step.
13. Python and TypeScript schemas accept only exact camelCase tagged variants and
    `Present`/`Absent`; null, omission, alternate casing, and completion heartbeat
    fields fail decode. New intent IDs are UUIDv7/timestamptz; no background-job
    ID is public. Lectern chapter count/title bounds hold at worst-case input.
14. Video never reaches `<audio>`; reload/pane mount never seed it. Desktop/mobile
    controls, queue-free accessible names, next preview, shortcuts/live region,
    playback-failure Retry, speed/effects, shell bottom row, safe area, and
    one-editor rule pass behavior tests.
15. Scoped gates prove deleted routes/symbols and owners: Lectern DML only in
    `_lectern_store.py`; explicit/listening DML only in their stores; session DML
    only in `attention.py`; projection reads only in `_projection`/attention;
    only named lifecycle/auto-sync composition callsites. Media deletion
    explicitly removes all four in-scope child families before parent deletion.
    Superseded owner/gate claims are absent.

## 9. Delivery order

1. Presence/replay primitives, consumption owner, schemas/routes, and DB tests.
2. Teardown/reference barrier and auto-subscription transaction.
3. Lectern provider plus exhaustive capability decoder and optimistic lane.
4. Player session/origin/resume/end reconciliation and retained heartbeat.
5. Reader/podcast/library/Launcher adoption, footer simplification, hard deletion.
6. Negative gates, real-stack E2E, and owner/supersession docs.

Each slice lands only final-state code. No bridge or legacy path is permitted.
