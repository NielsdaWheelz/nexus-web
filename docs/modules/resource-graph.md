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
semantic membership is undirected. conversation endpoints do not create a second
ordinary-link authority.

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

`CitationOut` retains edge id, ordinal, role and captured item. its disclosure
identity, literal quotation, source attribution and historical context come from
the captured evidence. current source access controls reading/actions. assistant
supports/contradicts/context facts with rationale remain directed evidence and
are not represented as additional undirected user links.

note-body embed facts are rebuilt solely from the canonical owner's embedded
references, in the same server transaction. they retain directional meaning and
are not additional authored membership. no adapter invents attribution,
replacement quote text or approximate identity matches.

## chat context

canonical admission is direct incident user links plus outgoing bare
citation/system context facts. past message citation ordinals are not admission.
`resource_view_states.context_order_key` preserves admission order independently
of mutable display position; automatic facts retain their own source order.
display moves never change context membership.

the context lane of `ResourceVersion` remains an opaque equality fence for
explicit chat admission edits. complete target detachment checks its observed
context version; an absent target succeeds, and a stale retry cannot erase a
new attachment. ordinary user-link additions/removals still pass through the
shared authored transaction; directed automatic facts retain their own owner.

run admission stores its context version after attachment edits. publication
preserves historical citations and adds future context only while that admitted
version still matches. automatic additions do not advance the explicit-user fence.
provider work never runs under domain locks. prompt expansion remains read-only
and never broadens source permissions.

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
