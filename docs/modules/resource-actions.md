# resource actions

## purpose

one place answers "what can i do with this resource, now?" for any canonical ref
(`<scheme>:<uuid>`) and does it. the server says which verbs exist and whether it blocks
them; the web labels, orders, confirms and runs them through each verb's owner.
resource subjects share those verbs. both row families use that same resource
ellipsis; an outline bullet separately exposes its exact relationship commands.

## contract

- `GET /resource-items/{ref}/actions` → `ResourceActionsOut {ref, label, activation, missing,
  actions}` (`services/resource_items/actions.py`). each action is `{kind, blocked, …facts}`;
  `blocked` is `PermissionDenied | Locked | Processing | TemporarilyUnavailable | null`.
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
  the overlays (authors, metadata, library settings, podcast settings, subscribe).
  action defects are thrown by `ResourceActionDefect` beneath the existing workspace
  boundary; the account command owner and its feedback remain above containment.
  an unconfirmed podcast request and its loss guard therefore survive an action defect.
- a row ellipsis supplies `action_ref` in either family. when it differs from the
  displayed passage, management appears in `source: {label}`. row composition
  omits loaded open/fork; `any-pointer: coarse` adds exactly one local fork from
  displayed activation, preserving location. that activation participates in menu
  subject identity, so a changed route retires the open menu.
- a bullet relationship menu supplies no resource ref/fork. right-click,
  context-menu key, shift-f10 and stationary touch hold use the shared context
  anchor. native title link menus stay native. movement, scroll, cancellation,
  lost subject or overlay/pane ownership aborts the hold; completed hold consumes
  its activation click, including mobile-sheet retarget. opening never executes.
  exact unlink/details retain the incoming edge's authority; missing navigation
  does not erase an authorized relationship.
- structural insertion/rearrangement/history use the outline session's direct
  command interface and mobile accessory, never row/header menu shortcuts.
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
  libraries receives the actual trigger and owning-pane focus fallback. relationship
  menus retain their occurrence principal; media quick actions retain the media id.
- external subjects use their sealed target as identity. `mediaContinuation` retains
  explicit membership intent above row/picker lifetime. acquisition freezes its source,
  retry identity and removal/destination revisions before provider i/o. unknown
  admission retries the exact command; refusal needs explicit review and fresh
  choice. acceptance identity is retained before availability reads. URL settlement
  supplies the final media id, including deduplication. library admission already
  filed it; settlement reads current membership and never reapplies an old filing.
  lectern membership waits for identity, not processing success. failure keeps saved
  media and retries only the remaining stage; removed receipts claim no current saving.
  the existing imports observer stays retained while identity resolves. libraries
  retargets only its still-current picker session; completion never navigates or
  reopens a dismissed picker. account teardown/reload ends client continuation.
  pending destination creation blocks competing membership commands for that sealed
  target through the existing creation owner. acknowledged canonical deletion
  forgets completed receipts for that media id.
- destination links and create commands carry explicit opening intent through
  `ActionSelectDetail`. bound links retain full targets and own pointer/keyboard
  handling; shared presenters classify commands and suppress new-pane return focus.
- `Chat`, `LearnHighlight` and message repeat use the shared `openAsyncResult`
  landing contract ([workspace](workspace.md#target-activation)). later input,
  including wheel, source departure or competing overlay permanently relinquishes
  automatic opening; the initiating layer may remain. success offers its exact
  named result after departure. accepted dossier builds say `dossier requested`.
- message repeat uses the shared chat command owner before placement. failure
  creates no pane. success names the returned assistant endpoint; ordinary
  placement retains bare-conversation reuse, while shift always forks.
- source refresh and metadata research send the expectation the viewer saw. their account
  admission owner retains an unconfirmed request and offers *confirm request*; checking
  resends the same expectation. only these two admissions restore recovery after restart
  ([imports](imports.md), [media metadata](media-metadata.md)). an access failure after an
  unknown outcome cannot prove that the request was refused.
- `ResourceActionsProvider` mounts the sole consumption command owner. callers use
  `ctx.consumption.finish(id, { leaveLectern })`, `markUnread(id)` or `resetProgress(id)`;
  reader *open next* runs its finish through the existing tracked action runtime
  and delayed-result landing contract. the
  owner fences progress holders and keeps the finish response's exact undo receipt beyond
  the originating pane. undo has no timer; a superseding consumption command on that media
  or a definitive conflict retires it. an uncertain undo remains a workspace condition.
- chat deletion and repeat stay with `ConversationCommands`. `ctx.observeChatCommand` projects
  its continuing recovery after the originating pane closes; it stores no command
  or receipt. the target/revision or run id identify the frozen command, its
  owner's `retry()` checks it, and settlement or a different command removes the
  condition. retained failure copy and the same busy action survive checking.

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
  pattern. confirmation precedes execution and busy tracking. `PodcastSubscription`
  confirms only unsubscribe; subscribe opens its overlay without that warning.
- inverse verbs are ordinary commands; checked semantics belong only to stable state labels.
- visibility, `label` and activation are the item read's (one gate, `items._rows`), so the
  actions read and the item read agree on `missing`; a podcast is a public catalog row (any
  persisted show is visible, as its pane reads it). routing decides no visibility.
- a passage, highlight, note or message is labelled by its words; a dossier by its subject.
