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
| `links.py` | flush-only source/target materialization and preserving unlink; serializable link-note commands |
| `order.py` | endpoint display order for every incident fact; dense ranks and exact placement |
| `../outline.py` | bounded mixed reads and serializable command batches |
| `connections.py` | one row per visible incident fact, direction and owner-supplied mutation |
| `citations.py` | canonical ordinal edges composed with captured evidence |
| `context.py` | `context_facts_sql`, current admission, versioned complete detachment |
| `cleanup.py` | resource death, link-note cleanup and orphan external snapshots |

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
source/target/other, link note, creation, mutation and creation time. endpoints are
`ResourceItemOut`; the link note contains its own item. `other` is the endpoint
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
| `PUT /resource-graph/links/{id}/note` | attach/create by note id; resend converges |
| `DELETE /resource-graph/links/{id}/note/{note_id}` | detach that note; preserve its prose; absent succeeds |
| `GET /conversations/{id}/context` | one shared item per admitted target, admission edge ids, context version and aggregate removal capability |
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

`unlink {link_id, require_unannotated}` is an unlink-only atomic batch; duplicate
ids use the strictest annotation precondition. absent/foreign ids succeed without
effects; owned non-user facts refuse. the annotation precondition is explicit
on every command and refuses annotated links before detachment. acknowledgement
returns five empty arrays, with no endpoint projection.
`unlink_in_txn` preserves resources and detaches relationship annotations without
deleting their prose. link-note cleanup uses
`edges.detach_link_notes`, then `edges.delete_edge`; it does not delete note prose.
fact-specific unlink, discovery dismissal, assistant undo, resource deletion and
complete context detachment remain distinct operations.

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

ordinal edges die with their source; other facts die with either endpoint. a dying
endpoint takes its link-note motif, then orphan external snapshots are collected.
explicit note deletion retains its domain rule of deleting historical citation
edges. preserved historical text is not permission to resurrect deleted resources,
editor drafts or undo entries.

source deletion keeps its domain cleanup rules and does not advance the explicit
context-edit fence. automatic publication skips targets that are no longer
readable; it may still add unrelated readable targets from that response.
