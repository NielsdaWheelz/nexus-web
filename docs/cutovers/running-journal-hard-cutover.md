# The Running Journal — Final Contract

**Status:** BUILT

**Type:** Hard cutover; one final architecture, no compatibility paths.

## Scope

This document owns the two editorial furniture primitives that survived the
cutover: `RunningHead` in pane chrome and `SectionOpener` in scrolling list
content. Route identity, header resolution, desktop/mobile projection,
resource credits, actions, geometry, and focus behavior are owned by
[`pane-header-identity-hard-cutover.md`](pane-header-identity-hard-cutover.md).

## Final State

```text
PaneRouteModel.header
  -> resolvePaneHeaderModel
  -> PaneHeaderIdentity
       section  -> RunningHead
       resource -> ResourceHead

collection body -> CollectionView / PaneSurface -> SectionOpener
```

`RunningHead` is the section-header identity projection. It receives a stable
DOM id, a resolved standing-head string, and a typed `Folio`. It renders
supplementary `<p>`/`<span>` text, never the page heading. Pending folio text
is both visibly reserved and accessibly announced.

`SectionOpener` is optional scrolling body furniture for editorial collection
surfaces. It owns that surface's `<h1>`, optional standfirst, scale, pending
state, and narrowly scoped opener actions. `PaneSurface`/`CollectionView` own
placement; the primitive contains no route, workspace, transport, or domain
logic.

## Rules

- A pane has one route-declared header kind. Section and resource identity are
  discriminated projections, never interchangeable slots.
- `RunningHead` and `SectionOpener` remain domain-free UI primitives.
- Route defaults live in `paneRouteModel.ts`; publication acceptance and
  pending/ready/error resolution live in `paneHeaderModel.ts`.
- `PaneShell` composes resolved identity. Pane bodies publish typed data only;
  they do not replace chrome.
- The pane landmark's accessible name comes from the active header projection.
  A `SectionOpener` heading names body content; it does not duplicate chrome
  controls or resource credits.
- Folios use the closed `Folio` union and `formatFolio`. No free-form chrome
  metadata or body-derived header node is permitted.
- The 44px section-header and 60px resource-header/mobile geometry contracts
  remain owned by the pane-header specification and shared CSS tokens.
- A new route, header kind, or folio kind must make the owning exhaustive
  resolver fail at compile time until deliberately handled.

## Files

| Concern | Owner |
|---|---|
| Section identity rendering | `apps/web/src/components/ui/RunningHead.tsx` |
| Editorial body opener | `apps/web/src/components/ui/SectionOpener.tsx` |
| Typed folio | `apps/web/src/lib/ui/folio.ts` |
| Header composition | `apps/web/src/components/ui/PaneHeaderIdentity.tsx` |
| Route declaration | `apps/web/src/lib/panes/paneRouteModel.ts` |
| Header resolution | `apps/web/src/lib/panes/paneHeaderModel.ts` |
| Body placement | `apps/web/src/components/ui/PaneSurface.tsx`, `CollectionView.tsx` |

## Acceptance Criteria

- Every supported section route resolves a non-empty standing head and typed
  folio without a pane-body header override.
- Section and resource panes expose one pane-local accessible identity; pending
  section identity is never empty to assistive technology.
- `RunningHead` is not a heading; collection surfaces that use
  `SectionOpener` expose exactly one body `<h1>`.
- Desktop and mobile render the same resolved section model without parallel
  derivation.
- Primitive boundary guards reject route/workspace/domain imports.
- No superseded chrome, title-publication, or action descriptor API remains in
  source, tests, or current architectural guidance.

## Verification

The pane-header cutover's named unit, browser, and E2E suites are authoritative.
Primitive coverage additionally lives in `RunningHead.test.tsx`,
`SectionOpener.test.tsx`, and `paneSurfaceCutover.guards.test.ts`.
