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
  shell-mounted full-screen Nexus task and its dedicated Manage Tabs page

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

- `Section` declares its owning destination plus
  `context: "None" | "Destination"`, which decides whether that destination
  label appears beside the title
- `Resource` declares the pending label its identity carries until the body
  resolves

The pane runtime label is the only title value for both kinds. Bodies publish a
typed `PaneHeaderMeta` — `None`, `Pending`, `Count`, or `Date` — for section
routes, or a typed `Ready`/`Unavailable`/`Failed` resource status with its
structured credit groups. No publication carries a title.

Pane bodies publish the orthogonal
`{ header, search, instrument, actions, resourceTarget, viewMenu, refresh, filters }`
capabilities through `usePanePrimaryChrome`. Each update carries the current
`routeKey`; `PaneShell` rejects stale updates before validating the header kind.
There is no route-level chrome descriptor, body-mode inference, or ambient title
override.

`refresh` publishes one source-fenced, abortable, awaitable owner operation.
`PaneShell` renders the canonical `ResourceActionMenu` and owns the refresh
control's mobile top-edge pull gesture, progress, and announcement; the pane
owner resolves only after its canonical first page is installed. Only the six explicitly supported finite standard-scroll panes
publish it. Refresh never reloads the route or polls for completion.

`search` is one closed pane-local capability: `FilterRows` derives local primary
rows, while `FindOccurrences` delegates document matching and exact preview to
the format owner. `PaneShell` alone owns the shared Filter/Find header action,
expanded row, focus, and active-pane request consumption. `WorkspaceHost`
arbitrates bindable `Pane.Search` before the editable-target guard, so
Cmd/Ctrl+F reaches Page and Note editors; it prevents native Find only when the
active pane consumes the request. Cmd/Ctrl+K remains Nexus retrieval.
If the live browser viewport leads React during a responsive host replacement,
the arbiter carries one pane-and-route-fenced Search handoff; the incoming
`PaneShell` acknowledges it only after its current publication is ready.

A `FilterRows` producer publishes its domain View/Filter/Sort controls as
`publication.filters`, ending with `Clear filters`, and reports
`activeDomainControlCount` — the number of controls differing from that
surface's canonical default, excluding the local query. `PaneShell` renders the
collapsed marker and the accessible label **Filter, N control(s) active** from
that count. The local query lives in `usePaneFilterRows`, keyed on a source key
that must never embed the domain view: a view change replaces the pane URL on
the same path, and the local text, the expanded row, and the focused native
control all have to survive it. Every refinement-capable route therefore
declares `queryNavigation: "in-place"` so its body is not remounted by the
replacement, and `usePaneScrollRetention` restores the scrollport once the new
view commits.

A resource pane publishes only its canonical `resourceTarget`
(`ResourceActionSubject`); `PaneShell` renders the one canonical
`ResourceActionMenu` for it, identical to every other surface
(`canonical-resource-action-menu-hard-cutover.md`). Membership, current verb,
order, and danger-last come from the server action snapshot and the pure planner,
so the pane menu includes `Open` (it is no longer projection-dropped for the
already-open pane). Pane view/session controls (reader settings, add-content,
date navigation) publish through a separate non-resource `viewMenu`; pane refresh
and route-share are dedicated header controls. Pane bodies never build resource
action arrays.

Every primary identity projection uses one 60px track. The mobile safe area is
additive.

Desktop promoted actions render through `ActionBar`; overflow publications
render through `ActionMenu` in desktop and mobile chrome. PDF and EPUB publish
one labelled `instrument` containing control content only. `PaneShell` owns its
40px desktop or 48px mobile contextual frame and renders it as an accessible
group. Expanded Search takes exclusive occupancy of that same track.

`PaneHeaderIdentity` owns the single route-level `h1` for every pane kind. Body
outlines start at `h2`, and imported reader headings are projected beneath the
chrome heading. Each pane landmark is named from the exact title plus its
optional context, never from a count or date, and pending identity is marked
`aria-busy` while keeping a non-empty accessible name. `WorkspaceHost` projects
the active pane's label as the browser document title `Title · Nexus` and
restores `Nexus` when no active pane exists; inactive panes never write it. The
route-scoped error boundary wraps runtime, chrome, body, and mobile secondary
composition so one pane failure cannot replace its siblings or the workspace.

### Mobile Reader Chrome

`MobileChromeProvider` is the sole mobile reader chrome policy owner.
`TextDocumentReader`, the `MediaPaneBody` transcript viewport, and `PdfReader`
register their actual scroll element through
`useMobileChromeReaderScrollport`. Exactly one active reader scrollport owns
native scroll sampling and blank-canvas reveal. One stable active-reader
interaction root owns primary-pointer focus handoff even while the scrollport
is loading, short, or being replaced. Window, workspace, nested transcript
segments, and non-reader pane scroll never participate.

The provider reduces reader scroll to one normalized collapse progress. The app
top bar, optional active contextual row, and inner Nexus control consume that
progress in the same animation frame through compositor-only transforms. Top
chrome retreats upward and Nexus retreats downward. The untransformed outer
Nexus wrapper remains the registered `"Nexus"` bottom-surface measurement
surface, so content clearance, content offset, and reader `scrollTop` remain
fixed. Downward scroll
collapses, upward scroll reveals after the direction dead zone, and idle partial
progress settles to the nearest endpoint.
Phase, inertness, and accessibility state commit before collapse motion. A new
reader sample interrupts settlement by sampling once, cancelling every owned
collapse transition, freezing all three surfaces at that progress, and fencing
stale completion events.

The provider resets fully shown when the active `(paneId, routeKey)`, semantic
reader source, EPUB unit, or mobile mode changes. Reflow, lazy media, zoom,
IME, rotation, and safe-area changes retain that source identity and only
rebaseline live geometry. App-owned reader positioning passes through the
single locked `paneScroll.ts` boundary, so a programmatic jump cannot become
the next reading delta.

The provider pins chrome fully visible at the document top, for reduced motion,
and while reader restore, positioning, Find, selection, navigation,
secondary-surface, library-picker, menu, or chrome-focus locks are held.
`useMobileChromeVisibleLocks` is the only lock capability, and final release
rebaselines from the live scrollport. Enabled mobile surfaces register as
`AppBar`, `PaneToolbar`, or `NexusControl`; `PaneToolbar` remains the
internal motion-role name for the active pane's effective contextual row.
Focus on a real control acquires `chrome-focus`; primary pointer
intent on the reader releases only that focus. Tracking, settling, and hidden
moving roots are inert, non-hit-testable, and absent from accessibility
navigation, while the pane landmark remains represented. Desktop chrome is
unaffected.

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

Preview identity is its sealed discovery target. It re-resolves provider truth,
sets its exact title as the pane label, and publishes a source credit plus an
explicit acquisition action, but no
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

Accepted activation may carry one pane-entry delivery addressed to the chosen
`paneId` plus its current `visitId`. Lazy body mounting queues that delivery
until the visit subscribes; an already-mounted visit receives it immediately.
Each AppendNote delivery carries its initial text and replay-safe note and
client-mutation identities. Each activation ID is consumed once for the
workspace-provider lifetime. A
visit holds at most one unclaimed delivery: a newer accepted entry explicitly
supersedes it, while View cancels it. Acknowledgement names the exact claimed
delivery, so a stale acknowledgement cannot clear its replacement. Rejected,
closed, or `ActivationBlocked` activation leaves no ambient intent for a later
pane.

The planner derives `daily:{localDate}` and `page:{pageId}` aliases from their
routes and unions them with aliases published by Page panes. Quick Note,
query-seeded Add to Today, and
ordinary Page opens therefore reuse an open `/pages/{pageId}` daily pane or
`/daily/{localDate}` pane and deliver append to that exact visit. The daily
surface owner appends seed text to an appendable draft and rejects a seeded
atomic draft before navigation. A latent
daily visit adopts its returned persistence ref without replacing the visit
href or mount identity.

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

## Mobile Viewport And Bottom Geometry

`globals.css` is the sole raw platform-inset adapter. It maps WebView's four
CSS safe-area values to `--viewport-safe-{top,right,bottom,left}`, and
`readMobileCssLength` is the single browser boundary that resolves one of those
published tokens to CSS pixels when JavaScript needs a number.

`MobileViewportProvider` owns two registration kinds. Id-keyed bottom surfaces
register through `registerBottomSurface("Nexus" | "Player", element)`: the
fixed Nexus wrapper and the normal-flow MiniPlayer. Each active mobile pane
body registers through `registerContentSurface(element)`, so several content
surfaces may be registered while several mobile panes are mounted. Duplicate
active registration of either kind is a defect, and every cleanup is
idempotent, disconnects its observer, removes the element-local variable, and
recomputes immediately. `useMobileModalLifecycle` reports active sheet or
full-screen-task keyboard insets through scoped, ordered reports, so releasing
the newest modal restores the preceding report. Inactive mounted overlays
publish nothing. One document focus observer recognizes only text-entry targets
outside modal layers. While root text entry owns focus, the mounted MiniPlayer
is hidden/inert and its `"Player"` bottom surface is unregistered; playback
continues through system controls.

Geometry resolves in one ordered measurement pass, because each rectangle can
only be measured after the write it depends on. The pass resolves the Nexus
bottom offset from the safe bottom and the Player rectangle and writes root
`--mobile-nexus-bottom-offset`; then measures the placed Nexus wrapper and
writes root `--mobile-content-bottom-clearance` — the maximum of safe bottom,
the Nexus band, and the active overlay keyboard inset — alongside root
`--mobile-overlay-keyboard-inset`; then projects that protected band into each
registered content surface's local bottom coordinate and writes an
element-local `--mobile-content-bottom-clearance` on that element.
`ResizeObserver`, `window.resize`, and top-level `visualViewport`
resize/scroll share one animation-frame-coalesced path.

The MiniPlayer stays normal flow. It is a bottom surface that only places
Nexus and is never added to content clearance: its flow layout already shortens
every surface above it, and the Nexus rectangle resting on it carries the whole
protected band, so the Player is counted exactly once.

The fixed Nexus wrapper consumes root `--mobile-nexus-bottom-offset` plus its
gap. Terminal scroll content consumes `--mobile-content-bottom-clearance` from
its nearest owner: full-window consumers inherit the root value, while every
scroll owner nested inside an active mobile pane body — reader document
viewport, PDF viewer, chat surface, and standard pane bodies — inherits the
element-local value published on `PaneShell`'s registered `.body`, with no
per-consumer subtraction. Components do not read raw safe-area values or
independently recalculate platform, Player, Nexus, focus, or keyboard geometry.

The Android shell remains edge-to-edge. `MainActivity` enables the platform
edge-to-edge policy before creation, keeps the WebView at full window bounds,
and returns the original `WindowInsets` unconsumed so System WebView M144+ can
publish `systemBars | displayCutout` to CSS. A black,
accessibility-hidden native overlay covers exactly the combined top inset;
system-bar icons remain light, and Android owns three-button navigation
contrast. Android instrumentation owns the real-WebView native-to-CSS inset,
top-protection, icon, full-window-bound, safe-control, and stale-value-clearing
contracts. For native inset `N`, CSS inset `C`, and positive device-pixel ratio
`D`, the permanent quantization contract is exact zero after native clearing;
otherwise `N <= C * D < N + D`. CSS never under-covers native system UI and
adds less than one CSS pixel of safe clearance.

## Fixed Chrome

Fixed primary chrome is desktop-only. Pane bodies may publish fixed chrome, but
mobile workspace mode makes that publication inert for desktop fixed-chrome
rendering.

The passive mobile reader position ribbon does not participate in fixed primary
chrome. It remains reader-relative, uses the reader-owned semantic range, and
paints at the reader surface bottom (`bottom: 0`). It consumes no bottom
clearance and does not rise above Nexus, Player, or Android navigation; a
higher-priority surface may cover it. See the
[mobile ribbon cutover](../cutovers/mobile-reader-position-ribbon-hard-cutover.md)
for its semantic range, and the
[bottom geometry cutover](../cutovers/mobile-reader-bottom-geometry-hard-cutover.md)
for its placement.

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
