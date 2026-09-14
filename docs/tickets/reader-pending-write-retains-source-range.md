# pending reader writes retain detached source ranges

- status: open
- origin: 2026-09-14 bounded reader late-ack review
- area: reader selection and source retirement

`MediaPaneBody.tsx:3410` keeps `activeSelection` across create/detail awaits; its completion closure reads the captured `Range`. `PdfReader.tsx:2375` does the same for create/update. `useRetainedReaderSelection.ts:190` cancels publication on unmount but leaves its captured snapshot referenced. a closed reader can therefore remain reachable through pending write continuations after its visible source and source lease retire. this is a structural retention finding; its physical charge and collection boundary are not yet measured.

preserve authoritative write acknowledgment. inspect the existing selection/operation owner for a clearable presentation reference that can retire on source close while scalar write identity survives. do not cancel committed writes or add a selection registry. include fresh Link source completion in that audit.

acceptance: hold a real write after source close; its acknowledgment survives while retired source DOM can be collected and no released source charge is still required by a live selection reference. include a positive pre-retirement liveness witness and ordinary current-selection completion.

actual body red `811ac360c67ebd4c` confirms detached source survives forced Chromium collection while Ask creation is held. scalar selection identity/ref cleanup preserves selection behavior but leaves the same collection failure (`dfff5f998d83af76`). temporary heap diagnosis `06fe0f6610573cd0` finds the live retained path through pane chrome → React alternate menu-action props → body callback context → prepared-state queue → released `PreparedReaderUnit.view.root`. `publicationDom.ts` removes the root and releases its DOM reservation but its returned projection still exposes raw root/cursor/resource references. the diagnostic retained only the minimal path in its24kb receipt; no heap artifact is stored. clear the existing prepared projection at release, and keep raw borrow lifetimes within that owner.

after that projection repair, diagnosis `9ed91990378d347b` identifies a second path: pane header alternate action → `captureCurrentLocatorRef.current` → body callback context → `epubTextDocumentContentState.preparedRoots` → retired root. the viewport callback needs only readiness, so capture that scalar instead of the prepared-root object. current-map imperative reads must also avoid already-released render snapshots. no heap artifact or diagnostic parser remains. the coupled retirement/navigation proof is pending.

the actual body collection and exact acknowledged Ask destination both pass in `37d5484723bad8d2` (814ms), together with ordinary selection, highlight outcomes, body navigation, and native shelf cases. that command fails later because the shared Find fixture did not publish its retired prepared-root list before rerender; its correction keeps the behavioral assertions intact. this is DOM retirement evidence, not decoded-payload or final capacity qualification.

parent review found the same stale borrow in hosted reset eligibility, artwork layout publication, automatic positioning, and internal-link origin (`MediaPaneBody.tsx:2509,2703,2828,7295` before the repair). source cleanup clears the current map before later effects can consume the old render array. those imperative reads must use the current map, preserving the React render snapshot and requiring mounted positioning roots.

`SelectionPopover.tsx:136` also retains the Share trigger button through highlight creation and return-focus options. include actual detached-button collection while preserving the acknowledged Share destination; a current return-focus lookup must not retain the retired trigger.

source-payload audit remains separate from the dom collection oracle: `DocumentReaderSession.ts:379–427` leaves the settled unit promise holding `{address, unit}` after `release()` returns its payload charge. `MediaPaneBody.tsx:1580–1599` also copies the active canonical slice and retains its unit in `activeContent`; callbacks that need this only before an await can keep that source reachable. this is a structural retention hazard, not a measured leak. after the dom repair, verify that pending-write continuations retain only scalar write identity and bounded presentation state; do not infer payload retirement solely from detached-node collection.

actual shared-unit red `8802ec32ae19c7cc` holds the two public result handles, releases one consumer, clears the cache, then releases the last consumer. the raw unit remains reachable after exact session occupancy returns to its prior value. the reviewed candidate clears existing cache/session handles and preserves the clearing getter through the window; borrowed promises obtained before release remain ordinary irrevocable promises.

actual Share red `3ed208243dd68fb1` first verifies live dialog return focus, then holds a second write and unmounts its selection popover. the retired trigger remains reachable. the same command passes all three newer/same-coordinate text-selection cases. the PDF draft initially passes its text-node oracle (`714c689cc4d30581`); source-root collection is being checked separately because SDK teardown can remove text children and collapse a live Range to an ancestor. no PDF defect fix is justified by the text-node result alone.

actual PDF ancestor proof `1eb9f0f2f8b3e32d` fails after physical worker
retirement. adding scalar selection identity and clearing the captured selection
still fails the same source-root assertion in `4ddd3aefd5aa5c63`. that run bails
in the create case; neither the update case nor the separate raw-payload owner
executes. the remaining retaining path requires diagnosis; no PDF collection
fix is established.

retainer diagnosis `7169ec7b50a1d70a/retainer-pdf-region.json` finds the
pdf.js localization collection: `AnnotationEditor._l10n` →
`GenericL10n.#elements` → retired reader region. `pdf_viewer.mjs:8024,8066`
creates localization and translates the container; `setDocument(null)` at
8355 does not release it. the public `destroy()` at 3726 disconnects and
clears its roots. the scalar-selection change was reverted before the
selector-backed baseline `be8ff5fd9322fcac`, which still fails region
collection. release localization in the existing viewer teardown; report
rejection through existing telemetry without poisoning a replacement reader.
verify physical worker retirement, region collection, and exact create/update
acknowledgment. this is a separate sdk owner from pending-write ranges.

share diagnostic `66d97c4abe8dfa7f/retainer-share-trigger.json` also found
a test-owned retaining path through Vitest completion diagnostics and an
element-backed locator. selector-backed role clicks remove that accidental
fixture reference; the same collection assertion remains red on baseline
`10b2a292db66f5a1` and clearable-trigger-only `a3105ccae80e165d`.
the return-focus capture still requires an actual candidate replay.

standalone raw-payload retirement passes `5682dc44efbff485` after the
observed `8802ec32ae19c7cc` failure. integration and enclosing capacity
qualification remain pending.
