# replaying a finished episode starts at its end and re-completes

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), player slice spec and harness · area: player / listening

## what is wrong

the player descriptor carries the terminal position regardless of completion (`python/nexus/services/consumption/projection.py:410`); the browser's zero-start override lives only in provider memory (`browserPlayerRuntime.tsx:1059-1082`); native seeks to `descriptor.positionMs` (`NexusPlaybackService.kt:673`). observed: a fresh tab starts at 150.0/150 s and ends immediately; on android a replay ends instantly and posts another `SettleNaturalEnd`, bumping the override revision each time. the user must reset progress to listen again.

## fix

resolve in the player rewrite (`player-reauthor-ready.md`), or at the owning module if fixed first.

## acceptance

a player harness journey shows the corrected behaviour on desktop and android.
