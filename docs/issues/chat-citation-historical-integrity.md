# historical chat citation integrity requires a separate audit

status: open; audit not performed; deferred by owner decision 2026-10-20

the raw marker parser at `7dc73d92d8fff5d910bf09131e0fcd56619f1048` can rewrite
code indexes while publishing or stripping citations
(`python/nexus/services/resource_graph/citations.py:33,72-81`,
`python/nexus/services/chat/citations.py:135-180`). saved answers may therefore
contain altered literals or citations derived from code. the reproduced control
flow proves the hazard, not that any particular production answer is affected.

the owner scoped the citation correction to future publication. do not infer
original numbers from the stored answer or silently rewrite historical rows.
a separate audit must establish whether complete original generation output and
candidate/evidence records survive, compare them against published messages,
and repair only exactly reconstructible cases through the owning publication
contract. preserve ambiguous cases for explicit owner disposition.

resolved when a bounded audit identifies affected answers and either verifies
exact content/citation repair from retained originals or records an explicit
owner disposition for unreconstructible cases. missing original output is a
known blocker to automatic repair.
