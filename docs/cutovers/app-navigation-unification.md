# App Navigation Unification — Rail + Mobile Top Bar + Command Bar

**Status:** Implemented (2026-06-01) · **Revision 2** (corrected after code-grounded review)
**Date:** 2026-06-01
**Type:** Hard cutover. No legacy paths, no fallbacks, no backward-compat shims.

> Implementation notes: the small one-use pieces the component map listed as
> separate files (`NavItem`, `NavCommandBar`, `NavBrand`, `NavActiveIndicator`,
> `NavTooltip`, `useNavCollapse`, `useActiveIndicator`, a second CSS module) were
> inlined into `AppNav`/`NavRail`/`NavSheet` per the codebase's minimalism rules —
> the family is `navModel.ts`, `navActive.ts`, `AppNav.tsx`, `NavRail.tsx`,
> `NavSheet.tsx`, `NavTopBar.tsx`, `NavAccount.tsx`, `AppNav.module.css`. The
> controller hook moved to `lib/workspace/mobileChrome.tsx` (no re-export from
> PaneShell — `codebase.md` forbids it; `MediaPaneBody`/`PdfReader` import it from
> the new home). `externalShell` was dropped from the model: `resolvePaneRoute`
> already returns `"unsupported"` for Oracle, so the click handler routes it via
> the full shell without a flag. Correctness work beyond the file plan: the reader
> top-offset CSS (`media/[id]/page.module.css`, `PdfReader.module.css`) now adds
> `var(--appnav-bar-height)` so document readers clear the new fixed top bar.

> Post-implementation review (2026-06-01): a multi-agent review-and-validate pass hardened the
> cutover. Fixes landed: (a11y blocker) collapsed rail links were unnamed → `aria-label` per item;
> (perf) the lifted controller re-rendered the heavy reader bodies on every hide/reveal — split
> `mobileChrome` into a **stable** controller context (readers) and a **volatile** state context (top
> bar) restoring the original boundary; (consolidation, D-3) `NavAccount` hand-rolled a menu — now
> reuses `ActionMenu` (extended once, additively, with a `renderTrigger` + `placement`/`align`),
> deleting ~45 lines + a CSS block and gaining real arrow-key menu nav + explicit focus restore;
> Settings now derives from `NAV_MODEL` (no triple definition); `NavSheet` reuses
> `useDismissOnOutsideOrEscape`; dropped the dead `MobilePaneChrome.titlePending` field and the dead
> `SurfaceHeader.onOptionsOpenChange` prop; pins map via a narrowing `flatMap` (no `as string`); the
> account avatar active state gains a non-color cue + `aria-current`; rail `aria-keyshortcuts` tracks
> the live binding; the sheet closes on out-of-band route change; `pane-chrome` e2e retargeted off the
> deleted Search nav link; added `AppNav.test.tsx` and a pane-switch reset test. Deferred follow-up:
> extract a shared dialog-overlay hook unifying `NavSheet` + `MobileSecondaryPaneHost` (out of this
> cutover's scope — touches a file it does not own). Verified: typecheck/lint clean, unit 497 pass.
>
> Rev-2 changelog: corrected the `--mobile-bottom-nav-height` "dead token" error (it is live in
> `SelectionPopover`); reuse `parseWorkspaceHref` instead of a new helper; keep **all** destinations
> (incl. Settings) in one model; add a single-active-destination **resolver** with precedence; lift
> the mobile hide-on-scroll controller to a shared owner; extend `useAnchoredPosition` for side
> placement; fix breakpoint wording (`≤768px`), indicator-height/contrast claims, command-helper
> cutover, file plan, and test plan. Owner decisions D-1…D-5 baked in (§13).

---

## 1. Summary

Replace today's three disconnected navigation surfaces with **one navigation system** — a single
source-of-truth model rendered through two responsive presentations and one shared command entry.

- **Desktop (> 768px):** a persistent, beautiful left **rail**.
- **Mobile (≤ 768px):** a from-scratch **single top bar** + slide-over **nav sheet**.
- **Both:** a **command bar** (⌘K → existing `CommandPalette`) — the universal *intent* surface —
  beside the rail/bar which is the persistent *orientation* surface.

Fuses the two chosen design lanes (**signature/artful** + **command-first**) because they are
symbiotic, and consolidates a 9×-duplicated rail plus a mobile-nav concern wrongly embedded in
per-pane chrome into one config-driven component.

---

## 2. Current state

### 2.1 Surfaces
| Surface | File | Viewport | Role |
|---|---|---|---|
| Left rail | `components/Navbar.tsx` (+ `.module.css`) | desktop (`display:none` ≤768px) | logo, 9 links + pins, Add, Sign Out, collapse |
| Pane tabs strip | `components/workspace/WorkspacePaneStrip.tsx` | desktop (`!isMobile`) | open-pane switcher (not sections) |
| Per-pane header | `components/ui/SurfaceHeader.tsx` via `PaneShell.tsx` | both | back/forward, title, meta, options |
| Mobile "app nav" | a `Command` button injected into `SurfaceHeader.actions` when mobile (`PaneShell.tsx:587–620`), count fed by `WorkspaceHost.tsx:1172` | mobile | the **only** app-level nav affordance on mobile |

Breakpoint is `window.innerWidth <= 768` via `useIsMobileViewport` (`lib/ui/useIsMobileViewport.ts:5`).
There is **no** bottom nav.

### 2.2 Concrete defects (the "why")
1. **Invisible hover/active.** Rail bg is `--surface-2`; `.navItem:hover` and `.navItem.active` both
   set `background-color: var(--surface-2)` — the same color. The system already ships
   `--surface-hover`, `--surface-active`, `--accent-muted` (unused by the rail).
2. **No active indicator**, **flat ungrouped list** (Settings adjacent to content; Add no heavier
   than Settings), **`transition: all`** (animates layout).
3. **9× duplicated markup**: nine `<Link>` blocks + nine `xActive` booleans (`Navbar.tsx:56–73,
   140–250`); two use raw `<a>` (`/search`, `/settings`).
4. **Missing semantics**: no `aria-current`, no list semantics, no collapsed-mode labels.
5. **Mobile nav is wrongly located** inside a generic per-pane chrome primitive.
6. **Dead plumbing**: `AuthenticatedShell` injects `${navbarCollapsed ? styles.navCollapsed : ""}`
   but `layout.module.css` defines no `.navCollapsed` → literal class `"undefined"`. Collapse state
   is otherwise unused (flex handles width). Collapse is **ephemeral** (`useState`).
7. **Asymmetric event dispatch**: `OPEN_COMMAND_PALETTE_EVENT` fired inline via
   `new CustomEvent(...)` (`PaneShell.tsx:598`) while `addContentEvents.ts` exposes
   `dispatchOpenAddContent()`.

---

## 3. Goals
- **G1 — One system / one model.** `NAV_MODEL` drives rail, bar, sheet. No destination defined twice.
- **G2 — Beauty.** Living active indicator, real hover/press physics, weight-shifting type, grouped
  with eyebrow labels, one accent, Oracle signature, grain atmosphere.
- **G3 — Command-first.** Persistent command bar (⌘K) on both presentations → existing palette.
- **G4 — Decouple.** App nav leaves `SurfaceHeader`/`PaneShell`; that primitive becomes pure pane chrome.
- **G5 — Mobile redone.** From-scratch single top bar (with folded minimal pane context) + nav sheet.
- **G6 — A11y + reduced-motion + performant** by construction (§8, §9).
- **G7 — Consolidate** (§12): kill duplication, dead plumbing, asymmetric dispatch; reuse existing
  URL/positioning/mobile-chrome primitives.

---

## 4. Non-goals
- No change to `CommandPalette` internals/ranking/providers. No semantic-search in the bar (it opens
  the palette, which already brokers search + "Ask AI").
- No change to `WorkspacePaneStrip` behavior.
- **No new runtime dependency** (no framer-motion/WebGL). **No new color tokens.**
- No backend/API changes. No bottom nav. No CSP/Trusted-Types work.

---

## 5. Scope
**In:** new `AppNav` family (rail/bar/sheet); `NAV_MODEL` + active resolver; command bar; collapsed
tooltips (+ a `useAnchoredPosition` side-placement extension); mobile top-bar rewrite; a lifted shared
**mobile-chrome controller**; token additions + the bottom-obstruction rename; decoupling edits to
`SurfaceHeader`/`PaneShell`/`WorkspaceHost`; `AuthenticatedShell` mount + dead-plumbing removal;
`dispatchOpenCommandPalette()` + call-site removal; `SelectionPopover` token rename.
**Out:** palette internals, pane strip, reader/oracle page internals, backend.

---

## 6. Target architecture

### 6.1 The model (single source of truth — Settings included)
```ts
// components/appnav/navModel.ts
import { Sparkles, type LucideIcon } from "lucide-react";

export type NavSlot = "primary" | "tools" | "account";

export interface NavDestination {
  id: string;                  // "libraries", "settings", "oracle", ...
  label: string;
  href: string;
  slot: NavSlot;
  icon?: LucideIcon;           // default: getPaneRouteIcon(href)
  match?: { exact?: string[]; prefix?: string[] }; // default: exact:[href]
  signature?: "oracle";
  externalShell?: boolean;     // navigates via full shell (Oracle is NOT a workspace pane route)
}

// Rendered groups (in order). Pinned is dynamic (not in the static list).
export const NAV_GROUPS = [
  { id: "primary", label: "Library" },
  { id: "pinned",  label: "Pinned" },   // dynamic items
  { id: "tools",   label: "Tools" },
] as const;

export const NAV_MODEL: NavDestination[] = [
  { id: "libraries", label: "Libraries", href: "/libraries", slot: "primary",
    match: { exact: ["/libraries"], prefix: ["/libraries/"] } },
  { id: "browse",   label: "Browse",   href: "/browse",   slot: "primary" },
  { id: "podcasts", label: "Podcasts", href: "/podcasts", slot: "primary",
    match: { exact: ["/podcasts"], prefix: ["/podcasts/"] } },
  { id: "today",    label: "Today",    href: "/daily",    slot: "primary",
    match: { exact: ["/daily"], prefix: ["/daily/"] } },
  { id: "notes",    label: "Notes",    href: "/notes",    slot: "primary",
    match: { exact: ["/notes"], prefix: ["/notes/", "/pages/"] } },
  { id: "chats",    label: "Chats",    href: "/conversations", slot: "tools",
    match: { exact: ["/conversations"], prefix: ["/conversations/"] } },
  { id: "oracle",   label: "Oracle",   href: "/oracle",   slot: "tools",
    icon: Sparkles, signature: "oracle", externalShell: true,
    match: { exact: ["/oracle"], prefix: ["/oracle/"] } },
  { id: "settings", label: "Settings", href: "/settings", slot: "account",
    match: { exact: ["/settings"], prefix: ["/settings/"] } },
];
```
- **Settings stays in the model** (slot `account`) so the model remains the single source of truth.
  It renders inside the **account menu** (decision D-3), not the section list.
- **Sign Out** is an auth *action* (`<form action="/auth/signout" method="post">`), not a destination;
  it lives in the account menu beside Settings.
- **Search has no model entry** — it *is* the command bar (D-2). The palette routes to the `/search`
  pane ("see all"), so no capability is lost.
- **Oracle** is intentionally outside the workspace pane system — `resolvePaneRoute("/oracle").id ===
  "unsupported"` (asserted at `lib/panes/paneRouteRegistry.test.tsx:72`). Hence `externalShell: true`
  and explicit `match` (active state cannot come from pane resolution).
- **Icons reuse the registry** (`getPaneRouteIcon`, `paneRouteRegistry.tsx:285`); only Oracle overrides.

### 6.2 Active-state resolution (reuse existing URL semantics; single winner)
```ts
import { parseWorkspaceHref } from "@/lib/workspace/workspaceHref"; // returns URL | null (validated)

// Active pathname of the workspace (as today): active primary pane → parseWorkspaceHref(href)?.pathname ?? ""

// components/appnav/navActive.ts
export function resolveActiveDestinationId(
  pathname: string,
  destinations: NavDestination[],   // static model + dynamic pins, normalized to NavDestination
): string | null;
```
**Precedence (exactly one winner):**
1. **Exact** matches first — `pathname === href` or `pathname ∈ match.exact` — across **pins, then
   account, then sections**. (A pin to `/pages/x` or `/settings/keys` beats a section prefix.)
2. **Prefix** matches next — `pathname` starts with any `match.prefix` — sections only.
3. Else `null` (indicator hidden).

This resolves the Notes-vs-pin conflict: Notes claims `/pages/*` by **prefix**, but a pinned
`/pages/x` claims it by **exact** and wins. `parseWorkspaceHref` replaces the old Navbar-local
`pathnameFromHref` (no new helper).

### 6.3 Component map
```
components/appnav/
  AppNav.tsx              # entry; picks rail vs bar via useIsMobileViewport(); owns shared state
  NavRail.tsx            # desktop rail
  NavTopBar.tsx          # mobile single bar (app affordances + folded minimal pane context)
  NavSheet.tsx           # mobile slide-over: brand, command bar, groups+pins, account
  NavItem.tsx            # one destination row (rail + sheet)
  NavCommandBar.tsx      # rail: input-styled; bar/sheet: compact → dispatchOpenCommandPalette()
  NavBrand.tsx           # AsterismMark + wordmark
  NavActiveIndicator.tsx # measured sliding indicator (transform only)
  NavAccount.tsx         # avatar trigger → ActionMenu(Settings, Sign Out)
  NavTooltip.tsx         # collapsed-rail label tooltip (portal, side placement)
  navModel.ts navActive.ts
  useNavCollapse.ts      # collapse + localStorage "nexus.nav.collapsed.v1"
  useActiveIndicator.ts  # measures active item geometry → {top,height,visible}
  AppNav.module.css NavTopBar.module.css

lib/workspace/mobileChrome.tsx   # NEW shared provider (lifted from PaneShell) — §6.5
```

### 6.4 Mounting
`AuthenticatedShell.tsx`:
- Wrap the workspace in `<MobileChromeProvider>` (§6.5), then mount `<AppNav />` + `<WorkspaceHost />`.
- **Delete** `navbarCollapsed`/`onToggle` state and the broken `navCollapsed` className. Collapse is
  owned + persisted by `AppNav` (`useNavCollapse`).
- `CommandPalette` and `AddContentTray` remain siblings (unchanged).

### 6.5 Mobile hide-on-scroll — one owner (lifted, not duplicated)
Today the hide-on-scroll lives **inside `PaneShell`** and is exposed only to pane bodies via
`usePaneMobileChromeController()` (`PaneShell.tsx:109–174`): `onDocumentScroll(snapshot)` drives
hide/reveal; `acquireVisibleLock(reason)` pins it visible (reasons: `reader-restore`, `pdf-selection`,
`text-selection`, `highlight-navigation`, `mobile-secondary`, `library-picker`, `action-menu`).

Because the **single** mobile bar now owns app + pane chrome, that controller must live **above** both
`AppNav` and `WorkspaceHost`:
- **Extract** the controller into `lib/workspace/mobileChrome.tsx` as `MobileChromeProvider` exposing
  `{ hidden, onDocumentScroll, acquireVisibleLock }` plus a `useMobileChrome()` hook.
- `AppNav`'s `NavTopBar` reads `hidden` to translate the bar off-screen (reveal on scroll-up).
- Pane bodies keep calling the **same** `usePaneMobileChromeController()` API — now backed by the
  shared provider (re-exported for source compatibility), so scroll publication + locks are unchanged.
- **No scroll logic is duplicated**; `PaneShell` stops owning hide state and simply forwards the active
  pane's document scroll into the shared controller.

---

## 7. Visual & interaction design spec

### 7.1 Desktop rail zones (top → bottom)
1. **Brand row** — `AsterismMark` (20px) in `--ink` (accent reserved for state); wordmark "Nexus"
   `--text-lg/--weight-semibold/-0.01em`. Collapse chevron right, `--ink-faint`, full-opacity on rail hover.
2. **Command bar** — input-styled control: leading `Search` icon, "Search or ask anything…"
   (`--ink-faint`), trailing `⌘K` `<kbd>`. Bg `--surface-1` (inset vs rail's `--surface-2`), 1px
   `--edge-subtle`, `--radius-lg`. Click/⌘K → `dispatchOpenCommandPalette()`. Collapsed → centered
   Search icon button.
3. **Groups with eyebrow labels (D-4):** `Library` (Libraries, Browse, Podcasts, Today, Notes) →
   `Pinned` (dynamic) → `Tools` (Chats, Oracle). Eyebrow = `--text-xs`, uppercase,
   `letter-spacing var(--tracking-wider)`, `--ink-faint`; hidden when collapsed. Groups separated by a
   1px `--edge-subtle` hairline inset `--space-3`.
4. **Footer cluster** (`margin-top:auto`): **Add** — single accent-tinted primary action
   (`--accent-muted` fill, `--accent` text; hover `--accent` fill + `--ink-on-accent`). **Account** —
   an avatar button → `ActionMenu` with **Settings** and **Sign Out** (D-3, reuses
   `components/ui/ActionMenu`). Avatar shows active when on `/settings*`.

Width tokens unchanged (`--navbar-width:240px`, collapsed `48px`, transition
`var(--duration-base) var(--ease-glide)`).

### 7.2 NavItem (shared rail + sheet)
`[indicator gutter][icon 20px][label]`, ~`--size-lg` (36px) desktop / ~44px sheet.
- Idle: icon+label `--ink-muted`, `--weight-medium`.
- Hover: bg `--surface-hover`; `--ink`; icon springs (§7.4).
- Active: bg `--accent-muted`; `--accent`; label `--weight-semibold`; `aria-current="page"`; moving
  indicator in the gutter.
- Press: bg `--surface-active` (`--duration-instant`).
- Transitions are **property-scoped** (`background-color`, `color`) — never `all`.

### 7.3 Living active indicator (signature) — transform only
One 2px-wide `--accent` bar in the left gutter that **slides** to the active item.
- `NavActiveIndicator` is one absolutely-positioned element inside the nav **scroll content** (scrolls
  with items, no scroll sync). `useActiveIndicator` measures the active item's `offsetTop`/
  `offsetHeight` via refs in `useLayoutEffect`, re-measuring on: active-change, `ResizeObserver` on the
  list, collapse `transitionend`, pins load.
- **Animate `transform: translateY()` only** (fixed indicator height; if heights ever vary, use
  `transform: scaleY()` — never CSS `height`). Easing `var(--duration-base) var(--ease-bloom)`;
  reduced-motion → tokens are `0ms` → snaps. Fades to `opacity:0` when no destination is active.

### 7.4 Micro-interactions (restrained)
Icon hover spring `transform: translateY(-1px) scale(1.06)` (`--ease-bloom`, transform only);
label weight shift idle→active with reserved width (no reflow); command-bar focus/`--ring` bloom.
All ≤ `--duration-base`, auto-zeroed under reduced motion.

### 7.5 Oracle signature
`Sparkles` carries a faint persistent gold glow (`drop-shadow(0 0 4px color-mix(in srgb, var(--accent)
40%, transparent))`), intensifying on hover; optional 1.6s shimmer sweep on hover **disabled under
reduced motion** (static glow remains).

### 7.6 Atmosphere (D-5: grain included)
Rail surface: subtle vertical gradient (`--surface-2` → ~2% lighter top) + 1px inner right-border
highlight. **Grain on** — a static `feTurbulence` SVG overlay at ≤4% opacity, `pointer-events:none`,
behind text; validate it does not depress label contrast below AA. **No `backdrop-filter` on the
persistent rail or mobile bar** (per-frame blur cost). The transient **sheet scrim** may blur once.

### 7.7 Collapsed-rail tooltips (extend the positioning primitive)
Collapsed = icon-only → each item shows its label as a tooltip on hover/focus. The rail is
`overflow:hidden` and the list scrolls, so the tooltip portals out. **Extend `useAnchoredPosition`**
(`lib/ui/useAnchoredPosition.ts`, today `placement: "below" | "above"`) to also accept
`"left" | "right"` (horizontal offset + flip), then build `NavTooltip` (`role="tooltip"`,
`placement:"right"`, portal) on it. This is an intentional, reusable enhancement (not a hack); add a
unit test for the new placements. (We do **not** reuse `HoverPreview` — it is a rich card with a touch
bottom-sheet path we don't want for labels — but we reuse its underlying hook.)

### 7.8 Mobile single bar (from scratch) + nav sheet
**One** sticky bar (`≤768px`, height `--appnav-bar-height`), replacing the `SurfaceHeader` palette
hack, with folded **minimal** pane context (D-1). Left→right:
- **Menu/brand** button → opens `NavSheet`.
- **Back / Forward** (pane) — compact, from the pane's `SurfaceHeaderNavigation`.
- **Pane title** (truncated).
- **Search** icon → `dispatchOpenCommandPalette()`.
- **Add** (accent icon) → `dispatchOpenAddContent("content")`.
- **Options** (pane `ActionMenu`, when present).

The bar hides/reveals via the shared `MobileChromeController` (§6.5). Pane back/forward/title/options
are sourced from the existing pane chrome publication; `SurfaceHeader` no longer renders its own bar on
mobile (it remains the desktop pane header).

**NavSheet** (`role="dialog" aria-modal`, `--z-modal`): brand, full command bar, groups with eyebrow
labels + Pinned group, Add, account (Settings + Sign Out). **Reuse the `MobileSecondaryPaneHost`
overlay pattern** (`components/workspace/MobileSecondaryPaneHost.tsx:53`): body-scroll lock, focus
trap, initial focus, focus restore to trigger, Escape, backdrop. Closes on selection / route change.
Reduced-motion → fade instead of slide.

### 7.9 Tokens
- **Add:** `--appnav-bar-height: 52px`.
- **Rename (not delete):** `--mobile-bottom-nav-height` → `--mobile-bottom-obstruction` (value `64px`
  retained). It is **live**: `SelectionPopover.tsx:34` reads it to keep mobile selection popovers clear
  of bottom chrome, and `SelectionPopover.test.tsx:119/127` sets it. Update both consumers + the test.
- **No new color tokens.** The redesign only *starts using* `--surface-hover`, `--surface-active`,
  `--accent-muted`, `--ease-bloom`. The **only color-value change** is the `--ring` contrast fix (§7.10).

### 7.10 Focus ring `--ring` — global contrast fix (D-6)
The shared focus token fails WCAG SC 1.4.11/2.4.11 non-text contrast (≥3:1 vs adjacent surfaces) at
its current translucent values, so we fix it globally as part of this cutover.

**Why it fails (alpha composites away the contrast):**
- Light: `rgba(125,94,53,0.45)` over `#ffffff` composites to ≈`#c4b6a4` → **≈2.0:1** (fail).
- Dark: `rgba(196,164,114,0.55)` over the *lighter* dark surfaces (`--surface-3 #23232a`,
  `--surface-active #2a2a2f`) composites to ≈**2.8:1** (fail); it only passes over the darkest surface.

**Fix — opaque, brand-derived rings (one value per theme):**
| Block (globals.css) | Today | New | Worst-case contrast vs its surfaces |
|---|---|---|---|
| `:root` (dark) `:134` | `rgba(196,164,114,0.55)` | `#d4b687` (= `--accent-hover`) | ≈7.4:1 (over `--surface-active`) |
| `[data-theme="light"]` `:166` | `rgba(125,94,53,0.45)` | `#4a371d` (= `--accent-active`) | ≈10:1 (over `--surface-2`) |
| `@media (prefers-color-scheme:light) :root:not([data-theme])` `:199` | `rgba(125,94,53,0.45)` | `#4a371d` | ≈10:1 |

Rationale: both are brand shades but **offset from the accent *fill* color** (lighter gold in dark,
darker brown in light), so a focus ring never collides with a same-colored accent button; opaque
guarantees the ratio regardless of the surface behind it. `outline: 2px solid` + `outline-offset: 2px`
unchanged. **Oracle** (`[data-theme="oracle"]`) defines no `--ring` and inherits the dark `#d4b687` —
high contrast on its near-black `#14110f` ground; no oracle-specific value needed.

**Blast radius (14 consumers, all benefit):** global `:focus-visible` (`globals.css:302`); the
`box-shadow: 0 0 0 3px var(--ring)` field halos in `Input`/`Select`/`Toggle`/`Textarea` + login;
`outline … var(--ring)` in `SurfaceHeader`, `ReaderCitation`, `ReferencingChatRow`,
`WorkspacePaneStrip`, `SecondarySurfaceTabs`; inset ring in `PaneShell`. **Accepted side effect:** the
three field halos render as solid (not translucent) 3px rings — bolder, on-brand, and accessible. No
component CSS changes; only the three token definitions change.

---

## 8. Accessibility contract
- Rail: `<nav aria-label="Primary">` with `<ul><li>` groups; items are real `<a>` (click intercepted,
  `href` valid). **No `role="menu"`/`menubar"`.**
- **`aria-current="page"`** on the active item (new). Active conveyed by indicator + fill + weight
  **and** color (never color alone).
- Command bar: real `<button>`, `aria-haspopup="dialog"`, `aria-keyshortcuts="Meta+K"`, name
  "Search or ask anything".
- Collapsed tooltips: `role="tooltip"`, on hover **and** focus.
- Mobile sheet + account menu: dialog/menu semantics, focus trap + restore, Escape, inert backdrop
  (sheet reuses the `MobileSecondaryPaneHost` pattern).
- Targets ≥24px floor (WCAG 2.5.8); design ~36px desktop / ~44px touch.
- **Contrast is validated with tooling during build** (no asserted magic numbers here). Targets: AA
  4.5:1 for labels, ≥3:1 for the indicator/icons, in light, dark, **and** system-preference modes.
  The global focus ring `--ring` is **fixed globally** in this cutover (§7.10, D-6) — opaque,
  brand-derived, ≥3:1 in every theme.
- All motion gated by `prefers-reduced-motion` (duration tokens auto-zero; sheet/shimmer explicitly
  guarded).

---

## 9. Performance rules
- Animate **transform/opacity/background-color/color** only; the indicator never animates CSS `height`
  (rail collapse `width` is a one-shot). No `transition: all`.
- **No `backdrop-filter`** on rail or mobile bar (transient sheet scrim only).
- Indicator uses `useLayoutEffect` + `ResizeObserver` (no scroll listener); reads-then-writes. It lives
  in scroll content, so scrolling needs no JS.
- Mobile hide-on-scroll uses the **single** shared controller (no per-surface scroll handlers).
- Tooltip positioning reuses batched `useAnchoredPosition`.

---

## 10. Capability contract / API
```ts
function AppNav(): JSX.Element;                       // shell mounts only this for nav

function resolveActiveDestinationId(pathname: string, destinations: NavDestination[]): string | null;

function useNavCollapse(): { collapsed: boolean; toggle(): void };           // localStorage
function useActiveIndicator(a: { activeId: string | null; listRef: RefObject<HTMLElement>;
  itemRefs: Map<string, HTMLElement> }): { top: number; height: number; visible: boolean };

// commandPaletteEvents.ts — ADD (mirror dispatchOpenAddContent):
function dispatchOpenCommandPalette(): void;          // window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))

// lib/workspace/mobileChrome.tsx — lifted shared controller:
function MobileChromeProvider(p: { children: ReactNode }): JSX.Element;
function useMobileChrome(): { hidden: boolean; onDocumentScroll(s:{scrollTop:number;scrollHeight:number;clientHeight:number}): void;
  acquireVisibleLock(reason: PaneMobileChromeLockReason): () => void };

// lib/ui/useAnchoredPosition.ts — placement union extended:
//   placement?: "below" | "above" | "left" | "right"
```
**Navigation behavior (reused, `Navbar.tsx:92–101`):** if `resolvePaneRoute(href).id === "unsupported"`
let the browser handle it; else `preventDefault()` + `navigatePane(activePane.id, href)` (or
`window.location.assign` when no active pane). `externalShell` destinations (Oracle) route via full shell.

---

## 11. Composition with other systems
- **Workspace store:** active pane → active pathname (`parseWorkspaceHref(...).pathname`); nav via
  `navigatePane`. Contract unchanged.
- **Command palette:** opened via the new helper; ⌘K hint = `formatKeyCombo(loadKeybindings()
  ["open-palette"] ?? DEFAULT_KEYBINDINGS["open-palette"])` → "⌘K"/"Ctrl+K".
- **Add content:** `dispatchOpenAddContent("content")` (unchanged).
- **Pins:** `useApiResource({ cacheKey:"navbar", path: pinnedObjectsPath })`; mapped to
  `NavDestination` (slot `pinned`, exact match on their route).
- **Pane tabs strip:** unchanged; rail = section nav, strip = open panes (complementary).
- **`SurfaceHeader`/`PaneShell`/`WorkspaceHost` decoupling (hard cutover):**
  - `PaneShell.tsx` — remove the mobile palette `<Button>`, the `Command` import, and the
    `mobileCommandPalette*` props/labels/badge; **stop owning hide state** (forward scroll to the
    shared controller). `SurfaceHeader` no longer renders a mobile bar.
  - `PaneShell.module.css` — delete `.mobileCommandPalette*` rules (`:120–174`).
  - `WorkspaceHost.tsx` — stop passing `mobileCommandPalettePaneCount` (`:1172`); wire pane scroll into
    the shared controller.
  - Command helper: PaneShell **loses** the dispatch entirely (button deleted); **AppNav** is the sole
    app dispatcher via `dispatchOpenCommandPalette()`.

---

## 12. Consolidation / dedupe ledger
| # | Smell today | Action |
|---|---|---|
| C1 | 9 hand-written nav blocks + 9 `xActive` booleans | `NAV_MODEL` + `.map(NavItem)` + `resolveActiveDestinationId` |
| C2 | Mixed `<a>`/`<Link>` for items | one `NavItem` element |
| C3 | Navbar-local `pathnameFromHref`; raw `new URL(href,…)` | **reuse `parseWorkspaceHref`** (no new helper) |
| C4 | Inline `new CustomEvent(OPEN_COMMAND_PALETTE_EVENT)` vs `dispatchOpenAddContent` | add `dispatchOpenCommandPalette()`; remove inline dispatch |
| C5 | App-nav embedded in `SurfaceHeader`/`PaneShell` mobile branch | move to `AppNav`; pure pane chrome |
| C6 | Dead `navCollapsed` plumbing | delete (collapse owned by `AppNav`) |
| C7 | Hide-on-scroll trapped in `PaneShell` | **lift** to shared `MobileChromeProvider` (no dup) |
| C8 | Icon choices duplicating the route registry | default `getPaneRouteIcon`; override Oracle only |
| C9 | Ephemeral collapse | persist (`useNavCollapse`) |
| C10 | `useAnchoredPosition` only above/below | extend with left/right (reusable) |
| C11 | Misleadingly-named live token | rename `--mobile-bottom-nav-height` → `--mobile-bottom-obstruction` |

---

## 13. Key decisions
**Owner-ratified:**
- **D-1** Mobile = one bar with folded minimal back/forward/title/options (sections live in the sheet).
- **D-2** Search graduates into the command bar; no Search rail item.
- **D-3** Settings + Sign Out behind an avatar/account `ActionMenu` (Settings stays in `NAV_MODEL`,
  slot `account`).
- **D-4** Show eyebrow group labels (Library / Pinned / Tools).
- **D-5** Include the ≤4% grain atmosphere (validated against contrast).
- **D-6** Fix the focus ring `--ring` globally now (opaque, brand-derived, ≥3:1 in all themes) — §7.10.

**Engineering:**
- **E-1** One component, two presentations, one model (avoids drift).
- **E-2** Living indicator slides via measured `transform` (signature); reduced-motion → snaps.
- **E-3** Reuse existing primitives: `parseWorkspaceHref`, `useAnchoredPosition` (extended),
  `MobileSecondaryPaneHost` overlay pattern, `ActionMenu`, `getPaneRouteIcon`, `useIsMobileViewport`.
- **E-4** Lift mobile-chrome controller above WorkspaceHost (one owner; no duplicated scroll logic).
- **E-5** No `backdrop-filter` on persistent surfaces. No new deps / color tokens.

---

## 14. File-level change plan
**Create:** `components/appnav/*` (per §6.3); `lib/workspace/mobileChrome.tsx`.
**Modify:**
- `components/commandPaletteEvents.ts` — add `dispatchOpenCommandPalette()`.
- `app/(authenticated)/AuthenticatedShell.tsx` — mount `MobileChromeProvider` + `AppNav`; delete
  `navbarCollapsed`/`onToggle`/broken className.
- `app/(authenticated)/layout.module.css` — confirm no `.navCollapsed` remains.
- `components/workspace/PaneShell.tsx` — remove mobile palette button + `Command` import +
  `mobileCommandPalette*`; forward scroll to shared controller; stop owning hide state.
- `components/workspace/PaneShell.module.css` — delete `.mobileCommandPalette*` (`:120–174`).
- `components/workspace/WorkspaceHost.tsx` — drop `mobileCommandPalettePaneCount` (`:1172`); wire pane
  scroll → shared controller.
- `components/ui/SurfaceHeader.tsx` — pure pane chrome (mobile bar removed once PaneShell stops passing it).
- `lib/ui/useAnchoredPosition.ts` (+ test) — add `left`/`right` placements.
- `components/SelectionPopover.tsx` + `__tests__/components/SelectionPopover.test.tsx` — rename token
  consumption to `--mobile-bottom-obstruction`.
- `app/globals.css` — add `--appnav-bar-height`; rename the obstruction token; **fix `--ring` in all
  three theme blocks** (`:134` dark → `#d4b687`, `:166` light → `#4a371d`, `:199` prefers-light →
  `#4a371d`) per §7.10. No component CSS touched.
**Delete (hard cutover):** `components/Navbar.tsx`, `components/Navbar.module.css`, any `Navbar` test.

---

## 15. Acceptance criteria
**Functional**
- [ ] Rail renders all `NAV_MODEL` sections (Library/Tools) + a labeled Pinned group; account avatar
      menu holds Settings + Sign Out; Add opens the tray; Oracle routes via full shell.
- [ ] Exactly **one** active item per `resolveActiveDestinationId` precedence; pinned `/pages/x` beats
      Notes prefix; `aria-current="page"` set; indicator slides to it.
- [ ] Command bar + ⌘K open the palette; hint matches the user's binding.
- [ ] Collapse hides labels, shows tooltips, **persists across reload**.
- [ ] Mobile: single bar shows menu/back/forward/title/search/add/options; menu opens the sheet; sheet
      navigates + closes correctly; bar hides on document scroll-down, reveals on up, and is pinned by
      visible-locks (selection, action-menu, etc.).
- [ ] **No** app-navigation affordance remains in `SurfaceHeader`/`PaneShell`; `WorkspaceHost` no longer
      passes a palette count; no inline palette `CustomEvent` in app code.
- [ ] `SelectionPopover` mobile bounds still honor the (renamed) bottom-obstruction token.

**Visual/motion**
- [ ] Hover/active clearly distinct from rail bg; indicator slides (transform); icons spring; Oracle
      glows; grain present without depressing contrast.
- [ ] Reduced-motion: indicator snaps, shimmer off, sheet fades.

**A11y**
- [ ] Keyboard reaches every control; visible focus; sheet + account menu trap/restore focus; no
      `role="menu"` on site nav; contrast validated in light/dark/system.
- [ ] `--ring` meets ≥3:1 against adjacent surfaces in dark, light, system-light, and oracle themes
      (spot-check a `:focus-visible` outline and a field `box-shadow` halo in each).

**Perf/cleanup**
- [ ] No `backdrop-filter` on rail/bar; no per-frame scroll JS for the indicator; no `transition:all`.
- [ ] `Navbar.*` deleted with no dangling imports; dead `navCollapsed` removed; token renamed.

---

## 16. Test plan
(`cd apps/web`; `*.test.tsx` run in the **browser** Vitest project (real Chromium) — ideal for
indicator geometry & focus; unit project for pure logic.)

- **Unit:** `navActive.test.ts` — precedence truth table (exact pin > section prefix; `/notes/123` &
  `/pages/x` → notes unless a pin claims `/pages/x`; `/podcasts/abc` → podcasts; `/settings/keys` →
  settings/account; `/oracle/x` → oracle). `useAnchoredPosition` left/right placement + flip.
- **Component (browser):** `AppNav.test.tsx` — renders sections + Pinned group + account menu; click
  navigates (mock store); `aria-current`; indicator `translateY ≈ active offsetTop`; collapse hides
  labels + persists (localStorage); command bar & ⌘K dispatch; tooltip appears on focus with side
  placement; mobile bar opens/closes sheet with focus trap/restore; Oracle routes via full shell.
- **Decoupling regression:** **replace** the positive mobile-command-button assertion at
  `__tests__/components/PaneShell.test.tsx:542` with a **negative** one (no palette button in mobile
  pane actions); assert pane back/forward/options intact. Update
  `androidShell.commandPalette.test.tsx` / `CommandPalette.test.tsx` to open via the event/helper.
  `SelectionPopover.test.tsx` updated for the renamed token.
- **E2E (Playwright, `apps/web/e2e/`):** add/refresh flows that touch the old Navbar/Search/Add/SignOut
  and mobile chrome: `command-palette`, `pane-chrome`, `workspace-tabs`, `workspace-session-restore`,
  `web-articles`, `epub`, `password-auth`.
- **Reduced motion:** indicator snaps (duration 0); shimmer off.

---

## 17. Hard-cutover steps
1. Land `navModel`/`navActive`, reuse `parseWorkspaceHref`, `dispatchOpenCommandPalette`,
   `useAnchoredPosition` extension, and `MobileChromeProvider` (extracted from PaneShell).
2. Build the `AppNav` family; wire `AuthenticatedShell` (provider + AppNav); persist collapse.
3. Strip app-nav from `PaneShell`/`SurfaceHeader`/`WorkspaceHost`; forward scroll to the shared
   controller; delete `.mobileCommandPalette*` styles.
4. Rename the obstruction token; update `SelectionPopover` + its test.
5. Delete `Navbar.*`; replace/extend tests; add Playwright specs. Run `bun run` lint + typecheck +
   vitest + e2e.

No transition window, no `Navbar` alias, no fallback path.

---

## 18. Risks & mitigations
- **Indicator churn** (collapse/scroll/pins/resize) → `ResizeObserver` + `transitionend` re-measure;
  indicator inside scroll content; fade when no active item.
- **Controller lift regressions** (locks, reduced-motion pinning) → preserve the exact
  `acquireVisibleLock` reasons + reduced-motion pin behavior when extracting; cover with PaneShell +
  AppNav tests.
- **Token rename** breaking `SelectionPopover` → update both consumers + test in the same change.
- **Crowded mobile bar** → compact icon controls; sections offloaded to the sheet; hide-on-scroll.
- **`--ring` is a shared token** → fixed globally (§7.10) changing only 3 definitions, not component
  CSS; the 3 field `box-shadow` halos intentionally become solid (accepted). Re-validate all themes.
```
