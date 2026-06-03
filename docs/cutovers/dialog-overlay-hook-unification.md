# Dialog-overlay hook unification

> **Status:** Implemented 2026-06-02. Hard cutover landed — all four hooks shipped, all six sheets
> converted, `useDismissOnOutsideOrEscape` delegates Escape to `useEscapeKey`, Workstream B scrim
> tokens done. Typecheck + lint clean; full unit + browser suites green. A follow-up review pass
> (2026-06-02, §21) extended the sweep to three sites the original scope missed and fixed a
> cutover-introduced focus-trap regression.
> **Type:** Hard cutover. No legacy code, no fallbacks, no backward-compat shims, no dual paths.
> **Origin:** Deferred follow-up named in `docs/cutovers/app-navigation-unification.md:33–35`
> ("extract a shared dialog-overlay hook unifying `NavSheet` + `MobileSecondaryPaneHost`").
> **Scope correction vs. origin:** the right unit is a *focus/scroll-containment cluster* shared by the
> whole **custom modal-sheet family** (six components), not a two-component merge. Native `<dialog>`
> components and anchored popovers are explicitly out of scope and stay as they are.

---

## 1. Summary / target behaviour

Every custom modal sheet in the app hand-rolls the same accessibility cluster — body-scroll lock,
focus trap, focus-in on open, focus-restore on close, and Escape-to-dismiss — and each does it slightly
differently, with three different Escape implementations and four copies of the initial-focus effect.

Centralise that cluster into one composing hook, `useDialogOverlay`, built from three new single-concern
primitives (`useEscapeKey`, `useReturnFocus`, `useInitialFocus`) layered on the two existing primitives
(`useBodyOverflowLock`, `useFocusTrap`). Convert all six custom modal sheets to it (or, for the two
viewport-adaptive sheets, to the primitives à la carte). Outside-click dismissal is standardised on the
**backdrop `onClick`** pattern — deliberately *not* folded into the hook, because the document-pointerdown
dismiss hook is unsafe for sheets that host portaled child layers (see §9).

After the cutover there is **one owner** for the modal-sheet a11y contract, **one owner** for
Escape-to-dismiss (the popover dismiss hook composes the same primitive), and zero inline focus/escape
effects in the converted components.

---

## 2. Goals

- **G1.** A single composing hook `useDialogOverlay` encodes the modal-sheet a11y contract (§6).
- **G2.** Three new reusable single-concern primitives in `lib/ui/`: `useEscapeKey`, `useReturnFocus`,
  `useInitialFocus`. Each is independently usable by viewport-adaptive sheets whose per-concern `active`
  conditions differ.
- **G3.** Convert all six in-scope custom modal sheets (§10.1) — including fixing the three that are
  currently a11y-deficient (`PodcastSubscriptionSettingsModal`, `ModelSettingsPopover` mobile,
  `GlobalPlayerFooter` expanded sheet).
- **G4.** **Single Escape owner:** `useDismissOnOutsideOrEscape` composes `useEscapeKey` for its Escape
  branch instead of re-implementing the keydown listener (§12).
- **G5.** Delete every inline lock/trap/return-focus/initial-focus/escape effect in the converted
  components. No component keeps a private copy.
- **G6.** Standardise modal-sheet outside-dismissal on backdrop-`onClick` + panel-`stopPropagation`,
  removing the only backdrop-redundant use of the document-pointerdown dismiss hook (`NavSheet`).
- **G7. (Workstream B)** Tokenise the duplicated backdrop scrim CSS into two design tokens + a documented
  recipe, **normalising** the `Dialog` (0.6) and `queueOverlay` (0.45) opacity outliers to the default
  `--overlay-scrim` (0.5). Lands in the same PR as Workstream A (§11).

---

## 3. Non-goals

- **N1.** Do **not** touch the native `<dialog>` components (`ui/Dialog.tsx`, `palette/PaletteDesktopShell.tsx`,
  `palette/PaletteMobileShell.tsx`, and `LibraryMembershipPanel` mobile which delegates to `Dialog`). The
  browser already provides focus containment + top-layer scroll behaviour for these; wrapping them in the
  hook would duplicate or fight native behaviour. Migrating the custom sheets *onto* `<dialog>` is a
  separate, larger effort and is **not** part of this cutover.
- **N2.** Do **not** change the anchored-popover family (`HighlightActionPopover`, `SelectionPopover`,
  `ActionMenu`, `ActionBar`, `GlobalPlayerFooter` "more" popover, `LibraryMultiSelectPicker`,
  `ModelSettingsPopover` *desktop*, `LibraryMembershipPanel` *desktop*). These are non-modal, use
  `useDismissOnOutsideOrEscape` + `useAnchoredPosition`, and have different return-focus semantics
  (restore to a known anchor, not the prior `activeElement`). They are out of scope.
- **N3.** No new animation system. Reduced-motion handling stays in CSS (§8.5). The hook is behaviour-only.
- **N4.** Do **not** introduce a `useDialogOverlay` that renders markup or owns the backdrop element. It is
  a behaviour hook (`void` return), consistent with the existing `lib/ui` hooks. Backdrop + panel markup
  stays in each component.
- **N5.** No `data-dismiss-ignore` plumbing onto `ActionMenu`/`HighlightActionPopover` to make the document
  dismiss hook safe for sheets — that is the rejected alternative (§9, §17 K4).

---

## 4. Background — current state

### 4.1 The overlay family, classified

| Component | Class | In scope? |
|---|---|---|
| `components/appnav/NavSheet.tsx` | custom modal sheet (portaled, left slide) | ✅ convert |
| `components/workspace/MobileSecondaryPaneHost.tsx` | custom modal sheet (in-tree, bottom) | ✅ convert |
| `components/AddContentTray.tsx` (mobile) | custom modal sheet (adaptive) | ✅ convert (primitives) |
| `components/chat/ModelSettingsPopover.tsx` (mobile) | custom modal sheet (adaptive) | ✅ convert (primitives) |
| `app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal.tsx` | custom modal (a11y-deficient) | ✅ convert + fix |
| `components/GlobalPlayerFooter.tsx` (expanded sheet) | custom modal sheet (mobile, a11y-deficient) | ✅ convert + fix |
| `components/ui/Dialog.tsx` | native `<dialog>` | ❌ N1 |
| `components/palette/PaletteDesktopShell.tsx` | native `<dialog>` | ❌ N1 |
| `components/palette/PaletteMobileShell.tsx` | native `<dialog>` | ❌ N1 |
| `components/LibraryMembershipPanel.tsx` (desktop) | anchored popover | ❌ N2 |
| `components/highlights/HighlightActionPopover.tsx` | anchored popover (portaled) | ❌ N2 |
| `components/SelectionPopover.tsx` | anchored popover | ❌ N2 |
| `components/ui/ActionMenu.tsx` | anchored menu (portaled) | ❌ N2 |
| `components/ui/ActionBar.tsx` | anchored bar + color popover | ❌ N2 |
| `components/LibraryMultiSelectPicker.tsx` | anchored popover | ❌ N2 |

### 4.2 What's duplicated across the six in-scope sheets

| Concern | Today (file:line) | Owner after cutover |
|---|---|---|
| Body scroll lock | `useBodyOverflowLock` — NavSheet:41, MSPH:53, AddContentTray:319, ModelSettings:64, Player:211 (Podcast: **missing**) | already shared; called inside `useDialogOverlay` |
| Focus trap | `useFocusTrap` — NavSheet:42, MSPH:54, AddContentTray:321 (ModelSettings/Player/Podcast: **missing**) | already shared; inside `useDialogOverlay` |
| Return focus | inline — NavSheet:45–52, MSPH:56–72 (w/ fallback) (AddContentTray/ModelSettings/Player/Podcast: **missing**) | **`useReturnFocus`** (new) |
| Initial focus (rAF) | inline — NavSheet:54–60, MSPH:74–86 (tab-aware, re-key), AddContentTray:323–329 (ModelSettings/Player/Podcast: **missing**) | **`useInitialFocus`** (new) |
| Escape | 3 variants — `useDismissOnOutsideOrEscape` (NavSheet:43, ModelSettings:53); `document` keydown (MSPH:88–100, AddContentTray:305–317, `ui/Dialog`:29–34); element `onKeyDown` (Player:322) (Podcast: **missing**) | **`useEscapeKey`** (new); popovers via `useDismissOnOutsideOrEscape`→`useEscapeKey` |
| Outside / backdrop dismiss | backdrop `onClick` (MSPH:112, AddContentTray:400, ModelSettings mobile:102, Player:314, Podcast:25) **vs** doc-pointerdown (NavSheet:43) | standardise on backdrop `onClick` (§9) |

**Tally:** 3 hand-rolled Escape implementations, 3 copies of the return-focus effect (incl. the MSPH
fallback variant), 4 copies of the initial-focus effect, and 3 modals missing focus management entirely.
This is exactly the "collapse repeated logic to a single owner … state machines … near-identical
branches" case in `docs/rules/cleanliness.md`.

### 4.3 Existing primitives (unchanged, reused)

- `lib/ui/useBodyOverflowLock.ts` — `useBodyOverflowLock(active)`; sets `body.style.overflow=hidden`,
  restores prior value per activation.
- `lib/ui/useFocusTrap.ts` — `useFocusTrap(ref, active)`; wraps Tab/Shift+Tab within `getFocusableElements`.
- `lib/ui/getFocusableElements.ts` — focusable-selector query.
- `lib/ui/useDismissOnOutsideOrEscape.ts` — `useDismissOnOutsideOrEscape({enabled, refs, onDismiss})`;
  pointerdown-outside (honouring `data-dismiss-ignore`) **+** Escape. Stays for popovers; loses its
  Escape duplication (§12).
- `lib/ui/useAnchoredPosition.ts`, `lib/ui/useIsMobileViewport.ts` — unchanged.

---

## 5. Architecture / final state

A four-layer model. New code is layers 2–3; layer 1 is reused unchanged; layer 4 is the markup each
component already owns.

```
Layer 1  PRIMITIVES (exist, unchanged)
         useBodyOverflowLock   useFocusTrap   getFocusableElements

Layer 2  FOCUS/DISMISS PRIMITIVES (new, single-concern, à-la-carte usable)
         useEscapeKey          useReturnFocus       useInitialFocus

Layer 3  COMPOSING CONTRACT (new)
         useDialogOverlay  =  lock + trap + returnFocus + initialFocus + escape
                              (outside-click is NOT here — see §9)

         (Adaptive sheets skip layer 3 and call layer 1+2 directly, because their
          per-concern `active` differs: lock/trap mobile-only, escape both viewports.)

Layer 4  MARKUP (per component, owned locally)
         <scrim onClick={onDismiss}>            ← backdrop dismissal lives here
           <aside ref role="dialog" aria-modal onClick={stopPropagation}> … </aside>
         </scrim>

Parallel: ANCHORED POPOVERS (out of scope)        NATIVE <dialog> (out of scope)
          useDismissOnOutsideOrEscape (→useEscapeKey)   browser-contained
          + useAnchoredPosition
```

**Why a hook and not a shared component:** the six sheets diverge irreducibly on mount strategy (portal
vs in-tree vs adaptive branch), open signal (plain `open` prop vs derived `active` vs internal state),
geometry (left slide vs bottom sheet vs centred card), and content. The only thing they truly share is
the *behaviour cluster*. A hook operates on a `ref` and is indifferent to all of the above; a shared
component would have to absorb every divergence and become a god-component. The repo's existing `lib/ui`
hooks are `void`, ref-based, single-concern (see the `useDismissOnOutsideOrEscape` doc-comment: "this hook
only owns the dismiss listeners … positioning … in a separate effect") — `useDialogOverlay` matches that
shape.

---

## 6. Capability contract

`useDialogOverlay({ ref, active, onDismiss, … })` guarantees, for the lifetime of `active === true`:

1. **Scroll containment** — `document.body` scroll is locked; the prior `overflow` is restored exactly on
   deactivate/unmount (nested locks compose).
2. **Focus containment** — Tab and Shift+Tab cycle within the focusable elements inside `ref`.
3. **Focus-in** — on activation (and again whenever `focusKey` changes) focus moves, on the next animation
   frame, to `initialFocus(container)` if provided and found, else the first focusable element, else the
   container itself.
4. **Focus-restore** — on deactivation/unmount, focus returns to whatever was focused at activation; if
   that element is no longer connected, to `returnFocusFallback()` if provided.
5. **Escape dismissal** — a top-level Escape keypress calls `onDismiss` and `preventDefault()`s the event.
6. **Outside dismissal is the caller's responsibility** — the hook does **not** listen for outside
   pointer events. Callers render a full-viewport scrim with `onClick={onDismiss}` and stop propagation on
   the panel (§9). This keeps dismissal portal-safe and explicit.

Non-guarantees (caller-owned): ARIA roles/labels, the scrim/panel markup and styling, z-index, animation,
the `active` derivation, and which viewport the sheet renders on.

---

## 7. API design

All four files live in `apps/web/src/lib/ui/` (the established hooks home; imports use the `@/` alias per
`docs/rules/codebase.md`). All are `"use client"` and return `void`.

### 7.1 `useEscapeKey.ts`

```ts
"use client";

import { useEffect, useRef } from "react";

/**
 * While `active`, call `onEscape` when the user presses Escape (captured at the
 * document level, with preventDefault). The handler is read through a ref so the
 * listener attaches once per activation and the caller need not memoise it.
 */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onEscapeRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active]);
}
```

### 7.2 `useReturnFocus.ts`

```ts
"use client";

import { useEffect, useRef } from "react";

/**
 * While `active`, remember the element focused at activation and restore focus to
 * it when `active` flips false / on unmount. If that element is gone
 * (`!isConnected`), focus `fallback()` instead (e.g. the pane chrome that replaced
 * the trigger).
 */
export function useReturnFocus(
  active: boolean,
  fallback?: () => HTMLElement | null,
): void {
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    returnRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = returnRef.current;
      if (target?.isConnected) {
        target.focus();
        return;
      }
      fallbackRef.current?.()?.focus();
    };
  }, [active]);
}
```

### 7.3 `useInitialFocus.ts`

```ts
"use client";

import { useEffect, useRef, type RefObject } from "react";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";

/**
 * When `active` (and again whenever `key` changes), focus — on the next frame —
 * `select(container)` if provided and found, else the first focusable element,
 * else the container itself. The rAF defers focus until after the overlay paints.
 * `select` is read through a ref so an inline selector does not retrigger the effect.
 */
export function useInitialFocus(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  options?: { select?: (container: HTMLElement) => HTMLElement | null; key?: unknown },
): void {
  const selectRef = useRef(options?.select);
  selectRef.current = options?.select;
  const key = options?.key;

  useEffect(() => {
    if (!active || !containerRef.current) return;
    const container = containerRef.current;
    const frame = window.requestAnimationFrame(() => {
      const target =
        selectRef.current?.(container) ?? getFocusableElements(container)[0] ?? container;
      target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, key, containerRef]);
}
```

### 7.4 `useDialogOverlay.ts`

```ts
"use client";

import { type RefObject } from "react";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useEscapeKey } from "@/lib/ui/useEscapeKey";
import { useReturnFocus } from "@/lib/ui/useReturnFocus";
import { useInitialFocus } from "@/lib/ui/useInitialFocus";

/**
 * The modal-sheet accessibility contract in one call: while `active`, lock body
 * scroll, trap Tab focus inside `ref`, move focus in on open and restore it on
 * close, and dismiss on Escape.
 *
 * Outside-click dismissal is intentionally NOT owned here. Modal sheets dismiss
 * via a backdrop `onClick` (portal-safe — see docs/cutovers/dialog-overlay-hook-
 * unification.md §9): the caller wires `onClick={onDismiss}` on the scrim and
 * `onClick={(e) => e.stopPropagation()}` on the panel.
 */
export function useDialogOverlay(args: {
  ref: RefObject<HTMLElement | null>;
  active: boolean;
  onDismiss: () => void;
  initialFocus?: (container: HTMLElement) => HTMLElement | null;
  returnFocusFallback?: () => HTMLElement | null;
  focusKey?: unknown;
}): void {
  const { ref, active, onDismiss, initialFocus, returnFocusFallback, focusKey } = args;
  useBodyOverflowLock(active);
  useFocusTrap(ref, active);
  useReturnFocus(active, returnFocusFallback);
  useInitialFocus(ref, active, { select: initialFocus, key: focusKey });
  useEscapeKey(active, onDismiss);
}
```

---

## 8. How it composes with existing systems

- **§8.1 `useDismissOnOutsideOrEscape` (popovers).** Unchanged surface; internally delegates Escape to
  `useEscapeKey` (§12). Modal sheets stop using it (NavSheet dropped). It remains the right tool for
  anchored popovers, where pointerdown-outside is correct and `data-dismiss-ignore` guards portaled
  children.
- **§8.2 `useAnchoredPosition`.** Orthogonal — positioning, not containment. Popovers keep using it; modal
  sheets don't need it.
- **§8.3 `useIsMobileViewport`.** Drives the `active` expression for adaptive sheets
  (`isMobile && open`). The hook itself is viewport-agnostic.
- **§8.4 `MobileChromeProvider` / `useMobileChrome`** (`lib/workspace/mobileChrome.tsx`). The MSPH
  `returnFocusFallback` targets `[data-active="true"] [data-pane-chrome-focus="true"]` — that contract is
  preserved verbatim by passing the same selector into the hook. No coupling added.
- **§8.5 Z-index + scrim tokens** (`app/globals.css:92–97`): `--z-overlay:100`, `--z-modal:1000`. Sheets
  keep their current token (`NavSheet`→`--z-modal`, `MSPH`→`--z-overlay`); the hook doesn't touch z-index.
  Reduced motion stays globally handled (`globals.css:213–222` zeroes durations) plus the per-sheet
  `prefers-reduced-motion` rules (e.g. `AppNav.module.css:485–490`).
- **§8.6 Native `<dialog>` family.** Left intact (N1). The two patterns coexist: native `<dialog>` for
  simple centred dialogs/palettes; `useDialogOverlay` for custom-geometry sheets that can't be a plain
  `<dialog>` (edge slide, bottom sheet, viewport-adaptive modality).

---

## 9. Key decision — dismissal stays backdrop-`onClick`, not the document hook

**Decision:** modal sheets dismiss on outside interaction via a full-viewport scrim element with
`onClick={onDismiss}` and `onClick={(e) => e.stopPropagation()}` on the panel. `useDialogOverlay` owns
Escape only; outside-click is **not** in the hook.

**Why (the portal landmine).** `MobileSecondaryPaneHost` hosts arbitrary secondary-surface bodies that
open **portaled** child layers which mount to `document.body` as *siblings* of the sheet:

- `ReaderHighlightsSurface` → `HighlightActionBar presentation="menu"` → `ui/ActionMenu` →
  `createPortal(menu, document.body)` at `ActionMenu.tsx:370` — **no `data-dismiss-ignore`**.
- `ConversationReferencesSurface` → `ui/ActionMenu` (same).
- `HighlightActionPopover` → `createPortal(…, document.body)` at `HighlightActionPopover.tsx:54` —
  **no `data-dismiss-ignore`**.

A document-level pointerdown-outside listener (`useDismissOnOutsideOrEscape({refs:[sheetRef]})`) treats a
pointerdown on any of these portaled siblings as "outside the sheet" and would **dismiss the whole sheet
the instant the user taps a highlight action or reference menu**. The only portaled layer that carries
`data-dismiss-ignore="true"` today is the `ActionBar` color popover (`ActionBar.tsx:113`) — verified the
single occurrence in the repo. Backdrop-`onClick` sidesteps this entirely: a click on a portaled sibling
is not a click on *the scrim element*, so it never dismisses.

`NavSheet` happens to be safe with the document hook (its content opens nothing portaled while open — the
command/add buttons close the sheet first), but standardising it onto backdrop-`onClick` is strictly
better: the full-viewport scrim makes "click outside the sheet" ≡ "click the scrim," so behaviour is
equivalent, the sheet becomes robust if it ever hosts a portaled child, and the family gets one dismissal
pattern.

**Rejected alternative** (§17 K4): add `data-dismiss-ignore` to `ActionMenu` + `HighlightActionPopover`
portal roots so MSPH could use the document hook. Rejected — it's fragile (every future portaled child
must remember to opt in), spreads the dismissal contract across unrelated components, and buys nothing
over backdrop-`onClick`.

---

## 10. Scope — per-component conversion

### 10.1 In scope

#### 10.1.1 `NavSheet.tsx` — pure modal (`useDialogOverlay`)
- **Add:** `useDialogOverlay({ ref: sheetRef, active: open, onDismiss: onClose })`.
- **Remove:** `useBodyOverflowLock` (41), `useFocusTrap` (42), `useDismissOnOutsideOrEscape` (43), the
  return-focus effect (45–52), the initial-focus effect (54–60), `returnFocusRef`, and the now-unused
  imports (`useBodyOverflowLock`, `useFocusTrap`, `useDismissOnOutsideOrEscape`, `getFocusableElements`).
- **Markup:** add `onClick={onClose}` to `.sheetBackdrop` (71) and `onClick={(e) => e.stopPropagation()}`
  to the `<aside>` (72). Keep `role`, `aria-modal`, `aria-label`, `tabIndex`, `createPortal`.

#### 10.1.2 `MobileSecondaryPaneHost.tsx` — pure modal (`useDialogOverlay`, derived `active`)
```tsx
useDialogOverlay({
  ref: sheetRef,
  active,
  onDismiss: () => onClose(secondaryPaneId),
  initialFocus: (c) => c.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
  returnFocusFallback: () =>
    document.querySelector<HTMLElement>('[data-active="true"] [data-pane-chrome-focus="true"]'),
  focusKey: activeSurfaceId,
});
```
- **Remove:** `useBodyOverflowLock` (53), `useFocusTrap` (54), the return-focus effect (56–72), the
  initial-focus effect (74–86), the Escape effect (88–100), `returnFocusRef`, and the `getFocusableElements`
  import. Keep the `active` derivation (46–51) and the `if (!active …) return null` guard (102).
- **Markup:** backdrop `onClick` (112) and panel `stopPropagation` (122) already exist — keep.
- **Regression guard:** `MobileSecondaryPaneHost.test.tsx` must pass **unchanged** (§15, AC).

#### 10.1.3 `AddContentTray.tsx` — adaptive (primitives à la carte)
Modality is mobile-only but Escape works on both viewports, so `active` differs per concern → use
primitives directly, not `useDialogOverlay`:
```tsx
useBodyOverflowLock(isMobile && open);          // was 319
useFocusTrap(trayRef, isMobile && open);        // was 321
useReturnFocus(isMobile && open);               // NEW (was missing)
useInitialFocus(trayRef, isMobile && open);     // replaces inline 323–329
useEscapeKey(open, () => setOpen(false));        // replaces document keydown 305–317
```
- **Remove:** inline keydown Escape effect (305–317), inline initial-focus effect (323–329).
- **Markup:** backdrop `onClick` (400) + section `stopPropagation` (409) stay.

#### 10.1.4 `ModelSettingsPopover.tsx` — adaptive (add mobile cluster only)
Desktop = anchored popover (keep `useDismissOnOutsideOrEscape` at 53–62, which already supplies Escape on
both viewports and ignores outside-click on mobile). Add the mobile modal cluster:
```tsx
useBodyOverflowLock(open && isMobile);          // exists (64)
useFocusTrap(panelRef, open && isMobile);       // NEW
useReturnFocus(open && isMobile);               // NEW
useInitialFocus(panelRef, open && isMobile);    // NEW
```
- **No `useEscapeKey`** — the existing dismiss hook already owns Escape here. Do **not** add the document
  hook for outside-click on mobile (it's deliberately ignored — keep the mobile backdrop `onClick` at 102).

#### 10.1.5 `PodcastSubscriptionSettingsModal.tsx` — a11y-deficient modal → bring up to contract
Currently: backdrop `onClick` (25) + panel `stopPropagation` (31) + ARIA (28–30) only; **no** lock, trap,
focus, or Escape. Convert:
```tsx
const cardRef = useRef<HTMLDivElement>(null);
useDialogOverlay({ ref: cardRef, active: settingsRow !== null, onDismiss: settingsModal.close });
```
- **Add:** `cardRef` on the dialog card (28). Backdrop `onClick`/`stopPropagation` stay. Net result: gains
  scroll lock, focus trap, focus-in/restore, and Escape — a real accessibility fix.

#### 10.1.6 `GlobalPlayerFooter.tsx` (expanded sheet) — a11y-deficient modal → bring up to contract
Currently: `useBodyOverflowLock(mobileExpanded && isMobile)` (211), backdrop `onClick` (314), element-level
`onKeyDown` Escape (322); **no** trap/return/initial focus.
```tsx
const expandedSheetRef = useRef<HTMLElement>(null);
useDialogOverlay({
  ref: expandedSheetRef,
  active: mobileExpanded && isMobile,
  onDismiss: closeMobileExpanded,
});
```
- **Add:** `expandedSheetRef` on the `.expandedSheet` `<aside>` (316) + `onClick` `stopPropagation`.
- **Remove:** the standalone `useBodyOverflowLock` (211) — now inside the hook; the element-level Escape
  `onKeyDown` (322).
- **Keep:** the "more" popover's `useDismissOnOutsideOrEscape` (213) — separate anchored popover.
- **Verify (acceptance gate):** the expanded sheet hosts the effects/queue popovers — confirm Escape
  ordering (Escape should close an open child popover before the sheet, or at minimum match today's
  behaviour). If today's behaviour is "Escape closes the sheet," that is preserved; if a child popover
  needs first priority, handle in that popover, not here.

### 10.2 Out of scope (with rationale)
- **Native `<dialog>`:** `ui/Dialog.tsx`, `palette/PaletteDesktopShell.tsx`, `palette/PaletteMobileShell.tsx`,
  `LibraryMembershipPanel` mobile (delegates to `Dialog`). Browser-contained (N1).
- **Anchored popovers:** `HighlightActionPopover`, `SelectionPopover`, `ActionMenu`, `ActionBar`,
  `LibraryMultiSelectPicker`, `GlobalPlayerFooter` more popover, `ModelSettingsPopover` desktop,
  `LibraryMembershipPanel` desktop (N2). They benefit only from G4 (shared Escape primitive), transparently.
- **`app/share/ShareCapture.tsx`:** not a focus-managed dismissible modal (no `role="dialog"`, Escape, or
  lock) — leave alone.

---

## 11. Workstream B — backdrop scrim consolidation

The scrim CSS is copy-pasted across the modules below with the same recipe and four different opacities:

| File:line | Class | Opacity | Blur |
|---|---|---|---|
| `AppNav.module.css:428` | `.sheetBackdrop` | 0.5 | — |
| `MobileSecondaryPaneHost.module.css:1` | `.backdrop` | 0.24 | — |
| `AddContentTray.module.css:24` | `.mobileBackdrop` | 0.5 | 2px |
| `GlobalPlayerFooter.module.css:473` | `.expandedBackdrop` | 0.5 | 2px |
| `GlobalPlayerFooter.module.css:570` | `.queueOverlay` | 0.45 | — |
| `app/share/share.module.css:1` | `.backdrop` | 0.5 | 2px |
| `ui/Dialog.module.css:17` (`::backdrop`) | — | 0.6 → **0.5** | — |
| `palette/PaletteDesktopShell.module.css:15` (`::backdrop`) | — | 0.5 | 2px |
| `palette/PaletteMobileShell.module.css:14` (`::backdrop`) | — | transparent (keep) | — |

**Decision:** two tokens, and the two opacity outliers are **normalised** to the default — the per-module
drift (0.45, 0.6) is incidental, not designed, so a true single-token consolidation is preferred over
preserving named exceptions. Add to `globals.css` (alongside the `--z-*` tokens at 92–97):
```css
--overlay-scrim: rgb(0 0 0 / 0.5);        /* default modal scrim */
--overlay-scrim-soft: rgb(0 0 0 / 0.24);  /* light scrim — mobile secondary sheet */
```
Each backdrop becomes `background: var(--overlay-scrim)` — or `var(--overlay-scrim-soft)` for
`MobileSecondaryPaneHost.module.css:1` — keeping its own `position:fixed; inset:0` and per-sheet
`backdrop-filter` blur. The two normalisations are deliberate visual changes:
- `ui/Dialog.module.css:17` `::backdrop` — `0.6 → 0.5`.
- `GlobalPlayerFooter.module.css:570` `.queueOverlay` — `0.45 → 0.5`.

`PaletteMobileShell`'s intentionally-transparent `::backdrop` is **left as-is** (it relies on the sheet's
own opaque surface + slide animation, not a scrim). Workstream B lands in the same PR as Workstream A but
is independent of it — neither blocks the other.

---

## 12. Workstream A coda — single Escape owner

Refactor `useDismissOnOutsideOrEscape` so its Escape branch delegates to `useEscapeKey`, rather than
re-registering its own `keydown` listener:

```ts
// inside useDismissOnOutsideOrEscape, replacing the inline Escape keydown:
useEscapeKey(enabled, () => onDismissRef.current("escape"));
// the effect now owns only the pointerdown-outside listener.
```
Behaviour is identical (Escape → `preventDefault` → `onDismiss("escape")`). This makes `useEscapeKey` the
**one** place the Escape-to-dismiss keydown is implemented across the whole app (modal sheets *and*
popovers) — the "one concern, one owner" rule applied to the listener itself.

---

## 13. Files

**Create (4):**
- `apps/web/src/lib/ui/useEscapeKey.ts`
- `apps/web/src/lib/ui/useReturnFocus.ts`
- `apps/web/src/lib/ui/useInitialFocus.ts`
- `apps/web/src/lib/ui/useDialogOverlay.ts`

**Create — tests (browser project, §15):**
- `apps/web/src/lib/ui/useDialogOverlay.test.tsx`
- (optionally `useEscapeKey.test.tsx` / `useReturnFocus.test.tsx` / `useInitialFocus.test.tsx`, or cover
  them through the composing-hook test + the component tests)

**Modify (components, 6):**
- `apps/web/src/components/appnav/NavSheet.tsx`
- `apps/web/src/components/workspace/MobileSecondaryPaneHost.tsx`
- `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/components/chat/ModelSettingsPopover.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal.tsx`
- `apps/web/src/components/GlobalPlayerFooter.tsx`

**Modify (consolidation):**
- `apps/web/src/lib/ui/useDismissOnOutsideOrEscape.ts` (compose `useEscapeKey` — G4/§12)

**Modify (Workstream B):**
- `apps/web/src/app/globals.css` (add the two scrim tokens) + the scrim modules listed in §11
  (`AppNav`, `MobileSecondaryPaneHost`, `AddContentTray`, `GlobalPlayerFooter` ×2, `share`, `ui/Dialog`,
  `palette/PaletteDesktopShell`; `PaletteMobileShell` left as-is)

**Delete:** none. No files are removed; inline effects are deleted *within* the modified components. No
shim/compat files are introduced.

---

## 14. Rules & constraints

- **Hard cutover.** Every in-scope component switches in the same change. No component keeps an inline
  copy of any concern the hook now owns. No feature flag, no dual path, no "fallback" branch.
- **No legacy / no back-compat.** `NavSheet` stops importing `useDismissOnOutsideOrEscape`; the three
  hand-rolled Escape effects and four inline initial-focus effects are deleted outright. No deprecated
  re-exports.
- **House conventions** (`docs/rules/codebase.md`): imports via `@/` alias, relative imports ≤2 levels, no
  re-exporting symbols from other modules. New hooks are imported from their defining module.
- **Cleanliness** (`docs/rules/cleanliness.md`): the composing hook must stay a transparent orchestrator —
  no logic beyond ordering the five primitive calls. If `useDialogOverlay` ever needs a branch, that
  branch belongs in a primitive. "Prefer a little duplication over a hollow generic helper" is satisfied
  because (a) the primitives have ≥3 consumers each and (b) the cluster is a11y-critical, where a single
  owner prevents silent drift — not mere line-count reduction.
- **Single concern per hook.** `useEscapeKey`/`useReturnFocus`/`useInitialFocus` each own exactly one
  behaviour and are independently usable (proven by the adaptive sheets in §10.1.3–.4).

---

## 15. Testing strategy

Per `apps/web/vitest.config.ts` and the `[[reference_vitest_project_split]]` convention: the **unit**
project is `node`, includes `src/**/*.test.ts`, excludes `src/lib/highlights/**`; the **browser** project
runs `src/**/*.test.tsx` in real Chromium (Playwright). Focus, `requestAnimationFrame`, and
`document.body.style` only behave correctly in the browser project — so **hook tests are `.test.tsx`** and
mirror the existing `lib/ui/useAnchoredPosition.test.tsx` host-component pattern. Run from `apps/web`.

- **`useDialogOverlay.test.tsx`** (browser) — render a host component with a button + a hooked panel:
  - locks `body.style.overflow` while active; restores it on deactivate and on unmount;
  - moves focus into the panel on open (first focusable) and to `initialFocus(container)` when provided;
  - re-runs focus-in when `focusKey` changes;
  - restores focus to the opener on close; uses `returnFocusFallback` when the opener is disconnected;
  - Escape calls `onDismiss` and `preventDefault`s;
  - Tab/Shift+Tab wrap within the panel.
- **`MobileSecondaryPaneHost.test.tsx`** (existing, browser) — must pass **unchanged**. It already asserts
  scroll lock, active-tab initial focus, Escape→`onClose`, focus restore to opener, and roving tabs; it is
  the behaviour-preserving guard for the MSPH conversion.
- **`AppNav`/`NavSheet`** — add a browser test for the mobile sheet (open → focus moves in; Escape and
  backdrop click close; scroll locks; focus restores). `AppNav.test.tsx` currently only exercises the
  desktop rail (unit, node) — the sheet path is untested today, so this closes a gap.
- **Converted a11y-fix components** — add/extend a browser test asserting the *new* guarantees for
  `PodcastSubscriptionSettingsModal` and the `GlobalPlayerFooter` expanded sheet (Escape closes, focus
  traps, scroll locks), since these are behaviour *additions*, not refactors.
- **`useDismissOnOutsideOrEscape`** — existing popover tests must still pass after §12 (Escape unchanged).

---

## 16. Acceptance criteria

1. `useEscapeKey`, `useReturnFocus`, `useInitialFocus`, `useDialogOverlay` exist in `lib/ui/`, each `void`,
   single-concern, with the §7 signatures.
2. All six in-scope components (§10.1) consume the new hooks; **none** retains an inline
   lock/trap/return-focus/initial-focus/escape effect. Verified by grep: no `addEventListener("keydown"`
   for Escape, no `requestAnimationFrame` focus block, no `document.activeElement` capture inside any of
   the six.
3. `NavSheet` no longer imports `useDismissOnOutsideOrEscape`; its scrim dismisses via `onClick`.
4. `MobileSecondaryPaneHost.test.tsx` passes **without modification**.
5. `PodcastSubscriptionSettingsModal` and `GlobalPlayerFooter` expanded sheet now trap focus, restore
   focus, lock scroll, and dismiss on Escape (new tests assert this).
6. `useDismissOnOutsideOrEscape` delegates Escape to `useEscapeKey`; popover tests still pass (G4).
7. New `useDialogOverlay.test.tsx` (browser) covers the §6 contract.
8. `bun run` typecheck + lint clean; full unit + browser suites green. (Project uses Bun —
   `[[project_uses_bun]]`; never npm/pnpm.)
9. The portal landmine (§9) is not reintroduced: no in-scope sheet uses `useDismissOnOutsideOrEscape` for
   outside-click while hosting portaled children.
10. **(Workstream B)** `--overlay-scrim` + `--overlay-scrim-soft` exist in `globals.css`; the §11 scrim
    modules reference them; `Dialog` (0.6) and `queueOverlay` (0.45) are normalised to `--overlay-scrim`;
    no `rgb(0 0 0 / …)` / `rgba(0, 0, 0, …)` scrim literal remains in those modules (`PaletteMobileShell`'s
    transparent backdrop excepted). Verified by grep.

---

## 17. Key decisions

- **K1 — Hook, not component.** Behaviour-only `void` hooks operating on a `ref`. The sheets diverge on
  everything except behaviour; a shared component would absorb every divergence. Matches the existing
  `lib/ui` shape. (§5)
- **K2 — Three primitives + one composing hook, not one mega-hook.** The composing hook serves pure-modal
  sheets; the primitives serve adaptive sheets whose per-concern `active` differs. A single
  `useDialogOverlay({active})` is too coarse for `AddContentTray`/`ModelSettingsPopover` (lock/trap
  mobile-only, Escape both). (§10.1.3–.4)
- **K3 — Dismissal stays backdrop-`onClick`; Escape-only in the hook.** Portal-safe; equivalent for
  `NavSheet`; required for `MSPH`. (§9)
- **K4 — Rejected: `data-dismiss-ignore` plumbing** to make the document hook safe for sheets. Fragile,
  spreads the contract, no benefit over K3. (§9)
- **K5 — Native `<dialog>` left alone.** Two coexisting patterns is correct; converging them is a separate
  effort. (N1)
- **K6 — Single Escape owner.** `useDismissOnOutsideOrEscape` composes `useEscapeKey`; one keydown
  implementation app-wide. (§12)
- **K7 — Fix the deficient modals in the same cutover.** `PodcastSubscriptionSettingsModal` and the player
  expanded sheet gain real focus management — consolidation surfaces and closes a11y gaps rather than
  preserving them. (§10.1.5–.6)
- **K8 — `select` via ref in `useInitialFocus`.** Lets callers pass an inline selector without retriggering
  the effect; deps stay `[active, key, containerRef]`. (§7.3)

---

## 18. Risks & mitigations

- **R1 — MSPH behaviour drift.** Mitigation: AC4 (existing test passes unchanged); the hook reproduces the
  exact tab-aware `initialFocus`, the `[data-active]` fallback, and the `activeSurfaceId` re-key.
- **R2 — GlobalPlayerFooter nested Escape ordering.** The expanded sheet hosts effects/queue popovers.
  Mitigation: §10.1.6 verification gate; preserve today's ordering, push child-first priority into the
  child popover if required.
- **R3 — Double-dismiss / propagation bugs** when adding backdrop `onClick` to `NavSheet`. Mitigation:
  panel `stopPropagation` (mirrors MSPH/AddContentTray which already do this); browser test for
  open→backdrop-click→closed.
- **R4 — `ModelSettingsPopover` desktp regression** from adding mobile-only hooks. Mitigation: all four
  added hooks gate on `open && isMobile`; desktop path (anchored popover) is untouched.
- **R5 — rAF/focus flakiness in tests.** Mitigation: browser project only (real Chromium), `waitFor`
  around focus assertions, mirroring `useAnchoredPosition.test.tsx`.

---

## 19. Sequencing (single hard-cutover PR)

1. Add the three primitives + `useDialogOverlay` (+ tests).
2. §12 — `useDismissOnOutsideOrEscape` composes `useEscapeKey`; confirm popover tests green.
3. Convert the two pure-modal sheets with existing coverage first: `MobileSecondaryPaneHost` (AC4 guard),
   then `NavSheet` (+ new sheet test).
4. Convert the adaptive sheets: `AddContentTray`, `ModelSettingsPopover`.
5. Convert + fix the deficient modals: `PodcastSubscriptionSettingsModal`, `GlobalPlayerFooter` expanded
   (+ new a11y tests, R2 gate).
6. Grep-verify AC2/AC3/AC9 (no inline effects, no stray dismiss-hook usage in sheets).
7. Workstream B — add the two scrim tokens; repoint the §11 modules; normalise the `Dialog` (0.6) and
   `queueOverlay` (0.45) outliers to `--overlay-scrim`.
8. `bun run` typecheck + lint + full suite.

---

## 20. Resolved decisions

These three were open at first draft and are now settled (decisions folded into the body above):

- **Q1 → RESOLVED: normalise.** Workstream B uses two tokens and folds the `Dialog` (0.6) and
  `queueOverlay` (0.45) outliers into the single `--overlay-scrim` (0.5). The drift is incidental, not
  designed; a true single-token consolidation beats named exceptions. (§11, G7, AC10)
- **Q2 → RESOLVED: ship `useDialogOverlay`.** The composing hook is shipped and the four pure-modal sheets
  consume it. The named contract is the point; it stays a transparent orchestrator (no logic beyond
  ordering the five primitive calls — §14). (§7.4, §10.1, K2)
- **Q3 → RESOLVED: include `GlobalPlayerFooter`.** The expanded sheet is converted in this cutover (§10.1.6),
  behind the R2 nested-Escape-ordering verification gate. (§18 R2)

---

## 21. Post-implementation review (2026-06-02)

A validation pass (parallel review agents + full suites) confirmed the scoped cutover is correct and all
ACs hold, and surfaced four items — now fixed — that the original scope had missed:

- **GPF queue focus-trap regression (cutover-introduced).** Adding the §10.1.6 focus trap to the expanded
  sheet trapped Tab inside the occluded, `aria-modal` sheet when the queue panel — rendered as a sibling
  *outside* `expandedSheetRef` — opened over it. Fixed by collapsing the sheet when the mobile Queue button
  opens the queue (`setMobileExpanded(false)`), mirroring the desktop button that already closes its sibling
  "more" popover. The queue is now a single top-level overlay on both viewports.
- **Workstream B completion.** Two scrims on already-converted components were missed by the §11 table:
  `podcasts/page.module.css .modalBackdrop` (the standalone modal's scrim → `--overlay-scrim`, no visual
  change) and `chat/ModelSettingsPopover.module.css .settingsBackdrop` (the mobile sheet's scrim →
  `--overlay-scrim-soft`; a deliberate 0.32→0.24 normalisation that also gives the soft token a 2nd consumer).
- **A third hand-rolled document-Escape (scope miss).** `PodcastDetailPaneBody`'s mobile episodes drawer
  hand-rolled `useBodyOverflowLock` + a document keydown-Escape — the exact pattern this cutover eliminates.
  Converted to `useDialogOverlay` (it also gains a focus trap + focus restore). There is now **zero**
  hand-rolled Escape-to-dismiss outside `useEscapeKey` and native `<dialog>` (grep-verified).
- **Duplicate subscription modal (scope miss).** `PodcastDetailPaneBody` rendered its own a11y-deficient
  inline copy of `PodcastSubscriptionSettingsModal` (role/`aria-modal` on the backdrop, no focus management,
  no backdrop dismissal), driven by the same state hook. Consolidated onto the shared component: its prop was
  narrowed from `settingsRow: PodcastSubscriptionListItem` to `podcastTitle: string | null` (it only ever read
  the title), the richer detail-pane copy was ported into it so both surfaces share it, and the ~67-line
  inline copy plus its now-dead CSS were deleted.

Also closed two named-but-untested `useDialogOverlay` contract clauses (the `initialFocus`-miss fallback rung;
§6.1 nested-lock composition). Full unit + browser suites green after all changes.
