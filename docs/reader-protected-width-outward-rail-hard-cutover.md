# Reader Protected Width And Outward Rail Hard Cutover

## Status

Target plan.

This document owns the desktop reader layout contract for preserving the
configured reading measure while the collapsed gutter or expanded reader
secondary rail is present.

The cutover is hard. The final state keeps no legacy encroaching rail behavior,
no feature flag, no query toggle, no old/new branch, no compatibility wrapper,
and no fallback path that silently shrinks the reader text column on desktop.

## Problem

The reader text already has a configured maximum measure through
`reader_profile.column_width_ch`. Reflowable readers apply it as
`--reader-column-width-ch` and center `.readerContentInner` inside the scroll
viewport.

The outer media layout does not protect that measure. Desktop media panes render
the reader column and `SecondaryRail` as flex siblings. The reader column has
`min-width: 0`, while the rail occupies 36px collapsed or 360px expanded. When
the rail expands, that width is taken from the reader side of the pane.

That makes the rail feel like it pushes into the page. The reader should instead
keep enough width for the configured prose measure plus reader padding, and rail
width should add outward from that protected reader area.

## Goals

- Preserve the configured reflowable reader text measure on desktop.
- Treat the reader's configured `column_width_ch` as the width invariant, not a
  best-effort decoration.
- Make collapsed and expanded reader tools occupy space outside the protected
  reader area.
- Grow the media pane outward when rail expansion needs more space.
- Keep the collapsed gutter and expanded rail scanline-aligned with the same
  projection subsystem already used by reader highlights.
- Keep mobile behavior viewport-bound: mobile keeps the 24px gutter and local
  drawer/sheet behavior.
- Keep `SecondaryRail` layout-only and reader-agnostic.
- Make workspace pane width clamping honor media pane layout needs instead of
  globally reclamping media to the standard pane maximum.
- Use one final implementation path with focused tests.

## Non-Goals

- Do not redesign the reader typography controls.
- Do not change saved highlight anchors, projection semantics, or row placement.
- Do not make mobile use a persistent expanded rail.
- Do not introduce a slide-over, modal, or overlay replacement for the desktop
  secondary rail.
- Do not make `SecondaryRail` know about media, EPUB, PDF, transcripts,
  highlights, Ask, notes, or workspace routing.
- Do not persist DOM measurements, viewport measurements, rail positions, or
  marker positions.
- Do not restore deleted desktop overlay/list behavior.
- Do not add a user setting for this layout mode.

## Hard-Cutover Policy

- No feature flags.
- No environment toggles.
- No query toggles.
- No old/new component branches.
- No compatibility wrappers around removed behavior.
- No fallback to encroaching expansion when the pane is narrow.
- No silent clamping that prevents the protected reader width from being honored
  on desktop.
- Rewrite or delete tests that assert the old encroaching behavior.
- Update docs that describe reader rail expansion without the protected-width
  contract.

## Final State

Desktop media panes have a protected reader area and an outward rail area.

```text
media pane width
  = protected reader width
  + active reader tools width
```

Protected reader width is the width needed for the active reader profile's text
measure plus reader inline padding and any required local reader margin.

```text
protected reader width
  = rendered width of var(--reader-column-width-ch)
  + reader root inline padding
```

Active reader tools width is:

- 0px when no desktop reader tools are mounted.
- 36px when the desktop secondary rail is collapsed.
- 360px when the desktop secondary rail is expanded, unless a final rail width
  constant changes that width in one place.

When the rail expands, the media pane requests enough width for the expanded rail
without reducing the protected reader width. If the current pane is already wide
enough, no width change occurs. If not, the pane grows to the required width and
the workspace may horizontally scroll.

Collapsing the rail does not automatically shrink the pane. Width shrink remains
an explicit user resize action. This avoids layout oscillation and preserves the
reader's stable center after the rail is closed.

Mobile remains viewport-bound. The app renders only the active pane, the reader
uses the current responsive text behavior, the collapsed gutter is 24px where
supported, highlights expand into the local drawer, and Ask uses the mobile
sheet.

PDF readers follow the same rail-outward rule. They do not use
`column_width_ch`, but the rail must still not reduce the PDF viewport below its
reader-local minimum.

## Target Behavior

### Desktop Open

1. Opening readable media creates a media pane wide enough for the default reader
   profile and collapsed reader tools.
2. Reflowable text renders at its configured `column_width_ch` whenever the pane
   has been expanded to its protected width.
3. The collapsed gutter appears at the right edge of the protected reader area
   and does not reduce the prose measure.
4. A workspace with multiple panes may horizontally scroll if the media pane
   needs more width than the visible workspace area.

### Desktop Expand

1. Activating the gutter expand affordance opens the existing reader secondary
   rail.
2. Before or during expansion, the media pane requests at least:
   `protectedReaderWidthPx + expandedRailWidthPx`.
3. The reader column keeps its protected width.
4. The expanded rail appears to the reader's right.
5. Other workspace panes move outward according to the existing horizontal
   workspace layout. They are not overlaid by the media rail.
6. The reader scroll position, highlight focus, and projection state are
   preserved.

### Desktop Collapse

1. Collapsing the rail returns to the 36px gutter when highlights are available.
2. The pane width is not automatically reduced.
3. Reader content remains centered inside the now-wider reader side.
4. The user can explicitly resize the pane narrower, but not below the effective
   protected desktop minimum while reader tools are active.

### Reader Profile Changes

1. Changing font family, font size, line height, column width, theme, focus mode,
   or hyphenation invalidates reader projection measurement as it does today.
2. Changing font family, font size, or `column_width_ch` recomputes protected
   reader width.
3. If the new protected width exceeds current pane width, the media pane requests
   the new minimum.
4. If the new protected width is smaller than current pane width, the pane is not
   automatically shrunk.

### Workspace Resize

1. Desktop pane resizing cannot persist a media pane width below its effective
   protected minimum.
2. Workspace URL decoding and store updates preserve route-specific or
   runtime-published media pane width requirements.
3. Standard panes keep standard width behavior.
4. Media panes can exceed the standard pane maximum when their protected reader
   width plus rail requires it.

## Architecture

### Width Ownership

`MediaPaneBody` owns reader-local layout requirements because it already owns:

- reader profile consumption
- secondary rail mode
- secondary rail expanded/collapsed state
- reader assistant state
- highlight DTO shaping
- mobile drawer/sheet composition

`MediaPaneBody` does not own workspace rendering. It publishes the media pane's
effective minimum/preferred width to the workspace shell through pane runtime.

`PaneShell` owns shell width application.

`WorkspaceHost` owns passing runtime layout constraints between pane content,
shell descriptors, and resize actions.

`WorkspaceStore` owns persisted width updates and must stop using a single
standard-pane clamp for every route.

`SecondaryRail` remains layout-only. It exposes collapsed and expanded widths
through constants or props, but it does not compute reader width.

### Protected Width Measurement

Protected width must be based on actual rendered reader typography, not a hard
coded `font_size_px * column_width_ch` approximation.

Use one of these final mechanisms, not both:

- CSS-resolved measurement: put the reader font variables on the media layout
  root, use a hidden measurement element with
  `width: var(--reader-column-width-ch)`, and read its border-box width.
- CSS intrinsic constraint: apply `min-width:
  calc(var(--reader-column-width-ch) + 2 * var(--space-4))` to the reader
  column with the same reader font variables, and publish the same measured
  value to workspace.

The chosen implementation must have one source of truth for the active measured
protected width. Do not maintain separate approximate JS and CSS formulas that
can drift.

### Width Request Flow

```text
reader profile + rail state
  -> protectedReaderWidthPx
  -> requiredMediaPaneWidthPx
  -> pane runtime layout request
  -> workspace shell effective min/preferred width
  -> store resize when current width is too small
  -> PaneShell width/minWidth/maxWidth style
```

The request is monotonic during automatic changes: it may grow the pane to avoid
encroachment, but it does not automatically shrink it.

### Desktop CSS Layout

The media body keeps a single desktop layout path:

```text
.splitLayout
  .readerColumn
    reader surface
  SecondaryRail
```

The reader column receives an effective desktop `min-width` equal to the
protected reader width. The rail remains a fixed-size sibling.

The mobile reader-with-gutter grid remains separate because mobile has different
mounting behavior and no persistent expanded rail.

## Structure

### Runtime Layout Constraints

Add a pane runtime mechanism for body-owned layout constraints.

It should support the concrete current need:

- publish effective minimum pane width
- request pane growth when current width is below that minimum
- clear the request on unmount or route change

Do not add speculative options for height, placement, breakpoints, animations,
or future pane policies.

### Route And Store Width Clamping

The workspace must stop treating all panes as `320..1400`.

Final behavior:

- standard panes use standard min/max width.
- media panes keep their route default width.
- media panes can persist widths above the standard max when required by reader
  protected width or route max.
- decoded workspace URLs are sanitized without destroying valid media widths.
- resize keyboard and pointer paths use the same effective constraints.

### Reader Layout Constants

Define rail widths in one place:

- collapsed reader tools width: 36px desktop
- expanded reader tools width: 360px desktop
- mobile gutter width: 24px

If the constants live outside `SecondaryRail`, `SecondaryRail` consumes them. If
they live inside `SecondaryRail`, media layout imports them from the defining
module rather than duplicating raw numbers.

## Rules

- Reflowable desktop reader text measure is protected.
- Rail expansion grows outward; it never consumes protected reader width.
- Automatic layout changes may grow the pane but must not shrink it.
- Mobile viewport constraints override desktop protected-width behavior.
- `SecondaryRail` stays layout-only.
- `MediaPaneBody` owns reader-local composition and publishes layout needs.
- Workspace owns pane width application and persistence.
- Store, URL codec, pointer resize, and keyboard resize must share effective
  width constraints.
- Do not persist measured protected width; persist only pane width.
- Do not add fallback branches for old encroaching rail behavior.
- Do not clamp media pane width to standard-pane max after a route-specific or
  runtime-specific width has been accepted.
- Do not use approximations where CSS can resolve actual reader typography.

## Files

### Add

- `apps/web/src/lib/panes/paneLayoutRuntime.ts` or equivalent small runtime
  helper if keeping layout-specific code out of `paneRuntime.tsx` is cleaner.
- Focused tests for route/runtime pane width constraints if existing tests cannot
  cover the new contract directly.

### Change

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - compute and publish protected reader width.
  - request outward pane growth on desktop rail expansion and reader profile
    width increases.
  - remove any duplicated raw rail width numbers.

- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
  - add the protected desktop reader-column min-width.
  - add a single measurement/probe style if measurement uses CSS-resolved DOM.
  - keep reader theme token scopes intact.

- `apps/web/src/components/secondaryRail/SecondaryRail.tsx`
  - expose or consume canonical collapsed/expanded width constants.
  - remain layout-only.

- `apps/web/src/components/secondaryRail/SecondaryRail.module.css`
  - keep fixed rail sizing and overflow behavior aligned with the constants.

- `apps/web/src/lib/panes/paneRuntime.tsx`
  - expose the minimal runtime API needed for pane content to publish layout
    width requirements.

- `apps/web/src/components/workspace/WorkspaceHost.tsx`
  - receive layout requirements from pane content.
  - pass effective width constraints to `PaneShell`.
  - trigger resize when the current pane width is below the effective minimum.

- `apps/web/src/components/workspace/PaneShell.tsx`
  - use effective min/max/current width for desktop shell styles.
  - keep mobile width forced to `100%`.

- `apps/web/src/components/workspace/useResizeHandle.ts`
  - clamp pointer and keyboard resizing against effective width constraints.

- `apps/web/src/lib/workspace/schema.ts`
  - replace or supplement global width clamping so media widths above the
    standard pane max survive sanitize/decode when valid.

- `apps/web/src/lib/workspace/store.tsx`
  - apply effective route/runtime-aware width clamping on resize/open/restore
    paths.

- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
  - keep media route sizing aligned with the final media pane width policy.

### Tests

- `apps/web/src/lib/workspace/schema.test.ts`
  - media widths above the standard pane max survive sanitize when valid.
  - standard panes still clamp to standard constraints.

- `apps/web/src/lib/workspace/store.test.tsx`
  - resizing a media pane below effective protected min clamps to the protected
    min.
  - resizing standard panes remains unchanged.

- `apps/web/src/__tests__/components/PaneShell.test.tsx`
  - keyboard resize honors effective min/max.

- `apps/web/src/__tests__/components/WorkspacePaneStrip.test.tsx` or existing
  workspace host tests
  - automatic media growth does not affect active pane identity or minimized
    panes.

- `apps/web/src/__tests__/components/MediaPageReaderThemeStyles.test.tsx`
  - reader theme variables remain scoped and intact.

- A browser or e2e test where jsdom is insufficient:
  - open a media pane with text reader.
  - record `.readerContentInner` width.
  - expand the gutter.
  - assert `.readerContentInner` width is unchanged and the media pane grows or
    workspace horizontal overflow increases.

## Key Details

- The protected-width contract applies to web article, EPUB, and transcript
  prose surfaces.
- Transcript pages may have playback and segment UI above the prose. The
  protected-width contract applies to the active transcript prose reader, not to
  every transcript control row.
- EPUB TOC is inside `.readerContentInner`, so it inherits the same protected
  width.
- PDF uses reader viewport minimums rather than `column_width_ch`, but rail
  expansion still cannot reduce the PDF viewport below its effective minimum.
- The workspace may become horizontally scrollable on desktop. That is expected
  and preferable to shrinking the reader.
- The final implementation should use `ResizeObserver` for the measurement probe
  or reader container where actual rendered width can change.
- `reader_profile.column_width_ch` remains the source of truth for reflowable
  reader measure. Do not introduce a second reader-width preference.

## Key Decisions

- Reader measure is the invariant; rail width is additive.
- Expansion grows outward; it does not encroach.
- Collapse does not auto-shrink.
- Mobile keeps existing drawer/sheet behavior.
- Width measurement should be CSS-resolved, not estimated from font-size math.
- Workspace width clamping must become media-aware enough to honor the reader.
- `SecondaryRail` remains generic and layout-only.
- There is no legacy encroaching mode.

## Acceptance Criteria

- Desktop web article, EPUB, and transcript readers keep the same
  `.readerContentInner` width before and after expanding the reader rail, when
  the configured width is within the profile's requested measure.
- Expanding the gutter to the secondary rail increases media pane width when the
  current pane is too narrow.
- The expanded rail appears to the right of the protected reader area.
- The reader scroll position does not jump when the rail expands or collapses.
- Highlight markers and rows remain scanline-aligned after rail expansion.
- Collapsing the rail does not automatically shrink the pane.
- Changing `column_width_ch` upward grows the media pane when needed.
- Changing `column_width_ch` downward does not automatically shrink the pane.
- Standard workspace panes retain standard min/max behavior.
- Media pane widths above the standard pane max are not destroyed by store
  updates or workspace URL decoding when valid for media.
- Desktop workspace horizontal scrolling is allowed when the protected media pane
  exceeds visible workspace width.
- Mobile behavior is unchanged: active pane only, 24px gutter where supported,
  highlights drawer, Ask sheet.
- No code path remains where desktop rail expansion silently reduces protected
  reader width.
- No feature flag, compatibility wrapper, fallback branch, or legacy rail mode is
  present.
