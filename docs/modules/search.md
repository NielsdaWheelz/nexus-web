# search

browser discovery finds resources and shows their evidence. strict retrieval finds
citable occurrences. they share visible sql families, scope predicates, embeddings
and resource presentations; neither consumes the other's public projection.

## owners and contracts

| owner | responsibility |
|---|---|
| `services/search/discovery.py` | browser bands, source grouping, preview, occurrence view and cursors |
| `query.py` | separate `DiscoveryQuery` and strict `SearchQuery`; parsing and cursor codec |
| `sources.py` | canonical browser eligibility, semantic-window projection and strict retrieval relations |
| `indexed.py` | one lexical score traversal, request-local winners, semantic composition and literal evidence |
| `projection.py` | derived occurrence extraction/replacement and publication ordering |
| `scope.py` | scope authorization and family membership; frozen-context predicates |
| `semantic.py` | one query embedding and bounded nearest-neighbour reads |
| `admission.py` | database-wide expensive-read admission and physical connection ownership |
| `service.py`, `project.py` | strict search, multi-scope retrieval and citation reopening |
| `pickers.py` | resource-target admission, exclusions and durable passage identity |
| web `lib/search/` | browser criteria, canonical urls and generated-wire loaders |
| web `lib/nexus/`, `components/nexus/` | intent, local navigation, preview composition and selection |

activation, source identity, location availability and full target extent come from
the shared [resource item](resource-references.md). consumers do not reconstruct
targets from snippets or hrefs. browser responses have no score or second locator
schema. wire schemas are generated; see [typed wire](../local-rules/typed-wire.md).

## work bounds

ranking, authorization and the amount of work are separate contracts. a response
limit bounds displayed results, not candidate materialization, database memory
or elapsed time. preserve the accepted owner grouping, best evidence and tie
rules when changing execution. an early candidate cap that changes winners is
a ranking decision, not a transparent optimization. hydrate selected results
without broadening the ranked work or copying full bodies into candidate sets.

the caller's original deadline covers provider transport, admission and database
work. cancellation stops subsequent local requests and retries and joins cleanup;
cleanup may finish after the response deadline. running synchronous provider work
in a thread does not give it the awaiting task's cancellation lifetime. strict
retrieval's remaining [embedding gap](../issues/tool-search-embedding-outlives-deadline.md)
must retain its own declared fallback semantics when repaired.

[production composition](../../deployment.md#capacity-contract) owns aggregate
capacity. query qualification uses representative data and warmed connections;
fewer simultaneous queries or longer timeouts alone do not establish bounded
work. current gaps are [aggregate memory qualification](../issues/production-database-connection-budgets-implicit.md)
and [background admission occupancy](../issues/production-search-admission-contention.md).
slower background refresh is an explicit cost of foreground progress; useful
background completion remains required.

## browser discovery

`GET /search/preview` requires `phase=direct|lexical|hybrid`. each returns
`{phase, resources, saved, passages, semantic_status}`: at most eight directly matched
primary resources, eight saved occurrences, and eight passages with distinct owners.
direct searches literal canonical titles/names and contributor aliases across media,
podcasts, contributors, pages, conversations, libraries and readings.
it returns only primary resources: saved/passages are empty and children are null.
unicode casefold matching orders exact, prefix, then substring; canonical display
label and ref break ties. choose each ref's best witness before the eight-result
limit; within a ref prefer its canonical name over an equally ranked alias.
canonical eligibility owns visibility, scope and filters. selected hydration keeps
canonical bodies and activation; evidence quotes the matched original literal with
grapheme-aligned codepoint ranges. a reading's full question is its canonical name;
its bounded display title affects ties only, and undisplayed matches use separate
literal evidence. direct uses neither native text ranking nor
annotation, vectors or providers. body/saved-text and query grammar belong to the
later phases. filter-only browse keeps existing listable families and null match
fields. this contract applies only to explicit direct preview.
lexical searches all eligible families without
provider or vector calls. hybrid is a complete server-ranked replacement containing
lexical and semantic evidence. displayed primary owners are excluded
before the inside-source budget. web snapshots are full-search-only.

`GET /search` requires `phase=lexical|hybrid` and returns that phase with a
discriminated `view`, `results`, `page` and `semantic_status`. resources is the
default; passages must be explicit. loaders reject phase/view mismatches before
adopting rows or cursors.

- resources: exact meaningful names, remaining primary matches, saved occurrences,
  then owners discovered only through passages. a directly matched owner occurs
  once, with at most one representative child. independent notes and saved
  occurrences keep their own identity.
- passages: individual notes, saved occurrences, messages, indexed chunks,
  fragments and apparatus by evidence relevance. deduplicate exact occurrence
  refs only; overlapping extents and repeated quotations remain distinct.

meaningful names have exact/prefix/substring tiers. note, quote and passage prose
has none. within a band, names precede remaining lexical matches, which precede
semantic-only matches; relevance and canonical ref break ties. no passage-count
summation or frontend score merging. filter-only listings retain label order.
generated message/media hits group by conversation or permitted reading owner in sql before
limiting. owner classification is independent of the direct result window.
selected owners receive one best child from the same lexical scoring traversal,
including children outside the global window. composition carries these proven
facts; it performs no second ranking query. semantic-only facts use the approved
neighbour windows and cannot displace lexical occurrences. each response owns its
facts; phases do not share scores, snapshots, caches or cancellation ownership.

matching named pieces retain private child winners from that same score stream,
even when ordinary passage discovery prefers their visible source. these facts
only enrich selected parents. selected presentation keys include canonical ref
and reading identity, so one passage can explain source and piece without sharing
the wrong activation. hydration batches distinct refs together and splits only
conflicting contexts for the same ref; passage-view deduplication is unchanged.

source-backed pieces are reading identities, not copied passage/vector owners.
authorization chooses one permitted reading owner before ranking; source-owned
occurrence refs remain canonical. piece evidence must fit its bounded scope and
activation opens that reading identity. a piece never authorizes neighbouring
text or the whole source. among admitted readings, the source wins owner choice;
otherwise the smallest eligible piece and its id break ties.

local authored search follows the same owner rule, including global search.
replicated workspace membership is distinct from retained reading permission.
highlight and media-passage rows carry their selected reading into activation;
canonical identities, quotes and locators remain unchanged. ordinary owned
notes/pages remain searchable while source inputs hydrate.

highlight context has one derived native variant per admissible reading identity.
piece variants clip prefix/suffix before matching and scoring; their canonical
highlight ref remains singular. the extra rows change corpus statistics and add
refresh work on definition changes. physical inserts/deletes remain bounded to256
rows per statement; a partial highlight-ref index supports exact withdrawal.
source-authorized stored quotes remain searchable with unavailable locations;
piece-only access still requires complete-anchor containment and strict citations
still require valid locations.

chunk ranking reads scalar candidate facts and requires a nonnull primary-span id;
its validated foreign key proves span existence. selected hydration and reopening
still join the complete span and retain source/quote/locator checks. browser
lexical relevance comes from the pinned native occurrence index. strict citation
retrieval retains its separate lexical and admission contract, including its
postgres text indexes. prose contributes no name arm.

for requests containing only primary families, `indexed.py` uses a zero-score
native family filter. `sources.py` owns canonical eligibility; every native match
joins that relation before grouping, ranking or truncation. this avoids expanding
every eligible key into the native filter. requests including generated families
retain native owner-key admission. narrow scopes can score more primary matches
before the canonical join; the scoring grammar and selected evidence stay the same.

the occurrence index is derived, never an authority for visibility, identity,
activation or source text. scalar fields preserve phrase boundaries; contributor
documents are viewer-specific. canonical writers own transactions, permissions,
retries and claim/revision fences. projection replacement withdraws old identities
and inserts current canonical values in that same transaction. dependency discovery
belongs to a fresh serializable attempt before canonical reads or locks; providers
stay outside it. source replacement withdraws old identities as well as publishing new
ones. title, credit and alias writers refresh their dependent works; filing,
membership and grant changes refresh viewer-specific contributor text. the
visibility-loss callback owns that viewer's contributor refresh. existing
source/identity/claim locks remain;
postgres tracks shared predicate dependencies and conflicting transactions retry
their entire database operation. the retry owner alone commits; participants flush
and materialize results. unrelated owners have no global publication mutex.
visibility changes conservatively rebuild that viewer's contributor documents in
bounded batches. suggestion invalidation advances only the changed owners' durable
clocks; their sum preserves committed changes, including late commits. clocks remain
after source deletion. this trades small retained rows and reader aggregation for
independent source publication. operational qualification remains
required by [release-search](../issues/release-search.md).

the browser kinds are documents, notes, highlights, conversations, people, web,
libraries, readings and saved passages. highlights does not implicitly
add annotation notes. libraries/readings are global-only. web snapshots
are external resources; links and citations are relationships, not extra results.

scopes are all, media, library and conversation, not generic ancestry. each row
also requires viewer visibility. media/library membership uses existing source
and note predicates; saved anchors follow their actual owned source. conversation
membership uses explicit context facts. unreadable requested scopes return 404,
including when no selected family serves them. blank, unfiltered queries read
nothing; format/author/role-only requests list media, podcasts and contributors.
passages require text. one codepoint omits generated families and semantic work;
full search retains its existing lexical matching, distinct from direct preview.

note membership starts with the note's eligible adjacent edges, then tests their
source or highlight against scoped reading media. it does not repeat edge lookup
for each media in a library. the standalone and shared predicates use this same
rule; conversation and frozen-context membership retain their separate contracts.

contributor admission materializes visible credits once using the request's shared
media and podcast visibility. the permission owner supplies the unchanged catalogue,
media or podcast rule; joins avoid per-credit scans of recursive visibility.
standalone consumers retain their self-contained permission query.

browser admission requires readable content, not a currently usable exact locator.
stale saved/apparatus locations remain visible and honestly unavailable, with an
independent source action where possible. raw pdf fragments remain excluded;
indexed pdf evidence uses its existing page target without requiring geometry.

## transactions, semantic capability and pages

expensive browser, strict, picker, connection-discovery, oracle and
suggestion refresh reads share one database-wide advisory session lock. each read
owns an external physical connection: admission's transaction rolls back while retaining the lock, then a
fresh read-only repeatable snapshot materializes authorization, ranking and results.
the connection is retired after snapshot/session cleanup; there is no explicit
unlock before backend cleanup. this requires a session-affine database connection.

provider waits, direct lookups, primary-only browse and browser branches with no
retrieval stay outside admission. async admission and reads consume the caller's
original absolute deadline, including queue time; expired or cancelled waiters do
not later dispatch retrieval. sync callers retain their database timeout backstop.
the synchronous picker still has the existing
[request-cancellation limitation](../issues/api-sync-work-outlives-request-cancellation.md).

hybrid computes at most one embedding before opening a transaction. `read_snapshot` then
owns one repeatable-read, read-only snapshot for authorization, ranking, hydration
and presentation, and ends it. entering with an open transaction raises rather
than discarding a caller's writes. reopening uses its caller's transaction and
does no network work.

search uses the shared application engine's jit-disabled execution policy
([database layer](../architecture.md#71-the-database-layer)). configured api startup
loads local embedding sdk code before readiness, without creating clients or
making calls.

the api container, disposable runtime and local commands select uvicorn's stock
`asyncio` loop explicitly. optional `uvloop` is not required for search; the http
parser, route deadlines and cancellation, admission and retrieval stay with their
existing owners. this loop choice is an operational candidate after an unexplained
native api crash, not a demonstrated repair. complete browser qualification must
measure its latency and retain the earlier faster baselines.

browser semantic retrieval has fixed windows of 200 chunks each for media and note
owners, independent of page size/offset. scope, filters, active model and ready
index eligibility apply before the budget. enrichment adds no embedding or ann
read. full resource search obtains note neighbours and lexical winners first.
it omits chunk neighbours only when the known prefix covers the page and its
continuation, and every selected media already has a lexical child or lacks
current eligible vectors. vector absence is a conservative witness in the same
snapshot, never authorization. otherwise it obtains the unchanged full chunk
window and recomposes the retained facts without repeating lexical scoring.
preview applies the same selected-media witness after its two globally distinct
inside slots are filled by lexical winners. its primary and saved slots remain
independent; note neighbours are obtained first. passage search retains both
eligible windows. this saves work only
when semantic chunks cannot change the response; it adds an eligibility read
when selected media lack lexical evidence. cosine eligibility is unchanged; approximate recall is bounded, not global
top-k. lexical evidence and semantic-only evidence have separate provenance.

`nearest_chunks` counts at most25,001 current ready chunks in the caller's
snapshot. publication owns exactly one nonnull vector per current chunk on the
active provider/model; migration0317 rejects serving rows that violate
that contract. the capped scalar count therefore chooses exact retrieval through
25,000 vectors, otherwise ivfflat with40 probes over the original full predicate.
an empty count returns no neighbours. the exact branch fetches actual eligible
vector ids before scoring in the same snapshot; at most25,000 uuids transfer.
authorization, publication and model predicates remain unchanged. broad routing
avoids per-vector existence lookups; small scopes pay one extra bounded query.
the count never truncates the searchable domain or caller's window. this cutoff
extrapolates slightly beyond the measured 20,137-vector exact control; it is not
a proved crossover. migration0317 owns the current-publication expression
statistic used by that predicate. strict search and oracle reads share this
primitive and retain their own limits and cosine policies.

`semantic_status` is `not_requested` or `used`. an eligible hybrid failure or
missing credential returns `E_EMBEDDING_PROVIDER_UNAVAILABLE` / 503 after scope
authorization. lexical makes no provider/ann call. the browser retains its last
successful phase and presents failed capabilities separately; the server never
downgrades a hybrid response. malformed vectors and unexpected failures are defects.
local search tools and pickers retain their lexical capability without that
credential; oracle embedding failure remains typed at its own boundary.

browser cursors contain `{offset, query_fingerprint, phase}`. the fingerprint
binds viewer, canonical text, kinds, formats, authors, roles, scope, view and phase,
excluding page size. old/mismatched cursors are invalid. continuations keep the
accepted phase; failure retains the loaded prefix and offers manual retry.
cursor rejection requires explicit page-one refresh, never an automatic restart.

browser routes own one native async operation/session, raced against disconnect
and aggregate deadline. sql runs through `AsyncSession.run_sync` and one read-only
repeatable snapshot; remaining transaction-local statement timeout backs the outer
deadline. cancellation joins cleanup. current enforced api caps are
direct400/lexical1500/hybrid5000 ms; client and bff whole-read caps are
1000/2250/5750 ms, including body/decode and
the complete prefix walk. search has no automatic retries. api timeout is
`E_SEARCH_TIMEOUT`; browser/bff timeout is `E_UPSTREAM_TIMEOUT`. the api cap starts
cancellation; cleanup may outlast it, while the browser cap bounds waiting.
historical qualification targets are being reconsidered; no replacement numeric
deadline has been approved. the previous provisional warm release
p95 budgets were direct500/keyword2000/related4000 ms from
the last keystroke through paint, including settling and transport. existing stricter
failure cutoffs remain distinct. keyword delivery uses the earliest validated
complete lexical or hybrid response reflected in results; record phase failures
separately. hybrid success proves neither lexical-request latency nor reliability.
preserve faster regression baselines and historical
verdicts; extending a timeout is not a speed improvement. the previous provisional
cold-session first-action bounds were keyword3000/related4000ms from the last
keystroke through paint, after normal startup and with restoration traffic retained,
without a cold-percentile or per-query empty-cache promise.
publication overlap needs its own measured finite bound; recurrent pressure is
ordinary use.

the previous rollout accepted occasional restored-pane related failure during
publication when useful results remained visible, failure was explicit and retry
remained available.
that historical allowance does not approve a current failure mode or change any
deadline; revised acceptance requires an explicit owner decision.

offsets count displayed groups or occurrences, including unavailable ones.
families contribute at most `offset + limit + 1` logical identities before the
merge; pages contain at most 50 rows. the offset ceiling is 1,000. fixed-corpus
lexical pages preserve the merged prefix. every request uses a fresh snapshot;
corpus/index changes and approximate neighbour membership can change later pages.
no retained search session or total-result count is promised.

## launcher

the existing command registry owns slash/create/ask/browse/import syntax, bare
new/create, and exact `go [to]` destinations. unknown or ambiguous destinations
remain content. canonical refs use the existing resolver instead of text search;
pending enter waits, and unavailable refs keep their exact disabled target.
full search treats commands and refs as content.

ordinary find composes at most eight principal results, then two continuations:
`search all results` and `use this text…`. relevance precedes truncation: explicit
intent, exact name, prefix/token, substring, literal evidence, fuzzy/synonym
navigation, semantic evidence. each tier interleaves stream ordinals, then fixed
navigation/local/resources/saved/passages order and key; unrelated scores never
mix. canonical authority chooses duplicate ownership, not relevance. local
writing wins over server projections; readable remote resources replace source
stubs. source/passage deduplication preserves exact matching-passage activation.

launcher local acquisition uses the nonpaged authored `search_preview` query.
it inspects bounded literal-name batches before truncation, reuses scoped/evidence
admission, then fills remaining slots from lexical evidence. one host revision
covers the compound read. local name matching uses trim and unicode lowercase;
remote names retain unicode casefold. cross-source unicode equivalence is not
promised. ordinary full-search/picker `search` retains its existing cursor.
server preview excludes viewer-authored projections before its limits.

local capture candidates resolve their scoped frozen excerpt before consuming an
admission slot. preview and held-ref admission use the same resolution as ordinary
search, within the same host revision; unresolved captures consume no result slot.
an unfiltered preview means the shared discovery-family vocabulary. unsupported
source-stub families cannot consume its bounded slots and disappear in the renderer.

independent preview delays are direct80/lexical120/hybrid160 ms; one codepoint
uses direct immediately. hybrid requires two codepoints and an eligible semantic
family. canonical refs bypass textual requests. retain proven direct names
omitted by richer phases. duplicate refs choose one whole snapshot: strongest
name tier, then later phase; explicit unavailability supersedes old evidence.
never splice activation and evidence from different snapshots. closed/hidden
surfaces abort reads; composition dispatches only committed input.

account, raw text, filters, scope and intent form query identity. before interaction,
results and defaults can improve. afterward the whole displayed list holds its
identity, order, evidence and geometry until explicit refresh/new query/reopen.
explicit pane operations retain their own committed successor/focus rules.
capped omission does not mean deletion; the bounded local `search_admission` query distinguishes
revoked query/scope/evidence admission from preview omission. unavailable/removal never selects a
replacement action. desktop enter acts on the displayed eligible selection;
mobile input retains parsed-intent/full-search submission. repeat/composition
never activate; shift retains its captured opening disposition.

command and lookup views are separate from retrieval. exact slash heads accept
end-of-input or whitespace; unknown heads retain command lookup, never search.
lookup shows all six commands without a default; deliberate selection starts an
empty command. available explicit commands are initial defaults, including creation.
command/lookup views omit incidental query continuations. the explicit literal-search
escape retains outer-trimmed text without parsing filters. the full interaction
and content contract belongs to [app navigation](app-navigation.md#nexus-content-grammar).

## browser presentation

urls own query, kinds, filters, scope and view. omit the default resources view
and all-kinds selection; `kinds=` means none. switching views preserves criteria,
resets paging and clears preceding-query rows and metadata. clear filters preserves query/view; reset
returns empty resources. unsupported passage kinds stay unsupported, with controls
to return to resources or clear kinds. automatic pagination exposes no rolling
count or completion receipt; initial query waiting and failures remain explicit.

two `useServerList` instances own independent lexical/hybrid metadata and cursors;
only the selected one pages. a hidden candidate loads page one and restarts its
generation on invalidation. adoption commits rows/phase/view/cursor together;
interaction freezes phase adoption, while ordinary source invalidation remains
active. visit restoration preserves accepted phase, generation, latch and prefix.
explicit refresh replaces page one and resets selection/scroll after success;
pending/failed refresh retains old rows. visible progress uses one polite atomic
live region per surface with delayed reveal. source titles open the whole work; child excerpts open
their exact occurrence. notes retain selectable prose and their existing opening
bullet. saved quotes retain source attribution and an independent source link.
the launcher offers matching-passage activation in the resource's existing menu.

reuse `ResourceBody`, `ResourceMatchEvidence`, `ResourceMetadata` and outline rows.
literal text, codepoint emphasis, honest ellipses and full activation extent are
independent facts. no generated summaries, invented names/locations, duplicate
title-as-excerpt, or raw chunk labels. lectern actions inspect the item's own
media ref, not its source ref.

`ResourceBody` decorates a matching literal part inline only when the entire
match excerpt equals that rendered part. other evidence stays separate from the
canonical body, including for custom bodies and live note editors. own and nested
witnesses wrap without clipping; equal inline evidence also releases row clamps,
including name-only evidence with no emphasis ranges. mobile nexus assigns one
description id, preferring the matching passage, then separate own evidence,
then the rendered body. source and activation remain the canonical item's.

## text publication

`content_index_states.lexical_revision = revision` proves a complete current
nonempty text/locator publication. semantic readiness additionally requires ready
status and the consumer's model identity. new readable sources may await the
existing preparation queue. pure local planning publishes spans/chunks before
embedding work; semantic publication installs vectors on those exact ids.
both commits are source-revision/exact-claim fenced. retries resume existing text;
completed ready/no-text/ocr-required outcomes are no-ops, including effects and
timestamps. note edits increment revisions and coalesce unclaimed work.

the media text publisher takes the revision returned by its own state write and
checks that the lexical update stored that same revision. it then projects only
that owner's new chunks with the explicit owner and revision in the same
transaction. the final insert does not reread unrelated index states; migration
extraction still derives each row from canonical state.

pieces use their source's current lexical publication and published partition.
definition changes reconcile that partition in the same transaction. structural
witness/text publication precedes embeddings, so missing embedding credentials
cannot prevent manual piece creation. piece detail and processing readiness read
that same source state; source repair offers never target the piece id.

media detail, processing snapshot and import item expose derived
`text_search_ready`. completed publication governs capability even if queue
acknowledgement lags. indexing credential absence terminates with
`E_EMBEDDING_NOT_CONFIGURED` after text publication. vector consumers retain their
completion gates. fresh chunk search uses current text; saved-reference reopening
retains existing identity/quote/locator guards without a new readiness gate.

## strict consumers and retained limits

strict `SearchKind` stays the existing six kinds. `service.search`, multi-scope
chat/document search, citation reopen, connection discovery, browse, oracle and
picker retain their evidence admission and frozen-context contracts. strict sql
location guards and final `project.py` checks remain; browser visibility changes
do not weaken citation eligibility.

strict ranking retains s1: case-insensitive label tier, then lexical rank ahead
of semantic-only cosine, with label/id ties. its offset cursor and ann policy
are separate from browser discovery. live offset pages require a fixed ranked
candidate set for prefix stability. the picker retains one bounded pass, unique
quote admission, source/exclusion handling and ten-row pages; it can end early
when admission rejects most candidates. browse and contributor listing keep
their existing cursor contracts. source display truncation never narrows a target.

the old openables endpoint, request/response types, loader and launcher paged
search path are removed. api/web cut over together. verification follows the
[local contract](../local-rules/testing-standards.md); `./scripts/test` is the sole
permanent static gate. exactly three manually invoked search integration checks
remain under that local contract; other scenario cases are temporary.
