# per-episode playback rate differs by device

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator), player slice spec and harness · area: player / listening

## what is wrong

the browser pins an episode rate on first `playing` and refuses rate-less heartbeats (`browserPlayerRuntime.tsx:1897`, `listeningHeartbeat.ts:276`); android sends Absent and keeps inheriting the podcast default (`NativeConsumptionRecorder.kt:1001`). observed: desktop rows get `episodePlaybackRate` Present, android rows stay Absent; a podcast-default change reaches an episode only if it was never opened on desktop.

## fix

resolve in the player rewrite (`player-reauthor-ready.md`), or at the owning module if fixed first.

## acceptance

a player harness journey shows the corrected behaviour on desktop and android.
