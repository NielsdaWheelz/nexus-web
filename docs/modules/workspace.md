# Workspace Module

## Scope

The workspace module owns authenticated pane composition. It decides which
primary panes, desktop pane-strip controls, desktop canvas affordances,
desktop-attached secondary panes, fixed primary chrome, and mobile secondary
sheets are mounted.

Frontend owners live under `apps/web/src/components/workspace/*` and
`apps/web/src/lib/workspace/*`.

## Layout Modes

`WorkspaceHost` owns the workspace layout mode. Viewport classification comes
from the render environment path, but workspace composition policy is decided in
`WorkspaceHost`.

Desktop mode:

- renders the pane strip
- renders every visible/minimized primary pane in the horizontal canvas
- enables `usePaneCanvas` in desktop mode
- renders edge fades only from desktop canvas edge state
- allows desktop-attached secondary panes
- allows fixed primary chrome such as the reader Document Map overview rail
- mounts pane resize handles

Mobile mode:

- renders only the active visible primary pane in the main canvas
- disables desktop canvas measurement
- renders no edge fade DOM
- renders no pane strip
- renders no desktop-attached secondary pane column
- renders no fixed primary chrome
- renders no pane resize handle
- presents secondary content only through `MobileSecondaryPaneHost`
- presents global pane switching and recently closed restoration through the
  shell-mounted Nexus Switchboard

Mobile mode is not a narrow desktop canvas. It is a different composition
contract.

## Pane Canvas

`usePaneCanvas` owns desktop horizontal canvas measurement, wheel-to-horizontal
panning, header drag panning, in-view pane tracking, edge state, and
scrolling the active pane into view.

The hook accepts `mode: "desktop" | "disabled"`.

- `"desktop"` attaches listeners, observers, and measurement.
- `"disabled"` clears edge and in-view state, performs no measurement, and does
  not scroll panes into view.

Callers must not clear canvas state themselves. `WorkspaceHost` passes the mode
and renders edge fades only in desktop mode.

## Pane Headers and Primary Chrome

Every supported route declares one `PaneRouteHeaderContract`:

- `section` resolves the destination-owned standing head and an optional folio
- `resource` resolves a title plus structured credit groups

Pane bodies publish the orthogonal `{ header, toolbar, search, actions, menu,
refresh }`
capabilities through `usePanePrimaryChrome`. Each update carries the current
`routeKey`; `PaneShell` rejects stale updates before validating the header kind.
There is no route-level chrome descriptor, body-mode inference, or ambient title
override.

`refresh` publishes one source-fenced, abortable, awaitable owner operation.
`PaneShell` owns its menu action, mobile top-edge pull gesture, progress, and
announcement; the pane owner resolves only after its canonical first page is
installed. Only the six explicitly supported finite standard-scroll panes
publish it. Refresh never reloads the route or polls for completion.

`search` is one closed pane-local capability: `FilterRows` derives local primary
rows, while `FindOccurrences` delegates document matching and exact preview to
the format owner. `PaneShell` alone owns the shared Filter/Find header action,
expanded row, focus, and active-pane request consumption. `WorkspaceHost`
arbitrates bindable `Pane.Search` before the editable-target guard, so
Cmd/Ctrl+F reaches Page and Note editors; it prevents native Find only when the
active pane consumes the request. Cmd/Ctrl+K remains Nexus retrieval.

`menu` is an `ActionPublication`. Resource panes publish an explicit canonical
target and the four semantic groups `core | operations | relationships | view`;
non-resource panes use `FlatMenu`. `PaneShell` resolves current-pane core policy
from the resource target—Share and Chat, with Open remaining
representation-only—merges the published groups, and invokes
`composeResourceMenu` exactly once. Pane bodies never publish flat resource
arrays or duplicate core behavior. Share and promoted header actions project
from the universal resource-action catalog.

The three projections are fixed:

- desktop section header: 44px
- desktop resource header: 60px
- mobile top bar: 60px plus safe area

Desktop promoted actions render through `ActionBar`; overflow publications
render through `ActionMenu` in desktop and mobile chrome. Free-form `toolbar`
content is reserved for bounded format navigation such as PDF and EPUB
controls. It is not another action channel.

Each pane landmark is named from its resolved header. Resource identity owns its
`h1`; imported reader headings are projected beneath it, and pending resource
identity supplies an accessible loading name. The
route-scoped error boundary wraps runtime, chrome, body, and mobile secondary
composition so one pane failure cannot replace its siblings or the workspace.

### Mobile Reader Chrome

`MobileChromeProvider` is the sole mobile reader chrome policy owner.
`TextDocumentReader`, the `MediaPaneBody` transcript viewport, and `PdfReader`
register their actual scroll element through
`useMobileChromeReaderScrollport`. Exactly one active reader scrollport owns
native scroll, primary-pointer focus handoff, and blank-canvas reveal; window,
workspace, nested transcript segments, and non-reader pane scroll never
participate.

The provider reduces reader scroll to one normalized collapse progress. The app
top bar, optional active reader toolbar, and inner Nexus control consume that
progress in the same animation frame through compositor-only transforms. Top
chrome retreats upward and Nexus retreats downward. The untransformed outer
Nexus wrapper remains the fixed-obstruction measurement surface, so content
clearance, content offset, and reader `scrollTop` remain fixed. Downward scroll
collapses, upward scroll reveals after the direction dead zone, and idle partial
progress settles to the nearest endpoint.

The provider resets fully shown and rebaselines from live geometry when the
active `(paneId, routeKey)`, reader source, EPUB unit, layout generation, or
mobile mode changes. Programmatic positioning therefore cannot become the next
reading delta.

The provider pins chrome fully visible at the document top, for reduced motion,
and while reader restore, positioning, Find, selection, navigation,
secondary-surface, library-picker, menu, or chrome-focus locks are held.
`useMobileChromeVisibleLocks` is the only lock capability, and final release
rebaselines from the live scrollport. Enabled mobile surfaces register as
`AppBar`, `PaneToolbar`, or `NexusControl`; only the active pane toolbar
registers. Focus on a real control acquires `chrome-focus`; primary pointer
intent on the reader releases only that focus. Tracking, settling, and hidden
control clusters are inert and absent from accessibility navigation, while the
pane landmark remains represented. Desktop chrome is unaffected.

## Mobile Secondary Panes

`MobileSecondaryPaneHost` is the only workspace mobile secondary presentation.
It is modal sheet chrome, not a workspace column. It presents through the shared
`MobileSheet` primitive (`scrim="soft"`, `layer="overlay"`), which owns the
portal, scrim, grabber, keyboard avoidance, back-button dismissal, and the
`useDialogOverlay` modal contract. See `docs/modules/overlays.md`.
`MobileSecondaryPaneHost` owns only its header chrome, tab state, and surface
bodies.

Workspace secondary content can share the same surface bodies across desktop
and mobile, but the chrome owner differs:

- desktop: `SecondaryPaneShell`
- mobile: `MobileSecondaryPaneHost`

Pane Find results use the separately typed, route-keyed transient
`resource-search` surface in the existing `resource-inspector` group.
`WorkspaceHost` owns that activation outside `WorkspaceSecondaryState`: it
never enters workspace persistence, never changes the underlying durable
visibility or active tab, and is pruned on route replacement. Desktop keeps it
open while results preview; mobile hides the sheet after a successful exact
preview. Ending Find restores the prior durable presentation exactly. Selecting
a durable tab explicitly ends the transient presentation and selects that tab.
Transient-only publication is valid while active and renders without a durable
tab strip.

Standalone Artifact panes use that transient-only form directly. The active
accepted Dossier revision owns its opaque-frame Find capability; the Artifact
route publishes contextual results without `useResourceInspector`, a durable
Dossier tab, workspace persistence, or a second secondary group.

An expanded secondary region uses
`paneSecondaryRegionId(primaryPaneId, groupId)`. Disclosure actions expose that
id only while the region exists. Mobile open requests may carry the exact trigger
element as ephemeral focus state; the sheet focuses its active tab, returns to
that trigger on close, and falls back to the same pane's chrome if the trigger
disconnects.

Do not introduce another workspace mobile drawer or sheet owner.

## Browse And Preview Panes

Browse is a standard section pane at `/browse`; Preview is a standard resource
pane at `/browse/preview`. Both use `PaneShell` as their vertical scroll owner.
The Browse visit identity is the exact normalized `q`, `kind`, `source`, and
`sort` query. Its route-owned memento captures the committed section pages and
cursors together with focus and scroll, so Back restores the accepted snapshot
without refanning provider requests.

Preview identity is its sealed discovery target. It re-resolves provider truth
and publishes title/source credit plus an explicit acquisition action, but no
canonical resource target before acquisition. Open/reload/play/leave Preview
writes no Media, subscription, Library entry, job, progress, completion, or
activity fact. Successful Add or Subscribe replaces Preview with the canonical
owned pane after any eligible one-shot position transfer; failure leaves Preview
and its staged destination choices intact.

Browse and Preview intentionally publish no pane-local `FilterRows` or
`FindOccurrences` capability. Their own query, facets, section continuation,
and Preview episode list remain route/body-owned controls rather than a second
Pane Search implementation.

## Target Activation

The workspace owns cross-pane product-target activation through
`activateWorkspaceTarget`. Callers provide a supported href, semantic
disposition, optional label/secondary payload, and navigation modality; they
never choose a pane or invoke pane creation directly.

- `Follow`: activate and restore an exact route-key match; otherwise push the
  target in the origin pane.
- `Fork`: always create and activate a fresh pane immediately after the origin.
- `Adopt`: activate and restore an exact match; otherwise create after the
  origin. Only named workflows that must preserve their source use it.

Exact identity is route plus normalized query and ignores hash. With duplicate
exact panes, selection is origin first, then the first visible match, then the
first minimized match. A different hash pushes in the selected target pane;
query-distinct product targets remain distinct. Secondary activation is
delivered after pane selection and never changes disposition.

At the 12-pane cap, `Fork` or creating `Adopt` is rejected atomically with
non-modal feedback. The workspace never evicts another pane to satisfy target
activation.

Learn is one of the named Adopt workflows. It preserves the source reader and
opens `/artifacts/artifact:<id>` as a standalone resource pane after its durable
Highlight-to-Idea command succeeds. Artifact revision navigation is in-place:
`?revision=artifact_revision:<id>` changes the viewed revision without changing
the pane's Artifact resource identity or creating a duplicate pane.

Pane Find movement is reversible inspection, not pane navigation. Web,
transcript, and accepted Artifact previews write no pane href or history
entry. Their single **Go back to reading position** origin is ephemeral,
revision-bound presentation state retired by Return, source replacement, or
route exit.

`targetLinkActivation.ts` is the one browser gesture adapter. Plain click and
`Enter` are `Follow`; `Shift`+click is `Fork`; Meta/Ctrl/Alt, middle-click,
downloads, external links, `_blank`, fragments, and already-prevented events
remain browser- or route-owned. Anchors retain real hrefs. Route-local reader
location, sort/filter, and pagination controls keep their feature-owned
push/replace/no-write policy.

## Recently Closed Panes

`WorkspaceStoreProvider` owns a session-local, newest-first stack of at most
five valid closed-pane snapshots outside persisted `WorkspaceState`. A snapshot
contains the primary pane, its attached secondary pane when present, and its
former order index.

Close snapshots before removal, including close-last fallback. Restore is one
atomic workspace transition: reject before mutation at the pane cap, reject
duplicate primary or secondary identity as a defect, normalize secondary
attachment and parent identity, clamp current widths, make the restored pane
visible and active at the clamped former index, and reapply the per-pane and
global history budgets. Remove the snapshot only after successful restore.
Reload clears the stack.

## Mobile Viewport And Fixed Obstructions

`MobileViewportProvider` is the shell owner for safe-area, fixed Nexus control,
active MiniPlayer, root text-entry focus, and active `MobileSheet` keyboard
obstruction. One document focus observer recognizes only text-entry targets
outside modal layers. While root text entry owns focus, the mounted MiniPlayer
is hidden/inert and its `"Player"` obstruction is unregistered; playback
continues through system controls. Fixed controls register measured rectangles;
`MobileSheet` alone reports keyboard inset through scoped, ordered reports so
nested-sheet release restores the prior inset. The provider publishes
`--mobile-content-bottom-clearance`, and every authenticated mobile primary
scroll owner consumes it. Components do not independently recalculate safe
area, player, Nexus, focus, or keyboard geometry.

## Fixed Chrome

Fixed primary chrome is desktop-only. Pane bodies may publish fixed chrome, but
mobile workspace mode makes that publication inert for desktop fixed-chrome
rendering.

The reader Document Map overview rail is fixed primary chrome and remains
desktop-only. Its markers activate contextual targets; it contains no generic
Document Map opener.

## Pane History

Each primary pane owns one current `PaneVisit` and Back/Forward stacks of
visits. A visit is a canonical workspace href plus a unique UUID; duplicate
visits to the same href therefore retain independent presentation. The
workspace is the sole owner of `push`, `replace`, Back, and Forward mechanics.

- `push` records the exact current visit in Back, mints the target visit, and
  clears Forward.
- `replace` retains the current visit id and changes its href without changing
  either stack.
- Back and Forward traverse visit occurrences.
- A replace that consumes a target hash writes `pathname + search` — hash
  consumption always strips the hash from the href it stores.
- The workspace never infers push-versus-replace from URL shape or resource
  equality. Feature owners choose the operation for every navigation they
  perform; the workspace only executes it.
- Per-pane history is capped at 12 entries in each direction; the workspace
  holds at most 48 history entries across every pane combined. When a write
  exceeds either budget, Back trims its head and Forward trims its tail;
  non-active panes are trimmed before the active pane.

For every `ShellScroll` route, `PaneShell` is the one primary vertical
scrollport. `PaneReturnMementoProvider` keeps current-tab-only presentation
state keyed by visit id: raw position, semantic eye-line anchor, keyboard focus
anchor, and a bounded route-owned loaded-extent snapshot. Capture is synchronous
before a visit is displaced. Restore waits for the successful lazy body and the
route's committed async content, then restores semantic position before
clamping raw pixels. Reader, Chat transcripts, and Atlas keep their separate
scroll/location owners. Mementos and loaded extent are never persisted.

## Reader-To-Chat Launch Intent

A reader Highlight quote launches chat through a pane-local intent hash
`#mediaId=<uuid>&highlightId=<uuid>`, read only through `paneRuntime` pane-local
hash parameters (never ambient `window.location`). Before the send commits the
hash is reload/navigation safe and excluded from pane identity.

Reaching the destination uses canonical-pane adoption: the target chat pane is
reused or opened without duplication — desktop shows it adjacent, mobile
activates it while preserving the reader pane in the session — and source
activation returns to that reader pane. On a successful run the feature
route-`replace`s to consume the provisional history entry, so Back cannot
rehydrate a completed intent.
