# title-only containers truncate publisher reading ranges

status: open; whole-book repair unsafe, not applied
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

`python/nexus/services/epub_structure.py:700` assigns the local container end
to the merged owner. `reader_structure.py:112` uses that end for the reading
division; `epub_read.py:128` exposes it as the section extent. establish whether
the local container owns the whole publisher division before clipping its
range. preserve genuine container boundaries; do not special-case this book
or discard all source container bounds. this shared range-owner fix is outside
the bounded repair campaign.

acceptance: the real-source full proposal preserves the three authored body
scopes and all section identities, hierarchy and destinations required by the
reviewed contract. also verify a genuine container that ends before the next
publisher division. qualify complete installed extents and reader consumers
before applying this book; other proposal fields remain separately reviewed.
