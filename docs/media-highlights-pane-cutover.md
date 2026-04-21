# media highlights pane cutover

this doc owns the hard cutover for the reader highlights pane in
`apps/web/src/app/(authenticated)/media/[id]/`.

it replaces the current mixed-purpose linked-items pane with a compact
context rail plus a full detail surface.

## goals

- make every selected highlight fully readable without clipping
- keep the contextual rail fast to scan while reading
- keep the implementation local, explicit, and easy to follow
- remove dead UI and dead data paths
- remove document-wide and book-wide highlight browsing from this surface

## non-goals

- no separate full-reading mode for highlights
- no all-highlights toggle
- no document-wide pdf highlight index in the reader pane
- no book-wide epub highlight list in the reader pane
- no backward compatibility layer
- no generic annotation sidebar framework

## target behavior

### desktop

- the media page keeps a right-side highlights pane
- the pane is widened to a fixed `400px`
- the pane has two columns:
  - a narrow contextual rail on the left
  - a full detail inspector on the right
- the rail stays spatially aligned to visible source highlights
- the rail row is a selector, not an editor
- each rail row shows:
  - color swatch
  - one-line quote preview
  - optional small status affordance for note presence and linked chat count
- each rail row stays fixed-height
- the rail does not show:
  - wrapped quote text
  - annotation body text
  - linked conversation title rows
  - inline textarea
  - hover action menu
  - per-row send-to-chat button
- the inspector shows the selected highlight in full
- the inspector wraps the full quote and remains readable at any quote length
- the inspector owns all highlight actions:
  - send to chat
  - edit bounds
  - color change
  - delete highlight
  - note edit
  - linked conversation navigation
  - show in document

### mobile

- the media page keeps a highlights drawer entry point
- the drawer shows the contextual rail as a simple ordered list
- selecting a row opens a detail sheet for that highlight
- the detail sheet uses the same content and actions as the desktop inspector
- there is no all-highlights view on mobile

### selection and focus

- the pane always has exactly one selected highlight when contextual
  highlights exist
- if the current focused highlight is still in the contextual set, keep it
- if the current focused highlight leaves the contextual set, select the
  first contextual highlight
- if the contextual set is empty, clear selection
- clicking a source highlight focuses that highlight and updates the
  inspector
- clicking a rail row focuses that highlight and scrolls the source into view
- hovering a rail row still outlines the source highlight on desktop

### contextual scope

- web article and transcript: show highlights for the current content
- epub: show highlights for the active section only
- pdf: show highlights for the active page only
- this pane never fetches or renders off-context highlights

## final state

### ui structure

- `MediaPaneBody.tsx` owns the right column width inline
- `MediaHighlightsPaneBody.tsx` owns:
  - pane header
  - selected-highlight resolution
  - rail plus detail desktop layout
  - mobile drawer and detail sheet layout
- `LinkedItemsPane.tsx` owns the contextual rail only
- one feature-local detail component is allowed if desktop inspector and
  mobile sheet share the same JSX
- if extracted, it must live in
  `apps/web/src/app/(authenticated)/media/[id]/`

### data flow

- `useMediaViewState.tsx` exposes contextual highlights only
- `MediaHighlightsPaneBody.tsx` derives the selected highlight from the
  current contextual list and `focusedId`
- the rail does not own editor state
- the detail surface does not fetch data on its own
- the detail surface receives the selected highlight and action callbacks

### code shape

- branch explicitly on `isPdf` and `isMobile`
- do not keep `layoutMode`
- do not keep `highlightsView`
- do not keep generic anchor provider interfaces
- do not keep a separate alignment engine module
- keep alignment math in `LinkedItemsPane.tsx`
- inline one-use constants, helpers, and temporary object shapes
- extract only when there is real reuse or real incidental complexity

## key decisions

### 1. the rail is intentionally preview-only

the current bug exists because the rail is trying to be both a spatial
preview list and a reading surface.

the cutover stops that.

the rail becomes compact by design.

full readability moves to the inspector.

### 2. remove all-highlights behavior instead of preserving it

the current epub and pdf pane carries extra state, fetching, sorting, and
navigation only to support document-wide browsing.

that behavior is out of scope for this surface and conflicts with the goal
of keeping the pane contextual and simple.

the cutover deletes it.

### 3. remove row-level editing and action chrome

row-level note editing, linked conversation sub-rows, hover menus, and chat
buttons all add vertical pressure and state branching to the rail.

the inspector owns those actions after cutover.

### 4. keep one selected highlight when highlights exist

this avoids an empty right-side inspector when the pane already has useful
context.

it also keeps control flow simple.

### 5. delete feature-specific abstractions that no longer earn their cost

the current linked-items stack has generic provider and alignment layers that
exist only for this pane.

after cutover, keep the feature logic local and direct.

## rules

- follow `docs/rules/simplicity.md`
- follow `docs/rules/codebase.md`
- follow `docs/rules/module-apis.md`
- follow `docs/rules/control-flow.md`
- follow `docs/rules/function-parameters.md`
- keep business logic out of Next.js api routes per `docs/rules/layers.md`

feature-specific implementation rules:

- do not add a new shared highlights pane abstraction
- do not add adapters, builders, or intermediate view models for this cutover
- do not add a compatibility prop to preserve old pane modes
- do not keep a dead component alive only to export a type
- do not keep generic provider interfaces that only one component uses
- do not keep document-wide fetch state after removing all-highlights behavior

## files

### add

- `apps/web/src/app/(authenticated)/media/[id]/HighlightDetailPane.tsx`
  only if desktop inspector and mobile detail sheet share enough UI to earn
  one extracted component
- `apps/web/src/app/(authenticated)/media/[id]/HighlightDetailPane.module.css`
  only if the component above exists

### modify

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHelpers.ts`
- `apps/web/src/components/LinkedItemsPane.tsx`
- `apps/web/src/components/LinkedItemsPane.module.css`
- `apps/web/src/components/LinkedItemRow.tsx`
- `apps/web/src/__tests__/components/LinkedItemsPane.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `e2e/tests/non-pdf-linked-items.spec.ts`
- `e2e/tests/epub.spec.ts`

### delete

- `apps/web/src/components/HighlightEditor.tsx`
- `apps/web/src/components/HighlightEditor.module.css`
- `apps/web/src/components/HighlightEditPopover.tsx`
- `apps/web/src/components/HighlightEditPopover.module.css`
- `apps/web/src/lib/highlights/alignmentEngine.ts`
- `apps/web/src/lib/highlights/alignmentEngine.test.ts`
- `apps/web/src/lib/highlights/anchorProviders.ts`
- `apps/web/src/lib/highlights/anchorProviders.test.ts`
- `apps/web/src/lib/highlights/highlightIndexAdapter.ts`
- `apps/web/src/lib/highlights/highlightIndexAdapter.test.ts`

### shrink or simplify

- `apps/web/src/lib/highlights/coordinateTransforms.ts`
  remove pane-specific exports that become one-use dead weight after
  alignment is inlined locally
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
  remove the shared highlights-pane width constant if the media page remains
  its only runtime consumer
- `apps/web/src/components/AnnotationEditor.tsx`
  delete it if the new detail pane would otherwise be its only caller

## acceptance criteria

### behavior

- selecting any highlight shows the full exact quote in the inspector with no
  vertical clipping
- long quotes wrap in the inspector and remain fully reachable by pane scroll
- the rail stays compact and fixed-height
- the rail never renders note body text inline
- the rail never renders linked conversation rows inline
- the rail never renders a row action menu
- the rail never renders a row send-to-chat button
- desktop rail rows remain aligned to source highlights
- mobile shows contextual highlights only
- epub has no all-highlights button
- pdf has no all-highlights button
- the pane header has no contextual-vs-all toggle

### state

- the selected highlight is always explicit
- the inspector updates when focus changes from either source click or rail
  click
- removing a selected highlight selects the next available contextual
  highlight, else clears selection
- changing page or chapter re-resolves selection against the new contextual
  set

### code

- there is no `highlightsView` state in the media reader path
- there is no document-wide pdf highlights fetch in the media reader path
- there is no epub all-highlights fetch in the media reader path
- there is no `layoutMode` branch in this feature
- there is no generic anchor provider interface in this feature
- there is no separate alignment engine module for this feature
- there is no dead UI component imported only for a type

### tests

- component tests cover:
  - wrapped inspector quote rendering
  - single selection resolution
  - rail compactness
  - desktop alignment still working
  - mobile detail sheet behavior
- e2e tests cover:
  - long non-pdf highlight remains fully readable in inspector
  - epub contextual highlight selection after chapter changes
  - pdf active-page highlight selection and inspector behavior
- tests removed with the cutover:
  - pdf all-highlights toggle behavior
  - epub all-highlights fetch behavior
  - book-mode linked item navigation through a document-wide list

## implementation order

1. cut `MediaHighlightsPaneBody.tsx` down to contextual-only behavior
2. remove all-highlights fetch and state from `useMediaViewState.tsx`
3. simplify the rail to selector-only rows
4. add the inspector and mobile detail sheet
5. inline linked-items alignment logic into `LinkedItemsPane.tsx`
6. delete dead modules and dead tests
7. rewrite tests to match the new surface

## out of scope follow-ups

- search-driven highlight discovery across an entire document
- a notebook or review surface outside the reader
- bulk highlight operations
- virtualized variable-height contextual rail rows
