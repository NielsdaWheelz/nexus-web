# search result boundary

status: implemented; static, wire/row parity and real browser checks passed · origin: 2026-10-02 cleanup · baseline: `56b889bdc6708d2d913982e22e7566a141b024d6`

this owns the browser projection of `GET /search`; execution/visibility/ranking
stay in `services/search/`. see [architecture](../architecture.md#76-search-retrieval--the-embedding-pipeline),
[typed wire](../local-rules/typed-wire.md) and [verification](../local-rules/testing-standards.md).

## contract

`SearchResponse` owns `{results: [...], page: {has_more, next_cursor}}`.
result fields are always sent, including nulls/empty arrays, and required in
openapi. only empty context evidence ids and absent context locator are omitted;
nested locator omission, aliases, UUID strings and presence values are unchanged.
wire variants carry score/snippet, occurrence/owner/action refs, activation,
citation/context. the browser preserves order/score and `type-id` keys.

| discriminant | primary text fallback order | other wire facts |
|---|---|---|
| `media`, `episode`, `video` | canonical media summary | kind, credits/date/duration/processing, snippet |
| `podcast` | title, stripped snippet, untitled | credits, source label |
| `contributor` | display name, stripped snippet, author | handle/identity |
| `content_chunk` | stripped snippet | citation, source, locator/evidence |
| `fragment` | stripped snippet, fragment | source, locator |
| `page` | title, stripped snippet, untitled page | source label |
| `note_block` | excerpt, body, stripped snippet, note | origin, locator |
| `highlight` | exact, stripped snippet, highlight | source, locator |
| `message` | stripped snippet, message number | conversation/sequence, locator |
| `evidence_span` | stripped snippet, citation | source, span/locator |
| `reader_apparatus_item` | stripped snippet | source, apparatus/locator |
| `conversation` | title, stripped snippet, conversation | source label |
| `artifact` | title, stripped snippet, dossier | revision ref/id, subject |
| `web_result` | title, stripped snippet, url | source metadata/date, external locator/snapshot |

`<b>`/`</b>` delimit emphasis case-insensitively; other text stays literal. source
credits and partial bibliographic dates stay canonical; web dates also permit
qualified instants. media retains owned date/minute/presence values. activation
changes casing once; action identity remains separate and canonically constructed.

structural browser decoding is retired. existing semantic checks stay: usable
canonical activation; media id/kind/context/modality; chunk nonnull media identity
and context evidence; nonempty contributor identities; matching contexts for
contributor/chunk/fragment/span/apparatus/conversation/artifact/web; highlight-note
iff excerpt exists; artifact revision/web snapshot identity. no new variant checks.

query/UI behavior stays: omitted kinds means all, empty kinds means none; operators
keep their meanings. blank unfiltered input makes no request. search debounces
200 ms, requests 20 rows, appends cursor pages and rejects stale responses. nexus
requests 40 owned rows after openables settle, excluding web. transport/auth
handling stays; unexpected adapter errors reach the render boundary.

## ownership

`ApiJson<"/search", "get"> -> typed row adapter -> row consumers` is the boundary.
`searchApi.ts` owns fetching; `searchViewModel.ts` owns conversion/presentation;
`types.ts` owns row/page contracts with generated tags. delete four unread row
fields: `contextRef`, `citationTarget`, `noteBody`, `noteOrigin`; server fields/checks
stay. score and occurrence/owner refs stay for nexus grouping/ranking.

`schemas/search.py` owns requiredness/context serialization; the route returns its
model and producers supply always-sent values. chunk nonnull checks stay in the
adapter; inherited wire fields remain nullable. delete the reconstruction decoder,
handwritten wire union and custom contract-error class. SSE owns its exhaustive
runtime tag census checked against generated tags. core source: 1,429→735 lines.
search first-page/continuation and nexus consume this boundary; collection/nexus
keep its retained row contract. `LinkTargetDialog` keeps `parseSnippetSegments`.

## verification and trade-offs

`./scripts/test` passed. temporary oracle: 45 fixtures/all 16 tags preserved
47,616 FastAPI bytes; retained rows, collection presentation and five nexus queries
matched with exactly four deleted keys. nine context locators and 29 semantic
cases passed. ten real HTTP outcomes matched, five successes byte-exact. live data
covered conversations; provider/embedding retrieval was not exercised. six real
authenticated browser→bff cases matched, including cursor continuation and errors.
four displayed rows, links, action menus and filtered nexus results matched;
forking a result then returning preserved search rows without refetch or page errors.
after rebasing onto the auth-recovery change, real password login, the same six
bff cases, private-scope denial and missing-cookie sign-in recovery passed.
the fresh database's unrelated workspace-session read defect is tracked separately.
temporary scripts, fixtures and browser dependencies were deleted after review;
no production test seam remains.

one data model and reconstruction phase are gone. schema/static typing own
structural drift; semantic checks stay. reject fallback defaults, duplicate paths,
shared locator-schema rewrites and unrelated UI/retrieval changes.
