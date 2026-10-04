# Panes And Tabs

## Scope

Primary panes are workspace-owned route containers. The pane strip is a desktop
workspace affordance for switching, minimizing, restoring, and closing primary
panes.

## Desktop Pane Strip

`WorkspacePaneStrip` renders only in desktop workspace mode. It reflects the
primary pane order and visibility state from the workspace store and delegates
pane activation/minimize/restore/close actions back to `WorkspaceHost`.

The strip is not part of mobile navigation. Mobile renders the active primary
pane directly and relies on app-level navigation plus pane chrome actions.

## Sequential Traversal

Across all viewport modes, sequential traversal follows visible panes in stable
`primaryPaneOrder`, skips minimized panes, clamps at the first and last visible
pane, and never wraps. The workspace store is its sole owner, and the
`pane-next` / `pane-previous` keybindings invoke that store command on every
viewport. Mobile additionally maps a primary-touch horizontal swipe on the
Nexus control to the same command. No input restores, creates, reorders, or ranks
panes.

## refresh

`usePaneRefresh` owns the refresh command, gesture, source cancellation, and
settled announcement. `useResource` owns fetch identity and retries. Collection
panes use `useRevalidationSettlement` to own one pending promise and its abort
listener. Each pane keeps its source checks, committed-result marker, and
cancellation restoration; it resolves the promise only after its matching
result is committed. The settlement helper owns no data, fetch, or commit effect.

podcast refresh is [durable admission](jobs.md#podcast-live-sync-and-backfill),
followed by that pane's matching read. `lib/podcasts/refresh.ts` owns one typed
`requestPodcastRefresh` command returning the selected-subscription count.
the library detail, podcast detail and podcast index own reload and settled
announcement: `Refresh requested for n show(s)`, or `Nothing to refresh` at zero.
the pane stays indeterminate until reload commits; Complete describes this
command/read, never provider sync completion. ordinary request and read failures
retain their pane-owned feedback/retry behavior. command catch normalization
preserves native aborts and errors handled after the signal becomes aborted.
library retry uses the same command and reload. a mounted podcast action commits
its invocation immediately after accepted admission, before local reload, so a
failed projection cannot abort a durable request. shared pane source fencing,
progress and lifecycle remain owned by `usePaneRefresh`; subscription streams
independently observe the later worker state.

admission cleanup verification (2026-10-02): 16 authenticated api cases preserved
202 bytes, aliases, scope errors and the same committed pending job/generation
identities. five real browser paths verified admission copy, unchanged zero copy,
matching reload, mounted-action commit and library failure/retry. after 202, a
delayed real owner read kept the indicator indeterminate until it committed.
seven transport cases preserved native/late abort handling. no worker or provider
ran; later sync completion and desktop pull-indicator visibility were not qualified.
the six production owners lose 65 lines; generated wire and docs are excluded.

## Mobile Contract

Mobile workspace mode mounts exactly one active visible primary pane in the main
canvas. Non-active primary panes are not mounted as hidden mobile columns, and
desktop pane-strip controls are absent.

Mobile pane shells do not mount desktop resize handles, fixed primary chrome, or
desktop-attached secondary columns. Secondary content is presented by the
workspace mobile secondary sheet.

pane-local search is visit-local chrome, not pane history or workspace state.
only the active capable `PaneShell` consumes Cmd/Ctrl+F; inactive panes retain
their mounted query/result state, while source replacement retires it.
unsupported panes leave native browser find untouched. collection panes publish
one compact row in the body scrollport: their input and order stay visible;
applicable facets open a labelled editor, while applied chips and an honest
result status sit at the list boundary. reset appears only for changed state.
`Pane.Search` reveals, focuses and selects the active pane input; collection
menus have no duplicate search command.
page and note editors retain transient `FilterRows` over their direct ordered
items. document panes, including individual conversations, retain transient `Find`
(the pane's `useFind` controller) with transient Inspector results.

Every domain view is pane-URL state decoded by one strict, total owner codec.
An unknown, duplicate, partial, or redundantly-default owned key is `Invalid`:
the pane renders `Invalid {surface} view` with `Reset view` and makes no
collection request. Because a view change replaces the pane URL on the same
path, every refinement-capable route declares `queryNavigation: "in-place"` so
its body survives the replacement with its local text, focus, scroll, and
previously committed rows intact.

Nexus Root projects at most five open panes in stable workspace order and then
one direct `Manage tabs…` row. The dedicated Manage Tabs page renders all
primary panes, activates or restores an exact pane, closes panes without
dismissing, and exposes the workspace provider's bounded session-local
recently-closed stack. Recovery opens the same page with the exact retained
activation; direct Manage Tabs needs no retained activation. Mobile never
recreates the desktop pane strip or mounts inactive pane columns.
