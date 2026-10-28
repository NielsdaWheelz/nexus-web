# connectivity changes remount library rows

in disposable chromium run `20261028-142233-a5c05a29caf2` (index-row-actions branch
based on `daf605a8d`), a canonical media row's more menu disappeared after an
intercepted resource-action read failed, instead of exposing preparation retry.
the isolated case confirmed the exact media ref and visible loading announcement
before `Fetch.failRequest`. an earlier combined case observed the same dismissal.

evidence: private `.nexus-local/lab/20261028-142233-a5c05a29caf2/artifacts/playwright/`
case `canonical action facts loading and retry`; temporary case source at
`apps/web/.nexus-lab/cases/index-row-actions.spec.ts:249-274`.

cause: `apps/web/src/app/(authenticated)/libraries/[libraryId]/LibraryPaneBody.tsx:204-210`
removes ordering when `remoteReady()` becomes false after `E_NETWORK`.
`apps/web/src/components/collections/CollectionView.tsx:188-205` then replaces
`SortableList` with a different `ResourceList` subtree. the trace shows the same
row's trigger changing from `_r_47_` to `_r_57_`: its menu owner was remounted.
this loses pending menu/focus state during a transient connectivity change.

repair list composition so changing reorder availability preserves row identity;
disable unavailable reorder interaction in its existing owner. keep admission
rules and frozen-menu guards intact. no automatic reopen or retry. this is separate
from index shortcut promotion; a held-read preparation deadline exercises retry
without changing connectivity or remounting the row.

resolved when network loss and recovery preserve same-subject row identity, expose
truthful availability and focus, and never permit offline reorder. reproduce by
opening a media menu in a custom-ordered library and failing its genuine action read.
