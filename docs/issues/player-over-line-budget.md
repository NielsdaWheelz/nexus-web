# the re-authored player exceeds its line budget

status: open · origin: 2026-10-05 player re-author (branch `cleanup/player-reauthor`), integration measure · area: player / lectern / listening (web, python, android)

## what is wrong

the design's merge gate (formatted physical lines: prettier@3, `ruff format`, kotlin raw) is in-budget ≤ 5,700 and full scope ≤ 7,000. measured on the merged tree:

| | now | design |
|---|---|---|
| python | 2,141 | 1,909 |
| web | 4,021 | 2,790 |
| android | 1,040 | 850 |
| in-budget | 7,202 | 5,549 (gate 5,700) |
| carried | 1,343 | ≈1,318 |
| full scope | 8,545 | 6,867 (gate 7,000) |

today's scope was 24,613 lines. the largest overruns: `lib/player/browserEngine.ts` 598/370, `components/player/GlobalPlayerSurfaces.tsx` 475/280, `lib/player/playerRuntime.tsx` 513/360, `NexusPlaybackService.kt` 515/340, `lib/lectern/LecternProvider.tsx` 323/230. the review fixes of 2026-10-05 added 133 (7,069 → 7,202): the server-recorded undo (python +25), the engine-owned resume refresh on both platforms and the detached-episode writer (web +33, android +75). the per-file estimates assumed fewer lines than prettier's 80-column jsx produces. owner decision P5 (keep the session pause-shortening override and the time-saved counter) costs ≈50 web and ≈47 android lines.

## what to do

owner: accept the overrun, or ask for a compaction pass. implementer A estimates ≈600–700 lines from one (≈550 web, ≈150 python), which still misses the gate; meeting it needs cuts of behaviour, not of form.

## acceptance

the owner's decision is recorded here and either this ticket is deleted (accepted) or a compaction lands with the formatted count of the same files at or under the gate and the player harness still green.
