# Visual Foundation 1A — Hard Cutover

## 0. Summary

Replace the entire current design-token system, ship app-wide light/dark mode, and stand up a primitive component layer (`Button`, `Input`, `Card`, …) — all in one branch, no legacy names, no fallbacks, no aliases. The result is a direction-agnostic foundation: the eventual visual direction (Cabinet / Penguin / MoMA / etc.) becomes a value swap, not a rewiring exercise.

## 1. Context

This is Phase 1A of the visual rebuild discussed in chat. Phase 1B (slide-over chat, ghost gutter, document-style chat, citation system, contextual Cmd-K, context-chip rail, magazine login) builds on this foundation. Phase 2 picks the visual direction and replaces the placeholder values from this spec with real ones.

The current state, audited:
- 70 CSS module files; ~1,400 token references.
- 3 tokens used in CSS but **undefined** in `globals.css` (`--radius-sm`, `--color-bg-hover`, `--color-bg-active`) — silently broken today.
- ~88 hardcoded `8px` radii, 49 `6px`, 34 `999px`, plus 23 `4px`, 13 `10px`, 10 `12px`, others — no scale.
- ~80 ad-hoc `rgba()` colors, 77 hardcoded `font-weight` values, ~40 distinct `line-height` values, 24 distinct `letter-spacing` values.
- ~40 distinct ad-hoc button stylings across 56 component files; no `Button` primitive.
- App is dark-only outside the reader. Login/legal use a radial gradient tuned for dark only.
- Oracle (`(oracle)/*`) uses a scoped `[data-theme="oracle"]` on a child element. Works fine; will be preserved.
- Reader uses `.readerThemeLight` / `.readerThemeDark` classes with `--reader-*` tokens. Composes over the app theme. Will be preserved.

## 2. Goals

1. Replace the current token block with a complete, semantic token system covering color, typography, radius, spacing, motion, density, shadow, z-index. Light + dark values for every semantic color.
2. App-wide light/dark mode applied to `<html data-theme>`, persisted via cookie, FOUC-free at SSR, respecting `prefers-color-scheme` when no cookie is set.
3. Build a primitive component layer (`apps/web/src/components/ui/`) that subsumes every ad-hoc button, input, select, card, chip, kbd, toggle, separator, avatar, spinner, tabs, pill in the codebase.
4. Migrate **every** existing CSS module to the new tokens. Migrate **every** ad-hoc styled control to the primitive layer.
5. Reader theme keeps composing on top, unchanged in mechanism. Oracle theme keeps its scoped overlay, unchanged in mechanism.
6. Login, legal, terms, privacy gain light-mode support (utilitarian — visual polish is Phase 2).
7. The branch lands as one cutover with zero legacy artifacts: old token names gone, ad-hoc CSS classes gone, hardcoded values gone (except `--reader-*` and `--oracle-*` scoped overrides).

## 3. Non-goals

- The eventual visual direction (Cabinet / Penguin / etc.) — values in this spec are deliberately neutral placeholders; Phase 2 swaps them.
- Reader internal layout, typography choices for the reader column, or `reader_profile` schema changes — out of scope.
- Phase 1B patterns: slide-over chat, ghost gutter, citation hover-previews, context-chip rail, contextual Cmd-K, document-style chat, marketing/login redesign.
- Resolving the four reader open questions (paragraph spacing, hyphenation, justification, `focus_mode`).
- Backend API changes other than the appearance-pref persistence (cookie only — no DB schema change).
- Mobile-specific visual rework beyond what tokens already cover.
- Accessibility audit beyond WCAG AA contrast on the new tokens.
- Storybook or any visual-test harness beyond what already exists.
- Adding new web fonts. The `--font-serif` placeholder uses a system stack; Phase 2 picks the face.

## 4. Final state — target architecture

### 4.1 Token system

A single CSS file (`globals.css`) defines every token. Tokens split into:

- **Scale tokens** (theme-invariant): radius, spacing, type sizes, type leading/tracking, font weights, motion, density, z-index, layout. Live under `:root`.
- **Semantic tokens** (theme-variant): surface, ink, edge, accent, ring, success/warning/danger/info, shadow. Defined under `[data-theme="dark"]` and `[data-theme="light"]` with a `:root` default that mirrors dark for safety.
- **Highlight tokens** (preserved): `--highlight-yellow|green|blue|pink|purple` — unchanged.
- **Reader tokens** (preserved, scoped): `--reader-*` — defined in `media/[id]/page.module.css`, untouched.
- **Oracle tokens** (preserved, scoped): `--oracle-*` — defined under `[data-theme="oracle"]` in `globals.css`, untouched.

Naming convention is short and semantic (`--ink`, `--surface-1`, `--accent`), not descriptive (`--color-text-primary`). State suffixes are `-hover`, `-active`, `-muted`. Numeric levels (`-1`, `-2`, `-3`) denote elevation, not absolute scale.

### 4.2 Theme system

`<html data-theme="light|dark">` is the single source of truth.

- **Server**: root layout reads `nx-theme` cookie (values `light` | `dark`; missing = no attribute) and sets `data-theme` on `<html>`. No flash on subsequent loads.
- **First-load fallback (no cookie)**: a small inline script in `<head>` reads `prefers-color-scheme` and sets `data-theme` before paint. The CSS also uses `@media (prefers-color-scheme: light)` on `:root:not([data-theme])` so even with JS disabled the colors are correct.
- **Toggle**: `/settings/appearance` route writes the cookie via a Server Action and updates `<html data-theme>` immediately on the client.
- **Reader**: `.readerThemeLight` / `.readerThemeDark` classes continue to scope `--reader-*` overrides. Reader's user preference (`reader_profile.theme`) is independent of app theme.
- **Oracle**: a child element carries `data-theme="oracle"`. Because it's on a descendant, it wins specificity for its subtree. Oracle's `--oracle-*` tokens are independent of `--surface-*` / `--ink-*` and don't react to app theme. Oracle stays as it is today.

### 4.3 Primitive component layer

Lives at `apps/web/src/components/ui/`. Existing files (`Dialog`, `ActionMenu`, `StatusPill`, `SurfaceHeader`, `ContextRow`, `SectionCard`, `MarkdownMessage`, `HighlightSnippet`, `AppList`, `InlineCitations`) keep their location. New primitives ship alongside.

API style: typed React component, variant + size props (no class-soup), CSS Modules. No `class-variance-authority` dependency — hand-rolled variant→className map.

The thirteen primitives shipped in 1A:

| Primitive  | Variants                                          | Sizes                | Replaces                                                                                                              |
| ---------- | ------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Button     | `primary` `secondary` `ghost` `danger` `pill`     | `sm` `md` `lg`       | `.sendBtn`, `.searchButton`, `.subscribeButton`, `.primaryButton`, `.askButton`, `.unsubscribeButton`, `.iconButton`, ~30+ more |
| Input      | `default` `bare`                                  | `sm` `md` `lg`       | `.searchInput`, `.input` (multiple files), `.composerInput` (`bare`)                                                    |
| Textarea   | `default` `bare` (auto-grow option)               | `sm` `md` `lg`       | textarea uses in `AddContentTray`, composer textarea (`bare`)                                                           |
| Select     | `default`                                         | `sm` `md` `lg`       | `.settingsSelect`, `.webSearchSelect`, `.select` (settings/reader)                                                       |
| Card       | `flat` `bordered` `elevated`                      | padding `sm` `md` `lg` | search result row, evidence cards, generic surfaces                                                                   |
| Pill       | `neutral` `info` `success` `warning` `danger` `accent` `subtle`; shape `pill` `square` | `sm` `md` | `StatusPill` (refactored), evidence badges, owner/role badges                                                          |
| Chip       | with `removable`, `selected`, leading-icon slot   | `sm` `md`            | `ContextChips`, `ConversationScopeChip`, attached-context tags                                                         |
| Kbd        | `ghost` `bordered`                                | `sm` `md`            | `.shortcutHint` and inline kbd usage                                                                                   |
| Toggle     | accessible checkbox-as-switch                     | `sm` `md`            | `.keyModeToggle`, future toggles                                                                                       |
| Separator  | `horizontal` `vertical`                           | n/a                  | ActionMenu `.separator`, ad-hoc dividers                                                                               |
| Avatar     | image src or initials, color seed                 | `sm` `md` `lg`       | `LibraryMembershipPanel` `.colorDot`, future use                                                                       |
| Spinner    | CSS-only pulse                                    | `sm` `md` `lg`       | `.pending` animation in MessageRow, future loading                                                                     |
| Tabs       | tabs container + trigger; segmented variant       | `sm` `md`            | `AddContentTray` mode tabs, future tabbed surfaces                                                                     |

`Dialog`, `ActionMenu`, `SurfaceHeader`, `ContextRow`, `SectionCard` are reskinned to consume the new tokens but keep their public APIs. `StatusPill` is renamed and reabsorbed as `Pill`.

### 4.4 File layout

```
apps/web/src/
  app/
    globals.css                    -- token block fully rewritten
    layout.tsx                     -- adds SSR theme attr + blocking script
    (authenticated)/
      settings/
        appearance/                -- new route
          page.tsx
          SettingsAppearancePaneBody.tsx
          page.module.css
  components/
    ui/
      Button.tsx + Button.module.css           -- new
      Input.tsx + Input.module.css             -- new
      Textarea.tsx + Textarea.module.css       -- new
      Select.tsx + Select.module.css           -- new
      Card.tsx + Card.module.css               -- new
      Chip.tsx + Chip.module.css               -- new
      Kbd.tsx + Kbd.module.css                 -- new
      Toggle.tsx + Toggle.module.css           -- new
      Separator.tsx + Separator.module.css     -- new
      Avatar.tsx + Avatar.module.css           -- new
      Spinner.tsx + Spinner.module.css         -- new
      Tabs.tsx + Tabs.module.css               -- new
      Pill.tsx + Pill.module.css               -- replaces StatusPill (rename + extend)
      Dialog.tsx + .module.css                 -- token sweep only
      ActionMenu.tsx + .module.css             -- token sweep only
      SurfaceHeader.tsx + .module.css          -- token sweep only
      ContextRow.tsx + .module.css             -- token sweep only
      SectionCard.tsx + .module.css            -- token sweep only
      index.ts                                 -- barrel export
  lib/
    theme/
      AppThemeProvider.tsx                     -- client provider for theme actions
      serverTheme.ts                           -- read cookie at SSR
      setThemeAction.ts                        -- Server Action: write cookie
      types.ts                                 -- AppTheme = "light" | "dark"
```

## 5. Hard rules

1. **No legacy token names.** `--color-bg`, `--color-bg-secondary`, `--color-bg-tertiary`, `--color-surface`, `--color-text*`, `--color-accent*`, `--color-border*`, `--color-success/warning/error`, `--shadow-sm/md/lg`, `--transition-fast/normal` — all gone after this lands. `grep` for any of them returns zero hits across `apps/web/src/`.
2. **No ad-hoc button/input CSS.** No `.sendBtn`, `.searchButton`, `.subscribeButton`, `.primaryButton`, `.askButton`, `.modeTab`, `.colorButton`, etc. survive. Every `<button>` in `apps/web/src/components/` and `apps/web/src/app/` is either the `Button` primitive, a `Toggle`, an internal element of a primitive, or a documented exception.
3. **No hardcoded colors in `*.module.css`** outside `--reader-*`/`--oracle-*` scoped blocks and the `--highlight-*` definitions. Every color goes through a token. (Allow-list: PDF.js viewer overrides if absolutely necessary; document them.)
4. **No hardcoded `border-radius`.** Every radius uses `--radius-{xs|sm|md|lg|xl|2xl|full}`.
5. **No hardcoded `font-size`, `font-weight`, `line-height`, or `letter-spacing`** in `*.module.css`. Use `--text-*`, `--weight-*`, `--leading-*`, `--tracking-*`. Reader content area is exempt (it has its own user-driven values).
6. **No hardcoded `box-shadow`.** Every shadow uses `--shadow-{1..5}`.
7. **No hardcoded transitions.** Every transition pulls from `--ease-*` and `--duration-*`.
8. **Light mode is mandatory on every route.** Including login, legal, terms, privacy. No "we'll fix it in Phase 2" exceptions for tokens; visual polish for the marketing surface is fine to defer.
9. **FOUC-free.** First paint after navigation must use the right theme. Verified by manual smoke test (DevTools throttling + cookie set + reload).
10. **WCAG AA minimum.** Documented contrast pairs in §6.1. Every `ink`/`surface` and `ink-on-accent`/`accent` pair meets AA at minimum.
11. **`prefers-reduced-motion: reduce`** collapses every motion duration to `0ms` via media query override. Done globally — components don't need to opt in.
12. **CSS Modules stays.** No Tailwind, no CSS-in-JS, no Vanilla Extract.
13. **No new runtime dependencies** for the primitive layer. Hand-roll variant logic.
14. **Reader and Oracle scopes preserved verbatim.** Their CSS surfaces are not re-tokenized in 1A beyond consuming new scale tokens (radius/spacing/text). Their color/font tokens stay untouched.

## 6. Token sheet

Concrete values. Direction-pass replaces semantic-color values; everything else is permanent.

### 6.1 Color (semantic, theme-variant)

**Dark (default):**

| Token              | Value                            | Notes                                       |
| ------------------ | -------------------------------- | ------------------------------------------- |
| `--surface-canvas` | `#0e0e10`                        | page background                             |
| `--surface-1`      | `#161618`                        | pane / card                                 |
| `--surface-2`      | `#1c1c1f`                        | popover, dropdown                           |
| `--surface-3`      | `#23232a`                        | dialog, command palette                     |
| `--surface-hover`  | `#1f1f23`                        |                                             |
| `--surface-active` | `#2a2a2f`                        |                                             |
| `--surface-sunken` | `#0a0a0c`                        | inset (input bg)                            |
| `--ink`            | `#ededef`                        | AAA on canvas                               |
| `--ink-muted`      | `#a3a3a8`                        | AA on canvas                                |
| `--ink-faint`      | `#6f6f76`                        | AA-large only; meta text, hints             |
| `--ink-on-accent`  | `#0e0e10`                        | text on accent fill                         |
| `--edge`           | `#2c2c30`                        | default border                              |
| `--edge-subtle`    | `#1f1f23`                        | hairline                                    |
| `--edge-strong`    | `#44444a`                        | emphasis                                    |
| `--accent`         | `#c4a472`                        | placeholder warm-tan; Phase 2 swaps         |
| `--accent-hover`   | `#d4b687`                        |                                             |
| `--accent-active`  | `#b8965f`                        |                                             |
| `--accent-muted`   | `rgba(196, 164, 114, 0.16)`      | translucent fill (selection bg, etc.)       |
| `--ring`           | `rgba(196, 164, 114, 0.55)`      | focus outline                               |
| `--success`        | `#6ec07a`                        |                                             |
| `--warning`        | `#d4b066`                        |                                             |
| `--danger`         | `#d96a73`                        |                                             |
| `--info`           | `#7ea3c5`                        |                                             |

**Light:**

| Token              | Value                            | Notes                            |
| ------------------ | -------------------------------- | -------------------------------- |
| `--surface-canvas` | `#fafaf7`                        | warm cream                       |
| `--surface-1`      | `#ffffff`                        |                                  |
| `--surface-2`      | `#f4f4f0`                        |                                  |
| `--surface-3`      | `#ededea`                        |                                  |
| `--surface-hover`  | `#f0f0ec`                        |                                  |
| `--surface-active` | `#e6e6e1`                        |                                  |
| `--surface-sunken` | `#f1f1ed`                        |                                  |
| `--ink`            | `#1a1a1c`                        | AAA on canvas                    |
| `--ink-muted`      | `#525258`                        | AA                               |
| `--ink-faint`      | `#7a7a80`                        | AA-large only                    |
| `--ink-on-accent`  | `#fafaf7`                        |                                  |
| `--edge`           | `#d4d4cf`                        |                                  |
| `--edge-subtle`    | `#e8e8e3`                        |                                  |
| `--edge-strong`    | `#87878d`                        |                                  |
| `--accent`         | `#7d5e35`                        | placeholder; Phase 2 swaps       |
| `--accent-hover`   | `#634a29`                        |                                  |
| `--accent-active`  | `#4a371d`                        |                                  |
| `--accent-muted`   | `rgba(125, 94, 53, 0.12)`        |                                  |
| `--ring`           | `rgba(125, 94, 53, 0.45)`        |                                  |
| `--success`        | `#2f7a3e`                        |                                  |
| `--warning`        | `#8a6618`                        |                                  |
| `--danger`         | `#a83a44`                        |                                  |
| `--info`           | `#3b6b8f`                        |                                  |

**Highlight tokens** (theme-invariant — fluorescent inks read on both):

```
--highlight-yellow:  rgba(255, 235, 59, 0.40);
--highlight-green:   rgba(76, 175, 80, 0.35);
--highlight-blue:    rgba(33, 150, 243, 0.35);
--highlight-pink:    rgba(233, 30, 99, 0.35);
--highlight-purple:  rgba(156, 39, 176, 0.35);
```
(Slightly lower opacities than today's 0.7–0.8 to read better on light mode without losing dark-mode legibility. If reader testing shows insufficient contrast on dark, revisit.)

**Contrast pairs (WCAG check, dark):**

- `--ink` on `--surface-canvas`: `#ededef` on `#0e0e10` → 16.4 : 1 (AAA)
- `--ink-muted` on `--surface-canvas`: 7.4 : 1 (AAA)
- `--ink-faint` on `--surface-canvas`: 4.6 : 1 (AA)
- `--ink-on-accent` on `--accent`: `#0e0e10` on `#c4a472` → 9.7 : 1 (AAA)

**Contrast pairs (WCAG check, light):**

- `--ink` on `--surface-canvas`: `#1a1a1c` on `#fafaf7` → 16.0 : 1 (AAA)
- `--ink-muted` on `--surface-canvas`: 7.7 : 1 (AAA)
- `--ink-faint` on `--surface-canvas`: 4.5 : 1 (AA-large; OK for meta only)
- `--ink-on-accent` on `--accent`: `#fafaf7` on `#7d5e35` → 7.0 : 1 (AAA)

(Implementation pass verifies these with a script; placeholder values may shift ±0.5 to lock in AA.)

### 6.2 Typography

**Family:**
```
--font-sans:  var(--font-inter), ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
--font-serif: ui-serif, Charter, Georgia, "Times New Roman", Times, serif;
--font-mono:  var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
```

**Size scale:**
```
--text-xs:        0.75rem;    /* 12px - labels, kbd, meta */
--text-sm:        0.8125rem;  /* 13px - secondary UI */
--text-base:      0.9375rem;  /* 15px - app body */
--text-md:        1rem;       /* 16px - default reader floor */
--text-lg:        1.125rem;   /* 18px - subheads */
--text-xl:        1.25rem;    /* 20px - section titles */
--text-2xl:       1.5rem;     /* 24px - page titles */
--text-3xl:       1.875rem;   /* 30px - hero */
--text-display-1: 2.5rem;     /* 40px - marketing display */
--text-display-2: 3.5rem;     /* 56px - marketing hero */
```

**Leading (line-height, unitless):**
```
--leading-tight:    1.2;
--leading-snug:     1.35;
--leading-normal:   1.5;
--leading-relaxed:  1.6;
--leading-loose:    1.75;
```

**Tracking:**
```
--tracking-tight:    -0.02em;
--tracking-normal:   0;
--tracking-wide:     0.02em;
--tracking-wider:    0.04em;     /* small caps / labels */
--tracking-widest:   0.08em;
```

**Weight:**
```
--weight-regular:  400;
--weight-medium:   500;
--weight-semibold: 600;
--weight-bold:     700;
```

(The reader column overrides size and leading via its own `--reader-*` properties — unchanged.)

### 6.3 Radius

```
--radius-xs:   2px;     /* tiny chips, swatches */
--radius-sm:   4px;     /* badges, kbd */
--radius-md:   6px;     /* small button, list row */
--radius-lg:   8px;     /* default surface, card */
--radius-xl:   12px;    /* dialog */
--radius-2xl:  16px;    /* composer shell */
--radius-full: 999px;   /* pills, circular avatars */
```

Migration mapping (every hardcoded value):
- `2px → --radius-xs`
- `4px → --radius-sm`
- `6px → --radius-md`
- `8px → --radius-lg`
- `9px, 10px → --radius-lg` (snap down)
- `12px → --radius-xl`
- `14px → --radius-xl` (snap down)
- `16px, 18px → --radius-2xl`
- `999px → --radius-full`

### 6.4 Spacing

```
--space-0:   0;
--space-1:   0.25rem;   /* 4px */
--space-2:   0.5rem;    /* 8px */
--space-3:   0.75rem;   /* 12px */
--space-4:   1rem;      /* 16px */
--space-5:   1.25rem;   /* 20px */
--space-6:   1.5rem;    /* 24px */
--space-7:   1.75rem;   /* 28px - was missing */
--space-8:   2rem;      /* 32px */
--space-10:  2.5rem;    /* 40px */
--space-12:  3rem;      /* 48px */
--space-16:  4rem;      /* 64px */
--space-20:  5rem;      /* 80px */
--space-24:  6rem;      /* 96px */
```

### 6.5 Motion

```
--ease-snap:   cubic-bezier(0.2, 0, 0, 1);     /* decisive, exit-fast */
--ease-glide:  cubic-bezier(0.4, 0, 0.2, 1);   /* default ease-in-out */
--ease-bloom:  cubic-bezier(0.16, 1, 0.3, 1);  /* gentle bounce-out */

--duration-instant:  80ms;
--duration-fast:     150ms;
--duration-base:     220ms;
--duration-slow:     360ms;
--duration-deliberate: 600ms;  /* sheet/modal mounts */
```

Reduced-motion override (in `globals.css`):
```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-instant: 0ms;
    --duration-fast: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
    --duration-deliberate: 0ms;
  }
}
```

### 6.6 Density / control sizing

```
--size-xs:  24px;   /* compact icon button */
--size-sm:  28px;   /* small button, kbd */
--size-md:  32px;   /* default icon button, dense input */
--size-lg:  36px;   /* default button, default input */
--size-xl:  44px;   /* touch-target floor, large CTA */
--size-2xl: 52px;   /* hero CTA */
```

### 6.7 Shadow

Theme-aware (different color/opacity per theme). Five elevation levels.

**Dark:**
```
--shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
--shadow-2: 0 4px 8px rgba(0, 0, 0, 0.5);
--shadow-3: 0 8px 18px rgba(0, 0, 0, 0.55);
--shadow-4: 0 18px 40px rgba(0, 0, 0, 0.6);
--shadow-5: 0 32px 80px rgba(0, 0, 0, 0.7);
```

**Light:**
```
--shadow-1: 0 1px 2px rgba(20, 20, 30, 0.06);
--shadow-2: 0 4px 8px rgba(20, 20, 30, 0.10);
--shadow-3: 0 8px 18px rgba(20, 20, 30, 0.12);
--shadow-4: 0 18px 40px rgba(20, 20, 30, 0.16);
--shadow-5: 0 32px 80px rgba(20, 20, 30, 0.22);
```

### 6.8 Z-index

```
--z-base:    0;
--z-raised:  10;     /* sticky headers */
--z-overlay: 100;    /* dropdowns, popovers */
--z-modal:   1000;   /* dialogs, sheets */
--z-toast:   10000;  /* notifications */
```

### 6.9 Layout (preserved verbatim)

```
--navbar-width: 240px;
--navbar-collapsed-width: 48px;
--tabsbar-height: 40px;
--mobile-bottom-nav-height: 64px;
--pane-min-width: 320px;
--pane-default-width: 480px;
--pane-max-width: 1400px;
--resize-handle-width: 8px;
--content-max-width: 700px;
```

## 7. Theme architecture (concrete)

### 7.1 SSR + cookie

Cookie name: `nx-theme`. Values: `light` | `dark`. Path: `/`. Max-Age: 31_536_000s (1 year). SameSite=Lax. Secure in production.

`apps/web/src/lib/theme/serverTheme.ts`:
```ts
import { cookies } from "next/headers";

export type AppTheme = "light" | "dark";

export async function readThemeCookie(): Promise<AppTheme | null> {
  const c = (await cookies()).get("nx-theme")?.value;
  return c === "light" || c === "dark" ? c : null;
}
```

`apps/web/src/app/layout.tsx`:
```tsx
const theme = await readThemeCookie();
return (
  <html lang="en" data-theme={theme ?? undefined} className={...fonts}>
    <head>
      <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
    </head>
    <body>...</body>
  </html>
);
```

### 7.2 Blocking script (first-load fallback)

Inlined in `<head>` before any paint. Reads cookie + system pref:

```js
(function () {
  try {
    var c = document.cookie.match(/(?:^|;\s*)nx-theme=(light|dark)/);
    var t = c ? c[1]
              : (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", t);
  } catch (_) {}
})();
```

CSS belt-and-suspenders for no-JS / no-cookie:
```css
:root, [data-theme="dark"] { /* dark vars */ }
[data-theme="light"]       { /* light vars */ }
@media (prefers-color-scheme: light) {
  :root:not([data-theme])  { /* light vars */ }
}
```

### 7.3 Server Action for toggling

`apps/web/src/lib/theme/setThemeAction.ts`:
```ts
"use server";
import { cookies } from "next/headers";

export async function setThemeAction(theme: "light" | "dark") {
  (await cookies()).set("nx-theme", theme, {
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
```

`AppThemeProvider` client wraps this action and also flips `document.documentElement.dataset.theme` immediately so the UI updates without waiting for revalidation.

### 7.4 Reader composition (unchanged)

The reader column already applies `.readerThemeLight` / `.readerThemeDark` class to its content root, scoping `--reader-*` overrides. This keeps working — those classes consume the new `--text-*`, `--leading-*`, `--radius-*` scale tokens but keep their own color tokens. Reader's user-facing theme picker is independent of the app theme picker; users can have light app + dark reader or vice versa.

### 7.5 Oracle scope (unchanged)

`[data-theme="oracle"]` is applied to a `<div>` inside `(oracle)` route group's pane bodies. Its CSS variables are the `--oracle-*` namespace; they don't react to app-theme changes. Oracle stays visually identical.

### 7.6 Login / legal / terms / privacy

These routes live at root (outside `(authenticated)`). They inherit the same `<html data-theme>` from the root layout. Their stylesheets are migrated to use the new tokens — meaning they'll look bare in 1A (today's radial-blue gradient is removed). Phase 2 styles them properly.

## 8. Primitive components (concrete API surface)

### 8.1 Button

```tsx
type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "pill";
  size?: "sm" | "md" | "lg";
  iconOnly?: boolean;          // squares the button at the size, removes padding
  loading?: boolean;           // shows spinner, disables
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  asChild?: boolean;           // render-as: useful for <Link>
} & ButtonHTMLAttributes<HTMLButtonElement>;
```

Defaults: `variant="primary"`, `size="md"`. Replaces ~40 ad-hoc button classes (full list in §9.4).

### 8.2 Input / Textarea / Select

Standard form props passthrough. `variant="bare"` strips border + bg for use inside container shells (e.g. composer). `Textarea` adds `autoGrow`, `minRows`, `maxRows`.

`Select` wraps native `<select>`. (A combobox/listbox primitive is deferred to Phase 1B — no current consumer needs it.)

### 8.3 Card

```tsx
type CardProps = {
  variant?: "flat" | "bordered" | "elevated";  // bordered is default
  padding?: "none" | "sm" | "md" | "lg";       // md is default
  asChild?: boolean;
} & HTMLAttributes<HTMLDivElement>;
```

`SectionCard` recomposes as `<Card><CardHeader/><CardBody/></Card>`.

### 8.4 Pill

```tsx
type PillProps = {
  tone?: "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "subtle";
  shape?: "pill" | "square";  // pill = radius-full, square = radius-sm
  size?: "sm" | "md";
  uppercase?: boolean;        // default true for status-like uses
} & HTMLAttributes<HTMLSpanElement>;
```

`StatusPill` import sites are codemodded to `Pill` with the equivalent tone.

### 8.5 Chip

```tsx
type ChipProps = {
  size?: "sm" | "md";
  selected?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  leadingIcon?: ReactNode;     // inc. color swatch
  truncate?: boolean;
} & HTMLAttributes<HTMLDivElement>;
```

### 8.6 Kbd, Toggle, Separator, Avatar, Spinner, Tabs

Prop surfaces are simple — variant/size/state. Spec's 4-line summary suffices; finalised in implementation.

### 8.7 Existing primitives (token sweep only)

`Dialog`, `ActionMenu`, `SurfaceHeader`, `ContextRow`, `SectionCard`, `MarkdownMessage`, `HighlightSnippet`, `AppList`, `InlineCitations` — public APIs unchanged; their `.module.css` files are rewritten to consume new tokens.

## 9. Files

### 9.1 New files (~28)

- `apps/web/src/lib/theme/{AppThemeProvider.tsx,serverTheme.ts,setThemeAction.ts,types.ts}` (4)
- `apps/web/src/components/ui/{Button,Input,Textarea,Select,Card,Pill,Chip,Kbd,Toggle,Separator,Avatar,Spinner,Tabs}.{tsx,module.css}` (26)
- `apps/web/src/components/ui/index.ts` (1 — barrel)
- `apps/web/src/app/(authenticated)/settings/appearance/{page.tsx,SettingsAppearancePaneBody.tsx,page.module.css}` (3)

### 9.2 Heavily rewritten (~5)

- `apps/web/src/app/globals.css` — full token block replaced.
- `apps/web/src/app/layout.tsx` — SSR theme + blocking script.
- `apps/web/src/app/login/{page.module.css,LoginPageClient.tsx?}` — token sweep + light-mode support.
- `apps/web/src/app/legal.module.css` — token sweep + light-mode.
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` — register `appearance` pane.

### 9.3 Migrated (CSS-module token swap, ~70 files)

Every `*.module.css` referencing any old token name. The full enumerated list is generated from the audit; I'll commit it as `docs/visual-foundation-1a-migration-checklist.md` at implementation time so PR review can tick them off. Notable files (not exhaustive):

`apps/web/src/components/{Navbar,ChatComposer,CommandPalette,SelectionPopover,AddContentTray,AnchoredSecondaryPane,ConversationContextPane,GlobalPlayerFooter,HtmlRenderer,LibraryEditDialog,LibraryMembershipPanel,LibraryTargetPicker,PdfReader}.module.css`,
`apps/web/src/components/chat/{ChatSurface,ContextChips,ConversationScopeChip,MessageRow,QuoteChatSheet,ReaderAssistantPane}.module.css`,
`apps/web/src/components/feedback/*.module.css`,
`apps/web/src/components/notes/*.module.css`,
`apps/web/src/components/sortable/*.module.css`,
`apps/web/src/components/contributors/*.module.css`,
`apps/web/src/components/search/*.module.css`,
`apps/web/src/components/workspace/{PaneShell,WorkspaceHost,WorkspacePaneStrip}.module.css`,
`apps/web/src/components/ui/{Dialog,ActionMenu,StatusPill,SurfaceHeader,ContextRow,SectionCard,MarkdownMessage,HighlightSnippet,AppList,InlineCitations}.module.css`,
`apps/web/src/app/(authenticated)/**/*.module.css` (libraries, media, conversations, notes, pages, daily, search, browse, podcasts, authors, settings),
`apps/web/src/app/(oracle)/{OracleShell,oracle/*}.module.css` (scale tokens only — colors stay).

### 9.4 Migrated (component refactors — ad-hoc → primitive, ~56 files)

Concretely: every `.tsx` containing a `<button>` styled by an ad-hoc class is refactored to use the `Button` primitive; same for `<input>`, `<textarea>`, `<select>`. List is generated from the audit. Hot spots:

- `Navbar.tsx`, `ChatComposer.tsx`, `AddContentTray.tsx`, `SelectionPopover.tsx`, `CommandPalette.tsx`, `LibraryEditDialog.tsx`, `LibraryMembershipPanel.tsx`, `GlobalPlayerFooter.tsx`, `PdfReader.tsx` (header buttons only — viewer chrome is exempt where pdfjs owns it).
- `chat/{ChatSurface,ChatComposer,ContextChips,ConversationScopeChip,MessageRow,QuoteChatSheet,ReaderAssistantPane}.tsx`.
- `notes/*.tsx`, `search/*.tsx`, `sortable/*.tsx`, `feedback/*.tsx`, `contributors/*.tsx`.
- `app/(authenticated)/**/*.tsx` — every settings page, every list/detail body.
- `app/login/LoginPageClient.tsx` — provider buttons → `Button` with brand-color slot.
- `app/(oracle)/oracle/*.tsx` — Oracle pages keep their bespoke chrome but shared button-shaped affordances move to `Button` (the Oracle theme overrides Button's tokens via `[data-theme="oracle"]` scope).

### 9.5 Deleted

- `StatusPill.tsx` and `StatusPill.module.css` (replaced by `Pill`); imports codemodded.
- Every ad-hoc CSS class for buttons/inputs/selects in the migrated `.module.css` files. Each migration PR removes the dead class along with its consumer.
- Old token names in `globals.css`.

## 10. Migration order (within the 1A branch)

Do **not** ship 1A in chunks. The branch is one cutover, but for reviewability commits are grouped:

1. **Tokens + theme plumbing.** Rewrite `globals.css`, add `lib/theme/*`, add SSR script + cookie, add `/settings/appearance` route. App is broken until step 4 finishes (every CSS module is referencing old names). This commit is "scaffolding only" and is not visually exercised.
2. **Primitive layer.** Build all 13 new primitives + reskin existing 5. Tested in isolation. Still not consumed by the app.
3. **Existing primitives — token sweep.** `Dialog`, `ActionMenu`, etc.'s `.module.css` migrate to new tokens. App still broken (most components downstream still reference old tokens).
4. **Component CSS migration sweep.** Every `*.module.css` listed in §9.3 swapped to new tokens. Now app compiles and renders again, but ad-hoc button stylings are still in place.
5. **Component primitive migration.** Every component listed in §9.4 swapped to primitives. Ad-hoc classes deleted as their last consumer migrates.
6. **Reader and Oracle scoped sweeps.** Reader's `.readerThemeLight/Dark` tokens stay; only scale tokens (radius, text, leading) migrate. Oracle gets the same light treatment.
7. **Light-mode polish on auth/legal.** Strip the radial gradient from login. Make terms/privacy theme-aware. Acceptance criteria — they look "fine" in both themes, not "good." Visual polish is Phase 2.
8. **Tests + screenshots.** Update or regenerate. Spot-check; do not blanket-accept regenerated artifacts.

Step 1–2 can happen in parallel; everything from step 4 onward is serial-ish but areas are independent (e.g., notes vs. chat) and can be parallelized within the branch.

## 11. Acceptance criteria

Hard gates — every one must pass before the branch merges.

1. `grep -r "var(--color-bg" apps/web/src/` returns zero hits. Same for every other old token name (`--color-text*`, `--color-accent*`, `--color-border*`, `--color-success/warning/error`, `--color-surface*`, `--shadow-sm/md/lg`, `--transition-fast/normal`).
2. `grep -rE "border-radius:\s*[0-9]" apps/web/src/` returns zero hits in `*.module.css` (excluding scrollbar styles in `globals.css`).
3. `grep -rE "font-size:\s*(0\.|[0-9]+(\.[0-9]+)?(rem|px|em))" apps/web/src/` returns zero hits in `*.module.css` outside the reader scope and `globals.css`.
4. `grep -rE "font-weight:\s*[0-9]" apps/web/src/` returns zero hits in `*.module.css` outside `globals.css`.
5. `grep -rE "rgba?\(" apps/web/src/` only matches: `globals.css`, the `--reader-*` block in `media/[id]/page.module.css`, the `--oracle-*` block, the `--highlight-*` block, and a documented allow-list.
6. `apps/web/src/components/ui/` exports every primitive listed in §4.3.
7. Every primitive has a unit test covering: render, all variants, all sizes, disabled, focus-visible. Tests pass.
8. `<button>` outside `components/ui/` only appears in: (a) primitive consumers (`<Button>`), (b) documented exceptions (PDF.js internals; Oracle ornament if any), (c) third-party-controlled DOM. Audit-able via `grep` + manual review.
9. Light mode renders without missing colors on every authenticated route, on `/login`, `/privacy`, `/terms`. Verified by manual smoke test.
10. Theme toggle in `/settings/appearance` switches `<html data-theme>` immediately and persists across reload.
11. With cookie set, no FOUC observed in DevTools (slow 3G + cache disabled). Screenshot the trace.
12. With no cookie, system preference applies; switching system preference flips theme on next reload (or instantly via `matchMedia` listener — bonus).
13. `prefers-reduced-motion: reduce` set in DevTools → animations are 0ms; verified by toggling and observing `transition` / `animation` durations.
14. Reader pages render with `--reader-*` overrides intact; reader theme picker still works; reader is visually unchanged from before the cutover.
15. Oracle pages render visually unchanged.
16. Existing screenshot tests in `apps/web/src/__tests__` and `apps/web/src/components/__screenshots__` are regenerated; CI passes.
17. `npm run typecheck` (or equivalent) passes.
18. `npm run lint` passes with no new warnings, no inline disables.
19. Manual contrast check on the new tokens: `--ink`, `--ink-muted` on `--surface-canvas`, and `--ink-on-accent` on `--accent` meet WCAG AA in both themes. Documented in PR.

## 12. Key decisions (resolved)

1. **CSS Modules stays.** No Tailwind, no CSS-in-JS, no runtime variant libraries.
2. **Token naming is short and semantic.** `--ink`, `--surface-1`, `--accent`, `--ring`. State suffixes `-hover`, `-active`, `-muted`. Numeric suffixes for elevation only.
3. **Theme attribute lives on `<html>`** and is set at SSR via cookie. Blocking script in `<head>` handles first-load fallback.
4. **Cookie name `nx-theme`**, values `light` | `dark`, missing = follow `prefers-color-scheme`. No "auto" stored — explicit pick wins until user clicks "Use system" (clears cookie).
5. **No new web font in 1A.** `--font-serif` uses `ui-serif, Charter, Georgia, …`. Phase 2 picks the face.
6. **Accent color is a placeholder** (warm-tan `#c4a472` dark / `#7d5e35` light). Phase 2 picks the real accent.
7. **Reader and Oracle scopes are preserved.** Their colors and fonts don't change. They consume the new scale tokens (radius/spacing/text) only.
8. **`StatusPill` becomes `Pill`.** Codemod call sites; delete old file.
9. **Settings UI: `/settings/appearance` route only.** Navbar quick-toggle is **out** of 1A — defer to Phase 1B/2 polish.
10. **Reduced-motion is a global override**, not per-component opt-in.
11. **Single feature branch, multi-commit.** Branch contains the whole cutover; commits are grouped by §10. Branch merges in one squash to `main`.
12. **Primitive variant logic is hand-rolled**, no `class-variance-authority` dependency.

## 13. Open questions — resolve before implementation

These should be answered before code starts; flagged so review of this spec captures them:

1. **Accent placeholder colors OK?** The warm-tan placeholders are deliberately neutral but opinionated. Alternative: graphite/charcoal accent (less wayfinding signal but more neutral). Pick before §6.1 freezes.
2. **Settings route — pane or page?** Other settings live at `/settings/<thing>` and render inside the workspace pane shell. Confirm `appearance` follows the same pattern (yes, default).
3. **Login page light mode — bare or branded?** 1A migrates it to tokens (so it works in both themes) but strips the radial gradient. Result is "utilitarian / unfinished" until Phase 2. Confirm acceptable.
4. **Existing reader screenshot tests** assert visual fidelity on the reader column; should be unaffected, but the reader's *chrome* (toolbar, panes around it) will look different. Are screenshot tests scoped tightly enough that this won't cause noise? If not, accept regeneration.
5. **PDF.js viewer styles** (`pdfjs-dist/web/pdf_viewer.css`) inject color-scheme-naive defaults. Approach: either (a) layer scoped overrides over its toolbar, or (b) accept that the viewer chrome is theme-blind in 1A and revisit. Default = (b).
6. **Highlight color opacities.** I'm proposing 0.35–0.40, down from today's 0.7–0.8. Reader testing may require revisiting if the lower opacity reads weakly on dark. Decision: ship at 0.40 (small drop), revisit only if testers complain.
7. **Visual regression testing.** No tooling exists today for app-wide visual regression. 1A doesn't add it but the question of "how do we know we didn't break anything visually" is real. Reasonable answer: per-area manual smoke + the existing screenshot tests. Confirm.
8. **`focus_mode`.** Reader's `focus_mode` from `reader_profile` is unused in UI. Untouched by 1A.

## 14. Risks

1. **Branch staleness.** Whole-cutover branches diverge fast. Mitigation: rebase weekly; freeze unrelated CSS work for the duration.
2. **Test churn.** Snapshot tests, component tests asserting class names, and the `__screenshots__` set will all need updating. Mitigation: do this in step 8 of §10 once the visual is stable.
3. **Reader regression.** If a reader-adjacent component (e.g., `MediaPaneBody`) accidentally reaches into the new app tokens instead of `--reader-*`, the reader can drift. Mitigation: explicit grep in acceptance to verify reader column uses `--reader-*` exclusively.
4. **Oracle regression.** Same risk, narrower scope. Mitigation: visual diff Oracle pages against pre-cutover screenshots before merge.
5. **Login page brand drift.** Light mode without the gradient looks unfinished. Mitigation: scope-flag in §13 #3; accept the interim state in writing.
6. **PDF.js theme blindness.** Viewer chrome (toolbar, page-number widgets) won't follow theme. Acceptable per §13 #5.
7. **Cookie-vs-DB drift.** App theme is in a cookie; reader theme is in the DB. A user resetting cookies loses app theme but keeps reader theme. Acceptable — the cookie scope is intentional (no DB write per toggle).
8. **Unknown unknowns from 56-component refactor.** Some ad-hoc buttons may have subtle behavioral nuance (focus flow, keyboard handling) that the primitive doesn't capture. Mitigation: spot-test each migrated component's keyboard interactions; the primitive's tests cover the common cases.

---

**Status when this spec is approved:** ready to start step 1 of §10. Implementation discipline (no half-cut intermediate states beyond the documented commit groups) is the gating factor — everything else is mechanical.
