# Workspace Pane Layout Cutover

## Status

This is the implementation plan and target contract for simplifying workspace
panes, centralizing pane sizing, and making web article and EPUB reader panes
impossible to narrow below their protected text measure.

The cutover is strict:

- No nested split-pane tree.
- No duplicate width contract resolver.
- No separate runtime min-width and extra-width APIs.
- No live-content or CSS `min-content` pane sizing for readers.
- No protected text-width floor for PDF or transcript panes.
- No duplicated rail width constants.
- No compatibility shim for the previous pane sizing API.
- No fallback path that keeps old sizing behavior alive.

Any code path that still depends on those concepts is wrong and should be
deleted, not adapted.

## Problem Statement

The current workspace has the right product shape: a flat ordered list of panes
rendered in a horizontal desktop canvas, with a single active pane on mobile.
The problem is that pane sizing is spread across too many owners:

- `schema.ts` derives width contracts from URL shape.
- `paneRouteRegistry.tsx` owns route matching, body mode, render binding, and
  then imports the schema width contract.
- `WorkspaceHost.tsx` keeps two runtime maps, one for min width and one for
  extra width.
- `PaneShell.tsx` recomputes effective rendered dimensions.
- `useResizeHandle.ts` performs another local clamp.
- `MediaPaneBody.tsx` owns the reader text-width probe, reader column CSS var,
  overview ruler width, secondary rail width, and runtime width publication.
- Conversation panes publish extra rail width through similar ad hoc effects.

That split makes the pane system hard to reason about. It also makes reader
width behavior easy to regress: the code already has a protected reader width
probe, but the behavior is hidden inside a large media component, applies too
broadly, and lacks an E2E contract proving that live web article and EPUB panes
cannot stay narrower than the reader text measure.

The correct fix is one hard cutover to the pane sizing contract below.

## Goals

- Keep the flat workspace pane model.
- Keep desktop panes as independent shells in one horizontal canvas.
- Keep mobile as one active visible pane with no desktop rail width behavior.
- Make pane width contracts resolve from one source of truth.
- Make runtime pane sizing one atomic capability.
- Keep persisted pane width as the resizable primary pane width.
- Keep outward rails outside the persisted primary pane width.
- Protect web article and EPUB reader text from compression below the configured
  reader measure.
- Measure reader text floors from reader profile typography, not from live
  article/EPUB content.
- Scope protected reader text floors to reflowable text readers only.
- Shrink `MediaPaneBody` by moving pane layout and sizing behavior to owned
  modules.
- Preserve reader pane-local history, reader resume, highlights, and focus-mode
  contracts.
- Add behavior-level tests for reader pane width floors.
- Delete old duplicate APIs, stale constants, and doc drift as part of the
  cutover.

## Non-Goals

- Replacing the workspace with a nested split tree.
- Making child rails or panels independently resizable.
- Persisting secondary rail width in workspace state.
- Changing `WorkspaceState` shape unless a hard defect requires it.
- Changing reader profile schema.
- Changing the web article, EPUB, transcript, or PDF resume contracts.
- Changing highlight data APIs.
- Merging the overview ruler and visible highlights rail.
- Making PDF pages obey text-reader column width.
- Making transcript playback/segments obey text-reader column width.
- Supporting both old and new pane runtime sizing APIs.
- Adding CSS intrinsic pane sizing as a second layout authority.

## Design Rules

The repository rules in `docs/rules/cleanliness.md`,
`docs/rules/module-apis.md`, and `docs/rules/simplicity.md` govern this
cutover:

- One concern has one owner.
- A capability has one primary API.
- Duplicate derivations are deleted.
- Dead compatibility branches are deleted.
- Values are parsed or normalized at the boundary and trusted afterward.
- Tests assert observable behavior at the owning surface.

Consequences for this feature:

- Pane width contracts are owned by one pure route model.
- Effective pane sizing is a pure calculation with a single implementation.
- Pane runtime publishes one sizing object, not two independent numbers.
- Pane shell rendering consumes an already resolved sizing result.
- Resize handles clamp through the same sizing function as render.
- Reader text floors come from configured reader measure, never from live
  content intrinsic width.
- Reflowable text reader sizing is a media-reader concern, not a workspace
  schema concern.
- Secondary rail width is a shared rail concern, not a per-pane magic number.

## Target Behavior

### Workspace Panes

The workspace remains a flat ordered list:

```ts
interface WorkspaceState {
  schemaVersion: number;
  activePaneId: string;
  panes: WorkspacePaneState[];
}

interface WorkspacePaneState {
  id: string;
  href: string;
  widthPx: number;
  visibility: "visible" | "minimized";
  history: WorkspacePaneHistory;
}
```

`widthPx` is the primary resizable pane width. It excludes outward rails.

Desktop renders visible panes in the horizontal pane canvas. Mobile renders only
the active visible pane and ignores runtime width and extra width publications.

### Effective Sizing

Every pane has three sizing inputs:

- Route width contract.
- Stored primary width from workspace state.
- Runtime sizing publication from the mounted pane body.

The effective desktop sizing calculation is:

```ts
routeMinWidthPx = route.width.minWidthPx;
routeMaxWidthPx = route.width.maxWidthPx;
publishedMinWidthPx = runtime.minWidthPx;
extraWidthPx = runtime.extraWidthPx;

primaryMinWidthPx = min(
  routeMaxWidthPx,
  max(routeMinWidthPx, publishedMinWidthPx ?? routeMinWidthPx),
);

primaryWidthPx = clamp(
  storedWidthPx,
  primaryMinWidthPx,
  routeMaxWidthPx,
);

renderedWidthPx = primaryWidthPx + extraWidthPx;
renderedMinWidthPx = primaryMinWidthPx + extraWidthPx;
renderedMaxWidthPx = routeMaxWidthPx + extraWidthPx;
```

If a visible desktop pane's stored `widthPx` is below `primaryMinWidthPx`, the
workspace store resizes that pane to `primaryMinWidthPx`. This is the only
automatic stored-width mutation caused by runtime sizing.

Opening or closing an outward rail changes `extraWidthPx` and the rendered pane
width. It does not mutate the persisted primary `widthPx`.

### Resize Interaction

The mouse resize handle, keyboard resize handle, shell inline styles, and host
auto-resize use the same effective sizing result.

Required keyboard behavior:

- `ArrowLeft`: decrease primary width by the existing step, clamped to
  `primaryMinWidthPx`.
- `ArrowRight`: increase primary width by the existing step, clamped to
  `routeMaxWidthPx`.
- `Home`: set primary width to `primaryMinWidthPx`.
- `End`: set primary width to `routeMaxWidthPx`.

The ARIA separator reports rendered dimensions, because that is what the user
sees. The store receives primary dimensions, because that is what the user can
resize.

### Web Article And EPUB Reader Floor

Desktop readable web article and EPUB panes must not be narrower than:

```text
measured reader column width
+ reader inline padding
+ desktop overview ruler width when shown
```

The measured reader column width is the configured `reader_profile.column_width_ch`
in the configured reader font family and font size. It is measured by an
offscreen fixed-width probe that uses the same reader typography custom
properties as the visible text reader.

The floor is not:

- The live rendered article width.
- CSS `min-content`.
- The width of a long URL, table, image, or code block.
- The open secondary rail width.
- A hard-coded pixel conversion for `ch`.

With the default reader profile, the effective text floor is approximately:

```text
65ch + 2 * var(--space-4) + OVERVIEW_RULER_WIDTH_PX
```

The value must still be measured, because `ch` depends on the active reader
font and font size.

### Secondary Rail Width

The reader secondary rail remains outward extra width:

```text
renderedWidthPx = primaryWidthPx + SECONDARY_RAIL_EXPANDED_WIDTH_PX
```

The rail is not part of the text floor. Closing the rail returns the rendered
pane to the protected primary width without changing stored primary width.

### PDF And Transcript Panes

PDF and transcript panes use the media route width contract and any rail extra
width they legitimately publish. They do not publish the reflowable reader text
floor.

PDF canvas zoom and page geometry remain PDF reader state. Transcript playback,
chapter panels, and transcript segments remain transcript layout state.

### Mobile

Mobile panes render at `100%` width.

Mobile ignores:

- Runtime min width.
- Runtime extra width.
- Desktop overview ruler width.
- Desktop secondary rail width.

Mobile keeps the existing reader contract:

- No desktop overview ruler.
- No persistent highlights rail.
- Highlights open in a drawer.
- Document pane chrome remains local to the active pane.

## Final Architecture

### Pure Route Model

Add one pure route model module:

```text
apps/web/src/lib/panes/paneRouteModel.ts
```

It owns:

- `PaneRouteId`
- `PaneBodyMode`
- `PaneLayoutKind`
- `PaneWidthContract`
- route patterns
- static titles
- title mode
- resource refs
- body mode
- width contract
- `resolvePaneRouteModel(href)`

It does not import React components or icons.

`paneRouteRegistry.tsx` becomes the render/chrome binding layer. It imports the
pure route model by route id and attaches:

- component render functions
- icons
- chrome descriptors

`schema.ts` stops deriving route width contracts from URL shape. Workspace
state parsing, URL encoding, pane history, and persisted width clamping call the
pure route model resolver instead.

There is no second width-contract resolver.

### Effective Sizing Module

Add one pure sizing module:

```text
apps/web/src/lib/workspace/paneSizing.ts
```

It owns:

```ts
interface PaneRuntimeSizing {
  minWidthPx: number | null;
  extraWidthPx: number;
}

interface PaneSizingInput {
  storedWidthPx: number;
  routeWidth: PaneWidthContract;
  runtimeSizing: PaneRuntimeSizing;
  isMobile: boolean;
}

interface EffectivePaneSizing {
  primaryWidthPx: number;
  primaryMinWidthPx: number;
  primaryMaxWidthPx: number;
  extraWidthPx: number;
  renderedWidthPx: number;
  renderedMinWidthPx: number;
  renderedMaxWidthPx: number;
  storedWidthCorrectionPx: number | null;
}
```

Public functions:

```ts
resolveEffectivePaneSizing(input: PaneSizingInput): EffectivePaneSizing
normalizePaneRuntimeSizing(input: PaneRuntimeSizing): PaneRuntimeSizing
```

Rules:

- `minWidthPx` is `null` or a finite positive integer.
- `extraWidthPx` is a finite non-negative integer.
- Invalid runtime sizing is a defect.
- Mobile returns `100%` render behavior at the shell layer and no stored-width
  correction.
- Desktop returns numeric pixel dimensions.

### Pane Runtime API

Replace the existing two-method runtime API:

```ts
setPaneMinWidth(widthPx)
setPaneExtraWidth(widthPx)
```

with one method:

```ts
setPaneSizing(input: {
  minWidthPx: number | null;
  extraWidthPx: number;
}): void
```

`PaneRuntimeProvider` publishes sizing with the active `paneId` and
`resourceKey`.

`WorkspaceHost` keeps one runtime sizing map:

```ts
Map<paneId, { resourceKey: string; sizing: PaneRuntimeSizing }>
```

Records are pruned when the pane resource key changes. Stale records are not
used.

Cleanup publishes:

```ts
{ minWidthPx: null, extraWidthPx: 0 }
```

There is no adapter that keeps the old `setPaneMinWidth` or `setPaneExtraWidth`
names alive.

### Pane Shell

`PaneShell` receives an `EffectivePaneSizing`, not raw `widthPx`,
`minWidthPx`, `maxWidthPx`, and `extraWidthPx`.

It is responsible for:

- Applying shell inline width styles.
- Rendering pane chrome.
- Rendering body mode.
- Rendering resize separator ARIA values.

It is not responsible for recomputing effective sizing.

### Resize Handle

`useResizeHandle` receives:

```ts
{
  paneId: string;
  primaryWidthPx: number;
  primaryMinWidthPx: number;
  primaryMaxWidthPx: number;
  onResizePane: (paneId: string, primaryWidthPx: number) => void;
}
```

It clamps to those resolved primary bounds. It does not know about route
contracts or runtime sizing publications.

### Reflowable Reader Pane Sizing

Add one media-reader sizing owner:

```text
apps/web/src/app/(authenticated)/media/[id]/useReflowableReaderPaneSizing.tsx
```

It owns:

- hidden protected-width probe ref
- `ResizeObserver` for the probe
- measured protected text width
- reader column `--reader-protected-width-px`
- pane runtime sizing publication for web article and EPUB

Public hook:

```ts
function useReflowableReaderPaneSizing(input: {
  enabled: boolean;
  readerSurfaceStyle: CSSProperties;
  overviewRulerWidthPx: number;
  secondaryRailWidthPx: number;
}): {
  protectedWidthProbe: ReactNode;
  readerColumnStyle: CSSProperties;
}
```

Rules:

- `enabled` is true only for readable `web_article` and `epub` media on desktop.
- The probe uses the same reader typography variables as the visible reader.
- The hook publishes `{ minWidthPx, extraWidthPx }` atomically.
- The hook clears sizing on disable or unmount.
- `ResizeObserver` is required for ongoing typography measurement.
- Initial layout measurement happens before first paint where React permits it.
- The hook does not inspect rendered article or EPUB HTML.
- The hook does not run for PDF or transcript media.

The visible reader column keeps a CSS min width:

```css
.readerColumn {
  min-width: var(--reader-protected-width-px, 0);
}
```

The CSS var is set only when the hook has a measured positive protected width.

### Rail Sizing

Add one shared rail sizing module:

```text
apps/web/src/components/secondaryRail/railSizing.ts
```

It owns:

```ts
export const SECONDARY_RAIL_COLLAPSED_WIDTH_PX = 36;
export const SECONDARY_RAIL_EXPANDED_WIDTH_PX = 360;
export const CONVERSATION_REFERENCES_RAIL_WIDTH_PX = 320;
```

If the product decides all secondary rails should use one width, delete the
conversation-specific width and use `SECONDARY_RAIL_EXPANDED_WIDTH_PX`
everywhere. Do not keep duplicate constants with the same value in pane bodies.

`SecondaryRail.tsx`, reader panes, conversation panes, and new-chat panes import
from this module.

### MediaPaneBody Final Shape

`MediaPaneBody` keeps media-reader orchestration:

- media loading
- navigation loading
- active content selection
- reader resume
- highlight mutation
- reader chrome actions
- PDF/transcript/web/EPUB reader selection

It no longer owns:

- hidden protected-width probe implementation
- pane runtime sizing publication details
- reader column protected-width state
- duplicated secondary rail width constants

The reflowable text reader remains shared:

```text
apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx
```

Web article and EPUB continue to render through that component.

## Capability Contract

### Workspace Sizing

Workspace sizing is:

- Pane-scoped.
- Resource-key-scoped for runtime publications.
- Numeric at the shell boundary.
- Persisted only as primary pane width.
- Derived from one pure sizing function.

Workspace sizing is not:

- CSS intrinsic layout.
- Live content measurement.
- A split-tree data model.
- A rail persistence system.
- A component-local approximation of route contracts.

### Runtime Pane Sizing

Runtime pane sizing lets pane content publish layout requirements that the
workspace cannot know statically.

Allowed publications:

- `minWidthPx`: the minimum primary pane width needed by mounted content.
- `extraWidthPx`: outward width added by mounted, non-resizable side surfaces.

Required behavior:

- Publications are keyed by `paneId` and `resourceKey`.
- Stale resource publications are ignored and pruned.
- Every publication replaces the previous publication for that pane/resource.
- Cleanup clears both min and extra width.
- Invalid values are defects.

Runtime pane sizing must not:

- Write directly to workspace state.
- Persist outward rails.
- Publish separate independent records for min and extra width.
- Publish mobile desktop rail sizing.

### Reflowable Reader Width

Reflowable reader width is:

- Derived from `reader_profile`.
- Measured through a fixed offscreen typography probe.
- Published as runtime pane sizing.
- Applied as a CSS floor to the reader column.

Reflowable reader width is not:

- A measurement of the current DOM content.
- A PDF canvas rule.
- A transcript layout rule.
- A mobile width rule.

## Composition With Other Systems

### Workspace Session And URL State

The persisted workspace state continues to store `widthPx` as primary pane
width. Runtime sizing is never serialized into `ws=` URLs or workspace session
JSON.

When a persisted pane width is too narrow for the current runtime content, the
host corrects it to the effective primary minimum. That corrected primary width
can later be captured by the existing workspace session system.

### Pane Route Registry

Route resolution composes in two layers:

1. Pure route model resolves route identity, resource identity, body mode, and
   width contract.
2. React registry attaches component renderers, icons, and chrome.

Tests must fail if a renderable route does not have exactly one route model and
one width contract.

### Reader Profile

Reader pane width composes with reader profile by measuring the configured
profile. A change to font family, font size, line height, or column width causes
the protected width probe to remeasure and republish sizing.

The reader profile remains global. No per-media width override is introduced.

### Reader Resume And Highlight Projection

Text width changes already participate in reflow-safe resume and highlight
projection. This cutover keeps that model:

- Web article resume uses canonical text offsets.
- EPUB resume uses section and text-offset restore.
- Anchored highlight projection remeasures after typography and rail width
  changes.

The pane sizing hook must not persist reader geometry. Geometry remains derived
from the current DOM.

### Focus Mode

Focus mode keeps its current product contract:

- `distraction_free` reduces chrome and hides sibling panes from view.
- Paragraph and sentence focus add dimming.
- Active selection suspends dimming.

Runtime pane sizing still protects the configured reader measure for the active
reader pane. Focus mode must not introduce a second width path.

### Secondary Rail

The secondary rail composes through runtime `extraWidthPx`.

Reader overview ruler width contributes to reader minimum width because it is
always present for desktop readable media. The expanded secondary rail
contributes to extra width because it opens and closes outward.

### Pane Canvas

The pane canvas remains the horizontal scroll container. It must not expand its
grid row to fit all panes. `min-width: 0` and horizontal overflow stay at the
canvas boundary.

## API Design

### `paneRouteModel.ts`

```ts
export type PaneBodyMode = "standard" | "document" | "contained";
export type PaneLayoutKind =
  | "standard"
  | "dense-list"
  | "document"
  | "podcast-detail"
  | "media-reader";

export interface PaneWidthContract {
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  layoutKind: PaneLayoutKind;
}

export interface PaneRouteModel {
  id: PaneRouteId;
  pattern: readonly string[];
  staticTitle: string;
  titleMode: "static" | "dynamic";
  bodyMode: PaneBodyMode;
  width: PaneWidthContract;
  resourceRef?: (params: Record<string, string>) => string | null;
}

export interface ResolvedPaneRouteModel {
  id: PaneRouteId | "unsupported";
  pathname: string;
  params: Record<string, string>;
  staticTitle: string;
  titleMode: "static" | "dynamic";
  bodyMode: PaneBodyMode;
  resourceRef: string | null;
  width: PaneWidthContract;
}

export function resolvePaneRouteModel(href: string): ResolvedPaneRouteModel;
```

### `paneSizing.ts`

```ts
export interface PaneRuntimeSizing {
  minWidthPx: number | null;
  extraWidthPx: number;
}

export const EMPTY_PANE_RUNTIME_SIZING: PaneRuntimeSizing = {
  minWidthPx: null,
  extraWidthPx: 0,
};

export function normalizePaneRuntimeSizing(
  input: PaneRuntimeSizing,
): PaneRuntimeSizing;

export function resolveEffectivePaneSizing(input: {
  storedWidthPx: number;
  routeWidth: PaneWidthContract;
  runtimeSizing: PaneRuntimeSizing;
  isMobile: boolean;
}): EffectivePaneSizing;
```

### `paneRuntime.tsx`

```ts
interface PaneRuntimeContextValue {
  ...
  setPaneSizing: (sizing: PaneRuntimeSizing) => void;
}
```

No `setPaneMinWidth`. No `setPaneExtraWidth`.

### `useReflowableReaderPaneSizing.tsx`

```ts
export function useReflowableReaderPaneSizing(input: {
  enabled: boolean;
  readerSurfaceStyle: CSSProperties;
  overviewRulerWidthPx: number;
  secondaryRailWidthPx: number;
}): {
  protectedWidthProbe: ReactNode;
  readerColumnStyle: CSSProperties;
};
```

The hook returns renderable probe content so the owning reader layout decides
where hidden measurement DOM lives.

## Implementation Scope

### Files To Add

- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/lib/workspace/paneSizing.ts`
- `apps/web/src/components/secondaryRail/railSizing.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useReflowableReaderPaneSizing.tsx`
- E2E coverage for reader pane minimum width, likely
  `e2e/tests/reader-pane-width.spec.ts`

### Files To Change

- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/schema.test.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRuntime.test.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/useResizeHandle.ts`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/components/secondaryRail/SecondaryRail.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `docs/reader-implementation.md`
- `docs/reader-research.md`
- `README.md`

### Files To Delete Or Inline If Left Empty

- Any local helper that only wraps old `setPaneMinWidth`.
- Any local helper that only wraps old `setPaneExtraWidth`.
- Any duplicate chat rail width constant.
- Any duplicate media rail width constant.
- Any test whose only purpose is preserving the old two-map runtime width API.

## Implementation Plan

### 1. Establish Pure Route And Width Ownership

Move route identity and width contract data into `paneRouteModel.ts`.

Cut over:

- `resolvePaneWidthContract(href)` callers to `resolvePaneRouteModel(href).width`.
- `paneRouteRegistry.tsx` to use pure route models.
- Tests to assert every route model has one render binding when supported.

Delete URL-shape width derivation from `schema.ts`.

### 2. Establish One Effective Sizing Function

Add `paneSizing.ts` and move all effective sizing math into it.

Cut over:

- `WorkspaceHost.buildHostPane`.
- `PaneShell`.
- `useResizeHandle`.
- Workspace and shell tests.

Delete local clamp recomputation where it duplicates the pure sizing result.

### 3. Replace Runtime Width API Atomically

Replace runtime width publication with `setPaneSizing`.

Cut over all publishers:

- Media reader pane.
- Conversation pane.
- New conversation pane.

Delete:

- `setPaneMinWidth`
- `setPaneExtraWidth`
- separate runtime min width map
- separate runtime extra width map
- tests for stale split records

Replace stale-record tests with tests for stale atomic runtime sizing records.

### 4. Extract Reflowable Reader Pane Sizing

Move reader protected-width measurement and publication into
`useReflowableReaderPaneSizing`.

Scope `enabled` to:

```ts
!isMobileViewport &&
canRead &&
(media.kind === "web_article" || media.kind === "epub")
```

Delete `hasProtectedReaderTextWidth = canRead`.

Keep the protected CSS var on `.readerColumn`, but set it only from the new
hook result.

### 5. Centralize Rail Width Constants

Move rail width constants into `railSizing.ts`.

Cut over imports in:

- `SecondaryRail.tsx`
- `MediaPaneBody.tsx`
- conversation panes
- tests

Delete duplicate constants.

### 6. Add Reader Pane Width E2E

Add a Playwright spec that:

- Uses encoded workspace state with a `/media/{id}` pane width below the
  protected reader floor.
- Opens a seeded web article.
- Asserts the pane auto-expands to at least protected text width plus overview
  ruler width.
- Attempts keyboard shrink with `Home` or repeated `ArrowLeft`.
- Asserts the pane remains at the protected floor.
- Repeats for seeded EPUB.
- Verifies mobile ignores desktop width publication and remains viewport width.

The test must use the existing workspace helper pattern for pane-sensitive
state. It must not assume restored workspace state is empty.

### 7. Clean Documentation Drift

Update reader docs to state:

- One-shot EPUB reader targets use `#loc-<section_id>`; pane-local EPUB
  active-section history uses `?loc=<section_id>`.
- Web article/EPUB desktop pane floors are protected by configured reader
  measure.
- PDF/transcript panes do not inherit the reflowable text floor.

Remove or replace stale README links to missing docs.

## Acceptance Criteria

### Product Behavior

- A desktop web article pane cannot remain narrower than the configured reader
  text measure plus reader padding plus desktop overview ruler.
- A desktop EPUB pane cannot remain narrower than the configured reader text
  measure plus reader padding plus desktop overview ruler.
- A desktop web article or EPUB pane opened from persisted workspace state below
  the floor auto-corrects upward.
- Drag resize cannot reduce those panes below the floor.
- Keyboard resize cannot reduce those panes below the floor.
- Opening the reader secondary rail increases rendered width by the rail width
  without reducing text measure.
- Closing the reader secondary rail removes only the outward extra width.
- PDF panes do not receive the reflowable text floor.
- Transcript panes do not receive the reflowable text floor.
- Mobile media panes remain viewport width and do not publish desktop rail
  width.

### Architecture

- There is one pure route width contract source.
- There is one effective pane sizing function.
- There is one runtime pane sizing API.
- There is one runtime sizing map in `WorkspaceHost`.
- `PaneShell` does not recompute route/runtime sizing.
- `useResizeHandle` clamps with resolved primary bounds only.
- Reader protected-width measurement is not implemented inside
  `MediaPaneBody`.
- Rail width constants are imported from one module.
- No old runtime width setters remain.
- No duplicate chat rail width constants remain.

### Tests

- Unit tests cover route model width contracts.
- Unit tests cover `resolveEffectivePaneSizing`.
- Browser/component tests cover `PaneShell` rendered dimensions and resize
  behavior through effective sizing.
- Browser/component tests cover stale runtime sizing records after resource
  changes.
- Media reader browser tests cover web article and EPUB sizing publication.
- Media reader browser tests prove PDF/transcript do not publish the
  reflowable text floor.
- E2E covers article and EPUB panes opened below the protected floor.
- E2E covers attempted shrink below the protected floor.
- E2E covers mobile ignoring desktop sizing publication.

### Deletion Checks

These searches return no matches after cutover:

```bash
rg "setPaneMinWidth|setPaneExtraWidth" apps/web/src
rg "hasProtectedReaderTextWidth" apps/web/src
rg "CHAT_REFERENCES_RAIL_WIDTH_PX" apps/web/src
rg "resolvePaneWidthContract" apps/web/src/lib/workspace/schema.ts
```

`rg "min-content" apps/web/src` may remain empty. If future code introduces it,
it must not participate in pane shell width.

## Verification Commands

Focused frontend browser coverage:

```bash
cd apps/web && bun run test:browser -- \
  'src/lib/workspace/paneSizing.test.ts' \
  'src/lib/panes/paneRouteRegistry.test.tsx' \
  'src/components/workspace/WorkspaceHost.test.tsx' \
  'src/__tests__/components/PaneShell.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx'
```

Focused E2E:

```bash
make test-e2e PLAYWRIGHT_ARGS="tests/reader-pane-width.spec.ts tests/web-articles.spec.ts tests/epub.spec.ts tests/pane-chrome.spec.ts"
```

Routine full verification:

```bash
make verify
make test-e2e
```

Pre-merge broad verification:

```bash
make verify-full
```

## Cutover Completion Checklist

- [x] Route model owns width contracts.
- [x] Schema no longer derives width contracts by URL shape.
- [x] Effective pane sizing is centralized.
- [x] Runtime pane sizing is atomic.
- [x] Old runtime width setters are deleted.
- [x] Runtime sizing records are resource-key scoped and pruned.
- [x] Reader protected-width measurement is extracted from `MediaPaneBody`.
- [x] Reflowable text floor is scoped to web article and EPUB only.
- [x] Secondary rail widths are centralized.
- [x] E2E proves article and EPUB panes cannot stay below the protected floor.
- [x] Docs distinguish EPUB `?loc` pane state from hash target behavior.
- [x] README no longer links to missing reader docs.

## Key Decisions

### Keep Flat Panes

The existing flat pane canvas is the correct product model. It supports
side-by-side work, pane-local history, minimization, and mobile active-pane
rendering without introducing split-tree state. The cutover simplifies this
model; it does not replace it.

### Protect Configured Measure, Not Live Content

Reader comfort depends on configured measure. Live content intrinsic width is
unbounded and hostile to pane layout: long URLs, tables, code blocks, images,
and publisher EPUB markup can all create oversized intrinsic widths. Those
elements should scroll or wrap inside the reader content, not enlarge the pane
floor.

### Store Primary Width Only

Persisting outward rails would make a temporary reader tool change the user's
main pane preference. The store persists what the user resizes. Rails are
runtime additions.

### Make Runtime Sizing Atomic

A single publication prevents stale combinations such as new min width with old
extra width. The pane body owns its current runtime requirement and publishes it
as one fact.

### Scope Reader Floor To Reflowable Readers

PDF and transcript panes have different layout primitives. Giving them the
reader text floor couples unrelated readers and makes media panes wider for no
reading benefit.

## Risks

- Refactoring route width ownership can create import cycles if the pure route
  model imports React code. Keep it pure.
- Changing runtime sizing API touches multiple pane bodies. Delete old setters
  in the same change so no half-cutover survives.
- E2E width assertions can be flaky if they compare exact pixels. Assert lower
  bounds and visible text measure, not exact browser font metrics.
- Browser font metrics can differ by platform. Tests must derive expected floor
  from measured DOM where possible.
- `ResizeObserver` tests must run in browser/component or Playwright contexts,
  not pure node tests.

## Out Of Scope Until After Cutover

- User-resizable secondary rails.
- Persisted per-pane rail open state.
- Visual regression screenshot baseline system.
- Generalized layout manager for arbitrary nested panes.
- Per-document reader width overrides.
