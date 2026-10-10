# search

status: implemented · origin: 2026-10-10 search reauthor (cleanup/search-reauthor), result boundary 2026-10-02 · area: search, browse, link pickers

one retriever and one ranking rule serve the search pane (`GET /search`), the nexus
launcher (openables, then owned search), the link picker
(`POST /resource-items/targets/search`), browse's in-database sections (Nexus, Gutenberg),
chat (`app_search`, `document_search`, citation reopen), dossier research, connection
discovery and the oracle's lanes. see [architecture](../architecture.md#76-search-retrieval--the-embedding-pipeline),
[typed wire](../local-rules/typed-wire.md) and [verification](../local-rules/testing-standards.md).

## the retriever

`services/search/sources.py` holds every findable **family** as one visible SQL relation:
a `SELECT` with conventional columns `type, id, label, doc` (and `cosine` when semantic)
for ranking, `text` for the snippet and wire-named columns for projection. `{where}`
receives scope and filter predicates. visibility is part of the relation, so `rank` (the
family's top `k`) and `hydrate` (reread ids, with a headline) share it, and a reopen is a
reread. callers ask two questions only: *rank these against a query* and *reread these ids*.

the rule (S1), absolute in [0, 1) and comparable across families, scopes and pages:

```
tier      3 label = q · 2 label starts with q · 1 label contains q · 0 (case-folded, LIKE-escaped)
evidence  0.5 + ts_rank_cd(doc, q, 32) / 2   when doc @@ websearch_to_tsquery(q)
          cosine / 2                          for a semantic neighbour (cosine >= 0.5), else 0
score     (tier + evidence) / 4
match     doc matches · label contains q · semantic neighbour
order     score desc, label, id (codepoint order in SQL `COLLATE "C"` and in python)
```

a higher title tier always wins; within a tier full-text beats semantic-only, and cosine
never reorders full-text matches. with filters and no text (`author:` alone) only the
listable families (media, podcasts, contributors) answer, at score 0, in label order;
passages need text. each family returns its top `k = offset + limit + 1` and `merge`
sorts the union, so the merged prefix is exact and pages are prefix-stable.

families: media (typed media/episode/video by kind), podcast, contributor (wire id =
handle), page, note_block, highlight, message (`complete` only), conversation, artifact
(conversation dossier claims, owner only), reader_apparatus_item, fragment, content_chunk
(ready index, primary span), web_result (one row per external snapshot), evidence_span
(reopen and targets), gutenberg (browse), library, oracle_reading, dossier (artifact
heads), passage_anchor, oracle_passage_anchor (targets and openables). credited families
(media, podcast, contributor, content_chunk) honour `format:`/`author:`/`role:`; any other
family contributes nothing under such a filter.

semantic recall: `semantic.embed_text` makes the one provider call and never touches a
session (a provider failure degrades to lexical with one
`search_semantic_embedding_unavailable_lexical_fallback` warning; wrong dimensions are
`E_APP_SEARCH_FAILED`). `semantic.nearest_chunks(db, embedding, owner=…, params, limit)`
is the one nearest-neighbour query: embedded chunks of ready, active-model indexes under
the caller's owner predicate, ordered by a bound constant so ivfflat can drive broad
scopes (`ivfflat.probes = 10`, `limit = max(200, 4k)`), returned nearest first with ties
by chunk id. note blocks take their best chunk's
cosine; the chunk family restricts itself to lexical matches ∪ neighbours.

scopes (`scope.py`): `authorize_scope` answers 404 (never 403; a conversation is
`E_CONVERSATION_NOT_FOUND`) for any query with text or a filter, even one no kind
serves; blank unfiltered input reads nothing. `scope_predicate` ORs one cell per scope: media and library
scopes keep descendants, a conversation scope keeps the chat and its context facts, and
"all" under a frozen chat context admits exactly the frozen refs (a frozen conversation
admits its completed messages). picker and browse families admit only an unfrozen "all".

## transaction law

`service.read_snapshot` owns it: embed first, outside any transaction, then open one
REPEATABLE READ, READ ONLY snapshot, read, and end it. `search()`, `search_scopes_async()`
and the link picker require a session without an open transaction and raise
`RuntimeError` otherwise, never discarding a caller's writes. `get_search_result()`
(reopen) runs in the caller's transaction (no network). background callers end their own
reads before searching (connection discovery commits after its reads; the oracle commits
before embedding).

## entry points and cursors

| entry | contract |
|---|---|
| `GET /search` | `search(db, viewer, SearchQuery)`; kinds, formats, authors, roles, `in:` scope; ≥ 2 characters or a filter; `{"offset": n}` cursor |
| chat `app_search`, `document_search`, dossier research | `search_scopes_async(session, viewer, base, scopes)`: one union pass, first page, real `has_more`, no cursor |
| chat citations, attached resources | `get_search_result(db, viewer, type, id, evidence_span_ids?)`: every type reopens through its family; a media id reopens as media, episode or video |
| link picker | `pickers.search_targets`: exact ref, exclusions and source identity, then one bounded pass over the global top `2·needed + |excluded|` with one embedding; passages admit by unique quote (anchor key); page size 10; `{"offset": n}` cursor |
| nexus launcher | `pickers.search_openables`: the direct families lexically from one character, route-activatable, at most 20 |
| browse | Nexus sections rank `media` (`format` filter), Gutenberg ranks `gutenberg`; cursor `{q, kind, source, sort, at}` (`at`: offset, or YouTube's page token); podcast preview episodes `{target, published, episode}` |
| authors | `GET /contributors` stays an alphabetical keyset listing (not S1); cursor `{n, h}` |

one cursor codec (`query.encode_cursor`/`decode_cursor`: unpadded base64url of compact,
key-sorted json; padded input decodes; anything else is `E_INVALID_CURSOR`). an offset
(search, targets, browse `at`) is at most `query.MAX_OFFSET` (1,000), since it sets every
family's `k`: no cursor is issued past it and a deeper one is `E_INVALID_CURSOR`. browse
takes each query key once (a repeated key is 400 `E_INVALID_REQUEST`, as an unknown one).

## browser result boundary

`SearchResponse` is `{results, page: {has_more, next_cursor}}`, a union discriminated by
`type`; every field is always sent (context `evidence_span_ids` too) and required in
openapi. rows carry score/snippet, occurrence, owner and action-subject refs,
activation, citation target and context ref; passage types act on their owner.
`<b>`/`</b>` is the only snippet markup. the web projects the generated wire once
(`lib/search/searchApi.ts`, `searchViewModel.ts`) and keeps its semantic checks:
canonical activation, media id/kind/context agreement, chunk evidence, contributor
identity, highlight-note iff excerpt, artifact revision and web snapshot identity. blank
unfiltered input makes no request; the pane debounces 200 ms, requests 20 rows and
appends cursor pages; nexus requests 40 owned rows after openables settle, web excluded.

## verification and trade-offs

static: `./scripts/test`. live: the campaign search harness (37 journeys: http contracts,
ranking, paging, semantic and lexical fallback, visibility and scopes, targets and
openables, browse sections, previews and failures, pane, launcher, link picker, chat
tool, oracle) and a seeded 200k-embedding EXPLAIN gate for `nearest_chunks`.

trade-offs: no type interleaving (one family can fill a page; kind chips diversify);
substring matching reads labels only (messages, chunks, fragments and spans match by full
text); the link picker's one bounded pass can end early when most of the prefix fails
admission; ANN post-filtering can thin semantic hits under medium scopes
([ticket](../tickets/semantic-recall-under-filtered-scopes.md)); note locators cover the
whole block; browse Nexus sections match description, publisher and credits too; a page
can hold fewer than `limit` rows while `has_more` is true, because `project` drops a
ranked row that no longer places (a chunk whose evidence span does not resolve, a
highlight without a locator) after paging, and offsets count ranked rows, so paging
never skips or repeats one.
