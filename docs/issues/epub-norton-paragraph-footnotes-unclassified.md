# unresolved footnotes in the norton moby-dick

status: open. main extracts 1,400 of 1,498 known reciprocal note pairs.
origin: 2026-11-21 moby-dick chapter investigation, main `06419a76d`

the 2026-11-21 capture of norton media `39cc0b8a-20f0-40e5-a7df-960a27c22f3e`
had zero stored apparatus items and note groups. a fresh parse at `06419a76d`
gave the same result. the original epub contains 1,400 reciprocal numeric
markers in `span.fn-ref > a`, with 1,334 same-file and 66 cross-file. including
the related `fn-ref1`, `fn-ref2` and `fn-ref3`
families gives 1,496 reciprocal, label-matched pairs, including 89 symbol notes.
all pairs bind at both ends to unique retained anchors with matching labels and
normalized hrefs. those class names identify the original sample. scanning named reciprocal
links independently of their wrappers finds two more asterisks, on the title
page (`text/part0010_split_000.html#rfn_`) and in the contents
(`text/part0011.html#rfn_1`). neither has an apparatus body on `d77bffa5c`.

example: `text/part0014_split_000.html#rfn_1` targets `#fn_1`, whose enclosing
paragraph begins with an anchor returning to `#rfn_1`. source size and hash are
recorded in [the chapter issue](epub-internal-chapter-contents-not-detected.md).

an unresolved marker retains its source link in the full book. the reader
lacks a note to inspect and a range to exclude from routine navigation.
some intervals contain pooled editorial notes for preceding chapters.

at `06419a76d`, `python/nexus/services/html_apparatus.py:737` and `:1364`
required literal `sup` for generic numeric markers. a disposable exact-source probe admitting
`span.fn-ref` as well produced 1,393 notes, but 126 bodies included `CHAPTER n`;
the longest body was 55,805 characters. every locator still reported exact.
the body scanner at `:1492` stops at heading tags but can consume paragraph
chapter headings. coordinate precision does not establish semantic ownership.

complete bodies also need positive continuation evidence: note 570 continues
into `p.fntx`; note 943 includes verse paragraphs and subsequent prose. symbol
returns may sit in `span.start` inside `p.fn-new`; the inline wrapper alone is
not the body. 26 numeric markers occur in chapter-title paragraphs, so requiring
a long prose parent would also discard valid notes.

the 2026-11-23 source audit found all 1,496 returns in sibling runs beginning
immediately after `hr`. multi-note runs supply 1,436 candidate body ends before
continuation checks; 47 singleton notes and 13 terminal bodies need additional
evidence. 43 singletons have same-parent multi-note peers. 14 of 17 terminal
windows have an independently identified opening in the next spine file; the
ends of `text/part0020.html`, `text/part0021.html` and
`text/part0030_split_000.html` do not yet have that evidence. these are candidate
geometry counts, not a claim of complete extracted note bodies.

resolve at the apparatus source owner using independently evidenced note
direction and complete body boundaries, with exact retained-coordinate binding.
reciprocity alone must not turn the book's chapter-index links into footnotes.
verify representative multi-paragraph notes, markers, backlinks and chapter
navigation while preserving canonical text and existing link destinations.
metadata-only repair is possible only after proving complete body ranges against
the retained html; exact marker/return binding alone is insufficient. publish
through the representation owner with existing apparatus reconciliation and
dependent-reference fences. verify hosted activation and disconnected authored
link behavior.

the candidate's actual fresh and retained derivations produce 1,400 complete
bodies, 1,400 exact reference locators and 1,400 edges. the retained derivation
uses the original fragment ids and changes no source html. source body clipping
agrees for the opening numeric note, one cross-file note, the symbol note, the
two-paragraph note 570 and the six-paragraph verse note 943. live installation
and consumer checks are separate release steps.

of the original 96 omissions, ten are in numbered chapters, one in “etymology”
and 85 in supplementary material. 47 are singletons without a corroborating
peer, including 37 that also lack a recognized end. another 46 lack an end,
and three have unproved continuations. all ten chapter cases occupy a single
paragraph between a divider and a proved chapter opening.

79 of the 83 missing ends precede a byline or figure title identified by both
the package ncx and the reciprocal html contents. four reach a file end.
at `text/part0029.html#fn_20`, the quotation in the second paragraph belongs
to the note. the following byline begins the next review. at
`text/part0030_split_000.html#fn_38`, the following sibling is a figure whose
first paragraph holds the title target `#h1_81`.

in a local counterfactual on `d77bffa5c`, supplying 99 corroborated paragraph
openings to the existing detector recovered 44 complete pairs. derivation on
locally retained fragments preserved all 1,400 prior bodies and locators, all
266 sections and the contents. clipping the publisher's note paragraphs
separately reproduced the rich body and plain text for all 1,444. qualification
on other books and the installed copy is open.

the follow-up release requires a real non-norton recovery for each new rule:
one editorial note end and one lone chapter note. the editions may differ.
a source-only screen of 397 local epub paths (396 readable archives) established
neither positive. pin each qualifying original, marker, body and baseline miss
before counting it. the existing 1,400-note release has its own qualification.

resolve further cases with independently corroborated note roles and complete
body intervals. a singleton can borrow evidence from a bounded collection
within the same work. every continuation and the marker-to-body edge must bind
to retained source. preserve ordinary source links for the remaining cases.

the candidate on `c08f9fd89` recovers all 54 named notes plus
`text/part0030_split_000.html#fn_38`, whose body ends before the title-first
figure. fresh and retained source yield 1,455 notes and preserve 266 sections.
of the remaining 43, 39 lack independent role evidence, six lack a proved end,
and four need continuation evidence. the reasons overlap. each residual retains
its authored source link. the paired production observation still shows 130
sections and zero note items for the pinned source.
