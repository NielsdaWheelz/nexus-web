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

Across all viewport modes, sequential traversal follows visible panes in
`state.panes` order, skips minimized panes, clamps at the first and last visible
pane, and never wraps. The workspace store is its sole owner, and the
`pane-next` / `pane-previous` keybindings invoke that store command on every
viewport. Mobile additionally maps a primary-touch horizontal swipe on the
Nexus control to the same command. No input restores, creates, reorders, or ranks
panes.

## refresh

`usePaneRefresh` owns the refresh command, gesture, indicator and settled
announcement. One execution runs at a time; it belongs to the fence (route and
the publication's source key) that started it, and a new fence aborts it, so a
result lands only where it was asked for. `useResource` owns fetch identity and retries. Collection
panes use `useRevalidationSettlement` to own one pending promise and its abort
listener. Each pane keeps its source checks, committed-result marker, and
cancellation restoration; it resolves the promise only after its matching
result is committed. The settlement helper owns no data, fetch, or commit effect.

podcast refresh is [durable admission](jobs.md#podcast-live-sync-and-backfill).
`lib/podcasts/api.ts` owns one typed `requestPodcastRefresh` command returning
the selected-subscription count and announced as `Refresh requested for n
show(s)`, or `Nothing to refresh` at zero. the podcast index and detail settle
their refresh on admission (`podcastRefresh` in `lib/podcasts/paneState.ts`):
the command bumps the podcast revision and the panes refetch through it a moment
later. the library detail keeps admission followed by its matching reload and
retry. Complete describes the admitted command, never provider sync completion.
the RefreshPodcast resource action posts the same command and opens no pane; an
open detail pane converges through the revision and its subscription stream.
shared pane source fencing, progress and lifecycle remain owned by
`usePaneRefresh`.

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

Every domain view is pane-URL state. Most are decoded by one strict, total
owner codec: an unknown, duplicate, partial, or redundantly-default owned key is
`Invalid`, and the pane renders `Invalid {surface} view` with `Reset view` and
makes no collection request. The podcast and browse panes pass their params to
the API instead and render its 400 as a notice with `Reset view` (browse:
`Reset Browse`); browse keeps only the mapping of `kind`/`source` onto its
planned sections ([podcast](podcast.md)). Because a view change replaces the pane URL on the same
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
