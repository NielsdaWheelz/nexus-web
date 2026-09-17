# `Pill`'s danger and accent tones still fail AA contrast against their own fill

**Status:** open (narrowed — the info, success and warning tones were fixed in
Phase 7 chain Z; the two tones the Imports pane never paints were left)
**Origin:** Imports workspace cutover, Phase 6 chain W4 (second D15 desktop
visual/assistive review), 2026-09-09; narrowed 2026-09-10
**Area:** `apps/web/src/components/ui/Pill.module.css` `.toneDanger` /
`.toneAccent` and the `--danger` / `--accent` text steps in
`apps/web/src/app/globals.css`

## What is wrong

`.tone*` fills with an 18% mix of a tone token and, for these two tones, still
paints the label in that same token:

```css
.toneDanger {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}
```

Ink and fill then differ only by the mix. `.toneInfo`, `.toneSuccess` and
`.toneWarning` now read `--info-ink` / `--success-ink` / `--warning-ink`, per-theme
steps chosen to clear 4.5:1 over their own fill on the grounds the Imports pane
paints those pills on (the page canvas, plain or under the selection wash; worst
measured 4.83:1 — over `--surface-3` under that wash the same steps measure
4.15-4.20:1, so a caller on a deeper surface remeasures); `.toneDanger` and
`.toneAccent` have no such step at all. Computed from the tokens over
the darkest (light palette) / lightest (dark palettes) ground a pill actually
lands on — the selected row's `--accent-muted` wash and `--surface-active`:

| Tone | Palette | Ratio |
|---|---|---|
| `danger` | dark | 3.21:1 |
| `danger` | light | 3.87:1 |
| `danger` | elvish | 3.07:1 |
| `accent` | dark | 4.16:1 |
| `accent` | light | 3.78:1 |
| `accent` | elvish | 3.35:1 |

Pills are uppercase `--text-xs` / `--text-2xs`, nowhere near the 18.66 px bold
that would let the 3:1 large-text exception apply, so this is WCAG 1.4.3
(Contrast Minimum, AA) wherever those two tones carry text.

Why it is not a blocker for this cutover: the Imports pane paints only the
warning, info and success tones (`ImportRow.tsx` `STATE_TONE`,
`ImportsWorkspace.tsx` tab counts, `ImportsBadge.tsx`, `ImportInspector.tsx`), all
three of which measured above 4.5:1 in the original browser check. The two
remaining tones are painted by other surfaces (`CollectionRow`,
`ConnectionsSurface`, `SettingsBillingPaneBody`, `SettingsLocalVaultPaneBody`,
`MediaPaneBody`, `EvidenceItemRow`), none of which is in this cutover's ownership.

## Evidence

Computed from `apps/web/src/app/globals.css` (the `--danger` / `--accent` steps of
each palette) composited through `Pill.module.css`'s 18% mix, with the WCAG 2.1
relative-luminance formula; the same computation, run against the rendered DOM,
was recorded by the former `ImportsWorkspace.browser.test.tsx` assertion
"paints every status pill label at AA contrast over its own tinted fill," which
measured the pre-fix
warning pair at 3.92:1 over the plain page ground. The D15 captures
`<scratchpad>/evidence/F-imports-review-5/{history-recovered,in-progress-counted,needs-attention-selected}.png`
decoded 3.24-4.19:1 for the three now-fixed tones on the selected row.

## Prerequisites

None. The owner is `components/ui` plus the shared token palette; the pattern to
follow already exists (`--info-ink` / `--success-ink` / `--warning-ink`).

## Proposed fix

Add `--danger-ink` and `--accent-ink` to each palette in `globals.css` the same
way, point `.toneDanger` / `.toneAccent` at them, and manually measure surfaces
that paint those tones.
The same tone-on-its-own-tint pairing outside `Pill` is
`docs/tickets/tone-text-on-its-own-tint-fails-aa-outside-pill.md` (OI-050); the
ink steps added here are what those rules should point at.

## Acceptance

manual measurements of danger and accent pills show at least 4.5:1 between
rendered text and the composited effective background in the light, dark, and
elvish palettes.
