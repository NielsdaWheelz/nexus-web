# media highlights single-pane cutover

this doc owns the hard cutover for the reader highlights pane in
`apps/web/src/app/(authenticated)/media/[id]/`.

it replaces the current contextual rail plus detail inspector with one
contextual highlights pane that expands the focused row inline.

this is a hard cutover.

- no legacy inspector path
- no backward compatibility layer
- no parallel layout mode
- no compatibility props

## goals

- remove the desktop two-pane highlights UI
- keep the spatial connection between a highlight row and its text target
- make the full quote, note, and actions available in one obvious place
- keep desktop and mobile on the same mental model
- reduce state branches, dead UI, and dead files
- keep the implementation local, linear, and easy to read
- optimize for maintainer comprehension over reuse or extensibility

## non-goals

- no document-wide or book-wide highlight browser
- no all-highlights toggle
- no separate inspector surface
- no secondary mobile detail sheet
- no generic accordion abstraction
- no generic highlight row abstraction
- no generic action manifest, builder, adapter, or view model
- no `ActionMenu` expansion for icons, custom renderers, or nested controls
- no autosave-on-every-keystroke note system
- no virtualization or new alignment engine

## target behavior

### desktop

- the media page keeps one right-side highlights pane
- the pane uses one fixed-width column
- the current `400px` split inspector layout is removed
- the pane renders contextual highlights only
- each contextual row stays visually tied to its text target
- collapsed rows stay compact and scannable
- the focused row expands inline in the same pane
- only one row is expanded at a time
- clicking a row:
  - focuses that highlight
  - expands that row
  - scrolls the source highlight into view
- hovering a row still outlines the source highlight

### mobile

- the media page keeps the highlights drawer entry point
- the drawer uses the same single-list model as desktop
- selecting a row expands it inline inside the drawer
- there is no secondary mobile detail sheet
- there is no mobile all-highlights mode

### expanded row

- the expanded row shows:
  - the full quote with wrapping
  - a small ask-in-chat icon button
  - a 3-dot action menu
  - the user note directly below the quote
  - linked chat buttons below the note when they exist
- there is no separate `show in document` button
- there is no separate detail inspector

### actions

- ask in chat is a visible icon button on the expanded row
- the 3-dot menu contains:
  - `Edit bounds` or `Cancel edit bounds`
  - one flat command per color
  - `Delete highlight`
- the menu stays flat and command-only
- color is a flat list of commands, not a nested picker
- selection-to-chat from text selection keeps the existing popover flow

### note editing

- the note sits directly below the quote in the expanded row
- owners edit the note inline in place
- there is no `Save note` button
- blur commits the current draft
- if the trimmed draft is empty, blur deletes the note
- if the draft is unchanged, blur does nothing
- read-only highlights show the note inline without editor chrome

### alignment

- collapsed rows use one compact fixed height
- the expanded row keeps its top edge aligned to its text target
- rows after the expanded row reflow downward as needed
- do not try to preserve perfect top alignment for every row below an
  expanded row
- if expansion pushes later rows out of view, pane scroll handles it
- alignment logic stays local to this feature

### contextual scope

- web article and transcript: current content only
- epub: active section only
- pdf: active page only
- this surface never fetches or renders off-context highlights

## final state

### ui structure

- `MediaPaneBody.tsx` owns:
  - the single desktop highlights column width
  - mobile drawer open and close state
- `MediaHighlightsPaneBody.tsx` owns:
  - pane header
  - contextual highlight ordering
  - focus resolution against the current contextual set
  - desktop versus mobile shell branching
- `LinkedItemsPane.tsx` owns:
  - row alignment
  - row rendering
  - inline expansion
  - row-local transient UI state that only exists while a row is rendered
- there is no separate detail component
- there is no separate row component unless one clearly reduces incidental
  complexity after the cutover

### state ownership

- `useMediaViewState.tsx` remains the only owner of:
  - highlight create, update, delete, and annotation mutations
  - send-to-chat routing
  - pdf refresh state
  - focused highlight id
  - edit-bounds mode
- `MediaHighlightsPaneBody.tsx` resolves the focused contextual highlight
  from `focusedId` plus the current contextual set
- `LinkedItemsPane.tsx` does not fetch data and does not own business logic
- there is no inspector state
- there is no mobile detail state
- there is no alternate pane mode state

### code shape

- branch explicitly on `isPdf`, `isMobile`, `isFocused`, and `canEdit`
- keep control flow local, linear, and explicit
- keep alignment math in `LinkedItemsPane.tsx`
- keep expanded-row JSX near the alignment logic that depends on it
- reuse the existing `useMediaViewState` callbacks directly
- inline one-use highlight mapping code at the call site
- inline one-use helpers, one-use constants, and one-use object shapes
- accept a small amount of duplication when it makes the code easier to
  follow
- keep only abstractions with obvious payoff

## rules

- follow `docs/rules/simplicity.md`
- follow `docs/rules/module-apis.md`
- follow `docs/rules/control-flow.md`
- follow `docs/rules/codebase.md`
- follow `docs/rules/function-parameters.md`
- follow `docs/rules/conventions.md`
- follow `docs/rules/testing_standards.md`

feature-specific implementation rules:

- hard cutover only; delete the old surface in the same change
- do not keep `HighlightDetailPane.tsx`
- do not keep the mobile detail sheet path
- do not keep the split rail-plus-inspector grid
- do not add a new shared highlights pane abstraction
- do not add a generic accordion or expander utility
- do not add a highlight row presenter, mapper, adapter, or intermediate
  display shape
- do not add a `useHighlightPane` or `useHighlightRow` hook
- do not add builders, manifests, wrappers, planners, or DSLs
- do not extend `ActionMenu` for this cutover if the existing flat command
  API is sufficient
- do not create a second mutation path when `useMediaViewState.tsx`
  already owns the capability
- do not keep one-use helpers, one-use types, or one-use constants unless
  they hide substantial incidental complexity
- do not keep an extraction only because the old layout needed it
- do not preserve the old inspector behavior behind flags or branches

## key decisions

### 1. one pane, one surface

the current split between contextual rail and inspector makes the user read
and act in two different places.

after cutover, quote, note, and actions live in the same row the user
selected.

### 2. focus and expansion are the same thing

this feature already has one focused highlight id.

after cutover, the focused row is the expanded row.

do not add a second expansion state model.

### 3. keep the menu command-only

the 3-dot menu is for commands.

it should not become a custom mini-panel or nested editor.

ask in chat stays a small visible icon button on the expanded row instead of
forcing `ActionMenu` to grow icon-rendering or custom-item APIs.

### 4. inline note editing should stay simple

the note should feel inline, but the implementation should stay linear.

after cutover:

- local draft state lives with the expanded row
- blur commits
- empty deletes
- unchanged does nothing

do not add per-keystroke autosave, background sync, or complex save-state
machinery unless a real bug forces it.

### 5. expanded-row alignment beats perfect global alignment

the selected row is the row the user is reading and acting on.

it should stay anchored to its source highlight.

rows below it may shift downward when that row expands.

do not build a more elaborate global packing system to avoid that.

### 6. keep the existing mutation and routing APIs

`useMediaViewState.tsx` already owns:

- edit bounds
- color changes
- delete
- annotation save and delete
- send to chat

reuse those callbacks directly.

the cutover is a UI simplification, not a data-flow redesign.

### 7. delete one-use UI layers

the old inspector component exists only because the old layout needed a
second surface.

if `LinkedItemRow.tsx` also stops earning its keep once expansion moves into
`LinkedItemsPane.tsx`, delete it too and keep the row JSX local.

## files

### add

- no new runtime files are expected for this cutover

### modify

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/components/LinkedItemsPane.tsx`
- `apps/web/src/components/LinkedItemsPane.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/__tests__/components/LinkedItemsPane.test.tsx`
- `e2e/tests/non-pdf-linked-items.spec.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`

### delete

- `apps/web/src/app/(authenticated)/media/[id]/HighlightDetailPane.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/HighlightDetailPane.module.css`
- `apps/web/src/components/LinkedItemRow.tsx`
- `apps/web/src/__tests__/components/LinkedItemRow.test.tsx`

### simplify in place

- `apps/web/src/components/ui/ActionMenu.tsx`
  keep unchanged unless the implementation finds a real, concrete gap
- `apps/web/src/lib/highlights/coordinateTransforms.ts`
  keep only the exports still required by local alignment code

## acceptance criteria

### behavior

- desktop shows one highlights pane, not a rail plus inspector split
- the focused row expands inline and shows the full quote without clipping
- the expanded row shows:
  - ask in chat icon button
  - 3-dot action menu
  - inline note directly below the quote
- collapsed rows do not show full note text or action chrome
- there is no `Save note` button
- there is no `Show in document` button
- there is no secondary mobile detail sheet
- mobile drawer uses the same inline expansion model
- epub has no all-highlights button
- pdf has no all-highlights button

### state

- focusing a source highlight expands the matching contextual row
- clicking a row focuses that highlight and scrolls its source into view
- only one contextual row is expanded at a time
- deleting the focused highlight re-resolves focus to the next contextual
  highlight, else clears focus
- changing page or section re-resolves focus against the new contextual set
- edit bounds still runs through the existing selection-driven flow

### code

- there is no `HighlightDetailPane` in the feature
- there is no mobile detail-sheet branch in the highlights pane path
- there is no rail-versus-inspector desktop grid in this feature
- there is no new generic accordion, presenter, mapper, or controller layer
- there is no duplicate mutation path outside `useMediaViewState.tsx`
- if a row abstraction survives, it has a clear and documented payoff

### tests

- component tests cover:
  - single expanded-row resolution
  - expanded row full-quote rendering
  - inline note rendering and blur-save behavior
  - ask in chat icon visibility
  - action-menu command visibility
  - desktop variable-height alignment behavior
  - mobile drawer inline expansion with no detail sheet
- e2e tests cover:
  - non-pdf inline expansion, note visibility, and send-to-chat
  - epub contextual scoping across section changes
  - pdf active-page scoping with inline expanded row behavior
- tests that only assert inspector behavior are removed

## implementation order

1. remove the inspector and mobile detail-sheet render paths
2. move expanded highlight content into the contextual list itself
3. rework row alignment for one variable-height focused row
4. remove dead row and inspector components
5. simplify styles to a single-pane layout
6. rewrite component and e2e tests to match the new surface

## out of scope follow-ups

- document-wide highlight review outside the reader
- bulk highlight operations
- multi-select or multi-expand highlight behavior
- a richer linked-chat management surface
- a fully virtualized variable-height highlight list
