# speculative reads lack an execution budget

- status: open
- origin: 2026-09-13 memory investigation; deployed sha `7e8fd48244b3b436965037738e05785bb4931be1`, local sha `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: pane intent prefetch and resource ownership

`apps/web/src/lib/panes/paneWarm.ts:45–57` schedules data prefetch after
70 ms independently per resource key. moving to another target does not
withdraw the previous target's timer. `PaneRouteBoundary.tsx:81–92`
warms every hovered/focused in-pane anchor; nexus also warms active rows.
`api/resourceCache.tsx:47–58` starts work immediately and limits retained
prefetch entries to 16 afterward (lines 72–81). these files are unchanged
between deployed and local shas.

sixteen author keys can start 32 contributor/works reads; the author loader
starts two reads per key. this is possible admitted work, not a measured
incident request count. eviction does abort a retained pending entry at
line 79. however `useResource.ts:132–135` consumes an adopted pending
entry before settlement, removing it from lru tracking; its adoption
cleanup deliberately does not abort the request (lines 149–181). the
sixteen-entry cache limit is therefore not a complete in-flight-work
budget. it also says nothing about bytes or backend work after disconnect.

prerequisites: measure resource-loader allocation, request lifetime after
abort, and the memory available for speculative work after active reads.

proposed fix: admit speculative data loads through one bounded owner with
an explicit measured capacity budget; active user requests take priority.
retain ownership until each admitted operation settles or cancellation is
acknowledged. distinguish chunk warming from data warming and keep only
useful outstanding intent. share an adopted operation instead of releasing
its accounting while it is still running. do not substitute an arbitrary
new cache-entry limit for execution admission.

acceptance: controlled pointer/keyboard traversal over many unique targets,
pending-prefetch adoption, and immediate pane close cannot exceed the
admission budget or leave unaccounted work. active navigation remains
correct and responsive. correlate admitted work with api memory before
calling it the cause of the reported kills; proof runs via `./scripts/test`.
