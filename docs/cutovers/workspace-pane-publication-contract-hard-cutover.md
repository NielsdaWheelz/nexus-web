# Workspace Pane Publication Contract Hard Cutover

Status: SPEC
Author: Codex
Type: hard cutover
Date: 2026-06-20

## North Star

Pane bodies publish ephemeral workspace capabilities through one canonical value
contract. The route body says, "this pane currently offers these secondary
surfaces" or "this pane currently offers this fixed primary chrome." The
workspace host accepts, validates, canonicalizes, stores, and renders those
publications using the same pure semantics everywhere.

The architecture is:

```text
route body
  -> pane publication hook
  -> canonical pane publication value helpers
  -> WorkspaceHost route-keyed publication records
  -> PaneShell / SecondaryPaneShell / MobileSecondaryPaneHost
```

No component owns a private second definition of publication equality,
normalization, or membership.

## Type

Hard cutover. No legacy helper copies, no compatibility exports for old private
helpers, no fallback equality branches, no dual raw/canonical comparison paths,
and no per-component publication validation.

If two files answer "are these pane publications the same?", one of them stops
answering. If two files answer "is this secondary surface included in this
publication?", one of them stops answering. If a publication value needs
canonicalization, exactly one module owns that canonicalization.

## SME Thesis

A subject matter expert would not patch rerender churn one call site at a time.
They would name the missing contract:

> Pane publications are route-local capability values, not component-local
> React implementation details.

The existing code already has the correct host and render owners:

- `WorkspaceHost` owns route-keyed publication records, stale route guards,
  pruning, pending secondary requests, and mobile/desktop composition.
- `PaneSecondary` and `PaneFixedChrome` own React context/hook transport from a
  routed body into the host.
- `PaneShell` owns desktop primary pane geometry, fixed chrome rendering, and
  desktop attached secondary column mounting.
- `SecondaryPaneShell` owns desktop secondary chrome.
- `MobileSecondaryPaneHost` owns mobile secondary sheet chrome.
- `paneSecondaryModel` owns pure secondary group/surface metadata and validates
  surface-to-group membership.

The missing layer is a pure pane-publication value module. It should define the
publication payload shapes and the operations that make those payloads safe and
stable across every consumer.

The wrong moves are:

- creating a generic `utils.ts`;
- moving route-keyed host state out of `WorkspaceHost`;
- moving React hooks into a pure module;
- adding provider-level validation in `PaneRuntimeProvider`;
- validating publications in every route body;
- preserving old private equality helpers next to a new shared helper;
- comparing raw fixed-chrome widths in one place and rounded widths elsewhere;
- using JSON serialization or object identity for React-node-bearing values;
- making mobile fixed-chrome suppression a publication-normalization concern.

## Governing Rules And Docs

- `docs/rules/cleanliness.md` requires repeated validators, normalizers,
  derived-state calculations, constants, and near-identical branches to collapse
  to one owner.
- `docs/rules/cleanliness.md` also warns against hollow generic helpers and
  unpaid indirection. The new module must own real semantics.
- `docs/rules/simplicity.md` requires one primary form per capability and no
  speculative options or flags.
- `docs/rules/boundaries.md` requires boundary conversion to produce a narrow
  representation that downstream code does not repeatedly re-validate.
- `docs/rules/effect-services.md` says to default to pure helpers when behavior
  can be externalized without exposing runtime wiring.
- `docs/local-rules/testing_standards.md` places pure normalization functions in
  frontend unit tests near `apps/web/src/lib`.
- `docs/modules/workspace.md` keeps workspace composition decisions in
  `WorkspaceHost` and makes fixed primary chrome desktop-only.
- `docs/modules/panes-tabs.md` keeps mobile workspace free of desktop fixed
  chrome, desktop secondary columns, and desktop resize handles.
- `docs/cutovers/pane-route-resource-identity-hard-cutover.md` makes `routeKey`
  the guard for stale title, layout, fixed-chrome, and secondary-publication
  records.

## Current State

### Publication Shape Owners

Today publication type definitions live in React component modules:

- `apps/web/src/components/workspace/PaneSecondary.tsx`
  - `PaneSecondarySurfacePublication`
  - `PaneSecondaryPublication`
  - `PaneSecondaryContext`
  - `usePaneSecondary`
  - private `arePaneSecondaryPublicationsEqual`
- `apps/web/src/components/workspace/PaneFixedChrome.tsx`
  - `PaneFixedChromePublication`
  - `PaneFixedChromeContext`
  - `usePaneFixedChrome`
  - private `arePaneFixedChromePublicationsEqual`

Those files are valid React transport owners, but they are not the right final
owners for pure publication value semantics.

### Duplicated Equality And Normalization

`WorkspaceHost` duplicates and extends publication semantics:

- `normalizePaneSecondaryPublication`
- `arePaneSecondaryPublicationsEqual`
- `normalizePaneFixedChromePublication`
- inline fixed-chrome equality inside
  `upsertOrDeletePaneFixedChromePublicationRecord`
- `secondaryPublicationIncludesSurface`

The secondary hook compares raw publication values to suppress repeated
publishes. The host compares normalized publication values to avoid redundant
record updates. Fixed chrome is more dangerous: the hook compares raw `widthPx`,
while the host rounds `widthPx` with `Math.ceil` before comparing. That means
the codebase has two possible answers for whether `{ widthPx: 28.1 }` and
`{ widthPx: 29 }` are equivalent.

### Repeated Active-Surface Membership Logic

Secondary publication membership is also repeated:

- `WorkspaceHost` checks whether a persisted secondary pane is backed by the
  active route publication.
- `PaneShell` computes whether desktop secondary chrome is visible.
- `MobileSecondaryPaneHost` computes active sheet state from publication,
  secondary state, and active surface.
- `SecondaryPaneShell` finds the active secondary surface body.
- `WorkspaceHost.test.tsx` mocks the same shape in the mocked
  `MobileSecondaryPaneHost`.

This is adjacent to the equality cleanup. It should be consolidated only at the
publication-value level, not by moving presentation ownership out of those
components.

### Existing Patterns To Reuse

Use these patterns:

- `apps/web/src/lib/panes/paneSecondaryModel.ts` is the precedent for a pure,
  isomorphic pane-domain module. It owns secondary group/surface metadata and
  exposes precise helpers.
- `apps/web/src/lib/workspace/paneSizing.ts` is the precedent for canonicalizing
  pane runtime numeric values in one pure module and unit-testing the edge cases.
- `apps/web/src/lib/panes/paneRuntime.tsx` is the precedent for React runtime
  transport staying separate from pure value modules.
- `apps/web/src/components/workspace/PaneShell.tsx` has a local
  `arePaneChromeOverridesEqual` helper. That is a related publication-like
  pattern, but it is chrome override state local to `PaneShell`, not this
  cross-component workspace publication contract.

Do not generalize all equality helpers into one broad comparator. The shared
module should be specific to pane publication values.

## Target Behavior

After the cutover:

- There is exactly one public module that defines pane publication value shapes
  and value semantics:
  `apps/web/src/lib/panes/panePublications.ts`.
- `PaneSecondary.tsx` imports publication types and equality from that module and
  keeps only context plus `usePaneSecondary`.
- `PaneFixedChrome.tsx` imports publication types and equality from that module
  and keeps only context plus `usePaneFixedChrome`.
- `WorkspaceHost.tsx` imports publication normalization, equality, and
  membership helpers from that module.
- `PaneShell.tsx`, `SecondaryPaneShell.tsx`, and `MobileSecondaryPaneHost.tsx`
  import secondary active-surface lookup from that module instead of repeating
  `publication.surfaces.find(...)` or equivalent membership checks.
- Publication type imports throughout the app point at
  `@/lib/panes/panePublications`.
- No private `arePaneSecondaryPublicationsEqual` or
  `arePaneFixedChromePublicationsEqual` helper remains in component files.
- No private `normalizePaneSecondaryPublication` or
  `normalizePaneFixedChromePublication` helper remains in `WorkspaceHost`.
- Secondary publication validation defects on invalid owned values:
  empty surface list, duplicate surface id, surface outside its group, and
  default surface not present.
- Fixed-chrome publication validation defects on negative or non-finite width.
- Fixed-chrome width canonicalization is explicit and tested.
- Publication equality uses the canonical semantics used by the host.
- Mobile fixed chrome remains inert because `WorkspaceHost` and `PaneShell`
  suppress desktop fixed chrome in mobile mode, not because the publication value
  is rewritten for mobile.
- Existing route body producer sites continue to publish memoized publication
  descriptors. The new module does not compensate for unstable producer values.

## Final Architecture

### Pure Publication Module

New owner:

```text
apps/web/src/lib/panes/panePublications.ts
```

Responsibilities:

- publication type definitions;
- validation and canonicalization for accepted publication values;
- equality semantics for secondary and fixed-chrome publications;
- active-surface lookup and membership helpers for secondary publications.

The module may import:

- `type ReactNode` from `react`;
- `WorkspaceSecondaryGroupId` and `WorkspaceSecondarySurfaceId` from
  `paneSecondaryModel`;
- `secondarySurfaceBelongsToGroup` from `paneSecondaryModel`.

The module must not import:

- `WorkspaceHost`;
- `PaneShell`;
- React hooks;
- browser APIs;
- workspace store;
- route table;
- CSS modules;
- test helpers.

### React Transport Modules

`PaneSecondary.tsx` final shape:

- exports `PaneSecondaryContext`;
- exports `usePaneSecondary`;
- uses `arePaneSecondaryPublicationsEqual` from `panePublications`.
- does not define or re-export publication types.

`PaneFixedChrome.tsx` final shape:

- exports `PaneFixedChromeContext`;
- exports `usePaneFixedChrome`;
- uses `arePaneFixedChromePublicationsEqual` from `panePublications`.
- does not define or re-export publication types.

These modules do not validate. They are publish transports. The host remains the
acceptance boundary because it owns route-key staleness and record storage.

### Workspace Host

`WorkspaceHost` final shape:

- keeps `PaneSecondaryPublicationRecord` and
  `PaneFixedChromePublicationRecord`;
- keeps route-key guards in `publishPaneSecondary` and
  `publishPaneFixedChrome`;
- keeps route-key pruning;
- calls `normalizePaneSecondaryPublication` before storing a non-null secondary
  publication;
- calls `normalizePaneFixedChromePublication` before storing a non-null fixed
  chrome publication;
- uses shared equality helpers for record stability;
- uses shared membership helpers for persisted secondary validation and pending
  secondary request handling;
- continues to pass `fixedChromePublication: null` to mobile panes.

`WorkspaceHost` must not become a generic publication service. It remains the
workspace composition owner.

### Render Components

`PaneShell`, `SecondaryPaneShell`, and `MobileSecondaryPaneHost` use shared
publication active-surface helpers to avoid repeating membership lookup.

They still own presentation:

- `PaneShell` decides whether desktop secondary and fixed chrome are visible.
- `SecondaryPaneShell` renders desktop secondary tabs/body/resize chrome.
- `MobileSecondaryPaneHost` renders mobile sheet tabs/body/close behavior.

The shared helper may answer "which active surface is published?" It must not
answer "should this component mount?"

## Capability Contract

### Secondary Publication

Type:

```ts
export interface PaneSecondarySurfacePublication {
  readonly id: WorkspaceSecondarySurfaceId;
  readonly body: ReactNode;
}

export interface PaneSecondaryPublication {
  readonly groupId: WorkspaceSecondaryGroupId;
  readonly surfaces: readonly PaneSecondarySurfacePublication[];
  readonly defaultSurfaceId: WorkspaceSecondarySurfaceId;
}
```

Contract:

- `surfaces` is non-empty.
- Every surface id belongs to `groupId`.
- Surface ids are unique within the publication.
- `defaultSurfaceId` is one of the published surface ids.
- Surface order is meaningful and is the rendered tab order.
- Surface body identity is meaningful. If a producer creates a new React node,
  that is a new publication value.
- The returned normalized publication has a fresh surface array and shallow
  surface objects so the host's stored record cannot be mutated through the
  caller's array reference.

### Fixed Chrome Publication

Type:

```ts
export type PaneFixedChromePublicationId = "reader-document-map-overview-rail";

export interface PaneFixedChromePublication {
  readonly id: PaneFixedChromePublicationId;
  readonly widthPx: number;
  readonly body: ReactNode;
}
```

Contract:

- `widthPx` must be finite and non-negative.
- Normalization canonicalizes `widthPx` with `Math.ceil`.
- `body` identity is meaningful.
- Fixed chrome is a desktop presentation capability. Publication values do not
  encode desktop/mobile mode.

## API Design

The final public API of `panePublications.ts` should be small and semantic:

```ts
export interface PaneSecondarySurfacePublication { ... }
export interface PaneSecondaryPublication { ... }
export type PaneFixedChromePublicationId = "reader-document-map-overview-rail";
export interface PaneFixedChromePublication { ... }

export function normalizePaneSecondaryPublication(
  publication: PaneSecondaryPublication,
): PaneSecondaryPublication;

export function arePaneSecondaryPublicationsEqual(
  left: PaneSecondaryPublication | null,
  right: PaneSecondaryPublication | null,
): boolean;

export function secondaryPublicationIncludesSurface(
  publication: PaneSecondaryPublication | null,
  surfaceId: WorkspaceSecondarySurfaceId,
): boolean;

export function getPublishedSecondarySurface(
  publication: PaneSecondaryPublication | null,
  surfaceId: WorkspaceSecondarySurfaceId | null | undefined,
): PaneSecondarySurfacePublication | null;

export function normalizePaneFixedChromePublication(
  publication: PaneFixedChromePublication,
): PaneFixedChromePublication;

export function arePaneFixedChromePublicationsEqual(
  left: PaneFixedChromePublication | null,
  right: PaneFixedChromePublication | null,
): boolean;
```

No options object, no comparator injection, no flags, no "loose" mode, no
fallback helper for raw fixed width equality.

### Fixed Width Equality Decision

Canonical decision: fixed-chrome equality compares canonical widths, not raw
input widths.

That means these two publication inputs are equal if id and body are equal:

```ts
{ id: "reader-document-map-overview-rail", widthPx: 28.1, body }
{ id: "reader-document-map-overview-rail", widthPx: 29, body }
```

Reason: the host stores and sizes from the canonical value. Equality that answers
differently before and after host normalization preserves the current duplicate
semantic drift.

The hook may call the equality helper on raw inputs; the helper itself should
normalize the width comparison internally without mutating either input.

### Secondary Equality Decision

Secondary equality is structural over the publication contract:

- `null` equals `null`;
- reference-equal values equal immediately;
- `groupId` must match;
- `defaultSurfaceId` must match;
- `surfaces.length` must match;
- each surface at the same index must have the same `id`;
- each surface at the same index must have the same `body` identity.

Surface order is not normalized. Reordering tabs is a real publication change.

## Composition With Other Systems

### Workspace Store

No persisted workspace schema changes. Publication records remain ephemeral
runtime state in `WorkspaceHost`.

The workspace store owns primary panes, attached secondary pane state, active
surface ids, visibility, and widths. It does not store React publication bodies.

### Pane Runtime

`PaneRuntimeProvider` remains the route-scoped command surface for route bodies.
It does not learn publication normalization. Publication hooks continue to use
contexts installed by `PaneRuntimeFrame`.

### Pane Route Model

No route table or route-width changes. Route definitions still own static route
capabilities and allowed secondary groups. Runtime publication values describe
what the currently mounted body actually offers.

### Secondary Surface Model

`paneSecondaryModel` remains the source of truth for group ids, surface ids,
metadata, icons, and width policy. `panePublications` consumes it for validation;
it does not duplicate the surface catalog.

### Reader And Media

`MediaPaneBody` continues publishing:

- a `reader-tools` secondary publication containing available Document Map
  surfaces;
- a fixed overview rail when desktop document-map rail conditions are met.

This cutover does not change reader feature availability. It only makes the
published value contract single-owned.

### Chat

`Conversation` continues publishing the `conversation-context` secondary
publication. Chat surface scroll behavior, branch/fork behavior, and context-ref
logic are untouched.

### Library, Notes, Pages

Library detail, page, and note pane bodies continue publishing their existing
secondary descriptors. The cutover only changes where the publication types and
semantics live.

### Mobile Workspace

Mobile secondary content still reaches the user only through
`MobileSecondaryPaneHost`. Fixed primary chrome remains desktop-only by
workspace composition rule.

The publication module must not special-case mobile.

## Duplicate Consolidation Inventory

Consolidate in this cutover:

- `PaneSecondary.tsx` private secondary equality.
- `PaneFixedChrome.tsx` private fixed-chrome equality.
- `WorkspaceHost.tsx` private secondary normalization.
- `WorkspaceHost.tsx` private secondary equality.
- `WorkspaceHost.tsx` private fixed-chrome normalization.
- `WorkspaceHost.tsx` inline fixed-chrome equality.
- `WorkspaceHost.tsx` private secondary membership helper.
- Active-surface lookup in `PaneShell`, `SecondaryPaneShell`, and
  `MobileSecondaryPaneHost`.
- Publication type imports in `SecondarySurfaceTabs`, `WorkspaceHost` tests, media
  tests, and any producer/test files currently importing those types from
  component wrapper modules.

Do not consolidate in this cutover:

- `PaneShell` chrome override equality. It is local chrome override state, not
  pane publication state.
- `ActionMenuOption` equality. It is a separate component-level value contract.
- `normalizePaneRuntimeLayout`. It belongs to pane sizing and layout.
- `resolveEffectivePaneSizing` or secondary width policy. They belong to sizing
  modules.
- producer-side `useMemo` calls in route bodies. Stable producer identity is
  still required.

## Files

### New Files

- `apps/web/src/lib/panes/panePublications.ts`
- `apps/web/src/lib/panes/panePublications.test.ts`

### Edited Files

- `apps/web/src/components/workspace/PaneSecondary.tsx`
- `apps/web/src/components/workspace/PaneFixedChrome.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/components/workspace/SecondaryPaneShell.tsx`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.tsx`
- `apps/web/src/components/workspace/SecondarySurfaceTabs.tsx`
- any producer/test files that import publication types from the old component
  modules.

### Test Files

- `apps/web/src/lib/panes/panePublications.test.ts`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`
- `apps/web/src/components/workspace/SecondaryPaneShell.test.tsx`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`, only if
  type import churn or publication host behavior changes.

## Hard-Cutover Sequence

### S1 - Publication Value Owner

Create `panePublications.ts` with types, normalization, equality, and membership
helpers. Add unit tests first or in the same slice.

Acceptance for S1:

- Secondary normalization defects on empty surfaces.
- Secondary normalization defects on duplicate surface ids.
- Secondary normalization defects on surface/group mismatch.
- Secondary normalization defects on unpublished default surface.
- Secondary normalization returns a cloned surface array.
- Secondary equality handles `null`, same reference, body identity, order, group,
  default surface, and surface id differences.
- Fixed-chrome normalization defects on `NaN`, `Infinity`, and negative width.
- Fixed-chrome normalization rounds up finite non-negative widths.
- Fixed-chrome equality compares canonical widths.

### S2 - Hook Transport Cutover

Update `PaneSecondary.tsx` and `PaneFixedChrome.tsx` to import value semantics
from `panePublications`.

Acceptance for S2:

- The hooks still suppress equivalent repeated publishes.
- The hooks still publish `null` on unmount.
- No private equality helper remains in either hook module.
- Type imports remain clear and non-circular.

### S3 - WorkspaceHost Cutover

Update `WorkspaceHost` to import normalization, equality, and membership helpers.

Acceptance for S3:

- Route-key guards remain unchanged.
- Publication records remain route-keyed by pane id.
- Stale publication pruning remains unchanged.
- Invalid non-null publication values defect through the shared normalizers.
- Existing rerender-stability behavior remains covered by
  `WorkspaceHost.test.tsx`.
- Mobile fixed chrome remains inert through host/shell composition, not through
  publication rewriting.

### S4 - Render-Side Membership Cleanup

Replace repeated active-surface lookup in render components with
`getPublishedSecondarySurface` and `secondaryPublicationIncludesSurface` where
membership rather than presentation is being answered.

Acceptance for S4:

- `PaneShell` still owns desktop secondary visibility.
- `SecondaryPaneShell` still owns desktop secondary presentation.
- `MobileSecondaryPaneHost` still owns mobile sheet presentation.
- Shared helpers only answer publication membership or active surface lookup.
- `rg "publication\\.surfaces\\.(find|some)" apps/web/src/components/workspace`
  has no remaining publication membership checks outside `SecondarySurfaceTabs`
  tab rendering or tests that intentionally inspect tab input.

### S5 - Import Cutover And Negative Cleanup

Move publication type imports to the canonical owner.

Acceptance for S5:

- No private publication helper remains outside `panePublications.ts`.
- No duplicate exported publication type definition remains in component files.
- `PaneSecondary.tsx` and `PaneFixedChrome.tsx` do not re-export publication
  types.
- No barrel file is introduced.
- `rg` confirms the only definitions of publication normalization/equality live
  in `panePublications.ts`.

### S6 - Verification

Run targeted verification from the smallest layer outward.

Commands:

```bash
cd apps/web && bun run test:unit -- src/lib/panes/panePublications.test.ts
cd apps/web && bun run test:browser -- src/components/workspace/WorkspaceHost.test.tsx
cd apps/web && bun run typecheck
cd apps/web && bun run lint
```

If render-side membership cleanup touches `SecondaryPaneShell` or
`MobileSecondaryPaneHost`, also run:

```bash
cd apps/web && bun run test:browser -- src/components/workspace/SecondaryPaneShell.test.tsx src/components/workspace/MobileSecondaryPaneHost.test.tsx
```

If media publication imports or reader publication behavior changes, also run:

```bash
cd apps/web && bun run test:browser -- 'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx'
```

## Acceptance Criteria

- `apps/web/src/lib/panes/panePublications.ts` is the only owner of publication
  value types, normalization, equality, and secondary publication membership.
- `PaneSecondary.tsx` and `PaneFixedChrome.tsx` are context/hook transport
  modules only.
- `WorkspaceHost.tsx` still owns route-key staleness, publication record storage,
  pruning, pending secondary requests, and mobile/desktop composition.
- Invalid publication values fail loudly and deterministically.
- Fixed-chrome equality uses canonical rounded widths.
- Secondary equality treats ordered surfaces and body identity as meaningful.
- Mobile fixed chrome remains absent.
- Desktop secondary and fixed chrome behavior remains unchanged except for
  removal of duplicate helper definitions.
- All existing publication producer sites compile against the final type owner.
- Unit tests cover pure publication semantics.
- Existing component tests continue covering host/render behavior.
- No compatibility wrappers, alternate helpers, feature flags, or fallback paths
  are added.

## Non-Goals

- No workspace schema migration.
- No persisted workspace-session change.
- No pane route table change.
- No route-width or pane sizing policy change.
- No change to reader Document Map feature behavior.
- No change to chat, library, notes, or pages domain behavior.
- No new mobile secondary presentation owner.
- No new generic equality utility.
- No conversion of React nodes into serializable shapes.
- No attempt to make unstable producer-side React node creation "equal".
- No E2E-only validation for pure value semantics.

## Risks And Guardrails

### Risk: Circular Imports

Publication types currently live in component modules consumed by other
workspace components. Moving them to `lib/panes` must not make the pure module
import component files.

Guardrail: `panePublications.ts` imports only types and pure helpers.

### Risk: Raw Versus Canonical Fixed Width Drift

If hook equality keeps raw width comparison while host equality uses rounded
width comparison, the cutover preserves the defect.

Guardrail: one fixed-chrome equality helper compares canonical widths.

### Risk: Over-Generalization

The codebase has other equality helpers. Pulling them into the same module would
make the new owner hollow and broad.

Guardrail: consolidate only pane publication values.

### Risk: Moving Composition Policy Downward

A helper named too broadly could start deciding whether mobile or desktop chrome
mounts.

Guardrail: publication helpers answer only value questions. `WorkspaceHost`,
`PaneShell`, `SecondaryPaneShell`, and `MobileSecondaryPaneHost` keep composition
and presentation decisions.

### Risk: Tests Retest Component Behavior At The Unit Layer

Pure tests should not render React components or mock contexts.

Guardrail: `panePublications.test.ts` tests value semantics only. Component
tests remain in browser-mode files.

## Final State Summary

The final system has one pane publication value contract:

- route bodies publish publication values;
- hooks transport them;
- shared pure helpers define equality and canonical form;
- `WorkspaceHost` stores canonical route-keyed records;
- pane shells render according to workspace mode and presentation ownership.

There are no duplicate publication equality helpers, no split fixed-width
semantics, and no component-local revalidation of the same publication contract.
