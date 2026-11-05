# archive polling discards the active read promise

`apps/web/src/app/(authenticated)/media/[id]/Embeds.tsx:209–215` calls `archive.refetch()` without returning its promise. `apps/web/src/lib/useIntervalPoll.ts:28–38` can therefore mark the tick finished before the read finishes; later queued/running ticks can replace their own slow read.

return and handle the existing read owner's promise at this caller. resolve when an actual original archive read survives longer than two polling ticks and advances the archive state. accepted-source visibility/background lifetime checks exercise another owner and do not close this issue.
