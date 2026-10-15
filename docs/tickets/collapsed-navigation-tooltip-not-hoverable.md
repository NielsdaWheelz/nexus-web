# collapsed navigation tooltip cannot retain pointer hover

status: open
origin: 2026-10-14 inspector design review; baseline `367da80e0`
area: web / navigation accessibility

source evidence: `apps/web/src/components/appnav/AppNav.tsx:169-172` opens a
custom tooltip on mouse entry or focus, then clears it immediately on mouse
leave. its tooltip is a sibling outside the trigger (`:231-234`), and
`AppNav.module.css:332` sets `pointer-events: none`. the revealed caption cannot
remain visible when the pointer moves onto it. this conflicts with the hoverable
condition of [wcag 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
source review only; no live pointer reproduction performed in this session.

prerequisite: none; included in the [navbar plan](../navbar-launcher-plan.md).
fix tooltip interaction at its owning ui/navigation layer;
preserve the trigger's accessible name. keep the caption visible across the
trigger-to-caption pointer transition and while hovered or keyboard-focused.
provide escape dismissal without moving focus. do not copy the current behavior
into the proposed inspector tooltip.

acceptance: in collapsed navigation, hover a destination and move onto its
caption; it remains readable. escape dismisses without moving pointer/focus;
keyboard focus also reveals help. leaving both trigger and caption closes it,
and the tooltip never takes focus or blocks navigation.
