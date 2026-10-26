# resource actions

## purpose

one place answers "what can i do with this resource, now?" for any canonical ref
(`<scheme>:<uuid>`) and does it. the server says which verbs exist and whether it blocks
them; the web labels, orders, confirms and runs them through each verb's owner.
resource subjects share those verbs. both row families use that same resource
ellipsis; an outline bullet separately exposes its exact relationship commands.

podcasts and libraries share metadata and finite collection actions through the
same catalog/projectors. `Metadata` selects an explicit media, podcast, library or
supplied discovery subject; it never treats collection ids as media ids. podcast
metadata is local catalog inspection; discovery metadata names its directory
provenance. library details contains native collection facts. for podcasts, source
means the supplied homepage; feed is a separate native rss link. absent facts grant
no action.

podcast subscription, libraries and more share one finite inline subject across
ordinary rows and headers. at compact widths the complete menu retains every
command once. library cards retain their single scoped removal shortcut. captured
evidence and outline relationships acquire no resource shortcuts. menus retain
their prepared canonical-facts lifecycle; opening a bulk dialog starts its own
selection read. [collection actions](collection-actions.md) owns batch semantics.
filtered view descriptors include their state in their presentation ids; canonical
whole-resource descriptors retain canonical ids. menu identities distinguish
selection scope while execution keeps the same catalog command ids.

## contract

- `GET /resource-items/{ref}/actions` → `ResourceActionsOut {ref, label, activation, missing,
  actions}` (`services/resource_items/actions.py`). each action is `{kind, blocked, …facts}`;
  `blocked` is `PermissionDenied | Locked | Processing | TemporarilyUnavailable |
  PodcastSubscription | null`.
  inapplicable verbs are omitted; forbidden ones are present and blocked. an invisible ref
  answers 200 `missing: true`, no actions, a `none` activation. a bad ref is 400. a media
  carries at most one `Recovery` per import obligation (source, then search); the web keys
  each by its offer kind. `RefreshSource` carries the `expected_attempt_id` it replaces
  (blocked `PermissionDenied` for a non-creator, `TemporarilyUnavailable` while no refresh is
  offered); `RetryMetadata` carries the retry with its `purpose` (title or bibliography).
- `GET /resource-items/{ref}` → `ResourceItemOut {ref, action_ref, label, preview,
  activation, missing}` (`services/resource_items/items.py`). bounded content and
  source capabilities follow [resource references](resource-references.md).
  resource menus use `action_ref`; ordinary activation uses `activateResource`, and native
  row anchors use `activateTargetLink`. both reach the same workspace planner and
  canonical source-target parser.
- `services/resource_items/capabilities.py` is the static policy, one row per scheme, read
  through `capability(scheme)`; `make generate-resource-capabilities` writes the columns the
  web reads (`link_mode`, `sharing`, `app_search_scope`, `inspector`) and the discovery source
  schemes to `lib/resources/resourceCapabilities.ts`.
- web: `useResourceActions(ref)` reads facts for a caller-owned abort signal and returns
  explicit loading, ready or failed state keyed by ref and signal. abort forgets the read;
  ready projection uses current runtime availability. menu composers supply complete
  `MenuContent` through `MenuSource`; `ActionMenu` owns preparation and publication.
  published geometry compares raw measurements to its frozen opening snapshot
  within 1/64 css pixel; it never rebases that snapshot. meaning and viewport
  remain exact. rounding buckets cannot define measurement equality.
  non-menu highlight actions and metadata remedies own their visible read lifetimes and
  local pending/failure/retry feedback. `lib/actions/catalog.ts` owns copy, icons, groups,
  order and confirmations, keyed by the server's kind; `project.tsx` turns facts into
  descriptors; `ResourceActionsProvider` confirms, tracks busy, reports failures and hosts
  the overlays (metadata, library settings, podcast settings and fixed
  podcast addition, unsubscribe, cleanup and episode-removal reviews).
  `ResourceActionPresentation` renders overlays and throws reported action defects
  beneath the existing workspace boundary. overlay state, identity-gated dismissal,
  account command owners and their feedback remain above containment. a review
  read/render defect therefore cannot discard another command's recovery.
  unconfirmed podcast, consumption and lectern requests and their loss guards
  therefore survive an action defect.
- a row ellipsis supplies `action_ref` in either family. when it differs from the
  displayed passage, management appears in `source: {label}`. row composition
  omits loaded open/fork, as do menus on the subject their pane publishes
  ([workspace](workspace.md#target-activation) rule 3); `any-pointer: coarse`
  adds exactly one local fork from displayed activation, preserving location.
  that activation participates in menu subject identity, so a changed route
  retires the open menu.
- a bullet relationship menu supplies no resource ref/fork. right-click,
  context-menu key, shift-f10 and stationary touch hold use the shared context
  anchor. native title link menus stay native. movement, scroll, cancellation,
  lost subject or overlay/pane ownership aborts the hold; completed hold consumes
  its activation click, including mobile-sheet retarget. opening never executes.
  exact unlink/details retain the incoming edge's authority; missing navigation
  does not erase an authorized relationship.
- structural insertion/rearrangement/history use the outline session's direct
  command interface, its keys and the touch accessory, never row/header menu shortcuts.
  independent chat/message admission retains its own composer. no canonical
  `LinkResource` verb or global picker is added. action refs never supply missing
  insertion identity.
- an edit whose state lives in a mounted pane (page title, note body, highlight colour, note,
  bounds and delete, message fork, walk and delete) is a pane entry: the
  menu navigates with `paneEntryActivation` and is done; the landing pane claims and serves
  it ([workspace](workspace.md)).
- an inline button outside a menu sends the identity its own view shows: an import's
  recovery runs the menu's `Recovery` verb through the provider with that obligation's offer
  (`recoverMedia`); metadata research (import row, inspector, metadata overlay) runs the
  menu's `RetryMetadata` with the view's `expected_job_id`; each shares the menu's busy key.
  a title blocked on missing x source context reads the media's verbs while blocked and offers
  its first available source remedy (refresh, retry or repair). an import's open reads the
  item's current activation when pressed (`resolveResourceItem`).
- `useMediaActions` projects episode playback, lectern add/remove and the libraries
  chooser from supplied media identity and shared account owners. direct controls
  never preflight resource menus. unresolved lectern intent wins over membership
  and capacity; recovery checks its exact retained command. newer acknowledgements
  and the revision-gated read establish membership; unknown never means absent.
  `projectLecternAction` owns checking and failed-read recovery for both direct
  and prepared commands. an exact pending command and server prohibition precede
  shared-read recovery. a failed read offers its own refetch when membership or
  revision cannot authorize a new write.
  libraries receives the actual trigger and owning-pane focus fallback. relationship
  menus retain their occurrence principal; media quick actions retain the media id.
- canonical episode actions use requested-media authority even without a holding.
  playback, explicit transcript work, own annotations, state, queue/lectern and
  device downloads acquire no library membership. existing content readiness,
  explicit transcript forecasts/admissions and device ownership still govern them.
  collection commands delegate scope to their owner: known catalogue episodes for
  a show, physical memberships for a library.
- `AddEpisodeToAll` appears only when effective all membership is absent;
  `RemoveEpisodeFromAll` appears only when present. their facts use
  `LibraryPlacementsOut.all_membership`, whose id/revision address the actual
  personal default. removal projects subscription protection as
  `PodcastSubscription` and read-only contributions as `PermissionDenied`.
  named `LibraryPlacement` stays separate, with subscribed placements locked.
  episode removal uses its full guarded preview and command; generic `RemoveMedia`
  serves other media.
- `resourceActions` is the finite media/podcast subject contract shared by pane
  chrome and collection rows. domain hooks supply complete `accessibleLabel`
  values for inline controls and short `menuLabel` values for menu adapters.
  descriptors retain their own menu labels.
  `ActionButtons` does not assemble names or know domain state. it
  owns only button anatomy, disabled explanations, event isolation and focus
  recovery. podcast subscription keeps one control key while its verb changes.
  show indexes, discovery rows and headers expose subscription, libraries and
  one complete more menu; rows demote shortcuts below their 32em boundary and
  headers at 479px. library
  cards retain their scoped single-shortcut policy. shows receive no playback controls.
  live search/chat rows receive explicit subjects matching their own podcast ref;
  captured evidence and editable references receive none.
- podcast shortcut and menu commands share projectors. `PodcastLibraries` is
  distinct from media-only `LibraryPlacement`. invocation passes explicit original
  focus and captured surviving-row fallback through the prepared menu and overlay;
  chooser-to-review handoff suppresses intermediate restoration. current facts
  admit new intent; existing account commands alone own writes and uncertainty.
  manager-scoped removal first restores the original control; the collection's
  focus owner handles a later disappearance. card-local removal captures displayed
  successors at selection and uses that target on acknowledgement, even before
  refresh removes the row. aggregate unsubscribe uses the host's removal target;
  discovery rows keep their original control and headers use their pane landmark.
  disabled unresolved controls say checking/failure, never guess subscribe from
  unknown membership.
- prepared nonmissing media facts may omit playback while the player still owns
  that exact loaded or pending episode. the projector supplements only that
  current-session transport command with no retained descriptor. a server-offered
  playback command, including its block, always wins; idle or unrelated players
  confer no capability.
- external collection rows compose `ExternalMediaMenu` from the same
  `useMediaActions` producer and existing view actions. it is immediate at every
  width and retains the sealed subject after acquisition. canonical saved menus
  remain prepared. menu selection passes the surviving overflow trigger to the
  command, not its departing menu item. no resource-action read occurs on row
  render except the existing metadata source-remedy read.
  podcast-directory episode rows expose the same playback/more composition; the
  directory's bounded snapshot limits listing completeness, not sealed-target
  command authority. find results and stale query rows retain their existing gates.
- external subjects retain their sealed target as identity. opening an unknown
  directory show or episode posts `POST /podcasts/resolve` or
  `POST /podcast-episodes/resolve` with `{target}`, then opens the returned canonical
  href. replies carry `podcast_id`, and episode replies also carry `media_id`.
  resolution dedupes by source, creates no personal holding/rule and requests no
  transcript or model work. new identities still deliver to existing show rules.
  known local targets bypass resolution; preview/action-facts reads create nothing.
- `mediaContinuation` retains explicit destination intent above row/picker lifetime.
  url acquisition freezes source, retry id and removal/destination revisions before
  provider i/o; its accepted library admission already filed the item. settlement
  reads current membership and never reapplies an old filing.
  episode saves freeze the removal fence before catalogue resolution, then read
  canonical destination/order facts without replacing that fence. the account
  command owner retains the exact `PlaceItemRequest`; all addresses the actual
  default and never fans out. resolve, open and playback alone never save.
  unknown writes retain exact-request recovery after dismissal; refusal requires
  explicit review before fresh intent. acceptance identity survives later reads.
  lectern membership waits for identity, not transcript readiness, and saves no
  episode. libraries retarget only their current picker session; completion never
  navigates or reopens a dismissed picker. account teardown/reload ends the
  continuation. pending destination creation blocks competing commands for that
  sealed target through the existing creation owner.
- destination links and create commands carry explicit opening intent through
  `ActionSelectDetail`. bound links retain full targets and own pointer/keyboard
  handling; shared presenters classify commands and suppress new-pane return focus.
- `Chat` and message repeat use the shared `openAsyncResult`
  landing contract ([workspace](workspace.md#target-activation)). later input,
  including wheel, source departure or competing overlay permanently relinquishes
  automatic opening; the initiating layer may remain. success offers its exact
  named result after departure.
- message repeat uses the shared chat command owner before placement. failure
  creates no pane. success names the returned assistant endpoint; ordinary
  placement retains bare-conversation reuse, while shift always forks.
- source refresh and metadata research send the expectation the viewer saw. their account
  admission owner retains an unconfirmed request and offers *retry same request*;
  retry resends the same expectation. live recovery survives pane departure,
  not account teardown or browser restart
  ([imports](imports.md), [media metadata](media-metadata.md)). an access failure after an
  unknown outcome cannot prove that the request was refused.
- `ResourceActionsProvider` mounts the sole consumption command owner. callers use
  `ctx.consumption.finish(id, { title, leaveLectern })`, `markUnread(id)` or `resetProgress(id)`;
  reader *open next* runs its finish through the existing tracked action runtime
  and delayed-result landing contract. the
  owner fences progress holders and keeps the finish response's exact undo receipt beyond
  the originating pane. the exact inverse is offered only by its subject menu through
  reactive `consumptionUndoItems`. `undo(commandKey)` retains private receipts and
  revisions. overlapping
  changes or authoritative refusal retire optional inverses. an uncertain undo
  stays on that menu even after a later refusal; the earlier outcome is still
  unknown, and each failed attempt reports once. send admission and exact owner identity are checked
  after progress preparation, immediately before transmission.
- progress preparation refusal means the position is not ready, not necessarily
  that a save failed. no state request is sent; the reader/player retains its
  specific recovery. an unloaded reader keeps its read fence so retry still loads.
- chat deletion and repeat stay with `ConversationCommands`. `ctx.observeChatCommand` projects
  its continuing recovery after the originating pane closes; it stores no command
  or receipt. the target/revision or run id identify the frozen command, its
  owner's `retry()` checks it, and settlement or a different command removes the
  condition. retained failure copy and the same busy action survive checking.

historical generic failures belong to the action runtime. an admitted deliberate
same-subject/action retry withdraws its exact prior failure before execution;
this does not claim success. current attempt identity fences delayed failures.
modeled local device/admission refusals carry their content through
`ResourceActionFailure` to this same runtime. domain conditions and inverses
retain their separate settlement contracts.

## invariants

- nothing is cached: every open asks again; closing aborts and forgets.
- a tracked verb is busy per `(ref, kind)` until it settles; a reopened menu shows it busy.
- menu preparation shows no provisional command subset. a five-second activation-time
  budget aborts late preparation; failure is a named dialog with shared feedback and retry.
  retry keeps that surface and its interaction owner while pending, with a fresh signal
  and budget. failures never mean an empty result. non-menu reads have no menu deadline.
- a 401 from the current account hands off to sign-in; a modeled failure uses shared
  feedback (`actionFailure`: a recovery 409 is the conflict notice). continuing obligations
  are owner-projected workspace conditions; completed results and optional inverses are
  offers; brief actionless acknowledgments are receipts. the action runtime ignores late
  feedback and auth handling after its account owner leaves. `ctx.isActive()` guards
  projected navigation, deleted-pane settlement, original-file redirects and transcript
  invalidation; admission and consumption owners guard their own effects. older domain api
  helpers retain their existing internal invalidation behavior. a defect while loading
  breaks the menu's pane (both header projections, the phone bar included, render
  inside it), while an action defect stops workspace presentation below the
  account owner.
- confirmations substitute the resource's `label` literally into body `{title}`
  tokens (a media's bare title, without authors); label text is never a replacement
  pattern. confirmation precedes execution and busy tracking. podcast actions use
  distinct `SubscribePodcast`, `PodcastLibraries`, `UnsubscribePodcast`,
  `RemovePodcastEpisodes` and `RemoveEpisodeFromAll` ids and fixed overlays; their
  guarded review is the confirmation. finite show additions stay behind
  `PodcastLibraries`. the subscription projector also serves loaded pane-header facts.
- inverse verbs are ordinary commands; checked semantics belong only to stable state labels.
- visibility, `label` and activation are the item read's (one gate, `items._rows`), so the
  actions read and the item read agree on `missing`; a podcast is a public catalog row (any
  persisted show is visible, as its pane reads it). routing decides no visibility.
- a passage, highlight, note or message is labelled by its words.
