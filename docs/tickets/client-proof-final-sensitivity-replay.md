# replay the consolidated client proof owners

status: open
origin: 2026-09-14 consolidation, delivery 318747fb5c
area: client canonical sensitivity and combined replay

six whole-file owners are now registered in `testdata/proofs.json`, but none has
an established canonical fault/owner pin: `MediaPaneBodyLayerReplacement`,
`MediaPaneBodyPendingWriteRetirement`, `MediaPaneBodyHighlightSelection`,
`SelectionPopoverShareRetirement`, `PdfReaderPendingWriteRetirement` and
`ReaderUnitPayloadRetirement` (each `.browser.test.tsx`). new Find preparation
recovery and PDF resume extremes also exceed their existing faults' contracts.

historical evidence is narrower than the consolidated source: Share
`a8105e6a22503739` passes with both fixes and `45a7542fc31dc94e` fails with only
weak focus; text Ask `52dd912fdbda1142` red → `7ae56c4826ee2c5d` green; PDF
`be8ff5fd9322fcac` red → `7c0e3c428b6814cb` green; payload
`8802ec32ae19c7cc` red → `5682dc44efbff485` green. combined
`e7dfd613c31bfce0` covers the corrected payload/PDF owners, not the later batch.
layer `208a68579051863f` failed before its intended DOM-refusal oracle; Find
`29368beb978cb403` still lost explicit recovery. new PDF extremes are unrun.

prerequisite: commit the reviewed registry and source together. select the exact
whole-file owners through `./scripts/test changed`, preserving all assertions.
qualify BASE or an independently reviewed product fault; do not invent a
coherent exception or refresh a pin merely to bypass policy. demonstrate actual
layer refusal, explicit command retry and the clamped/no-delta PDF outcome.

acceptance: each owner routes once, exact old-source red/current-source green
reaches its behavioral oracle, and the consolidated branch passes. preserve
source geometry, acknowledged destinations, newer selections and single-GC
retirement boundaries. record receipts in the client dossier before closing.
