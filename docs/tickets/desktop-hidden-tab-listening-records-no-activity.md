# desktop listening in a hidden tab records no activity

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), player slice spec and harness · area: player / listening

## what is wrong

activity capture requires `visibilityState === "visible"` (`ActivityCaptureLifecycle.tsx:11-15,47`), and that rule also applies to audio. observed: 30 s played in a hidden tab → 0 s of spans while heartbeats continue. stats undercount the commonest desktop podcast mode.

## fix

resolve in the player rewrite (`player-reauthor-ready.md`), or at the owning module if fixed first.

## acceptance

a player harness journey shows the corrected behaviour on desktop and android.
