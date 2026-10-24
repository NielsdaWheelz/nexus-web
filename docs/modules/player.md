# Player Module

## Scope

the player composes four independent owners:

- the lectern owns intended consumption and its explicit membership/order.
- consumption owns progress, reset fences, the versioned finished/unread
  override and first-completion facts.
- a device queue owns a saved occurrence sequence and cursor, captured once
  from an explicit source view. editing it never edits that source.
- one engine owns actual audio and each load's identity: an audio element in
  the browser, the media3 service on android.

reader completion can select the next readable lectern row. audio previous,
next and natural end follow the device queue. `lecternNext` serves readers
only. natural completion records the real terminal sample, marks played and
removes lectern intent regardless of playback origin. every activation resolves
current consumption authority; finished media starts over. external previews
pause and preserve the queue, then end without advancing or resuming it.

[playback sessions](playback-sessions.md) owns queue schemas, source capture,
conditional browser persistence, retry postconditions and account cleanup.
quick reads and suggestions own no playback sequence. browse owns previews;
[podcasts](podcast.md) owns acquisition and sync;
[consumption activity](consumption-activity.md) owns observed activity/stats;
[offline](offline.md) owns downloaded files and their leases.

## Invariants

1. public writes are serializable under the viewer row lock
   (`services/consumption/__init__.py: viewer_txn`). internal lectern primitives
   take the viewer lock inside their caller's transaction; internal append
   callers use read committed.
2. every write is absolute and states its retry rule. lectern commands retain
   their captured order revision: an accepted command advances it, so an old
   retry conflicts even when its intent is already satisfied. a fresh matching
   remove of an absent row still advances the fence. finish re-applies (no
   second completion); unread and reset re-apply (the fences advance again).
3. The override revision is never reused (reset and the clearing of unread
   keep the row). A finish answers `Finish {revision, prior_status,
   completion_id, removed}`; its undo, carrying that answer, applies only while
   the override still holds that revision, and a resend that already landed
   (the next revision, back in the prior status, the fact gone) succeeds.
4. Listening writes are fenced by `reset_epoch` alone: last writer wins within
   an epoch, a reset wins across epochs. Unread, reset and undo bump the epoch.
   completion is monotone within an epoch: any write that can move finished to
   unread or in progress changes `reset_epoch`, so a same-epoch override change
   cannot undo finished. device projections rely on this to retire stale local
   completion by epoch alone.
5. a natural end is fenced on the captured override revision and terminal
   sample's reset epoch. retry succeeds only at the next finished revision,
   the same epoch and absent lectern membership. later unread, reset or re-add
   wins. browser terminal completion and queue advancement commit together;
   native stores its terminal record and next cursor atomically, then delivers
   consumption through the recorder.
6. one audio owner per device: android's service owns native playback; one
   account-scoped exclusive web lock owns browser audio and queue writes.
   restoration is paused. unsupported browser coordination is unavailable.
7. A Lectern holds at most 2000 rows, hidden ones included; media teardown
   removes every consumption row of the media, and Remove from Nexus removes the
   viewer's row (taking the viewer lock before the media, as teardown does).
8. A mounted reader or player of a media flushes and pauses its unsaved
   progress before unread, reset and undo of that media, and reads the
   server's after (`holdProgress`). bulk collection state writes use the same
   boundary for their fixed target ids. every started preparation settles;
   one failure prevents the write, and only successfully prepared holder/id
   pairs reconcile. fulfillment proves acknowledgment or authoritative
   supersession. `ProgressPreparationError` leaves pending progress and the
   reader/player's recovery intact, releasing only the temporary command hold.
   unresolved reader-position conflicts require the existing choice. successful
   writes stay acknowledged even if reconciliation needs owner-local recovery.
   browser/reader owners enforce this contract; native acknowledgment and outage
   classification gaps remain tracked in [native fence saves](../issues/native-progress-fence-discards-unconfirmed-samples.md)
   and [native fence availability](../issues/native-progress-fence-unavailable-classification.md).
9. A tab's lectern writes go one at a time: membership intents (add, remove,
   place) in admission order, one per media, each sent at the floor its
   predecessor left (the highest revision the tab knows, from a read or its own
   acknowledgement); a move or reviewed collection batch only on an idle
   lane at the exact revision on screen. A lost answer blocks the lane until "check" or a read past its
   revision settles it; a refusal reaches its caller. A membership write is
   refused as a conflict only when the revision moved, so the lane then waits
   for a read past it; a move's conflict leaves the floor alone, since the
   server also refuses a move whose row went hidden at an unchanged revision.

[collection actions](collection-actions.md) owns finite bulk selection, atomic
state/inverse semantics and reviewed lectern appends.

single unread, reset and finish-undo acknowledgements return their resulting
override revision. the account owner orders inverse offers by these revisions,
not response arrival time; late older acknowledgements cannot replace newer
inverses. inert collection choices preserve still-valid earlier offers.

## Backend owners

`python/nexus/services/consumption/`:

- `lectern.py` — sole DML owner of `consumption_queue_items` and the Lectern
  read. Positions are dense over visible and hidden rows (a row is hidden while
  its media is not visible to the viewer or is being torn down; hidden rows
  keep their slots, since a placement permutes the visible rows through the
  visible slots and a new row takes a new last slot, and they count toward the
  cap). `place` puts one media first or
  after another media's visible row (first when that row is absent or hidden);
  a null placement only ensures membership: an absent media takes the absolute
  tail and an existing row keeps its identity, added time and position;
  `remove_media_in_txn` answers what an undo needs (`{item_id,
  added_at, after_item_id}`); `restore_in_txn` puts that row back after its
  former predecessor while it is visible, else first;
  `append_missing_in_txn` and `remove_item_in_txn` serve internal callers in
  the caller's transaction. all accepted public membership
  commands and explicit internal remove/restore/nonempty-append intent advance
  the viewer's shared sequence revision, including already-satisfied intent.
  strict reorder preserves membership and hidden slots; its precondition is
  checked under the viewer lock before actor/successor validation.
- `state.py` — sole DML owner of `consumption_overrides`,
  `reader_engagement_states` and `consumption_completion_facts`: the player
  read, the reader cursor composition, listening and preview writes, finish,
  undo, unread, reset, the natural-end settle, the collection batch state and
  media teardown. `settle_natural_end_in_txn` composes completion/removal with
  browser cursor persistence; `natural_end_is_settled` inspects the full retry
  postcondition without reapplying it.
- `listening.py` — sole DML owner of `podcast_listening_states` (position,
  duration, nullable episode rate, reset epoch, `last_engaged_at`). A write is
  `UPDATE … WHERE reset_epoch = :epoch`, else an insert when the epoch is 0;
  positions are clamped only to positive duration; an absent rate or duration
  keeps the stored one. `install_preview` writes only when there is no row.
- `projection.py` — the read model other slices compose: the one read-state
  ladder in SQL (`engagement_fact_rows_sql`, `episode_state_*_sql`), read
  states (`Unread | InProgress | Finished`), engagement recency and anchors,
  `player_descriptors`. A descriptor's `position_ms` is 0 when the episode is
  finished by override; `playback_rate` is the episode rate ?? the
  viewer/show default ?? 1; `podcast_id` identifies the episode’s show independently
  of settings or subscription. `remaining_time_rows_sql` composes raw reader
  seconds and stored physical listening position/duration for library ordering.
- `observation.py` — owns account `consumption_revision` advancement and canonical
  episode observations. mutation owners advance under the viewer lock in their
  own transaction; reads and already-settled natural-end retries only observe.
  positions and durations are raw listening values, including null versus zero;
  feed duration remains source metadata. targeted library/podcast/lectern reads
  carry the same-snapshot watermark and returned episode states.
- `reader_cursor.py`, `activity.py`, `stats.py` — see
  [reader-implementation.md](reader-implementation.md) and
  [consumption-activity.md](consumption-activity.md).

## Wire

```http
GET    /lectern                       -> {items: [{media_summary, added_at, activation}], at_capacity, order_revision}
PUT    /lectern/items/{media_id}      {placement: First | After{media_id} | null, expected_order_revision} -> {order_revision}
DELETE /lectern/items/{media_id}?expected_order_revision=... -> {order_revision}
PUT    /lectern/items/{media_id}/position {before_media_id: UUID | null, expected_order_revision} -> {media_ids, order_revision}
POST   /media/{id}/finish             {leave_lectern} -> Finish
POST   /media/{id}/finish/undo        Finish -> {override_revision}
POST   /media/{id}/unread             -> {override_revision}
POST   /media/{id}/progress/reset     -> {override_revision}
POST   /media/{id}/natural-end        {terminal_listening, expected_override_revision} -> EpisodeConsumptionObservation
GET    /media/{id}/player             -> PlayerActivationOut{descriptor, observation} (404 when not playable)
PUT    /media/{id}/listening-state    ListeningIn -> EpisodeConsumptionObservation
POST   /media/{id}/preview-position   {position_ms, duration_ms} -> 204
GET    /lectern/suggestions, /lectern/quick-reads   (suggestions)
```

the player/read-write results use `Data`; the lectern read keeps `data` and adds
`consumption_revision` and `episode_consumption`. accessible listening/natural-end
conflicts expose the current full observation in `details.current`; inaccessible
media expose no state.

`GET /media/{id}/episode-download` captures source rendition, sanitized published
notes with image placeholders, canonical baseline and optional transcript metadata
under one repeatable-read snapshot. `services/episode_download.py` hashes canonical
rendition/notes separately from exact serialized `Data[ReaderTranscriptDocumentOut]`
bytes. the fixed transcript subroute returns those bytes only when both captured
identities still match; otherwise it returns `E_EPISODE_DOWNLOAD_CHANGED`. notes
over 512 kib or transcript over 8 mib are explicitly unavailable supplements.
these authenticated reads are private/no-store and write no download archive.

`api/routes/consumption.py` owns the Lectern, its suggestions and the
read-state writes; `api/routes/playback.py` the player read, the listening
write, preview hand-off and queue snapshot/session routes (both registered
before the `media` router). queue wire and persistence contracts live in
[playback sessions](playback-sessions.md).

a null placement ensures membership without moving a present row. the 200
acknowledgement advances the revision; every retry keeps the original revision,
so a repeated old command cannot rebase. strict reorder cannot add a member.
revisions are canonical positive decimal strings bounded by signed bigint.
stale writes return409 `E_RESOURCE_CONFLICT`; membership acknowledgements contain
no order snapshot. a move also answers 409 `E_RESOURCE_CONFLICT` when its row or
successor is no longer visible, at an unchanged revision.
`at_capacity` counts
every row, hidden members included; `items` stay visibility-filtered, so a
media's absence from them does not establish non-membership.

Errors: a placement 404 (unknown media), 400 (after itself), 409 `E_LIMIT`
(2000 rows, an absent media only) or `E_MEDIA_DELETING`; an undo 409 `E_RESOURCE_CONFLICT`
("Completion is no longer undoable") or `E_LIMIT` when its row cannot return;
a settle 409 `E_RESOURCE_CONFLICT` when superseded, 404 when gone, 400
`E_INVALID_KIND` for a non-episode. A listening write answers the accepted
`{position_ms, reset_epoch, consumption_override_revision}`; an accepted
position clears unread and, with known progress at least 95%, writes sticky
finished under the same lock. A stale epoch answers 409
`E_STALE_LISTENING_REVISION` with that tuple in `error.details.current`; the
writer adopts it. "Mark as played" changes state only; the row stays.

Change topics: Lectern writes, finish, undo and settle publish `Lectern`;
finish, undo, unread, reset and settle publish `Consumption`.

## Frontend owners

`AuthenticatedShell` mounts `MediaSummaryProvider`, `LibraryOrderProvider`
(library moves, [library](library.md)), `LecternProvider` and
`GlobalPlayerProvider`, which wraps the workspace and `GlobalPlayerSurfaces`.

- `lib/lectern/lectern.tsx` (`LecternProvider`) is the lectern's one owner: the
  one read every surface shares (`useLectern`: rows, activations, capacity,
  revision; it rereads on `Lectern`, `Metadata` and foreground refresh, and ready
  rows stay shown during a reread), the write lane (invariant 9) behind
  `useLecternCommands` (ensure, remove, place; pending intents; receipts) and the
  lectern's order (`useLecternOrder`: the pending move, its notice, the last
  acknowledged order while the read lags it). An identical pending intent joins;
  an opposed one is superseded without a send; a queued intent reads as
  sending. Receipts carry the exact acknowledged intent kind and cover the
  written media until a read reaches their revision; only Ensure
  acknowledgements accept suggestions. Before the first read, and after a
  membership write's conflict until a read passes it, writes say "lectern is
  not ready · load lectern". `lecternNext` serves reader navigation only;
  `lib/lectern/api.ts` is the transport.
- `lib/consumption/state.tsx` — single and collection state writes with untimed exact undo,
  unread, reset, natural-end settlement, and the `holdProgress` registry the
  reader and player join. `ResourceActionsProvider` owns the consumption
  commands above pane lifetime; sending or unconfirmed undo remains a required
  workspace condition. the offer ends on use, dismissal or owner invalidation;
  it does not survive account teardown or reload.
- `app/(authenticated)/lectern/LecternPaneBody.tsx` — **On the lectern** (play
  rows, one url `sort` key, filter, drag moves one row in Custom view), Quick
  reads and Suggestions.
- `components/media/MediaActions.tsx` — the shared icon commands in live media
  rows and document/episode title headers. `useMediaActions` reads the account
  action runtime and lectern owner; it requests no per-row menu or descriptor.
  pending intent and receipts remain account-local; recovery retains its exact
  command until acknowledgement or account teardown/reload.
- summaries expose `can_play` exactly when an episode record and nonempty
  application playback source permit a descriptor. processing/transcript readiness
  does not gate audio; remote delivery remains the engine's responsibility.
- `playAudio({mediaId, knownDescriptor, positionMs, source, recapture})` returns
  `Applied` or `Superseded` and receives explicit source context. ordinary play matching the current media preserves queue
  edits and pauses/resumes that occurrence; explicit recapture prepares a new
  source snapshot. list owners capture the complete matching source; detail,
  search and suggestion starts create singleton queues. preparation resolves
  before replacement; cancellation before commit preserves the prior queue.
  a sent commit must settle. the browser engine reads `/player` (bounded) before
  replacement; known descriptors permit its outage playback and authoritative
  refusal cannot fall back to them. android never awaits a web descriptor read:
  native resolves each activation from a ready package's lease, else its own read,
  so a downloaded start works offline or behind an unresponsive api. offline list
  owners capture from their complete saved catalog view. `pendingPlayback` exposes
  admitted intent separately from observed audio, and pause retires pending
  activation immediately. `positionMs: null` resumes; a number starts at that exact
  source time. timed play on the live current occurrence seeks in place, preserves
  its load subject and queue edits, and acknowledges play requested, not audibility.
  another, absent or ended source requires fresh authority before a timed start;
  unanswered authority never substitutes a retained descriptor. its selected
  occurrence installs with the requested time before play is acknowledged.
- `lib/player/playerRuntime.tsx` — `GlobalPlayerProvider`: engine choice, the
  state/timeline context split, occurrence commands, serialized loads with
  latest-intent checks, playback preferences and keyboard shortcuts. previous
  restarts after three seconds or selects the preceding occurrence; exhausted
  previous selects the last occurrence paused. next, natural end and up next
  share one sequence/cursor. manual next preserves play/pause intent without
  implying completion. stale replies cannot select another occurrence of the
  same media. current
  preferences initialize from each engine's observed snapshot; android installs
  inherited settings before publishing a source. requested rate and silence
  choices stay separate from observed engine state; one flight applies the
  newest pair. queued preferences retain their engine-owned load subject across
  in-place timed seeks. replacement fences rate, silence and seek, including
  same-media reloads and native advance, and retires old work and presentation;
  temporary native unavailability blocks playback-command admission while
  retaining the confirmed subject and captured save receipts.
  `seekTo({positionMs, expectedSubject?})` captures the current subject when
  omitted and validates it again at engine application. retired seeks do nothing.
  Every play of the loaded episode (bar, page, keyboard, transcript) goes to
  its engine, which owns where a resume starts.
  public explicit play, preview, resume and playing queue selection notify
  `onExplicitPlay` once at admission, before asynchronous work. internal loads,
  natural advancement and passive observations never notify presentation.
  pending intent covers source/descriptor preparation as well as installation,
  including passive-tab playing selection. generation-owned cleanup cannot erase
  a newer start; pause retires pending intent immediately.
  `PlayerQueue.known` distinguishes first observation from confirmed absence;
  queue-derived commands require knowledge and their existing revision/phase
  preconditions. `createQueue` captures a singleton paused queue and rechecks
  absence under ownership; a discovered queue refuses creation rather than
  rebasing it. unrestricted replacement belongs only to explicit-play internals.
  Server rendering and the first client render start absent. Only the existing
  client initialization effect can observe a missing Android bridge and report
  `UpdateRequired`; native response timeouts report `NotResponding`, cleared by
  the next frame. The server cannot infer bridge failure from its own environment.
- `lib/player/queue.ts` owns pure occurrence edits and the shared command
  contracts. append/insert mint one occurrence per deliberate invocation and
  retry its id; move/remove/select name occurrences, never media ids or indexes.
  only upcoming rows can move/remove, except explicit failed-current recovery.
  selection, previous and next preserve history without wrapping. stop retains
  the queue; clear persists empty state under a new identity. replacement/clear
  offer one memory-owned restore, paused under a new identity; later edits,
  selection, account change or reload retire it. `QueueCommandError` identifies
  modeled refusals across persistence, coordination, native and action callers;
  these keep the workspace mounted with recovery feedback. channel replies
  preserve this distinction; arbitrary faults remain defects.
- `lib/player/browserSession.ts` owns absolute conditional browser writes.
  unknown outcomes freeze the exact request and block later mutations. terminal
  recovery resends through the joint consumption/queue postcondition. pause or
  seek retires automatic activation; an already-sent write settles before a
  newer retained cursor is persisted.
  initial knowledge is false; successful reads and acknowledged saves establish
  it. refresh failures preserve confirmed data. the runtime bounds first browser
  observation by the existing five-second coordination deadline; preparation
  and cancellation cannot clear unresolved startup failure.
- `lib/player/browserOwnership.ts` owns the exclusive account web lock and
  narrow broadcast channel. passive tabs mirror state and forward non-play
  commands. explicit play resolves its source, requests cooperative release,
  pauses old audio and drains writes before acquiring/reading paused state.
  transfer never steals a lock; a five-second timeout prevents late autoplay.
  uncertain persistence prevents release. opening/observing a tab never
  acquires ownership merely because another tab is playing.
- `lib/player/browserEngine.ts` owns the audio element, listening writes,
  activity observer, media session and real terminal sampling. listening is one
  flight with the newest sample: pause, seek/rate and the fifteen-second cadence
  checkpoint through consumption; pagehide uses keepalive only with new facts.
  terminal samples go to the runtime's durable queue lane. successful completion
  grants no automatic activation after a newer pause/seek/start. the engine has
  no lectern successor or descriptor history. only its attached episode samples
  the shared element; outgoing writes retain their own captured sample/fences.
  an internal resume/retry reload binds its new load subject to the same current
  queue occurrence, never merely to another occurrence of the same media.
- `lib/player/nativeEngine.ts` — the Android engine, a thin client of
  `window.nexusPlayer` (below). frames are decoded strictly at this boundary and
  snake snapshots map onto the engine state; `source.package_id` identifies a
  downloaded recording (`packageId`). an unanswered bounded request or the
  service's `{unavailable: true}` frame shows "Player unavailable", never an empty
  player, until the next frame arrives. `listening_revision` invalidates the
  listening facts below; observations and explicit delivery retry use its
  `observe_consumption`/`retry_listening` operations. preference commands resolve
  after application and snapshot publication. expired replies are ignored; live
  replies cannot replace an intervening confirmed load. real pushes from the
  current controller remain authoritative. preference admission refuses while
  unavailable; recovery preserves failed intent for explicit retry.
  the accepted snapshot counter establishes queue knowledge. runtime reads and
  pages retain their originating engine and observation; retired success/failure
  cannot change current queue data or status. a timeout cannot mark availability
  lost after a newer accepted snapshot.
- `lib/player/presentation.tsx` owns desktop visibility for the account's workspace
  lifetime, independently of audio, queue data and mobile chrome. initial markup
  is hidden; mount reads `sessionStorage` key `nexus:desktop-player:<account_id>`
  before explicit commands write `shown`/`hidden`. denied storage leaves the
  in-memory choice usable. rail-open focuses the committed region; hide returns
  owned focus to the rail and closes desktop pickers without changing playback.
  explicit desktop play/resume reveals without moving focus; mobile commands
  preserve the desktop choice. tabs keep independent ongoing choices.
- `lib/consumption/listening.ts` — android's committed listening facts: rereads
  the fixed account-bound `/_nexus/device/listening.json` after a newer
  `listening_revision`, decodes strictly and drops older or other-account reads.
  `local` is unacknowledged activity only; an acknowledgement is `observed`. it
  forwards canonical observations (live read stamps, the saved catalog) for media
  native retains, in frames of at most 100 observations and 32 kib, and owns the
  one pure presentation projection of the consumption rules over dated sources:
  a newer observation replaces the source; local activity applies within its reset
  epoch, clears unread and makes completion sticky; its natural end applies at its
  captured override revision and leaves the lectern. duration is the activity's,
  else the observed listening record's, else the dated feed's; zero stays unknown.
- `components/player/` — the persistent desktop/mobile player, loaded-source
  sheet, desktop playback/chapter pickers and shared presentational fields.
  the authenticated workspace keeps one mounted player and live-region owner.
  a hidden desktop slot contributes no geometry or tab stops; its operation
  owners remain mounted. the permanent rail disclosure indicates active playback
  or engine/queue/preference-application failure without forcing reopen.
  a retained stopped queue
  remains reachable with resume/up next even when the engine is absent.
  exhausted and empty queues are distinct; before queue authority is known,
  the player shows loading or its read failure, never “nothing queued”;
  restoration never starts audio.
  `Loaded` retains identity, transport and stop while load-scoped preferences
  initialize; preference-dependent controls require the current settings subject.
  `Unavailable` exposes the actual warning and android update link only when
  required. stop unloads and retains sequence/cursor; clear remains distinct. closing an overlay preserves playback. the downloaded shelf is a
  separate composition.
  desktop shares one source/transport/seek/options anatomy across empty, pending,
  unavailable and loaded states. unavailable controls are natively disabled;
  unloaded clocks read `—` and speed reads `speed`. pending pause remains usable,
  and unknown queues never display invented emptiness or counts. wide desktop
  starts at 80px, narrow desktop at 128px; coarse pointing adds 16px for seeking.
  the 64rem breakpoint belongs to
  the player container. equal side tracks center transport in the whole player.
  enlarged text and substantive failures may grow without clipping controls.
  the 64px mobile mini adds the existing safe inset and shows artwork, title,
  subtitle and play/pause in one row, with a decorative progress edge.
  the mobile drawer orders identity, transport, seek and utilities. its native
  handle is the only header control. playback and chapters begin closed and
  are mutually exclusive plain disclosures; opening/closing the sheet, changing
  subject or changing viewport mode retires them. desktop retains anchored
  pickers and an interactive footer.
  standalone chapter pickers use intrinsic list height within available anchored
  space; embedded mobile chapters retain their host's scrolling. both render the
  same source order, timestamps and current marker. desktop opening retains
  current/first focus without seeking. only positive saved-time totals appear
  beneath silence as `approx. time saved on this device`: the existing device
  estimate, with no episode, precise or cross-device claim. episode up-next
  lives inside playback; chapter context lives in chapters.
  preview exposes rate only, with no queue advancement, chapters or default save.
  numbered skips show 15 seconds back and 30 seconds forward. ordinary pending
  work uses control markers; failures expose details and recovery. application
  gain is unity; volume belongs exclusively to the os/device.
  pointer scrubbing previews locally and commits once on captured release,
  including outside the range. cancellation, capture loss, source retirement or
  sheet closure discards it. keyboard seeks carry the rendered range's subject.
  mobile motion, reader overlay composition, ordinary-pane flow and
  keyboard/sheet suppression follow the shared
  [workspace geometry contract](workspace.md#mobile-reader-chrome).
  source-specific overlays close on absence, unavailability or viewport-mode
  change. mobile keeps now playing open across loaded-source changes. ordinary
  dismissal returns to its actual opener; disappearing player controls recover
  owned focus to the visible idle link, otherwise the active pane landmark,
  without scrolling or reclaiming unrelated focus. an open mobile sheet owns
  lost settings-field focus across load-subject changes and preserves surviving
  controls. source navigation keeps destination focus. one live region outside
  inert surfaces owns session/status
  announcements: initial idle is silent, confirmed absence after a known source
  says “playback stopped”, and unavailability warns once without claiming a stop.
  last confirmed source kind/identity survive unavailability, so recovery of that
  source does not announce a new play. settings actions retain their own feedback.

`Engine` and `PlayerSession` expose local
`readonly supportsSilenceSkipping: boolean`. it is immutable per engine: browser
false, native true. the session exposes that engine fact, or false before an
engine exists. it describes capability, not availability or enabled state, and
belongs to neither `EngineState` nor the native/http wire.
only `source.kind === "Episode"` is eligible for silence controls. the browser's
observed silence remains false; a saved android default cannot create an
inherited application failure. an explicit unsupported on command still refuses
at the browser engine boundary.

`PlaybackRateEditor` and `SkipSilenceField({checked, onChange, label})` own fields
and associated help only. callers own capability, application and persistence.
native playback exposes speed and silence; browser playback exposes speed and
plain `skip silence · android app only` copy.

remember freezes the applied native rate/silence pair, or the browser's applied
speed with the baseline's raw android silence default, plus the playback-settings
uuid/version. an absent settings row uses a new client uuid and version zero.
admission requires ready current settings and a readable,
non-refreshing baseline; unavailability blocks new live remember actions.
saving does no engine work: no reload, seek, pause, override clearing or listening
write. its owner outlives picker dismissal; old feedback cannot describe a
replacement subject. live controls apply immediately; independent podcast
defaults remain editable while playback is unavailable.

`lib/podcasts/usePodcastSettingsSave.tsx` owns the shared frozen-command
receipt and recovery. exact retries resend the full frozen body; eligibility
compares current speed on browser and both current fields on native. unknown
outcomes read back the whole raw pair without resending. conflict review requires
an explicit complete-pair save, even when another writer has converged to that
pair; a browser reviewed save preserves the reviewed silence default and version.
settings belong to the viewer/show independently of subscriptions; stopping
delivery preserves them. another settings identity cannot receive the old command.
acknowledged receipts name the captured command: browser `saved speed: {rate}`,
native `saved: {rate} · skip silence {on/off}`. later playback or server-read
changes never rewrite them. current saved defaults are a separate read, with
silence labeled as an android default; saved reads never overwrite playback.
the [podcast module](podcast.md) owns saved nullable defaults and their form.

## android ownership and bridge

`NexusPlaybackService` owns the queue, media3 engine, listening and os transport
without a webview. `PlaybackStore` shares one synchronized atomic envelope per
account with the fixed-route reader. queue/cursor, pending facts, canonical
observations, exact receipts, resume/settings and occurrence checkpoints commit
before publication. resume survives queue replacement and audio removal.
activity spans and acquired packages retain their separate owners. recreation
restores paused; a controller reconnect does not reset the process clocks.

local activation first takes `OfflineStore.openEpisode`: one lease pins matching
package audio, rendition, baseline and committed artwork. it installs immediately
without an origin read or delivery wait. the baseline initializes only facts and
settings not superseded locally. source title/chapters/artwork stay attached to
the loaded recording. pause retains its lease; replacement or dismissal closes
it. removal prevents new leases and waits for current leases to close.

streaming preflight reads `/player` outside the playback mutation lock. its
response captures account, activation generation and candidate media. application
reenters the lock and checks queue, occurrence and load before installation. a
newer local start can pass an unanswered older origin read. unavailable queue
occurrences remain selected with explicit skip; they are never silently pruned.

`window.nexusPlayer` is the sole owned-origin playback transport. snake_case
snapshot fields include process-monotone `snapshot_id`, `listening_revision` and
source `package_id` (null for streaming). `load_id` identifies each engine
installation; keyed controls retain `expected_load_id`, and queue commands retain
queue/revision/occurrence fences. first connection and failure remain distinct
from an observed empty queue. the bridge retains hello for controller recovery
and emits explicit unavailability when binding fails.

queue transfer uses document/controller-owned `queue_begin`/`queue_chunk`, then
`queue_commit` or `queue_cancel`. at most 100 entries fit each 32-kib queue frame;
commit validates completeness and saves paused. `queue_read` and revision-bound
`queue_page` avoid whole-queue frames. chapters use bounded pages. other frames
remain within 64 kib. `seekAndPlay` and timed selection name the episode/load
and install the requested source time before acknowledgement.

`ListeningRecorder` writes absolute samples under their captured reset epoch.
its durable sequence identifies only the local fact being settled; it never
enters an api request. a receipt atomically removes that exact sequence and
adopts only newer canonical observations, preserving newer pending activity.
only a preceding same-media/same-epoch receipt can update a dependent terminal
fence. a threshold-crossing sample remains a coalescing barrier until settled;
95% completion stays finished after a backward seek. natural end is a separate
barrier committed with the next cursor before continuation. refusal never rewinds
that cursor, invents an override revision or revokes downloaded bytes.

403/404/410 suspends delivery for that media while other media continue; explicit
`retry_listening` checks access/fences again. auth/transport loss retains pending
facts under existing admission and retry rules. newer reset observations retire
old-epoch facts and pause only the affected loaded episode. override changes can
supersede terminal completion while ordinary epoch-valid samples remain valid.
local persistence failure pauses playback and refuses the command receipt.
periodic checkpoints bound uninterrupted process-death loss to fifteen seconds;
pause, seek, settings and natural end are durable before acknowledgement.

`ListeningPublication` exposes account-bound, no-store, wire-checked
`/_nexus/device/listening.json`, bounded to 16 mib. it contains the latest
canonical observation and unacknowledged local projection per episode. settled
activity is represented by its observation; internal resume/receipt state survives
until a durably published catalog covers it. bounded `observe_consumption`
frames (100 observations and 32 kib) adopt newer catalog/live observations without
granting resource access. committed changes invalidate the fixed reader; engine
ticks do not. explicit account retirement closes registered streams and removes
the shared store owner before another account is exposed.

explicit sign-out pauses/checkpoints, cancels delivery and releases packages
before purge or cookie change. ordinary document detach preserves playback.
media3 owns processing and clock; positions, chapter/transcript seeks and samples
remain in original-media time. pause shortening uses the load's explicit choice,
then the captured/default setting, then off. volume belongs to the os/device.

## Boundary with podcast sync

playback never fetches feeds or writes transcripts. library-owned subscriptions
deliver physical episode memberships; finite imports acquire history into their
destination. their separate library section does not enter queue capture.
neither delivery nor history appends to the lectern. queue placement remains explicit.
