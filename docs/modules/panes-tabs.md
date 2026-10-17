# Panes And Tabs

## Scope

primary panes are workspace-owned route containers. the desktop strip owns
switching and tab management; the store owns order, visibility and selection.

## Desktop Pane Strip

`WorkspacePaneStrip` renders one toolbar in workspace order, including minimized
panes. each chip has a title, more menu and close control; chips keep a 12 rem
minimum and overflow horizontally. one roving stop records the pane id and title
or menu control. active, in-view, focused and minimized are separate facts.

plain left/right wrap focus through every title; home/end reach the ends.
enter/space on a title activates, restores if needed, and enters pane content.
down, context-menu or shift+f10 open that item's menu. tab exits from the current
roving control; menu return keeps more as that stop. delete/backspace close once
per press, and shift+m toggles maximize once per press for the focused item.
global mod+shift+left/right retain the separate sequential traversal contract.
there are no global shift-letter commands.

`lib/workspace/paneActions.ts` supplies the strip and manage tabs with explicit
target commands: minimize/restore, move earlier/later, close. the strip adds
maximize/restore layout; [workspace](workspace.md#layout-modes) owns its geometry
and lifetime. disabled actions retain their explanations: keep one stored-visible
pane, or already first/last. menu management retains strip focus, unless a new
companion sheet takes modal focus. close selects the next surviving title, else
the previous, independent of the store's active-pane successor. focused chips
reveal only inside the strip.

reorder uses the existing dnd-kit mouse and touch sensors from the title alone:
8 px mouse activation, or 250 ms touch hold with 8 px tolerance. unactivated
touch keeps native strip scrolling. the drag overlay is decorative; only the
strip autoscrolls. outside drop, escape, changed pane membership/order, strip
unmount or another interaction owner prevents a commit. a native release guard
survives sensor retirement and consumes that drag's trusted click without taking
the next gesture. drag start focuses the source; completion repairs lost focus
without overriding another interaction owner.

`@dnd-kit/core` is pinned to `6.3.1` with an install-applied bun patch: a fresh
pointer press retires the previous sensor's document blockers and cleanup timer.
drag end retires keydown and selectionchange synchronously; an expired drag
cannot clear the textarea selection react restored after keyed placement.
the library retains its ordinary release suppression. the strip separately
consumes its actual delayed release after escape or unmount; neither path
blocks a new gesture. sortable and utilities remain direct dependencies.
upgrading core requires reviewing the patch in all three published bundles;
keep it until the library supplies the same listener-lifetime guarantees.

`store.movePane({paneId, beforePaneId})` is the only reorder writer; null appends.
it preserves pane objects, activation, visits and histories, returns false for
missing/self/unchanged moves, and commits one changed array. a changed move
announces its position. move commands provide the keyboard and touch alternative
to dragging; there is no keyboard pickup mode.

## Sequential Traversal

Across all viewport modes, sequential traversal follows stored-visible panes in
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
result lands only where it was asked for. `useServerValue` and `useServerList` own fetch identity and retries. A
collection pane's refresh awaits its list's `refetch()`, which settles when the
reread commits or fails (architecture §8.12).

podcast refresh is [durable admission](jobs.md#podcast-live-sync-and-backfill).
`lib/podcasts/api.ts` owns one typed `requestPodcastRefresh` command returning
the selected-subscription count and announced as `Refresh requested for n
show(s)`, or `Nothing to refresh` at zero. the podcast index and detail settle
their refresh on admission (`podcastRefresh` in `lib/podcasts/paneState.ts`):
the command publishes `Podcasts` and the panes reread through it a moment
later. the library detail keeps admission followed by its matching reload and
retry. Complete describes the admitted command, never provider sync completion.
the RefreshPodcast resource action posts the same command and opens no pane; an
open detail pane converges through `Podcasts` and its subscription stream.
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

pane-local controls are source-local chrome. identity, reader navigation and
queries compose independently above the content scrollport. supported desktop
fields remain visible; mobile find discloses alongside navigation and clears on
close. only the active capable pane consumes cmd/ctrl+f; overlays win and native
find remains available for unsupported/resolving panes. source replacement
retires query lifetime; active-pane resizing preserves it. inactive panes
unmounted on mobile retain their existing reset behavior.

collections and page/note rows publish the shared query toolbar with inline
native filter choices. find publishers supply `useFind` controllers and
transient companion results. domains own urls, query timing, results and clear/
reset semantics. see [workspace controls](workspace.md) for the capability,
geometry and keyboard contract.

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

nexus root projects at most five open panes in stable workspace order and then
one direct `Manage tabs…` row. manage tabs renders all primary panes and the
five-entry session-local recently-closed stack. activation enters an exact pane;
minimize, restore, move and close keep the task open, including active and final
close. close repairs focus to a surviving row action. the task
tracks the committed pane/visit selection, so its own changes do not dismiss it.
mobile uses this same management vocabulary and never mounts the desktop strip
or inactive columns. pane count has no cap; history and recently-closed bounds
remain owned by [workspace](workspace.md#persisted-workspace-sessions).
