# Black Forest Oracle — Vade Mecum (Hard Cutover)

Builds on `docs/black-forest-oracle-eternal.md` (v1) and
`docs/black-forest-oracle-eternal-v2.md` (v2). Both shipped. v1's tripartite
arc, illuminated capital, fleurons, and colophon stay. v2's motto / gloss /
theme, sortes attribution, Aleph, Concordance, and first-person voice stay.

This cutover answers two practical gaps left by v2:

1. **The Oracle is unreachable on phones.** The app's navbar hides at
   ≤768px. The only mobile path to /oracle today is a deep link.
2. **The reading is laid out for desktop.** At 375px the body column
   collapses to ~299px after padding; the drop cap eats 27%; right-rail
   marginalia stack with their dashed border but never reflow; concordance
   rows overflow.

Vade Mecum (Latin: *go with me*) is the medieval term for a portable
ceremonial book. We make the Oracle one. It also adds the Oracle to the
command palette — Cmd+K becomes the canonical entry point on every
viewport.

No legacy code, no fallbacks, no backwards compatibility. No TypeScript
branches on viewport width — every desktop/mobile divergence is pure CSS
(media queries for shell, container queries for components). Hover styles
are gated on `(hover: hover) and (pointer: fine)`. Touch targets are
≥44×44 CSS px everywhere. Native `<dialog>` and the Popover API replace
any hand-rolled overlay; `100svh`/`100dvh` replace `100vh`.

## Target Behaviour

### Command palette

1. User presses Cmd+K (desktop) or taps the existing palette trigger
   (mobile) — palette opens in its existing centered panel / bottom sheet.
2. Palette shows a **new "Oracle" navigation entry** under the existing
   *Navigate* section: `Sparkles · Oracle` with keywords *oracle,
   divination, reading, folio, fortune, sortes, motto*.
3. Palette also shows a **new "Recent folios" group** populated from
   `/api/oracle/readings` (top 5, filtered to `status='complete'`). Each
   row reads `Folio XII · Of Courage · AVDENTES FORTVNA IVVAT` — Roman
   number, theme, motto. Truncates with ellipsis on a single line.
4. Selecting *Oracle* navigates the browser to `/oracle` via
   `window.location.assign` — a real route change out of the workspace
   shell. Selecting a folio navigates to `/oracle/{readingId}` the same
   way.
5. Recent folios are fetched lazily on first palette open per session and
   memoized; they refresh when the palette opens after a 5-minute idle
   window.

### Oracle on mobile (≤768px viewport)

1. `(oracle)/layout.tsx` provides a **sticky 44pt translucent top bar**
   with safe-area-inset-top padding. It contains a single labeled back
   affordance — `← Index` on a reading, `← Home` on the landing — and a
   collapsing title slot that fills with the folio motto once the
   headline scrolls past a sentinel.
2. Body text reflows to a comfortable column: `60ch` cap, `clamp()`-fluid
   font size (~17–20px), line-height 1.6. The font is the system
   old-style stack — Iowan Old Style → Palatino — so there is zero font
   download for body.
3. The **drop cap survives**, scaled with `initial-letter: 2` (mobile) /
   `3` (desktop). It never disappears.
4. **Marginalia become inline ⊕-toggles** below the relevant paragraph.
   Tapping the glyph expands the marginal note; tapping again collapses
   it. On desktop ≥1024px the right-rail returns and the toggle is
   hidden — same data, two presentations, one component.
5. **Concordance rows wrap to two lines on narrow widths** — Roman
   number + theme on the first line, motto on the second — so nothing
   overflows. Rows remain ≥44px tall and tap anywhere on a row navigates.
6. **Aleph grid** stays 2 columns at 375px. Image `sizes` is corrected
   so the browser picks the right `srcset` entry on phones; tile motto
   uses `text-wrap: balance` so it never breaks raggedly.
7. **Headlines** (motto, gloss, theme, question) get `text-wrap: balance`;
   passage prose gets `text-wrap: pretty`. Both fall back to normal wrap
   in browsers that lack support — no JS shim.
8. **Variable-font optical sizing** applied to body and display text via
   `font-optical-sizing: auto`.

### Oracle on desktop (≥1024px viewport)

1. The shell adds the same sticky top bar — but it can host more chrome
   (recent folios shortcut, theme filter) without crowding. *(Not in
   scope; the slot exists for future use, populated only with the back
   link today.)*
2. Right-rail marginalia are unchanged from v2.
3. Aleph grid expands to 4–5 columns; same `next/image` `sizes` pattern.

## Structure

### What's added (delta over v2)

| Concern | v2 | Vade Mecum |
|--|--|--|
| Layout shell | none — pages render directly | `(oracle)/layout.tsx` with sticky top bar |
| Mobile column | inherits v2 padding, broken at ≤768px | container-query and media-query reflow |
| Marginalia | always-visible right-rail aside | desktop right-rail / mobile ⊕-toggle, one component |
| Drop cap | `font-size: 2.5em` float, breaks at narrow | `initial-letter: 3 / 2`, optical-sized |
| Concordance row | single-line, can overflow | two-line wrap on narrow, stays one-line ≥768px |
| Aleph `sizes` | omitted → over-fetches on phones | `(max-width: 768px) 50vw, 25vw` |
| Palette entry | none for Oracle | `nav-oracle` + `Recent folios` group |
| Discoverability on mobile | deep links only | palette + (existing) hidden navbar |

### What stays

- v1's tripartite arc, IlluminatedCapital, BorderFrame, fleurons,
  colophon, illuminated-letter component.
- v2's motto / gloss / theme, sortes attribution, Aleph grid composition,
  Concordance fetch, first-person interpretation register, citation
  integrity contract.
- `(oracle)` route group as a full-screen page outside the workspace
  shell.
- The existing CommandPalette implementation (codebase's own; not cmdk).
- 768px as the codebase's single mobile breakpoint. 1024px stays for the
  passage 2-col rule. No new breakpoints.

## Architecture

### Layout shell (`(oracle)/layout.tsx`)

A server component that wraps both `/oracle` and `/oracle/{readingId}`.
It mounts a small client component (`OracleShell`) which renders:

```
<OracleShell>
  <OracleTopBar />            // sticky 44pt bar; reads parent route via usePathname
  {children}
</OracleShell>
```

The top bar:

- Position: `position: sticky; top: 0;` with safe-area-inset-top padding
  via `padding-top: max(env(safe-area-inset-top), 0.5rem)`.
- Backdrop: translucent (`background: color-mix(in oklch, var(--oracle-paper) 80%, transparent)`)
  with `backdrop-filter: blur(8px)`.
- Back link: derived from path. `/oracle/{id}` → `← Index` (`/oracle`).
  `/oracle` → `← Home` (`/libraries`). Plain `<a>` with explicit href so
  the browser handles real navigation; iOS edge-swipe-back works for free.
- Title slot: empty until the page's headline scrolls past the bar's
  sentinel. Implemented with an IntersectionObserver on a sentinel
  element rendered by the page; OracleShell exposes a context (`OracleHeadlineContext`)
  with `setStickyTitle(text | null)` that the headline calls in a useEffect.

### Marginalia component

```tsx
// apps/web/src/app/(oracle)/oracle/[readingId]/Sidenote.tsx
"use client";
function Sidenote({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.sidenoteToggle}
        aria-expanded={open}
        aria-label={open ? "Hide marginal note" : "Show marginal note"}
        onClick={() => setOpen((o) => !o)}
      >⊕</button>
      <aside className={styles.sidenote} data-open={open}>{children}</aside>
    </>
  );
}
```

CSS:

```css
/* default: mobile-first */
.sidenoteToggle { /* 44×44, inline next to the marginalia anchor */ }
.sidenote[data-open="false"] { display: none; }
.sidenote[data-open="true"]  { display: block; /* inline below paragraph */ }

@media (min-width: 64rem) {       /* 1024px */
  .sidenoteToggle { display: none; }
  .sidenote { display: block !important; /* always shown in right-rail */ }
}
```

`OracleReadingPaneBody.tsx` swaps each `<aside class={styles.marginalia}>`
for `<Sidenote>{ /* same content */ }</Sidenote>`.

### Palette additions

`CommandPalette.tsx` gets two changes:

1. New static entry in `ACTIONS`:

```ts
{
  id: "nav-oracle",
  label: "Oracle",
  keywords: ["oracle", "divination", "reading", "folio", "fortune", "sortes", "motto"],
  section: "Navigate",
  icon: Sparkles,
  execute: () => window.location.assign("/oracle"),
}
```

2. New hook `useRecentOracleReadings()` returning `Action[]`. Pseudocode:

```ts
function useRecentOracleReadings(open: boolean): Action[] {
  const [rows, setRows] = useState<OracleSummary[]>([]);
  const fetchedAt = useRef(0);
  useEffect(() => {
    if (!open) return;
    if (Date.now() - fetchedAt.current < 5 * 60_000) return;
    apiFetch("/api/oracle/readings")
      .then((r) => r.json())
      .then((rows) => {
        const completed = rows
          .filter((r) => r.status === "complete")
          .slice(0, 5);
        setRows(completed);
        fetchedAt.current = Date.now();
      })
      .catch(() => { /* swallow — empty section is fine */ });
  }, [open]);
  return useMemo(
    () => rows.map((r) => ({
      id: `oracle-recent-${r.id}`,
      label: `Folio ${toRoman(r.folio_number)} · ${r.folio_theme ?? "—"} · ${r.folio_motto ?? "Untitled"}`,
      keywords: [r.folio_motto ?? "", r.folio_theme ?? "", `folio ${r.folio_number}`],
      section: "Recent folios" as Section,
      icon: Sparkles,
      execute: () => window.location.assign(`/oracle/${r.id}`),
    })),
    [rows],
  );
}
```

The component's existing render-time merge of `ACTIONS + recentTabs +
searchResults` extends to include `recentOracle` in the same shape. The
palette's filtering and keyboard navigation already operate over the
merged list — no changes needed.

The `Section` union widens to include `"Recent folios"`, with its
display order placed after `"Recent"` and before `"Create"`.

### CSS strategy

`oracle.module.css` becomes the single source of truth for the page's
visual rules. New blocks in additive order:

1. **Container scope** — wrap the reading body in
   `container: oraclereading / inline-size;` so the passage layout can
   adapt to its own width via `@container oraclereading (min-width: 56rem)`
   instead of viewport media queries. The current
   `@media (min-width: 1024px)` block on `.passage` is replaced with the
   container query.
2. **Mobile defaults** (applied at all widths; overridden at larger):
   - `.surface` and `.reading` padding shrunk to `clamp(1rem, 4vw, 3rem)
     clamp(0.875rem, 3vw, 2.25rem)`.
   - `.illuminatedCapital` size driven by
     `font-size: clamp(2.75em, 6vw + 1em, 4.5em);`.
   - `.quote::first-letter` replaced by `initial-letter: 2;` mobile-first;
     `initial-letter: 3;` at `≥1024px`.
   - `.concordanceItem`: switched to two-line layout on narrow, single
     line ≥640px via container query.
   - `.alephCellMotto`: `text-wrap: balance`.
3. **Hover only on hover-capable devices**:
   ```css
   @media (hover: hover) and (pointer: fine) {
     .alephCell:hover { transform: translateY(-2px); /* … */ }
   }
   ```
4. **Tap-target floor**:
   ```css
   @media (any-pointer: coarse) {
     .alephCell, .concordanceItem, .sidenoteToggle { min-height: 44px; }
   }
   ```
5. **Headline / body text-wrap**:
   ```css
   .epigraph, .foliumMotto, .foliumGloss, .foliumTheme, .readingQuestion {
     text-wrap: balance;
   }
   .quote p, .interpretation p, .argument p { text-wrap: pretty; }
   ```
6. **Optical sizing**:
   ```css
   .reading { font-optical-sizing: auto; }
   ```

The legacy `@media (min-width: 1024px)` rule for `.passage` is **removed
and replaced** by the container query; nothing else outside this file
changes layout breakpoint behavior.

### Top-bar scroll observer

```tsx
// OracleShell.tsx
const HeadlineContext = createContext<{ setStickyTitle: (s: string | null) => void } | null>(null);

export function OracleShell({ children }: { children: ReactNode }) {
  const [stickyTitle, setStickyTitle] = useState<string | null>(null);
  const value = useMemo(() => ({ setStickyTitle }), []);
  return (
    <HeadlineContext.Provider value={value}>
      <OracleTopBar title={stickyTitle} />
      {children}
    </HeadlineContext.Provider>
  );
}
```

The reading page mounts a single sentinel element above the headline; an
IntersectionObserver in OracleTopBar (or a small hook
`useStickyHeadline(text)` consumed by the headline) flips `stickyTitle`
between `null` and the motto string. No scroll event listener — only IO.

## Final State

### `/oracle` on mobile

```
┌──────────────────────────────────┐  ← 44pt sticky bar
│ ← Home                           │     translucent + safe-area-inset-top
├──────────────────────────────────┤
│                                  │
│       BLACK FOREST ORACLE        │  ← clamp() motto, balance-wrap
│         …small italic gloss…     │
│                                  │
│  [        question input       ] │  ← form
│  [ ask                          ]│
│                                  │
│  ──────  fleuron  ──────         │
│                                  │
│  ┌──────┬──────┐                 │  ← Aleph: 2 columns
│  │ XII  │  XI  │                 │     image sizes="50vw"
│  │motto │motto │                 │     each ≥44px tall
│  ├──────┼──────┤                 │
│  │  X   │  IX  │                 │
│  └──────┴──────┘                 │
└──────────────────────────────────┘
```

### `/oracle/{id}` on mobile, after stream complete

```
┌──────────────────────────────────┐
│ ← Index            FORTUNE FAVO… │  ← stickyTitle once headline scrolls past
├──────────────────────────────────┤
│  Folio XII · Of Courage          │
│  AVDENTES FORTVNA IVVAT          │
│  Fortune favors the bold.        │
│                                  │
│  «What should I do…?»            │  ← question
│                                  │
│  Argument paragraph…             │
│                                  │
│  [ artist plate, full-bleed ]    │
│                                  │
│  Virgil opened to Aeneid X.467   │
│  ┃Long quote text wrapped at     │  ← drop cap initial-letter: 2
│   60ch, line-height 1.6…         │
│   ⊕  ← tap to expand marginalia  │
│   [ marginalia inline below ]    │
│                                  │
│  …two more passages…             │
│                                  │
│  Interpretation, first person…   │
│                                  │
│  ❦   omens   ❦                   │
│   • omen one                     │
│   • omen two                     │
│                                  │
│  ❦   concordance   ❦             │
│  Folio VII · Of Time             │  ← two-line row
│  The Solitary Lamp               │
│                                  │
│  Folio III · Of Courage          │
│  Per Aspera Ad Astra             │
│                                  │
│  ❦  colophon  ❦                  │
└──────────────────────────────────┘
```

### `/oracle/{id}` on desktop, unchanged from v2

The right-rail marginalia returns; the drop cap is `initial-letter: 3`;
the passage uses a 2-column container-query layout.

### Command palette

- *Navigate* section gains an *Oracle* row.
- A new *Recent folios* section appears between *Recent* and *Create* on
  the empty-state view (no query) and falls under the same fuzzy filter
  once the user types. When the user has zero completed Oracle readings,
  the section renders nothing.
- Every entry executes via `window.location.assign(...)` because Oracle
  lives outside the workspace pane shell.

## Rules

1. **No mobile-vs-desktop branches in TypeScript.** Adaptation is CSS
   only (media queries for shell, container queries for components).
   `useIsMobileViewport` is allowed only where there is no CSS path —
   currently nowhere in this scope.
2. **No JS shims for unsupported CSS.** `text-wrap: balance/pretty`,
   `initial-letter`, `font-optical-sizing: auto` ship as-is; older
   browsers degrade to normal rendering.
3. **No third-party modal / sheet / palette libraries.** The codebase's
   palette stays. Any future overlay uses the native `<dialog>` element.
4. **No new web fonts.** Body uses the system old-style stack; display
   uses the existing UnifrakturMaguntia (`--font-unifraktur`) / IM Fell
   (`--font-im-fell`) / EB Garamond (`--font-eb-garamond`) loaded by the
   root layout.
5. **Hover-only styles** sit inside `@media (hover: hover) and (pointer:
   fine)`. Touch sizing inside `@media (any-pointer: coarse)`. Width
   alone is never used as a touch proxy.
6. **44×44 CSS px floor** for every interactive element on coarse
   pointers.
7. **`100svh` for shells; `100dvh` only for full-bleed dialogs/popovers.**
   `100vh` is forbidden in this scope.
8. **viewport-fit=cover** is already on the root layout — no change
   required. Safe-area-inset values are read with `max(env(...), <baseline>)`
   so insets compose with baseline padding.
9. **Palette entries that target /oracle use `window.location.assign`.**
   They do not call `requestOpenInAppPane` — Oracle is not a pane.
10. **Recent folios section** is silently empty on fetch error or empty
    response. No spinner, no error toast in the palette.
11. **Ranking** stays substring-on-label-and-keywords. No frecency in
    this cutover (deferred to a separate spec).
12. **Sidenote toggle is a real `<button>`** with `aria-expanded`,
    keyboard-activatable, focus-visible.
13. **Sticky title in the top bar** is announced as `aria-live="polite"`
    so screen readers receive the new heading when the user scrolls
    past the visual headline.

## Goals

- Oracle is reachable on every viewport: navbar (desktop), palette
  (every viewport), deep link (every viewport).
- Reading on a 320–375px phone is comfortable: 60ch lines, 17–20px body,
  drop cap proportional, no horizontal overflow.
- Marginalia remain a meaningful annotation on phones — neither hidden
  nor crammed — via the ⊕-toggle.
- Concordance never overflows; row tap area is generous.
- Desktop UX is preserved — anyone who was happy with v2 is at least as
  happy.
- The palette becomes the canonical mobile entry point to /oracle and
  recent folios in 1 keystroke / 1 tap.

## Acceptance Criteria

### Manual

- [ ] At 320px / 375px / 414px / 768px / 1024px / 1280px / 1440px the
  reading page never produces horizontal scroll. The drop cap is visible
  but proportional; no clipping.
- [ ] iOS Safari: top bar respects safe-area-inset-top in standalone PWA
  mode and in browser; bottom edge of the page respects
  safe-area-inset-bottom (where applicable).
- [ ] iOS Safari: edge-swipe-back from the reading view returns to
  /oracle.
- [ ] Sidenote toggle works on touch (tap), keyboard (Enter/Space), and
  mouse; keyboard focus ring is visible. `aria-expanded` reflects state.
- [ ] At ≥1024px the right-rail marginalia returns; the toggle button is
  hidden.
- [ ] Concordance rows do not horizontally overflow at 320px.
- [ ] Aleph grid is 2 cols at 375px, 3+ at 768px, 4+ at 1024px; tile
  motto wraps with `balance`.
- [ ] Cmd+K (desktop) shows *Oracle* in *Navigate* and the user's
  completed folios (if any) under *Recent folios*.
- [ ] Mobile palette (existing trigger) shows the same entries.
- [ ] Selecting *Oracle* navigates the browser to /oracle (full route
  change, not pane open). Selecting a recent folio opens that reading.
- [ ] Hover styles on Aleph cells appear on a desktop mouse hover; do
  not appear on a touch device.
- [ ] Sticky top bar reveals the motto only after the user scrolls past
  the visible headline; scrolling back hides it again.

### Automated

- [ ] `Sidenote.test.tsx` — toggling click flips `data-open` and
  `aria-expanded`; the aside is hidden when closed at narrow widths and
  always shown ≥1024px.
- [ ] `CommandPalette.test.tsx` — `nav-oracle` action exists with the
  expected label/keywords; `useRecentOracleReadings` is called when the
  palette opens and merges into the visible list (mocked fetch).
- [ ] `OracleShell.test.tsx` — top bar renders the back affordance based
  on the mocked path; `setStickyTitle` updates the bar title.
- [ ] `oracle-layout.spec.ts` (Playwright e2e) — at 375px viewport, no
  horizontal scroll on /oracle and /oracle/{id}; sidenote toggle expands;
  palette opens and contains *Oracle*.
- [ ] `make verify` green; `make test-front-unit` green;
  `make test-front-browser` green; existing `make test-back-unit` green
  (no backend changes).

## Non-Goals

- Refactoring the palette to cmdk or React Aria. The codebase has a
  working palette; a swap-out is a separate decision.
- Frecency / personalization ranking in the palette. Substring is enough
  for now.
- AI fallback ("Ask Oracle") inside the palette.
- Bottom-sheet *peek* on a concordance row. Tap still navigates.
- Voice input on the palette.
- PWA install / offline mode.
- Reading-position persistence across sessions.
- A standalone mobile theme picker. Sepia is the only mode.
- Edge-swipe-back gesture handling in code — relies on browser default.
- New fonts. Body uses the system old-style stack; display uses the
  fonts already loaded by the root layout.
- Backend changes. The `/api/oracle/readings` list endpoint added in v2
  is reused as-is. No new migration. No new schema.

## Files

### New

| Path | Role |
|--|--|
| `apps/web/src/app/(oracle)/layout.tsx` | Server layout for /oracle and /oracle/{id}; mounts OracleShell. |
| `apps/web/src/app/(oracle)/OracleShell.tsx` | Client shell rendering OracleTopBar; provides HeadlineContext. |
| `apps/web/src/app/(oracle)/OracleTopBar.tsx` | Sticky 44pt top bar with derived back link and live title slot. |
| `apps/web/src/app/(oracle)/oracle-shell.module.css` | Top-bar / shell CSS — sticky positioning, blur, safe-area. |
| `apps/web/src/app/(oracle)/oracle/[readingId]/Sidenote.tsx` | Mobile ⊕-toggle / desktop right-rail marginalia component. |
| `apps/web/src/app/(oracle)/oracle/[readingId]/Sidenote.test.tsx` | Toggle and breakpoint visibility tests. |
| `apps/web/src/lib/palette/useRecentOracleReadings.ts` | Hook returning palette `Action[]` from `/api/oracle/readings`. |
| `apps/web/src/lib/palette/useRecentOracleReadings.test.ts` | Hook tests with fetch mocked. |
| `apps/web/e2e/oracle-mobile.spec.ts` | Playwright: 375px viewport, sidenote toggle, palette entry. |

### Modified

| Path | Change |
|--|--|
| `apps/web/src/components/CommandPalette.tsx` | Add `nav-oracle` action; widen `Section` to include `"Recent folios"`; consume `useRecentOracleReadings()` and merge into rendered list; import `Sparkles`. |
| `apps/web/src/app/(oracle)/oracle/oracle.module.css` | Mobile-first reflow of `.surface`, `.reading`, `.passage`, `.quote::first-letter` → `initial-letter`, `.concordanceItem` two-line wrap, `.alephCellMotto` balance-wrap, hover/coarse-pointer media queries, container query on `.reading`, `text-wrap` rules, `font-optical-sizing`. The existing `@media (min-width: 1024px)` block on `.passage` is replaced with `@container oraclereading (min-width: 56rem)`. |
| `apps/web/src/app/(oracle)/oracle/OracleLandingPaneBody.tsx` | Remove its own page-level header if it duplicates the new top bar; keep the form + Aleph. |
| `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.tsx` | Replace each marginalia `<aside>` with `<Sidenote>`; mount `useStickyHeadline(motto)` to feed the top bar; ensure body wrappers use the new container scope. |
| `apps/web/src/app/(oracle)/oracle/OracleAlephGrid.tsx` | Update `<Image sizes>` to `(max-width: 768px) 50vw, 25vw`. |
| `apps/web/src/app/(oracle)/oracle/OracleConcordance.tsx` | Restructure each row's content into two `<span>`s so the CSS can drop the second to its own line on narrow widths. |
| `apps/web/src/app/(oracle)/oracle/[readingId]/OracleReadingPaneBody.test.tsx` | Update snapshots / DOM assertions for the new sidenote markup. |

### Deleted

None. Hard cutover is an in-place replacement of the legacy mobile-broken
CSS rules and the legacy non-toggleable marginalia structure.

## Key Decisions

1. **`(oracle)/layout.tsx` is a server component**; the shell is a thin
   client component. Layouts compose; this is the Next.js native answer.
2. **Top-bar title via React Context, not Zustand store**. Scope is one
   tree; no other consumer needs the value. A workspace-store entry
   would be wrong layering.
3. **IntersectionObserver, not scroll listener**, for sticky-title
   detection. Modern, cheap, no rAF coordination.
4. **Sidenote uses React state, not the Tufte CSS-only checkbox hack.**
   Tufte's hack was a JS-purity claim; this is a React app with client
   components. State is simpler, testable, accessible by default.
5. **Container query on the passage, not a media query.** The passage is
   a component that lives inside the reading body; it should adapt to
   its own width, not the viewport. The existing 1024px viewport rule
   is replaced — this is a one-line correctness fix masquerading as
   modernization.
6. **`window.location.assign` for palette → /oracle**, not router.push.
   Oracle is outside the workspace shell; a hard navigation is the
   semantically honest signal. It also keeps `ACTIONS` a static array
   instead of forcing the palette into a hook context for one entry.
7. **Recent folios fetched lazily on palette open, cached for 5 minutes**.
   The list endpoint is small and already supports the user's full
   history; we don't need a server-side push.
8. **No bottom-sheet for concordance peek.** Tap → navigate is the
   simpler, well-understood behavior. A peek sheet is feature creep.
9. **No frecency.** The palette's substring filter is enough for the
   small recent set; sorting is server-side `last_used_at desc`.
10. **System old-style serif for body** (Iowan Old Style → Palatino).
    Zero font download for body, instant first paint, optical sizing
    works on macOS/iOS (Iowan and Palatino both have optical metrics).
11. **`initial-letter` over `::first-letter`-with-clamp.** It composes
    correctly with line layout instead of fighting it; modern browsers
    support it; older browsers ignore the rule and the letter falls
    back to inline rendering — acceptable.
12. **No "Vade Mecum" naming surfaces in UI.** Internal codename only.
13. **No new font weights or subsets.** UnifrakturMaguntia is already
    400-only; we won't add a 700.

## Cutover Plan

Order is chosen so each step is testable in isolation.

1. **`(oracle)/layout.tsx` + OracleShell + OracleTopBar + shell CSS.**
   The bar shows nothing but a back link. No page changes yet. Verify
   bar appears, route-derived back link is correct, safe-area padding
   is right.
2. **Sticky-title context + sentinel.** Reading page mounts the sentinel
   above the headline and feeds the motto string via
   `useStickyHeadline`. Verify the bar title appears/disappears on scroll.
3. **`oracle.module.css` mobile reflow.** Add the mobile-first padding,
   typography, drop cap, container query on `.reading`, hover/coarse
   guards, text-wrap rules. Remove the `@media (min-width: 1024px)
   .passage` block; replace with the container query. Verify visually
   at 375 / 768 / 1024 / 1440.
4. **Sidenote component.** Replace inline marginalia in
   `OracleReadingPaneBody.tsx`. Verify mobile toggles, desktop
   right-rail.
5. **Concordance row two-line layout.** Restructure
   `OracleConcordance.tsx` rendering, add CSS rule to drop the second
   span to its own line on narrow widths. Verify row tap area ≥44px.
6. **Aleph `sizes` correction.** One-line change in `OracleAlephGrid.tsx`.
7. **Palette `nav-oracle` entry.** Static action; widen `Section` union;
   add Sparkles import. Verify palette opens with Cmd+K and shows
   *Oracle* under *Navigate*.
8. **`useRecentOracleReadings` hook + integration.** Add hook, mock its
   fetch in tests, render into the palette. Verify recent folios appear
   for a user with completed readings.
9. **Tests.** `Sidenote.test.tsx`, `useRecentOracleReadings.test.ts`,
   palette unit assertions, e2e `oracle-mobile.spec.ts`.
10. **Full verification gauntlet.** `make verify`, `make test-front-unit`,
    `make test-front-browser`, `make test-back-unit`, `make test-e2e`,
    `make test-real`. Pre-existing failures previously documented are
    re-confirmed as such, not introduced by this cutover.
11. **Commit + push to main.** Single commit with a clear message
    summarizing both halves of the change.

## Risks

| Risk | Likelihood | Mitigation |
|--|--|--|
| `initial-letter` rendering inconsistent across iOS Safari versions | Medium | Acceptable visual variance; the page never depends on the cap for legibility, only ornament. |
| Container queries on `.reading` interact unexpectedly with the existing pane outline | Low | The reading body is the only container; outline is on `.reading` itself, container scope is nested. |
| `useRecentOracleReadings` fetch races with logout / unauthenticated state | Low | Hook swallows fetch errors; empty section renders nothing. |
| Section ordering in the palette confuses users who memorized the Cmd+K layout | Low | New section is added between existing ones, not in front of *Navigate*; muscle memory preserved. |
| Sticky title context throwing on a /oracle page rendered without the layout (server-side prefetch) | Low | OracleShell's context provides a no-op default `setStickyTitle`. |
| `text-wrap: pretty` perf regressions on very long passages in Chromium | Low | Only three passages per reading, each <2k chars; well under documented thresholds. |
| Hidden navbar at ≤768px now leaves the back affordance load-bearing | Medium | The new top bar always has the back link; manual mobile QA covers the back path on every page. |
| Recent-folios cache outliving a folio deletion | Low | 5-minute TTL is short enough; deleted-folio rows surface a 404 page that's already handled. |

## Out of Scope (deferred)

- Frecency-based palette ranking (separate spec).
- AI / "Ask Oracle" palette fallback.
- Concordance peek bottom sheet.
- Reading-position persistence.
- PWA / offline.
- Native mobile app.
- Replacing CSS Modules with Tailwind / CSS-in-JS.
- Theme switcher (sepia → dark).
- Recent folios scoped by theme or by source work.

## Source notes

The recommendations distilled from the SOTA survey:

- WAI-ARIA Authoring Practices: combobox / listbox /
  `aria-activedescendant`. The codebase's palette already implements
  this; no changes.
- web.dev — `<dialog>`/popover Baseline 2026; `100svh`/`100dvh`/`100lvh`
  Baseline 2025. We respect both.
- Tufte CSS — the ⊕-toggle pattern. We adopt the visual idea, implement
  with React state.
- Frank Rausch / Apple HIG — labeled back-arrow is preferable to
  generic "Back"; `← Index` / `← Home` follow this.
- Utopia.fyi — `clamp()` formula for fluid type. We don't generate a
  full Utopia scale; the per-rule `clamp()` is targeted.
- Slack engineering — frecency model. Cited and explicitly deferred.
- WCAG 2.2 SC 2.5.8 — 24×24 minimum, 44×44 target. We hold the line at
  44.
- Linear's `ResponsiveSlot` pattern (intrinsic > breakpoints). The top
  bar's title slot is a small expression of this.

## Out-of-band caveats from current research

- `text-wrap: pretty` is not in Firefox as of 2026-05; it falls back to
  normal wrap. Acceptable.
- cmdk has had no release in 14+ months. We are *not* on cmdk; this is
  context for any future palette swap-out.
- Container style queries on custom properties are not in Firefox.
  Irrelevant to this cutover (we only query inline-size).
