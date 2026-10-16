status: open
origin: 2026-10-16 selection-popup phone acceptance
area: reader native selection admission

a stationary touch tap can reopen an old native-selected passage instead of
the saved mark being tapped. this is an application admission defect; a native
first tap may clear selection, but must not create fresh intent for unrelated
old text. no write or draft loss occurred in the observed sequence.

evidence: android chrome, samsung sm-s906w, 360 × 651 css pixels. arm bounds for
the blue unit-two highlight, select “deliberate” in unit one, cancel the
wrong-unit mode, navigate back to unit two, then tap the blue mark. a fresh
yellow composer opens for “deliberate” with an empty editor. clearing native
selection and dismissing that composer lets the next mark tap restore the
correct blue highlight and retained draft. receipts:
`/tmp/nexus-selection-popup-phone-proof/green-receipt.json` and
`bounds-cancel-reopen.png`. selection was not sampled separately between
cancel and navigation, so the precise browser event ordering is unproven.

`apps/web/src/lib/documentReader/selection.ts:80` discards the prior touch range;
`:93` admits any range still selected at pointerup and suppresses its click,
without proving this gesture selected it. the same path exists at baseline
`ff57128842b470510446b3edca54922ebcace41e:84`–`:90`.
`text/TextSurface.tsx:225` independently declines mark clicks while native
selection remains noncollapsed.

fix at the shared selection-admission owner after tracing this native event
sequence. distinguish a completed selection gesture from a tap with an unchanged
old range; suppress the click only for a selection owned by that gesture.
preserve native clearing, long press and already-admitted handle adjustments;
do not globally clear selection or bypass the mark handler's selection guard.

resolved when the phone sequence never reopens an unrelated passage and normal
native clearing still works; a subsequent mark tap restores its retained draft.
real long press, handle adjustment, mouse drag and keyboard selection must still
admit the intended range once. verify that cancelling bounds causes no write.
