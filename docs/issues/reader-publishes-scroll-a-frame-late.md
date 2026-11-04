# reader publishes scroll a frame late

problem: the document reader hears its port's `scroll` event and publishes the new viewport and placement from its own
`requestAnimationFrame` (`apps/web/src/lib/documentReader/scrollport.ts:134-155`, scheduled from `:171-174`). a
consumer that schedules its work from `reader.subscribe` therefore runs a frame after the text moved.

impact: the reader margin follows the text. scheduled from `subscribe` alone, its first frame of a gesture lags, and
the next one catches up by up to 3x two frames of text, past a10's per-frame cap. the pane works around it in the
consumer: `E/EvidencePane.tsx` adds a passive capture-phase `scroll` listener on `window` that schedules the margin's
measure in the text's own frame. that is a second clock beside the reader's: it measures for any scroll anywhere in the
document while the margin is shown, and `reader.getState()` inside that measure still returns the previous frame's
`viewport` and `placement` (only the passage and bounds geometry are live), so the ring filter and the reveal fold see
the text a frame late.

evidence: connections-scroll lane 4 (`$S/build/reports/margin.md`, deviation 2). the late frame was found by reading
the reader's publish path; l4-g1 (run `20261102-151845-54fd49731487`) failed a10 with 8 of 16 wheel passes over,
alongside the unseen-row fault, and the window listener plus the measuring pass made a10 green from l4-g2 on.

resolved when the reader publishes a scroll in the event's own frame, or exposes its scroll element so the margin
listens there, and the pane's `window` listener is deleted with a10 still green.
