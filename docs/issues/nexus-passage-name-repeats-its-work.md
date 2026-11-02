# a passage row's name says its work twice

status: open · origin: 2026-11-02 palette s3 lab · area: web / nexus rows (rowFacts, s1)

a passage row is now titled by its work (`preview.source.title`, the row sheet).
its facts still come from `resourceMetadataText`, whose `source` part is that same
work, so the spoken name reads `{work}. {author} · {work}. {window}`. the facts line
is not painted on a passage row (evidence wins), so only the name repeats.

evidence: lab run `20261102-120048-554a7e7740c0`, palette-05 chromium, word
`generosity`: row named `源氏物語 — The Tale of Genji, selected chapters. 紫式部 ·
源氏物語 — The Tale of Genji, selected chapters. Chapter 2: Longing …`.

impact: screen-reader users hear the work twice on every passage row.

fix: `rowFacts` (or `resourceMetadata`) omits the `source` part when the row's
title is that source; `nexusRowPrimaryText` already owns the title.

resolved when: the same row is named `{work}. {author}. {window}`.
