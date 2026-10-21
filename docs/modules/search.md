# search

browser discovery finds resources and shows their evidence. strict retrieval finds
citable occurrences. they share visible sql families, scope predicates, embeddings
and resource presentations; neither consumes the other's public projection.

## owners and contracts

| owner | responsibility |
|---|---|
| `services/search/discovery.py` | browser bands, source grouping, preview, occurrence view and cursors |
| `query.py` | separate `DiscoveryQuery` and strict `SearchQuery`; parsing and cursor codec |
| `sources.py` | visible family relations, ranking facts, owner grouping and selected-owner reads |
| `scope.py` | scope authorization and family membership; frozen-context predicates |
| `semantic.py` | one query embedding and bounded nearest-neighbour reads |
| `presentation.py` | bounded literal excerpts and codepoint emphasis; shared resource-item hydration |
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
direct excludes generated passages. lexical searches all eligible families without
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
selected owners receive one best child in the same snapshot, including children
outside the global window; enrichment reuses admitted neighbours.

the browser kinds are documents, notes, highlights, conversations, people, web,
libraries, readings, dossiers and saved passages. highlights does not implicitly
add annotation notes. dossier discovery uses the visible artifact head, not a
second artifact result. libraries/readings/dossiers are global-only. web snapshots
are external resources; links and citations are relationships, not extra results.

scopes are all, media, library and conversation, not generic ancestry. each row
also requires viewer visibility. media/library membership uses existing source
and note predicates; saved anchors follow their actual owned source. conversation
membership uses explicit context facts. unreadable requested scopes return 404,
including when no selected family serves them. blank, unfiltered queries read
nothing; format/author/role-only requests list media, podcasts and contributors.
passages require text. one codepoint uses direct lexical retrieval only.

browser admission requires readable content, not a currently usable exact locator.
stale saved/apparatus locations remain visible and honestly unavailable, with an
independent source action where possible. raw pdf fragments remain excluded;
indexed pdf evidence uses its existing page target without requiring geometry.

## transactions, semantic capability and pages

hybrid computes at most one embedding before opening a transaction. `read_snapshot` then
owns one repeatable-read, read-only snapshot for authorization, ranking, hydration
and presentation, and ends it. entering with an open transaction raises rather
than discarding a caller's writes. reopening uses its caller's transaction and
does no network work.

browser semantic retrieval has fixed windows of 200 chunks each for media and note
owners, independent of page size/offset. scope, filters, active model and ready
index eligibility apply before the budget. enrichment adds no embedding or ann
read. cosine eligibility is unchanged; approximate recall is bounded, not global
top-k. lexical evidence and semantic-only evidence have separate provenance.

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
deadline. cancellation joins cleanup. api caps are direct400/lexical1000/hybrid1800
ms; client and bff whole-read caps are1000/1750/2500 ms, including body/decode and
the complete prefix walk. search has no automatic retries. api timeout is
`E_SEARCH_TIMEOUT`; browser/bff timeout is `E_UPSTREAM_TIMEOUT`. the api cap starts
cancellation; cleanup may outlast it, while the browser cap bounds waiting.

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
resets paging and hides old-view rows. clear filters preserves query/view; reset
returns empty resources. unsupported passage kinds stay unsupported, with controls
to return to resources or clear kinds. counts describe loaded rows only.

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
permanent static gate. there is no permanent behavioral suite.
