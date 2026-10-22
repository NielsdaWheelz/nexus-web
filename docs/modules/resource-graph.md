# resource graph

the graph stores one relationship fact per `resource_edges` row. its writer owns
which facts may exist; connections projects direct adjacency; citations projects
historical evidence; context projects current admission. these are different reads
of the same facts. [resource references](resource-references.md) owns their common
presentation and opening contract; [connections](connections.md) owns discovery.

## owners

paths below are relative to `python/nexus/services/resource_graph`.

| owner | contract |
| --- | --- |
| `refs.py` | canonical `<scheme>:<uuid>` identity; `require_ref` rejects invalid requests |
| `resolve.py` | viewer-scoped domain/prompt reads; writes use `assert_ref_visible` |
| `edges.py` | fact shape, endpoint visibility, uniqueness, rank and version changes; flush-only writer |
| `links.py` | flush-only source/target materialization and exact preserving unlink |
| `order.py` | endpoint display order for every incident fact; dense ranks and exact placement |
| `../outline.py` | bounded mixed reads and serializable command batches |
| `connections.py` | one row per visible incident fact, direction and owner-supplied mutation |
| `citations.py` | canonical ordinal edges composed with captured evidence |
| `context.py` | `context_facts_sql`, current admission, versioned complete detachment |
| `cleanup.py` | resource death and orphan external snapshots |

`resource_items/items.py` supplies bounded current presentations.
`resource_items/evidence.py` captures and projects historical evidence and resolves
source targets. neither the web nor graph adapters invent source attribution or
replacement quotation text.

## facts and reads

a user link is `origin=user`, `kind=context`, with no ordinal or snapshot. its
pair is unordered and unique per viewer, enforced by a normalized-pair index.
new links retain insertion source/target orientation in the existing columns;
this is creation provenance, not semantic direction. sorted endpoint order owns
locking only. endpoint-specific display order belongs to the rank mechanism. a direct
connection may instead be an annotation, embed, citation, assistant write, discovery
fact or automatic context membership. unaccepted suggestions are not facts.

`ConnectionOut` retains `edge_id`, direction, kind, origin, snapshot, rank, ordinal,
source/target/other, creation, mutation and creation time. endpoints are
`ResourceItemOut`; `other` is the endpoint
opposite the query. user links are undirected. connection queries page newest first
using creation time and edge id. arranged disclosure uses the mixed outline read;
owner rollup remains for surfaces explicitly gathering an owner's references.
insertion receipts orient `other` opposite the actual materialized request source.
an identical minted-id retry returns that source without resolving transient
candidates again. a reused existing pair uses the current request's source.

`CitationOut` is `{edge_id, ordinal, role, item}`. its item keeps the cited resource
as disclosure identity while words, attribution, colour and target come from the
stored captured evidence. live visibility controls current actions and source
capabilities. machine relationship rationale occupies its own snapshot field and
never substitutes for the referenced object's body.

## commands and retry rules

| route | contract |
| --- | --- |
| `POST /resource-graph/connections/query` | visible paged facts; unknown/private roots yield no adjacency |
| `GET /resource-graph/outline/{ref}?limit&cursor` | bounded exact mixed adjacency, rank then creation/id; version-bound cursor conflicts on change |
| `POST /resource-graph/commands {commands}` | atomic insertion, text, rank and structural commands; returns outlines, nodes, deleted refs, insertion receipts and actual link-version proofs |
| `GET /conversations/{id}/context` | `{items: [{item, admission_edge_ids, mutation}]}`: one shared item per admitted target in first-attachment order, with the ids of its current admission facts; each detach mutation carries the context version read in the same statement |
| `DELETE /conversations/{id}/context/{target_ref}?expected_context_version=…` | remove every current admission fact atomically; absent succeeds; present with stale version is 409 `E_CONTEXT_CHANGED` |

insertion recognizes an owned user `link_id` before resolving source/target or
placement. a landed retry returns the stored canonical endpoints, including after
passage candidates retire. another id for an existing pair returns `created=false`
without moving it, unless `require_created=true` requires that exact edge id and
refuses the occupied pair. exact retries of that id still succeed. source/day/selection highlight, passage anchors and the link
materialize atomically; invalid targets leave no partial source. reader sources
carry their frozen publication generation; replacement conflicts before any
highlight is created. `position=null`
appends at commit; a position carries its exact predecessor and expected links
version. missing anchors and stale versions conflict. `insert_note` preserves an
existing note's body. minted links must survive their batch unchanged.

`unlink {link_id}` is an unlink-only atomic batch; duplicate exact ids are applied
once. absent succeeds without resolving a replacement. foreign or unsupported
origins conflict atomically. owned user/discovery/assistant edges permit removal;
acknowledgement has empty result arrays and readers reconcile through the existing
graph change signal. `unlink_in_txn` preserves resources, historical receipts and
all other edges. `edges.delete_edge` removes only that edge's occurrence state and
advances endpoint versions; retention and source-owned cleanup remain unchanged.

relationship annotations no longer exist. migration 0307 converts each validated
old attachment independently to an ordinary user link, changing origin only.
ids, endpoints, ranks including null, prose and original relationships survive.
invalid/foreign/invisible endpoints, conversation attachments, inconsistent view
states and unordered pair collisions refuse before effects. affected links lanes
advance once per endpoint, suggestions input once. visibility rules are frozen in
the migration. release requires stopped writers and verified backup; rollback uses
that backup. no API, motif cleanup or annotation guard remains.


## context ordering

canonical membership is direct incident user links plus outgoing bare
citation/system context facts. annotation links and past message citations are not
admission. a target retains its earliest attachment rank while any reason remains.
`resource_view_states.context_order_key` preserves user-link admission order
independently of its mutable display `order_key`; automatic facts retain their
`source_order_key`. display moves never change context membership or its version.

unchanged complete derived facts retain their ids and display ranks. a changed
fact has a new identity; its old occurrence state is removed before deletion.
every changed fact advances both endpoints' links lanes. semantic page-note
traversal, place counts and historical citation ordinals retain their own rules.

the `ResourceVersion` context lane orders user admission edits independently of
link and branch versions. explicit user membership edits lock the conversation
and advance the fence for each changed admission fact, even if another fact still
admits the target. the version is an opaque equality precondition, not a command
count. complete target detachment advances it once.
chat-to-chat endpoints lock in sorted id order. an absent target detaches
idempotently; a present target requires the observed version. a stale retry after
reattachment cannot remove the new intent. clients never silently rebase removal.

admission stores `ChatRun.admitted_context_version` after its own attachment edits.
publication preserves valid historical citations and adds their targets to future
context only when that value still equals the current version, compared once for
the batch. automatic additions invalidate reads but do not advance the user-edit
version. a null pre-cutover version suppresses additions. a later explicit
attachment or newly admitted response may add a resource again.

publication and deletion lock conversation, run, then job. writers needing only
run/job retain that suffix order. no provider call occurs under these locks.
context changes invalidate both endpoints and affected note reads through the
existing change owners. expansion is read-only and never broadens prompt scope.

## resource death

ordinal edges die with their source; other facts die with either endpoint.
independent links at surviving resources remain; orphan external snapshots are collected.
explicit note deletion retains its domain rule of deleting historical citation
edges. preserved historical text is not permission to resurrect deleted resources,
editor drafts or undo entries.

source deletion keeps its domain cleanup rules and does not advance the explicit
context-edit fence. automatic publication skips targets that are no longer
readable; it may still add unrelated readable targets from that response.
