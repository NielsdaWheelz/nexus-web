# the unload keepalive can lose the last listening position

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), player slice spec and harness · area: player / listening

## what is wrong

`flushKeepalive` reuses the current expected revision while a PUT may be in flight with the same revision (`listeningHeartbeat.ts:296-304`); whichever lands second gets 409 and the keepalive has no recovery. source-only.

## fix

resolve in the player rewrite (`player-reauthor-ready.md`), or at the owning module if fixed first.

## acceptance

a player harness journey shows the corrected behaviour on desktop and android.
