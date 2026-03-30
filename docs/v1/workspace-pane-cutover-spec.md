# Workspace Pane Cutover — Full PR Spec / Plan

## Goal

Replace the authenticated web app's mixed layout systems with one unified pane workspace system.

After this PR:

- every authenticated route renders inside the same pane shell
- desktop uses a single horizontally tiled, horizontally resizable, horizontally scrollable pane strip
- mobile uses the same pane state model but shows one active pane at a time with a global tab switcher
- pane headers never scroll
- pane bodies own their own scrolling
- document readers keep their special inner pan/zoom viewport behavior
- all legacy pane/layout systems are deleted

This is a full cutover.

There is no backwards compatibility requirement for old workspace URL payloads, old pane components, old tab systems, or old split-surface behavior.

## Scope

In scope:

- authenticated layout shell
- workspace state model and URL codec
- global tab UI
- pane strip layout
- pane shell / pane body primitives
- desktop resize and horizontal overflow behavior
- mobile single-pane presentation and global tab switching
- route metadata and route rendering contract
- migration of all authenticated routes to the unified pane shell
- deletion of all legacy pane/page/split/tab wrappers and their tests

Out of scope:

- visual redesign of colors, typography, or branding
- drag-reorder for tabs
- saved named workspaces
- multi-window support
- persistent workspace restore outside the URL
- changes to backend APIs
- unauthenticated pages (`/login`, legal pages, etc.)

## Why This Must Be A Full Cutover

The current app has multiple incompatible top-level surface systems:

- `PageLayout` for generic routed pages
- `Pane` for some list/detail/media surfaces
- `PaneContainer` for older horizontal pane rows
- `SplitSurface` for media/detail paired panes
- `WorkspaceRoot` + `PaneGroup` + per-group `TabStrip` for the newer workspace
- a dead global `Tabsbar` component that is not the live tab system

These systems disagree on:

- who owns vertical scroll
- who owns horizontal scroll
- where tabs live
- where widths are stored
- how mobile adapts
- whether a "pane" is a route, a group, a split primary, or a page wrapper

This is the root cause of the current bugs.

No amount of local CSS patching is acceptable.

The PR must remove the multiple-systems architecture entirely.

## Non-Negotiable Product Contract

### Top-level shell layers

The authenticated app must have exactly these layout layers:

1. fixed app shell
2. fixed primary navigation
3. fixed global tabs control
4. fixed workspace viewport
5. fixed footer player
6. scrolling pane bodies inside the workspace viewport

No authenticated route may cause `body` or `html` to scroll during normal use.

### Desktop

Desktop must behave like a browser/tabbed knowledge workspace:

- panes are adjacent with no layout gaps
- panes live in one horizontal strip
- each pane has an explicit width
- resizing one pane changes only that pane's width
- panes to the right move because the strip reflows naturally
- no sibling pane is resized implicitly to "make room"
- if total pane width exceeds the viewport, the workspace viewport scrolls horizontally
- the global tabs bar remains visible while the workspace viewport scrolls underneath it

### Mobile

Mobile must use the same pane state model but a different presentation:

- only one active pane is visible at a time
- pane bodies scroll vertically inside the pane
- global tab switching is available from a single global tab switcher, not per-pane local tabs
- mobile must not use horizontal multi-pane panning as the primary interaction model
- media companion panes remain part of workspace state but are accessed via the global tab switcher, not a special split drawer

### Pane shell

Every pane must have exactly two structural regions:

1. pane chrome
2. pane body

Pane chrome contains:

- title
- subtitle / metadata
- back / previous / next controls where applicable
- route actions / options menu
- route toolbar controls

Pane chrome must never scroll with the pane body.

Pane body contains route-specific content only.

### Document exception

Document-like panes (`pdf`, `epub`, `web article`, transcript surfaces when needed) may contain an inner viewport.

The outer pane body still follows pane-shell rules.

The special behavior is limited to an inner `DocumentViewport`/reader container that owns:

- two-axis pan when appropriate
- zoomed content overflow
- selection/highlight interaction geometry

This is the only allowed exception to the default pane-body scroll rule.

## Target Architecture

### 1. Authenticated shell

The authenticated layout must become a single grid-based shell.

Required structure:

- left nav on desktop / bottom nav on mobile
- top global tabs layer inside the main app area
- workspace viewport below tabs
- footer player below workspace viewport

Use CSS grid for the main authenticated shell.

Do not rely on nested flex wrappers alone.

Every grid/flex child on the scroll path must declare `min-width: 0` and `min-height: 0`.

Canonical shell tree:

```tsx
<AuthenticatedLayoutShell>
  <PrimaryNavigation />
  <MainWorkspaceArea>
    <WorkspaceTabsBar />
    <WorkspaceViewport>
      <PaneStrip>
        {panes.map((pane) => (
          <PaneShell key={pane.id} paneId={pane.id} />
        ))}
      </PaneStrip>
    </WorkspaceViewport>
    <GlobalPlayerFooter />
  </MainWorkspaceArea>
</AuthenticatedLayoutShell>
```

Desktop shell contract:

- root shell owns the left nav column
- main workspace area owns exactly three rows:
  - global tabs
  - workspace viewport
  - footer player

Mobile shell contract:

- root shell owns the bottom nav row
- main workspace area still owns exactly three rows:
  - global tabs
  - workspace viewport
  - footer player

Do not introduce route-specific shell layers between `WorkspaceViewport` and `PaneShell`.

### 2. One workspace model

There is exactly one workspace.

There are no pane groups.

There are no nested tab groups.

There is one ordered pane list.

There is one active pane id.

All pane opening, closing, activation, resizing, and navigation operate on that single ordered pane list.

### 3. One global tabs system

Tabs represent panes, not groups.

There is one global tab control layer for the workspace.

Desktop:

- horizontally scrollable tabs bar
- one tab per pane in left-to-right pane order
- selecting a tab activates the matching pane and scrolls it into view if necessary
- closing a tab closes the pane

Mobile:

- one global tab switcher sheet/list
- same pane ordering
- same close behavior

Per-pane tab strips are forbidden.

### 4. One pane strip

Desktop workspace content must be a single pane strip.

Required CSS behavior:

- `display: flex`
- `flex-direction: row`
- `gap: 0`
- `overflow-x: auto`
- `overflow-y: hidden`

Every desktop pane wrapper must be:

- `flex: 0 0 auto`
- explicit width in pixels
- no flex-grow distribution

Unsized desktop panes are forbidden.

### 5. One pane shell primitive

Create one shared pane shell component for authenticated panes.

Canonical responsibilities:

- render pane chrome
- render pane body
- expose resize handle
- own chrome-vs-body mobile behavior
- support standard body mode and document body mode

Canonical non-responsibilities:

- route-specific fetching logic
- route-specific list rendering
- linked-items alignment logic
- global tab rendering
- workspace ordering logic

Use CSS grid inside the pane shell:

- `grid-template-rows: auto minmax(0, 1fr)`

Do not put pane chrome inside the pane body's scroll container.

### 6. Two pane body modes

The new pane shell must support exactly two body modes.

#### Standard body mode

Used by:

- discover
- search
- settings
- libraries
- conversations
- linked-items list panes
- podcast and video list/detail panes where no inner document viewport is required

Rules:

- outer pane shell body is the vertical scroll container
- `overflow-y: auto`
- `overflow-x: hidden`

#### Document body mode

Used by:

- PDF reader
- EPUB reader
- web article reader
- transcript/media panes when they need a dedicated inner reading viewport

Rules:

- outer pane shell body clips and does not itself become the interaction viewport
- inner document viewport owns `overflow: auto`
- pan/zoom/selection/highlight logic attaches to the inner document viewport only

### 7. Route contract

Route renderers must stop returning their own top-level shell wrappers.

No route may render:

- `PageLayout`
- `Pane`
- `PaneContainer`
- `SplitSurface`

Instead, each pane-renderable route must provide:

- route id
- static title
- resource ref resolver
- pane width defaults
- pane body mode
- header metadata/actions/options/toolbar provider
- body render function

The route registry becomes the source of truth for pane chrome and pane sizing metadata.

Route body components render content only.

Do not import Next app route `page.tsx` modules into the registry.

Instead:

- extract pane body components into normal component modules
- keep route entry files as thin route entrypoints only
- have the workspace route registry import body components, not route files

Recommended route registry contract:

```ts
export type PaneBodyMode = "standard" | "document";

export interface PaneChromeDescriptor {
  title: string;
  subtitle?: string | null;
  toolbar?: ReactNode;
  actions?: ReactNode;
}

export interface PaneRouteDefinition {
  id: PaneRouteId;
  pattern: readonly string[];
  staticTitle: string;
  bodyMode: PaneBodyMode;
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  resourceRef?: (params: RouteParams) => string | null;
  getChrome: (ctx: PaneRouteContext) => PaneChromeDescriptor;
  renderBody: (ctx: PaneRouteContext) => ReactNode;
  buildCompanionPanes?: (ctx: PaneRouteContext) => WorkspacePaneDraft[];
}
```

Required rule:

- width and body-mode metadata live in the route registry, never inside route body components

### 8. Shared body templates

The cutover should aggressively consolidate repeated body patterns.

At minimum, create shared body-level templates/helpers for:

- list/catalog panes
- sectioned settings/discover panes
- simple detail panes
- document/media panes

The exact names may vary, but the architecture must separate:

- shell
- shared body templates
- route-specific body content

## Required Store Contract

The new workspace store must be flat-pane-first and must not expose any group language.

The store may keep ephemeral caches for resolved titles and UI state, but persisted workspace state must remain flat and minimal.

## Target State Model

Replace the group-based workspace model with a flat pane list model.

Use a new schema version.

Persisted state must include only what is required to reconstruct pane layout.

Do not persist runtime titles in the URL.

Do not persist group state because groups no longer exist.

### Persisted invariants

- pane ids are unique
- pane order is stable and deterministic
- every pane has an explicit width
- `activePaneId` always points at an existing pane
- companion panes may only reference an existing source pane
- companion panes must appear immediately to the right of their source pane

### Ephemeral state

Keep ephemeral state out of the URL:

- runtime titles
- title cache
- hover/focus state
- mobile tab sheet open/closed state
- transient drag/resize session state

### URL codec rules

Use the existing `ws` query parameter concept, but replace the payload contract.

No compatibility with schema v2 is required.

Required behavior:

- `wsv=3` is the only supported encoded version
- if the URL has no workspace state, infer a one-pane state from the current route
- if the URL payload is invalid or an older version, discard it and infer a fresh one-pane state
- do not attempt to migrate old grouped states

### History rules

The URL is the durable workspace source of truth.

Required behavior:

- opening a pane pushes history
- closing a pane pushes history
- activating a different pane pushes history only if the URL payload changes
- navigating within an existing pane pushes or replaces history based on caller intent
- resizing panes must use `replaceState`, not `pushState`
- browser back/forward must reconstruct workspace layout from the URL without consulting deleted legacy code

The workspace must never become empty.

If the last remaining pane is closed, immediately replace the workspace with a single fallback pane using the default fallback href.

## Workspace Behavior Rules

### Open behavior

- standard click inside a pane navigates within the current pane
- explicit open-in-new-pane actions create a new pane immediately to the right of the source pane
- shift-click on supported links also opens a new pane immediately to the right of the source pane
- activating a pane from the global tabs UI scrolls it into view and focuses it

### Close behavior

- closing a pane removes exactly that pane
- if the closed pane is active, activate the nearest surviving pane
- if a source pane closes, all of its companion panes close in the same transaction
- closing a companion pane does not close its source pane
- closing the last remaining pane resets the workspace to one fallback pane rather than leaving zero panes

### Media companion behavior

Desktop media behavior:

- opening a media pane creates a content pane
- if the media route supports a linked-items companion, create that pane immediately to the right
- content pane and linked-items pane are just panes in the same strip
- no special `SplitSurface` wrapper exists

Mobile media behavior:

- opening media still creates both panes in workspace state when appropriate
- only one pane is visible at a time
- switching between content and linked-items happens through the global tab switcher
- no mobile split-surface drawer exists

### Width rules

Every pane gets a width at creation time from route metadata.

No desktop pane may rely on `width: 100%` or flex growth as its default sizing behavior.

Recommended default width table:

- standard list/settings/search/discover pane: `480`
- library detail / chat list / chat detail: `560`
- media content pane: `920`
- linked-items companion pane: `360`
- context companion pane: `420`

Required width bounds:

- global minimum pane width: `320`
- global maximum standard pane width: `1400`
- media content max width may be higher (`1800`)

All route metadata must declare:

- `defaultWidthPx`
- `minWidthPx`
- `maxWidthPx`

Width defaults inside route body components are forbidden.

### Resize rules

- resize handle changes only the target pane width
- workspace order does not change during resize
- panes to the right move because strip width changes
- no sibling width balancing logic
- resize handles must support keyboard access (`ArrowLeft`, `ArrowRight`, `Home`, `End`)
- pointer resize must capture drag on the handle only and must not depend on resizing the pane's siblings

### Scroll rules

There must be exactly one horizontal scroller on desktop:

- the workspace viewport / pane strip container

There must be exactly one vertical scroller per standard pane:

- the pane body

There must be exactly one interactive inner scroller per document pane:

- the inner document viewport

`body` scroll is forbidden during normal app usage.

Multiple nested vertical scrollers inside standard panes are forbidden unless a component is explicitly a bounded sub-panel (for example a queue popover or modal content area).

### Focus and accessibility rules

The new workspace must be keyboard-usable and screen-reader-legible.

Required behavior:

- global tabs bar uses tab semantics (`tablist`, `tab`, `tabpanel` or an equivalent accessible pattern)
- the active pane tab exposes `aria-selected="true"`
- closing a tab moves focus to the next surviving tab, or the previous one if there is no next tab
- resize handles are keyboard-focusable and expose an accessible label
- activating a tab scrolls the matching pane into view and moves logical focus into that pane's chrome
- mobile tab switcher traps focus while open and returns focus to the triggering control on close

Accessibility is part of the acceptance criteria, not a follow-up task.

## Layout / CSS Rules

These rules are mandatory.

### Global

- `html`, `body`, and authenticated root remain fixed-height and non-scrolling
- all app-level layout containers use `min-width: 0` and `min-height: 0`
- no authenticated route may use `min-height: 100vh` or `height: 100vh` for content surfaces

### Pane strip

- no `gap`
- no margin between panes
- visual separation comes from borders and resize affordances only

### Pane shell

- pane chrome is outside the body scroller
- pane body fills remaining height via `minmax(0, 1fr)`
- no pane shell may set `overflow-y: auto` on the same element that contains pane chrome

### Mobile

- mobile visible pane fills the workspace viewport
- bottom nav and safe area are handled at shell level, not by route-specific wrappers
- pane shell mobile chrome behavior is implemented once in the shared pane shell
- route-specific mobile chrome hide-on-scroll logic is forbidden
- inactive mobile panes are not laid out side-by-side offscreen; render only the active pane in the viewport

## Route Migration Rules

Every authenticated route must be migrated to the new contract.

### Generic routes

These routes must stop using `PageLayout` and render body content only:

- `/discover`
- `/documents`
- `/podcasts`
- `/videos`
- `/search`
- `/settings`
- `/settings/reader`
- `/settings/keys`
- `/settings/identities`

### Library routes

These routes must stop using `PaneContainer`/`Pane` as route-level wrappers and render body content only:

- `/libraries`
- `/libraries/[id]`

### Conversation routes

These routes must stop using `PaneContainer` and `SplitSurface` as route-level wrappers and render body content only:

- `/conversations`
- `/conversations/new`
- `/conversations/[id]`

### Media route

`/media/[id]` is the most important migration.

Required changes:

- remove `SplitSurface`
- remove route-level `Pane` wrappers
- render content pane and linked-items pane as separate workspace panes
- move media header/toolbars into route metadata + unified pane chrome
- preserve PDF/EPUB/web/transcript special body behavior through the document body mode only

## File-System Target Structure

The exact names may vary slightly, but the final structure must contain equivalents of:

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceShell.tsx`
- `apps/web/src/components/workspace/WorkspaceTabsBar.tsx`
- `apps/web/src/components/workspace/WorkspaceTabsSheet.tsx`
- `apps/web/src/components/workspace/PaneStrip.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/DocumentViewport.tsx`
- `apps/web/src/lib/workspace/schema.ts` rewritten for flat panes
- `apps/web/src/lib/workspace/store.tsx` rewritten for flat panes
- `apps/web/src/lib/workspace/urlCodec.ts` rewritten for flat panes
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` expanded to supply pane metadata + body render contract

Route body components may stay under current route files or be extracted, but the final architecture must make them shell-free.

This is preferable to importing `app/(authenticated)/**/page.tsx` files into the workspace registry.

## Code To Delete Entirely

The final PR must delete all of the following concepts:

- page-level layout shell as a separate authenticated route primitive
- split-surface desktop pair layout
- split-surface mobile drawer for companion panes
- grouped workspace state
- per-group tab strips
- old unused top tabs bar
- route-level pane wrappers

The final codebase must not contain authenticated-route imports of:

- `PageLayout`
- `PaneContainer`
- `SplitSurface`

The final codebase must not contain workspace components named:

- `PaneGroup`
- `TabStrip`

unless they are completely new components with new semantics, which is not recommended.

## Acceptance Criteria

### Architecture

- all authenticated routes render inside one unified workspace shell
- all authenticated panes use one shared pane shell
- there is one global tabs system
- there are no per-pane or per-group tab bars
- there is no grouped workspace state

### Desktop layout

- panes are adjacent with no gaps
- each pane has an explicit width from creation
- resizing one pane changes only that pane width
- sibling panes move horizontally rather than being resized
- the workspace horizontally scrolls when total pane width exceeds the viewport
- navbar and global tabs remain fixed while panes scroll horizontally underneath

### Desktop scroll behavior

- discover, search, settings, libraries, conversations, and catalogs all scroll vertically inside their pane bodies
- pane headers remain fixed and visible while pane bodies scroll
- no authenticated route causes body scroll during normal usage

### Mobile behavior

- every authenticated pane body scrolls correctly on mobile
- only one pane is visible at a time
- pane switching happens through one global tab switcher
- mobile does not use route-specific split drawers for linked items
- pane headers do not scroll with pane bodies

### Media behavior

- opening media on desktop results in a content pane plus a right-adjacent linked-items companion pane when applicable
- linked-items remain immediately adjacent to their source pane
- PDF keeps inner pan/zoom/scroll behavior
- EPUB and web article remain readable inside document-style panes
- transcript media preserve player/content behavior without `SplitSurface`

### Cleanup

- no authenticated route imports `PageLayout`
- no authenticated route imports `PaneContainer`
- no authenticated route imports `SplitSurface`
- no legacy workspace group/tab-strip code remains
- dead `Tabsbar` code is removed
- old tests for removed primitives are deleted or replaced, not left behind to assert obsolete behavior

## Validation / Test Plan

The PR must replace the current fragmented test coverage with tests for the new architecture.

### Component/unit tests required

- workspace schema round-trip for flat panes
- workspace store open / close / activate / resize / companion-close behavior
- workspace history codec behavior for push vs replace operations
- global tabs bar keyboard + close semantics
- pane shell scroll ownership
- pane shell keyboard resize
- mobile tab sheet behavior
- document body mode vs standard body mode behavior

### E2E tests required

- desktop: discover pane body scrolls while header stays fixed
- desktop: search pane body scrolls while header stays fixed
- desktop: settings pane body scrolls while header stays fixed
- desktop: multiple panes are adjacent with no visible gap
- desktop: resizing one pane translates panes to the right
- desktop: workspace horizontally scrolls when panes overflow viewport width
- desktop: global tabs stay visible while horizontal pane scrolling occurs
- desktop: opening media creates adjacent content + linked-items panes
- mobile: discover/search/settings/library/media pane bodies all scroll vertically
- mobile: only one pane is visible at a time
- mobile: global tab switcher opens, selects panes, closes panes
- mobile: media companion pane is accessible via the global tab switcher

### Structural grep checks required

Implementation is not complete if any of the following still return authenticated-surface matches:

- `rg "PageLayout" apps/web/src/app/(authenticated) apps/web/src/components`
- `rg "PaneContainer" apps/web/src/app/(authenticated) apps/web/src/components`
- `rg "SplitSurface" apps/web/src/app/(authenticated) apps/web/src/components`
- `rg "PaneGroup|TabStrip|Tabsbar" apps/web/src/components/workspace apps/web/src/components`
- `rg "AuthenticatedWorkspaceHost|WorkspaceV2Host" apps/web/src/components`
- `rg "groups|activeGroupId|activateGroup|openGroupWithTab|closeGroup|setGroupWidth" apps/web/src/lib/workspace`

## Explicit Failure Conditions

The PR is wrong if any of the following are true:

- a route still renders its own top-level pane or page shell
- desktop panes still use flex-grow as their default width behavior
- tabs still exist inside individual panes
- media still depends on `SplitSurface`
- generic pages still rely on `PageLayout` scroll behavior
- mobile scrolling is fixed by unlocking `body` scroll
- the implementation keeps old grouped workspace code "temporarily"
- the implementation adds compatibility adapters instead of deleting old code

## Definition Of Done

This cutover is done only when:

- one workspace model exists
- one pane shell exists
- one global tabs system exists
- one desktop pane strip exists
- mobile uses the same pane state with a single-pane presentation
- document panes preserve their special reader viewport behavior
- all legacy shell/split/tab/group code is deleted
- the new tests prove the scroll and layout contract end to end
