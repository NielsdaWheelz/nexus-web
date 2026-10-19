# resource actions

## purpose

one place answers "what can i do with this resource, now?" for any canonical ref
(`<scheme>:<uuid>`) and does it. the server says which verbs exist and whether it blocks
them; the web labels, orders, confirms and runs them through each verb's owner. the same
menu appears on every row, header, dock and pane chrome that shows a resource.

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
  menus use `action_ref`; ordinary activation uses `activateResource`, and native
  row anchors use `activateTargetLink`. both reach the same workspace planner and
  canonical source-target parser.
- `services/resource_items/capabilities.py` is the static policy, one row per scheme, read
  through `capability(scheme)`; `make generate-resource-capabilities` writes the columns the
  web reads (`link_mode`, `sharing`, `app_search_scope`, `inspector`) and the discovery source
  schemes to `lib/resources/resourceCapabilities.ts`.
- web: a menu calls `useResourceActionMenu(ref)` and fetches when it opens (a loading row,
  then the verbs, or an error row with Retry); `lib/actions/catalog.ts` owns copy, icons,
  groups, order and confirmations, keyed by the server's kind; `project.tsx` turns facts into
  descriptors; `ResourceActionsProvider` confirms, tracks busy, reports failures and hosts the
  overlays (authors, metadata, library settings, podcast settings, subscribe, link).
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
- `useLecternAddAction` projects the additive `LecternMembership` command through the
  action runtime and shared lectern owner. direct controls never preflight a resource menu.
  unresolved same-media intent wins over membership and capacity; recovery checks its exact
  retained command. acknowledged receipts and the single revision-gated read establish
  positive membership; visibility-filtered absence cannot prove a delayed write failed.
  direct add stays additive and never becomes remove under the pointer. library media
  entries and search media results promote only stored `web_article`, `epub` and `pdf`,
  identified by library `mediaSummary.media_id` or the canonical media-root id in
  the resource outline; fragments never borrow their owner id. existing quick-read/suggestion/transcript cohorts
  retain their eligibility and lifecycle. titles remain native links.
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
- a failed actions read keeps its retry control while pending. shared feedback supplies
  its status copy; the command remains a native menu item with the menu's focus semantics.
- a 401 from the current account hands off to sign-in; a modeled failure uses shared
  feedback (`actionFailure`: a recovery 409 is the conflict notice). continuing obligations
  are owner-projected workspace conditions; completed results and optional inverses are
  offers; brief actionless acknowledgments are receipts. the action runtime ignores late
  feedback and auth handling after its account owner leaves. `ctx.isActive()` guards
  projected navigation, deleted-pane settlement, original-file redirects and transcript
  invalidation; admission and consumption owners guard their own effects. older domain api
  helpers retain their existing internal invalidation behavior. a defect while loading
  breaks the menu's pane (the mobile bar's menu,
  rendered outside it, through the pane's `onDefect`), while running breaks the shell.
- confirmations quote the resource's `label` (a media's bare title, without authors).
- inverse verbs are ordinary commands; checked semantics belong only to stable state labels.
- visibility is the resolver's verdict for every scheme, so the actions read and the item read
  agree on `missing` and activation; a podcast is a public catalog row (any persisted show
  resolves, as its pane reads it). routing decides no visibility.
