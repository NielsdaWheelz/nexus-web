# desktop natural end skips the natural-end fence

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), player slice spec and harness · area: player / listening

## what is wrong

the browser's `FinishLecternItem` neither installs the terminal position atomically nor checks `consumptionOverrideRevision` (`browserPlayerRuntime.tsx:1201-1240` vs `services/consumption/service.py:307-358`); an Unplayed set elsewhere during playback is overwritten by a late end. source-only.

## fix

resolve in the player rewrite (`player-reauthor-ready.md`), or at the owning module if fixed first.

## acceptance

a player harness journey shows the corrected behaviour on desktop and android.
