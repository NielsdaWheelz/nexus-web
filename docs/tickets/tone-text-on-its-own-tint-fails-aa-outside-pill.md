# Four rules outside `Pill` paint a tone as text over a tint of that same tone

**Status:** open
**Origin:** Imports workspace cutover, Phase 7 chain Z review, 2026-09-10
**Area:** `apps/web/src/app/(authenticated)/media/[id]/page.module.css`
(`.mismatchBanner`, `.partialCoverageWarning`),
`apps/web/src/components/PdfReader.module.css` (`.error`),
`apps/web/src/components/chat/BranchComposerHeader.module.css` (`.iconBox`)

## What is wrong

`Pill` is not the only place in the app that paints a tone token as text over a
`color-mix` fill of the same token. A mechanical scan of every `.css` file under
`apps/web/src` for a rule that pairs `color: var(--<tone>)` with
`background(-color): color-mix(in srgb, var(--<same tone>) N%, transparent)`
returns six rules; two are the `Pill` tones tracked by OI-047, and these four are
the rest:

| Rule | Mix | Text size |
|---|---|---|
| `media/[id]/page.module.css` `.mismatchBanner` | 10% `--warning` | `--text-sm` |
| `media/[id]/page.module.css` `.partialCoverageWarning` | 10% `--warning` | `--text-sm` |
| `PdfReader.module.css` `.error` | 10% `--danger` | `--text-sm` |
| `chat/BranchComposerHeader.module.css` `.iconBox` | 14% `--accent` | icon only |

Ink and fill differ only by the mix, so the pair cannot be far apart by
construction. Three of the four carry `--text-sm` body copy, which needs 4.5:1
under WCAG 1.4.3 (AA); `.iconBox` carries a 28 px icon, for which 1.4.11 asks
3:1 and which passes, so it is listed only because it is the same pattern and
will read wrong the moment a label is put in it.

## Evidence

Computed from `apps/web/src/app/globals.css` through each rule's own mix with the
WCAG 2.1 relative-luminance formula — the same computation the browser case
`ImportsWorkspace.browser.test.tsx` ("paints every status pill label at AA
contrast over its own tinted fill") runs against the rendered DOM. Below 4.5:1:

| Rule | Palette | Ground | Ratio |
|---|---|---|---|
| `.mismatchBanner` / `.partialCoverageWarning` | light | `--surface-canvas` | 4.36:1 |
| `.mismatchBanner` / `.partialCoverageWarning` | light | `--surface-2` | 4.20:1 |
| `PdfReader` `.error` | dark | `--surface-2` | 4.47:1 |

Every other palette/ground pairing of those three rules measures 4.6:1 or above,
and `.iconBox` measures 4.48:1 at its worst (light, `--surface-2`), which clears
the non-text 3:1 threshold that applies to it.

## Prerequisites

None. `--success-ink` / `--warning-ink` / `--info-ink` already exist in all four
palette blocks of `globals.css`; `--danger-ink` and `--accent-ink` are the two
OI-047 asks for, and `.error` needs the danger one.

## Proposed fix

Point `.mismatchBanner` and `.partialCoverageWarning` at `--warning-ink`, and
`.error` at `--danger-ink` once OI-047 adds it. Keep the fills and borders on the
tones. `.iconBox` needs no change while it holds only an icon.

Note that the ink steps are proved over the grounds the Imports pane paints on;
a banner sitting on `--surface-2` or `--surface-3` is a different ground, so the
fix remeasures rather than assuming the step carries.

## Acceptance

A browser case owned by the media pane (and one by the PDF reader) computes the
WCAG ratio from the rendered `color` and the composited effective background of
the banner and fails below 4.5:1, in the light, dark and elvish palettes.
