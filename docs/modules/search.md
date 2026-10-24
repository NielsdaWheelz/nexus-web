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

## browser discovery

`GET /search/preview` requires `phase=direct|lexical|hybrid`. each returns
`{phase, resources, saved, passages, semantic_status}`: at most four directly matched
primary resources, two saved occurrences, and two passages with distinct owners.
direct searches literal canonical titles/names and contributor aliases across media,
podcasts, contributors, pages, conversations, libraries and readings.
it returns only primary resources: saved/passages are empty and children are null.
unicode casefold matching orders exact, prefix, then substring; canonical display
label and ref break ties. choose each ref's best witness before the four-result
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
generated message/media hits group by their canonical source owner in sql before
limiting. owner classification is independent of the direct result window.
selected owners receive one best child from the same lexical scoring traversal,
including children outside the global window. composition carries these proven
facts; it performs no second ranking query. semantic-only facts use the approved
neighbour windows and cannot displace lexical occurrences. each response owns its
facts; phases do not share scores, snapshots, caches or cancellation ownership.

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

browser snapshots disable postgres jit transaction-locally before retrieval:
compiling the visibility relations is unsuitable for these bounded reads. other
workloads retain their execution policy. configured api startup loads local
embedding sdk code before readiness, without creating clients or making calls.

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
active provider/model; migration0306 rejects serving legacy rows that violate
that contract. the capped scalar count therefore chooses exact retrieval through
25,000 vectors, otherwise ivfflat with40 probes over the original full predicate.
an empty count returns no neighbours. the exact branch fetches actual eligible
vector ids before scoring in the same snapshot; at most25,000 uuids transfer.
authorization, publication and model predicates remain unchanged. broad routing
avoids per-vector existence lookups; small scopes pay one extra bounded query.
the count never truncates the searchable domain or caller's window. this cutoff
extrapolates slightly beyond the measured 20,137-vector exact control; it is not
a proved crossover. migration 0306 owns the current-publication expression
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
deadline. cancellation joins cleanup. api caps are direct400/lexical1500/hybrid3000
ms; client and bff whole-read caps are1000/2250/3750 ms, including body/decode and
the complete prefix walk. search has no automatic retries. api timeout is
`E_SEARCH_TIMEOUT`; browser/bff timeout is `E_UPSTREAM_TIMEOUT`. the api cap starts
cancellation; cleanup may outlast it, while the browser cap bounds waiting.
provisional warm release p95 budgets are direct500/keyword2000/related4000 ms from
the last keystroke through paint, including settling and transport. existing stricter
failure cutoffs remain distinct. keyword delivery uses the earliest validated
complete lexical or hybrid response reflected in results; record phase failures
separately. hybrid success proves neither lexical-request latency nor reliability.
preserve faster regression baselines and historical
verdicts; extending a timeout is not a speed improvement. the provisional
cold-session first-action bounds are keyword3000/related4000ms from the last
keystroke through paint, after normal startup and with restoration traffic retained,
without a cold-percentile or per-query empty-cache promise.
publication overlap needs its own measured finite bound; recurrent pressure is
ordinary use.

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

find shows optional best match, commands & places, resources, saved passages and
inside sources. home caps are 4/4/2/2; promotion consumes its home slot and unused
capacity is not reassigned. explicit intent wins promotion, then an exact canonical
local label, then an exact resource name. aliases admit suggestions but do not
beat resource names. local fuzzy matching and frecency stay within navigation.
query actions sit outside these budgets and never become automatic defaults.

local rows appear immediately. independent preview delays are direct80/lexical120/
hybrid160 ms; one codepoint uses direct immediately. hybrid requires two codepoints
and an eligible semantic family. canonical refs bypass textual requests. newer
complete phases replace lower phases until result interaction; afterward they are
held without changing rows/evidence and expose explicit refresh. closed/hidden
surfaces abort their reads; composition dispatches only committed input.

canonical resource refs deduplicate pane and server rows; evidence enriches the
row without changing its primary whole-resource target. filtered/scoped queries
require server admission. unfiltered pane placeholders follow server resources.
pane close actions stay in the merged row's menu. reconcile passages against the
final surviving resources, including pinned rows, without refill requests.

text, filters, scope and intent form query identity. a new query resets selection.
late results preserve the active key and primary target. deliberate selection
freezes the visible prefix and its groups; pinned rows consume home capacity.
capped omission does not mean deletion. explicit unavailability disables the same
target; actual removal clears selection without choosing another automatic row.
desktop enter follows selection, otherwise intent/full search. mobile keyboard
submit always follows intent/full search; explicit row activation opens the row.
composition/repeat guards, shift opening and the two-cell keyboard grid remain.

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
