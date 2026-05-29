# Workspace Pane Width Cutover

## Status

This is the target contract and implementation plan for simplifying workspace
pane widths.

The cutover is strict:

- One primary pane width rule for every non-PDF pane.
- Default primary width equals minimum primary width.
- The non-PDF primary width is the measured reader text content floor.
- PDF panes are the only primary-width exception.
- Overview rulers and secondary rails are runtime extra width.
- Pane width policy has one owner.
- Effective pane sizing has one calculation.
- Runtime pane sizing has one API.
- No stale route-specific width defaults.
- No compatibility path for old pane width behavior.

Any code path that keeps the old per-layout defaults, adds overview ruler width
to primary width, or gives PDF the universal text floor is wrong and should be
deleted.

## Problem Statement

The workspace pane implementation already has the right product shape: a flat
ordered list of panes rendered in one horizontal desktop canvas, with one active
pane on mobile. The remaining problem is width policy.

Today pane width policy is still shaped by old route categories:

- standard panes default wider than their minimum
- dense-list panes have a different default
- document panes have another default
- podcast detail panes have their own minimum and default
- media panes have a large static default
- web article and EPUB readers publish a special measured floor
- PDF panes bypass the reader text floor
- the reader overview ruler is folded into the reflowable reader primary floor

That creates a pane system that is technically centralized but product-wise hard
to predict. New panes open at arbitrary widths. Some panes can shrink to narrow
layouts while reader panes cannot. The overview ruler is treated like primary
content in one path but behaves like outward chrome in the UI. PDFs, which are
the only truly intrinsic-width reader, do not own their own pane floor.

The correct target is a hard cutover to one simple rule:

```text
non-PDF primary pane min/default = reader text content floor
PDF primary pane min/default = measured PDF page width
rendered pane width = primary pane width + runtime extra width
```

## Goals

- Make pane widths predictable.
- Make every non-PDF pane open at its minimum width.
- Make every non-PDF pane share the same minimum width.
- Base the shared width on the configured reader text content measure.
- Keep web article and EPUB protected reader text behavior.
- Apply that protected reader floor universally to non-PDF panes.
- Remove the overview ruler from the protected reader floor.
- Treat overview ruler width like secondary rail width: runtime extra width.
- Make PDF panes show the whole rendered PDF page by default.
- Make PDF panes impossible to shrink below their measured rendered page width.
- Keep desktop workspace panes as independent shells in one horizontal canvas.
- Keep mobile panes at viewport width with no desktop width publication.
- Keep persisted pane width as primary content width only.
- Keep outward UI chrome out of persisted primary width.
- Delete stale width constants, layout-kind width distinctions, and tests that
  preserve old behavior.
- Update docs and tests in the same cutover so the product contract is stated
  once and verified at the right surfaces.

## Non-Goals

- Replacing the flat workspace with nested split panes.
- Making arbitrary child panels independently resizable.
- Persisting overview ruler width.
- Persisting secondary rail width.
- Preserving old route-specific default widths.
- Preserving the old runtime `{ minWidthPx: null }` API shape.
- Supporting both old and new pane width schemas.
- Letting live article, EPUB, transcript, or arbitrary pane content determine
  non-PDF pane width.
- Using CSS `min-content` as a pane shell sizing authority.
- Making PDF pages obey the reflowable text column.
- Making PDF width depend on reader text typography.
- Adding per-document reader width overrides.
- Adding a generalized layout manager.

## Repository Rules

This cutover follows the repository rules in:

- `docs/rules/cleanliness.md`
- `docs/rules/module-apis.md`
- `docs/rules/simplicity.md`
- `docs/rules/testing_standards.md`

Applied here:

- One concern has one owner.
- A capability has one primary API.
- Duplicate derivations are deleted.
- Dead compatibility branches are deleted.
- Values are measured or normalized at the boundary and trusted afterward.
- Tests assert observable behavior at the owning surface.
- Browser-dependent width measurement is tested in browser or E2E contexts.

## Current Owners To Reuse

The existing architecture should be reused, not replaced:

- `apps/web/src/lib/panes/paneRouteModel.ts`
  owns route identity, body mode, resource refs, and route-level width policy.
- `apps/web/src/lib/workspace/paneWidth.ts`
  owns default-width and clamp helpers for persisted workspace widths.
- `apps/web/src/lib/workspace/paneSizing.ts`
  owns effective pane sizing math.
- `apps/web/src/lib/panes/paneRuntime.tsx`
  owns the pane body to workspace runtime sizing API.
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
  owns runtime sizing records and rendered pane descriptors.
- `apps/web/src/components/workspace/PaneShell.tsx`
  owns shell inline dimensions and resize ARIA.
- `apps/web/src/components/workspace/useResizeHandle.ts`
  owns pointer and keyboard resize interaction.
- `apps/web/src/lib/reader/ReaderContext.tsx`
  already wraps the authenticated workspace and owns reader profile access.
- `apps/web/src/components/secondaryRail/railSizing.ts`
  already centralizes secondary rail widths.
- `apps/web/src/components/PdfReader.tsx`
  owns PDF.js page rendering and knows rendered page geometry.

The cutover should consolidate into these owners. It should not introduce a
second width resolver, a second runtime width API, or per-pane local width
helpers.

## Target Behavior

### Primary Width

Every desktop pane has a primary width.

Primary width is the width the user resizes. It is stored in workspace state as
`WorkspacePaneState.widthPx`.

Primary width excludes:

- overview ruler width
- secondary rail width
- collapsed rail width
- mobile drawer width
- transient overlays

### Universal Non-PDF Width

Every non-PDF desktop pane uses the same primary width floor:

```text
reader text content floor =
  measured reader column width
  + reader inline padding
```

The floor uses the active reader profile:

- `reader_profile.font_family`
- `reader_profile.font_size_px`
- `reader_profile.line_height`
- `reader_profile.column_width_ch`

The value is measured in the browser with an offscreen probe. It is not derived
with a hard-coded `ch` multiplier.

The floor is not:

- live article width
- EPUB publisher markup width
- transcript content width
- table width
- code block width
- long URL width
- CSS `min-content`
- overview ruler width
- secondary rail width

### Default Equals Minimum

For every non-PDF pane:

```text
default primary width = minimum primary width = reader text content floor
```

Opening a new non-PDF pane stores the current measured reader text content floor
as `widthPx`.

If reader profile changes increase the floor, visible non-PDF panes whose stored
width is below the new floor are resized to the new floor.

If reader profile changes decrease the floor, user-expanded panes keep their
stored width. The new lower floor only affects future shrink clamping and future
default widths.

### PDF Width

PDF panes are the only exception to the universal primary floor.

For PDF panes:

```text
default primary width = minimum primary width = measured rendered PDF page width
```

The measured rendered PDF page width is the maximum rendered page width for the
loaded PDF at the active PDF viewer scale, including PDF.js page surface chrome
that is required to avoid horizontal clipping.

If pages have mixed sizes, use the maximum rendered page width. This guarantees
that a pane wide enough for one page is wide enough for every page at the same
scale.

If the active PDF zoom changes and the rendered page width changes, the PDF pane
publishes the new intrinsic primary width. The workspace resizes the stored
primary width upward only when it is below the new PDF floor. User-expanded
widths above the floor remain user-owned.

PDF width is measured from rendered PDF geometry, not reader text settings.

### Runtime Extra Width

Rendered pane width is:

```text
primary width + runtime extra width
```

Runtime extra width includes outward chrome:

- reader overview ruler
- reader secondary rail
- conversation references rail
- collapsed rail affordances, when they occupy horizontal space

Runtime extra width does not mutate stored `widthPx`.

Opening outward chrome increases rendered pane width. Closing it removes only
the outward extra width.

### Overview Ruler

The reader overview ruler is runtime extra width.

It must not be added to the primary pane floor.

It composes exactly like a rail:

```text
extraWidthPx += READER_OVERVIEW_RULER_WIDTH_PX
```

When the overview ruler is hidden, its contribution is `0`.

### Secondary Rails

Secondary rails remain runtime extra width.

Conversation panes, reader highlight rails, and document chat rails publish only
their outward rail width. They do not publish a primary min width unless they
are the PDF reader publishing measured PDF width.

### Mobile

Mobile panes render at viewport width.

Mobile ignores:

- universal reader text floor
- PDF intrinsic width
- runtime extra width
- overview ruler width
- secondary rail width

Mobile keeps the existing reader behavior:

- one active visible pane
- no desktop horizontal pane canvas
- no persistent desktop overview ruler
- no persistent desktop secondary rail
- highlights through drawer or direct interaction
- pane chrome local to the active pane

## Capability Contract

### Workspace Primary Metrics

The workspace needs one measured text-floor capability:

```ts
interface WorkspacePrimaryMetrics {
  primaryMinWidthPx: number;
  primaryDefaultWidthPx: number;
}
```

Rules:

- `primaryDefaultWidthPx === primaryMinWidthPx`.
- The value is measured from reader profile typography and padding.
- The value exists before the workspace store creates or sanitizes panes.
- The value is workspace-wide, not pane-local.
- It is not a CSS token source of truth.

### Pane Runtime Sizing

Replace the old nullable runtime min-width API with an explicit primary-width
source:

```ts
type PaneRuntimePrimaryWidth =
  | { kind: "workspace" }
  | { kind: "intrinsic"; widthPx: number };

interface PaneRuntimeSizing {
  primaryWidth: PaneRuntimePrimaryWidth;
  extraWidthPx: number;
}
```

Rules:

- `kind: "workspace"` means the pane uses the universal non-PDF floor.
- `kind: "intrinsic"` means the pane owns a measured primary width.
- PDF is the only shipped `intrinsic` publisher.
- `extraWidthPx` is always outward rendered width.
- `extraWidthPx` is finite and non-negative.
- `intrinsic.widthPx` is finite and positive.
- The runtime API is atomic: primary source and extra width publish together.
- There is no separate min-width setter.
- There is no separate extra-width setter.
- There is no nullable min-width sentinel.

Default runtime sizing is:

```ts
const DEFAULT_PANE_RUNTIME_SIZING = {
  primaryWidth: { kind: "workspace" },
  extraWidthPx: 0,
} satisfies PaneRuntimeSizing;
```

### Effective Sizing

`resolveEffectivePaneSizing` becomes the only sizing calculation:

```ts
effectivePrimaryFloorPx =
  runtime.primaryWidth.kind === "intrinsic"
    ? runtime.primaryWidth.widthPx
    : workspacePrimaryMetrics.primaryMinWidthPx;

primaryMinWidthPx = ceil(effectivePrimaryFloorPx);
primaryDefaultWidthPx = primaryMinWidthPx;
primaryMaxWidthPx = max(routeMaxWidthPx, primaryMinWidthPx);

primaryWidthPx = clamp(
  storedWidthPx,
  primaryMinWidthPx,
  primaryMaxWidthPx,
);

renderedWidthPx = primaryWidthPx + extraWidthPx;
renderedMinWidthPx = primaryMinWidthPx + extraWidthPx;
renderedMaxWidthPx = primaryMaxWidthPx + extraWidthPx;
```

Mobile short-circuits to viewport width and does not use runtime sizing.

### Route Width Policy

Route width policy no longer owns per-layout min/default values.

Route policy owns only:

- route identity
- body mode
- resource ref
- max width policy
- whether a route may publish intrinsic primary width

There is one non-PDF default/min width: the workspace measured text floor.

## API Design

### Route Model

`PaneWidthContract` should be reduced to the data routes still own:

```ts
interface PaneWidthContract {
  maxWidthPx: number;
  intrinsicPrimaryWidth: "none" | "allowed";
}
```

Expected route rules:

- Most routes: `intrinsicPrimaryWidth: "none"`.
- `/media/:id`: `intrinsicPrimaryWidth: "allowed"` because PDF media can
  publish intrinsic width.
- Route model does not decide media kind.
- Route model does not import media data.
- Route model does not import React.

Delete route width layout kinds if their only remaining purpose is selecting
old min/default values.

### Workspace Store

Workspace state shape remains:

```ts
interface WorkspacePaneState {
  id: string;
  href: string;
  widthPx: number;
  visibility: "visible" | "minimized";
  history: WorkspacePaneHistory;
}
```

Rules:

- `widthPx` is always primary width.
- New panes use `workspacePrimaryMetrics.primaryDefaultWidthPx`.
- State sanitization clamps using current width policy.
- Pane navigation preserves width only when it is still valid for the next pane.
- If a transition cannot preserve width under the new contract, it resets to the
  current default primary width.
- Schema version increments.
- Old encoded/session workspace states are not migrated.
- Tests that preserve old route defaults are deleted or rewritten.

### Workspace Host

`WorkspaceHost` receives or reads:

- workspace state
- route width policy
- workspace primary metrics
- runtime sizing records
- mobile viewport status

It builds host pane descriptors with `resolveEffectivePaneSizing`.

It owns the existing correction behavior:

- visible desktop pane below effective primary floor is resized upward
- invisible/minimized pane is not force-resized until visible
- correction writes primary width only
- extra width never writes to workspace state
- stale runtime records are ignored by `paneId + resourceKey`

### Pane Runtime

`PaneRuntimeProvider` exposes one runtime sizing command:

```ts
setPaneSizing(sizing: PaneRuntimeSizing): void;
```

Publishers:

- PDF media pane publishes intrinsic PDF width plus reader extras.
- Reflowable media pane publishes workspace primary width plus reader extras.
- Transcript media pane publishes workspace primary width plus reader extras.
- Conversation panes publish workspace primary width plus references rail extra.
- Panes with no outward chrome do not publish sizing.

### Reader Text Floor Measurement

Add one workspace-owned measurement capability. The exact file can be chosen
during implementation, but the owner should be under reader or workspace, not
inside a media pane:

```text
apps/web/src/lib/reader/useReaderTextContentFloor.tsx
```

or

```text
apps/web/src/lib/workspace/useWorkspacePrimaryMetrics.tsx
```

Rules:

- It uses `useReaderContext`.
- It renders one offscreen probe.
- It uses the same reader font family mapping as the media reader.
- It uses the same reader font size, line height, and column width.
- It includes reader inline padding.
- It returns no workspace metrics until a real measurement exists.
- `AuthenticatedShell` mounts the workspace only after metrics are available.
- No route or store function invents a pixel fallback for reader measure.

### PDF Width Measurement

`PdfReader` owns rendered page geometry.

Expose a narrow callback to the media pane:

```ts
interface PdfReaderProps {
  onIntrinsicPageWidthChange?: (widthPx: number | null) => void;
}
```

Rules:

- The callback reports maximum rendered page width.
- It reports `null` before a PDF page width can be measured.
- It re-reports after pages render, page sizes become known, rotation changes,
  or zoom changes.
- It reads actual `.page.getBoundingClientRect().width` where possible.
- It may fall back to pdf.js viewport width only inside PDF measurement code.
- It does not call pane runtime directly.
- `MediaPaneBody` composes PDF width with overview and rail extra width and
  publishes one atomic runtime sizing object.

### Outward Width Constants

All outward fixed widths should live in one module.

Current secondary rail constants live in:

```text
apps/web/src/components/secondaryRail/railSizing.ts
```

Cutover options:

- move `OVERVIEW_RULER_WIDTH_PX` into `railSizing.ts`, or
- rename the module to a broader outward-chrome sizing owner.

The final state must have one import source for:

- overview ruler width
- reader expanded rail width
- reader collapsed rail width
- conversation references rail width

## Composition With Other Systems

### Reader Profile

Reader profile drives the universal non-PDF floor.

When the profile changes:

- the workspace text floor is remeasured
- pane defaults for future opens change
- visible panes below the new floor resize upward
- user-expanded panes above the new floor remain unchanged
- web/EPUB reader columns remain protected because primary pane width is already
  at least the measured text floor

### Web Article And EPUB Readers

Web article and EPUB readers keep their protected text behavior.

The protection moves from media-pane-specific runtime min-width publication to
the workspace-wide primary floor.

The visible reader column may keep a CSS min width set to the same measured
floor for internal layout integrity, but that CSS is not the pane shell sizing
authority.

### Transcripts

Transcript panes use the universal non-PDF floor.

Transcript playback panels and segments do not derive pane width from their own
intrinsic content. Overflow, wrapping, or internal layout is transcript-owned.

### Conversations

Conversation panes use the universal non-PDF floor.

Conversation reference rails publish only extra width.

Existing and new conversation panes should share one small rail sizing hook or
component if that removes duplication without introducing a hollow abstraction.

### Libraries, Browse, Search, Notes, Settings, Pages, Authors, Podcasts

These panes use the universal non-PDF floor.

They no longer have route-specific default widths. Dense-list and document
distinctions can remain only if they still affect rendering or body mode; they
must not exist solely to select width values.

### PDF Reader

PDF panes publish intrinsic primary width.

PDF zoom, page, and resume state remain PDF reader state. Pane width composes
with PDF state by reflecting the currently rendered page width.

If the PDF page width is larger than the current stored primary width, the
workspace grows the primary width to show the page. If the user has already
resized wider, the workspace does not shrink them.

### Workspace URL And Session State

Workspace URL/session state continues to store `widthPx` as primary width.

Schema version increments because old width semantics are removed.

Old encoded pane widths are not interpreted as route-specific defaults. Invalid
or old workspace payloads are rejected at the boundary and replaced with a new
workspace state created under the new width contract.

### Mobile

Mobile ignores this desktop width system.

Reader profile can still be measured, but mobile rendering does not apply
desktop primary or extra widths.

## Final Architecture

### One Width Policy Source

`paneRouteModel.ts` remains the route model, but it stops owning min/default
pixel values.

`WorkspacePrimaryMetrics` owns the current measured default/min pixel value.

`paneSizing.ts` combines:

- route max policy
- current workspace primary metrics
- stored primary width
- runtime intrinsic primary width
- runtime extra width
- mobile status

No other module computes effective pane width.

### One Runtime Sizing API

`PaneRuntimeSizing` is the only body-to-shell sizing capability.

It publishes:

- primary source: workspace or intrinsic
- extra width

It does not publish separate min and extra values through independent paths.

### One Outward Width Model

Overview ruler and secondary rails are fixed outward chrome.

They are accumulated into `extraWidthPx`.

They are never persisted as primary width.

### One PDF Intrinsic Path

PDF measurement lives in the PDF reader.

PDF pane sizing publication lives in the media pane, where PDF measurement and
reader outward chrome are composed into one runtime sizing publication.

No route-level PDF special case is added.

## Implementation Scope

### Files To Change

- `docs/workspace-pane-layout-cutover.md`
- `docs/reader-implementation.md`
- `docs/reader-research.md`
- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx`
- `apps/web/src/lib/reader/ReaderContext.tsx`
- `apps/web/src/lib/reader/types.ts`
- `apps/web/src/lib/panes/paneRouteModel.ts`
- `apps/web/src/lib/panes/paneRouteModel.test.ts`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRuntime.test.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
- `apps/web/src/lib/workspace/paneWidth.ts`
- `apps/web/src/lib/workspace/paneSizing.ts`
- `apps/web/src/lib/workspace/paneSizing.test.ts`
- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/schema.test.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/workspace/store.test.tsx`
- `apps/web/src/lib/workspace/urlCodec.ts`
- `apps/web/src/lib/workspace/urlCodec.test.ts`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/useResizeHandle.ts`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/components/reader/ReaderOverviewRuler.tsx`
- `apps/web/src/components/secondaryRail/railSizing.ts`
- `apps/web/src/components/secondaryRail/SecondaryRail.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/PdfReader.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/app/(authenticated)/conversations/[id]/ConversationPaneBody.tsx`
- `apps/web/src/app/(authenticated)/conversations/new/ConversationNewPaneBody.tsx`
- `e2e/tests/reader-pane-width.spec.ts`
- `e2e/tests/pdf-reader.spec.ts`

### Files To Add

Add only if the code reads better with owned modules:

- `apps/web/src/lib/workspace/useWorkspacePrimaryMetrics.tsx`
- `apps/web/src/lib/workspace/workspacePrimaryMetrics.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaPaneSizing.ts`
- `apps/web/src/components/PdfReader.test.tsx` or browser component coverage if
  PDF measurement can be isolated without mocking internals

### Files Or Symbols To Delete

Delete if left with no remaining purpose:

- `DEFAULT_STANDARD_PANE_WIDTH_PX`
- `DEFAULT_DENSE_LIST_PANE_WIDTH_PX`
- `DEFAULT_DOCUMENT_PANE_WIDTH_PX`
- `DEFAULT_PODCAST_DETAIL_PANE_WIDTH_PX`
- `DEFAULT_MEDIA_PANE_WIDTH_PX`
- `MIN_PODCAST_DETAIL_PANE_WIDTH_PX`
- route layout kinds used only for width selection
- `useReflowableReaderPaneSizing` if it only publishes the old reflowable min
- CSS custom properties `--pane-min-width`, `--pane-default-width`,
  `--pane-max-width` if no active code uses them
- tests whose only purpose is preserving old route defaults
- tests asserting PDF panes stay at the old generic media width
- tests asserting transcript panes bypass the universal non-PDF floor
- stale doc text preserving the old PDF generic-width target or transcript
  floor exception

## Implementation Plan

### 1. Establish Workspace Primary Metrics

Add a workspace-level measured reader text floor.

Use the current reader typography mapping and reader profile.

Mount the workspace only after the metric has been measured. This avoids
inventing a second pixel fallback for the primary default.

### 2. Cut Route Width Contracts To Max Policy

Remove per-layout default/min widths from `paneRouteModel.ts`.

Keep route identity, body mode, resource ref, static title, and max width.

Mark `/media/:id` as allowing intrinsic primary width because PDF can publish
one after media load.

### 3. Cut Workspace Creation To Current Default

Change default pane creation, open-pane creation, sanitize, and width transition
logic to use current `WorkspacePrimaryMetrics.primaryDefaultWidthPx`.

Increment workspace schema version.

Delete old width default expectations.

### 4. Replace Runtime Sizing API

Replace `PaneRuntimeSizing` with explicit primary source plus extra width.

Update all publishers in one change:

- media panes
- conversation panes
- new conversation pane

Delete nullable min-width semantics in tests and implementation.

### 5. Move Overview Ruler To Extra Width

Centralize overview ruler width with other outward width constants.

Make media panes add overview ruler width to `extraWidthPx` whenever the ruler
is rendered on desktop.

Remove overview ruler width from reader primary floors and related assertions.

### 6. Move Web/EPUB Protection To Workspace Floor

Stop reflowable readers from publishing a pane-specific primary min.

Keep internal reader column protection only as layout integrity, not pane shell
sizing authority.

Ensure web/EPUB panes remain impossible to shrink below the reader text floor
because every non-PDF pane has that floor.

### 7. Add PDF Intrinsic Width Publication

Make `PdfReader` report maximum rendered page width.

Make `MediaPaneBody` publish:

```ts
{
  primaryWidth: { kind: "intrinsic", widthPx: measuredPdfPageWidthPx },
  extraWidthPx: overviewRulerWidthPx + secondaryRailWidthPx,
}
```

When PDF measurement is unavailable, the media pane must not pretend a PDF floor
exists. It can publish workspace primary width until the PDF reports geometry;
once geometry is known, it publishes intrinsic width and the host corrects.

### 8. Simplify Open-Pane Plumbing

Consolidate duplicated open-pane logic in `store.tsx` if still present after
width policy changes.

`buildPanesForOpen` should return one pane unless a real multi-pane open call
site exists. If no call site exists, replace array-shaped action plumbing with a
single-pane action.

### 9. Update Tests

Rewrite tests around the new observable contract:

- every non-PDF pane opens at the shared primary floor
- default equals minimum
- route categories no longer change default width
- web/EPUB still cannot shrink below text floor
- overview ruler adds rendered extra width
- secondary rails add rendered extra width
- extra width does not mutate stored primary width
- PDF pane auto-corrects to measured page width
- PDF cannot shrink below measured page width
- PDF width updates when rendered page width changes
- mobile ignores desktop primary and extra widths

## Acceptance Criteria

### Product Behavior

- Opening a standard pane uses the measured reader text floor as its primary
  width.
- Opening a dense list pane uses the same primary width as a standard pane.
- Opening a document pane uses the same primary width as a standard pane.
- Opening a conversation pane uses the same primary width as a standard pane.
- Opening a transcript pane uses the same primary width as a standard pane.
- Opening a web article pane uses the same primary width as a standard pane.
- Opening an EPUB pane uses the same primary width as a standard pane.
- All non-PDF panes report the same resize handle minimum on desktop.
- All non-PDF panes report resize handle current width equal to minimum when
  newly opened.
- Drag resize cannot reduce any non-PDF pane below the shared floor.
- Keyboard resize cannot reduce any non-PDF pane below the shared floor.
- Web article and EPUB text columns are not compressed below configured reader
  measure.
- Reader overview ruler increases rendered width but does not increase primary
  width.
- Reader secondary rail increases rendered width but does not increase primary
  width.
- Conversation reference rail increases rendered width but does not increase
  primary width.
- Closing outward chrome removes only its extra rendered width.
- Opening/closing outward chrome does not mutate stored primary `widthPx`.
- PDF panes auto-correct to measured rendered PDF page width once PDF geometry is
  known.
- PDF panes cannot be shrunk below measured rendered PDF page width.
- Mixed-size PDFs use the maximum rendered page width.
- Mobile panes render at viewport width and ignore desktop width publication.

### Architecture

- One workspace-wide reader text floor measurement exists.
- `paneRouteModel.ts` does not define route-specific default/min widths.
- `paneSizing.ts` is the only effective sizing calculation.
- `PaneRuntimeSizing` has one atomic API.
- Runtime sizing uses explicit `workspace` vs `intrinsic` primary source.
- Overview ruler width is imported from the same outward-width owner as rail
  widths.
- `MediaPaneBody` does not measure reader text floor.
- `PdfReader` does not import pane runtime.
- PDF intrinsic measurement flows through a narrow callback to `MediaPaneBody`.
- `WorkspaceHost` remains the only runtime sizing record owner.
- `PaneShell` consumes resolved sizing and does not recompute width policy.
- `useResizeHandle` clamps against resolved primary bounds only.

### Deletion Checks

These searches must return no production matches:

```bash
rg "DEFAULT_STANDARD_PANE_WIDTH_PX|DEFAULT_DENSE_LIST_PANE_WIDTH_PX|DEFAULT_DOCUMENT_PANE_WIDTH_PX|DEFAULT_PODCAST_DETAIL_PANE_WIDTH_PX|DEFAULT_MEDIA_PANE_WIDTH_PX" apps/web/src
rg "MIN_PODCAST_DETAIL_PANE_WIDTH_PX" apps/web/src
rg "minWidthPx: null" apps/web/src
rg "setPaneMinWidth|setPaneExtraWidth" apps/web/src
rg "useReflowableReaderPaneSizing" apps/web/src
rg -- "--pane-min-width|--pane-default-width|--pane-max-width" apps/web/src
```

`rg "min-content" apps/web/src` may only match code that is unrelated to pane
shell sizing.

### Docs

- Reader docs state that the reader text floor is workspace-wide for non-PDF
  panes.
- Reader docs state that overview ruler width is runtime extra width.
- Reader docs state that PDF panes publish intrinsic page width.
- No doc states as target behavior that PDF panes keep generic media width or
  transcript panes bypass the universal non-PDF floor.
- No doc states as target behavior that route categories own default pane width.

## Verification Commands

Focused frontend browser coverage:

```bash
cd apps/web && bun run test:browser -- \
  'src/lib/workspace/paneSizing.test.ts' \
  'src/lib/panes/paneRouteModel.test.ts' \
  'src/lib/panes/paneRuntime.test.tsx' \
  'src/components/workspace/WorkspaceHost.test.tsx' \
  'src/__tests__/components/PaneShell.test.tsx' \
  'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx'
```

Focused E2E:

```bash
make test-e2e PLAYWRIGHT_ARGS="tests/reader-pane-width.spec.ts tests/pdf-reader.spec.ts tests/pane-chrome.spec.ts"
```

Routine verification:

```bash
make verify
make test-e2e
```

Pre-merge verification:

```bash
make verify-full
```

## Key Decisions

### Keep Flat Panes

The flat horizontal pane canvas is still the right product model. Width
simplification does not require a new layout manager.

### One Non-PDF Floor

The reader text content floor is the best shared minimum because it is already
the application's strictest comfortable reading measure. Applying it universally
makes all non-PDF panes predictable and removes route-specific defaults.

### Default Equals Minimum

New panes should not consume more horizontal space than their minimum. If the
user wants a wider pane, resizing remains explicit and persisted.

### Overview Ruler Is Outward Chrome

The overview ruler is not primary content width. It behaves like a rail: it is
visible desktop chrome appended beside content. It belongs in runtime extra
width.

### PDFs Are Intrinsic

PDF pages have fixed rendered geometry. They are the only pane type whose
primary minimum should come from document geometry rather than the reader text
floor.

### Runtime Intrinsic Width Is Explicit

Allowing runtime width to silently raise or lower a generic min width makes
exceptions hard to audit. The runtime API states whether primary width comes
from the workspace floor or intrinsic content.

### Store Primary Width Only

Persisting outward chrome width would make transient tools change the user's
content width preference. The store persists primary width only.

### No Compatibility Width Layer

Old route defaults and old runtime min semantics are removed. Tests and docs
must move to the new contract in the same cutover.

## Risks

- Measuring reader text floor before workspace mount can affect initial shell
  timing. Keep the probe small and deterministic.
- Changing workspace state sanitization touches URL/session restore. Increment
  schema and test old payload rejection.
- PDF measurements can arrive after initial pane render. Use the existing host
  correction path and assert behavior after geometry is known.
- PDF zoom-driven width changes can grow panes. This is the direct consequence
  of making PDF width intrinsic to rendered page geometry.
- Mixed-size PDFs can create wide panes. Use maximum page width because the
  product rule is "show the whole thing."
- Exact pixel assertions can be flaky across fonts and platforms. Tests should
  derive expected floor from measured DOM whenever possible.

## Out Of Scope Until After Cutover

- User-resizable rails.
- Per-document reader width overrides.
- Visual regression screenshot baseline system.
- Nested panes.
- Arbitrary split panes.
- Persisted secondary rail state.
- Persisted overview ruler width.
