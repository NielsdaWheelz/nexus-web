# Media Progress Reset Hard Cutover

Status: APPROVED SPEC — 2026-07-24

Type: hard cutover. One final contract; no aliases, fallbacks, dual
reads/writes, feature flag, or backward compatibility.

No blocking question remains.

The nullable episode-rate storage and reset clauses are superseded by
[`playback-rate-policy-hard-cutover.md`](playback-rate-policy-hard-cutover.md);
reset preserves an existing rate and inserts `NULL` when no listening row exists.
On Android, the native player drains before Reset and
`AdoptListeningState` seeks and pauses; that runtime handoff is superseded by
[`android-native-player-pause-shortening-hard-cutover.md`](android-native-player-pause-shortening-hard-cutover.md).

## Goal

Give every media item two independent, honest controls:

- **Mark as finished / unread** changes the user's explicit status.
- **Reset progress** starts a fresh attempt from the beginning.

Reset applies to web articles, EPUBs, PDFs, videos, and podcast episodes.

## Target behavior

- Publish **Reset progress** in the existing resource action menu for:
  Library rows, podcast episode rows, Lectern rows, and the open Media pane.
- Show it only when the canonical projection says `progressResettable`.
- Confirm before mutation:
  `Reset progress? This starts the item from the beginning. Notes and activity
  history are kept.`
- For video, append:
  `YouTube watch history is not changed.`
- On success, show `Progress reset.`
- Preserve focus on the invoking row/control.
- If the item is active:
  - pause audio at `0`;
  - move the mounted reader/transcript to its canonical beginning;
  - cancel pending local saves and install the returned server snapshot.

Reset never changes Lectern membership or order.

## Capability contract

| Command | Explicit status | Resume/current progress | History | Lectern |
| --- | --- | --- | --- | --- |
| `EnsureMediaFinished` | `Finished` | preserve | append completion on transition | preserve |
| `SetUnread` | `Unread` | preserve | preserve | preserve |
| `ResetProgress` | clear override | reset | preserve | preserve |
| `UndoCompletion` | `Unread` | preserve | remove exact undoable completion | restore only through existing Undo flow |

`SetBatchState(..., Unread)` is also status-only. There is no batch reset.

After reset, the derived state is `Unread`, reader progress is absent, podcast
position is `0`, and `progressResettable` is false. A known podcast duration
may still yield fraction `0`; Unread UI renders no progress indicator. New
reading/listening naturally derives `InProgress`; no sticky override remains.

## Rules

- Status, current progress, factual history, and Lectern membership are
  independent axes.
- One command changes one semantic axis; Reset is the only progress-clearing
  command.
- Server snapshots and fencing tokens are authoritative; clients never infer
  them.
- Reset is atomic current-state replacement, not destructive history deletion.
- Provider state is never presented as Nexus-owned state.
- New variants must fail exhaustive backend and frontend matches until handled.

## Scope and reset boundary

Reset deletes or replaces only current-state inputs owned by Consumption:

- clear the `(viewer, media)` `consumption_overrides` row;
- replace the reader cursor with a revisioned `Empty` tombstone;
- delete the `reader_engagement_states` row;
- for podcast episodes, set listening position to `0`, clear completion and
  engagement recency, and advance both fencing tokens.

Reset preserves:

- `consumption_activity_spans` and `consumption_completion_facts`;
- notes, highlights, annotations, Walknotes, and graph relationships;
- media/library/podcast records and processing artifacts;
- Lectern membership/order;
- nullable established episode rate and known episode duration;
- reader profile/preferences;
- external YouTube/provider watch position.

PDF cursor-local zoom is reset with the cursor. Separating per-media visual
state is outside this cutover.

## Final architecture

```text
resource action menu
  -> LecternProvider consumption FIFO
  -> POST /consumption/commands { kind: "ResetProgress", ... }
  -> consumption_service: one replayable serializable transaction
       reader cursor tombstone
       reader engagement delete
       explicit override delete
       podcast listening reset, when applicable
       canonical response projection
  -> one progress-state install event
       GlobalPlayer
       mounted reader coordinator
       invoking collection surface
```

`python/nexus/services/consumption/` becomes the sole persistence owner for
all per-viewer current progress:

- `_reader_cursor_store.py` — `reader_media_state`;
- `_reader_engagement_store.py` — reader recency/progression;
- `_listening_store.py` — podcast position/completion/fences;
- `_state_store.py` — explicit `Unread`/`Finished`;
- `_projection.py` — state, progress, recency, and reset availability;
- `service.py` — public GET/PUT/command and media-teardown composition.

Extract cursor DML/CAS from `services/reader.py`; that module retains reader
profile and reader-domain behavior. Reader HTTP routes remain transport-only
and call Consumption for cursor GET/PUT.

Cursor PUT becomes one transaction:

```text
viewer serialization lock
  -> validate visibility + locator kind
  -> conditional cursor write
  -> reader engagement write
  -> completion-transition fact, if any
  -> commit
```

This removes the current committed cursor / later engagement race. Media
teardown calls the existing Consumption teardown port; direct
`reader_media_state` DML in `media_deletion.py` is deleted.

No workflow, event bus, generic command framework, cache, or new table.

## Database

Migration `0195_media_progress_reset.py` makes
`reader_media_state.locator` nullable.

- no row means `Empty`, revision `0`;
- `locator IS NULL` means a persisted `Empty` tombstone at revision `>= 1`;
- a positioned cursor remains non-null at revision `>= 1`;
- reset inserts revision `1` when absent, otherwise writes `NULL` and
  increments revision;
- PUT never accepts a null locator or clear shape;
- existing rows require no backfill;
- downgrade raises: this is a hard cut.

The tombstone is the serialization/fencing primitive. A stale pre-reset reader
save conflicts instead of resurrecting progress.

Podcast reset:

```text
existing row:
  position_ms = 0
  is_completed = false
  last_engaged_at = NULL
  write_revision += 1
  reset_epoch += 1
  preserve duration_ms + nullable playback_speed

absent row:
  position_ms = 0
  duration_ms = absent
  playback_speed = NULL
  is_completed = false
  last_engaged_at = NULL
  write_revision = 1
  reset_epoch = 1
```

No new index.

## API

Keep the bounded `POST /consumption/commands` port:

```text
ResetProgress {
  kind: "ResetProgress"
  clientMutationId: UUID
  mediaId: UUID
}

MediaProgressState {
  mediaId: UUID
  readerCursor:
    { state: "Empty", revision: int >= 0 }
    | { state: "Positioned", revision: int >= 1, locator: ReaderResumeState }
  listeningState: Presence<ListeningStateOut>
}

ConsumptionResult {
  outcome: ConsumptionOutcome
  lectern: LecternSnapshot
  nextItem: Presence<LecternItemOut>
  progressState: Presence<MediaProgressState>
  completionHandle: Presence<CompletionHandle>
}
```

`progressState` is present only for `ResetProgress`. It is read canonically
after apply/replay, so consumers install the server result rather than invent
local fencing tokens. `readerCursor` is always present; `listeningState` is
`Present` only for a podcast episode.

Hard-cut `ReaderCursorEmpty.revision` from literal `0` to non-negative integer.
GET may return an absent-row `Empty(0)` or tombstone `Empty(n)`. PUT remains
strict `{locator, baseRevision}` and uses either revision as its CAS base.

Add `progressResettable: bool` to the canonical Consumption projection and its
Lectern/media/podcast DTO adopters. It is true when an explicit override,
reader engagement, non-zero audio position, or audio completion exists.
Historical facts alone do not make it true.

The Python field is `progress_resettable`. Existing camel Consumption DTOs
emit `progressResettable`; existing snake `MediaOut`/episode DTOs emit
`progress_resettable`. Do not broaden this cutover into wire-case migration.

Missing/inaccessible media returns the existing masked `404`. Malformed or
unsupported command shapes fail strict validation. Reset is convergent;
repeating it with a new mutation ID succeeds and advances fences.

## Transaction and replay rules

- One fresh session and fixed order: viewer lock -> replay claim -> authorize
  and resolve kind -> cursor tombstone -> engagement delete -> override clear
  -> optional listening reset -> response projection -> replay memo -> commit.
- The stable replay key is `(viewerId, Consumption.Commands,
  clientMutationId)`.
- The replay memo records the semantic reset target, not serialized transport.
- Reader cursor mutation is the per-media race barrier; listening uses its
  existing `writeRevision` / `resetEpoch` CAS.
- Stale reader PUTs return `409 E_READER_STATE_CONFLICT` with the current
  snapshot. Stale heartbeats return `409 E_STALE_LISTENING_REVISION`.
- Database retry exhaustion remains a defect.

## Frontend composition

- Add `ResetProgress` once to `RESOURCE_ACTION_CATALOG` with id
  `ResourceOperation.Media.ResetProgress`, icon `RotateCcw`, label
  `Reset progress`, and busy label `Resetting...`.
- Add an independent `progressReset` capability to
  `MediaOperationCapabilities`; do not add reset to the finished/unread union.
- In `mediaOperationGroups`, place Reset immediately after the applicable
  finished/unread or played/unplayed action.
- Reuse the dependency-injected confirmation pattern from
  `confirmAndDeleteMedia` in one small Consumption-owned reset helper; surfaces
  do not duplicate copy or response validation. Each surface retains its
  existing feedback owner and strict modeled-error disposition.
- Reuse `mediaOperationGroups`, `mediaResourceOptions`,
  `episodeResourceOptions`, `presentMedia`, and `presentEpisode`.
- Extend `presentLecternItem` with the same catalog action; do not create a
  Lectern-specific label or command.
- `LecternProvider.resetProgress` owns confirmation-adjacent command
  serialization, unknown-outcome Retry, canonical Lectern installation, and a
  typed `progressState` event.
- Rename `registerBeforeSetUnread` to `registerBeforeProgressReset`.
  Registered active consumers cancel/drain pending writes before enqueue;
  server fencing remains the correctness boundary.
- Replace the `listeningStates` install event with the singular
  `progressState` event. Global player and mounted reader handle it
  exhaustively.
- Add one pure player-session reset transition. It installs the returned audio
  tokens/position and leaves the session paused.
- `useReaderProgress` gains one canonical-snapshot install operation. Installing
  `Empty` invalidates pending generations and asks the active format adapter to
  apply its existing cold-start beginning; never manufacture a fake locator.
- Do not optimistically fabricate revisions, reset epochs, or reader
  locations. Collection leaves may optimistically show `Unread` at the
  format-appropriate beginning, but reconcile from the command result.
- Keep the existing ten-second completion Undo. Reset uses confirmation, not a
  second undo/receipt subsystem.

## Hard cuts

Delete, rename, or supersede in the same change:

- podcast rewind from `_write_unread_state`;
- `_listening_store.reset_for_unread_in_txn`;
- `ConsumptionResult.listeningStates` and its decoder/event/tests;
- `registerBeforeSetUnread` and all callers;
- the route-level second `record_reader_engagement` transaction;
- the `ReaderCursorEmpty === revision 0` frontend assumption and
  row-disappearance fallback;
- reader cursor DML in `services/reader.py`;
- direct `reader_media_state` deletion in `media_deletion.py`;
- current docs claiming Mark Unread seeks audio to zero or that locator is
  always non-null.

No deprecated symbol, alternate endpoint, null-clear PUT, legacy decoder, or
compatibility comment remains.

## Non-goals

- Bulk reset or reset-all.
- Restoring/resetting Lectern membership.
- Deleting factual history, completion facts, notes, highlights, or activity.
- Controlling or clearing YouTube/provider history.
- Exact video playhead persistence.
- Cross-device live push; current focus/visibility revalidation remains.
- A reset undo receipt, recycle bin, audit log, new permissions, or settings.
- General refactors of completion, library, podcast, player, or reader UI.

## Files

Create:

- `migrations/alembic/versions/0195_media_progress_reset.py`
- `python/nexus/services/consumption/_reader_cursor_store.py`
- focused backend/frontend tests

Modify:

- `python/nexus/{db/models.py,schemas/{consumption,media,reader}.py}`
- `python/nexus/services/consumption/{service,_listening_store,_reader_engagement_store,_projection}.py`
- `python/nexus/services/{reader,media,library_entries,media_deletion}.py`
- `python/nexus/services/podcasts/{episodes,subscriptions_query}.py`
- `python/nexus/api/routes/{lectern,reader}.py`
- `apps/web/src/lib/lectern/{contract.ts,client.ts,LecternProvider.tsx}`
- `apps/web/src/lib/consumption/progressReset.ts`
- `apps/web/src/lib/actions/resourceActions.ts`
- `apps/web/src/lib/reader/{readerProgress,useReaderProgress}.ts`
- `apps/web/src/lib/player/{globalPlayer.tsx,playerSession.ts}`
- `apps/web/src/lib/collections/presenters/{media,episode,lectern}.ts`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/{PodcastDetailPaneBody,PodcastEpisodeList}.tsx`
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `docs/architecture.md`
- `docs/modules/{player,reader-implementation,reader-design-rationale,
  consumption-activity}.md`
- `docs/cutovers/{lectern-player-lifecycle,reader-progress-continuity}-hard-cutover.md`
  with explicit supersession
- `docs/cutovers/default-library-virtualization-and-transient-state-pruning-hard-cutover.md`
  with explicit supersession
- the narrow existing Consumption/Lectern real-stack E2E

Delete only code made ownerless by the hard cuts above. Do not refactor
unrelated action handlers or DTO families.

## Acceptance criteria

1. Every supported media kind exposes one catalog-owned Reset action on all
   four named surfaces when `progressResettable`.
2. Mark Unread/Unplayed changes status only; it never changes cursor,
   listening position, fencing tokens, or active playback.
3. Reset atomically clears override, reader cursor/engagement, and applicable
   podcast progress while preserving history, notes, and Lectern state.
4. Resetting active audio pauses at zero; resetting a mounted reader displays
   its beginning without a stale save restoring the old position.
5. Stale reader saves and podcast heartbeats fail with their existing typed
   conflicts after reset.
6. Empty reader tombstones round-trip with revision `>= 1`; no client assumes
   Empty means revision `0`.
7. Command replay performs no second logical reset and returns a canonical
   installable progress snapshot.
8. Explicit Unread over latent progress remains resettable; a completed-only
   history record does not.
9. Video resets Nexus transcript/reader state and truthfully leaves provider
   watch history unchanged.
10. Confirmation, busy state, success/error feedback, keyboard operation, and
    focus restoration work from every named surface.
11. One transaction owns reader cursor plus engagement; no post-commit
    engagement race or direct cross-owner DML remains.
12. Strict schema/decoder, projection, command replay, stale-write,
    player/reader install, action catalog/presenter, and one real-stack reset
    path pass focused tests.
13. Residue searches find no legacy symbol, old Unread-rewind behavior,
    compatibility decoder, or stale current-doc claim.

## Implementation order

1. Land this contract and migration/model/schema hard cut.
2. Move cursor ownership and make reader PUT atomic.
3. Implement Reset command, projection, replay, and teardown consolidation.
4. Cut the provider/player/reader install contract.
5. Publish the shared action across the four surfaces.
6. Delete legacy paths, update current docs, run focused tests and residue
   searches.
