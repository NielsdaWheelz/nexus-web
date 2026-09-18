# Press and Study never declare a color-scheme, so native controls follow the UA default

status: open · origin: 2026-09-18 owner-decision PR (D148 review) · area: appearance

only `[data-theme="elvish"]` declares `color-scheme` in
`apps/web/src/app/globals.css`. Press (dark, now the default for every visitor
without an `nx-theme` cookie) and Study (light) leave it unset, so selects,
date pickers, autofill and UA scrollbars render in the browser's own scheme
rather than the room's. an OS-light visitor on Press gets a dark page with
light native controls; an OS-dark visitor on Study gets the reverse.

impact: cosmetic, user-visible on every form control and scrollbar in the two
rooms. a proposed fix (`color-scheme: dark` on `:root`, `light` on
`[data-theme="light"]`) was reverted from the D148 change because it also
recolours UA scrollbars and inherits into frames, which is a design call.

resolved when: each room declares the `color-scheme` it means, and the Solar's
`scrollbar-color` rule still wins under it.
