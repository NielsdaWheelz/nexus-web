# pending drag can survive blur and claim another press

problem: `SortableList` clears its held press on window blur, but the installed
mouse/touch sensor does not cancel on blur. its pending interaction can outlive
that press and claim the replacement press's pointer and pane.

evidence at `565ff21b4`:

- `apps/web/src/components/sortable/SortableList.tsx:238` invalidates and clears
  `held`; lines 195–205 admit a fresh press, and lines 323–338 read the current
  `held` when the old sensor starts. equal row ids do not establish press identity.
- installed `apps/web/node_modules/@dnd-kit/core/dist/core.esm.js:1444` registers
  resize/visibility-change cancellation, but no blur cancellation. lines
  3193–3209 reject a fresh sensor while the old `activeRef` survives; lines
  1577–1603 detach the sensor and settle that ownership only on end/cancel.
- normal `touchcancel` is handled by the installed touch sensor; tab hiding may
  also cancel through `visibilitychange`. neither proves visible-window blur safe.

static reproduction trace: press row x without reaching activation; blur the
window while its document remains visible; release outside the document; refocus
and press row x again; move past 8px. if the original sensor received no end or
cancel, it activates using its old event while the list reads the new press.
possible impact: incorrect gesture ownership, suppressed fresh input, or movement
admitted against another press's snapshot.

browser reproduction and affected user journeys: `NOT_RUN`. reproduce with real
window focus changes and assert `document.visibilityState === "visible"`; a tab
switch that hides the document does not isolate this hazard.

proposed repair, if reproduced: make window blur cancel the existing sensor via
its existing cancellation path, settling listeners, timeout and dnd ownership.
the approved row-drag specification currently forbids changing the installed
dnd-kit patch; resolve that constraint before repair. an activator-identity check
alone leaves stale sensor ownership and does not prove fresh input works.

resolved when the actual visible-window blur sequence cannot admit the stale
press, the following independent gesture works, and row/pane-strip release
suppression still holds after cancellation.
