# Reader highlights sidecar — focus ≠ navigation · hard cutover spec

Status: **Approved direction, ready to implement.** Hard cutover. No legacy paths, no
fallbacks, no compatibility shims. One reveal helper, one emphasis channel.

This spec supersedes one assertion in
[`reader-highlight-sidecar-exact-only.md`](./reader-highlight-sidecar-exact-only.md)
§339/§355 ("card remains clickable; click jumps to the highlight in the reader"). That
claim is wrong for a viewport-scoped surface; see §1 and §12.1. The exact-only changes
themselves (compact snippet, empty placeholder) are orthogonal and stand.

**Deferred:** the delete UX (replacing the blocking `window.confirm` with a non-blocking
deferred-delete + Undo toast) is intentionally **out of scope** for this PR — it needs a
proper backend decision (soft-delete/restore vs client-deferred commit) and is tracked as
future work (§3, §16). Current delete behaviour is unchanged.

---

## 1. Context & problem

The reader has **two** highlight surfaces with deliberately different jobs
(`docs/modules/reader-implementation.md`):

- **Overview ruler** (`ReaderOverviewRuler`, ~28px far-right minimap) — the *whole-document
  map*. Its ticks can point anywhere, including far off-screen, so a tick click that
  **navigates** (scrolls) is correct. It does so via `dispatchReaderPulse`
  (`MediaPaneBody.onActivateHighlight`, 4385-4471 → cross-fragment-aware pulse →
  `HtmlRenderer` smooth-center scroll + 1200ms `.pulsing`).
- **Highlights secondary** (`ReaderHighlightsSurface`, the sidecar) — the *visible-only,
  here-with-notes* instrument. On desktop `useAnchoredHighlightProjection` filters it to
  highlights **currently in the reader viewport**, and `alignRows`
  (`ReaderHighlightsSurface.tsx:153-220`) pins each card on a "scanline" beside its source
  text in the margin. On mobile it is a full flow list of all highlights.

**The bug.** Clicking a card in the desktop sidecar fires **two instant, conflicting
scrolls** on a target that, by construction, is already on screen:

1. `focusAndScrollToHighlight` (`ReaderHighlightsSurface.tsx:380-399`) — calls
   `onFocusHighlight(id)`, then **instantly top-aligns** the anchor:
   `scrollParent.scrollTop = scrollParent.scrollTop + delta` (line 396, no `behavior`).
2. The focus change updates `focusState.focusedId`, which trips the effect at
   `MediaPaneBody.tsx:3368-3410` → on the next rAF, `anchor.scrollIntoView({ behavior:
   "auto", block: "center", inline: "nearest" })` — **instantly re-centers** it.

Net: the page lurches to top-align, then snaps to center one frame later — two instant
jumps for a card whose source mark never left the viewport. That two-step lurch is the
"jarring" motion. (The `secondaryFocusScrollAppliedRef` dedup key at 3386 is a prior
symptom-patch on the same effect.) The center effect is gated desktop+text-only
(3371-3372), i.e. precisely where the scanline makes scrolling most pointless.

**Root cause.** `focusHighlight` conflates two verbs. Focusing a highlight (select the
card, expand it, emphasize its mark) is forced to also move the document. Every mature
margin-annotation UI (Hypothesis sidebar, Google Docs comments, Medium margin notes,
Readwise Reader) holds the inverse rule: **selecting an annotation anchored to visible
text must not move the document.** Navigation is a separate verb that belongs to the map,
the URL deep-link, or an explicit jump — never to focus.

Two further defects in the same neighborhood are folded in:

- **One-directional hover.** Card→prose emphasis exists (`handleRowMouseEnter/Leave`,
  408-435, imperative `classList` writes of `hl-hover-outline`). The reverse
  (prose mark hover → emphasize its card) does not. The two halves of the card↔mark
  connection are asymmetric, and prose emphasis has two owners.
- **Scroll inconsistency.** The sidecar's raw `scrollTop =` assignment is the only
  reader scroll that isn't smooth + `prefers-reduced-motion`-aware (cf. `useChatScroll`,
  `usePaneCanvas.ts:202-210`).

A third wart — the blocking `window.confirm` on delete
(`ReaderHighlightsSurface.tsx:507-529`) — is acknowledged but **deferred** (§3, §16).

---

## 2. Goals

1. **Focus never scrolls.** Focusing a highlight (card click, prose-mark click, post-create
   focus, reconcile) selects/expands the card and emphasizes the mark — and moves nothing.
2. **Navigation scrolls, deliberately.** Ruler ticks, URL deep-links, and the mobile
   above/below jumps keep scrolling; their targets are genuinely off-screen.
3. **Sidecar card click = focus + reveal-if-needed.** A single conditional helper that
   no-ops when the anchor is already fully in view (the desktop common case) and gently
   reveals it (`nearest`, smooth, reduced-motion-aware) when it is clipped or off-screen
   (mobile). One rule, both platforms.
4. **Hover is bidirectional and centralized** through one `hoveredHighlightId` channel that
   drives both prose and card emphasis, replacing the bespoke imperative DOM writes.
5. **Consolidate** the scattered focus-scroll machinery into one reveal helper and one
   emphasis applier; delete dead/duplicated scroll code.

---

## 3. Non-goals

- **Delete UX is unchanged this PR.** The blocking `window.confirm`
  (`ReaderHighlightsSurface.tsx:507-529`) stays exactly as-is. Replacing it with a
  non-blocking deferred-delete + Undo toast is **deferred to a future PR** so it can be
  tackled fully alongside the backend decision (soft-delete/restore vs client-deferred
  commit — recreation is unsound because `createHighlight` mints a new id and drops
  notes/linked-chats). See §16.
- **Not** changing ruler navigation, the reader pulse, cross-fragment routing, or URL
  deep-link scroll (`MediaPaneBody` 2533/2584, `onActivateHighlight` 4385-4471). Those are
  the navigation layer and remain the *correct* place to scroll.
- **Not** changing the projection/alignment engine (`useAnchoredHighlightProjection`,
  `alignRows`), the scanline layout, `+N more`, or PDF quad projection.
- **Not** changing notes, linked-chats, color picker, quote-to-chat, edit-bounds, or delete
  flows.
- **Not** adding sidecar-internal scroll-to-focused-card (scrolling the sidecar list itself
  to reveal a card focused from the prose). Out of scope.
- **Not** keyboard list navigation (j/k/arrows) between cards. Separate effort.

---

## 4. Target behaviour (UX)

### 4.1 Desktop sidecar (visible-only, scanline)

- **Click a card** → the card becomes `selected` + `expanded`; its source mark in the prose
  gets the focus ring (`.hl-focused`). **The document does not move** (anchor is already in
  view → reveal-if-needed no-ops).
- **Hover a card** → its source mark(s) get the hover outline (`.hl-hover-outline`).
- **Hover a mark in the prose** → its card in the sidecar gets a hover emphasis
  (`.hovered`). (New — the reverse direction.)
- **Click a mark in the prose** → its card becomes `selected`+`expanded`. Document does not
  move (you clicked something already in view).

### 4.2 Mobile sidecar (full flow list)

- **Tap a card** → focus + reveal-if-needed; because the list is decoupled from the reader,
  the target is usually off-screen, so the reader gently scrolls it into view (`nearest`,
  smooth).
- **Tap "N above" / "N below"** → explicit jump: focus + reveal to a top-aligned reading
  position (`align: "start"`), smooth.

### 4.3 Motion

- Any reveal/navigation scroll is `smooth`, degrading to instant under
  `prefers-reduced-motion` (reuse the `usePaneCanvas` matchMedia pattern). No raw instant
  `scrollTop =` jumps remain in the sidecar path.

---

## 5. Architecture & final state

Two orthogonal channels, each with **one owner** (`MediaPaneBody`, which already owns
`focusState`, `contentRef`, and the highlights list):

### 5.1 Emphasis channel (focus + hover) — no scrolling, ever

```
                         MediaPaneBody (owner)
   focusState.focusedId ─┐                 ┌─ hoveredHighlightId  (NEW state)
                         │                 │
   ┌─────────────────────┴───┐     ┌───────┴────────────────────┐
   │ prose applier (effect)   │     │ prose applier (effect)     │
   │ applyFocusClass(root,     │     │ applyFocusClass(root,      │  ← REUSED, class-param
   │   focusedId,"hl-focused") │     │   hoveredId,"hl-hover-     │
   │ (exists, 2499-2500)       │     │   outline")  (NEW effect)  │
   └─────────────┬─────────────┘     └─────────────┬──────────────┘
                 │                                 │
        prose mark gets .hl-focused        prose mark gets .hl-hover-outline
                 │                                 │
   ┌─────────────┴─────────────┐     ┌─────────────┴──────────────┐
   │ card: selected + expanded │     │ card: .hovered  (NEW)      │
   │ (via focusedId → RHS prop)│     │ (via hoveredId → RHS prop) │
   └───────────────────────────┘     └────────────────────────────┘

   Focus sources: card click, prose-mark click (handleHighlightClick), post-create,
                  reconcile, URL deep-link.
   Hover sources: card onMouseEnter/Leave  AND  prose pointerover/out delegation (NEW).
```

`applyFocusClass(container, id, className)` (`useHighlightInteraction.ts:306-322`) is
**already parameterized by class name** — so the hover prose-applier reuses it verbatim
with `"hl-hover-outline"`. The imperative `handleRowMouseEnter/Leave` DOM writes in
`ReaderHighlightsSurface` (408-435) are **deleted**; the sidecar reports hover via a
callback instead of reaching into reader DOM. Prose emphasis now has a single owner.

### 5.2 Reveal channel (navigation) — the only thing that scrolls

```
   revealHighlightInReader(contentRef, id, { align, onlyIfNeeded })   ← ONE helper (RHS-owned)
        ├─ desktop card click  → align:"nearest", onlyIfNeeded:true   → no-op when in view
        ├─ mobile card tap     → align:"nearest", onlyIfNeeded:true   → gentle reveal
        └─ mobile above/below  → align:"start",   onlyIfNeeded:false  → explicit jump

   Cross-fragment / cross-document navigation stays in the navigation layer:
        ruler tick → dispatchReaderPulse (unchanged)
        URL ?highlight=/?evidence= → MediaPaneBody 2533/2584 (unchanged)
```

`focusAndScrollToHighlight` (RHS 380-399) is split: `onFocusHighlight(id)` (focus, no
scroll) and `revealHighlightInReader(...)` (conditional reveal). The
`MediaPaneBody` focus-center effect (3368-3410) and its `secondaryFocusScrollAppliedRef`
are **deleted** — focus no longer scrolls from anywhere.

---

## 6. Capability contract & API design

### 6.1 `lib/highlights/useHighlightInteraction.ts` — focus is scroll-free by contract

No signature change. `focusHighlight(id)` already only sets `focusState` and calls
`onFocusChange` (127-137); it must **never** acquire scroll behavior. This is now an
explicit invariant of the hook: *focus changes emphasis, not viewport.* Add
`hoveredHighlightId` as sibling state managed by the same hook **or** as local
`MediaPaneBody` state (see §12.3); whichever, the hook's focus contract is unchanged.

### 6.2 `ReaderHighlightsSurface` — split focus from reveal; report hover via callback

New/changed props:

```ts
interface ReaderHighlightsSurfaceProps {
  // ...existing...
  hoveredId: string | null;                          // NEW: which card to emphasize
  onHoverHighlight: (id: string | null) => void;     // NEW: replaces imperative DOM hover
  // onFocusHighlight stays: focus only, never scrolls
  // onDelete + handleDelete (window.confirm) UNCHANGED this PR
}
```

Internal:

```ts
// REPLACES focusAndScrollToHighlight (380-399)
function revealHighlightInReader(
  highlightId: string,
  opts: { align: "nearest" | "start"; onlyIfNeeded: boolean },
): void;
// - resolves anchor via existing [data-active-highlight-ids~=] / [data-highlight-anchor]
// - findScrollParent + scroll-padding-top (existing geometry)
// - onlyIfNeeded && fully-in-viewport  → return (NO-OP)
// - else scrollParent.scrollTo({ top, behavior })  // behavior from prefers-reduced-motion

// card click handler:
handleRowActivate(id) {
  onFocusHighlight(id);                                   // focus (no scroll)
  revealHighlightInReader(id, { align: "nearest", onlyIfNeeded: true });
}
// mobile above/below:
revealHighlightInReader(targetId, { align: "start", onlyIfNeeded: false });

// hover: ItemCard onMouseEnter/Leave → onHoverHighlight(id) / onHoverHighlight(null)
// (handleRowMouseEnter/Leave + their contentRef DOM writes are DELETED)
```

`handleDelete` (and its `window.confirm`, `deleting` spinner, `onDelete` call) is **left
untouched** — deferred per §3/§16.

### 6.3 `components/items/ItemCard` — add hover emphasis

```ts
interface ItemCardProps {
  // ...existing...
  hovered?: boolean;   // NEW → adds styles.hovered
}
```

`ItemCard.module.css`: add `.hovered` (lighter than `.selected`: e.g.
`border-color: var(--edge-strong)` or `background: var(--surface-2)`, no accent ring — the
accent ring stays reserved for `.selected`/focus). Existing `.card:hover` (11),
`.selected` (15), `.expanded` clamp (54) unchanged.

### 6.4 `MediaPaneBody` — owns hover state, prose appliers, reveal wiring

- **Delete** `useEffect` 3368-3410 + `secondaryFocusScrollAppliedRef` entirely.
- **Add** `hoveredHighlightId` state + setter.
- **Add** a prose hover applier effect mirroring the focus applier (2499-2500):
  `applyFocusClass(contentRef.current, hoveredHighlightId, "hl-hover-outline")`.
- **Extend** the reader-content pointer delegation next to `handleReaderContentClick`
  (2880-2901): add `onPointerOver`/`onPointerOut` (or `onMouseOver`/`onMouseOut`) that
  resolve `findHighlightElement(e.target)` → `parseHighlightElement` and set
  `hoveredHighlightId` to the topmost id (or `null`), guarding against redundant sets.
- **Pass** `hoveredId={hoveredHighlightId}` and `onHoverHighlight={setHoveredHighlightId}`
  to `ReaderHighlightsSurface`.
- **Delete path** (`handleDelete` ~3009 → `applyHighlightMutation(deleteHighlight)`):
  **unchanged**.

---

## 7. How it composes with other systems

- **Overview ruler.** Untouched. Ruler activation routes through `dispatchReaderPulse`,
  which performs its own cross-fragment scroll + pulse and does **not** depend on the
  deleted focus-center effect (verified: `onActivateHighlight` 4385-4471 never reads it).
  Ruler remains the navigator; sidecar becomes pure focus. The two verbs are now cleanly
  split across the two surfaces — exactly the map/instrument division the design intends.
- **URL deep-links** (`?highlight=`, `?evidence=`). Untouched; they scroll explicitly at
  2533/2584 *before* focusing. Deleting the focus-center effect removes a redundant second
  scroll on this path (a strict improvement).
- **Highlight create / reconcile** (`focusHighlight` at 2760/2780/2813/2945). These focus a
  just-created or refetched highlight. Today the focus-center effect yanks the page to
  center it; after this cutover they focus without moving — correct, since the selection is
  already on screen.
- **Prose emphasis ownership.** Both focus and hover prose classes are now applied by
  `MediaPaneBody` effects via the one `applyFocusClass` helper. The sidecar stops mutating
  reader DOM. One owner per concern (`docs/rules/cleanliness.md`).
- **Projection/alignment engine.** Unaffected; geometry and `alignRows`/`+N more`/mobile
  behave as before.

---

## 8. Reuse / consolidation decisions (resolved)

1. **Hover via `applyFocusClass`, not a new applier.** The helper already takes a class
   argument; hover = `applyFocusClass(root, hoveredId, "hl-hover-outline")`. Deletes the
   imperative `handleRowMouseEnter/Leave` DOM-write duplication in RHS (408-435). One
   mechanism applies both emphasis classes.
2. **One reveal helper, parameterized**, replacing: RHS `focusAndScrollToHighlight`
   top-align, the `MediaPaneBody` focus-center effect, and the mobile above/below scroll.
   `{ align, onlyIfNeeded }` collapses three scroll behaviors into one code path
   (`docs/rules/simplicity.md`: fewer paths).
3. **Reduced-motion behavior derivation** reuses the `usePaneCanvas.ts:202-210` matchMedia
   pattern rather than re-implementing.
4. **`hoveredHighlightId` mirrors `focusedId`** in ownership, applier shape, and prop
   threading — symmetric with the established focus channel rather than a novel pattern.

---

## 9. Scope

**In:** `ReaderHighlightsSurface` (split focus/reveal, hover via callback), `ItemCard`
(+`hovered`), `ItemCard.module.css` (+`.hovered`), `MediaPaneBody` (delete focus-center
effect; add hover state + prose hover applier + pointer-out/over delegation), and a
one-line invariant comment in `useHighlightInteraction.ts`. Amend the exact-only doc's
§339/§355. Tests for all of it.

**Out:** everything in §3 — most notably the delete UX (deferred to a future PR, §16).

---

## 10. Files

| File | Change |
|---|---|
| `apps/web/src/components/reader/ReaderHighlightsSurface.tsx` | Split `focusAndScrollToHighlight` → `onFocusHighlight` + `revealHighlightInReader({align,onlyIfNeeded})`; delete `handleRowMouseEnter/Leave`; add `hoveredId`/`onHoverHighlight` props; mobile above/below use `align:"start"`. **`handleDelete`/`window.confirm` untouched.** |
| `apps/web/src/components/items/ItemCard.tsx` | Add `hovered?: boolean` → `styles.hovered`. |
| `apps/web/src/components/items/ItemCard.module.css` | Add `.hovered` (lighter than `.selected`, no accent ring). |
| `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` | Delete focus-center `useEffect` (3368-3410) + `secondaryFocusScrollAppliedRef`; add `hoveredHighlightId` state; add prose hover applier effect; extend reader-content delegation with pointerover/out; pass `hoveredId`/`onHoverHighlight` to RHS. **Delete path unchanged.** |
| `apps/web/src/lib/highlights/useHighlightInteraction.ts` | Document the focus-never-scrolls invariant (1 comment); optionally host `hoveredHighlightId` (§12.3). |
| `apps/web/src/components/reader/ReaderHighlightsSurface.test.tsx` | Update click test: focus without scroll; add hover-callback test. **Existing delete (confirm) test stays green.** |
| `docs/cutovers/reader-highlight-sidecar-exact-only.md` | Amend §339/§355 to point here. |

No new files. No deleted files.

---

## 11. Key details

- **"Fully in view" test** for `onlyIfNeeded`: compare the anchor's `getBoundingClientRect`
  against the scroll parent's client rect inflated by `-scrollPaddingTop` at the top; only
  scroll if the anchor's top is above the padded top edge or its bottom is below the bottom
  edge. Reuse existing `findScrollParent` + `scrollPaddingTop` parsing (RHS 388-391).
- **`align:"nearest"`** scrolls the minimal delta to bring the nearest clipped edge in (plus
  the `scrollPaddingTop` margin). **`align:"start"`** is the old top-align delta. Both via
  `scrollParent.scrollTo({ top, behavior })`.
- **Hover guard.** `pointerover` bubbles; resolve `findHighlightElement(closest)` and only
  `setHoveredHighlightId` when the resolved id differs from current, to avoid render churn
  on intra-mark moves. `pointerout` to a non-highlight → `null`.
- **`.hl-focused` vs `.hl-hover-outline`** can co-apply to the same mark (box-shadow ring +
  outline); visually fine and already true today for the focus+hover overlap.

---

## 12. Key decisions (resolved)

1. **Sidecar click does not jump.** Overrides exact-only §339/§355. A viewport-scoped
   surface whose cards are scanline-pinned to on-screen marks must not move the document on
   focus. The ruler is the jump surface. *(User-confirmed: "Scroll-if-needed".)*
2. **Hover state ownership.** Single `hoveredHighlightId` source of truth in the focus
   owner (`MediaPaneBody`/`useHighlightInteraction`), symmetric with `focusedId`. Rejected:
   leaving card→prose hover as imperative RHS DOM writes (asymmetric, duplicated, two
   owners of prose emphasis).
3. **One reveal helper, two alignments.** Rejected separate functions per call site
   (more paths) and a fully-unified single rule (mobile explicit jumps want top-align, not
   nearest). `{align,onlyIfNeeded}` is the minimal parameterization.
4. **Reduced-motion is mandatory** on every remaining sidecar scroll; reuse the matchMedia
   pattern. No raw instant `scrollTop=` survives in this path.
5. **Delete UX deferred** (not redesigned here). Keeping the current `window.confirm` is a
   deliberate hold, not an oversight — see §16.

---

## 13. Acceptance criteria

1. **Desktop card click does not scroll the reader.** With the focused highlight already in
   view, clicking its card changes no scroll position; the card gains `selected`+`expanded`
   and the mark gains `.hl-focused`. The two-step lurch is gone.
2. **No focus-center effect remains.** `MediaPaneBody` 3368-3410 and
   `secondaryFocusScrollAppliedRef` are deleted; grep finds no focus-driven `scrollIntoView`.
3. **Reveal-if-needed works on mobile.** Tapping a card whose mark is off-screen scrolls it
   into view smoothly (`nearest`); above/below jumps top-align (`start`); both honor
   reduced-motion.
4. **Bidirectional hover.** Hovering a card outlines its mark(s); hovering a mark emphasizes
   its card (`.hovered`). The imperative `handleRowMouseEnter/Leave` DOM writes are gone;
   prose emphasis is applied solely by `MediaPaneBody` via `applyFocusClass`.
5. **Delete behaviour unchanged.** Delete still confirms via `window.confirm` and removes
   the highlight; no regression.
6. **Ruler / URL deep-link / create / reconcile** behave as before (ruler still jumps+pulses;
   deep-link still centers once; create/reconcile focus without moving the page).
7. **Tests pass:** typecheck, lint, `ReaderHighlightsSurface.test.tsx` (focus-no-scroll,
   hover-callback, existing delete test green), `useHighlightInteraction.test.ts`
   unchanged-green.

---

## 14. Test plan

- **`ReaderHighlightsSurface.test.tsx`** — replace "focuses the source highlight when row is
  clicked" to assert `onFocusHighlight` fires **and** no scroll mutation occurs on an
  in-view anchor; add a test that card hover calls `onHoverHighlight(id)`/`(null)`. The
  existing `window.confirm` delete test stays unchanged and green.
- **`MediaPaneBody`** — unit/integration: focus change applies `.hl-focused` and does not
  scroll; hover state applies `.hl-hover-outline` to the right mark and `.hovered` to the
  right card.
- **E2E** (largest layer per `docs/rules/testing_standards.md`): desktop reader, scroll so a
  highlight sits mid-viewport, click its card → assert `scrollTop` unchanged; hover a mark →
  card emphasized.

---

## 15. Rules adherence

- `docs/rules/simplicity.md` — one reveal helper, one emphasis applier, fewer code paths;
  no speculative props beyond `hovered`/`hoveredId`/`onHoverHighlight`.
- `docs/rules/cleanliness.md` — deletes the focus-center effect, the dedup ref, and the
  imperative hover writes; gives prose emphasis a single owner.
- Hard cutover: exactly one sidecar-scroll path remains; no legacy scroll branch, no
  compatibility flag. (Delete is explicitly held unchanged, not branched — §16.)

---

## 16. Deferred — delete UX (future PR)

The blocking `window.confirm` on delete is a known wart but is **out of scope here**.
Doing it right requires a backend decision, because a clean Undo cannot be built on the
current API:

- `deleteHighlight` (`lib/highlights/api.ts:159`) is a hard server delete.
- `createHighlight` (`lib/highlights/api.ts:102`) mints a **new id** and cannot restore the
  original's notes or linked conversations — so "recreate on undo" silently loses data and
  churns ids.

Two sound options for the future PR, to be chosen then:

1. **Client-deferred commit** — optimistic `pendingDeleteIds` overlay filtering the
   `highlights` list; the server `DELETE` fires only when the Undo window elapses (or on
   flush at unmount/fragment-change). No backend change, no data loss, stable id.
2. **Backend soft-delete + restore endpoint** — restores the exact record (id, notes,
   links) on undo; cleaner but needs API work in the backend service.

When picked up, that PR replaces `handleDelete`'s `window.confirm` with the non-blocking
delete + `useFeedback().show({ action: { label: "Undo" } })` toast, and adds the
corresponding deferred-commit/flush tests.
</content>
