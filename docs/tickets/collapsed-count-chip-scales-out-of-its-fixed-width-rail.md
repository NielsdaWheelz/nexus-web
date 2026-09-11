# The collapsed count chip scales out of its fixed-width rail

**Status:** open
**Origin:** Imports workspace cutover, Phase 6 chain W2 re-review, 2026-09-09
**Area:** `apps/web/src/components/ui/Pill.module.css` (`.sizeXs`);
`apps/web/src/components/appnav/AppNav.module.css` (`.utilityChip`,
`.collapsed .utilityLink`)

## What is wrong

The collapsed rail is fixed px (`--navbar-collapsed-width: 48px`, a 20px glyph),
while the count chip inside it is sized in rem: `--text-2xs` (0.6875rem),
`padding: 1px var(--space-1)` (0.25rem), inside a footer padded with
`--space-2` (0.5rem). The chip is right-anchored to the link and grows leftwards,
so raising the document's root font size grows the chip while the link it is
anchored to narrows.

At a 16px root the widest chip (`99+`) measures 27x17 inside a 31px link, well
within the rail. Measured with a throwaway case at a 22px root
(`document.documentElement.style.fontSize = "22px"`), the same chip is 37x22 with
its left edge at x=-1 while the rail spans x=0..48 and the link has narrowed to
25px: the chip overflows its link and the rail clips it
(`.rail { overflow: hidden }`). Browser zoom is safe because px scales with it;
**text-only** scaling is not, and the spec's navigation rubric asks for legible
counts under zoom.

`NavRail.browser.test.tsx` measures the default root font only. Its containment
assertion is against the *link's* box, which is the tighter bound, so the case
that exercises a larger root will fail on the link before it fails on the rail.

## Prerequisites

A decision on which unit wins, which is a design call, not a local fix: making
the chip px removes text-scaling from the one number the chrome shows, and making
`--navbar-collapsed-width` rem changes a global token every rail consumer reads.

## Proposed fix

Preferred: express the collapsed rail's width (and the footer's padding) in the
same unit the chip is typed in, so the whole chrome scales together. Otherwise
clamp the chip's typography in px, since it lives in a px chrome — noting that
px typography removes text-only scaling from the one number this chrome shows,
which is why the unit is a design call and not a local fix. Either way add a case
to `NavRail.browser.test.tsx` that raises `document.documentElement`'s font size
(restoring it afterwards) and re-asserts that the link contains the `99+` chip.

## Acceptance

A named case fails if the widest count chip is painted outside the collapsed
rail's box at a root font size materially larger than 16px.
