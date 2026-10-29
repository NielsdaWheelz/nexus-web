# panes

## Scope

primary panes are workspace-owned route containers. the desktop strip owns
switching and pane management; the store owns order, visibility and selection.
pane names the workspace object, its strip chip and its management; tab means
only a browser tab, an aria tab/tablist (inspector tabs, `ui/Tabs`) or the Tab
key.

## Desktop Pane Strip

`WorkspacePaneStrip` renders one toolbar in workspace order, including minimized
panes. each chip has a title and three stable control slots: visibility, layout,
close. active, in-view, focused and minimized are separate facts. there is no chip
menu. [visual system](visual-system.md#workspace-strip) owns target geometry.

plain left/right wrap focus through every title and control; home/end reach the
ends. one roving stop records pane id and slot. ordinary title activation selects
and unminimizes that exact pane, then enters its content within the current
viewing mode. shift-click or shift-enter forks its current visit into a fresh pane
immediately after it, preserving the clicked pane even when inactive or minimized.
there is no touch-duplication control.
tab exits the toolbar. delete/backspace close once per press, and shift+m toggles
maximize once per press for the focused pane. repeated or composing enter/space
cannot dispatch management again or activate a changing slot.
global mod+shift+left/right retain the separate sequential traversal contract.
there are no global shift-letter commands.

`lib/workspace/paneControls.ts` projects ordered slots, commands, icons, accessible
names, help and disabled reasons from live workspace state, the resolved title,
desktop mode. the strip renders shared
`Button` controls and dispatch through their command owners. keys and refs use
stable slots; a glyph change retains the focused node.

ordinary desktop panes offer minimize/maximize/close. minimized panes offer
restore-canvas/maximize/close. the active maximized pane offers
minimize/restore-canvas/close. restore-canvas selects and unminimizes its target
and exits maximize; title activation preserves that mode. last stored-visible
minimize is focusable, inert and explains `keep at least one pane visible`.
[workspace](workspace.md#layout-modes) owns mode, geometry and lifetime.

management focuses its invoking button before dispatch and retains it, unless a
companion sheet takes modal focus. accepted close focuses the next surviving
title, else the previous or replacement; refused close retains the initiator.
focused chips reveal only inside the strip, never under a held pointer.

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
window blur cancels pending and active pointer sensors through their normal cancel path.
each sensor exposes cancellation; the creating drag context cancels its sensor
on unmount, including pending activation and delayed keyboard listener attachment.
`useDndContext().cancel()` retires the same sensor without remounting rows or
their scrollport. nexus uses this for task-owned cancellation.
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
announces its position. the strip offers drag; nexus supplies the equivalent
keyboard and click/tap placement operation over that same complete pane order.

## history

header back/forward use the shared gesture classifier and an explicit store
disposition. ordinary activation traverses; shifted activation opens the exact
adjacent visit in a fresh pane. history forking is gesture-only (see
[workspace](workspace.md#target-activation)). each tooltip names the adjacent
visit's presentation `name`, truncated to 60 code points:
`back to {name} · NEW_PANE_HINT` (forward alike), or the hint alone while that
name is null. accessible names stay stable.

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

mobile nexus opens to a keyboard-down workspace overview with up to three visible
panes around current. desktop previews the first five panes. `expand` reveals all
panes, including minimized, in workspace order inside the existing scrollport;
`collapse` restores the preview. omit disclosure when nothing is hidden. disclosure
state lasts through same-opening search/page visits and responsive handoff, and
resets on explicit reopening. mobile search retains its query on return to overview;
the presented collection, not query emptiness, determines reorder eligibility.

the row body opens/restores its exact pane; only the independent × closes it.
closing keeps nexus open and adopts the store's committed successor, including
final-pane replacement. focus follows the next displayed row, else previous or
replacement, independently of workspace activation; refused close retains its
initiator. recently closed is a separate inline disclosure over the store's five
session-local records. reopening restores navigation and activates; it does not
recover discarded writing. its native controls use tab order, outside query candidates.

complete pane projections with at least two panes permit whole-body drag, excluding
×. truncated/ranked search projections cannot reorder. the nexus gesture owner
shares one snapshot-checked commit for drag and numbered placement, calling
`movePane` once. mouse uses 8px; touch uses 250ms hold/8px tolerance and keeps native
scrolling before activation. only the nexus scrollport autoscrolls. the preview
is decorative and modal-contained; the release guard prevents subsequent activation.

`reorder` chooses a source, then a final numbered position; each placement returns
to normal opening behavior, including no-op placement. keyboard navigation uses
the existing desktop combobox/grid or mobile native buttons. current pane,
keyboard highlight and moving source remain distinct. query editing/composition,
ineligible presentation, changed captured ids/order, shell replacement, window
focus loss or ownership loss cancels; element blur/tab traversal does not.
the first task-owned escape/back/scrim dismissal cancels; explicit close/done
cancels then dismisses. only changed moves announce success. no new persistence
or order revision is introduced. mobile offers no minimize/layout command and
never mounts a desktop strip or inactive columns.
