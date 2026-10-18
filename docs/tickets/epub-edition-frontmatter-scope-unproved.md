# edition-title ownership of editorial frontmatter is unproved

status: open; source-unproved, whole proposal unapplied
origin: 2026-10-15 book-repair original-source review, operator `150328b65`
area: epub reading-division scope

media `33138ad0-2215-49e6-b471-e5cb47660d9e` changes the edition-title
heading at `4:0` from an end at `7:0` to `12:0`. acknowledgements,
introduction, note on the text, bibliography and chronology become its
children. the original document contains the title, editor/introduction/notes
credit, publisher image and a page break. a separate work divider at `12:0`
is explicitly targeted by the original ncx.

the edition title could plausibly introduce this editorial frontmatter.
the acquired source does not explicitly name it as a bounded title-page
navigation entry or establish an editorial group. neither a safe complete
scope nor false containment is proved. flat ncx roots alone do not decide
reading-division hierarchy. keep this distinct from a source-named title
page: that proved page role does not establish this edition-level grouping.

evidence: `b-reader/two-title-scope-source-review-v2/receipt.json`, sha256
`c678a786a6bd54b617a369b705b5b6e788ae1e4bcf3eba3e1e9600804526e0bc`;
independent review `c-sources/two-title-scopes-independent-review.json`, sha256
`c2d54e8e3cd73ad247a05dce9245e9260acb16166cb5287cd8ce1fb2ef53875a`.
the exact two original body documents match the retained canonical text.
source sha256:
`cfd2c12065eecb23411c2ba49f8a69e535ee30a8fc3c3f3642be0925de7577b5`;
complete proposal sha256:
`75a03d10a72db03be9fe47273ba0dc2feee26a513b79895dfa8523c312263800`.
the 58 original note bodies have a separate source proof. all other changed
fields, apply and reader consumers remain unadjudicated.

acceptance: obtain concrete edition-level evidence for the proposed group
and its end, or retain an explicitly unresolved scope in the shared section
owner. then complete every remaining field and installed-projection check
before admitting the whole proposal. no book-specific heading exception or
global flat-outline rule is justified by this evidence.
