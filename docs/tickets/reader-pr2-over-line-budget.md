# the reader rewrite is over its line budget

status: open, needs an owner re-plan · origin: 2026-10-05 reader rewrite pr2 · area: web reader

the design's gates (formatted with prettier 3 defaults, `budget.sh final`):
`lib/documentReader` ≤ 4,200 and the whole web reader scope ≤ 9,000. measured at
pr2 after its review fixes: the primitive is **4,519** (+319) and the scope
**10,597** (+1,597): primitive 4,519, hosted pane 4,277 (design 3,263), the link
composer 378, public `/s` 427, `lib/canonicalText` 486, `lib/reader` 293, html
renderer 164, action intents 53. before the rewrite the same scope was 26,675
(the replaced files alone 36,495).

the link composer (`lib/resourceGraph/useLinkComposer.ts`) moved out of
`lib/reader` unchanged. the design listed it for deletion (re-authored inside the
verbs), and its only consumer is the pane's `useAnnotationVerbs`, so it counts
here; pr2's first figure (10,192) left it out.

where the primitive grew past its plan: `text/paint.ts` 310 (plan 140: the probe's
conditions — segment index, robust caret hit-test, lazy window, the webkit
registry-order workaround), `PdfSurface.tsx` 573 (pane width at scale 1, refit on
resize, chrome hold while pdf.js scales, page lookup by box), `DocumentReader.tsx`
355 (230), `runtime.ts` 372 (280), `model.ts` 323 (250), `progress.ts` 329 (270),
`scrollport.ts` 136 (unplanned file). the hosted pane exceeds its plan in
`MediaPaneBody` 639 (420), `chrome.tsx` 481 (280), `useAnnotationVerbs.ts` 534
(320), `EvidenceRow.tsx` 400 (340), `SelectionDock.tsx` 332 (230).

valves spent: (1) crowded rail ticks open the first marker, (2) no note-marker
hover preview, (3) the document scope folds into one evidence group, (4) rail
previews are `title` text. not spent: (5) sentence focus folding into paragraph
(−~30; d9 is not signed, and it would not close the gap). the gate was not raised.

decide: accept the measured sizes as the gate, or name behaviour to cut (candidates:
the g-chords, the transcript show-notes parser, evidence associations, the pdf
pane-width negotiation, sentence focus, the link composer's per-code error copy).

done when: the owner accepts a new gate or the cuts land under the old one.
