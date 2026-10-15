# distinct source notes can share a proposed whole-paragraph body

status: open; exact source-boundary review pending; both repairs unapproved
origin: 2026-10-15 retained-book rehearsal, candidate `150328b65`
area: epub apparatus / source note boundaries

retained-source review found that kjv `228d14cf` proposes 45 notes from
30 source paragraphs; one paragraph contains 16 distinct reciprocal targets.
kjv `20405d0e` proposes 65 notes from 11 paragraphs, with up to 15 targets
sharing a paragraph. each group currently receives its whole paragraph as
the body. authored `footnote`/`footnote2` classes and separate numbered return
anchors require examination before treating that body as one logical note.

private diagnostics under `book-repair/b-reader/`:
`228d14cf-source-structure-diagnostic.json`, sha256
`ab918bd474c7771d041a6baed275161ced1e46c5e161ffd0c0032766d0c325d5`;
`20405d0e-source-structure-diagnostic.json`, sha256
`34622eae6da1e3de7127ed164063bf514bb929187f2bbb2ef52bba4359b03109`.
the maintenance-budget proof passed separately; no repair was applied.

next: prove exact authored marker/body boundaries in both originals and trace
the shared extractor's selected container. refuse unsafe proposals. any fix
belongs in that shared owner, with precise per-note correspondence; do not
slice generated prose or add book-specific exceptions.

acceptance: each proposed body and reciprocal relation matches its authored
note, including grouped paragraphs, or each affected book has an explicit
unsafe-source-proposal disposition and remains unapplied. performance success
must not be reported as content acceptance.
