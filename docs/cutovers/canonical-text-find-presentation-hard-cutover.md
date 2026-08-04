# Canonical Text Find Presentation Hard Cutover

Status: PROPOSED
Type: hard cutover
Date: 2026-08-03

Open questions: none. Browser/version is diagnostic only; it does not change the
contract.

Landing note (implemented against the current deployed main): the earlier
`verification-infrastructure` cutover removed the adapter browser tests and the
repo-root `e2e/tests/` Find journeys and moved e2e under
`apps/web/e2e/journeys/*.journey.spec.ts`. This landing therefore proves the marks
at the real CSS Custom Highlight boundary in `paneFindHighlightRegistry.browser.test.tsx`
and `canonicalTextFindPresentation.browser.test.tsx` (live ranges, fragment filter,
active selection, priority, exact/connected/in-viewport invariants, stale-node
rejection, rebind-to-replaced-DOM, computed styling, forced colors, multi-owner
isolation), keeps `canonicalWebPaneFind.unit.test.ts` corpus parity (repointed to
the presentation owner), and relies on the route seam for the exhaustive Web/EPUB
rebind. No `.test.tsx` project-glob mismatch, `vi.spyOn`, or resurrected
deleted-on-main test file remains.

Governing contracts:

- [`docs/rules/README.md`](../rules/README.md) and every rule it indexes;
- [`docs/local-rules/testing-standards.md`](../local-rules/testing-standards.md);
- [`pane-search-foundation-hard-cutover.md`](pane-search-foundation-hard-cutover.md);
- [`canonical-text-surfaces-find-hard-cutover.md`](canonical-text-surfaces-find-hard-cutover.md);
- [`epub-find-hard-cutover.md`](epub-find-hard-cutover.md);
- [`docs/modules/reader-implementation.md`](../modules/reader-implementation.md).

## Decision

Make Find marks on canonical HTML surfaces visible and render-lifecycle safe.
Web articles and EPUBs use one shared presentation owner and one route-owned
post-commit rebind seam. Matching, pane-find state, preview movement, Return,
and reader-progress fences remain unchanged.

This is the 80/20 cut: exact visible marks that survive current HTML rebuilds,
without a new document engine, renderer protocol, backend API, or search model.

## Problem

- Web and EPUB targets are found and positioned, but their marks can be
  invisible. PDF marks are visible and use a different PDF.js-owned path.
- Custom-highlight styles use `background` shorthand although `::highlight()`
  supports `background-color`; behavior is not portable across browser engines.
- Web and EPUB duplicate the dangerous occurrence-to-DOM-range projection.
- EPUB does not rebuild Find ranges after persisted highlights rebuild
  `renderedHtml`; replaced DOM invalidates previously registered ranges.
- Current proofs observe result state or registry membership, not visible paint
  on live current DOM.

## Goals

- Visible passive and active marks for Web and EPUB Find.
- Exact marks rebound after every committed canonical-DOM replacement.
- One owner each for canonical range projection and document-global registry
  aggregation; no format duplicates either capability.
- Preserve exact preview, Return, multi-pane isolation, and search-neutral reader
  state.
- Demonstrate the defect proof red before implementation and green after it.

## Scope

In:

- Web-article and EPUB `FindOccurrences` presentation;
- shared canonical-text presentation extraction;
- standards-safe normal and forced-colors styles;
- route-local post-commit rebind composition;
- focused browser proofs and existing thin Find journeys.

Out:

- PDF, transcript, Chat, Artifact, global Search, and Search result activation;
- matching, scopes, snippets, result identity, Companion, or pane-shell UX;
- EPUB Find, navigation, highlight, reader-state, or progress APIs;
- fuzzy recovery, CFI, OCR, semantic Find, minimaps, analytics, or persistence;
- browser-native Find or support for browsers without CSS Custom Highlights.

## Target Behavior

| Event | Required result |
| --- | --- |
| Web/EPUB query becomes Ready | Paint every occurrence in the mounted fragment and distinguish the active occurrence without color alone |
| Previous/Next or Companion activation | Repaint and position the exact active occurrence before returning `Previewed` |
| Cross-fragment/section preview | Await current DOM, resolve current ranges, paint, then position; no old-fragment mark survives |
| `renderedHtml` changes for the same fragment | Re-resolve all visible logical occurrences against the new cursor before the next paint |
| Persisted highlight arrives/changes | Preserve Find marks; never convert Find into a persisted Highlight |
| Genuine reader movement to another rendered fragment | Paint its passive matches; paint active only when it is in that fragment |
| Close, source replacement, route exit, or unmount | Clear only that pane/session owner's ranges |
| Forced colors | Keep passive and active marks perceivable; retain a non-color active cue |
| CSS Custom Highlight capability absent | Find capability fails loudly; no native, DOM-wrapper, or approximate fallback |

## Final Architecture And Ownership

```text
usePaneFind
  -> Web or EPUB adapter owns logical occurrences + active key
     -> canonicalTextFindPresentation owns current DOM projection
        -> canonical cursor range resolution
        -> live/current-range invariants
        -> paneFindHighlightRegistry
           -> document-global CSS Highlight aggregation
           -> passive/active priority + owner-scoped clear

committed renderedHtml / fragment
  -> MediaPaneBody ordered post-commit seam
     -> current cursor/rendered-state publication
     -> selected canonical adapter.rebuildPresentation()
```

- `usePaneFind` remains the only session/query/step/stale-settlement owner. Do
  not change its contract.
- Web and EPUB adapters remain logical occurrence, active occurrence, origin,
  preview, and Return owners.
- `canonicalTextFindPresentation.ts` owns canonical occurrence-to-live-range
  projection and delegates paint publication to one private registry owner.
- `paneFindHighlightRegistry.ts` owns the document-global fixed-name CSS
  Highlight aggregate, priority, and owner-scoped clearing for every DOM Find
  surface. Conversation Find continues to consume this lower-level capability.
- `MediaPaneBody` owns DOM-commit ordering because it derives `renderedHtml`,
  builds the cursor, and selects the active format adapter.
- `page.module.css` owns Web/EPUB mark appearance.
- `HtmlRenderer` remains a sanitized HTML sink. Add no Find behavior to it.
- PDF.js remains the complete PDF matching/marking owner.

## Capability Contract

Do not widen `PaneFindAdapter`. Canonical DOM formats alone require rebind:

```ts
interface CanonicalTextFindAdapter<TError>
  extends PaneFindAdapter<TError> {
  rebuildPresentation(): void;
}

interface CanonicalTextFindPresentationTarget {
  readonly key: PaneFindResultKey;
  readonly fragmentId: string;
  readonly startCp: number;
  readonly endCp: number;
}

interface CanonicalTextFindPresentationInput {
  readonly fragmentId: string;
  readonly cursor: CanonicalCursorResult;
  readonly viewport: HTMLElement;
  readonly targets: readonly CanonicalTextFindPresentationTarget[];
  readonly activeKey: PaneFindResultKey | null;
}

interface CanonicalTextFindPresentationOwner {
  publish(input: CanonicalTextFindPresentationInput): void;
  clear(): void;
}

interface PaneFindHighlightOwner {
  publish(ranges: {
    readonly all: readonly Range[];
    readonly active: readonly Range[];
  }): void;
  clear(): void;
}
```

`publish` filters to `fragmentId`, resolves every target through
`resolveCanonicalTextRanges`, and defects when a range is absent, collapsed,
disconnected, outside `viewport`, or inconsistent with its nonempty logical
span. It publishes passive ranges and only the visible active target. It stores
no occurrence source of truth. Its private `PaneFindHighlightOwner` accepts only
already-resolved live ranges; Web and EPUB never call that lower-level owner
directly.

`rebuildPresentation` reads the adapter's existing occurrence map, active key,
and current rendered state, then calls `publish`. With no Ready occurrences it
clears. It performs no loading, matching, scrolling, state mutation, or timer.

## Intra-System Composition

1. Preview materializes the exact fragment/section through the existing path.
2. Adapter publishes current ranges and positions the exact anchor.
3. Adapter returns existing `PaneFindPreviewReceipt.Previewed` only after both
   operations succeed and all existing generation/source fences still hold.
4. Any later `renderedHtml` commit publishes the new cursor/rendered-state refs
   and invokes the selected Web/EPUB rebind in one ordered `useLayoutEffect`.
5. Clear/dispose removes the caller's owner ranges and republishes the aggregate
   so other mounted panes remain untouched.

No `MutationObserver`, retry, delay, animation frame, DOM wrapper, persisted
Highlight, route hash, or approximate text rematch may repair presentation.

## Style Rules

- Use only properties supported by `::highlight()`: `background-color`, `color`,
  `text-decoration` properties, and `text-shadow`.
- Passive: restrained yellow token fill. Active: stronger/opaque fill plus
  double underline or equivalent non-color cue.
- Set explicit registry priority: active above passive. Do not rely on
  registration order.
- Forced colors uses `Highlight`/`HighlightText` and retains the active
  decoration.
- Never suppress keyboard focus or use Find paint as its substitute.

Reference: [CSS Custom Highlight API](https://www.w3.org/TR/css-highlight-api-1/).

## API And Schema Design

No public, transport, backend, database, URL, workspace, or persisted schema
changes. The capability and presentation shapes above are frontend-internal
named types. Existing logical result keys, codepoint offsets, API DTOs, and
preview receipts remain canonical.

## Hard-Cut Rules

- Hard-rename `canonicalTextFindHighlights.ts` to
  `paneFindHighlightRegistry.ts`; rename its registry proof and all imports in
  the same change. No barrel, re-export, alias, bridge, or old-named file
  remains.
- Add `canonicalTextFindPresentation.ts` as the only canonical
  occurrence-to-range projector. It privately composes the registry owner.
- Move both duplicate `publishRenderedRanges` implementations into the shared
  owner; delete the local implementations.
- Replace the Web-only rebind selection/effect with one exhaustive canonical
  Web/EPUB selection. No dummy adapter or optional no-op callback.
- Delete unsupported `background` declarations from custom-highlight
  pseudo-elements in the touched canonical surface.
- Do not modify PDF or add a second presentation registry.

## Files

Change:

- `apps/web/src/lib/reader/canonicalTextFindHighlights.ts` ->
  `paneFindHighlightRegistry.ts`
- `apps/web/src/lib/reader/canonicalTextFindPresentation.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaPaneFind.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useEpubPaneFind.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
- `apps/web/src/components/chat/useConversationPaneFind.ts` (import rename only)
- `apps/web/src/__tests__/components/ChatSurface.test.tsx` (import rename only)
- focused proofs named below
- `docs/modules/reader-implementation.md`

Do not change:

- `apps/web/src/lib/panes/usePaneFind.ts`
- `apps/web/src/components/HtmlRenderer.tsx`
- PDF, transcript, backend, migrations, or BFF files

## Proof Plan

1. Capture sensitivity: current code must fail a proof that replaces mounted
   HTML after publication and expects the same logical EPUB target to remain
   visibly marked on current DOM.
2. Retain a focused registry proof for owner-scoped multi-pane clearing and
   priority. Add a real Chromium canonical-presentation browser proof of live
   ranges, computed highlight styling, active/passive distinction, and forced
   colors.
   Add the user's active browser engine as the only second-engine proof when it
   differs from Chromium; do not create a general browser matrix.
3. Extend `useMediaPaneFind.browser.test.tsx` and
   `useEpubPaneFind.browser.test.tsx` for post-replacement rebind, stale-source
   rejection, and persisted-highlight coexistence without mocking the
   presentation owner.
4. Extend `canonical-find-journey.spec.ts` and `epub.spec.ts` with one exact
   active-mark assertion each; retain existing URL/progress/Return assertions.
5. Run typecheck, targeted lint, focused browser proofs, both journeys,
   production build, residue search, and `git diff --check`.

## Acceptance Criteria

1. Web and EPUB passive and active Find marks are human-visible in the supported
   browser and active is distinguishable without color.
2. Marks survive same-fragment HTML replacement, delayed persisted-highlight
   loading, cross-fragment/section preview, and reader reflow.
3. Every published range is exact, noncollapsed, connected, and inside the
   current viewport; stale ranges are never retained.
4. Preview returns `Previewed` only after exact mark publication and exact
   positioning under current source/query fences.
5. Clear/source replacement/unmount removes only the caller's ranges; another
   mounted pane remains marked.
6. Persisted highlights, progress, completion, activity, URL, pane history,
   Return, matching, ordering, and PDF behavior are unchanged.
7. Normal and forced-colors behavior has focused real-browser proof.
8. The defect proof is demonstrated red before implementation and green after.
9. No legacy name/path, duplicate projector, fallback, compatibility seam,
   observer, timer, new API, or dead code remains.

## Implementation Order

1. Add the red sensitivity proof.
2. Hard-rename the shared registry and add the canonical presentation owner.
3. Adapt Web and EPUB; delete duplicate projectors.
4. Replace the route rebind seam and standards-harden styles.
5. Add browser/journey proof, update canonical docs, and run residue gates.
