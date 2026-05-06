# Visual Foundation 1A — Migration Cheat Sheet

Companion to `docs/visual-foundation-1a-hard-cutover.md`. Authoritative mapping for the migration sweep.

## Old token → new token (literal substitutions)

| Old                       | New                                                       |
| ------------------------- | --------------------------------------------------------- |
| `--color-bg`              | `--surface-canvas`                                        |
| `--color-bg-secondary`    | `--surface-2`                                             |
| `--color-bg-tertiary`     | `--surface-1`                                             |
| `--color-surface`         | `--surface-2`                                             |
| `--color-bg-hover`        | `--surface-hover`                                         |
| `--color-bg-active`       | `--surface-active`                                        |
| `--color-text`            | `--ink`                                                   |
| `--color-text-secondary`  | `--ink-muted`                                             |
| `--color-text-muted`      | `--ink-faint`                                             |
| `--color-text-on-accent`  | `--ink-on-accent`                                         |
| `--color-accent`          | `--accent`                                                |
| `--color-accent-hover`    | `--accent-hover`                                          |
| `--color-accent-muted`    | `--accent-muted`                                          |
| `--color-border`          | `--edge`                                                  |
| `--color-border-subtle`   | `--edge-subtle`                                           |
| `--color-success`         | `--success`                                               |
| `--color-warning`         | `--warning`                                               |
| `--color-error`           | `--danger`                                                |
| `--font-size-xs`          | `--text-xs`                                               |
| `--font-size-sm`          | `--text-sm`                                               |
| `--font-size-base`        | `--text-base`                                             |
| `--font-size-lg`          | `--text-lg`                                               |
| `--font-size-xl`          | `--text-xl`                                               |
| `--font-size-2xl`         | `--text-2xl`                                              |
| `--shadow-sm`             | `--shadow-1`                                              |
| `--shadow-md`             | `--shadow-2`                                              |
| `--shadow-lg`             | `--shadow-3`                                              |
| `var(--transition-fast)`  | `var(--duration-fast) var(--ease-glide)` (transition shorthand value) |
| `var(--transition-normal)`| `var(--duration-base) var(--ease-glide)`                  |

## Hardcoded value → token

**Radius:**
- `2px` → `var(--radius-xs)`
- `3px`, `4px` → `var(--radius-sm)`
- `5px`, `6px` → `var(--radius-md)`
- `7-10px` → `var(--radius-lg)`
- `11-14px` → `var(--radius-xl)`
- `15-18px` → `var(--radius-2xl)`
- `999px` → `var(--radius-full)`

**Font size:**
- `0.625-0.75rem` (10-12px) → `var(--text-xs)`
- `0.8125rem` (13px), `0.875rem` (14px) → `var(--text-sm)`
- `0.9375rem` (15px) → `var(--text-base)`
- `1rem` (16px) → `var(--text-md)` for reader/large UI; `var(--text-base)` for app body
- `1.125rem` (18px) → `var(--text-lg)`
- `1.25rem` (20px) → `var(--text-xl)`
- `1.5rem` (24px) → `var(--text-2xl)`
- `1.875rem` (30px) → `var(--text-3xl)`
- larger → `--text-display-1` / `--text-display-2`

**Font weight:**
- `400` → `var(--weight-regular)`
- `500` → `var(--weight-medium)`
- `600` → `var(--weight-semibold)`
- `700` → `var(--weight-bold)`

**Transition duration:**
- `80ms` → `var(--duration-instant)`
- `100-180ms` → `var(--duration-fast)`
- `200-260ms` → `var(--duration-base)`
- `280-400ms` → `var(--duration-slow)`
- `≥500ms` → `var(--duration-deliberate)`

**Easing:**
- `ease`, `ease-in-out`, `ease-in` → `var(--ease-glide)`
- `ease-out` → `var(--ease-snap)`
- bespoke `cubic-bezier(...)` → keep if intentional, otherwise → `var(--ease-glide)`

**Box shadow:**
- Replace ad-hoc box-shadow values with `var(--shadow-1..5)` by elevation:
  - `--shadow-1`: subtle hover hint
  - `--shadow-2`: card / dropdown
  - `--shadow-3`: popover / floating menu
  - `--shadow-4`: modal / dialog
  - `--shadow-5`: overlay / sheet

**Hex / rgba colors:**
- Map every hex / rgba to the closest semantic token (surface / ink / edge / accent / state).
- Translucent accent overlays (e.g. `rgba(122, 162, 247, 0.16)`) → `var(--accent-muted)`.
- For one-off translucent fills not covered by tokens, use `color-mix(in srgb, var(--accent) 20%, transparent)` style.
- `rgba(0, 0, 0, X)` modal/sheet backdrops are theme-invariant overlays — keep literal.

## Do NOT touch

- `--reader-*` namespace and the `.readerThemeLight` / `.readerThemeDark` blocks in `apps/web/src/app/(authenticated)/media/[id]/page.module.css`. Reader colors are independent.
- `[data-theme="oracle"]` block in `globals.css` and everything under `apps/web/src/app/(oracle)/`. Oracle colors are independent.
- `--highlight-*` tokens (already migrated).
- `apps/web/src/app/globals.css` (already rewritten).
- `apps/web/src/lib/highlights/highlights.css` (already migrated).
- `apps/web/src/app/login/page.module.css` and `apps/web/src/app/legal.module.css` — owned by the login/legal task.

The reader's *chrome* (toolbar, container, error states, settings UI) IS migrated. Only the column itself and its `--reader-*` overrides stay literal.

## Rules to honor (`docs/rules/`)

- `simplicity.md`: fewer lines, fewer code paths; no speculative API surface.
- `conventions.md`: don't extract one-use constants.
- `codebase.md`: no re-export barrels; direct imports.
- `control-flow.md`: exhaustive matching; no `default` swallowing.
- `function-parameters.md`: object params for boundary APIs; positional fine for tightly-coupled primitives.
- No inline lint disables. Fix root causes.
