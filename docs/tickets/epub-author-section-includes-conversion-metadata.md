# an author section retains conversion metadata in its extent

status: open; inherited historical extent, separate from the accepted edition-root improvement
origin: 2026-10-15 retained-book review, frozen operator `150328b65`
area: epub reading-division boundaries

for `682e1242-844a-448f-a65c-704cbe1f6332`, the existing `About the Author`
heading spans `58:0–60:0`. this includes the separate 213-character
`OEBPS/fb2info.xhtml` at index 59, with conversion information, document-author
and source-url headings. its parent relationship to the author heading is
also preexisting. the candidate transfers that exact extent and relationship
to the same-point publisher section; it adds no author-section coverage.

original NCX independently identifies the author/work root as an edition
aggregate containing all 53 chapters and the author section. that supports
the separately approved root expansion; it does not establish that conversion
metadata belongs to the author biography. the distinct converter `About`
section at index 60 remains outside the proposed edition root. no stored
text loss, new author-tail regression or fresh-stack reproduction is claimed.

private evidence: `c-sources/navigation682-work-root-review-v1.json`, sha256
`61c3f66fc180be3627ae734107436d104d52dd4079af1f3913faa1874f36a586`;
independent full-projection review `a-maintenance/navigation682-independent-review.json`,
sha256 `9d8e4d02e1d58302e62e29a59add639826f3f8a2cb8339cbfbbf3096ca8bc477`.
both bind the exact original, retained fragments and complete proposal.

establish the author biography's independent boundary at the structure owner
before changing it. acceptance: preserve the edition root and every source
destination while giving the author and conversion material source-supported
scopes; verify the fresh complete proposal and reader behavior. do not infer
an edition-wide prohibition on metadata from this narrower question.
