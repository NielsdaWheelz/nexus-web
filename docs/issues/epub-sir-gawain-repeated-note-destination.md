# 31 sir gawain markers point to note one

the original *sir gawain and the green knight, pearl, and sir orfeo* epub
(sha256 `d9e05e951abd393e23c818cce2e8965f7295e6bd0bf4840d58717115e8a7f8cc`)
has 33 numbered markers in
`OEBPS/text/011_9780007375929_Chapter_1b.xhtml`. only markers 1 and 20
point to their own note. the other 31 authored hrefs lead to
`012_9780007375929_Chapter_1c.xhtml#note1a`.

for example, `#note2` points to `#note1a`, while the distinct body at
`#note2a` returns to `#note2`. reproduce by reading these two members
in the hash-matched original. the private derivative changes 31 hrefs, preserves
the two controls, and passes epubcheck 5.4.0. the exact decompressed member diff
and both digests are in `completion-spec/source-derivatives-20261124/source-diffs.json`
under the epub corpus state directory.

after software release, import the derivative as a separate edition and verify
the complete notes and return destinations for all 33 markers. keep the original
and its saved state.
