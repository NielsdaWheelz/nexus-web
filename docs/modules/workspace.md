# Workspace Module

## Scope

The workspace module owns authenticated pane composition. It decides which
primary panes, desktop pane-strip controls, desktop canvas affordances,
desktop-attached secondary panes, fixed primary chrome, and mobile secondary
sheets are mounted.

Frontend owners live under `apps/web/src/components/workspace/*` and
`apps/web/src/lib/workspace/*`.

## persisted workspace sessions

the workspace separates routes
([`paneRouteModel.ts`](../../apps/web/src/lib/panes/paneRouteModel.ts), the only
url → pane-kind table, deriving routeKey, resource locator and mount key in one
resolver), state ([`model.ts`](../../apps/web/src/lib/workspace/model.ts), the
api's own type plus entry and pane moves), the store
([`store.tsx`](../../apps/web/src/lib/workspace/store.tsx), one external store
whose commands apply synchronously) and the return memento
([`paneReturnMemento.tsx`](../../apps/web/src/lib/workspace/paneReturnMemento.tsx)).

durable state is one json object per authenticated user/device pair:
`WorkspaceState = {active_primary_pane_id, panes}`. panes are one ordered array;
each pane is `{id, current_visit, primary_width_px, visibility, history:{back,
forward}, secondary}` with its inspector embedded. `primary_width_px: null` means
"the reader column": such a pane follows the column when the reader font or
column changes, and only a user resize stores a number. each visit stores
`{id, href, title_hint}`; its nullable hint is settled display evidence, not a
canonical title. recently closed panes, mementos, visit data, the transient
inspector and daily-page publications are not persisted.

python owns the shape and validates every save and every stored read
([schema](../../python/nexus/schemas/workspace_session.py),
[service](../../python/nexus/services/workspace_sessions.py)): structure and
bounds (at least one pane, no pane-count cap, back + forward ≤ 12 per pane,
≤ 48 history in all, ids ≤ 64, title hints ≤ 512 unicode code points), canonical
hrefs (≤ 4096 printable ascii characters, `/` and never `//` first, a path before
`?`/`#` with no `\` and no dot segment: `.`, `..` or their `%2e` forms; the
web's normalized `pathname+search+hash` always passes and anything that passes
restores without re-parsing elsewhere; launcher history,
`POST /me/nexus-selections`, refuses a target path that fails the same rule), unique pane and visit ids, an active pane that
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
400 `E_INVALID_REQUEST`. the same transaction keeps the user's newest 10 rows
(`updated_at DESC, id DESC`) and deletes the rest: a device whose row was pruned
resumes the newest other device's workspace, as a new device does. retry rule:
the body is the absolute state and the prune is idempotent. the device is `X-Nexus-Device`, which only the bff and
`callFastAPI` stamp from the server-owned httpOnly `nx_device` cookie, so a
client cannot name one; without it the api answers 400.

[`BrowserWorkspace.tsx`](../../apps/web/src/lib/authored/BrowserWorkspace.tsx)
opens a confirmed local account binding without a credential read. first
provisioning reads the verified account, reader profile and workspace session
concurrently, then saves the binding before mounting the shell. a failed read
mounts no store. [`DeviceWorkspace.tsx`](../../apps/web/src/lib/native/DeviceWorkspace.tsx)
opens the installed binding from the device; later account refresh cannot replace
live navigation. `enterWorkspace` picks own-if-nontrivial, else
elsewhere-if-nontrivial, else one lectern pane. it merges a deep link: `/` and
invalid paths resume; bare `/daily` resolves in the account zone; another path
reuses its resource and material view or appends a pane. neither entry seeds
authored text from the server. the authenticated group has one optional catch-all
page (`[[...path]]/page.tsx`); unknown paths render unsupported panes.

the pane registry owns one cached `Pending` → `Ready` or `Failed` module outcome
per route. client navigation renders loading while code is pending, then defers
the ready body's render so module arrival does not incur suspense's fallback
retry delay. import failure keeps its stage and requires document reload. this
registry holds code, never account data.

first-provisioning transport failure mounts no store and offers retry. only a
missing stored row is null; invalid state returns `500 E_INTERNAL` without
modifying its row or timestamp. after mounting, the shell retains its local
binding and live store across remote admission changes. account retirement
discards the subtree. local room selection writes its browser cookie without
an authenticated request or refresh.

launcher `?nexus=…` commands are one-shot entry input, never pane identity.
`nexus/urlIntent.ts` supplies one strict parser. restored states are used as
stored; the web never writes a command into an href, so stored data never
dispatches a command. the client captures once, strips browser history, then
delivers through the existing receiver after mounting.

[`useWorkspaceSession.tsx`](../../apps/web/src/lib/workspace/useWorkspaceSession.tsx)
saves after 200 ms. browser saves the local binding first; the installed app
saves through its device workspace owner. an admitted online session also sends
a best-effort cloud copy. one request is in flight; a newer state is sent after
it settles. pagehide and hidden flush the current state. local failure offers
retry; cloud failure cannot veto the local save.

the address bar names the active pane. the store projects it with next's patched
`history.replaceState(null, "", href)`, so next's router url follows and a server
action or refresh cannot revert it. next installs that patch in a passive effect
that runs after the first commit's layout effects; the first projection then
writes the entry directly and projects again on the next frame. a location hash
(cold load, `hashchange`, `popstate`) is folded into the active pane only when
the location's path and search equal the pane's, an empty hash included (Back
from a fragment entry to the bare path clears the pane's hash); an entry for
another path (browser Back onto a fragment entry) is re-projected to the active
pane.

## Layout Modes

`WorkspaceHost` owns the workspace layout mode. Viewport classification comes
from the render environment path, but workspace composition policy is decided in
`WorkspaceHost`.

Desktop mode:

- renders the pane strip
- renders every visible/minimized primary pane shell in the horizontal canvas
- first mounts a body only when its pane is effectively visible and either active
  or intersecting the canvas viewport; once admitted, it stays mounted through inactivity,
  off-canvas movement and minimization until its existing body key or composition
  replaces it, preserving editor drafts and reader state
- enables `usePaneCanvas` in desktop mode
- renders edge fades only from desktop canvas edge state
- renders each pane's companion as a column, or a sheet when maximized geometry
  cannot fit the primary minimum, reader rail and companion minimum
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
  Manage Panes page

Mobile mode is not a narrow desktop canvas. It is a different composition
contract.

desktop maximize is transient `Data.desktopMaximized` in the workspace store,
outside persisted `WorkspaceState`. it follows the active pane, including
close/minimize successors. host remounts preserve it; reload and account
replacement reset it. mobile suspends its projection and desktop resumes it;
mobile title activation does not clear the dormant flag. the active wrapper fills the
canvas; siblings stay mounted, hidden and inert. the runtime receives effective
visibility, while stored visibility, widths, visits and history stay unchanged.
maximized primary resize is absent; error, loading and unsupported panes keep
the same full-width host geometry.

`maximizePane(id)` and `restoreCanvas(id)` resolve the live target, select and
unminimize it through ordinary activation, and atomically publish the requested
mode with that selection. both return the committed `WorkspaceSelection`; a
missing target returns null without effects. an already selected, visible target
in the requested mode does not publish again. mode-only changes preserve
`state` identity and schedule no cloud or native save. these management commands
request no content focus, history entry or loss decision. title activation keeps
the current mode. the host owns effective visibility, inertness and geometry;
[panes](panes.md) owns controls and focus.

The workspace store is the sole owner of sequential traversal. It follows
stored-visible panes in strip order, clamps at the first and last pane,
and never wraps. The Nexus swipe and `pane-next` / `pane-previous` keybindings
invoke that same store command.

## Pane Resource Identity

a pane's resource is its route's own locator (`resource_ref` or
`contributor_handle`), resolved synchronously by `resolvePaneRouteModel`; the
runtime's `resourceRef` is that ref (null for authors and routes naming no
resource). this inspector identity is separate from the workspace title read:
the author body takes its contributor ref from the author it loaded, and a pane
for deleted media shows the body's own not-found. editors that open a typed link resolve it with
`resolveResourceItem` (`lib/resources/items.ts`, `GET /resource-items/{ref}`).

## workspace titles

[`presentations.tsx`](../../apps/web/src/lib/workspace/presentations.tsx) owns one
account-scoped projection for nexus, all panes, pane chrome and the document title.
`useWorkspacePresentations().forVisit(visit)` returns its title, name, detail and
status; `name` is the real name the title shows, or null while the title is a
placeholder (kind noun, loading, unavailable, untitled). `retryTitles()`
refreshes the shared read. readers never publish canonical titles.

current authored locators retain singular resource and semantic daily subscriptions.
each locator has a keyed subscription lifetime; sibling pane changes do not restart
its read.
the title projection publishes only changed ref, caption or local date; unchanged
read replies do not invalidate pane chrome. missing rows remain distinct from unread titles.

`POST /me/workspace-presentations` resolves the distinct current locators,
including minimized panes, in ordered batches of at most 100. batches run
sequentially under one cancellable read. this bounds concurrency without capping
panes; large workspaces pay serial request latency. history and closed visits use
their hints without starting reads. daily dates have their own title locator;
the existing daily-page publication connects live text to that locator.

the existing text owner supplies live and acknowledged note/page titles. live
unacknowledged notes survive a missing canonical row as `unsaved`; dirty writing
never becomes a persisted hint. acknowledged text wins over an older canonical
version. empty settled names render `untitled {kind}` and clear the old hint.
missing/invisible resources retain a known name with an unavailable state.
title failure keeps names, exposes one retry, and is contained independently of
workspace saving and content. request identity fences late replies; account
change discards the projection.

committed `Libraries`, `Entries`, `Metadata`, `Podcasts`, `Chats` and `Notes`
signals, existing link observations, imports observations and foreground/online
refresh the read. outline batches and independent text saves each publish
`Notes` once after acknowledgement; passage-note saves publish at their own
acknowledgement. reads never publish changes. this deliberately rereads some
unchanged names rather than adding another cache or invalidation protocol.

every persisted visit requires nullable `title_hint`. accepted semantic links,
settled identities and resolved previews may supply it; action labels, loading
copy and unsaved drafts may not. the store checks pane id, visit id and title key
before accepting a publication, collapses whitespace and bounds it to 512 code
points. same-resource view replacement preserves the hint; another destination
clears it. fork/history/reopen carry only settled evidence. a preview uses its
exact sealed target and publishes only after its active provider read resolves;
cold inactive previews use hints without contacting providers.

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

content pointer entry and focus entry that changes the active pane release the
target. same-active programmatic chrome focus preserves an explicit reveal.
deliberate horizontal canvas pan also releases it, including wheel, header
drag, its native scrollbar gutter, unhandled horizontal keys and horizontal touch. inner
horizontal scrolling and vertical reading do not. key classification runs after
react handlers. no gesture prevention or custom touch scrolling is added.

the hook takes `Canvas`, `Maximized` or `Disabled`. canvas mode observes the
canvas and every pane wrap for resize, tracks in-view panes and publishes edge
fades. maximized mode measures the canvas content width minus the shell's inline
borders, with no panning or fades. disabled mode measures and scrolls nothing;
it clears the width so desktop resumption cannot reuse the measurement from
before mobile. null denotes an unmeasured width.

`WorkspacePaneCanvas` owns browser scroll continuity during keyed pane placement.
its pre-mutation react snapshot captures both axes of scrolled descendants;
its post-mutation lifecycle restores the same connected nodes before paint.
react keeps the canonical dom order. only a changed relative order among
surviving panes triggers replay; additions, removals and breakpoint membership
changes alone do not. hidden panes retain their last visible
offsets until reveal, restoring only after relocation and only for the same
pane, body and visit. navigation, reader cursors and progress writes remain with
their existing owners. the local descendant scan runs on layout transitions,
not on scrolling or ordinary content updates. react's commit restores focus and
textarea selection after native placement; the canvas adds no focus/caret repair.

## Pane Headers and Primary Chrome

Every supported route declares one `PaneRouteHeaderContract`:

- `Section` declares its owning destination plus
  `context: "None" | "Destination"`, which decides whether that destination
  label appears beside the title
- `Resource` declares the pending support label shown until the body resolves
  its metadata

the workspace presentation supplies the title for both kinds. bodies publish a
typed `PaneHeaderMeta` — `None`, `Pending`, or `Count` — for section routes, or
a typed `Ready`/`Unavailable`/`Failed` resource status with its structured
credit groups. No publication carries a title. The route decides the header
kind; a publication of the other kind is ignored. Counts are whole rows and
credit groups are non-empty by their single producers; nothing re-validates
them.

A body contributes to its shell by rendering, into a store that `PaneShell`
creates for that mounted body (`lib/panes/paneChrome.tsx`), through three hooks:
`usePaneChrome` (`{ header, navigation, primaryAction, resourceActions, query, menuActions,
resourceRef, refresh }` with independent navigation, principal-task and query capabilities),
`usePaneCompanion` (the Companion's tabs and default) and `usePaneLayout` (a
reader's intrinsic width and rail). Each writes its slot in a layout effect and
clears its own value as it unmounts; the shell subscribes in a layout effect
and so re-renders before paint. Other descendants read only the published
`resourceRef`, through `usePaneSubject`. The body's mount is the publication and its
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
republishes on every render, which re-renders the shell and each `usePaneSubject`
reader (the republish passes through null); hot publishers (media,
`Conversation`) memoize theirs.
There is no route-level chrome descriptor, body-mode inference, or ambient title
override.

`refresh` publishes one source-fenced, abortable, awaitable owner operation.
`PaneShell` owns the refresh descriptor, mobile top-edge pull gesture, progress,
and announcement; both activation paths invoke the same fenced operation. The
pane owner resolves only after its canonical first page is installed. Only the
eight explicitly supported finite standard-scroll panes publish it (authors,
chats, lectern, libraries, library, notes, podcasts, podcast). Refresh never
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

`PaneQueryToolbar` owns presentation: a stable input/clear entry with optional
submit, followed by operation actions, inline options disclosure, native
sort/reset and optional trailing actions. options may use the shared icon-only
contract; their accessible name retains the active-option count. optional status
declares `Inline` or `Details` placement; inline
feedback shares the actions group. applied text, chips and details status share
one compact summary; errors and expanded options remain in its single bounded
refinement region, capped by the shell. mounted options retain their drafts.
controls wrap when their readable minimum sizes require it; no pane-width rule
forces another row. empty actions/controls wrappers have no layout footprint.
submitted queries use a form; local filters/find use labelled groups, with
details/options outside the form. checkboxes represent booleans/sets; uniquely
named radio groups represent singular choices. domains own options, draft/applied
text, timing, results, urls and reset. clear removes draft AND applied text
while retaining facets/order; browse immediately returns to its empty-query
state. an aborted response cannot publish as current. browse labels its
provider-scoped control
“youtube sort”; other sources keep relevance. newest survives facet removal
while the planned sections include youtube and resets only when the scope
excludes it.

supplied status requires `{ placement, id, content, visible }`. omit status for
idle find. visibility changes only the
wrapper's sighted presentation (`sr-only` when false); the described element
and domain-owned live subtree stay mounted. local-filter publishers use fixed
inline placement with `visible: false`: full scope descriptions remain attached
to the input, while routine loading/count text has no chrome footprint. local
query changes speak after 400ms only with a usable source in the active pane;
imports server queries disable that narrator. the first-read feedback owner
speaks its own initial outcome once. no narrator speaks automatic page arrivals.
sorting, reset eligibility and independent header counts do not imply filtering.
local reset appears only for changed facets/order and clears text plus those
settings; text-only views use clear/escape. header totals retain their existing
exact/domain meaning. unfinished local filters use provisional empty copy and,
when matches exist, explain “filter applies to loaded items.” at the results
boundary. outline filters name loaded top-level items and retain explicit show
more; failures and complete empty results stay distinct. browse/search keep
explicit query waiting, failures and ordering descriptions, without rolling
counts or automatic-pagination completion summaries. empty details have zero
visual height and no tab stop; a suppressed status keeps its live subtree
mounted and accessible. empty details without that subtree are hidden. capture
focus ownership before hiding; repair to the enabled input before paint, or
existing pane chrome/landmark if the input is disabled. retain focus already
transferred outside.

`usePaneFilterRows` captures its committed source and query in the existing
per-visit memento. pane back/forward restores that query before list and scroll
restoration; a fresh visit starts empty, and a query applies only to its captured
source. this memory lasts only while the visit remains reachable and never
enters browser storage.

clear and reset preserve a live focus target; chip removal uses the surviving
neighbour/input. options escape collapses only options, preserving selections.
desktop input escape clears nonempty text; mobile find escape clears/collapses.
only the active capable pane consumes `Pane.Search` (cmd/ctrl+f); existing
interaction overlays win and unsupported/resolving panes retain native find.
menu commands focus the permanent desktop field. source identity is
`paneSourceKey(runtime)` (`visitId:routeId:pathname`), excluding query/hash.

`usePaneFilterRows` owns source-local text and honest complete/partial/failed
status for local rows. shared lists expose only current-key rows and metadata;
same-key refresh retains usable data. `useCollectionReadFeedback` owns only
continuation failure recovery and a single outcome after an announced active
initial wait, bound to `list.requestedKey` so restoring another ready query
retires the abandoned wait. its notice is literal null when quiet; mount its persistent live
node outside optional footer/state wrappers so hidden speech creates no gap.
initial/refresh errors remain with their feature owner. inactive/abandoned waits
retire without replay; restored-ready mounts and passive traversal stay silent.
`useFind({ownerKey, source, presentation?})` owns
find lifetime, frozen first-query scope, computation, movement and painting.
return aborts movement while pending computation settles at the restored origin;
new query/options/retry allow automatic navigation again. the shell
retires only its disclosure/results; ordinary clear preserves find preferences
and a held return origin. publication replacement retains text/preferences,
retires old geometry, then recaptures after restore. `FindBar` adapts the shared
query toolbar: idle is silent, complete counts are compact, and partial/failure
details stay explicit. navigation/retry precede icon-only find options, followed
by icon-only results, optional return and mobile close. applied-option chips
remain visible. options uses sliders; the results trigger and companion tab use
the same text-search glyph. results opens its existing column/sheet and never
toggles it closed. one persistent status region supplies full descriptions.
retry/return transfer focus before their controls disappear; companion results
remain transient. current capability and
keyboard details are specified in the pane controls plan (#578, revised by #628);
its chrome sketch's `actionSubject?: ResourceActionSubject` is now
`resourceRef?: CanonicalResourceRef`.
current toolbar presentation is specified in the query toolbar plan (#628);
its verification records browser and dom
evidence, including native page/text zoom, with no spoken assistive-technology claim.

a resource pane publishes its canonical `resourceRef`
(`CanonicalResourceRef`) and explicit inline `resourceActions` subject.
`PaneShell` composes its pane commands and the body's
`menuActions` through `ContextualActionMenu`; the canonical resource
descriptors are one ordered contiguous suffix
([resource-action owner](resource-actions.md)). Membership, current verb,
order, and danger-last come from the server's verbs, read when the menu opens;
a pane's own subject omits open and fork
([target activation](#target-activation) rule 3). Pane bodies never build
resource action arrays. Both header projections render inside the pane, so a
menu defect breaks only that pane.

podcast discovery headers additionally publish their current explicit podcast
subject through `resourceActions`; their immediate menu shares the shortcut
projectors. canonical headers retain prepared resource menus. `resourceActions`
also carries media subjects; it replaces the former media-only chrome slot.
the host owns compact promotion and original-control/more/pane focus recovery.

A delete settles panes after the command succeeds: the active pane on the
deleted ref adopts its collection and other panes on it close; they are not
offered in recently closed, which holds closes only. A failed or lost
response reports the command error and leaves the view for refresh; the browser
neither retries the delete nor reads a commit witness.

`primaryAction` is one link or command descriptor with a required decorative
icon. `PaneShell` binds workspace activation; `SurfaceHeader` owns its icon-only
ghost button or native anchor, accessible name, tooltip, projected state and
disabled explanation. chats publish `new chat`, libraries `new library`, an
individual library `add content`, and podcasts `browse podcasts`, each with a
20px plus. existing menu entries reuse those descriptors; `Libraries.Create`
exists only as the primary action, independent of list loading, filtering and
invalid views. native anchors retain modified-click behavior; commands receive
their actual invoking button. query controls contain no primary action.

libraries creation is a pane-owned dialog. its immutable id/name survives
uncertainty in visit memory; close relinquishes automatic opening without
canceling the write. acknowledged foreground creation opens in its origin;
later completion offers explicit open. pane back restores filter/sort/position.
`usePaneVisitDataWriter` records or clears the attempt synchronously against the
latest committed visit key before navigation can unmount the body.

desktop and mobile headers order back/forward, identity, optional primary action,
the shared media action group when published,
optional passive subscription status, exactly one more trigger when contextual
commands exist, and the optional typed companion action. identity yields width;
controls retain whole targets. at primary-pane widths up to 479px, media shortcuts
move into the existing more menu; history, identity, more and inspector stay in
one line. the fixed mobile header uses the same viewport threshold outside the
desktop containment boundary. search/return, refresh, route share,
published view commands, and canonical resource actions appear in that order;
empty groups disappear. Route Share is omitted for a resource pane because its
canonical plan owns Share. A single marker on More represents hidden status.
Owner separation never creates a second trigger.

the overflow control uses `OverflowMenuButton`: 32px desktop, at least 44px with a
coarse pointer, and 48px in the mobile bar. its glyph and open/disabled/focus
paint belong to the [visual system](visual-system.md#overflow-buttons).
for overflow, headers own only placement and the decorative status marker. the
menu retains its existing commands, composition, refs and focus policy.

every primary header starts with `--pane-chrome-header-height`; compact media
commands move into overflow instead of adding an action row. desktop, coarse-pointer
and mobile controls retain 32px, 44px and 48px shared-control targets. mobile
headers can grow naturally. the viewport owner measures their stationary frames
and places controls with `--mobile-controls-top`; `--mobile-pane-content-offset`
publishes their shown envelope in each content surface. routes reserve no extra
media action row. hidden reader chrome follows the measured overlay contract,
not a permanent header reservation. refinement-room measurement consumes that
result. the content row explicitly occupies grid row two, the declared fill row,
so loading content cannot determine scrollport height. reader composition is
selected from the active route before publication loading; mounting a reader
does not change layout.

the typed companion action remains separate. `PaneShell` derives it
(`companionAction` in `Companion.tsx`) iff the body publishes a Companion, and
it is the only source of its name (`Inspector`), `PanelRight` icon and disclosure
state. both headers render its decorative 20px glyph with the stable accessible
name `Inspector`. both projections use the shared icon-only ghost `Button` and
header density. its open state is visually distinct and
announced through `aria-expanded`; `aria-controls` names the mounted region
while open. the shared text-only `Tooltip` shows the projected
`Show inspector`/`Hide inspector` command copy on mouse/pen hover or keyboard
focus, including mobile keyboard use. it preserves button focus and ordinary
commands; touch only activates the inspector. its lifecycle and passive overlay
contract live in [overlays](overlays.md).

`ContextualActionMenu` projects every remaining command through the existing
`ActionMenu` in desktop and mobile chrome. `ReaderNavigation` presents canonical
section navigation for structured text and page entry/navigation/zoom for pdf.
page entry commits on enter, validates an integer in range, and discards its
draft on blur/escape. no-section documents omit section controls. navigation
and queries wrap to pane width and share the declared control density.

`PaneHeaderIdentity` owns the single route-level `h1` for every pane kind. Body
outlines start at `h2`, and imported reader headings are projected beneath the
chrome heading. Each pane landmark is named from the exact title plus its
optional context, never from a count or date. pending support metadata is marked
`aria-busy`; title loading uses the shared projection's non-empty copy.
`WorkspaceHost` projects the active pane's title as the browser document title
`Title · Nexus`; workspace state always has a visible active pane. inactive
panes never write it. the
route-scoped error boundary wraps the whole `PaneShell` (runtime, chrome, body
and Companion), so one pane failure cannot replace its siblings or the
workspace; it reserves the primary width, or the full canvas when maximized.
it resets on every new visit (`paneId:visitId:routeKey`), so Back retries. a
failed pane with history offers "go back" (after "reload app" for a module
load failure; a stale build offers only its reload), which asks the loss guard
like any Back and then focuses the pane's chrome (desktop) or landmark (phone).
on a phone a failed pane shows no top bar.

Activation from the strip or the adjacent-pane keys focuses the pane chrome
(desktop) or landmark (mobile); on mobile a newly active pane takes focus into
its landmark, except an appended note that keeps its editor. A desktop↔mobile
flip moves focus only when the focused element went away (focus on the body):
a focused editor, find, filter or collection input keeps focus and the soft
keyboard. an active interaction owner retains focus when one of its commands
changes the workspace selection.
removed shortcut recovery runs before the host's generic breakpoint fallback,
so a surviving more control keeps focus. the host rechecks for lost focus before
choosing the pane landmark.

pointer or focus entry physically inside a visible pane synchronizes active
ownership from the live store, preserving the reached control and suppressing
canvas reveal. react events from a portaled menu or modal do not count as pane
entry. a newer focus/pointer action or interaction owner cancels delayed host
focus. strip management retains strip focus; its contract lives in
[panes](panes.md).

### mobile reader chrome

`lib/mobileShell/chrome.tsx` owns one visibility target for the hosted reader's
top bar, active pane controls, player footer and nexus button. `useMobileChromeSurface` registers
those roots; the controller alone writes `inert`,
`data-mobile-chrome-visibility` (`Shown`/`Hidden`) and
`data-mobile-chrome-motion` (`Animated`/`Instant`). `lib/mobileShell/chrome.css`
owns interpolation: `--duration-base`, `--ease-snap`, an 8px retreat and opacity.
each surface supplies its travel direction. hiding makes the
roots inert immediately and defers `visibility:hidden` until the fade ends;
showing restores interactivity immediately. reversal starts at the current
visual values. reduced motion and command focus reveal instantly. the hosted mobile reader uses a stable canvas inside platform protection. header,
controls, player and nexus occupy overlays; hiding removes their paint and input
without changing document extent or position. stationary frames supply shown
geometry independently of animated visibility. ordinary panes retain their flow
composition. the player registers its moving inner footer and stable outer frame
through every runtime state and reader retreat.
chrome alone owns the footer's inertness; local keyboard/sheet suppression owns
the outer slot. desktop anchored player pickers leave the footer interactive.
the player drawer uses the shared sheet's native handle button; playback and
chapters are mutually exclusive inline regions inside its existing body.
`MobileSheet` accepts either `handleLabel` or `renderHeader`, never both.
its captured header drag uses sticky 8px tap slop and a 96px downward dismissal
threshold. moved/cancelled gestures suppress only their own click; every exit
uses the same dismissal guard. default title/close and custom headers retain
their existing behavior.

the text/pdf scrollport registers through `ReaderHost.scrollport`; the hosted
media pane composes chrome and viewport `registerReaderScrollport` capabilities.
the viewport registry gates local reader geometry by the active route-owned
`data-reader-composition` marker, including breakpoint and active-pane changes. the newest mobile registration
accepts taps; desktop has no driver. fresh reader entry, pane return and viewport
breakpoint changes start shown. scrolling, reflow and same-mounted reader
navigation preserve the target. a new chrome surface inherits it immediately.
reader disposal restores the surrounding shell.

`readerTap.ts` admits a trusted, primary, unmodified completed pointer sequence
and its native click, within 8 css px. selection and overlay ownership are
sampled before light-dismiss; interactive targets and consumed clicks retain
their actions. reader-owned focusable reading surfaces mark
`data-reader-input-boundary`; the bounded interactive-target check still excludes
their links and controls. pdf text layers retain native keyboard focus.
semantic handlers finish before the toggle decision. browser
momentum-stop suppression, pan, pinch and context menus produce no toggle.
completed presses await their own pointer's native click, even when later
presses arrive first. cancellation retires only its pointer; unmatched numeric
ids retire on reuse, context menu, blur or reader disposal.
there is no scroll visibility policy, tween or visibility persistence.

`hold()` synchronously shows controls and returns an idempotent release. the
last release leaves shown. find and menus use `useMobileChromeHold`; reader
positioning owns no chrome hold. `focusPaneChrome` reveals synchronously and
focuses More, otherwise the pane landmark, next frame. hiding transfers focus
from a chrome control to the existing pane landmark with `preventScroll`.

`useMobileChromeState()` publishes `Shown`, `Hidden`, `Held`, or `null` for no
mobile reader. one stable native recovery button sits before the top bar,
outside every inert root. its exact action is “hide reader controls” or “show
reader controls”, with `aria-expanded`; `Held` disables hide. it stays visually
clipped until keyboard focus, when it shows the full label above the bar inside
the safe insets. accessibility navigation can discover it in either state.

the phone's top bar is the active pane's own header: `PaneShell` renders
`SurfaceHeader` in its `Mobile` projection (back, forward, identity, More,
Inspector, after the recovery button) as the pane section's child before
`.primaryPane`, whose inline-size container would otherwise become the fixed
bar's containing block. nothing publishes chrome out of a pane, so the bar's
links, defects and focus stay with that pane; its More trigger, when present,
carries `data-pane-chrome-focus`, and every chrome focus path falls back to the
pane landmark without it.

## Companion

A pane's Companion is its one secondary region: the durable Inspector tabs the
body publishes (`usePaneCompanion`) plus Find's transient "Search results" tab.
`Companion.tsx` renders the committed `Column` or `Sheet` presentation and owns
every companion command (`createCompanionController`, exposed to bodies as the runtime's
`requestSecondarySurface(id | null)`, `closeSecondaryPane` and
`toggleSecondaryPane`, the inspector action's toggle). the shared `MobileSheet`
(`scrim="soft"`, `panelId` = the region id, which is also its interaction
scope) owns the portal, scrim, grabber, keyboard avoidance, back-button
dismissal and the modal contract of the overlay stack (see
`docs/modules/overlays.md`); `Companion` owns its header, tab state and bodies.
the sheet renders that specialized header through `renderHeader`, outside the
scrolling retained body. its x uses the frame's dismissal request.

`PaneShell` commits presentation: mobile uses a sheet; ordinary desktop uses a
column; maximized desktop uses a column only when measured content width fits
320 px of primary content, the reader rail and the 280 px companion minimum.
an unmeasured maximized width retains presentation. transitions wait while
another interaction owner is active, with a live ownership check before commit.
the effective width limit is `max(280, min(720, contentWidth - 320 - railWidth))`
when maximized, otherwise 720 px. rendering never overwrites the stored preference.

one companion-owned portal host moves between empty column and sheet slots.
each destination supplies its actual `OverlayContext`, preserving local drafts
and dom identity while closed child layers bind to their current parent on
admission. presentation changes retain the active body; close and tab switches
keep their existing body lifetimes. new sheet admission waits for other owners;
an admitted sheet stays mounted under covering overlays and retires when closed
or its pane becomes effectively hidden.
relocation captures focus before removing the old host/header. the column
restores it after replacement refs commit; sheet admission prefers a live retained
body control before its selected-tab/close default. another owner or deliberate
focus move takes precedence.

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
record's when one exists. in sheet presentation a successful preview hides it while
the results live on. A pane whose body publishes no Companion shows its results with a solo title and no tablist.

The region id is `paneSecondaryRegionId(paneId)` (`pane-<id>-companion`) for
both groups; the Inspector's disclosure names it only while it is open.
A command opening the desktop column (the record turning visible or changing
group, Find's results expanding) scrolls it into the canvas so its ✕ is
reachable; a restore, a late publication or a breakpoint round trip never moves
the canvas.
Close labels are sentence case (`Close contents`, `Close search results`).
column close returns focus to its opener or explicit destination, else pane
chrome. a sheet initially focuses its selected tab and returns without scrolling
to a live external opener, else the pane landmark. promotion records the live
external opener; demotion retains inspector focus on the same connected control,
else its selected tab. a hidden pane and another interaction owner take precedence
over these repairs.

## Browse And Preview Panes

Browse is a standard section pane at `/browse`; Preview is a standard resource
pane at `/browse/preview`. Both use `PaneShell` as their vertical scroll owner.
The Browse visit identity is the exact normalized `q`, `kind`, `source`, and
`sort` query. each kind/source section uses the shared server list with its own
stable pane-visit key. external candidate identity is its top-level sealed target,
which survives resolution into an owned resource; nexus candidates use their
resource identity. accepted pages publish immediately, then continue in
source order while the pane is active and the document visible. one provider
failure stops only its section and retains its rows. the parent aggregates loaded
counts and section status. its route-owned memento captures committed pages and
cursors with focus and scroll, so back restores the accepted snapshot; unfinished
sections resume when eligible.

Preview identity is its sealed discovery target. It re-resolves provider truth,
publishes a matching-visit title hint and a source credit plus an
explicit acquisition action, but no
canonical resource target before acquisition. Open/reload/play/leave Preview
writes no Media, subscription, Library entry, job, progress, completion, or
activity fact. Successful Add or Subscribe replaces Preview with the canonical
owned pane after any eligible one-shot position transfer; failure leaves Preview
and its staged destination choices intact.

browse publishes its submitted query and inline facets as stationary query controls. its form
retains draft/commit semantics; the shared list owns section continuation.
preview keeps its resource controls and publishes no query capability.

## Target Activation

The workspace owns cross-pane product-target activation through
`activateWorkspaceTarget`. Callers provide an href, a semantic disposition and
an optional label hint or inspector surface; they never choose a pane or invoke
pane creation directly.

- `Follow`: activate an exact match; otherwise push the target in the origin
  pane.
- `Fork`: always create and activate a fresh pane immediately after the origin.

ordinary destination opening uses `Follow`; shifted activation uses `Fork`.
explicit open-in-new-pane actions also use `Fork`. fork affordances follow these
rules:

1. a menu offers verbs on its own subject. adjacent pages are not the pane
   menu's subject.
2. no menu or trigger exists only to carry a fork; the player chapter menu is
   the one recorded violation ([issue](../issues/chapter-shift-changes-verb.md)).
3. a menu inside a pane never offers to open the pane's own subject:
   `ContextualActionMenu` omits `Open` and `OpenInNewPane` when its resource is
   the subject the pane's body publishes (`PaneChrome.resourceRef`, read through
   `usePaneSubject`), not the route's ref, which author and daily routes lack.
4. a fork is shift on the visible control. pointer-visible help discloses it
   with `NEW_PANE_HINT`; keyboard-only help (nexus, the pane strip) names
   shift+enter.
5. exception: a multi-verb row menu on a coarse pointer may offer
   `open in new pane` (`Row.OpenInNewPane`), because shift does not exist there;
   resource menus with no displayed activation, unless their resource is the
   pane's own, keep the server `OpenInNewPane`.

materialising an already placed provisional view replaces that view without
another opening.
acquisition uses `originHistory: "replace"` for its already-placed preview:
only a `NavigatedOrigin` landing replaces the origin visit instead of pushing.
matching existing panes retain their navigation history; `Fork` starts independently. an offered result
is a fresh opening and never inherits this replacement request.

identity is resource plus material view: arrival parameters and fragments do not
defeat reuse; collection filters and sorts still distinguish views. an explicit
chat `leaf` matches that endpoint. bare/message-only chat targets preserve the
chosen pane's endpoint; a new untargeted view seeds from the last admitted send.
with duplicate
matches, selection is origin first, then the first visible match, then the first
minimized match. a different arrival href pushes in the selected pane; repeating
the same target still delivers a new activation. An unsupported
href opens the unsupported pane instead of throwing; it has the standard section
header, so its pane Back and Forward work like any route's. A requested inspector
surface is attached in the same commit (when the route offers its group); if the
body never publishes that surface, the host shows its publication's default.

there is no pane-count cap or eviction. activation commits directly; close and
minimize return the exact committed `{paneId, visitId}` selection. nexus absorbs
only its own close/minimize/restore selection into its navigation baseline;
outside navigation or target activation dismisses it, including activation of
the current target. root pane results expose direct close;
held enter cannot close surviving rows repeatedly. manage panes remains
available at every pane count.

the daily page is one explicit rule: a page body publishes its
`PaneDailyPage {localDate, pageId}` (layout phase, `usePaneDailyPage`), and a
`/daily/{date}` target matches a pane of another route whose publication names
that date, a `/pages/{id}` target one naming that page. Today, quick note and
add to Today therefore reuse an open daily pane under either href.

Accepted activation may carry one pane-entry delivery addressed to the chosen
pane and the exact visit the target lands on (`WorkspacePaneEntry`: a page's new
empty row or one of its notes, a typed `InspectSource` target, or a resource menu's edit: page title, note body,
highlight colour, note, bounds or delete, message fork or
delete); the store mints its activation id. The
pane body reads its entry and acts only once ready. commands claim before acting
and act only when `claim` returned true (the one call that removed it). source
inspection persists its pending target in visit data BEFORE claiming, so an
unmount cannot lose it; the destination owns resolution, positioning and paint.
ready but unable to serve a command (the subject is gone), it claims and
says so through shared feedback; it owns every outcome. a newer entry supersedes
the pane's previous delivery; a commit that changes its visit drops that delivery.
nothing expires otherwise. source arrivals also cancel
on source replacement. focus requires an active destination and no intervening
user interaction; a background arrival can paint without taking focus.

`ComposeChat {text}` and `ComposePage {title}` are transient authored entries.
their hrefs are query-free `/conversations/new` and `/pages/new`; authored seeds
never enter saved workspace state, title hints or browser history. the launcher
supplies the exact destination draft owner to the loss decision, using the pure
target planner and the feature's owner-id helper. refusal preserves source and
destination. the store registers accepted pending seeds in visit memory before
source dismissal. retained-history travel and lazy loading keep that ownership;
the recipient adopts and registers the value before claiming its exact delivery.
replacement protects both pending delivery and existing input. there is no old
query-seed reader or persisted recovery path.
page delivery replaces only the title; it retains body, editor identities and
live requests. its title owner and body/request owner read the same draft cell,
so changing a title never discards an attachment or warns about preserved prose.

`activateWorkspacePane` selects an exact pane or forks its current visit; missing
panes return null. `goBackPane`/`goForwardPane` require a disposition: `Follow`
traverses the exact adjacent occurrence; `Fork` peeks without changing either
source stack. named forks insert after the named pane, preserving minimization.
all forks create fresh pane/visit ids, empty history, default width and no inspector.

named/history forks copy only shell scroll/eye-line (without keyboard focus) and
`Reader.InspectionView` from the exact visit/route key. authored data, drafts and
pending commands retain their owners. generic href forks carry a fresh target.
`InspectSource.purpose` is required: `Open` invalidates old arrival presentation;
`RestoreVisit` waits for destination validation of its copied view. a valid view
wins even over an obsolete locator; absent/obsolete views inspect the canonical
href; failed restoration refuses visibly. admission precedes capture/copy/delivery
and one focused commit. refusal changes no workspace state or presentation.
canonical source hrefs and their single parser cover current resources, captured
quote messages, citation edges and saved retrieval ids. native tab, copy, reload
and in-app activation identify the same target. see [resource references](resource-references.md).

`lib/panes/openResult.ts` owns delayed landing for create/lookup consumers and
the shared `readForNavigation` attention check for those results.
the feature retains its mutation id, inputs and sticky opening intent. landing
requires the captured account, pane/visit, foreground generation, overlay owner
and no subsequent trusted input (including wheel). its initiating layer may remain;
a closing transient may expose only its captured underlying owner. a competing
layer, user back or modal dismissal revokes authority. departure revokes placement,
never the write.
`readForNavigation` returns `Aborted` for account departure, admitting no feedback;
otherwise it returns the read value and whether it still owns attention. callers
act on that result immediately, without another await. read errors propagate;
the helper always removes its input listeners.
superseded success offers its exact result. that action captures a fresh origin
and intent; ordinary offered open follows. result offers are session-local.
targets, surfaces and entries travel through one workspace commit; the workspace
owns destination focus, including exact named-pane selection. the palette keeps
its local handoff only for reopening closed panes. delayed offers inherit neither
automatic create/send placement nor obsolete source discard owners.
add's media and import controls share one accepted-source lookup and busy id.
the durable attempt is read once before placement: a settled media target uses
its resolved media id; an unsettled target keeps the exact attempt selector on
that resolved id. native media links retain their durable href. the opening
gesture owns intent; shifted dismissal confirmation can upgrade it to `Fork`,
and ordinary confirmation cannot downgrade it.
the store's nonpersisted `foregroundGeneration` advances synchronously on active
pane, visit or resolved source replacement; same-source query/hash refinement
does not advance it. leaving and returning cannot regain an earlier token.

Pane Find movement is inspection, not pane navigation. reader Find consumes the
shared mounted-reader navigation owner: its origin survives closing Find and
ordinary input, and only verified return or explicit adoption ends inspection.
Conversation find keeps its own way back, offered in the find bar and the pane
header. previews write no pane history entry. named result rows also carry pure
canonical hrefs: ordinary activation reveals locally, shift opens independently.
`activate(row)` and `targetHref(row)` validate the captured computation/source;
stale rows never dispatch. local sheets close after successful reveal; fork
sheets close only after workspace admission.

`lib/ui/targetActivation.ts` is the pure gesture classifier;
`lib/panes/targetLinkActivation.ts` binds it to a complete workspace target.
shift-click and shift-enter create one fresh, focused pane after the origin,
including an already-open/current target. plain activation uses `Follow`.
`onDefault` is only for same-source local inspection or materialising an already
placed provisional view; it cannot choose placement. owned repeated enter is
consumed; composition on destination controls is inert and multiline shift-enter
remains editor-owned. normal anchors use scoped pane/queue/metadata capture;
rich targets bind both handlers and bypass capture. global controls capture the
active origin at activation. accepted modal openings close and suppress trigger
return-focus; cancelled or unavailable openings keep their presenter open. Meta/Ctrl/Alt,
middle-click, downloads, external links, `_blank`, fragments, browser-owned
paths and already-prevented events remain browser- or route-owned. Browser-owned
paths are `/` (the workspace entry) and what Next serves outside the catch-all
(app pages and handlers such as `/login`, `/account`, `/auth`, `/s`, `/api`;
metadata files; `public/`; `/_next`). Every other path is a pane's, so a stale
link follows in its pane to the unsupported pane instead of reloading the
document. only an explicit semantic `data-pane-label-hint` supplies an anchor's
title hint; menu text is never inferred as identity.

`activateResource` passes the canonical resource href to the workspace. the store
derives its `InspectSource` arrival from that href in the same activation commit.

every semantic target activation commits one transient pane/visit focus request.
`WorkspaceHost` waits for the initiating overlay to close, then focuses chrome or
the mobile landmark,
unless the destination entry already focused its editor/source. intervening
input, foreground/visit change or closure cancels it. the request is never saved.
claims compare the exact request object, so an earlier activation cannot clear a
newer request for the same pane and visit.
ordinary rail activation claims its request so the surviving rail link keeps
focus. an unchanged account-menu destination also claims before restoring its
trigger; a changed destination uses the host's handoff.
the host, source arrival and delayed-result owner share the native input rule:
modifier keys and consumed enter repeats preserve attention; real editor input
and composition relinquish it.

`updatePaneViewHref({paneId, visitId, href, arrival})` changes a chat endpoint
without history or activation. it requires the same visit and conversation.
`preserve` changes only `leaf`, retaining source selectors and arrival authority;
`clear` removes selectors and delivery after the chat owner aborts its inspection.
chat return/memento identity excludes `leaf`; explicit target matching retains it.

## Recently Closed Panes

The store keeps a page-lifetime, newest-first stack of at most five closed panes
(`{pane, index}`, the inspector inside the pane) outside the persisted state.
closing the active pane selects the right stored-visible neighbour, else the
left; if only minimized panes remain, it restores the nearest survivor. closing
the last pane creates a fresh lectern pane. closing an inactive pane preserves
activation. restore reinserts at the clamped former index, visible and active,
keeping its inspector while the route still offers its group. reload clears the
stack. minimize preserves one stored-visible pane and uses the same right/left
selection order. close and minimize return the committed pane/visit selection
so callers need not repeat that policy; close returns null when refused.

## unsaved work

`lib/unsavedWork.tsx` owns one account-scoped memory registry. feature owners
supply `id`, lifetime scope, live risk read and subscription; the registry holds
no text or request bytes. risk separates changed input, unconfirmed requests and
unfinished browser work. existing content compares against its acknowledged or
loaded value; new input compares against canonical empty. rich-only content and
deletion to empty count; search and model choice alone do not.

workspace commands build and trim a prospective state, compute lost pane/visit
owners, then ask one synchronous browser-native confirmation. only approval may
capture mementos, retire owners, deliver entries, commit, dismiss the source or
move focus. activation returns `Cancelled`; navigate/back/forward return
`committed | unchanged | cancelled`. cancelled gestures are consumed. retained
history and mobile remounts keep owners and do not prompt. recently closed panes
restore navigation without discarded authored input.

the same registry conditionally installs `beforeunload` and answers the android
shell's cancelable `nexus:request-exit` event. false or suppressed confirmation
refuses loss. browser-owned unload text and controls are intentional. memory can
still be lost to process death or tab discard; nothing promises local durability.
canonical deletion is applied independently: refusal of later pane removal keeps
unavailable changed input copyable and cannot undo the deletion.

elective signout asks before purge/session mutation, makes the document inert
while pending, then arms a one-shot immediately before form submission. the first
unload consumes it; observable failure or `pageshow` restores protection.
forced account teardown remains unconditional and fences old callbacks.

## Mobile Viewport And Bottom Geometry

`globals.css` alone adapts platform insets to `--viewport-safe-{top,right,bottom,left}`.
`readMobileCssLength` resolves those tokens to css pixels. the route owner derives
mobile reader composition from the active route's `returnKind === "Reader"`;
the pane and global player consume the same value. reader composition excludes
platform protection once and overlays shell controls. ordinary panes reserve the
measured `--mobile-header-height` and retain a normal-flow player.

`MobileViewportProvider` owns top surfaces (`Header`, `Controls`), bottom surfaces
(`Nexus`, `Player`), pane content and hosted reader scrollports. each
shell registration supplies a stationary frame and nullable animated surface;
the frame determines shown endpoint extent,
while computed visibility determines current obstruction. the one border-box
resize observer and coalesced viewport/transition pass own invalidation.

one ordered pass measures the header, places controls and nexus, publishes
`--mobile-feedback-top` at the stationary header/control endpoint plus 12px,
and publishes local content clearance,
then publishes reader endpoint extent and current occlusion. overlapping
rectangles form a conservative full-width envelope; their heights are never
summed. nexus placement uses
shown frames and stays fixed on tap; `--mobile-content-bottom-clearance` and its
subscribers report current visible obstruction. the chrome controller refreshes
geometry synchronously after visibility writes and before holds/focus return.
fade-out retains conservative bounds until computed visibility is hidden;
reduced motion needs no transition event.

reader scrollports receive `--reader-content-inset-top/bottom` for real scrollable
endpoint extent and `--reader-occlusion-top/bottom` for current obstruction.
the first pair stays fixed on hide/show. the second releases hidden surfaces.
registration measures immediately; release or loss of active mobile composition
removes all local values. desktop,
public and downloaded readers retain their own spacing. geometry callbacks report
`Layout` for endpoint/dimension changes and otherwise `Occlusion`; layout wins
when both change. reader-local feedback adds its measured height outside hidden
roots and follows current shell obstruction without changing endpoint extent.

keyboard reporting retains its existing stack owner: the newest sheet/task
report wins, and release restores the prior report. focused root text entry and
the expanded player sheet suppress and unregister the outer player frame;
playback continues. hiding reader controls retains its registration. ordinary
pane scrollports consume their nearest content clearance; readers consume their
explicit endpoint/occlusion contract. consumers never recalculate shell or
platform geometry independently.

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
visits. a visit is a canonical workspace href, unique uuid and nullable settled
title hint; duplicate visits to the same href retain independent presentation. the
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
stamp it was read under. complete value readers paint the visit snapshot and
reread; paged readers retain their stamp-based return policy (architecture §8.12).
`PaneRefreshAnchor` captures same-query row replacement before mutation and
restores one shared pane eye-line after layout, unless newer input intent wins.
large eligible indices register their complete ordered ids and measured row
geometry through `usePaneCollectionGeometry`. the same memento owns return,
refresh and measurement-change scroll writes; the row window owns measurement
and mounted demand only. restoration waits for affected descendants to finish
measurement, including sibling lists sharing this scrollport. logical ranks
locate unmounted anchors and choose the next full-order survivor after removal;
bounded row demand mounts a needed target before focus recovery. a connected
unrelated focus destination wins over a pending return.

`CollectionView` keeps the most recently interacted row and its neighbours
mounted in a large index; an active menu or drag adds scoped demand. this preserves
the source through menu/dialog handoff without a second overlay lifecycle. a
menu's existing geometry guard may retire it when geometry changes. the
collection's focus owner retains the logical source through its own portal and
recovers that source after remount, or the next survivor after removal. lists
through 200 stay fully mounted. larger windows retain complete data and filter
scope, while native find, selection and accessibility traversal inspect mounted
content only; see [resource presentation](resource-references.md#presentation-contract).

`usePaneVisitDataWriter` records an immutable snapshot
synchronously before a write or navigation can outlive its presentation. its
stable function uses the mounted visit's latest committed route key; callers
own delivery lifetime and stop writing after departure. it adds no task owner
or durable storage. `usePaneScrollRetention` holds the live offset across a
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

reader-to-chat from a selection forks by default (`openAsyncResult`'s
`disposition: "Fork"`), creating one adjacent pane even when the destination is
open; source activation uses `Follow`, and shifted activation `Fork`.
on a successful run the feature
route-`replace`s to consume the provisional history entry, so Back cannot
rehydrate a completed intent.
