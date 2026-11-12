# resource graph

ordinary user links belong to the replicated authored graph. server-owned
citation, system, note-body embed, document-embed, discovery and directed assistant
evidence facts retain their existing owners. both project into `resource_edges`
for server reads; a relational authored row is never another write authority.
[resource references](resource-references.md) owns presentation and opening;
[connections](connections.md) owns discovery.

## owners

`node/authored` owns immutable user-link endpoint bindings, causal membership and
fractional endpoint order. device sqlite owns local commands and queries. python
`services/authored` owns account-head serialization, the feed and relational
materialization. `resource_graph/edges.py` still owns derived fact shapes;
ordinary link materialization delegates to the authored semantic owner.

`refs.py` parses canonical `<scheme>:<uuid>` identities. `resolve.py` and
`resource_items/items.py` supply viewer-scoped domain/prompt reads.
`connections.py` projects visible adjacency; `citations.py` projects historical
evidence; `context.py` projects current chat admission. these are distinct reads,
not interchangeable link writers. source captures retain literal labels and
quotes without granting permission to read source bytes.

## ordinary links

a user link has `kind=context`, no ordinal or rationale snapshot, and one permanent
id per sorted endpoint pair. new pairs derive uuid5; seeded known pairs retain
their old ids, including while semantically removed. conflicting bindings are
invalid. old insertion orientation may remain in the relational projection;
semantic membership is undirected. message endpoints use this same ordinary-link
authority.

membership compares add vectors with observed removal vectors. a link is visible
only while its membership and authored endpoints are live. deleting an endpoint
hides incident links without deleting their canonical state; revival reveals
still-live membership. an explicit unlink remains removed. moving a link changes
one endpoint's position and never adds membership or moves the opposite endpoint.

endpoint order is `(fractional_position,link_id)` using byte ordering. equal keys
are legal. insertion inside an observed equal-key run rekeys only that run and the
new occurrence between its nearest distinct neighbors. no dense-rank rewrite or
version-conflict whole-body command remains.

unlink, resource deletion and join are distinct commands. unlink preserves both
resources. resource deletion covers only its observed touch vector and never
consumes neighboring notes. join copies observed content, preserves destination
identity and does not redirect independent source relationships. all are prepared
and committed through the same local authored transaction.

## machine facts and read projections

`ConnectionOut` retains exact edge id, direction, kind, origin, snapshot,
source/target/other and ordering facts. `other` is opposite the query endpoint.
server reads honor semantic visibility for authored roots and incident links.
local authored adjacency remains authoritative online; separately available
machine facts never replace it with stale server-authored rows.

`CitationOut` retains edge id, source-local ordinal and captured item. its disclosure
identity, literal quotation, source attribution and historical context come from
the captured evidence. current source access controls reading/actions. assistant
supports/contradicts/context facts with rationale remain directed evidence and
are not represented as additional undirected user links.

note-body embed facts are rebuilt solely from the canonical owner's embedded
references, in the same server transaction. they retain directional meaning and
are not additional authored membership. no adapter invents attribution,
replacement quote text or approximate identity matches.

## citations

ordinal citations are source-owned `origin=citation`, `kind=context` facts with
null user ownership. source readability authorizes their visibility; null ownership
never means public. oracle readings, article embeds and native quoted posts use
the native citation writer and captured output. librarian citations instead belong
to their assistant message and retain only resource references or urls with live
locators. they do not create graph context membership. no relationship taxonomy
is exposed.

`source_citations.py` binds imported occurrences to ordinary citation ids.
article publication retires old bindings before their citation rows; immutable
capture reuse retains existing bindings. known references need no separately saved
target. absent captures use real source-owned external snapshots.

completion consumes admitted complete captures of the exact declared revision,
including independent imports. it fills unknown observations under the enclosing
serializable mutation, never replacing known words, literal attribution, credits
or captured-empty bodies. edge identity, creation time, bibliographic reference
and known captured extent remain fixed. completion changes no source composition.
current source visibility and capture admission are checked inside the transaction.

captured evidence retains its original base and one immutable `completion_ref`.
only admitted item/location projection merges the later observation; raw/copyable
evidence never stores that merged view as a new base. denied proof leaves original
facts intact and exposes no new fields or private proof id. supplementary metadata
on a known excerpt grants no full-body root or context traversal; a URL-only base
may use its proof for its first body at the existing admitted root positions.

saved x presentation membership uses proved aliases and primary captures; incidental
context never makes a post a member. match incoming declared revision and retained
evidence independently, deduplicate before paging, and retain existing edge cursor
order. citation snapshots supply historical presentation, never current target text.

source navigation resolves the bound article/native occurrence as a document-fenced
point; generated sources open their message/oracle resource. target navigation
opens retained exact evidence or the known external reference. stale/ambiguous
geometry cannot redirect to another occurrence. original article excerpts and
generated evidence are capture roots; imported fragment citations are not. extend
only one admitted context hop from independently established roots. explicit
capture saving freezes that readable body manifest and publication transfers only
authorized direct bodies; supplementary metadata proofs add no body admission.
provider acquisition retains its separate pinned-context manifest.

## librarian references

attachments belong to an immutable user message; citations belong to its answer.
opening either resolves current source availability and exact coordinates. a missing
or changed source is not reconstructed from graph snapshots. ordinary authored
message links use the shared graph and open `/librarian?message=<id>`.

message attachment membership does not gate model reads. the librarian uses current
account authorization and its run's message-sequence horizon. source context is
assembled at execution; the [chat owner](chat.md) defines its bounds and queue.

## retention and source availability

canonical authored resources, links, passage bindings and necessary causal state
are retained. projections hide semantic deletion; they do not physically tear down
independent writing or cascade incident canonical state. source-byte teardown
retains authored quotes, annotations, passages and references. absent source
bytes or permission grants no reading access, and unknown publication provenance
never licenses blind offset reuse.

server-owned facts keep their owning teardown rules. preserving historical
capture is not permission to resurrect source bytes, old editor sessions or undo
history. [authored notes](notes.md) owns durable commit/replication; the
[release issue](../issues/release-local-first-writing.md) owns migration and paired
client qualification.
