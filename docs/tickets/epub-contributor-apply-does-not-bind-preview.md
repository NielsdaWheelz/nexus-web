# contributor apply does not consume the reviewed preview

status: open; no contributor apply authorized by a current proposal
origin: 2026-10-14 book-repair planning at `75b17c030`
area: contributor maintenance / approval fence

`python/scripts/repair_epub_contributors.py:119–184` recomputes the plan in
each apply invocation. its internal source/credit snapshot fences that run,
not the preview reviewed beforehand. `epub_contributor_repair.py:287–328`
also resolves proposed person identities separately for preview and apply;
an alias winner can change while the source and current media credits do not.
the current counts and moved/added descriptions do not identify the full proposal.

prerequisite: the bounded source audit must find an actual correction. its
recorded 244-book preview had zero proposals; do not add code for a no-op.

fix if needed: follow the [book-repair plan](../book-repair-plan.md). bind
viewer/media, source, ordered existing credits/manual state, and complete
proposed rows/person identities in a preview digest. require it and exactly
one media id for apply. compare inside the locked serializable transaction,
before allocation or writes and on every retry; materialize the checked plan.
reject the old bare apply path. no new public endpoint or repair framework.

acceptance: changing only a proposed alias winner after preview refuses with
zero person/alias/credit allocations. source/credit drift also refuses; an
unchanged reviewed proposal applies once and then previews unchanged. reader
state, manual/unrelated credits and existing person identities stay intact.
