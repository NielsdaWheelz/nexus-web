status: open
origin: 2026-09-14 bounded-workspace capacity run 71e44d03ca91ca18 at 1700c6d987
area: resource graph / bulk deletion

cleanup after the real 4,100-chunk index fails in
`python/nexus/services/resource_graph/cleanup.py:241`: the tuple `in` predicate
expands 8,200 evidence-span/content-chunk identities. the owned postgres log at
2026-09-14 09:20:31.286 utc reports `stack depth limit exceeded` for the
`select distinct resource_edges.source_scheme, resource_edges.source_id`
link-note query. the pytest tail loses this heading under the expanded sql.

replace corpus-shaped predicate expansion with bounded relational operations.
preserve both link-note attachment halves, view-state deletion order, cited-edge
survival after target deletion, and transaction ownership. inspect the other
tuple predicates in this owner. do not raise postgres stack depth or shrink the
accepted source fixture.

acceptance: real large bulk deletion succeeds with the same graph semantics;
the original query fails the sensitivity case; the enclosing capacity run
cleans its owned media successfully without masking another failure.

implementation is staged: the cleanup owner consumes a two-column sql relation;
index callers retain their owner-filtered span/chunk selects, and apparatus uses
one typed uuid-array relation. unchanged actual proof bytes
`b6b79e3473b647593be783baf49f97aa24fab3ad2b1de063e7f7f811b7e5b943`
fail the original product at 4,100 chunks in `92dcc198b03b7568` and pass the
candidate in `d428a08c7a4c11bc` (all four cases). statement count/text remain
13/1,103 bytes at both tested cardinalities. enclosing capacity cleanup remains
pending, so this ticket stays open.

normal-base canonical proof is green `41095ab2b2b42b75` at `2fa900ad8f`.
original base `7fa89b88` reaches the same exact stack-depth assertion at 4,100
chunks with the unchanged proof overlay; candidate passes. no coherent-owner
exception. retain this ticket until the enclosing capacity teardown succeeds.
