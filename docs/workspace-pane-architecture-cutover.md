# Workspace Pane Architecture Cutover

Status: Accepted implementation contract.
Scope owner: desktop/mobile workspace panes in `apps/web`.
Related:

- `docs/workspace.md`
- `docs/workspace-tabs.md`
- `docs/reader-implementation.md`
- `docs/chat-search-and-reader-pane.md`
- `docs/command-palette-global-cutover.md`

## Intent

Nexus has one pane architecture. Every pane, regardless of route or content
type, is a `PaneShell` with a route-defined sizing contract and a body that
obeys exactly one body-mode contract. Contextual secondary surfaces append to
the primary pane width instead of taking width from the primary content.

This is a hard cutover. There is no legacy pane sizing path, no ad hoc default
width fallback outside route metadata, and no route-specific secondary-rail
layout model.

## Goals

- Make pane behavior predictable for the first pane, fifth pane, active pane,
  inactive pane, text reader, PDF reader, chat pane, settings pane, list pane,
  and document pane.
- Centralize pane width policy so route defaults, minimums, maximums,
  sanitization, URL hydration, opening, navigation, and resizing all use the
  same resolver.
- Preserve the primary pane width when contextual secondary UI opens.
- Use one desktop secondary-rail composition path and one mobile drawer/sheet
  pattern for contextual tools.
- Make Shift-click and programmatic new-pane opens create route-default-sized
  panes.
- Preserve user-resized widths when an already-open resource is activated.
- Keep pane-local actions in pane chrome and global actions in the command
  palette.
- Keep mobile as a single active pane surface with no desktop pane strip.

## Non-Goals

- No docking framework, drag-to-reorder, floating panes, popouts, or nested IDE
  grid layout.
- No backward-compatible support for older pane width fallback behavior.
- No overlaying desktop secondary rails on top of primary content.
- No pane-scoped command-palette revival.
- No change to PDF anchoring internals, EPUB/text offsets, or reader selection
  semantics except where needed to share pane layout.
- No persistence of secondary-rail width into `pane.widthPx`.

## Core Contract

### Workspace Pane State

`WorkspacePaneStateV4.widthPx` is the persisted primary content width. It does
not include contextual rails, rulers, drawers, sheets, mobile chrome, or
workspace strip dimensions.

The rendered desktop shell width is:

```text
rendered width = primary widthPx + runtime extraWidthPx
rendered min   = resolved minWidthPx + runtime extraWidthPx
rendered max   = resolved maxWidthPx + runtime extraWidthPx
```

`extraWidthPx` is runtime-only. It is published by pane bodies when they mount a
desktop contextual rail and cleared on unmount, mobile, or close.

Runtime min-width and extra-width publications are scoped to the publishing pane
id and active resource key. The host applies a runtime width only while the
record's resource key matches the pane's current resource key, so cleanup from a
previous resource cannot clear or apply sizing for the next resource rendered in
the same pane.

### Route Width Policy

Every route resolves to one width contract:

- `defaultWidthPx`
- `minWidthPx`
- `maxWidthPx`
- `bodyMode`

`bodyMode` is route metadata. Width policy is owned by the workspace route width
resolver and is attached to resolved pane routes. All pane creation and
normalization goes through that resolver:

- workspace default state
- workspace state sanitization
- pane open actions
- same-pane navigation clamps
- explicit user resize clamps
- URL decode and persisted-state hydration

There is no literal `480` fallback outside the resolver. Unsupported routes use
the standard route width contract through the resolver.

### Existing Pane Activation

Opening a route whose resource is already open activates and reveals the
existing pane. It may update the href to the normalized target href and make the
pane visible. It must not reset `widthPx` to the route default.

### New Pane Creation

New panes always use the target route's `defaultWidthPx`, clamped by the target
route's `minWidthPx` and `maxWidthPx`.

Openers must provide `titleHint` when a useful title is already known.

### Runtime Minimum Width

Runtime minimum width can only raise a route floor. It is used when content has
a measurable or format-specific minimum that route metadata cannot know, such
as reader text columns, PDF document viewing, always-on reader rulers, or other
primary-content constraints.

Runtime minimum width must not lower the route minimum and must be cleared on
unmount or mobile.

### Contextual Secondary Rail

Desktop contextual rails are part of the owning pane's compound layout:

```text
PaneShell
  primary column
  contextual secondary rail
```

The rail appends to the primary column. Opening the rail increases the rendered
pane width by the rail width. Closing the rail decreases the rendered pane width
by the same amount. The persisted primary width does not change.

Examples of contextual rails:

- reader highlights
- document chat
- library chat attached to the current document
- chat context for the current conversation
- local document outline or inspector, if added later

Non-contextual surfaces are not pane rails:

- global library navigation
- global chat list
- command palette
- account settings navigation
- app-wide search

Those are route panes, workspace-level surfaces, or palette actions.

## Body Modes

Each `bodyMode` has one meaning.

### `standard`

`PaneShell` owns vertical scrolling. The pane body renders content only. A
standard pane must not introduce a competing full-pane scroll owner except for
small internal widgets that naturally scroll.

Examples: settings, list panes, search, libraries, notes list, author, browse.

### `contained`

The pane body owns a full-height app surface with explicit internal scrollports.
`PaneShell` gives it a constrained full-height body. The body is responsible for
scroll containment and layout.

Examples: conversation detail, new conversation.

### `document`

The pane body owns a full-height document surface with `min-height: 0`,
`overflow: hidden` at the document shell root, and exactly one primary document
scrollport. Contextual rails and rulers sit beside the primary document column
through the shared compound-pane layout.

Examples: media reader/PDF, podcast detail, page, note, daily note.

## Shared Components

### `PaneShell`

Owns:

- route chrome
- title/subtitle/actions/options
- active/inactive state
- close/minimize/restore controls
- desktop resize handle
- mobile command-palette trigger
- body-mode envelope
- rendered width/min/max composition

Does not own:

- route-specific content layout
- contextual rail content
- document scroll positioning
- chat transcript scroll

### `PaneRuntimeProvider`

Owns pane-local APIs:

- same-pane navigation
- open in new pane
- runtime title publication
- runtime minimum width publication
- runtime extra width publication

Pane bodies use this API. They do not mutate workspace pane state directly.
The provider attaches the current resource key to runtime width publications;
pane bodies publish widths only, not resource-scoping metadata.

### Compound Pane Layout Contract

Pane bodies that mount a contextual desktop rail must use the same contract:

- primary + contextual secondary rail flex composition
- runtime minimum width publication
- runtime extra width publication
- desktop-only rail width reservation
- mobile/no-rail cleanup

Reader, PDF, and chat context rails all use `SecondaryRail` plus
`paneRuntime.setPaneExtraWidth`. New contextual rails must use the same runtime
width path instead of adding ad hoc CSS-only split behavior.

### `SecondaryRail`

Owns the visual and interaction shell for contextual rail content:

- expanded/collapsed rendering
- tab strip when needed
- close/collapse control
- rail width
- rail body scroll containment

It does not publish pane width directly. Width publication belongs to the
compound pane layout that mounts the rail.

## Reader And PDF Contract

Web article, EPUB, transcript, and PDF readers share the same pane composition:

- primary reader column
- optional desktop overview ruler
- optional contextual secondary rail
- mobile drawer/sheet equivalents
- same rail modes where supported: highlights, document chat, library chat
- same primary width preservation behavior

The content anchoring internals remain format-specific:

- web/transcript: text offsets and fragment spans
- EPUB: character counts and CFI/source mapping
- PDF: page, progression, quads, and zoom

PDF is not exempt from reader pane sizing. PDF publishes a protected primary
width through the same runtime min-width path as text readers. Opening reader
chat or highlights appends the secondary rail outside the PDF primary width.

## Chat Contract

Conversation panes use the same contextual rail model as readers:

- chat transcript/composer are the primary column
- conversation context is the contextual secondary rail
- opening context appends rail width outside the chat primary width
- closing context removes exactly that runtime extra width
- mobile uses `ChatContextDrawer`

Chat rails must not shrink the transcript/composer column.

## Navigation Contract

Same-pane navigation uses `paneRuntime.router`.

New-pane navigation uses `paneRuntime.openInNewPane` when the opener is inside a
pane and `requestOpenInAppPane` for global surfaces. Both paths resolve the
target route and create panes at the route default width.

Internal anchors intercepted by `PaneRouteBoundary` obey the same policy:

- normal primary click: same-pane navigation
- Shift-primary click: open in a route-default-sized pane after the opener

Custom row components should converge on shared row/link primitives that carry:

- `href`
- `titleHint`
- leading visual
- title
- subtitle/meta
- trailing status
- actions
- selected state
- keyboard semantics

## Accessibility Contract

Pane resizing is exposed as an interactive splitter:

- focusable `role="separator"`
- `aria-orientation="vertical"` for horizontal resizing
- accessible label naming the controlled pane
- `aria-valuemin`, `aria-valuemax`, `aria-valuenow`
- keyboard resizing via arrows
- Home/End clamp to min/max
- visible focus state

Secondary rail tab strips use accessible tab semantics through
`SecondaryRail`. Icon-only actions have labels and tooltips.

## Acceptance Criteria

- Creating the initial workspace pane for any route uses that route's default
  width.
- Sanitizing a persisted pane without `widthPx` uses that route's default width.
- Opening a new pane uses the target route default width.
- Reopening an already-open resource activates it without resetting user width.
- Resizing and navigation clamp through the route width resolver.
- Text reader, EPUB, transcript, and PDF publish protected primary widths.
- Runtime min-width and extra-width records never apply across resource-key
  changes in the same pane.
- Reader secondary rail opens by adding `SECONDARY_RAIL_EXPANDED_WIDTH_PX` to
  the rendered pane width and closes by removing it.
- Chat context rail opens and closes through the same runtime extra-width path.
- No desktop secondary rail overlays or shrinks primary content.
- Mobile renders one active pane and uses drawers/sheets for contextual tools.
- Tests cover route defaults, sanitization defaults, open-pane dedupe, runtime
  minimum auto-resize, secondary rail extra width, PDF reader minimum width,
  chat rail extra width, and existing pane activation.
- `docs/workspace.md` and related docs no longer describe pane width changes as
  a non-goal.

## Implementation Surfaces

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/useResizeHandle.ts`
- `apps/web/src/components/secondaryRail/SecondaryRail.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/page.module.css`
- workspace, pane route, pane shell, media reader, and chat tests

## Verification

Required targeted checks:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web test:unit -- src/lib/workspace/schema.test.ts
bun run --cwd apps/web test:browser -- src/lib/panes/paneRouteRegistry.test.tsx src/lib/workspace/store.test.tsx src/components/workspace/WorkspaceHost.test.tsx src/__tests__/components/PaneShell.test.tsx src/components/secondaryRail/SecondaryRail.test.tsx src/__tests__/components/ConversationPaneBody.test.tsx src/app/'(authenticated)'/conversations/new/ConversationNewPaneBody.test.tsx src/app/'(authenticated)'/media/'[id]'/MediaPaneBody.test.tsx src/__tests__/components/PdfReader.test.tsx
```

If a full browser pass is needed, run the reader and workspace e2e specs after
the unit/type pass is green.
