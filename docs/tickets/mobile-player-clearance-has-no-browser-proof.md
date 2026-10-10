# the mini-player half of mobile bottom clearance has no browser proof

status: open · origin: 2026-10-10 app navigation reauthor (cleanup/appnav-reauthor) · area: web / mobile viewport, player

design §14 M10 asks that, with a playing episode, the Nexus wrapper rest 12px
above the mini-player and that focusing a root text input hide the mini-player
and return Nexus to the safe bottom. the c2nv nav harness has no playable
episode (its stack seals the worker from any feed or audio host), so
M10.bottom-clearance ran only the empty half: wrapper bottom = viewport - 12 and
the pane body's local `--mobile-content-bottom-clearance` = Nexus band minus the
space below the body (both engines). the `"Player"` bottom surface
(`components/player/GlobalPlayerSurfaces.tsx`) and `useRootTextEntryFocused`
(`lib/mobileShell/viewport.tsx`) are unexercised.

what to do: add a playable episode to the nav harness (the podcasts harness's
`stack/fake.mjs` feed and audio host) and extend M10 with the player clauses.

resolved when: M10 passes with the player half on chromium and webkit.
