# Pane Surface Kit And ResourceRow Hard Cutover

## Status

Implemented 2026-06-12 in `work/pane-surface-kit-resource-row`.

Verification completed with targeted frontend gates:

- `bun run typecheck`
- `bun run lint`
- `bun run lint:css-tokens`
- `bun run test:unit -- src/lib/ui/paneSurfaceCutover.guards.test.ts`
- Browser shards covering `PaneSurface`, `PaneSection`, `ResourceRow`, Browse,
  Search, Notes, Conversations, Libraries, Library detail, Authors, Author
  detail, Podcast detail, and Settings panes.

The source gates for deleted primitives and migrated local row/list hooks are
implemented in `apps/web/src/lib/ui/paneSurfaceCutover.guards.test.ts`.

This is a hard-cutover plan. It does not preserve legacy pane body wrappers,
legacy list primitives, duplicate row CSS, compatibility shims, or fallback
render paths. At the end of the cutover there is one authenticated standard
pane-body layout primitive, one resource-list primitive, and one resource-row
primitive. The old local shells and row systems are deleted or folded into the
new owners.

## Summary

The authenticated frontend shell is strong: `WorkspaceHost` owns pane
composition, `PaneShell` owns pane frame/chrome/body scroll mode, and pane
bodies consume shell state through the pane runtime boundary. Inside the pane
body, though, the app repeatedly rebuilds the same product grammar:

- `SectionCard` plus a local `.content` wrapper for the top-level pane surface.
- Local toolbar/search/filter layouts.
- Local loading/error/empty placement.
- Local list spacing.
- Local row anatomy, metadata, badges, thumbnails, trailing actions, and
  activation behavior.

The first slice migrates Browse because it is small enough to finish but rich
enough to prove the row contract: it has filters, async actions, four result
families, thumbnails, nested buttons, loading, empty states, and URL-driven
pane routing. After Browse, the same primitive family migrates Search, Notes,
Libraries, Authors, Podcasts, Conversations, and Settings. The cutover ends by
deleting `SectionCard`, `AppList`, `AppListItem`, and any direct pane-body
dependency on `ContextRow`.

The new surface family is intentionally small:

- `PaneSurface`: the standard pane-body surface and state/toolbar host.
- `PaneSection`: the framed section primitive for real nested sections inside a
  pane, replacing `SectionCard`.
- `ResourceList`: the vertical list semantics and spacing owner.
- `ResourceRow`: the row anatomy and activation semantics owner.

Domain-specific adapters may remain, for example `SearchResultRow`, but they
must compose `ResourceRow`. They may not own row chrome or keyboard/click
semantics.

## SME Framing

The wrong question is "how do we make Browse prettier." The right questions
are:

- **Who owns pane-body structure?** The shell owns the pane frame; the pane
  body owns domain data. The repeated middle layer is missing. `PaneSurface`
  becomes that layer.
- **Who owns row semantics?** A resource row is a repeated product capability,
  not a local CSS pattern. It should be one component with real links/buttons,
  predictable nested-action behavior, and consistent metadata layout.
- **What is the lowest reusable abstraction that is not hollow?** The primitive
  owns only stable anatomy, spacing, state placement, and activation semantics.
  It does not fetch, normalize, route, ingest, follow, subscribe, sort, or
  decide resource identity.
- **Where should the first slice land?** Start with Browse, not Notes. Notes is
  a useful smoke test for `PaneSurface`, but Browse proves the hard part:
  multiple row types, async primary actions, trailing actions, filters, load
  more, thumbnail/fallback handling, and row activation.
- **How do we keep this from becoming a second design system?** Make the API
  slot-based, make illegal row activation states unrepresentable, migrate every
  consumer, then delete the old primitives and add negative grep gates. No
  variants until a real migrated call site needs one.

The production-grade move is not to add a convenience wrapper around each
current pane. It is to establish the pane-body grammar as a capability contract,
prove it on Browse, migrate every comparable pane body, and remove the
competing local grammars.

## Existing Architecture Boundaries

These boundaries stay intact.

- `docs/architecture.md` documents authenticated routes as client pane-system
  content, not ordinary nested Next children. Pane bodies are rendered by the
  pane registry and hosted by the workspace shell.
- `docs/modules/workspace.md` documents the workspace module as the owner of
  authenticated pane composition.
- `docs/modules/panes-tabs.md` documents primary panes as workspace-owned route
  containers, with mobile mounting one active primary pane and no desktop
  chrome.
- `apps/web/src/components/workspace/WorkspaceHost.tsx` owns route selection,
  body mode, sizing, secondary/fixed chrome publication, and rendering
  `PaneRuntimeFrame` plus `PaneShell`.
- `apps/web/src/components/workspace/PaneShell.tsx` owns pane frame, chrome,
  body scroll mode, toolbar publication, fixed chrome, resize handle, and
  secondary-pane mounting.
- `apps/web/src/lib/panes/paneRouteModel.ts` owns route ids and body modes.
  `browse` and `notes` are standard body-mode panes.
- `apps/web/src/lib/panes/paneRenderRegistry.tsx` is the only module that
  imports pane bodies.

`PaneSurface` must not move any of that ownership. It starts inside the pane
body, below `PaneShell`, and above domain-specific content.

## Governing Repo Rules

The cutover follows the current repository rules:

- `docs/rules/cleanliness.md`: one owner per concern, collapse duplication,
  avoid hollow generic helpers, keep public surfaces small and semantic.
- `docs/rules/cleanliness.md`: one primary form per capability, prefer an
  existing capability over inventing another surface.
- `docs/rules/simplicity.md`: fewer code paths, no speculative options or
  flags until a real call site needs them.
- `docs/local-rules/testing_standards.md`: UI behavior gets component/browser
  coverage where interaction and accessibility matter; integration and E2E
  tests exercise real flows without mock API servers.

## Current Duplication Inventory

### Top-Level Pane Surfaces

These panes use the same top-level pattern in slightly different local forms:

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
  imports `SectionCard`, wraps the body in `SectionCard > .content`, and owns
  local `.section`, `.resultRows`, `.row`, `.primary`, `.leading`, `.copy`,
  `.actions`, `.loadMore`, filter, and empty-state CSS.
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
  imports `SectionCard`, wraps the body in `SectionCard > .content`, and uses
  local `.resultRows`.
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
  imports `SectionCard`, wraps the body in `SectionCard > .content`, and uses
  `AppList`/`AppListItem`.
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  imports `SectionCard`, wraps the library detail body in `SectionCard >
  .content`, and owns rich item row/action/sort behavior.
- `apps/web/src/app/(authenticated)/authors/AuthorsPaneBody.tsx` and
  `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
  import `SectionCard` and use `AppList`/`AppListItem` for related resource
  rows.
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` and
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
  import `SectionCard`; podcast episode rows use `AppListItem`.
- `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx`,
  `settings/appearance`, `settings/billing`, `settings/identities`, and
  `settings/local-vault` use `SectionCard` for either a top-level pane surface
  or nested form sections.
- `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx` does not use
  `SectionCard`, but it locally owns the same pane-body grammar: shell,
  toolbar, loading/error placement, `.pageList`, `.pageLink`, `.pageTitle`,
  and `.pageDescription`.
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
  uses `AppList`/`AppListItem` and local empty/loading/error placement.

### Existing Shared Primitives

The codebase already contains pieces that should be reused or consolidated:

- `ContextRow` is the closest existing row anatomy: leading, title,
  description, meta, trailing, actions, expanded content, and optional `href`.
- `AppList`/`AppListItem` wrap `ContextRow`, but they are too generic and have
  become a parallel row API.
- `SearchResultRow` composes `ContextRow`, which makes it the best migration
  pattern for a domain adapter that should remain while delegating chrome to
  `ResourceRow`.
- `FeedbackNotice` and `PaneLoadingState` are already the right loading/error
  primitives. `PaneSurface` should place them; it should not replace them.
- `ActionBar`, `ActionMenu`, `Tabs`, `Button`, and `Input` remain the right
  control primitives. `PaneSurface` should host toolbars and filters; it should
  not invent a new control library.

### Why The Existing Pieces Are Not Enough

- `SectionCard` frames arbitrary content but does not encode pane-body state,
  toolbar, list, or row semantics. It is used as a top-level pane surface in
  many places and as a true nested card in others, which makes ownership
  ambiguous.
- `AppListItem` is list-oriented but underpowered for Browse-style rows:
  primary async activation, trailing async controls, thumbnail/fallback,
  badges, status, and nested control behavior are local again.
- `ContextRow` is useful row anatomy but not a product-level resource row
  contract. It allows direct use without resource semantics and therefore does
  not stop row behavior from fragmenting.
- Browse's four local row implementations duplicate the same layout and
  keyboard/click pattern four times, including `div role="button"` activation
  that should be real links or buttons.

## Target Behavior

After the cutover:

- Every standard authenticated pane body starts with `PaneSurface`.
- Every repeated resource list uses `ResourceList`.
- Every repeated resource row uses `ResourceRow` directly or through a thin
  domain adapter that composes `ResourceRow`.
- Top-level pane bodies no longer import `SectionCard`, `AppList`,
  `AppListItem`, or `ContextRow`.
- Browse result rows are real links or real buttons, never `div role="button"`.
- Nested row actions never trigger the row's primary activation.
- Loading, error, info, and empty states appear in a consistent location within
  the pane surface.
- Search/filter/toolbars have consistent spacing and responsive behavior, while
  business logic stays in the pane body.
- Settings panes use `PaneSection` for real framed form sections inside a
  `PaneSurface`; `SectionCard` is deleted.
- Document-mode reader/editor bodies keep their document body-mode contracts.
  They adopt `ResourceRow` only for repeated resource rows inside side panels
  or subviews, not by forcing reader content into the standard pane surface.

## Goals

- **G1.** Create one standard pane-body surface contract below `PaneShell` and
  above pane-domain content.
- **G2.** Create one resource-row contract with accessible activation,
  consistent row anatomy, stable layout, and predictable nested actions.
- **G3.** Start with Browse and migrate it completely, including the four
  result-family rows, filter/search shell, state placement, and load-more
  affordance.
- **G4.** Migrate all standard pane-list surfaces: Browse, Search, Notes,
  Libraries, Library detail, Authors, Author detail, Podcasts, Podcast detail,
  Conversations, and Settings panes.
- **G5.** Fold or delete the old competing primitives: `SectionCard`,
  `AppList`, `AppListItem`, and direct pane-body use of `ContextRow`.
- **G6.** Preserve all route, data, cache, hydration, pane-runtime, and server
  loader contracts. This is a frontend composition cutover, not a backend or
  routing cutover.
- **G7.** Add tests that prove row activation, nested controls, hydration paint,
  and key migrated pane flows.
- **G8.** Add negative source gates so the old local grammars do not return.

## Non-Goals

- **N1.** No backend API, database, ingestion, subscription, search ranking, or
  hydration schema changes.
- **N2.** No route model or pane runtime changes. `PaneSurface` does not import
  `paneRuntime`, `WorkspaceHost`, `PaneShell`, or pane route models.
- **N3.** No virtualized list abstraction. Existing list sizes and pagination
  remain as-is.
- **N4.** No saved views, command palette changes, or global filtering model.
- **N5.** No design-system rewrite. This is a small capability family for pane
  bodies and resource rows.
- **N6.** No feature flags, compatibility wrappers, or dual old/new row lanes.
- **N7.** No one universal resource-data adapter. Domain panes keep their
  resource-specific view models and action handlers.
- **N8.** No forced migration of reader document surfaces to `PaneSurface`.
  Standard list panes are in scope; document/bodyMode-specific readers are not
  top-level list panes.

## Scope

### In Scope

- Shared UI primitives under `apps/web/src/components/ui`.
- Authenticated standard pane bodies under `apps/web/src/app/(authenticated)`.
- Domain row adapters that currently wrap `ContextRow` or `AppListItem`.
- CSS modules for the migrated panes.
- Component/unit/browser tests for the new primitives and migrated panes.
- Source-gate tests that forbid the deleted primitives and old local patterns.

### Out Of Scope

- Backend routes and Python services.
- `WorkspaceHost`, `PaneShell`, `PaneRuntimeFrame`, and route registry behavior.
- Reader document layout, transcript layout, and editor internals, except for
  repeated resource-row sublists that can naturally compose `ResourceRow`.
- Oracle surfaces, unless they independently duplicate the exact same pane-list
  contract after the authenticated cutover is complete.

## Final Architecture

### Ownership Map

| Concern | Final owner | Notes |
|---|---|---|
| Pane frame, chrome, body mode, resize, secondary/fixed chrome | `PaneShell` / `WorkspaceHost` | Unchanged. |
| Standard pane-body spacing, toolbar slot, state slot, footer slot | `PaneSurface` | New top-level owner inside pane body. |
| Framed nested section inside a pane | `PaneSection` | Replaces `SectionCard`. |
| Repeated resource-list semantics and spacing | `ResourceList` | Owns list structure, gaps, optional section labels. |
| Resource row anatomy and activation semantics | `ResourceRow` | Owns link/button/static row contract and nested-action guard. |
| Domain result normalization and action handlers | Pane body or domain adapter | Browse, Search, Libraries, Podcasts, etc. remain domain owners. |
| Loading/error/notice rendering primitive | `PaneLoadingState`, `FeedbackNotice` | Reused, not replaced. |
| Control widgets | `Button`, `Input`, `ActionMenu`, `ActionBar`, `Tabs`, etc. | Reused, not wrapped unless needed by real call sites. |

### Dependency Direction

```
WorkspaceHost / PaneShell
  -> pane body
      -> PaneSurface
          -> PaneSection
          -> ResourceList
              -> ResourceRow
                  -> ContextRow internals only if retained privately

pane body
  -> domain APIs, resources, routing, action handlers
  -> ResourceRow slots and callbacks

ResourceRow
  -> shared UI atoms only
  -/-> pane runtime
  -/-> workspace
  -/-> domain APIs
  -/-> data fetching
```

`ResourceRow` may internally reuse `ContextRow` during implementation only if
`ContextRow` becomes private to `ResourceRow` or has no direct pane-body
callers. There must not be two public row APIs after the cutover.

## Capability Contract

### `PaneSurface`

`PaneSurface` is the standard pane-body layout owner. It is not a card and not
a shell. It starts at the body content boundary supplied by `PaneShell`.

It owns:

- vertical pane-body spacing;
- responsive padding and max-inline constraints for standard panes;
- toolbar/search/filter slot placement;
- loading/error/info/empty slot placement;
- main content slot;
- optional footer/action slot;
- CSS token usage for pane-body background and borders.

It does not own:

- pane frame, scroll mode, chrome, fixed toolbar, secondary pane, or resizing;
- data fetching or hydration;
- route parsing, pane navigation, or title publication;
- filter state machines;
- action menus or specific controls;
- document-reader layout.

Proposed API:

```tsx
type PaneSurfaceProps = {
  toolbar?: React.ReactNode;
  state?: React.ReactNode;
  empty?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
};

function PaneSurface(props: PaneSurfaceProps): JSX.Element;
```

Rules:

- `toolbar` renders before state and content.
- `state` is for `FeedbackNotice`, `PaneLoadingState`, and informational bands.
- `empty` renders only when the pane body passes it. The primitive does not
  infer empty from `children`.
- `children` is the main content. It is not wrapped in a card.
- `footer` is for load-more and sticky/non-sticky pane-local actions.
- No `variant` prop in the first implementation. Add only when two migrated
  call sites prove a real structural difference.

### `PaneSection`

`PaneSection` is a framed section inside a `PaneSurface`. It replaces
`SectionCard`.

It owns:

- a section frame when a frame is semantically needed;
- optional title/description header;
- section body spacing.

It does not own:

- top-level pane-body layout;
- resource-list row semantics;
- form state.

Proposed API:

```tsx
type PaneSectionProps = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

function PaneSection(props: PaneSectionProps): JSX.Element;
```

Rules:

- Use `PaneSection` for settings cards, billing panels, identity groups, local
  vault sections, and true nested groups.
- Do not use `PaneSection` as the outer pane-body wrapper.
- Delete `SectionCard` once all callers migrate.

### `ResourceList`

`ResourceList` owns repeated resource-list structure and spacing.

It owns:

- list semantics (`ul`/`li`) where rows are homogeneous navigable resources;
- `div role="list"` fallback only for layouts that cannot validly use list
  markup because of an existing owner such as a sortable library;
- vertical gap and section spacing;
- optional list label/description slot when a pane has several groups.

It does not own:

- sorting state;
- pagination or load-more;
- row activation;
- section filtering;
- data normalization.

Proposed API:

```tsx
type ResourceListProps = {
  label?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

function ResourceList(props: ResourceListProps): JSX.Element;
```

Rules:

- `ResourceRow` is the expected child.
- If `SortableList` or another library already owns item semantics, compose
  `ResourceRow` inside that owner and do not double-wrap in `ResourceList`.
- Do not create per-pane `.resultRows`, `.pageList`, or `.list` spacing copies.

### `ResourceRow`

`ResourceRow` owns row anatomy and activation. It is presentational plus
interaction semantics, not a data model.

It owns:

- leading media/icon/fallback slot;
- title, eyebrow/badges, description, metadata, contributors/status slots;
- trailing/action slots;
- busy/disabled/selected visual states;
- real link/button/static activation semantics;
- nested interactive control guard;
- keyboard activation for button rows;
- consistent focus, hover, and responsive wrapping behavior.

It does not own:

- resource identity;
- `ResourceDescriptor`;
- fetching, ingestion, following, subscription, library assignment, sorting, or
  transcript actions;
- pane routing policy;
- title publication beyond forwarding link attributes supplied by the caller.

Activation must be a discriminated union so illegal states are unrepresentable:

```tsx
type ResourceRowPrimary =
  | {
      kind: "link";
      href: string;
      paneTitleHint?: string;
      target?: "_self" | "_blank";
    }
  | {
      kind: "button";
      onActivate: () => void | Promise<void>;
      disabled?: boolean;
      busy?: boolean;
      label: string;
    }
  | {
      kind: "static";
    };

type ResourceRowProps = {
  primary: ResourceRowPrimary;
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  badges?: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  contributors?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  actions?: React.ReactNode;
  expanded?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
};

function ResourceRow(props: ResourceRowProps): JSX.Element;
```

Rules:

- Link rows use a real `<a>`.
- Button rows use a real `<button type="button">`.
- Static rows do not attach pointer or keyboard activation.
- If a row has trailing actions, the primary activation target is the primary
  sub-element, not the entire outer row.
- If an implementation supports outer-row click affordance, it must ignore
  events from `a`, `button`, `input`, `textarea`, `select`, `[role="button"]`,
  `[role="menuitem"]`, and `[data-row-action]`.
- `data-pane-title-hint` is forwarded only when provided by a link row caller.
- Domain adapters may precompose title/meta/actions, but they cannot replace
  the activation contract.

## API Design Principles

- **Slot-based over data-shape-based.** The primitives receive rendered slots
  and activation contracts. They do not know what a podcast, note page, library
  item, or search result is.
- **Few public components.** `PaneSurface`, `PaneSection`, `ResourceList`, and
  `ResourceRow` are the public surface. Internal helpers stay private.
- **No variant soup.** Start with no broad `variant` enum. Add named structural
  props only when a migrated call site proves the difference is real.
- **Illegal activation states are type errors.** A row cannot be both link and
  button. A static row cannot receive an activation handler.
- **Real HTML first.** Prefer `<a>`, `<button>`, `<ul>`, and `<li>` over ARIA
  roles. Use ARIA only when the host structure requires it.
- **Composition over ownership creep.** Pane bodies keep domain behavior and
  pass slots/callbacks into the primitives.
- **Delete after migration.** Once a caller is migrated, remove the old local
  CSS in the same slice. Once all callers are migrated, delete the old shared
  primitive.

## Composition With Other Systems

### Workspace And Pane Runtime

`PaneSurface` is below `PaneShell`; it has no knowledge of pane route ids, body
modes, pane widths, secondary panes, or fixed chrome. Links inside
`ResourceRow` continue to be captured by the existing pane link-routing
boundary. `paneTitleHint` is forwarded as an attribute for the existing routing
and title systems; `ResourceRow` does not compute pane titles.

### Hydration And Resources

`PaneSurface` and `ResourceRow` do not call `useResource`. Existing pane bodies
keep resource keys and server-seeded cache contracts:

- Notes keeps `notePagesResource` and the AC-4 hydration hit test.
- Libraries and library detail keep their seeded resource contracts.
- Authors and media-related panes keep their hydration tests.
- Browse remains query-driven and unprefetched, matching the existing server
  loader exclusion.

### Search And Browse

Search and Browse remain separate domain surfaces. The cutover centralizes
layout and rows only:

- Browse keeps `browseState.ts`, URL query parsing/building, follow/add/open
  actions, and load-more state.
- Search keeps `lib/search` query/result view models and `SearchPaneBody`
  behavior.
- `SearchResultRow` may remain as a search-domain adapter, but it must render
  `ResourceRow`.

### Sortable Lists

Library detail has sortable item behavior. The final state should not double
own list semantics:

- `SortableList` keeps drag/drop and ordering.
- The item renderer uses `ResourceRow` for row anatomy and actions.
- `ResourceList` is not wrapped around a list already owned by `SortableList`.

### Settings Forms

Settings panes are not resource lists, but they repeat top-level pane surface
and framed section grammar:

- Settings pane roots use `PaneSurface`.
- Settings groups use `PaneSection`.
- Rows that represent identities, providers, passwords, or destinations use
  `ResourceRow` when they are row-shaped resources.
- Forms keep their local validation and submit handlers.

### Loading, Feedback, And Empty States

`FeedbackNotice` and `PaneLoadingState` stay canonical. `PaneSurface` places
them consistently through its `state` and `empty` slots. It does not create a
second feedback primitive.

### CSS Tokens And Responsive Layout

The new CSS modules must use existing tokens. No raw color values unless
already allowed by the CSS token guard. Row layout must have stable leading,
content, and action zones so badges, hover states, loading text, and long
titles do not resize the overall structure incoherently.

## Key Decisions

1. **Browse is first.** It exercises the full grammar and prevents a
   Notes-only primitive that cannot handle real rows.
2. **`PaneSurface` is not `SectionCard` renamed.** It is the top-level pane-body
   layout owner. `PaneSection` is the framed nested-section replacement.
3. **`ResourceRow` replaces public `ContextRow` usage.** The implementation may
   reuse `ContextRow` privately, but pane bodies and domain adapters should
   consume `ResourceRow`.
4. **`AppList` is deleted.** Its capability becomes `ResourceList` plus
   `ResourceRow`.
5. **Domain adapters are allowed.** `SearchResultRow`, `PodcastEpisodeRow`, or
   a local `BrowseResultRow` can remain if they contain domain mapping, but row
   chrome and activation semantics live in `ResourceRow`.
6. **No fallback mode.** A migrated pane does not keep old CSS classes or old
   row paths for "just in case."
7. **No route or hydration changes.** This cutover is strictly composition and
   UI behavior.
8. **Document-mode panes are not forced into the standard surface.** The pane
   route model already distinguishes body modes; this cutover respects that
   boundary.

## Migration Plan

### S0 - Build The Primitives And Tests

Files:

- Add `apps/web/src/components/ui/PaneSurface.tsx`.
- Add `apps/web/src/components/ui/PaneSurface.module.css`.
- Add `apps/web/src/components/ui/PaneSection.tsx`.
- Add `apps/web/src/components/ui/PaneSection.module.css`.
- Add `apps/web/src/components/ui/ResourceList.tsx`.
- Add `apps/web/src/components/ui/ResourceList.module.css`.
- Add `apps/web/src/components/ui/ResourceRow.tsx`.
- Add `apps/web/src/components/ui/ResourceRow.module.css`.
- Add unit/browser tests under `apps/web/src/__tests__/components/ui`.

Required tests:

- `ResourceRow` renders link, button, and static rows with correct semantics.
- Button row invokes `onActivate` on click and keyboard activation.
- Link row forwards `href` and `data-pane-title-hint`.
- Disabled/busy button rows do not activate.
- Nested action buttons do not trigger primary activation.
- Long title/metadata/action combinations remain contained in browser coverage.
- `PaneSurface` orders toolbar, state, content, empty, and footer slots
  predictably.
- `PaneSection` covers titled and untitled sections.

### S1 - Browse First

Files:

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/page.module.css`
- Add or update `BrowsePaneBody` tests.

Work:

- Replace `SectionCard > .content` with `PaneSurface`.
- Move the search form and `BrowseTypeFilters` into the `toolbar` slot.
- Render loading/error/info/empty through the `state`/`empty` slots.
- Replace the four local row bodies with either one local
  `BrowseResultRow` adapter or four tiny adapters that all render
  `ResourceRow`.
- Use `ResourceList` for each result section.
- Convert current `div role="button"` primary areas to link or button rows.
- Keep `ensureAndOpenPodcast`, `followPodcast`, `addAndOpenResult`,
  `loadMore`, URL param handling, and `browseState.ts` unchanged except for
  call-site wiring.
- Delete migrated browse CSS: `.content`, duplicated row anatomy, `.resultRows`,
  `.row`, `.primary`, `.leading`, `.copy`, `.actions`, and local hover/focus
  states now owned by the primitives.

Acceptance for S1:

- Browse search/filter behavior is unchanged.
- Existing add/follow/open actions still work.
- Nested row action buttons do not open the row primary target.
- No `role="button"` remains in `BrowsePaneBody`.
- Browse has no top-level `SectionCard` import.

### S2 - Search

Files:

- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/search/page.module.css`
- `apps/web/src/components/search/SearchResultRow.tsx`
- `apps/web/src/__tests__/components/SearchResultRow.test.tsx`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.test.tsx`

Work:

- Replace `SectionCard > .content` with `PaneSurface`.
- Put search input/filter controls in the `toolbar` slot.
- Use `ResourceList` for results.
- Change `SearchResultRow` from `ContextRow` to `ResourceRow`.
- Delete local `.resultRows` and redundant content CSS.

Acceptance for S2:

- Search filter chip tests keep passing.
- Search result links keep route behavior and title hints.
- `SearchResultRow` no longer imports `ContextRow`.

### S3 - Notes And Conversations

Files:

- `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/notes/notes.module.css`
- `apps/web/src/app/(authenticated)/notes/NotesPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/__tests__/components/ConversationsPaneBody.test.tsx`

Work:

- Notes uses `PaneSurface` with its create button in the toolbar.
- Notes page links become `ResourceRow` link rows inside `ResourceList`.
- Preserve `notePagesResource` and the AC-4 hydration hit behavior.
- Conversations uses `PaneSurface`, `ResourceList`, and `ResourceRow`.
- Delete `pageList`, `pageLink`, `pageTitle`, and `pageDescription` CSS after
  migration.

Acceptance for S3:

- Notes paints seeded page titles without fetching `/api/notes/pages`.
- Create-page behavior still navigates to the new note.
- Conversations loading/empty/error states stay intact.

### S4 - Libraries And Library Detail

Files:

- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.ac4.test.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.ac4.test.tsx`
- associated library CSS modules.

Work:

- Libraries index uses `PaneSurface`, `ResourceList`, and `ResourceRow`.
- Library detail replaces top-level `SectionCard > .content` with
  `PaneSurface`.
- Sortable item renderers compose `ResourceRow`; `SortableList` keeps sorting
  semantics.
- Library item actions remain pane-domain owned.
- Delete `AppList` usage.

Acceptance for S4:

- Libraries AC-4 hydration tests keep passing.
- Library detail AC-4 hydration tests keep passing.
- Drag/sort behavior is unaffected.
- Row trailing actions do not trigger row activation.

### S5 - Authors And Author Detail

Files:

- `apps/web/src/app/(authenticated)/authors/AuthorsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/AuthorsPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.ac4.test.tsx`

Work:

- Replace outer `SectionCard` usage with `PaneSurface`.
- Replace `AppList` rows with `ResourceList` and `ResourceRow`.
- Keep author resource loading, load-more, and relationship logic unchanged.

Acceptance for S5:

- Authors tests and author detail hydration tests keep passing.
- Related works render with the shared row anatomy.

### S6 - Podcasts

Files:

- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeList.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeRow.tsx`
- existing podcast tests.

Work:

- Podcast index uses `PaneSurface`, `ResourceList`, and `ResourceRow`.
- Podcast detail replaces top-level `SectionCard` wrappers with
  `PaneSurface`/`PaneSection` as appropriate.
- Podcast episode rows use `ResourceRow`.
- Subscription/settings modal stays modal-owned; only row/surface duplication
  is migrated.

Acceptance for S6:

- Subscribe, follow, episode navigation, and episode actions still pass current
  tests.
- Episode rows no longer import `AppListItem`.

### S7 - Settings

Files:

- `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx`
- `settings/appearance/SettingsAppearancePaneBody.tsx`
- `settings/billing/SettingsBillingPaneBody.tsx`
- `settings/identities/SettingsIdentitiesPaneBody.tsx`
- `settings/identities/PasswordRow.tsx`
- `settings/keys/SettingsKeysPaneBody.tsx`
- `settings/local-vault/SettingsLocalVaultPaneBody.tsx`
- associated tests and CSS modules.

Work:

- Settings roots use `PaneSurface`.
- Framed groups use `PaneSection`.
- Row-shaped settings entries use `ResourceRow`.
- Form content stays local.
- Delete `SectionCard` imports.
- Delete `AppList`/`AppListItem` imports.

Acceptance for S7:

- Settings tests keep passing.
- Form submit, loading, success, and error states are unchanged.
- `SectionCard` no longer has authenticated settings callers.

### S8 - Delete Old Shared Primitives

Files:

- Delete `apps/web/src/components/ui/SectionCard.tsx`.
- Delete `apps/web/src/components/ui/SectionCard.module.css`.
- Delete `apps/web/src/components/ui/AppList.tsx`.
- Delete `apps/web/src/__tests__/components/AppList.test.tsx`.
- Delete or privatize `ContextRow` if no non-resource callers remain.

Work:

- Remove old tests or replace them with `ResourceList`/`ResourceRow` tests.
- Remove imports and dead CSS.
- Add source gates for deleted primitives and local duplicate row classes.

Acceptance for S8:

- `rg "SectionCard" apps/web/src` returns no runtime imports.
- `rg "AppList|AppListItem" apps/web/src` returns no runtime imports.
- `rg "ContextRow" apps/web/src/app apps/web/src/components` returns only the
  allowed private implementation path, or no results if folded into
  `ResourceRow`.

### S9 - Final Cleanup And Documentation

Files:

- Update this spec status after implementation and verification.
- Add a short module note if the UI primitives directory has an index/readme
  convention.
- Remove obsolete CSS classes in migrated pane modules.

Work:

- Run source gates.
- Run targeted tests.
- Run typecheck, lint, and CSS token checks.
- Do a desktop and mobile visual/browser pass for Browse, Search, Notes, and
  one settings pane because those cover the new grammar.

## Final File Set

New shared primitives:

- `apps/web/src/components/ui/PaneSurface.tsx`
- `apps/web/src/components/ui/PaneSurface.module.css`
- `apps/web/src/components/ui/PaneSection.tsx`
- `apps/web/src/components/ui/PaneSection.module.css`
- `apps/web/src/components/ui/ResourceList.tsx`
- `apps/web/src/components/ui/ResourceList.module.css`
- `apps/web/src/components/ui/ResourceRow.tsx`
- `apps/web/src/components/ui/ResourceRow.module.css`

Primary migrated panes:

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/page.module.css`
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/app/(authenticated)/search/page.module.css`
- `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/notes/notes.module.css`
- `apps/web/src/app/(authenticated)/conversations/ConversationsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/AuthorsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeList.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeRow.tsx`
- settings pane files listed in S7.

Likely deleted or folded:

- `apps/web/src/components/ui/SectionCard.tsx`
- `apps/web/src/components/ui/SectionCard.module.css`
- `apps/web/src/components/ui/AppList.tsx`
- direct public use of `apps/web/src/components/ui/ContextRow.tsx`

## Acceptance Criteria

### Product Behavior

- **AC-1.** Browse, Search, Notes, Libraries, Authors, Podcasts,
  Conversations, and Settings keep their existing user-visible workflows.
- **AC-2.** Browse result rows support the same primary actions and trailing
  actions as today.
- **AC-3.** Notes still paints server-seeded page titles with no initial
  `/api/notes/pages` fetch.
- **AC-4.** Library, author, and media-adjacent hydration tests still pass where
  the migrated pane currently has AC-4 coverage.
- **AC-5.** Nested row actions never trigger row primary activation.
- **AC-6.** Keyboard users can tab to row primary targets and row actions in a
  predictable order.
- **AC-7.** Empty, loading, error, info, and success states appear once, in a
  consistent location, and do not cause layout jumps.
- **AC-8.** Mobile and desktop pane widths do not produce overlapping row
  content, clipped buttons, or text overflow.

### Architecture

- **AC-9.** No migrated pane body imports `SectionCard`, `AppList`,
  `AppListItem`, or `ContextRow`.
- **AC-10.** `PaneSurface`, `PaneSection`, `ResourceList`, and `ResourceRow` do
  not import workspace, pane runtime, pane route model, domain API clients, or
  pane bodies.
- **AC-11.** `ResourceRow` activation is expressed as a discriminated union.
- **AC-12.** Domain-specific row adapters contain mapping only; shared row
  layout and activation semantics live in `ResourceRow`.
- **AC-13.** `SectionCard` and `AppList` are deleted after migration.
- **AC-14.** `ContextRow` is either deleted or private to `ResourceRow`; it is
  not a parallel public row primitive.

### Source Gates

These should be implemented as guard tests or documented negative grep checks:

```bash
rg "from \"@/components/ui/SectionCard\"" apps/web/src
rg "from \"@/components/ui/AppList\"" apps/web/src
rg "AppListItem" apps/web/src
rg "ContextRow" apps/web/src/app apps/web/src/components
rg "role=\"button\"" 'apps/web/src/app/(authenticated)/browse'
rg "className=\\{styles\\.resultRows\\}" apps/web/src/app
rg "className=\\{styles\\.pageList\\}" apps/web/src/app
```

Expected result: no matches, except an explicitly allowlisted private
`ContextRow` implementation path if the implementation chooses that route.

### Verification Commands

Targeted frontend verification:

```bash
cd apps/web && bun run typecheck
cd apps/web && bun run lint
cd apps/web && bun run lint:css-tokens
cd apps/web && bun run test:unit -- src/lib/ui/paneSurfaceCutover.guards.test.ts
cd apps/web && bun run test:browser -- src/__tests__/components/ui/ResourceList.test.tsx
cd apps/web && bun run test:browser -- src/__tests__/components/ui/ResourceRow.test.tsx
cd apps/web && bun run test:browser -- src/__tests__/components/ui/PaneSurface.test.tsx
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/browse/BrowsePaneBody.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/notes/NotesPaneBody.ac4.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/search/SearchPaneBody.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/libraries/LibrariesPaneBody.ac4.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/libraries/[id]/LibraryPaneBody.ac4.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/authors/AuthorsPaneBody.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/authors/[handle]/AuthorPaneBody.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.test.tsx'
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/settings/identities/page.test.tsx'
```

Browser/component verification should cover at least:

- `ResourceRow` responsive wrapping and nested-action behavior.
- Browse at desktop and mobile widths.
- Search results at desktop and mobile widths.
- Notes page list at desktop and mobile widths.
- One settings pane with `PaneSection`.

If the final patch touches enough pane surfaces that targeted coverage becomes
hard to reason about, run the full frontend unit and browser projects:

```bash
cd apps/web && bun run test:unit
cd apps/web && bun run test:browser
```

## Risks And Controls

- **Risk: over-generic API.** Control: no variants until a migrated call site
  proves a need; keep slot-based APIs.
- **Risk: row component starts owning domain logic.** Control: `ResourceRow`
  accepts slots and callbacks only; domain adapters remain at pane/domain
  boundaries.
- **Risk: breaking pane routing.** Control: use real `<a>` links, forward
  existing href/title attributes, and leave pane link routing untouched.
- **Risk: breaking hydration.** Control: do not move resource keys or
  `useResource` calls into primitives; keep AC-4 tests green.
- **Risk: nested action regression.** Control: first-class tests for trailing
  action buttons and primary activation.
- **Risk: deletion blast radius.** Control: migrate and verify each slice, then
  delete old primitives only when source gates prove no runtime callers remain.
- **Risk: settings section ambiguity.** Control: make the distinction explicit:
  `PaneSurface` for roots, `PaneSection` for nested framed groups.

## Definition Of Done

The cutover is done only when all of the following are true:

- Browse has been migrated first and verified.
- Every in-scope standard pane surface uses `PaneSurface`.
- Every repeated resource list uses `ResourceList` or a documented owner such
  as `SortableList` with `ResourceRow` inside.
- Every repeated resource row uses `ResourceRow` directly or through a thin
  domain adapter.
- `SectionCard`, `AppList`, and `AppListItem` are gone from runtime code.
- Direct public `ContextRow` use is gone.
- Old local pane/list/row CSS has been deleted from migrated modules.
- Source gates prevent the old primitives and old local row patterns from
  returning.
- Targeted tests, typecheck, lint, and CSS token checks pass.
- The final spec status is updated with implementation and verification notes.
