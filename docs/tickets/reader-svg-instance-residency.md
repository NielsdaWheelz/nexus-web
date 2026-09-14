status: open
origin: 2026-09-14 bounded workspace implementation
area: reader publication / browser residency

the epub sanitizer permits svg `use`, `defs`, and `symbol`
(`python/nexus/services/epub_ingest.py:234`, `:358`). direct render-node
construction bounds authored nodes, but `use` can instantiate referenced svg
content outside that count. authored node admission alone cannot certify browser
scene or heap residency. this is a code-supported hazard, not an observed oom.

prerequisite: the maximum supported svg/figure workload and browser/native
resource budgets are explicit. include repeated/nested svg references in the
figure qualification; establish a bounded instance policy or equivalent
content-preserving representation before declaring the reader profile safe.
do not claim a parser/node factor or silently discard figures.

acceptance: retained fixtures and actual browser/native measurements prove
admission covers instance expansion, including transition overlap; ordinary
svg figures keep their content and selected publication identity.
