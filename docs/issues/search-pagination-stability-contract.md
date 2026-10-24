# search pagination overstates prefix stability

status: open consistency follow-up; the collection cutover now documents the
fixed-candidate-set assumption and refresh reconciliation. source audit at
`0b3ad298a3cc8a9772232fe6b0e6cfb628afd6b2` on 2026-10-19.

problem: current cursors do not freeze ranked membership between requests.
documentation now states this limit; the underlying moving-candidate behavior
remains.

evidence: `python/nexus/services/search/query.py:190-197` decodes only an offset.
`search/service.py:95-104` embeds and opens a new read snapshot for every page;
`search/sources.py:364` also grows the approximate neighbour window with the page
prefix. corpus/index readiness or embedding availability changes can change the
ranked set. `search/semantic.py:66-77` applies the sql limit before its python
id tiebreaker, so deterministic ordering of returned neighbours does not prove
stable membership at a tied cutoff.

impact: concatenated pages may omit or repeat hits under changed candidate sets.
deduplication removes repetitions but cannot recover omissions. the original
audit reproduced no live failure. on 2026-10-22 utc, collection qualification also
observed this live-view boundary in `search/pickers.py`: a resource-target walk
ended with 139 candidates at `03:02:50.740Z`; `note_reindex_job` published
`evidence_span:a18240ce-bd4b-42b3-ae3c-e9577fbd697a` at `03:02:54.334Z`, and
the browser's later walk ended with 140 at `03:02:56.168Z`. preceding pages
were identical. fixed-corpus verification must await index readiness; this
observation does not establish an omission in a quiescent corpus.

current decision: live offset pagination with refresh reconciliation for this
prototype. stronger result-set retention needs an actual requirement.

resolved when: a required stronger guarantee is implemented and verified under
corpus/index changes and approximate candidate cutoffs.
