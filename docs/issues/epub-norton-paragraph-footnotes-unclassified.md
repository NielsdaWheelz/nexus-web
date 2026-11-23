# norton paragraph footnotes are absent from reader apparatus

status: open; candidate extracts proved notes, with 96 source pairs unresolved
origin: 2026-11-21 moby-dick chapter investigation, main `06419a76d`

norton media `39cc0b8a-20f0-40e5-a7df-960a27c22f3e` has zero stored apparatus
items and note groups; a fresh main parse has the same result. its original epub
contains 1,400 reciprocal numeric markers in `span.fn-ref > a`: 1,334 same-file
and 66 cross-file. including the related `fn-ref1`, `fn-ref2` and `fn-ref3`
families gives 1,496 reciprocal, label-matched pairs, including 89 symbol notes.
all pairs bind at both ends to unique retained anchors with matching labels and
normalized hrefs. these source class names describe this observation; they are
not a proposed global classification rule.

example: `text/part0014_split_000.html#rfn_1` targets `#fn_1`, whose enclosing
paragraph begins with an anchor returning to `#rfn_1`. source size and hash are
recorded in [the chapter issue](epub-internal-chapter-contents-not-detected.md).

impact: ordinary hyperlinks remain, but shared note inspection and note-region
exclusions have no representation of these editorial notes. this does not cause
the missing chapter starts, but must inform review of proposed chapter extents:
some intervals contain pooled editorial notes for preceding chapters.

`python/nexus/services/html_apparatus.py:737` and `:1364` require literal `sup`
for generic numeric markers. a disposable exact-source probe admitting
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

the window/target census leaves 47 singleton pairs without a corroborated
same-division peer, 46 final bodies without a proved close, and three pairs
without complete continuation or target proof. their authored links remain
ordinary usable links. resolve a singleton by establishing a bounded source
collection or a matching peer in its proved division. resolve a final body
with a source-proved closing opening or container end. resolve uncertain
continuations with an independently corroborated block shape and complete
retained correspondence. accept only pairs whose entire clipped body and edge
can be verified, and preserve the 1,400 placed pairs and existing chapter cuts.
