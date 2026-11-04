# native normal-save speech needs final qualification

original phone observation at `fdd0a3e`: starting episode 113 announced “progress
sync paused” while three listening puts returned 200 and two activity posts 204
(2026-10-15, 21:54:45–21:55:07 utc). no failed upload was established. the old
player treated every `synced=false` as failure and retained its last announcement.

source corrected: `components/player/usePlayerAnnouncement.ts` never derives
speech from `synced`; `PlayerOutcomes.tsx` distinguishes `playbackFailed` from
`PlaceTrouble` and projects only actual unresolved recovery. the bar model keeps
ordinary pending delivery and progress recovery separate from failed sound.

remaining acceptance on the final merged native tree: successful progress writes
never announce a false pause; an actual retained failure remains accessible and
settlement removes it without losing queued progress. the earlier phone evidence
is private under `coordinator/finalfdd0a3e/phone-sync-diagnosis/api-observation-1.json`.
