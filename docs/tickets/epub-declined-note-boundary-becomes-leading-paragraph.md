# declined note boundary becomes a leading-paragraph body

status: open; whole-book repair unsafe, not applied
origin: 2026-10-15 book-repair original-source review, operator `150328b65`
area: epub apparatus boundary and target collection

media `b13e55e0-03d0-4212-a6f7-eaee1f306fbc`, target
`OEBPS/Text/part0036_split_000.html#footnote_number_40`, has a 457-character
leading paragraph and an 88-character unnumbered paragraph before its
repeated empty pagebreak delimiter. numbered note 41 follows that delimiter;
note 39 uses the same boundary before note 40. the proposal keeps only the
leading paragraph. this source interval establishes the omission without a
prose-topic inference or a universal adjacent-paragraph rule.

`python/nexus/services/html_apparatus.py:1471` declines complete body HTML
when `_inferred_note_html` reaches the non-paragraph pagebreak. collection at
lines 646–654 nevertheless substitutes the leading paragraph text and labels
the result `html_note_boundary` / `strong`. materialization at lines 1240–1278
also reconstructs the leading paragraph. this differs from collecting a
complete rich body and subsequently dropping its continuation.

private source/actual-owner proof: `b-reader/b13-note-boundary-review-v1.json`,
sha256 `425cf25ec4279b9cc7e0418a731d3ddcef1cd6c6edbb9c643cc5075c37063c05`;
independent `c-sources/b13-note-boundary-independent-review.json`,
sha256 `16a321f3796cfd34120c06e049a50d65d38347b6f86aaa91d20af3bf72ccbe4c`.
source `6057403765e4856d257611fe848112edb73c495f13476c6101a11f08efe6a8e4`;
generation 2 proposal `891500c98b643169d7529c3bf2ac5c240d926f73df5c05e856458dc33d750a43`.
the receipts bind the verified original, eight consecutive source nodes,
reciprocal pair, actual proposal and declined-boundary reproduction. unrelated
fields remain unadjudicated. no installed-text loss is established.

fix the shared boundary contract: a declined complete-body boundary must not
become a strong partial-body target. retain an explicit unresolved outcome
unless source evidence proves the complete interval; preserve proved rich
content through materialization. no book-specific separator patch or generic
paragraph fallback. this extraction change is outside the bounded campaign.

acceptance: the real-source preview either preserves the complete proved note
or refuses its unproved boundary, never emits this 457-character partial body
as a complete strong note. qualify the full book proposal and normal readers
before applying it; retain successful single-paragraph note behavior.
