# title-page containers override cross-document publisher divisions

status: open; three whole-book repairs unsafe, not applied
origin: 2026-10-15 book-repair retained-source review, operator `150328b65`
area: epub section ownership and semantic extents

media `a48ee710-ceb9-4428-a67e-da5e7870d634` splits three title pages from
their following body documents. each title is the only text in a local
`section`; the next original-spine document contains its heading-free prose.
the old publisher division covers both. the candidate merges the heading into
that division but ends it at the title container, excluding the body:

| title/body fragment | old end | proposed end | excluded body characters |
| --- | --- | --- | ---: |
| 7 / 8 | 9:0 | 7:7 | 2,882 |
| 13 / 14 | 15:0 | 13:10 | 50,759 |
| 47 / 48 | 50:0 | 47:15 | 1,299 |

all 54,940 characters in those three body documents fall outside every
proposed section range. stored fragments and prose remain intact. the proposal
is withheld; this is no claim of an executed api, browser or device failure.

the original opf spine, exact retained html/text and full reconstructed final
proposal are bound by private receipt
`c-sources/navigation-a48-split-body-review-v1.json`, sha256
`508e7ca71a59ea1d15499a705fb915ca88c5a38ecb5e8975f8f575701a6a3d4c`.
independent review:
`a-maintenance/c-a48-split-body-independent-review.json`, sha256
`70290acf6301148e1d94061ed43d181bf817aeed8eb3a0cf594fc6f632573761`.
source sha256: `ca3c1b5be7702414ec425d25485bdc90fdb2e44f1326c98c0ff57e8201f5285c`;
proposal sha256: `7b008be2bf5306143be458ca705a6f5c47bebc26a75a96b110f95a181ddeb654`.

media `f0c3a6f6-e336-4ff8-bd0f-2dbb90d4a32b` (cyberiad) exposes a second
effect of the same ownership mistake. two original title pages explicitly
declare `epub:type="part"`; the admitted child documents declare `chapter`.
both original nav and ncx assign twelve chapters to those parts. the candidate
removes all twelve existing section memberships because the chapters extend
beyond the part's local title-page container. the full toc still preserves
those destinations and memberships; the loss is in reading-division hierarchy.
old part extents were already incomplete and are not endorsed by this finding.

exact original roles, both outlines and the complete proposal are bound by
`b-reader/cyberiad-authored-parts-independent-review.json`, sha256
`c41522546f0dd4778aa577507011256de0b05d2fe825b2cf97e26928a766426f`,
and independent reparse `c-sources/cyberiad-authored-parts-peer-review.json`,
sha256 `78b5581410969d0c1eb7013ee5b2eae0f20d7401291e70451ced90de32df7788`.
source sha256 `2a7f673fe5bab29b4a1194c72ad1aee51298235a2d41c572d8e893b210f1ac69`;
proposal sha256 `c6e6319f6bef510e35f9a9e561fc21735321de04067e0f748b374da73345258c`.
this is explicit authored part membership, not a rule requiring every semantic
section to copy a flat publisher outline. stored text remains intact; no
runtime consumer failure was executed.

media `cf26ed31-1cf3-433f-b310-ee923e197652` supplies another explicit
part-membership failure. the original title page has the adjacent `PART I`
and part-title headings; its first chapter has a separate numbered chapter
title. the declared ncx assigns three chapters to that part. the proposal
clears all three memberships while retaining the part title and clipping its
extent to the local title page. only these three source-proved memberships
justify this refusal; other changed memberships and fields are unadjudicated.
the old part extent was already incomplete and is not endorsed.

evidence:
`b-reader/three-navigation-boundary-review-v3/cf26ed31-1cf3-433f-b310-ee923e197652.json`,
sha256 `d976f8fdb8494bf7cd1666c82756d6fe5adf567e88dfe09589d0a895815ab834`;
independent `c-sources/cf26-authored-part-independent-review.json`, sha256
`87dff4362d6ae1de3c08b08a78fe70c404b7dff9aa2ea200ce1808dacd7d82c3`.
the original source, five admitted members and complete final proposal are
bound. its separately proved note bodies do not authorize this hierarchy loss.

`python/nexus/services/epub_structure.py:700` assigns the local container end
to the merged owner. `reader_structure.py:112` uses that end for the reading
division; `epub_read.py:128` exposes it as the section extent. separately,
`epub_structure.py:767–778` clears publisher parents when a child's container
extends beyond its parent's container. establish whether the local container
owns the whole publisher division before clipping its range or removing its
authored child membership. preserve genuine container boundaries; do not special-case these books
or discard all source container bounds. this shared range-owner fix is outside
the bounded repair campaign.

acceptance: the real-source full proposal preserves the three authored body
scopes, cyberiad's twelve authored part memberships and cf26's three proved
part memberships, with all section
identities and destinations required by the reviewed contract. also verify a genuine container that ends before the next
publisher division. qualify complete installed extents and reader consumers
before applying these books; other proposal fields remain separately reviewed.
