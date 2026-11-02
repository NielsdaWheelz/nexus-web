# an item menu opened by a touch hold ignores escape

problem: a touch hold released in place opens the bullet's item menu through
`ActionMenu`'s anchor `open()`, which begins the session without moving focus
into the menu; focus stays on the bullet. the menu closes on escape only from its
own surface (`ActionMenu.tsx`, `onSurfaceKeyDown`), so a keyboard escape leaves
it open. the menu's own internal touch hold opens the same way, so this predates
the outline's external hold.

impact: with a hardware keyboard on a touch device, escape does not dismiss the
menu. on android, back arrives as a synthetic escape on `document`; whether it
closes the menu, navigates under it, or both is unobserved.

evidence: lab runs `20261102-120140-2d183780d7a8` and
`20261102-123128-cee689a0b8a5` (case `adversary-L2-b-touch`, chromium touch
emulation): the menu stays visible after escape; the case dismisses it by tapping
outside instead.

resolved when escape, and android back on the owned emulator, closes a
touch-opened item menu once without navigating, with focus returned to the bullet.
