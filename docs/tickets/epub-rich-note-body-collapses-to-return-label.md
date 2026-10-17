# rich note bodies collapse to their return labels

status: open; whole-book repair unsafe, not applied
origin: 2026-10-15 book-repair source review, candidate `150328b65`
area: epub apparatus / source body ownership

media `ccba64e7-8e7b-4afb-a1d3-f7e498a637e3` has 34 proposed new note
bodies containing only their numbered return-link labels. the verified original
places each label inside an explicit footnote paragraph with additional authored
text. each proposal omits 6–281 characters from that same paragraph. this proves
truncation without assuming the paragraph is the entire note. existing reader
content is unchanged; the whole proposal remains unapplied.

source sha256 `1029e2cb239df1a1654e139fe8613bc93fd0da9527b91d6bcb5dbf0a8f912d91`,
3,240,438 bytes; affected documents `OEBPS/Text/07_Intro.xhtml` and
`OEBPS/Text/191_Back02.xhtml`. private campaign evidence:

- `b-reader/ccba-source-disposition-v1.json`, sha256
  `f4b2b5dcf21a8098a713a1b310a25d592274ca2189081491505ede5262b4d01c`;
- independent original-body review `c-sources/ccba-independent-boundary-review-v3.json`,
  sha256 `5c20f782ca31d8ae0ffaca4690c8dad7c9c6ef8d6dd2dccec59198832ca6b611`.

independent owner trace: `c-sources/ccba-causal-independent-review.json`, sha256
`d9a74c904e71e88f4d69558f2eaff75062f6e4f36d8ed918c4a5f6dcfe67fd20`.

in `python/nexus/services/html_apparatus.py:297–305`, the direct local-target
path derives text from the note body paragraph. line 358 stores rich html from
the smaller target anchor instead. `prepare_apparatus_bodies` at 476–496 then
replaces the text with that anchor's canonical text. text and rich content have
different body owners. this differs from external-target continuation loss.

next: select one source-proved note body for both representations at the shared
extractor. preserve complete rich structure, reciprocal links, source identities
and retained locators. do not substitute a punctuation tweak, a paragraph
fallback or a book-specific exception. this shared fix is outside the bounded
repair campaign.

acceptance: normal ingestion and maintenance previews preserve the authored
content for all 34 notes, with independently proved complete boundaries. verify
the full proposal and reader consumers before applying this book. the unresolved
campaign disposition does not close this defect.
