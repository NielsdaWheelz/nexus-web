# local excerpt table scope

the local authored excerpt query admits a table whose reading excludes empty
cells. canonical text offsets cannot prove admission of zero-text structure;
the server already withholds this case.

evidence: `node/authored/src/queries.ts`, real shared-worker query in lab
`20261028-150024-1fb309d7f2f4`, source snapshot `5efb89d5`. the six-cell source
table survives capture, but the partial reading returns content instead of
unavailable. the source-alias positive control passes.

resolved when local scope carries adequate structural admission proof, this
partial table is withheld, and an admitted complete table still opens normally.
