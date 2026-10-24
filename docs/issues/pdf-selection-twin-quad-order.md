# pdf reselection can miss an existing highlight because quad order differs

problem: a fresh pdf selection preserves source rectangle order, but stored pdf
geometry is sorted canonically. `annotations.ts:95-96` compares anchors with
order-sensitive json, so an equivalent range can miss its saved highlight and
open a blank composer. the saved note remains intact; backend extent deduplication
does not repair this client-side lookup.

evidence: merged source `ac3b0aa9c`, also present on main `4acdadc1d`.
`python/nexus/services/pdf_highlight_geometry.py:100-101` sorts quads by top,
left, bottom and right. the disposable pdf case saved quad tops in source order
`58.331, 80.494, 79.294, 100.238`; the map returned
`58.331, 79.294, 80.494, 100.238`. after reload, fresh passage rectangles had
the same dimensions and source order, but a new blank note opened. original
save and subsequent highlight/note reads passed. private evidence:
`~/.local/state/nexus-verification/mobile-selection-20261023/lab/`, run
`20261023-202508-bb901c52f62a`, artifact
`artifacts/playwright/mobile-selection-merge-mer-b390d-g-and-explicit-editor-focus/trace.zip`.

reproduce: select several pdf lines whose native range emits overlapping span
and text boxes, save a note, reload and select the same passage again. compare
fresh source quads with the stored anchor before opening note.

repair equivalence at the client identity/comparison owner using canonical copies;
preserve source order for endpoint measurement. resolved when an equivalent fresh
range finds the existing highlight and viewer note, while a different extent
still opens a distinct draft. saved-mark entry must remain usable throughout.
