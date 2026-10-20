# the phone reader sometimes undoes the first scroll after load

status: open; intermittent, cause unconfirmed · origin: 2026-10-19 resource references re-slice harness (O1) · area: reader web ui / reading position

at phone width, a reader pane scrolled right after its document loads sometimes
returns to `scrollTop` 0 while the pane menu is open: the refs harness journey
`act/N2.mobile-pane-menu-holds-the-chrome` saw it in 1 of 4 full baselines, 1 of 10
in a repeat hunt and once more in a later full run (evidence:
`nexus-web-campaign-artifacts/2026-10-18/refs/harness/state/superseded/baseline-b2-evidence`,
`flake-3-evidence`). the journey now scrolls a second time and says so; the chrome-hold
assertion is unchanged. afaict a late reading-position restore lands after the
reader's first user scroll.

impact: a reader who scrolls quickly after opening on a phone can be thrown back to
the top once.

fix: find the restore that runs after first user input (hosted reader restore in
`app/(authenticated)/media/[id]/hostedReader.ts` and the document reader's
navigator) and make a user scroll supersede any pending restore.

resolved when: the journey's first scroll holds in a 20-run repeat at phone width.
