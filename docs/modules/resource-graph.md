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
| `links.py` | serializable link and link-note commands |
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
endpoints are stored in canonical uri order; the pair is unordered and unique per
viewer. endpoint-specific order belongs to the existing rank mechanism. a direct
connection may instead be an annotation, embed, citation, assistant write, discovery
fact or automatic context membership. unaccepted suggestions are not facts.

`ConnectionOut` retains `edge_id`, direction, kind, origin, snapshot, rank, ordinal,
source/target/other, link note, creation, mutation and creation time. endpoints are
`ResourceItemOut`; the link note contains its own item. `other` is the endpoint
opposite the query. user links are undirected. queries page newest first using
creation time and edge id. recursive disclosure uses `rollup=exact`, both directions;
owner rollup remains for surfaces explicitly gathering an owner's references.

`CitationOut` is `{edge_id, ordinal, role, item}`. its item keeps the cited resource
as disclosure identity while words, attribution, colour and target come from the
stored captured evidence. live visibility controls current actions and source
capabilities. machine relationship rationale occupies its own snapshot field and
never substitutes for the referenced object's body.

## commands and retry rules

| route | contract |
| --- | --- |
| `POST /resource-graph/connections/query` | visible paged facts; unknown/private roots yield no adjacency |
| `POST /resource-graph/links` | create/materialize under client `link_id`; same pair is reused; conflicting id is 409 |
| `DELETE /resource-graph/links/{id}` | delete that user fact; absent succeeds; other origins have their own commands |
| `PUT /resource-graph/links/{id}/note` | attach/create by note id; resend converges |
| `DELETE /resource-graph/links/{id}/note/{note_id}` | detach that note; preserve its prose; absent succeeds |
| `GET /conversations/{id}/context` | one shared item per admitted target, admission edge ids, context version and aggregate removal capability |
| `DELETE /conversations/{id}/context/{target_ref}?expected_context_version=…` | remove every current admission fact atomically; absent succeeds; present with stale version is 409 `E_CONTEXT_CHANGED` |

link commands run inside the existing serializable retry boundary. create resends
the same id; a deleted link can be created again. link-note cleanup uses
`edges.detach_link_notes`, then `edges.delete_edge`; it does not delete note prose.
fact-specific unlink, discovery dismissal, assistant undo, resource deletion and
complete context detachment remain distinct operations.

## context ordering

canonical membership is direct incident user links plus outgoing bare
citation/system context facts. annotation links and past message citations are not
admission. a target retains its earliest attachment rank while any reason remains.

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
