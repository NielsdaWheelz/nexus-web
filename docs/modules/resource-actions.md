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
  bounds and delete, message fork, walk, rerun, regenerate and delete) is a pane entry: the
  menu navigates with `paneEntryActivation` and is done; the landing pane claims and serves
  it ([workspace](workspace.md)).
- an inline button outside a menu sends the identity its own view shows: an import's
  recovery runs the menu's `Recovery` verb through the provider with that obligation's offer
  (`recoverMedia`); metadata research (import row, inspector, metadata overlay) runs the
  menu's `RetryMetadata` with the view's `expected_job_id`; each shares the menu's busy key.
  a title blocked on missing x source context reads the media's verbs while blocked and offers
  its first available source remedy (refresh, retry or repair). an import's open reads the
  item's current activation when pressed (`resolveResourceItem`).
- lectern add is the Lectern's ensure (`useLecternAdds().add`, a null placement) with the
  resource's `label` as its title; while that add is unanswered the verb reads "adding…" or
  "check add" and checks it instead of sending another. the quick-read and transcript add
  controls read the media's verbs on mount and whenever its lectern membership changes; only
  that read says "on lectern".
- source refresh and metadata research send the expectation the viewer saw, so a lost
  answer's "confirm request" hud resends it and the run that landed answers (metadata: the
  retry rule, [media metadata](media-metadata.md), and its view is read again either way);
  an access reply (401/403/404) settles nothing.

## invariants

- nothing is cached: every open asks again; closing aborts and forgets.
- a tracked verb is busy per `(ref, kind)` until it settles; a reopened menu shows it busy.
- a 401 hands off to sign-in; a modeled error is a hud (`actionFailure`: a recovery 409 is
  the conflict notice); a defect while loading breaks the menu's pane (the mobile bar's menu,
  rendered outside it, through the pane's `onDefect`), while running breaks the shell.
- confirmations quote the resource's `label` (a media's bare title, without authors).
- visibility is the resolver's verdict for every scheme, so the actions read and the item read
  agree on `missing` and activation; a podcast is a public catalog row (any persisted show
  resolves, as its pane reads it). routing decides no visibility.
