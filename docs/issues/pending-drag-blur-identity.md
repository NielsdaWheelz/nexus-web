# pending drag can survive blur and claim another press

before repair, `SortableList` cleared its held press on window blur, but the
installed mouse/touch sensor did not cancel on blur. its pending interaction
could outlive that press and claim the replacement press's pointer and pane.

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

public blur-event regression reproduced against `a0beb0577` in disposable run
`20261020-010142-4fe51670e755`: both library and lectern showed a preview after
the fresh press moved 2px (expected none). the injected window blur was untrusted;
mouse input and persistence used their real boundaries. native visible-window
blur remains `NOT_RUN`; hiding a tab does not isolate it.

the user approved the narrow specification exception. the installed dnd-kit patch
now makes window blur use the pointer sensor's existing cancellation path,
settling listeners, timeout and dnd ownership in all three published bundles.
green qualification is pending. an activator-identity check alone would leave
stale sensor ownership and would not prove fresh input works.

resolved when the actual visible-window blur sequence cannot admit the stale
press, the following independent gesture works, and row/pane-strip release
suppression still holds after cancellation.
