# Workspace Module

## Scope

The workspace module owns authenticated pane composition. It decides which
primary panes, desktop pane-strip controls, desktop canvas affordances,
desktop-attached secondary panes, fixed primary chrome, and mobile secondary
sheets are mounted.

Frontend owners live under `apps/web/src/components/workspace/*` and
`apps/web/src/lib/workspace/*`.

## persisted workspace sessions

the workspace is four modules: routes
([`paneRouteModel.ts`](../../apps/web/src/lib/panes/paneRouteModel.ts), the only
url → pane-kind table, deriving routeKey, resource locator and mount key in one
resolver), state ([`model.ts`](../../apps/web/src/lib/workspace/model.ts), the
api's own type plus entry and pane moves), the store
([`store.tsx`](../../apps/web/src/lib/workspace/store.tsx), one external store
whose commands apply synchronously) and the return memento
([`paneReturnMemento.tsx`](../../apps/web/src/lib/workspace/paneReturnMemento.tsx)).

durable state is one json object per authenticated user/device pair:
`WorkspaceState = {activePrimaryPaneId, panes}`. panes are one ordered array;
each pane is `{id, currentVisit, primaryWidthPx, visibility, history:{back,
forward}, secondary}` with its inspector embedded. `primaryWidthPx: null` means
"the reader column": such a pane follows the column when the reader font or
column changes, and only a user resize stores a number. labels, recently closed,
mementos, visit data, the transient inspector and daily-page publications are
not persisted.

python owns the shape and validates every save and every stored read
([schema](../../python/nexus/schemas/workspace_session.py),
[service](../../python/nexus/services/workspace_sessions.py)): structure and
bounds (1..12 panes, back + forward ≤ 12 per pane, ≤ 48 history in all, ids ≤ 64,
hrefs `^/` and not `//`, ≤ 4096), unique pane and visit ids, an active pane that
is visible, and an inspector surface inside its group. the web has no decoder:
its state type is the generated `Schema<"WorkspaceState-Output">`. only a missing
row is absent. invalid present state raises `500 E_INTERNAL` and remains intact;
entry cannot install a default store over it.
which inspector group a route offers is the web's rule, applied on every write.

`GET /me/workspace-session` returns
`Data[WorkspaceSessionsOut]` = `{data:{own, most_recent_elsewhere}}`, each a
`WorkspaceState` or null; elsewhere is the same user's newest other-device row
(`updated_at DESC, id DESC`). `PUT /me/workspace-session` takes a
`WorkspaceState` body and answers 204 (last write wins); a model violation is
400 `E_INVALID_REQUEST`. the device is `X-Nexus-Device`, which only the bff and
`callFastAPI` stamp from the server-owned httpOnly `nx_device` cookie, so a
client cannot name one; without it the api answers 400.

[`bootstrap.server.ts`](../../apps/web/src/lib/workspace/bootstrap.server.ts)
reads the account, reader profile and sessions concurrently on the normal 30 s
deadline (all required: a failure is the workspace error region, never a
fabricated default that could autosave over an unread session). `enterWorkspace`
picks own-if-nontrivial, else elsewhere-if-nontrivial, else one Lectern pane, and
merges a deep link: `/` and non-canonical request paths resume; bare `/daily` is
today in the account zone; any other path reuses the pane on its routeKey or
resource (keeping its visit id, width and inspector) or is appended, keeping the
newest 11 at the cap. entry awaits only the guaranteed visible active pane's
first-paint reads (`paneSeeds`), with the existing 500 ms per-request deadline,
seeded by that pane's id under the api paths its hooks read. named transport
failures and route-specific missing resources use normal client reads; other seed
errors terminate. inactive panes load through their existing owners. the
authenticated group has one optional catch-all page (`[[...path]]/page.tsx`), so
unknown paths render unsupported panes.

required-data transport failures (`E_NETWORK`, `E_UPSTREAM`,
`E_UPSTREAM_TIMEOUT`, `E_AUTH_UNAVAILABLE`) are classified before react serializes
errors. cold failures mount no store and offer document reload. other failures,
including malformed json, unknown codes and bootstrap 401, are logged terminal
containment without retry. only a missing stored row is null; invalid state returns
`500 E_INTERNAL` without modifying its row or timestamp.

`WorkspaceEntry` captures the first successful initializer for one verified viewer.
a modeled later data reread failure retains the exact shell/store/reader/seeds and
publishes "workspace update wasn’t confirmed" with one guarded `router.refresh()`
action. success clears the notice without replacing live state; its focused action
hands focus to the current pane before removal. viewer change discards the subtree.
identity-gate failure still uses manual session recovery. local room selection
writes its browser cookie without an authenticated request or refresh.

[`useWorkspaceSession.ts`](../../apps/web/src/lib/workspace/useWorkspaceSession.ts)
saves 1 s after the state last changed identity; the initial state counts as
unsaved, so every page load saves once. one request is in flight; a newer state
requested meanwhile is sent when it settles (keepalive if any request asked), and
a success acknowledges exactly the state it sent. pagehide and hidden flush with
keepalive (best effort for states over the browser's 64 KiB keepalive budget).
network, upstream, upstream-timeout and auth-dependency failures publish one
persistent "Workspace save wasn’t confirmed" notice with Retry; 401 goes to
login; anything else is a defect thrown into the workspace boundary.

the address bar names the active pane. the store projects it with next's patched
`history.replaceState(null, "", href)`, so next's router url follows and a server
action or refresh cannot revert it. next installs that patch in a passive effect
that runs after the first commit's layout effects; the first projection then
writes the entry directly and projects again on the next frame. a location hash
(cold load, `hashchange`, `popstate`) is folded into the active pane only when
the location's path and search equal the pane's; an entry for another path
(browser Back onto a fragment entry) is re-projected to the active pane.

## Layout Modes

`WorkspaceHost` owns the workspace layout mode. Viewport classification comes
from the render environment path, but workspace composition policy is decided in
`WorkspaceHost`.

Desktop mode:

- renders the pane strip
- renders every visible/minimized primary pane in the horizontal canvas
- enables `usePaneCanvas` in desktop mode
- renders edge fades only from desktop canvas edge state
- renders each pane's Companion as a resizable column inside the pane
- applies a reader's published layout (a pdf's intrinsic width, the Document
  Map overview rail)
- mounts pane resize handles

Mobile mode:

- renders only the active visible primary pane in the main canvas
- disables desktop canvas measurement
- renders no edge fade DOM
- renders no pane strip
- renders no Companion column and ignores published reader layout
- renders no pane resize handle
- presents the Companion only as a sheet (the same `Companion`)
- presents sequential adjacent pane switching through a primary-touch
  horizontal swipe on the Nexus control
- presents random pane access, recently closed restoration, and minimized-pane
  restore through the shell-mounted full-screen Nexus task and its dedicated
  Manage Tabs page

Mobile mode is not a narrow desktop canvas. It is a different composition
contract.

The workspace store is the sole owner of sequential traversal. It follows
visible panes in strip order, clamps at the first and last pane,
and never wraps. The Nexus swipe and `pane-next` / `pane-previous` keybindings
invoke that same store command.

## Pane Resource Identity

a pane's resource is its route's own locator (`resource_ref` or
`contributor_handle`), resolved synchronously by `resolvePaneRouteModel`; the
runtime's `resourceRef` is that ref (null for authors and routes naming no
resource). nothing resolves locators for open panes: the author body takes its
contributor ref from the author it loaded, and a pane for deleted media shows the
body's own not-found. editors that open a typed link resolve it with
`resolveResourceItem` (`lib/resources/items.ts`, `GET /resource-items/{ref}`).

## Pane Canvas

`usePaneCanvas` owns desktop horizontal canvas measurement, wheel-to-horizontal
panning, header drag panning, in-view pane tracking, edge state, and
scrolling the active pane into view.

activation centers instantly and holds that pane
through actual layout growth. a changed pane position/width or canvas width
re-exposes it instantly using nearest native alignment; observer setup and
scroll events alone never re-aim. a pane that fits must remain fully visible;
oversized panes use native alignment/clamping. sibling observer rebinds retain
the target; removal, disable and unmount clear it.
activation has no smooth transition; browser animation must not outlive the
layout it targeted.

deliberate horizontal canvas pan releases the target, including wheel, header
drag, its native scrollbar gutter, unhandled horizontal keys and horizontal touch. inner
horizontal scrolling and vertical reading do not. key classification runs after
react handlers. no gesture prevention or custom touch scrolling is added.

The hook takes `enabled` (desktop). Enabled, one `ResizeObserver` watches the
canvas and every pane wrap, so the edge fades follow a pane that resizes,
minimizes, restores or opens its Companion as well as canvas scroll and resize;
one `IntersectionObserver` tints in-view strip tabs. Disabled (mobile), it
measures nothing, reports no edges or in-view panes and scrolls nothing.

## Pane Headers and Primary Chrome

Every supported route declares one `PaneRouteHeaderContract`:

- `Section` declares its owning destination plus
  `context: "None" | "Destination"`, which decides whether that destination
  label appears beside the title
- `Resource` declares the pending label its identity carries until the body
  resolves

The pane runtime label is the only title value for both kinds. Bodies publish a
typed `PaneHeaderMeta` — `None`, `Pending`, or `Count` — for section routes, or
a typed `Ready`/`Unavailable`/`Failed` resource status with its structured
credit groups. No publication carries a title. The route decides the header
kind; a publication of the other kind is ignored. Counts are whole rows and
credit groups are non-empty by their single producers; nothing re-validates
them.

A body contributes to its shell by rendering, into a store that `PaneShell`
creates for that mounted body (`lib/panes/paneChrome.tsx`), through three hooks:
`usePaneChrome` (`{ header, navigation, query, menuActions, resourceRef,
refresh }` with independent navigation and query capabilities),
`usePaneCompanion` (the Companion's tabs and default) and `usePaneLayout` (a
reader's intrinsic width and rail). Each writes its slot in a layout effect and
clears its own value as it unmounts; the shell subscribes in a layout effect
and so re-renders before paint. The body's mount is the publication and its
unmount the withdrawal: there are no route or source keys, registries, prunes
or equality checks. The last writer of a slot wins (the exclusive publishers,
`PagePaneBody` and the imports list, hand over within one commit). The store
lives exactly as long as the body: when the body remounts (`paneMountKey`
changes) `PaneShell` creates a fresh store in the same render, so the new route
never shows the previous body's chrome, even while the new body suspends (a
React commit that holds a suspended lazy body can delay the shell's follow-up
render past a paint). A body that stays mounted across an in-place navigation
republishes in the same commit. Find's results and the Companion's return
focus live in the store too, so they end with the body. A body that passes a fresh object
republishes on every render and re-renders only the shell; hot publishers
(media, `Conversation`) memoize theirs.
There is no route-level chrome descriptor, body-mode inference, or ambient title
override.

`refresh` publishes one source-fenced, abortable, awaitable owner operation.
`PaneShell` owns the refresh descriptor, mobile top-edge pull gesture, progress,
and announcement; both activation paths invoke the same fenced operation. The
pane owner resolves only after its canonical first page is installed. Only the
six explicitly supported finite standard-scroll panes publish it. Refresh never
reloads the route or polls for completion, and the gesture is never its only
path.

`PaneShell` composes identity, supported navigation and supported query above
its existing content scrollport (`auto minmax(0, 1fr)`). controls stay stationary;
readers keep their own document viewport and collection return anchors stay in
`.routeContent`. canvas dragging begins only in the identity header's
noninteractive region. controls and option labels never drag the canvas.

`query` is `Controls {label, content, focusInput}` or `Find {find}`. absent means
unsupported; null find means a promised source is not ready. desktop renders
every supported field, including a disabled resolving find field. mobile keeps
ordinary collection/page/note controls visible; find starts collapsed, coexists
with navigation when opened, and closes by clearing text and collapsing. only
active, visible mobile find holds chrome. navigation/find disclosure and empty
focused inputs survive an active-pane breakpoint change; source retirement
ends disclosure and transient companion results.

`PaneQueryToolbar` owns presentation: input/clear, optional submit/match actions,
inline options disclosure and native sort. optional status declares `Inline` or
`Details` placement; inline feedback shares the actions group. chips, details,
errors, applied/draft mismatch, reset and expanded options share one bounded
refinement region, capped by the shell's declared geometry contract. empty
details are hidden without layout or tab footprint; mounted options retain
their drafts. checkboxes represent booleans/sets; uniquely named radio groups
represent singular choices. domains own options, draft/applied text, timing,
results, urls and reset. clear removes draft AND applied text while retaining
facets/order; browse immediately returns to its empty-query state. an aborted
response cannot publish as current. browse labels its provider-scoped control
“youtube sort”; other sources keep relevance. newest survives facet removal
while the planned sections include youtube and resets only when the scope
excludes it.

clear and reset preserve a live focus target; chip removal uses the surviving
neighbour/input. options escape collapses only options, preserving selections.
desktop input escape clears nonempty text; mobile find escape clears/collapses.
only the active capable pane consumes `Pane.Search` (cmd/ctrl+f); existing
interaction overlays win and unsupported/resolving panes retain native find.
menu commands focus the permanent desktop field. source identity is
`paneSourceKey(runtime)` (`visitId:routeId:pathname`), excluding query/hash.

`usePaneFilterRows` owns source-local text and honest complete/partial/retained/
failed status for local rows. `useFind({ownerKey, source, presentation?})` owns
find lifetime, frozen first-query scope, computation, movement and painting.
return aborts movement while pending computation settles at the restored origin;
new query/options/retry allow automatic navigation again. the shell
retires only its disclosure/results; ordinary clear preserves find preferences
and a held return origin. publication replacement retains text/preferences,
retires old geometry, then recaptures after restore. `FindBar` adapts the shared
query toolbar: idle is silent, complete counts are compact, and partial/failure
details stay explicit. one persistent status region supplies full descriptions.
retry/return transfer focus before their controls disappear; companion results
remain transient. current capability and
keyboard details are specified in [the pane controls plan](../pane-controls-plan.md);
its chrome sketch's `actionSubject?: ResourceActionSubject` is now
`resourceRef?: CanonicalResourceRef`.

A resource pane publishes only its canonical `resourceRef`
(`CanonicalResourceRef`). `PaneShell` composes its pane commands and the body's
`menuActions` through `ContextualActionMenu`; the unchanged canonical resource
descriptors are one ordered contiguous suffix
([resource-action owner](resource-actions.md)). Membership, current verb,
order, and danger-last come from the server's verbs, read when the menu opens,
so the pane menu includes `Open`. Pane bodies never build resource action
arrays. The mobile bar renders the active pane's menu outside that pane, so the
pane publishes `onDefect` with its chrome: a defect while loading still breaks
only that pane.

A delete settles panes after the command succeeds: the active pane on the
deleted ref adopts its collection and other panes on it close. A failed or lost
response reports the command error and leaves the view for refresh; the browser
neither retries the delete nor reads a commit witness.

Desktop and mobile primary headers keep stable Back and Forward positions,
expose exactly one **More** trigger when contextual commands exist, and render
the optional typed companion action after it. Search/Return, Refresh, route Share,
published view commands, and canonical resource actions appear in that order;
empty groups disappear. Route Share is omitted for a resource pane because its
canonical plan owns Share. A single marker on More represents hidden status.
Owner separation never creates a second trigger.

the overflow control uses `OverflowMenuButton`: 32px desktop, at least 44px with a
coarse pointer, and 48px in the mobile bar. its glyph and open/disabled/focus
paint belong to the [visual system](visual-system.md#overflow-buttons).
headers own only placement and the decorative status marker. the menu retains
its existing commands, composition, refs and focus policy.

Every primary identity projection uses one 60px track. The mobile safe area is
additive.

The sole promoted action is the typed companion action. `PaneShell` derives it
(`companionAction` in `Companion.tsx`) iff the body publishes a Companion, and
it is the only source of its name (`Inspector`), `PanelRight` icon and disclosure
state; desktop renders it in `SurfaceHeader` as one labelled ghost `Button`
(icon and label at natural width, 32px; the identity yields width first),
mobile as an icon-only 48px bar button. Its open state is visually distinct and
announced through `aria-expanded`; `aria-controls` names the
mounted region while open, and the hover title is the projected
`Show inspector`/`Hide inspector` command copy.

`ContextualActionMenu` projects every remaining command through the existing
`ActionMenu` in desktop and mobile chrome. `ReaderNavigation` presents canonical
section navigation for structured text and page entry/navigation/zoom for pdf.
page entry commits on enter, validates an integer in range, and discards its
draft on blur/escape. no-section documents omit section controls. navigation
and queries wrap to pane width and share the declared control density.

`PaneHeaderIdentity` owns the single route-level `h1` for every pane kind. Body
outlines start at `h2`, and imported reader headings are projected beneath the
chrome heading. Each pane landmark is named from the exact title plus its
optional context, never from a count or date, and pending identity is marked
`aria-busy` while keeping a non-empty accessible name. `WorkspaceHost` projects
the active pane's label as the browser document title `Title · Nexus` and
restores `Nexus` when no active pane exists; inactive panes never write it. The
route-scoped error boundary wraps the whole `PaneShell` (runtime, chrome, body
and Companion), so one pane failure cannot replace its siblings or the
workspace; it reserves the pane's primary width only.

Activation from the strip or the adjacent-pane keys focuses the pane chrome
(desktop) or landmark (mobile); on mobile a newly active pane takes focus into
its landmark, except an appended note that keeps its editor. A desktop↔mobile
flip moves focus only when the focused element went away (focus on the body):
a focused editor, find, filter or collection input keeps focus and the soft
keyboard.

### Mobile Reader Chrome

`lib/mobileShell/chrome.tsx` is the sole mobile reader chrome owner: one
controller created once by `MobileChromeProvider`, with the motion law alone in
the pure `lib/mobileShell/chromeMotion.ts`. Moving surfaces register with
`useMobileChromeSurface(ref, enabled)`: the top bar (`MobilePaneBar`), the
active pane's contextual row (`PaneShell`'s `.chrome`, while it has one) and the
Nexus control. The module alone writes their motion, in one task: the inline
`--mobile-chrome-collapse` progress `p` (0 shown, 1 hidden), `inert` while
`p > 0`, and `data-mobile-chrome-phase` (Visible, Tracking, Settling, Hidden,
Pinned). No React render happens while reading, and a registered element
renders none of those three itself (the Nexus control's open-switchboard
inertness sits on its wrapper).

The reader's text and pdf surfaces register their scroll element through the
host's `ReaderHost.scrollport` (the media pane passes
`useMobileChrome().registerReaderScrollport`). Registration is unconditional; on
mobile the newest registered scrollport drives, on desktop none does. Window,
workspace and non-reader pane scroll never participate. Each scroll folds into
`p` by the law: at or above 8px always shown, an 8px dead zone after every
change of direction, 64px of travel from shown to hidden, sub-pixel deltas
ignored. A stopped half-retreat settles to the nearer end after 120ms with a
rAF tween over `--duration-fast` (instant under reduced motion, which keeps the
retreat itself); the next sample or hold stops it where it is. Motion is
transform-only, so layout, content offset, clearance and reader `scrollTop`
never move; the untransformed Nexus wrapper stays the `"Nexus"` bottom surface.

Holds are a count: `useMobileChrome().hold()` returns an idempotent release, and
`useMobileChromeHold(active)` is the declarative form (Find, the library picker,
open resource and contextual menus). App-owned reader positioning and pdf
rescale hold through the host's `holdChrome`, and
`lib/documentReader/scrollport.ts` counts only genuine input as reading
movement, so a programmatic jump cannot become the next reading delta. While
held, or while focus is inside a registered surface, the chrome is Pinned and
samples only rebaseline; focus is read at each sample, not tracked. The motion
resets to shown, measured from the live driver, on scrollport register and
unregister, mobile and desktop flips, the final hold release, a reader tap
reveal, and a reader press that releases chrome focus; a route or pane change
that changes what is read mounts or unmounts the reader, which is how it resets.

A plain primary click on the reader's own canvas (not interactive, not
prevented by any handler, no live selection), decided after the whole dispatch,
reveals chrome that is hidden or moving. A primary press inside the reading
pane, outside every surface, blurs a focused chrome control (WebKit keeps focus
on taps). `focusPaneChrome(paneId)` holds the chrome shown and next frame
focuses the pane's More trigger, else its landmark; it returns nothing and
cannot reject. Desktop chrome is unaffected.

`MobilePaneChrome` (the active pane's header, navigation, companion, actions and
resource ref) is an external store slot: the mounted `PaneShell` publishes
with `usePublishMobilePaneChrome`, and `MobilePaneBar` reads it with
`useMobilePaneChrome`. Publication does not touch motion.

## Companion

A pane's Companion is its one secondary region: the durable Inspector tabs the
body publishes (`usePaneCompanion`) plus Find's transient "Search results" tab.
`Companion.tsx` renders it as a resizable column inside the pane landmark on
desktop and as a sheet on mobile, and owns every Companion command
(`createCompanionController`, exposed to bodies as the runtime's
`requestSecondarySurface(id | null)`, `closeSecondaryPane` and
`toggleSecondaryPane`, the Inspector action's toggle). On mobile it is
modal sheet chrome, not a workspace column: the shared `MobileSheet`
(`scrim="soft"`, `panelId` = the region id, which is also its interaction
scope) owns the portal, scrim, grabber, keyboard avoidance, back-button
dismissal and the modal contract of the overlay stack (see
`docs/modules/overlays.md`); `Companion` owns only its header (tabs or a solo
title, the pane's resource Actions menu, ✕), tab state and bodies. Do not
introduce another workspace mobile drawer or sheet owner.

The durable state is the store's `pane.secondary`
(`{id, groupId, activeSurfaceId, widthPx, visibility}`), persisted; the runtime
fact `secondaryPane` is that record unchanged. A command acts only on a surface
the pane publishes now. Restoring a workspace and publishing a Companion never
change durable visibility or the remembered tab: while the remembered tab is
unpublished (reader Contents before its read lands) the column shows the
default without rewriting the tab, so a later publication brings it back. Only
the Inspector toggle, a tab, ✕/Esc and explicit requests (a target's
`secondaryActivation`, the media `g` keys, the imports selection) open, retarget
or close it. One width law serves both groups: `companionWidthPx` clamps
`round(stored ?? 360)` to 280–720, in the store's writes and at render.

Find's results are this pane's transient tab, never persisted
(`results: {expanded, widthPx}` in the pane store): FindBar's Results shows
them over whatever the durable Companion was doing; picking a durable tab ends
them and selects that tab; ✕, closing Find or leaving the source end them and
the durable presentation returns as it was. Their width is the durable
record's when one exists. On mobile a successful preview hides the sheet while
the results live on. A pane whose body publishes no Companion (an artifact)
shows its results with a solo title and no tablist.

The region id is `paneSecondaryRegionId(paneId)` (`pane-<id>-companion`) for
both groups; the Inspector's disclosure names it only while it is open.
A command opening the desktop column (the record turning visible or changing
group, Find's results expanding) scrolls it into the canvas so its ✕ is
reachable; a restore, a late publication or a breakpoint round trip never moves
the canvas.
Close labels are sentence case (`Close contents`, `Close search results`).
Focus returns to the opener (or a close destination), else the pane chrome
(desktop) or landmark (mobile); the mobile sheet initially focuses its selected
tab and returns focus without scrolling.

Standalone Artifact panes publish pane find and no Companion. The dossier
article renders into an open shadow root of the app document, so find is the
plain DOM case over that article (citation buttons excluded), keyed on the
revision ref.

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

browse publishes its submitted query and inline facets as stationary query controls. its form
retains draft/commit semantics; the body owns requests and section continuation.
preview keeps its resource controls and publishes no query capability.

## Target Activation

The workspace owns cross-pane product-target activation through
`activateWorkspaceTarget`. Callers provide an href, a semantic disposition and
an optional label hint or inspector surface; they never choose a pane or invoke
pane creation directly.

- `Follow`: activate an exact match; otherwise push the target in the origin
  pane.
- `Fork`: always create and activate a fresh pane immediately after the origin.
- `Adopt`: activate an exact match; otherwise create after the origin. Only
  named workflows that must preserve their source use it.

Exact identity is route plus normalized query and ignores hash. With duplicate
matches, selection is origin first, then the first visible match, then the first
minimized match. A different hash pushes in the selected pane. An unsupported
href opens the unsupported pane instead of throwing; it has the standard section
header, so its pane Back and Forward work like any route's. A requested inspector
surface is attached in the same commit (when the route offers its group); if the
body never publishes that surface, the host shows its publication's default.

At the 12-pane cap, `Fork` or creating `Adopt` is rejected atomically with the
"Pane limit reached" HUD. The workspace never evicts another pane to satisfy
target activation.

the daily page is one explicit rule: a page body publishes its
`PaneDailyPage {localDate, pageId}` (layout phase, `usePaneDailyPage`), and a
`/daily/{date}` target matches a pane of another route whose publication names
that date, a `/pages/{id}` target one naming that page. Today, quick note and
add to Today therefore reuse an open daily pane under either href.

Accepted activation may carry one pane-entry delivery addressed to the chosen
pane and the exact visit the target lands on (`WorkspacePaneEntry`: a page's new
empty row or one of its notes, or a resource menu's edit: page title, note body,
highlight colour, note, bounds or delete, message fork, walk, rerun, regenerate or
delete); the store mints its activation id. The
pane body reads it through `usePaneEntryDelivery` and acts only once ready: it
claims first and acts only when `claim` returned true (the one call that
removed it); ready but unable to serve it (the subject is gone), it claims and
says so in a hud; it owns every outcome. A newer entry supersedes (cancels) the
pane's previous delivery, a rejected activation drops it, and a commit that changes
the pane's visit drops it; nothing expires otherwise.

Learn is one of the named Adopt workflows. It preserves the source reader and
opens `/artifacts/artifact:<id>` as a standalone resource pane after its durable
Highlight-to-Idea command succeeds.

Pane Find movement is inspection, not pane navigation. reader Find consumes the
shared mounted-reader navigation owner: its origin survives closing Find and
ordinary input, and only verified return or explicit adoption ends inspection.
Conversation find keeps its own way back, offered in the find bar and the pane
header. previews write no pane history entry.

`targetLinkActivation.ts` is the one browser gesture adapter. Plain click and
`Enter` are `Follow`; `Shift`+pointer click is `Fork`; Meta/Ctrl/Alt,
middle-click, downloads, external links, `_blank`, fragments, browser-owned
paths and already-prevented events remain browser- or route-owned. Browser-owned
paths are `/` (the workspace entry) and what Next serves outside the catch-all
(app pages and handlers such as `/login`, `/account`, `/auth`, `/s`, `/api`;
metadata files; `public/`; `/_next`). Every other path is a pane's, so a stale
link follows in its pane to the unsupported pane instead of reloading the
document (where, as a deep link, it would append a pane and evict at the cap).

## Recently Closed Panes

The store keeps a page-lifetime, newest-first stack of at most five closed panes
(`{pane, index}`, the inspector inside the pane) outside the persisted state.
Closing activates the right visible neighbour, else the left; closing the last
pane leaves a fresh Lectern pane. Restore rejects at the pane cap, otherwise
reinserts the pane at its clamped former index, visible and active, keeping its
inspector while the route still offers its group. Reload clears the stack.

## Mobile Viewport And Bottom Geometry

`globals.css` is the sole raw platform-inset adapter. It maps WebView's four
CSS safe-area values to `--viewport-safe-{top,right,bottom,left}`, and
`readMobileCssLength` (in `lib/mobileShell/viewport.tsx`) resolves one of those
published tokens to CSS pixels when JavaScript needs a number; an expression
that does not resolve reads as 0.

`MobileViewportProvider` (`lib/mobileShell/viewport.tsx`) owns two registration
kinds. Id-keyed bottom surfaces register through
`registerBottomSurface("Nexus" | "Player" | "Feedback", element)`: the fixed
Nexus wrapper while the switchboard is closed, the normal-flow MiniPlayer or its
unavailable notice, and the persistent feedback region (registered by the
provider itself). The active mobile pane body registers through
`registerContentSurface(element)`; mobile renders one pane, so there is one.
Every cleanup is idempotent, removes the element-local variable and recomputes
immediately; one lazily created `ResizeObserver` (border box) watches every
registered element. `useKeyboardReport` (`lib/ui/useKeyboardInset.ts`) reports an active sheet's or
full-screen task's keyboard inset as a token stack: the newest report wins and
releasing it restores the one before. `useRootTextEntryFocused()` recognizes a
focused text-entry target outside modal layers; while it holds, the mounted
MiniPlayer is hidden/inert and its `"Player"` bottom surface is unregistered;
playback continues through system controls. No keyboard inset is reported for
root text entry.

Geometry resolves in one ordered measurement pass, because each rectangle can
only be measured after the write it depends on. The pass resolves the Nexus
bottom offset from the safe bottom and the Player and Feedback rectangles and
writes root `--mobile-nexus-bottom-offset`; then measures the placed Nexus
wrapper and writes root `--mobile-content-bottom-clearance` — the maximum of
safe bottom, the Nexus band, and the newest overlay keyboard inset — alongside
root `--mobile-overlay-keyboard-inset`; then projects that protected band into
each registered content surface's local bottom coordinate and writes an
element-local `--mobile-content-bottom-clearance` on that element. Every
registration and release measures at once; observed resizes, `window.resize`
and top-level `visualViewport` resize/scroll share one animation-frame-coalesced
pass. The `globals.css` defaults equal the empty-registry result, so nothing
measures before the first registration.

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

## Reader Layout

The media reader publishes its geometry with `usePaneLayout`
(`{intrinsicWidthPx, rail}`): a pdf's own width becomes the pane's minimum once
known, and the Document Map overview rail (52px) sits beside the body and widens
the pane. Both are desktop-only; mobile ignores the publication. Clamping is
render-only (`primaryWidth`): the stored `primaryWidthPx` is what the user chose
(null follows the reader column), and is clamped only at render time to the 320px floor or a pdf
intrinsic minimum. the reader column is the preferred default, rather than a
minimum; typography changes preserve a manually narrowed pane.

The passive mobile reader position ribbon does not participate in fixed primary
chrome. It remains reader-relative, uses the reader-owned semantic range, and
paints at the reader surface bottom (`bottom: 0`). It consumes no bottom
clearance and does not rise above Nexus, Player, or Android navigation; a
higher-priority surface may cover it. Its range is the reader's visible band
(`PositionRibbon` in `lib/documentReader/chrome/MapRail.tsx`).

The reader Document Map overview rail is desktop-only. Its markers activate contextual targets; it contains no inspector
or Document Map opener.

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
- The workspace never infers push-versus-replace from URL shape or resource
  equality. Feature owners choose the operation for every navigation they
  perform; the workspace only executes it.
- A pane's back + forward is at most 12 (push clears forward, traversal
  conserves the sum) and all panes hold at most 48 entries; past that, Back
  trims its head and Forward its tail, non-active panes first.
- A move keeps the pane's width and inspector within one resource, or within
  one route and path for routes naming no resource (query-only changes).

For every `ShellScroll` route, `PaneShell` is the one primary vertical
scrollport. The return memento keeps current-tab-only presentation state per
visit: scroll offset, the eye-line row and its offset, the keyboard focus row,
and route-owned visit data (`usePaneVisitData`). The store captures a pane
synchronously before its visit leaves the screen: push and traverse capture the
navigated pane, and any command that moves activation captures the pane losing
it (mobile unmounts it). Keyboard-ness is read at capture: the focused element
is inside the pane, matches `:focus-visible` and is not editable. A new visit's
registration restores: it places the eye-line row (else the clamped offset) at
once and twice more over two frames after the body reports ready
(`usePaneReturnReady`, and every `usePaneReturnDescendantReady` inside the
content), then focuses the row's `[data-row-focusable]` (else the pane
landmark). Wheel, touch, pointer and scroll keys cancel a pending restore.
Visit data is written on every commit and tagged with its routeKey, so a replace
to another route never restores stale data; a list's snapshot carries the change
stamp it was read under, and a return rereads when the stamp moved
(architecture §8.12). `usePaneScrollRetention` holds the live offset across a
same-path view swap. The scrollport registers its route content
(`usePaneReturnScrollport`'s `contentRef`), so the anchor search starts past
the stationary query controls. Reader, Chat transcripts, and Atlas keep their separate
scroll/location owners. Mementos and visit data are never persisted and are
forgotten when their visit leaves every stack.

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
