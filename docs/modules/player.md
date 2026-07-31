# Player Module

## Scope

The player module owns two related but distinct concerns: the **Lectern** (one
ordered, mixed-media list of outstanding intentions) and **Now Playing** (one
device-local audio session, not a second durable list). Podcast, video, reader,
agent, and Nexus actions address the ordered list. The Resonance subsystem's
read-only **At hand** Slate is adjacent to the Lectern but does not become
another queue or acquire mutation ownership. The player is the consumer of
podcast episodes (and YouTube videos) for playback; the
[Browse capability](../cutovers/browse-discovery-preview-acquisition-hard-cutover.md)
owns external discovery and Preview, while the [podcast module](podcast.md)
owns acquisition, sync/backfill, and explicit transcription.

Full behavioral contracts, wire shapes, and acceptance criteria:
`docs/cutovers/lectern-player-lifecycle-hard-cutover.md` and
`docs/cutovers/resonance-reading-slate-hard-cutover.md`. Android playback and
pause shortening are specified by
`docs/cutovers/android-native-player-pause-shortening-hard-cutover.md`.
Observed activity and Stats are a separate Consumption capability; see
[consumption-activity.md](consumption-activity.md).

## Backend Owners

`python/nexus/services/consumption/` is the sole backend consumption owner,
split by storage and query concern:

- `service.py` — the public boundary. Two command facades
  (`run_lectern_command` / `run_consumption_command`) each open a fresh
  session and own one `retry_serializable` transaction: viewer lock -> replay
  claim -> validation -> domain writes -> semantic memo -> snapshot read. Read
  facades (`get_lectern` / `get_listening_state` / `get_reader_cursor`) run on
  the request-scoped session; `put_reader_cursor` owns one transaction for the
  cursor CAS, engagement projection, and completion transition. Policy-neutral
  engagement, recent-anchor, complete membership, and item-count ports are
  consumed by Resonance. Two narrow
  in-transaction exceptions compose here rather than going
  through a command: `ensure_missing_items_in_txn` (the auto-subscription
  watermark step; only caller is the fenced finalization path in
  `services/podcasts/sync.py`) and
  `delete_media_consumption_state_in_txn` (media teardown; only caller is
  `services/media_deletion.py`).
- `_lectern_store.py` — sole DML owner of `consumption_queue_items` (Lectern
  membership/order). Builds the canonical `LecternSnapshot`.
- `_state_store.py` — sole DML owner of `consumption_overrides` (explicit
  `Unread`/`Finished` state plus the completion-only revision that fences a
  delayed natural-end receipt).
- `_listening_store.py` — sole DML owner of `podcast_listening_states`
  (position/duration/nullable established episode rate, completion flag, and
  the heartbeat fencing tokens `write_revision`/`reset_epoch`).
  `last_engaged_at` is advanced by successful
  heartbeats and by the one post-acquisition Preview-position transfer. The
  transfer installs only when no owned progress exists and never overwrites a
  listening position or completion. The separate operational `updated_at`
  still advances for
  manual Finished and `ResetProgress`; Finished preserves `last_engaged_at`,
  Reset clears it, and a new manual-Finished row starts with it absent.
  Migration 0186 seeds the new clock from operational `updated_at` only when
  post-fencing state proves the latest mutation was a heartbeat: revision is
  positive, completion is false, and either position is positive or no reset
  has occurred. Pre-fencing, completed, and post-reset zero-position rows remain
  absent because their timestamp is ambiguous.
- `_reader_cursor_store.py` — sole DML owner of `reader_media_state`: one
  revision-fenced `Empty` or `Positioned` cursor per viewer/media. A persisted
  `Empty` tombstone fences stale pre-reset saves without exposing a null-clear
  reader-state API.
- `_reader_engagement_store.py` — sole DML owner of `reader_engagement_states`:
  one current-state row per (viewer, media) carrying `last_engaged_at`
  recency and, for non-PDF locators, a monotonic `max_total_progression`
  (`GREATEST(existing, new)` on every save). It is current resume/engagement
  state, not activity history — a save is a plain idempotent
  `INSERT ... ON CONFLICT (user_id, media_id) DO UPDATE`, with no fencing
  token, committed atomically with the successful/idempotent cursor write (see
  [reader-implementation.md](reader-implementation.md)).
- `_activity_store.py` — sole DML owner of `consumption_activity_spans` and
  `consumption_completion_facts`; `_activity_stats.py` owns their factual
  aggregation and derived sessions. Neither changes the reader cursor or the
  listening heartbeat.
- `_projection.py` — the combined explicit-override + reader-engagement read
  model (`Unread`/`InProgress`/`Finished` + progress fraction), plus batched
  `PlayerDescriptor`s for podcast-episode media. Both descriptor paths reuse
  `services/playback_source.derive_playback_source` and the one playback-rate
  resolver over nullable episode rate plus the active subscription preference.
  They also project the active subscription pause-shortening override and
  current Consumption override revision through required `Presence` fields.
  `services/media.py`,
  `services/library_entries.py`, and `services/podcasts/{episodes,
  subscriptions_query}.py` adopt this projection; no other module reads
  `consumption_overrides`/`podcast_listening_states`/`reader_media_state`/
  `reader_engagement_states` directly except the one documented exception in
  `services/media.py`
  (catalog hydration only; canonical playback state comes from the player
  descriptor).

`python/nexus/services/resonance/` owns the deterministic Reading Slate. It
combines Consumption-owned Continuity with media- and podcast-owned Arrival
facts plus policy-neutral graph, contributor, and calibrated semantic evidence,
then returns at most ten placeable media outside the complete queue. `Finished`
targets are excluded; finished resources may still serve as anchors. The request
performs no model or provider call and uses one repeatable-read, read-only
database snapshot.

Media teardown (`docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §3.1;
see also [storage.md](storage.md)) composes one consumption call,
`consumption_service.delete_media_consumption_state_in_txn` (all users'
Lectern/override/listening/reader-cursor/reader-engagement/activity/completion
rows), inside the deletion transaction — `services/media_deletion.py` never
writes those tables directly.

`python/nexus/services/playback_source.py` resolves the playable source for a
media item (`derive_playback_source`); it is shared by the projection, the
media/podcast DTOs, and the Lectern snapshot so activation derivation
(`FooterAudio` / `Readable` / `OpenPane`) is identical everywhere.

## Command and Heartbeat Ports

```http
GET  /lectern
GET  /lectern/slate
POST /lectern/commands
POST /consumption/commands
GET  /media/{id}/listening-state
PUT  /media/{id}/listening-state
POST /media/{id}/preview-position
```

`python/nexus/api/routes/lectern.py` owns the Lectern reads and two
transport-only command ports; `python/nexus/api/routes/listening_state.py`
owns the singular heartbeat GET/PUT (no batch endpoint). The two POST ports
are bounded aggregate command ports, not a generic command bus: `Lectern`
commands (`PlaceItems`/`RemoveItem`/`SetOrder`) and `Consumption` commands
(`EnsureMediaFinished`/`FinishLecternItem`/`SetUnread`/`UndoCompletion`/
`SetBatchState`/`ResetProgress`/`SettleNaturalEnd`) each
share one transaction/replay scope (`Lectern.Commands` /
`Consumption.Commands`) and one canonical response. POST is
semantic-idempotent through a client-generated `clientMutationId`, keyed by
`(viewerId, mutationScope, clientMutationId)` through the shared
`services/resource_mutation_replay.py` ledger. The listening-state PUT is a
separate, unreplayable CAS mutation fenced by `write_revision`/`reset_epoch`
(§5.4) — it never memoizes and never reuses the command replay ledger. It
writes position/duration plus an owned-absence episode rate; `Absent` preserves
an existing nullable rate and does not establish one on insert. The heartbeat
carries no client-supplied elapsed-time delta or client-supplied device
identifier, and piggybacks no other table's write. Reader cursor and engagement
writes share their own
atomic Consumption transaction (see
[reader-implementation.md](reader-implementation.md)), independent of the
listening heartbeat.

`SettleNaturalEnd` is the only canonical natural-end command. It compares the
captured listening fences and exact Consumption override revision before any
write, installs the terminal source-time observation with zero dwell, and
completes in the same transaction. Exact Lectern origin may advance; Direct or
stale origin completes state only. Replay returns a fresh canonical projection
from the recorded terminal outcome without repeating domain writes.

The Preview-position POST is a replayable post-acquisition command keyed by the
required `Idempotency-Key` header. It accepts only an owned Podcast-episode
Media, clamps the observed position to a present duration, and installs it only
when no positive listening position or completion exists. It is the sole
permitted bridge from ephemeral Browse playback into owned progress.

`SetUnread` and batch Unread change only explicit status. `ResetProgress` is
the sole progress-clearing command: it clears the override, writes a revisioned
Empty reader cursor, deletes current reader engagement, and resets/fences
podcast listening state when applicable. It preserves Lectern membership,
activity/completion history, notes, and annotations.

Owned-absence fields on every wire shape use `Presence<T>` from
`nexus/schemas/presence.py` / `apps/web/src/lib/api/presence.ts`
([rules/boundaries.md](../rules/boundaries.md)) — never `null` or omission.

## Frontend Owners

`AuthenticatedShell.tsx` mounts `LecternProvider` (one `AsyncResource` + one
mutation FIFO that owns every Lectern/consumption mutation and reconciliation
GET) above `GlobalPlayerProvider` (one `PlayerSession`), which wraps
`WorkspaceHost` and `GlobalPlayerSurfaces`. The latter is the shell-resident
presentation owner: desktop Listening Shelf, mobile MiniPlayer, and mobile
full-screen Now Playing. Exactly one active `region` is labelled **Media
player**. It persists across pane navigation and is never an editor (the
Lectern pane is the sole full-list editor).

- `apps/web/src/lib/lectern/` — the Lectern capability: `contract.ts` (the one
  transport-free, isomorphic owner of every Lectern/consumption wire type and
  strict decoder), `client.ts` (HTTP calls only), `LecternProvider.tsx` (the
  FIFO + optimistic-mutation owner), and `useCompletionUndo.ts` (the ten-second
  Undo toast after explicit exact completion). Server pane seeding imports the
  pure contract directly and never imports the browser transport facade.
- `Reset progress` is one catalog-owned resource operation exposed by Library,
  Podcast episode, Lectern, and Media surfaces only when the canonical
  projection says `progressResettable`. `LecternProvider` emits the singular
  returned `progressState`; the active player installs its listening tokens and
  pauses, while the mounted reader installs the returned cursor snapshot. A
  Podcast episode collection immediately projects that returned canonical
  zero-position state as Unplayed and no longer resettable, then reconciles its
  full row from the owning Podcast read; it does not leave the pre-reset action
  capability interactive while that read is pending.
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx` renders the
  canonical **On the lectern** collection followed by the shared **At hand**
  Slate. The Slate consumes an optional server first-paint seed, otherwise
  queries on first active mount and every inactive-to-active transition,
  delegates Add to `LecternProvider.placeItems`, and never owns a second
  mutation lane. After success it preserves the exact surviving rows and
  appends at most one novel canonical replacement. `LecternMutationNotice`
  remains the sole assertive owner and Retry surface for an unknown Lectern
  command outcome.
- `apps/web/src/lib/resonance/` and
  `components/collections/ReadingSlateSection.tsx` own strict Slate transport,
  presentation, the destination-keyed read/add/refill state machine, focus,
  and quiet read recovery. They do not own queue state or write commands.
- `apps/web/src/lib/player/` — the audio session: `playerSession.ts` (pure
  session/origin/history/resume state machine, zero React/I-O),
  `browserPlayerRuntime.ts` (the non-Android `<audio>` element, output-effects
  graph, browser Media Session, heartbeat, and activity adaptation),
  `androidPlayerRuntime.ts` plus `androidPlayerClient.ts` (the exact
  `nexusPlayer` protocol and native snapshot/command adaptation),
  `playerChromeModel.ts` (the exhaustive pure semantic projection),
  `outputEffects.ts`, `pauseShortening.ts`, `chapters.ts`, `mediaSession.ts`,
  `playbackRate.ts`, `usePlayerKeyboardShortcuts.ts`, and
  `globalPlayer.tsx` (the exclusive platform-runtime selector and public
  re-export boundary). Each runtime publishes stable Commands and
  cadence-separated Session/Settings/Timeline capabilities. `playbackRate.ts`
  is the one owner of product bounds, steps, presets, parsing, formatting, and
  adjusted remaining time.
- Both selected runtimes implement the exhaustive `PreviewAudio` session
  variant. It has no Media ID, Lectern
  origin/history, heartbeat, completion command, activity observation, queue,
  podcast preference, pause-shortening preference, or previous/next
  capability. Preview starts at `1x`; natural end is local
  `PreviewAudioAtEnd`.
  Stopping Preview returns one in-memory position snapshot and clears OS Media
  Session position state.
- Android selects one service-owned Media3 runtime. The WebView mounts no audio
  element, Web Audio graph, browser Media Session, heartbeat, or listening
  recorder. The native service records original-source position and Listening
  activity while the browser runtime retains those owners on non-Android. A
  replacement native controller re-handshakes the account and pushes one
  authoritative full snapshot plus pending-receipt Presence; stale web state
  never drives the replacement service.
- Canonical natural end first persists one account/session-fenced native
  receipt. `LecternProvider.settleNaturalEnd` enters the existing FIFO without
  a live player session, installs the canonical result, and acknowledges only
  the exact recorded outcome. Session match gates presentation and successor
  start, not settlement.
- On canonical `LoadCanonical`, `NexusPlaybackService` resolves the source once
  through `OfflineMediaStore`. Ready uses the store's one Media3 cache directly;
  every other state captures the canonical remote source. Missing or corrupt
  Ready bytes fail without network fallback, and later download-state changes
  never switch the active source.
- `apps/web/src/components/player/` — the Listening Shelf, MiniPlayer, full-
  screen Now Playing, and shared cadence-scoped controls. The surfaces share
  one Capture controller and one provider-lifetime live region. They do not
  mount media elements, mirror session state, or own queue/chapter data.
  Contents and Lectern affordances use canonical workspace activation. For
  `PreviewAudio`, every surface omits canonical history, Capture, Contents,
  completion, and durable-status actions.
- `dismiss()` is a device-local teardown, not completion: it samples and
  flushes progress/activity before unloading audio, clears player history and
  OS controls, resets transient persistence state, and preserves all durable
  Consumption/Lectern facts. It remains available during completion. Pause
  never dismisses; mobile Back/Escape/Collapse never changes playback.

## Boundary With Podcast Sync

Playback never fetches feeds or writes transcripts. Live sync and historical
backfill may both persist episode metadata plus `external_playback_url`, but
neither fetches or publishes a transcript. Live sync alone may compose the
auto-queue watermark step; backlog does not enqueue historical episodes.
Canonical playback resolves and streams the owned source, and the listening
heartbeat records position. A transcript appears only after explicit Transcribe
and is rendered from current media fragments; the player never owns transcript
state.
