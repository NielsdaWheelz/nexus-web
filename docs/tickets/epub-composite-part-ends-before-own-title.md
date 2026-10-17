# a composite part ends before its own title

status: open; whole-book repair unsafe, not applied
origin: 2026-10-15 book-repair original/retained-source review, operator `150328b65`
area: epub composite heading ownership and section extents

media `ee255f6b-aecb-408a-97c1-2fee04ca4b08` begins its first part with
adjacent h1 headings `BOOK I` at `13:0–6` and `MISS BROOKE` at `13:8–19`,
then `CHAPTER I` at `13:21–30`. the existing publisher part label is
`i. Miss Brooke`. its proposed end becomes `13:8`, excluding its own named
title and subsequent chapter. the previous end was null; this finding does
not endorse an old extent or claim installed text loss.

the original and retained canonical text match all 244,931 characters.
`python/nexus/services/epub_structure.py:359` matches a heading or an exact
adjacent label pair; this publisher spelling does not match `BOOK I` plus
`MISS BROOKE`. the anchor still associates the part with the first h1, while
the title remains a distinct same-rank section. the depth-based range owner
in `reader_structure.py:103–107` closes the part at that title. composite
division ownership must be proved before asserting a finite range; a bounded
end is not sufficient evidence of a valid reading division.

exact original member, retained row and complete proposed metadata:
`b-reader/three-navigation-boundary-review-v3/ee255f6b-aecb-408a-97c1-2fee04ca4b08.json`,
sha256 `4067d01b867a2a1e8e5a9b76c6985fb3c8effca03c49c1ae9805b68efaea8e3f`;
independent `a-maintenance/two-b-navigation-boundaries-independent-review.json`,
sha256 `1d080de77eb5ea87f1a6c0318ac8ae33af6c63e06240f2acd8c73b7495f30822`.
the failed local read gate and separately admitted continuation remain in the
execution history. other fields, apply and reader consumers are unadjudicated.

fix the shared section owner without a book-specific spelling rule or broad
permissive matcher. acceptance: the real-source full proposal retains the
authored composite part and its chapter scope, or refuses the unproved range;
also preserve a genuinely separate same-rank heading. qualify full installed
extents and consumers before applying this book.
