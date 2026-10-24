# suggestion refresh bypasses expensive-read admission

status: functional fix verified; restored-corpus overlap pending · origin: review of admission changes after `7e55c59ae` · area: search / suggestions

the registered `suggestion_shortlist_refresh` worker previously ranked without
shared search admission. with media anchors, this reached the corpus-wide
vector-distance and window-ranking query in `services/suggestions.py:502-527`
before its candidate limit, alongside admitted browser or tool reads.

`services/suggestion_shortlists.py` now owns its ranking snapshot through
`search_session`; its separate fenced publication transaction is unchanged.
the actual registered handler waits behind the shared gate, then publishes the
same two independently known ordered targets. the ranking backend disappears
and admission is available while publication waits on its claim row. a real
expired/reclaimed claim cannot publish. this small fixture has no embeddings;
it does not establish restored-corpus cost or overlap memory safety.

remaining: qualify representative suggestion refresh and admitted-search
overlap on the restored corpus within the existing memory envelope. no oom
from this particular overlap has been measured.

the subsequent actual browser baseline fails before adding a worker: lexical
request failure and hybrid `504 / E_SEARCH_TIMEOUT`, with no result paint.
representative worker contention and maintenance remain blocked on the
[complete-search gate](semantic-document-search-times-out-on-restored-corpus.md).
