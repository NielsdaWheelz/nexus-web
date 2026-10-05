# natural end stores a position past the duration

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), player slice spec and harness · area: player / listening

## what is wrong

on android a natural end stored 372726 ms against a 372715 ms duration. harmless today; any `position ≤ duration` check would trip.

## fix

resolve in the player rewrite (`player-reauthor-ready.md`), or at the owning module if fixed first.

## acceptance

a player harness journey shows the corrected behaviour on desktop and android.
