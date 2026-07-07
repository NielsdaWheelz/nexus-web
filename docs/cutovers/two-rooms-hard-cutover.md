# Two Rooms — Study and Press, light and dark as distinct moods — Hard Cutover

**Status:** Spec · **Rev 1** · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior. Pure CSS + one settings label change.

## One-line

Split the two app themes into editorially distinct rooms — the **Study** (day: warm cream paper, `#faf8f3` canvas, crisp 1px rules) and the **Press** (night: `#ededef` ink on `#0e0e10`, body sized up to 1rem, tracking open 0.008em, rules thickened to 1.5px, letterpress grain spreading canvas-wide) — by adding five per-room tokens to `globals.css`, forking the body element defaults, replacing the AppNav's per-component grain with a `body::before` canvas grain, and renaming the Settings labels from "Light / Dark" to "Study / Press".

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** The machine-hand cutover (`machine-hand-hard-cutover.md`, sibling #1) defines `--ink-machine` and `--rail-machine` with per-room values and must land **before** this spec touches the theme blocks. This spec carries those tokens into the same three theme locations (dark `:root`, `[data-theme="light"]`, `prefers-color-scheme` fallback) without changing their values.
- **P-2.** The token layer structure in `globals.css` is stable: theme-invariant scale block (`:root`, lines 4–121), semantic dark defaults in `:root` (lines 123–155), `[data-theme="light"]` override (lines 159–191), and `@media (prefers-color-scheme: light) :root:not([data-theme])` system fallback (lines 194–228). This cutover adds tokens into those existing blocks — no new CSS structural patterns.
- **P-3.** The appearance cookie (`lib/theme/cookie.ts`) stores `"light" | "dark"`. Internal values are untouched. The `setAppearanceAction` server action (`lib/theme/setAppearanceAction.ts`) is untouched. The `data-theme` attribute on `<html>` is untouched. **Only the presentation labels in one UI file change** (D-1).

> Rationale: Two Rooms is a CSS-only semantic enrichment. No new pages, no new routes, no migration, no API. Its value is editorial character — two typographically differentiated environments — realized entirely through token values and one canvas-grain element. The cookie, action, and theme application machinery all stay.

---

## 1. Problem (grounded diagnosis)

### 1.1 Reversed type is not inverted type — but the token layer treats it that way

The current token architecture is symmetrical inversion: `globals.css:123–155` defines dark defaults (Press candidate) and `globals.css:159–191` defines light overrides (Study candidate) by swapping surface/ink values. This is engineering convenience, not book design.

Reversed type (light ink on dark paper) **halates** — light bleeds optically, making letterforms read slightly smaller and more closely spaced than they measure. Compensating requires:
1. **Optical size up** — body at 15px on dark paper reads ~15% smaller than on white; stepping to 16px (1rem) recovers it.
2. **Tracking open a hair** — ~0.008em separates the letters enough to counter irradiation.
3. **Rules slightly thickened** — at 1px, a reversed hairline halates into near-invisibility on the dark canvas. 1.5px holds the rule.
4. **Grain for texture** — reversed type gains depth from a subtle paper-tooth grain; without it, `#0e0e10` reads flat and electronic.

None of these four compensations are currently applied. The dark theme is the light theme with hex values swapped. **The body element rule reads:**
```css
/* globals.css:283 — font-size invariant across both rooms today */
body {
  font-size: var(--text-base);  /* 0.9375rem — never changes with the room */
  ...
}
```
`--text-base: 0.9375rem` and `--text-md: 1rem` both exist in the scale block (`globals.css:15–16`) but the body never switches between them.

### 1.2 The grain is a per-component accident, not an editorial decision

`AppNav.module.css:29–37` adds a grain texture to the nav rail via `::before` (SVG feTurbulence, `baseFrequency='0.85'`, `opacity: 0.035`). This was the right instinct — the grain is present in the app's dominant chrome element — but it:
- Does not extend to the canvas (the rail is ~240px wide; the rest of the viewport is grain-free)
- Fires in **both** Study and Press (light mode has an unexplained grain on the rail)
- Is not owned by the theme layer — it is a per-component decoration that happens to be grain-shaped

The editorial intent (the spec seed) is: grain belongs to the **Press** room only, covering the whole canvas, as a letterpress atmosphere. Study is clean paper.

### 1.3 Settings labels are typographic misnomers

`SettingsAppearancePaneBody.tsx:44,55` shows "Light" and "Dark" as the option labels. These are technically correct (they name the cookie values) but miss the editorial character of each room. "Study" and "Press" name what you are *doing*, not what color the pixels are.

The three-option structure (Study / Press / System) is already present; only the labels of the first two options change.

---

## 2. Target behavior (user-facing)

- **Study (day).** Warm cream canvas (`#faf8f3`), dark ink (`#1a1a1c`), body text at 0.9375rem (paper-tuned optical size), hairline rules at 1px, no grain. Hardback-under-a-lamp calm. The AppNav rail keeps its current linear gradient; the room's character is crisp contrast on warm paper.
- **Press (night).** Near-black canvas (`#0e0e10`), warm light ink (`#ededef`), body text stepped up to 1rem to compensate halation, tracking opened 0.008em, rules at 1.5px for legibility against dark, paper-tooth grain at opacity 0.035 spread across the entire canvas. Letterpress at night.
- **Settings labels.** Appearance Settings shows "Study — Warm paper, dark ink" and "Press — Near-black canvas, warm ink". The radio values and cookie strings remain `light`/`dark`.
- **Reader per-user settings compose.** The reader has its own `.readerThemeLight`/`.readerThemeDark` blocks in `page.module.css:337–364` with hardcoded hex values — they are explicitly documented as independent of the app theme (page.module.css:6–11). The reader's `font-size: var(--reader-font-size-px)` overrides body's `--body-font-size`. The `--tracking-body` inheritance is imperceptible at 0.008em and does not conflict.
- **Oracle scope unaffected.** `[data-theme="oracle"]` in `globals.css:248–262` is a separate, scoped theme applied by `/oracle/layout.tsx` via a `data-theme="oracle"` attribute on a `display: contents` wrapper `div`. Oracle's custom-property block does not define `--tracking-body` or `--body-font-size`, so those token values do not flow into oracle scope. However, body-level computed values cascade normally: `letter-spacing: var(--tracking-body)` (0.008em in Press) is inherited by oracle content where no explicit `letter-spacing` is set. Oracle's own display rules set explicit `letter-spacing` on all visible headings and labels; elements without an explicit override inherit 0.008em — imperceptible, and beneficial on the dark canvas. The canvas grain is behind oracle content areas (see §4.4 and AC-11).

---

## 3. Goals / Non-goals

### Goals

- **G1.** Five new per-room tokens: `--body-font-size`, `--tracking-body`, `--stroke-hairline` (forked from scale-block invariant), `--canvas-grain-opacity`, `--canvas-grain-image`. Defined in all three theme locations (dark `:root`, `[data-theme="light"]`, `prefers-color-scheme: light` fallback).
- **G2.** Body element defaults use the new per-room tokens: `font-size: var(--body-font-size)`, `letter-spacing: var(--tracking-body)`.
- **G3.** Canvas-wide grain in Press: `body::before` with `position: fixed; opacity: var(--canvas-grain-opacity); background-image: var(--canvas-grain-image)`. Zero paint cost in Study (`--canvas-grain-opacity: 0`).
- **G4.** Remove the AppNav per-component grain (`AppNav.module.css` `.rail::before` rule and its z-index scaffolding). Canvas grain is sole grain owner.
- **G5.** Settings labels renamed: "Light" → "Study", "Dark" → "Press", with updated hint text.
- **G6.** Study canvas warmed: `--surface-canvas` in `[data-theme="light"]` changes from `#fafaf7` to `#faf8f3`, matching `--brand-bg-light` (`brand.css:6`) and the reader's own light background (`page.module.css:338`).
- **G7.** Carry the machine-hand tokens (`--ink-machine`, `--rail-machine`, from sibling #1) in all theme locations. Values are defined by #1; this spec does not change them.
- **G8.** WCAG contrast table for body, muted, and machine ink in both rooms, with failures noted (see §4.3 — `--ink-faint` is a pre-existing gap, not introduced here).

### Non-goals (explicit)

- **N1.** No internal value changes. The cookie stores `"light" | "dark"`, the `AppTheme` type is `"light" | "dark"`, `data-theme` is `"light"` or `"dark"`. Nothing changes in the persistence or application layer.
- **N2.** No print styles. Out of scope per editorial guidance.
- **N3.** No `[data-theme="oracle"]` block changes — oracle color tokens are unaffected. Body-level declarations (`font-size`, `letter-spacing`) compose with oracle content as documented in §2.
- **N4.** No reader per-user typography changes. `ReaderTheme` values (`light`/`dark` in `lib/reader/types.ts:11`) and `--reader-*` tokens are out of scope.
- **N5.** No new font downloads. The grain SVG is an inline data URI; `--body-font-size` is a different size of Inter, not a new face.
- **N6.** No component rewrites. Two Rooms is tokens + settings labels + one structural CSS rule. Every surface that uses `--stroke-hairline`, `--surface-canvas`, etc. inherits the new values automatically.
- **N7.** No fixing the `--ink-faint` contrast gap. It exists today on both dark canvas (3.9:1) and light canvas (4.0:1) — below WCAG AA for body text. The gap is pre-existing, documented here for record, and deferred.

---

## 4. Architecture and final state

### 4.1 How theming works today (verified)

1. **Cookie.** `lib/theme/cookie.ts:3` defines `type AppTheme = "light" | "dark"`. `readThemeCookie()` reads the `nx-theme` cookie.
2. **Root layout.** `app/layout.tsx:67–78` reads the cookie server-side and sets `<html data-theme={theme ?? undefined}>`. No `data-theme` attribute = system preference fallback.
3. **CSS cascade.** `globals.css` has three blocks:
   - `:root` (lines 123–155) — dark defaults, active when `data-theme` is absent or `"dark"`.
   - `[data-theme="light"]` (lines 159–191) — explicit light override.
   - `@media (prefers-color-scheme: light) :root:not([data-theme])` (lines 194–228) — system-preference fallback, same values as `[data-theme="light"]`.
4. **Theme change.** `SettingsAppearancePaneBody.tsx:20–27` updates `document.documentElement.dataset.theme` immediately (no flash) and calls `setAppearanceAction` to persist the cookie.

No JS theme store, no React context, no SSR flash — the `data-theme` attribute on `<html>` drives everything via CSS cascade.

### 4.2 Final token table — every token that forks between rooms

All 30 existing tokens retain their current values (Study values in `[data-theme="light"]`, Press values in `:root`). The table below shows current values (unchanged unless marked ✎) plus the five new tokens (marked NEW).

| Token | Study `[data-theme="light"]` | Press `:root` |
|---|---|---|
| `--surface-canvas` | `#faf8f3` ✎ _(was `#fafaf7`)_ | `#0e0e10` |
| `--surface-1` | `#ffffff` | `#161618` |
| `--surface-2` | `#f4f4f0` | `#1c1c1f` |
| `--surface-3` | `#ededea` | `#23232a` |
| `--surface-hover` | `#f0f0ec` | `#1f1f23` |
| `--surface-active` | `#e6e6e1` | `#2a2a2f` |
| `--surface-sunken` | `#f1f1ed` | `#0a0a0c` |
| `--ink` | `#1a1a1c` | `#ededef` |
| `--ink-muted` | `#525258` | `#a3a3a8` |
| `--ink-faint` | `#7a7a80` | `#6f6f76` |
| `--ink-on-accent` | `#fafaf7` | `#0e0e10` |
| `--ink-machine` | `#3c4a57` | `#c4ccd6` |
| `--edge` | `#d4d4cf` | `#2c2c30` |
| `--edge-subtle` | `#e8e8e3` | `#1f1f23` |
| `--edge-strong` | `#87878d` | `#44444a` |
| `--accent` | `var(--brand-fg-on-light)` = `#7d5e35` | `var(--brand-fg-on-dark)` = `#c4a472` |
| `--accent-hover` | `#634a29` | `#d4b687` |
| `--accent-active` | `#4a371d` | `#b8965f` |
| `--accent-muted` | `rgba(125,94,53,0.12)` | `rgba(196,164,114,0.16)` |
| `--ring` | `#4a371d` | `#d4b687` |
| `--success` | `#2f7a3e` | `#6ec07a` |
| `--warning` | `#8a6618` | `#d4b066` |
| `--danger` | `#a83a44` | `#d96a73` |
| `--info` | `#3b6b8f` | `#7ea3c5` |
| `--shadow-1` | `0 1px 2px rgba(20,20,30,0.06)` | `0 1px 2px rgba(0,0,0,0.4)` |
| `--shadow-2` | `0 4px 8px rgba(20,20,30,0.10)` | `0 4px 8px rgba(0,0,0,0.5)` |
| `--shadow-3` | `0 8px 18px rgba(20,20,30,0.12)` | `0 8px 18px rgba(0,0,0,0.55)` |
| `--shadow-4` | `0 18px 40px rgba(20,20,30,0.16)` | `0 18px 40px rgba(0,0,0,0.6)` |
| `--shadow-5` | `0 32px 80px rgba(20,20,30,0.22)` | `0 32px 80px rgba(0,0,0,0.7)` |
| `--palette-glass-bg` | `color-mix(in srgb, var(--surface-1) 90%, transparent)` | `color-mix(in srgb, var(--surface-1) 82%, transparent)` |
| `--palette-glass-ring` | `rgba(20,20,30,0.1)` | `rgba(255,255,255,0.08)` |
| `--palette-glass-glow` | `rgba(255,255,255,0.5)` | `rgba(255,255,255,0.06)` |
| `--rail-machine` | `color-mix(in srgb, var(--ink-machine) 30%, transparent)` | `color-mix(in srgb, var(--ink-machine) 34%, transparent)` |
| **`--stroke-hairline`** NEW fork | `1px` | `1.5px` |
| **`--body-font-size`** NEW | `var(--text-base)` = 0.9375rem | `var(--text-md)` = 1rem |
| **`--tracking-body`** NEW | `0` | `0.008em` |
| **`--canvas-grain-opacity`** NEW | `0` | `0.035` |
| **`--canvas-grain-image`** NEW | `none` | _(see §4.4 — inline SVG data URI)_ |

Note on `--stroke-hairline`: currently defined **only** in the scale block (`:root`, line 54) as `1px`. This cutover moves it to per-room by adding it to the semantic blocks. The scale-block definition remains as a safe fallback for any scope where neither room block applies (e.g., `[data-theme="oracle"]`).

Note on `--ink-machine` and `--rail-machine`: values defined by machine-hand-hard-cutover.md (sibling #1). Carried here without change. Machine-hand's S0 slice adds them; Two Rooms S0 keeps them present in all three theme locations.

### 4.3 WCAG contrast table

Contrast ratios computed via WCAG 2.1 relative luminance formula. AA threshold: 4.5:1 (body text), 3:1 (large text / UI components).

**Press (dark `:root`):**

| Ink token | Hex | On canvas `#0e0e10` | On surface-1 `#161618` | Status |
|---|---|---|---|---|
| `--ink` | `#ededef` | 16.6:1 | 11.7:1 | AAA |
| `--ink-muted` | `#a3a3a8` | 7.6:1 | 5.3:1 | AA |
| `--ink-faint` | `#6f6f76` | 3.9:1 | 2.7:1 | **FAIL** (pre-existing) |
| `--ink-machine` | `#c4ccd6` | 12.8:1 | 9.0:1 | AAA |

**Study (`[data-theme="light"]`):**

| Ink token | Hex | On canvas `#faf8f3` | On surface-1 `#ffffff` | Status |
|---|---|---|---|---|
| `--ink` | `#1a1a1c` | 16.4:1 | 18.1:1 | AAA |
| `--ink-muted` | `#525258` | 7.3:1 | 8.0:1 | AA |
| `--ink-faint` | `#7a7a80` | 4.0:1 | 4.4:1 | **FAIL** for body (pre-existing) |
| `--ink-machine` | `#3c4a57` | 8.5:1 | 9.4:1 | AAA |

`--ink-faint` fails AA for body-sized text in both rooms. This is a pre-existing condition introduced before this spec — the values in `globals.css:134,170` are not changed here. A follow-up accessibility pass owns the fix. This spec documents the gap but does not widen it.

### 4.4 Canvas-wide grain (Press only)

The AppNav grain (`AppNav.module.css:29–37`) uses the following inline SVG at `opacity: 0.035`:

```
data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E
```

This spec reuses the same SVG at the same opacity for the canvas. The `stitchTiles="stitch"` attribute makes the tile seamlessly repeating; at 160×160px the browser rasterizes once and tiles. There is no per-frame animation — GPU composites a static bitmap. Promoting from ~240px rail to full viewport width does not materially change paint time.

The grain is applied via `body::before` using CSS custom properties. To keep the grain behind all body content without requiring `z-index` on every child element, `body` gets `isolation: isolate`. Within this stacking context, `z-index: -1` on the `::before` paints it above body's background-color but below all body content. `position: fixed` sizes it to the viewport.

```css
body {
  /* existing properties remain */
  isolation: isolate;  /* NEW: creates stacking context so ::before z-index:-1 is bounded */
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  opacity: var(--canvas-grain-opacity, 0);
  background-image: var(--canvas-grain-image, none);
}
```

In Study, `--canvas-grain-opacity: 0` makes the `::before` invisible — no paint cost. The browser may optimize away a zero-opacity fixed element entirely; even if not, it is a static composited layer with no layout impact.

### 4.5 Reader theme composition

The reader is a scoped area inside `MediaPaneBody`. Its theme is controlled independently via `profile.theme` (a `ReaderTheme`, persisted via `PATCH /api/me/reader-profile`). The CSS lives in `page.module.css:337–364` as `.readerThemeLight` and `.readerThemeDark` blocks with **hardcoded hex values** that intentionally bypass semantic tokens (documented at page.module.css:6–11: "independent of the app theme and must not be migrated to semantic tokens").

Two Rooms does not affect reader tokens. The only interaction:
- `--body-font-size` is applied to `body`. The reader's `.readerContentRoot` (page.module.css:298–305) overrides `font-size` with `var(--reader-font-size-px)`, so the room's body-font-size does not reach reader text.
- `--tracking-body: 0.008em` applies to body and is inherited. `.readerContentRoot` does not override `letter-spacing`, so reader text inherits 0.008em tracking in Press. This is 0.13px at 16px — imperceptible, beneficial for reversed type when reader is also in dark mode, neutral when reader is in light mode within a Press app.
- Canvas grain: `body::before` is `position: fixed` and covers the viewport. The reader's own `--reader-bg` background-color is set on `.readerThemeLight`/`.readerThemeDark` (page.module.css:338,348), which covers the reader viewport and paints above the grain. The grain is not visible inside the reader body.

They compose; they do not fight.

---

## 5. Data model / migration

None. No backend changes. No Alembic migration. No new tables.

---

## 6. API

None. The theme cookie (`nx-theme`) and `setAppearanceAction` are unchanged.

---

## 7. Frontend

### 7.1 `apps/web/src/app/globals.css`

**Scale block (`:root`, theme-invariant).** `--stroke-hairline: 1px` at line 54 **remains** as a fallback. No other changes to the scale block.

**Semantic dark defaults (`:root`, lines 123–155 — the Press block).** Add immediately after the existing last token in this block:

```css
/* Two Rooms — Press-specific typography + grain */
--stroke-hairline: 1.5px;
--body-font-size: var(--text-md);      /* 1rem — optical size up for reversed type */
--tracking-body: 0.008em;              /* tracking open a hair to counter halation */
--canvas-grain-opacity: 0.035;
--canvas-grain-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
/* machine-hand tokens (values from machine-hand-hard-cutover.md §4.3) */
--ink-machine: #c4ccd6;
--rail-machine: color-mix(in srgb, var(--ink-machine) 34%, transparent);
```

**`[data-theme="light"]` block (lines 159–191 — the Study block).** Add immediately after the existing last token, also change `--surface-canvas`:

```css
/* Study: warm canvas */
--surface-canvas: #faf8f3;  /* ✎ was #fafaf7 — matches brand-bg-light */
/* Two Rooms — Study-specific typography + grain */
--stroke-hairline: 1px;
--body-font-size: var(--text-base);    /* 0.9375rem — paper-tuned optical size */
--tracking-body: 0;
--canvas-grain-opacity: 0;
--canvas-grain-image: none;
/* machine-hand tokens */
--ink-machine: #3c4a57;
--rail-machine: color-mix(in srgb, var(--ink-machine) 30%, transparent);
```

**`@media (prefers-color-scheme: light) :root:not([data-theme])` block (lines 194–228 — the system-preference fallback).** Identical additions to the light block (same changes to `--surface-canvas` and same set of new tokens).

**`body` rule (lines 277–289).** Change `font-size` and add `letter-spacing` and `isolation`:

```css
body {
  height: 100%;
  overflow: hidden;
  margin: 0;
  padding: 0;
  font-family: var(--font-sans);
  font-size: var(--body-font-size);         /* ✎ was var(--text-base) */
  letter-spacing: var(--tracking-body);     /* NEW */
  line-height: var(--leading-relaxed);
  color: var(--ink);
  background-color: var(--surface-canvas);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  isolation: isolate;                       /* NEW: stacking context for ::before grain */
}
```

**`body::before` rule (new, add after the `body { }` block):**

```css
/* Canvas grain — Press only (--canvas-grain-opacity: 0 in Study) */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  opacity: var(--canvas-grain-opacity, 0);
  background-image: var(--canvas-grain-image, none);
}
```

### 7.2 `apps/web/src/components/appnav/AppNav.module.css`

**Delete** the grain pseudo-element block and its z-index scaffolding (lines 29–42 currently):

```css
/* DELETE — grain now owned by globals.css body::before in Press */
.rail::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.035;
  background-image: url("data:image/svg+xml,...");
}

.rail > * {
  position: relative;
  z-index: 1;
}
```

The rail's `position: relative; overflow: hidden` (lines 9–10) and the `linear-gradient` background (lines 13–18) are **kept**. The rail's visual character in Press comes from the canvas-wide grain (which covers it) plus its own gradient.

### 7.3 `apps/web/src/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody.tsx`

Change the presentation labels only. The radio `value` attributes (`"light"`, `"dark"`) and the `Selection` type are **untouched**. The `handleChange` logic is **untouched**.

```tsx
// BEFORE
<span className={styles.optionLabel}>Light</span>
<span className={styles.optionHint}>Cream paper, dark ink.</span>
...
<span className={styles.optionLabel}>Dark</span>
<span className={styles.optionHint}>Near-black canvas, warm ink.</span>
```

```tsx
// AFTER
<span className={styles.optionLabel}>Study</span>
<span className={styles.optionHint}>Warm paper, dark ink — day.</span>
...
<span className={styles.optionLabel}>Press</span>
<span className={styles.optionHint}>Near-black canvas, warm ink — night.</span>
```

### 7.4 `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx`

Update the `description` for the Appearance row to reflect the new labels:

```tsx
// BEFORE
description: "Light, dark, or follow your operating system.",

// AFTER
description: "Study, Press, or follow your operating system.",
```

---

## 8. Key decisions

- **D-1. Internal values stay `light`/`dark`; only presentation labels change.** The `AppTheme` type (`lib/theme/cookie.ts:3`), cookie name `nx-theme`, `data-theme` attribute values, and `setAppearanceAction` are all untouched. Renaming the cookie value from `"light"` to `"study"` would require a migration for existing users (clearing stale cookies) and touching N files. The editorial labels achieve the full expressive goal without any internal churn. *Rejected alternative:* rename internal values to `"study"/"press"`.

- **D-2. Body optical size in Press = `var(--text-md)` = 1rem (16px), not a larger step.** 1rem is the CSS default and widely used as the minimum comfortable body size for reversed type. Going to 1.0625rem (17px) risks reflow in tightly sized nav/toolbar components. 1rem is the correct compensation for the ~0.9375rem day size. *Rejected alternatives:* 1.0625rem (too much), 0.9375rem (no change, ignores irradiation).

- **D-3. Canvas grain via `body::before` + `isolation: isolate`, not a React component.** A React component in `RootLayout` would solve the stacking issue but adds a server-component boundary, a `div` to the DOM, and a coupling between the layout file and the theme CSS. CSS `body::before` with `isolation: isolate` is the same technique the AppNav uses at rail scope, promoted to canvas scope — pure CSS, zero JS, zero bundle cost. *Rejected alternative:* `<PressGrain />` React server component.

- **D-4. AppNav per-component grain deleted; canvas grain is sole owner.** Running two grain layers (AppNav's `::before` + canvas `::before`) in Press produces double-grain on the rail (~doubled opacity in the composited layer). One owner produces a consistent depth across the whole canvas. In Study, grain is editorially absent from both the rail and the canvas. *Rejected alternative:* keep AppNav grain and suppress it only in Study (adds a Study-specific override to AppNav.module.css rather than deleting).

- **D-5. `--stroke-hairline` forked per-room, not a new token.** Adding a `--stroke-rule` token alongside `--stroke-hairline` would require every consumer to switch to the new token name — a sweep across 8 CSS files. Forking `--stroke-hairline` itself gives all 8 existing callsites the correct room value automatically. The scale-block `1px` stays as a safe fallback for any scope (e.g., Oracle) that doesn't override it. *Rejected alternative:* introduce `--stroke-rule` as a distinct token.

- **D-6. Study canvas = `#faf8f3`, not `#fafaf7`.** `#faf8f3` is the value used by `brand.css` for `--brand-bg-light` (line 6) and by `page.module.css` for `--reader-bg` in the reader light theme (line 338). Using the same warm cream for the canvas aligns the app chrome with the brand identity and the reader's own light surface — a single paper feel. `#fafaf7` (current) has a slighter, cooler warm cast that is a mismatch against `#faf8f3` when the two appear adjacent (reader inside app). *Rejected alternative:* keep `#fafaf7`.

- **D-7. Grain opacity = 0.035 (matching AppNav legacy value).** The AppNav grain has shipped at 0.035 since its introduction with no visual complaints. This is calibrated to be subliminal — felt, not seen. Any higher reads as noise; lower is invisible on dark. *Rejected alternative:* 0.05 (visible, draws attention).

- **D-8. `--ink-faint` contrast gap is documented but not fixed.** Fixing `--ink-faint` to 4.5:1 requires brightening it in Press (e.g., to ~#818188) and darkening it in Study — a color change that touches navigation labels, timestamps, and placeholder text across the whole app. The correct fix warrants its own accessibility-focused spec. This spec does not widen the gap. *Rejected alternative:* fix in-band (deferred, documented in §4.3).

---

## 9. What dies (exhaustive deletion list)

1. **`AppNav.module.css` `.rail::before` grain rule** — lines 29–37, the entire `content: ""` → `background-image: url(...)` block.
2. **`AppNav.module.css` `.rail > *` z-index scaffold** — lines 39–42, the `position: relative; z-index: 1` that was required to lift content above the grain overlay.
3. **`globals.css` body `font-size: var(--text-base)`** — replaced by `font-size: var(--body-font-size)`.

That is the complete deletion list. Two Rooms adds tokens and one pseudo-element; it deletes two CSS rules from AppNav and one property from body.

---

## 10. Sibling cutovers and sequencing

- **Before #1 (machine-hand).** `--ink-machine` and `--rail-machine` must exist in globals.css before Two Rooms is deployed, because Two Rooms carries them in its theme blocks. If Two Rooms ships first (wrong order), those tokens are absent from `[data-theme="light"]` and the system-preference fallback → machine text fails in Study and system-preference-light. **Deploy #1 first, then Two Rooms.**

- **After #2 (running-journal).** Running heads and section openers use `border-bottom: var(--stroke-hairline) solid var(--edge-subtle)`. When Two Rooms forks `--stroke-hairline` to 1.5px in Press, those rules automatically gain the heavier weight — correct behavior, no change needed in running-journal.

- **No dependency on #4, #6, #7, #8, #9, #10.** Two Rooms is a pure token + settings-label change. It does not touch any pane, surface, or navigation component. Siblings that reference Study/Press in their target behaviors (e.g., machine-hand §2: "Both rooms hold") are consuming this spec's output; they have no build dependency on it deploying first.

---

## 11. Slices

All slices are independently buildable. Each has its own verification step.

### S0 — New room tokens in `globals.css`

Add the five new token groups (`--stroke-hairline`, `--body-font-size`, `--tracking-body`, `--canvas-grain-opacity`, `--canvas-grain-image`) to all three theme locations in `globals.css`. Also carry `--ink-machine`/`--rail-machine` (from machine-hand) in all three locations. Also change `--surface-canvas` in the light and system-preference blocks from `#fafaf7` to `#faf8f3`.

Do **not** yet change the body rule or add `body::before`.

*Verify:* `bun run typecheck` passes (no TS); `bun run lint` passes; a contrast-guard test (`twoRoomsCutover.guards.test.ts`, S3) parses `globals.css` and asserts the five new tokens are present in all three locations. Open the app in both Study and Press — no visible change yet (tokens exist but body and grain rule not wired up).

### S1 — Fork body defaults

Change `body { font-size }` from `var(--text-base)` to `var(--body-font-size)`, add `letter-spacing: var(--tracking-body)`, add `isolation: isolate` to the body rule.

*Verify:* `bun run build` (bundle within 104kB budget). In Press: devtools → computed styles on `body` → `font-size: 16px`, `letter-spacing: 0.008em`. In Study: `font-size: 15px`, `letter-spacing: 0px`. Run all FE tests: `bun run test --project=unit && bun run test --project=browser` — confirm all pass.

### S2 — Canvas grain + AppNav cleanup

Add the `body::before` grain rule to `globals.css`. Delete the `.rail::before` and `.rail > *` z-index rules from `AppNav.module.css`.

*Verify:* In Press: a subtle, even grain covers the entire viewport including the area behind the AppNav rail. The rail itself shows no double-grain. In Study: no grain. Toggle between rooms via Settings/Appearance — grain appears and disappears cleanly. Run browser tests: `bun run test --project=browser` — AppNav tests pass.

### S3 — Guard tests

Write `apps/web/src/lib/ui/twoRoomsCutover.guards.test.ts` (node project, `.test.ts`) with five assertions (see §13).

*Verify:* `bun run test --project=unit` passes. Intentionally break one token in `globals.css` — the guard fails, proving the gate is live.

### S4 — Settings labels

Update `SettingsAppearancePaneBody.tsx` (labels: Light→Study, Dark→Press, hint text) and `SettingsPaneBody.tsx` (description string).

*Verify:* Open `/settings/appearance` — the three options read "Study", "Press", "System". Select Study — app switches to light; select Press — dark with grain. The cookie value is still `nx-theme=light` or `nx-theme=dark` (inspect in devtools). Run the full FE suite.

---

## 12. Acceptance criteria

- **AC-1.** In Press, `body` computed `font-size` is 16px; in Study, 15px.
- **AC-2.** In Press, `body` computed `letter-spacing` is approx 0.13px (0.008em × 16px); in Study, 0px.
- **AC-3.** In Press, `--stroke-hairline` resolves to 1.5px; in Study, to 1px. A `var(--stroke-hairline) solid` border on `ResourceRow` measures 1.5px in Press (DevTools).
- **AC-4.** In Press, a subtle uniform grain is visible covering the entire viewport. No grain is visible in Study.
- **AC-5.** In Press, the AppNav rail shows grain sourced from the canvas layer (not a double-grain artifact). Switching to Study removes all grain from the rail.
- **AC-6.** `--surface-canvas` resolves to `#faf8f3` in Study and `#0e0e10` in Press.
- **AC-7.** `/settings/appearance` shows "Study", "Press", "System". Selecting each sets the right cookie value (`light`, `dark`, or deleted cookie) — unchanged from before.
- **AC-8.** The five new tokens (`--stroke-hairline` per-room, `--body-font-size`, `--tracking-body`, `--canvas-grain-opacity`, `--canvas-grain-image`) are present in all three theme locations (dark `:root`, `[data-theme="light"]`, `prefers-color-scheme: light` fallback).
- **AC-9.** `--ink-machine` and `--rail-machine` are present in all three theme locations with the values from machine-hand §4.3.
- **AC-10.** Reader body text does not change size when the app switches rooms (it has its own `var(--reader-font-size-px)` override). Reader body text inherits `letter-spacing: 0.008em` in Press (0.13px — intentional, unreset, as documented in §4.5); `.readerContentRoot` does not reset `letter-spacing` and this is the accepted state. Canvas grain is not visible inside the reader body (reader's `--reader-bg` background covers it).
- **AC-11.** Oracle routes (`/oracle/**`) are not materially affected. Oracle custom-property tokens (`--body-font-size`, `--tracking-body`, `--canvas-grain-*`) are not defined in the `[data-theme="oracle"]` block and do not drive oracle-specific CSS. Body-level `letter-spacing: 0.008em` (Press) is inherited by oracle elements without an explicit `letter-spacing` override; this is imperceptible and acceptable on the dark canvas. Canvas grain: oracle page surfaces set `background: var(--oracle-bg); min-height: 100%` (`.surface` in `oracle.module.css:1–7`). Since `body::before` with `z-index: -1` (within the `isolation: isolate` body stacking context) paints below all body children, the grain is occluded by oracle content backgrounds and is not visible inside oracle content areas. Verify in devtools on an oracle page in Press: oracle body text `letter-spacing` and absence of visible grain under content.
- **AC-12.** `bun run build` bundle size remains within 104kB gz first-load budget. CSS additions are < 1kB.

---

## 13. Negative gates

All checks are in `apps/web/src/lib/ui/twoRoomsCutover.guards.test.ts` (node unit project).

1. **Token presence — three locations.** Parse `apps/web/src/app/globals.css`. Assert `--body-font-size`, `--tracking-body`, `--stroke-hairline`, `--canvas-grain-opacity`, `--canvas-grain-image` appear at least once under each of: the dark `:root` semantic block, the `[data-theme="light"]` block, and the `@media (prefers-color-scheme: light) :root:not([data-theme])` block.

2. **No AppNav grain rule.** Assert `apps/web/src/components/appnav/AppNav.module.css` does not contain the string `feTurbulence` — the SVG turbulence filter has been deleted from the rail.

3. **Body rule uses token.** Assert `apps/web/src/app/globals.css` body block contains `font-size: var(--body-font-size)` and does not contain `font-size: var(--text-base)` as a standalone body rule (the scale-block definition `--text-base:` is fine; the direct body assignment must be gone).

4. **Study canvas value.** Assert `globals.css` `[data-theme="light"]` block contains `--surface-canvas: #faf8f3` and does not contain `--surface-canvas: #fafaf7` anywhere (the old value must be gone).

5. **Settings labels.** Assert `SettingsAppearancePaneBody.tsx` contains the strings `"Study"` and `"Press"` as visible label strings. Assert it does not contain the patterns `>Light<` or `>Dark<` (case-sensitive title-case search for text-node content). The radio `value` attributes remain `value="light"` and `value="dark"` (lowercase) — the guard must use case-sensitive title-case matching so those `value` attributes do not trigger a false positive.

---

## 14. Test plan

**Node unit (`.test.ts`, guard project):**
- `twoRoomsCutover.guards.test.ts` — five assertions above (§13).

**Browser (`.test.tsx`, Chromium project):**
- Extend `AppNav.test.tsx`: assert the rail `::before` has no `background-image` referencing `feTurbulence` (the style is now gone from the CSS); existing AppNav tests continue to pass without modification.
- Optional `SettingsAppearancePaneBody.test.tsx`: render the component, assert the radio option labels include "Study" and "Press". (The existing Appearance page has no test today; adding one here covers the label change and prevents regression.)

**Manual smoke (two browser tabs, one Study, one Press):**
- Font size: devtools computed on `<body>` in each room.
- Tracking: devtools computed `letter-spacing` on body.
- Stroke: inspect `ResourceRow` border width.
- Grain: visible check on viewport, especially at the seam between AppNav rail and main canvas.
- Reader: open a media item in Press; verify grain is not visible inside the reader body.
- Oracle: visit an oracle page in Press; verify oracle experience is not materially degraded by grain (imperceptible at 0.035).

**No e2e required.** Two Rooms is CSS tokens + one settings label. The absence of functional routing or data changes makes a Playwright test disproportionate.

---

## 15. Files

**Touched:**

| File | Change |
|---|---|
| `apps/web/src/app/globals.css` | Add 5 new tokens ×3 theme locations; fork `--stroke-hairline`; change `--surface-canvas` in light/system blocks; update `body` rule; add `body::before` rule |
| `apps/web/src/components/appnav/AppNav.module.css` | Delete `.rail::before` grain block + `.rail > *` z-index lines |
| `apps/web/src/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody.tsx` | Update two option label strings + hint strings |
| `apps/web/src/app/(authenticated)/settings/SettingsPaneBody.tsx` | Update description string |

**Created:**

| File | Purpose |
|---|---|
| `apps/web/src/lib/ui/twoRoomsCutover.guards.test.ts` | Five negative-gate assertions (§13) |

**Deleted:** None (changes are edits to existing files).

---

## 16. Risks

- **R1. `isolation: isolate` on body creates an unexpected stacking context.** Any descendant with `z-index: -1` that previously escaped to the root stacking context will now be clipped by the body context. Scan: `grep -r "z-index: -1\|z-index:-1" apps/web/src --include="*.css" --include="*.module.css"` — if any results are found, verify they are not relying on the root stacking context. At time of writing, no confirmed instances.

- **R2. Body font-size step causes layout overflow in tightly sized components.** Navigation items, table cells, and toolbar labels that were tuned to 15px may reflow or truncate at 16px in Press. Mitigation: all existing surfaces use `text-overflow: ellipsis` and `min-width: 0` defensively. The delta (1px / ~6.7%) is small enough that overflow is unlikely but must be verified in the browser smoke (§14).

- **R3. Machine-hand #1 ships after Two Rooms.** If Two Rooms deploys before #1, the `--ink-machine`/`--rail-machine` tokens in the Two Rooms theme blocks reference tokens that machine-hand S0 defines — but if S0 hasn't run yet, those tokens have no value. The tokens still exist in the globals.css blocks this spec adds; they just have no consumer yet (machine-hand's `MachineText.module.css` hasn't been created). So the risk is limited: no crash, no visual regression, `--ink-machine` is just an unused token. **Mitigation:** deploy #1 first (§10); if sequence is violated, the only consequence is `--ink-machine`/`--rail-machine` being declared without a consumer until #1 ships.

- **R4. Grain on Oracle.** The canvas grain covers Oracle pages too (Press body::before is page-wide). Oracle's strong `--oracle-bg: #14110f` and manuscript atmosphere might be affected by a ~3.5% grain overlay. At 0.035 opacity this is essentially invisible and adds texture appropriate to a Black Forest aesthetic. Acceptable, but verify once with a manual smoke of Oracle in Press.

- **R5. Reduced-motion preference.** The grain is static (no animation), so `prefers-reduced-motion` is not applicable. The grain is a texture, not motion.
