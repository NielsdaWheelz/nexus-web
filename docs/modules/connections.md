# connections and suggestions

connections inspects relationships. empty resource composers author neutral user
connections through inline `@` target search.
discovery writes machine connections. suggestions publishes ranked candidate refs
to read or file; it owns no destination membership.

connections uses the [shared resource outline](resource-references.md), including
recursive direct-link disclosure. filters apply only to roots.

connection reads remain complete and independent of outline ancestry: exact,
bidirectional, cursor-paged adjacency. branch projection hides only facts already
traversed on that path; distinct ancestor facts retain their evidence and actions.
chat context passes its existing aggregate `admission_edge_ids` into the branch;
exploring never admits context or changes its version. reader association metadata
does not imply a traversed edge. owner rollup remains confined to existing roots.

local add-item menus, drops and empty resource composers retain link creation. source text is primary, attribution secondary, and rationale/link notes
remain separate.

| owner | contract |
| --- | --- |
| `services/resource_graph/{edges,connections,context}.py` | one link writer; fact projection and mutations; shared chat membership |
| `services/resource_items/{capabilities,targets}.py` | symmetric endpoint admission and read-only target search |
| `services/connection_discovery.py` | queue, status, dismissal, retrieval, judgment and fenced publication |
| `services/suggestions.py` | exact lectern/library ranking; direct quick reads |
| `services/suggestion_shortlists.py` | background publication, bounded current reads and admission |
| `services/resource_graph/owners.py` | endpoint-to-work projection used by exclusions and ranking |
| web `lib/resourceGraph/useReferenceInput.ts` | visit-owned inline insertion; shared queue sends frozen intent |
| web `lib/resourceGraph/useLinkComposer.ts` | thin mutation adapter for saved uploads |
| web `components/connections/ConnectionsSurface.tsx` | paginated facts, owner actions and verified creator navigation |
| web `app/(authenticated)/media/[id]/evidence/` | passage-aligned connections, source notes and annotations |
| web `components/collections/SuggestionsSection.tsx` | destination-owned add, stable survivors and bounded refill |

python paths are relative to `python/nexus/`; web paths to `apps/web/src/`.
link commands and their outputs are in [resource graph](resource-graph.md).

## relationships

user links are canonical unordered pairs: `origin=user`, `kind=context`, no
ordinal, snapshot or source order. the database enforces viewer/pair uniqueness;
the writer owns shape, visibility and atomic materialization. endpoint ordering
is independent. search and pre-submission cancellation write nothing.

connections preserves one row per fact: user, assistant, discovery, citation,
annotation and source-owned attachment. directed facts retain their meaning.
only the owning operation supplies removal. assistant creation and undo come
from durable receipts; legacy bare edges expose neither invented navigation
nor generic delete. removing a link never deletes its resources or note body.

chat membership combines incident user links and outgoing bare citation/system
context facts. its context view reads that membership, not the owner's connection
rollup. complete detachment removes every current admission fact for the target,
including ordinary links, and preserves historical message citations. its expected
context version prevents a stale retry erasing a later attachment. new turns use
current membership; admitted turns retain frozen scope. a linked chat exposes
completed branches through bounded reads, without traversing its attachments.

## admission and actions

`resource_items/capabilities.py` gives each scheme one symmetric `link_mode`:
`direct` (media, library, highlight, page, note_block, conversation, message,
oracle_reading, artifact, contributor, podcast, passage_anchor),
`materialize_passage` (content_chunk, evidence_span, fragment,
oracle_passage_anchor, reader_apparatus_item: confirmation creates a durable
`passage_anchors` row) or `none` (artifact_revision, external_snapshot).
relationship ids are never targets. a link grants no ownership or edit right.
`search/pickers.py` alone owns target admission, visibility,
exclusion, dedupe and cursors (one bounded pass, see [search](search.md)); a
selected passage is never replaced by its whole document or a nearby match.

`ConnectionOut.mutation` names only what the owning operation can do: `unlink`,
`dismiss_discovery`, `detach_context` or `undo_assistant_write` (the edge's
`tool_calls` row id, absent once undone). `creation` is one flat record: the
authorship, `tool_call_id`, `generation_id`, and `conversation_id`/`message_id`
while the answer exists; it is null unless the viewer's own completed
`nexus.edge.create` call created the edge. citations, embeds and link-note
attachments have no generic unlink; detaching a context fact never erases the
citation occurrence.

chat attachment ranks come from one allocator in `edges.py`: reuse the target's
earliest rank or append, under the conversation row lock (two chats lock in id
order). each chat endpoint ranks independently; removing one reason never
reorders a still-attached resource. `nexus.resource.read` pages a linked
conversation's completed messages across branches in `(seq,id)` order, labelled
per segment and bounded by `READ_DOCUMENT_MAX_CHARS`; a changed source makes the
cursor stale. old stance/synapse/resonance vocabulary survives only in
migration inputs and immutable history, never as an active alias.

## discovery

note/page connections offer find connections. existing highlight creation,
pdf highlight creation, media-unit readiness and note reindexing enqueue scans.
the ui refreshes after settlement and announces success only for outcome `ok`;
an idle queue alone proves no successful generation.

- only discovery writes `origin=discovery`: source is media, page, note or an
  owned highlight; target is media, note or evidence span; snapshot rationale is
  the stored rationale.
- `ok` replace-sets that source's discovery facts, including an empty set.
  `skipped` and `terminal_failed` leave them unchanged. assistant work survives.
- at most twelve candidates, four links and two links per work. exclude self,
  page-owned notes, existing relations and dismissed work pairs.
- one job key is `connection_discovery_scan:<user>:<ref>`; queueing is flush-only
  inside a savepoint. `CONNECTION_DISCOVERY_ENABLED=false` disables admission.
- every attempt builds its `connection_discovery-input.v2` fresh and generates
  once; nothing replays. publication runs under the actual job lease in a fresh
  serializable transaction, rechecking visibility and exclusions.

already-related checks read relations incident to the source itself and project
the far endpoint to its work. a highlight scan therefore does not inherit every
relation of its media. dismissals project both endpoints to works: dismissing
one passage suppresses sibling passages and scans from either work, including
a dismissal committed while generation runs.

| api | result |
| --- | --- |
| `POST /connection-discovery/scans {ref}` | `202 {data:{status,outcome}}` |
| `GET /connection-discovery/scans?ref=` | `{data:{status,outcome}}` |
| `POST /connection-discovery/edges/{id}/dismiss` | `204`; unknown/foreign `404`, wrong origin `409` |

status is `idle | pending | running | failed`; outcome is null or
`ok | skipped | terminal_failed`. a retryable failed job reads pending; dead or
terminal model failure reads failed. both scan routes require a visible source.
the job payload is `{user_id,ref,reason}`, result `{status,error_code,ref}`;
the existing registry owns retries and its renewable 300-second lease.

## suggestions

background ranking uses one read-only repeatable-read snapshot and one `now()`.
get/view never rank, admit work or acquire corpus graph/embedding inputs. lectern
suggestions exclude finished media and current members; library suggestions
exclude destination members and require relational evidence; quick reads retain
their separate unfinished-document/time eligibility.

sql assigns continuity, arrival, rediscovery or graph-thread families and order,
with twenty candidates per family. lectern rotates families then backfills;
libraries take strength order. diversity retains the current reason, kind,
anchor and author caps while alternatives exist. continuity/arrival borrow no
relation evidence. semantic neighbors use only the calibrated embedding identity
and threshold before limiting rows. this cutover changes no ranking policy.

both suggestions destinations share the
[publication contract](suggestions.md): at most 80 retained candidates, ten
displayed, current eligibility on get and independent `/view`, and active-only
admission through `/refresh`. later publications stage until request or revisit;
acknowledged additions refill locally without replacing eligible survivors.
the destination owns adds; focus repair only acts on the control that still owns
focus. full lecterns retain links and uncertain-command recovery. successful
empty, first preparation, read failure and suspended work remain distinct.

`GET /lectern/quick-reads` keeps its direct `QuickReadsOut` owner and current
eligibility. it includes lectern members and exposes add/check/on-lectern through
the shared control; opening never enqueues. collection rows show factual item
metadata; explanations of relationships remain in opened-resource connections.
