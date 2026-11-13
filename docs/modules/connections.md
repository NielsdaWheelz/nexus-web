# connections and suggestions

connections inspects relationships. the shared outline insertion line authors
neutral user connections through inline `@` target search.
discovery writes automatic librarian links. suggestions publishes ranked candidate refs
to read or file; it owns no destination membership.

connections uses the [shared resource outline](resource-references.md), including
recursive direct-link disclosure. filters apply only to roots.

connection reads remain complete and independent of outline ancestry: exact,
bidirectional, cursor-paged adjacency. branch projection hides only facts already
traversed on that path; distinct ancestor facts retain their evidence and actions.
reader roots use exact media adjacency; membership facts do not enter the
outline's traversal history. librarian attachments belong to individual messages
and write citation edges to visible sources. these facts create no authored
membership or model admission scope.

keyboard and the touch accessory own structural insertion and rearrangement.
external resource/file admission keeps its existing owner. source text is primary,
attribution secondary, and relationship rationale remains separate.

upload-and-link retains its files, current position, upload ids and link ids in
the actual visit cell. mobile hiding keeps the pipeline running; actual visit
retirement and account teardown stop remaining browser work. retries use the
same ids. uploaded media and links already admitted to the shared write queue
remain server/tab-owned. the common work guard protects actual task loss.

the librarian is the presentation role for discretionary connections,
never a stored actor or command authority. routine linked-by prose
is omitted; relationship details retain useful provenance. shared row metadata
attributes the rationale, never the quoted source passage. rationales retain
inline machine text. original
origins, creation receipts and server-supplied capabilities remain authoritative.

| owner | contract |
| --- | --- |
| `services/resource_graph/{edges,connections}.py` | one link writer; fact projection and mutations |
| `services/resource_items/capabilities.py`, `services/search/pickers.py` | symmetric endpoint admission; read-only target search |
| `services/connection_discovery.py` | queue, status, retrieval, judgment and fenced publication |
| `services/suggestions.py` | shared bounded candidates and eligibility; direct quick reads |
| `services/suggestion_shortlists.py` | librarian curation, publication, current reads and admission |
| `services/resource_graph/owners.py` | endpoint-to-work projection used by exclusions and ranking |
| web `lib/resourceGraph/useReferenceInput.ts` | visit-owned inline insertion; shared queue sends frozen intent |
| web `components/connections/useConnectionAttachments.tsx` | visit-owned upload pipeline; shared queue sends each frozen link |
| web `components/connections/ConnectionsSurface.tsx` | paginated facts, owner actions and verified creator navigation |
| web `app/(authenticated)/media/[id]/evidence/` | passage-aligned connections, source notes and annotations |
| web `components/collections/SuggestionsSection.tsx` | destination-owned add, stable survivors and bounded refill |

python paths are relative to `python/nexus/`; web paths to `apps/web/src/`.
link commands and their outputs are in [resource graph](resource-graph.md).

## reader inventory

`reader_connections.py` reads bidirectional adjacency, including source-owned
citations through proved primary x presentation membership. reader inventory,
counts and child probes share that membership in the document map's snapshot;
the map has no independent links-version field. `reader_evidence.py` merges far
refs with native highlights and source references, retaining distinct citations
by edge id even when they share a target. citation roots retain historical items;
other grouped roots retain their existing native-content precedence. incidental
quoted context does not become the containing reading's source membership.
message links open the message in the single librarian timeline. saved
references remain on their message. source connections show quoted questions as
`you` and cited answers as `librarian`; deleting a turn removes both facts. source evidence lanes and finite foreground authored
catch-up refresh other profiles. capture map versions sum distinct fragment lanes,
so changing a nonmaximum lane changes the token.
current resource presentation is hydrated in batches; primary annotations carry
their complete canonical rich body and body version.

native evidence retains the current reading's scope. generic graph refs first
resolve their source target in that reading; only a matching source with a
located complete passage selects its bounded presentation and destination.
other refs retain their own authorized current presentation. local placement
is projected separately from the same source-target result; missing local
geometry never makes a readable foreign resource unavailable. historical
connection snapshots do not supply current root bodies.

root placement uses only that resource's own current local extent. whole resources
and other-source passages have no local extent; rejected local locations remain
visible as unavailable. the margin lists placed roots only. all is one flat list
without headers, in tier order: placed, whole, unavailable.
unaligned graph roots follow their first incident fact in document order, never
their label. sibling continuation names the source and insertion position derived from
that first fact. a separate authored placement names only an admitted
user edge and its own original predecessor. moving it can leave an independent
root supported by another fact. supported source-aligned and unavailable native
roots continue beneath their resource and have no authored placement. an explicit
null child insertion source denies child insertion, independently of sibling
continuation and exact authored placement. a native passage needs nonempty quoted
words, not a locator: missing or stale locations never retarget insertion to the
document. native quotes use the body when present, otherwise the label; an empty
body stays empty. apparatus producers trim canonical text, so the bounded head
retains this empty/nonempty distinction. source details apply the same quote
contract; location reasons do not grant or deny insertion.

the reader exposes four native checkbox facets, each a glyph and its count, after
its margin/all radio choice in one row that wraps only when the companion cannot
hold it. a facet's name is its type label, shown as help on hover and keyboard
focus, with the count's description beside a dash. counts describe the current
view: the margin counts placed roots across the document, never just the visible
stretch; all counts every root. counts are exact only when every contributing source is
complete and, in the margin, the document is mounted: highlights require local
annotations and remote evidence; links require local links and remote evidence;
citations and librarian links require remote evidence. a ready remote map is
complete only at ready/empty, not partial. otherwise the count is a dash described
as unavailable, incomplete or loading, in that precedence. partial totals never
masquerade as exact zero or a lower bound. available content survives another
source loading or failing.
all types off offers show-all regardless of completeness; resetting focuses the
first checkbox. incomplete empty inventories cannot claim global absence.

facets/counts cover distinct direct roots only and can overlap. native highlights
and source references add their own facets; ordinal citations add citations;
assistant/discovery facts add librarian links (`machine_links`); other facts add
links, which are not exclusively human-authored. generated ordinal citations
remain citations. expansion leaves counts and filters unchanged. each root
starts without an entering edge;
shared lazy disclosure exposes every exact relationship and its own capability.
one grouped resource never supplies an aggregate unlink action.
all roots share the outline editing session with their descendants; grouped roots
have no incoming relationship. filters and margin/all retain folds and sessions.
pending creations remain reachable until a complete read accounts for their exact
edges. composite maps preserve source media, continuation and placement together.

## reader geometry and reads

`EvidencePane` owns complete membership (`order`), facets, arrivals, keyboard
successors and unlink recovery. `EvidenceRow` passes local projections by value to
`ResourceOutlineRow`; an owned projection enters `AuthoredRow` without a row read.
source stubs retain `ReferenceRow`. a held row keeps one `li`; held occurrences
outside the visible membership remain keyed and hidden, retaining their editors.

three contracts govern all-items:

- **c1, height:** an unclipped placed highlight's own quote and annotation commit at resting
  height. `createReaderAnnotations` publishes marks immediately, then fills clipped
  excerpts once per content-addressed capture revision. refused scopes stay compact
  and retry on the next read. failures use the annotations store's existing retry.
  before a new embed row is admitted, that same owner prepares its display dependencies
  through existing resolve batches of at most 100 and full-excerpt reads. the snapshot
  carries whole/annotation-field targets, required source labels and full excerpts to
  their consumers. existing complete displays survive refresh; new displays wait.
  full-query results remain distinct from label-only projections and apply only to
  the same capture. dependency-preparation replies must share the parent read's store
  revision before display publication; root quote fills use capture identity across
  store revisions. this adds first-admission
  latency without delaying marks or eagerly opening writing documents or linked children.
  placed source highlights reserve two-control geometry and text exclusion
  throughout their own heads, including nested non-in-row resource heads and
  leaves. child availability can add its control without changing that own
  content's minimum height or line wrapping. sibling child sections, outside
  occurrences and flat in-row embeds retain their density.
- **c2, conservation:** `useEvidenceWindow` remembers measured heights. during motion,
  a remount reserves at least its remembered height, so replacing a gap conserves
  extent. memory only rises in motion; one second after the last offset change,
  reservations drop and the observer learns true heights. first-sight children can
  still expand at rest; unknown rows use the existing estimate.
- **c3, compensation:** geometry above the anchor is absorbed before paint with
  relative, instant `scrollBy`, preserving the compositor's scroll. the anchor is
  list-relative, so scrolling changes its screen position without changing its
  stored layout coordinate. the first fully visible row wins, otherwise the clipped
  row; filtering transfers its place to the next surviving row in the old order.
  if input has passed the old anchor before growth or admission lands, the prior
  actual offset array selects among surviving rows in the old layout. a removed
  filter anchor retains its successor's assigned position. remembered heights
  predict the next range; they do not substitute for prior actual geometry.
  a membership commit retains surviving rows from the previously published range
  through compensation. the carried range enters the existing frame comparison,
  which retires its extras on the next commit. both ranges can briefly be mounted.

one node-bound `ResizeObserver` follows replaced rows and schedules both restoration
and margin measurement. compensation runs after commits, during resize delivery,
and before a scroll frame chooses a new anchor. the observer never flushes react.
`scrollFrame`, shared with index and queue windows, coalesces port events into one
rAF and commits range changes synchronously before paint. reservation release also
publishes once. reveal, focus and restoration completion explicitly release their
hold and anchor that row at its revealed offset; reader input resumes normal policy.
the window alone owns the root's minimum height: its last measured total extent
prevents a shrinking list from clamping the port before relative compensation.
commit, frame and input handling publish the new extent after holding; the observer
measures and requests the existing frame. margin clears the floor. only a clamp
observed around this owned style write changes the remembered offset; pending
user movement is never inferred to be a clamp.

`Memory` lives in the pane's return memento beside the row and its offset. a new
publication replaces it; a changed positive width, list font or reader profile
invalidates measurements and re-observes mounted rows. a transient loading scope
never erases restored memory. returning to a remote anchor still depends on its map
arriving; see [remote return](../issues/connections-return-waits-for-remote-anchor.md).

row rest belongs to `ResourceOutlineList`: the mounted descriptor set must stay
unchanged for 150ms and contain the row. proofs survive unmounts for that list's
life, fenced by descriptor identity and refreshed at rest. `Occurrence` mounts
children only after its first rest. a remounted open row reserves its prior extent
while its children wait. hover commits are suppressed until window rest.

`HighlightAnnotation` receives its resource from its host. null means read and
absent; hosts wait for their read before mounting it. blank rows open no writing
document until annotate; bodied rows use the same read-only editor until rest or
a completed click opens their document. opening is permanent for the occurrence,
so emptying preserves focus and undo. existing bodies autosave; the creation
composer saves explicitly. actual drafts and uncommitted work pin a row; committed
pending synchronization and past undo availability do not.

c1 exceptions are explicit: unplaced highlights retain full-excerpt/source reads;
held links retain inner reads and note-document opening; remote authored roots
retain their local read; source stubs and server-owned embeds resolve remotely.
authored embed targets belong to the local replica. a present projection decides
ownership; an absent exclusively server-owned ref can resolve remotely. absence of
an authored ref stays local and does not claim deletion. every such asynchronous row
reserves its remembered extent on remount. native find and cross-row selection
cover mounted inspector content only; reader find keeps its full scope.
embedded whole-resource occurrences start their linked children closed through the
shared row's default disclosure input. chosen folds win; explicit disclosure uses
the ordinary lazy child owner. an embedded highlight's own content does not
automatically acquire a child editor or empty insertion tail after mounting.

## reader margin

**m:** `stackMargin` is pure; only text motion advances rows toward their passage
positions. the rigid target keeps passage spacing, or the preceding row's height
plus 4px when larger. the key is the passage nearest the reading line.
the common passage nearest that line
measures text motion; the key moves toward its desired top in that direction, by
at most three times that motion. without a common row the stack snaps. there is
no time term, animation or settling after text stops.

rows render at offsets; one transform on the outline scope applies the base.
the base is published before a changed placement commits, so child layout effects
measure matching offsets and transform; menu guards never see the intermediate pair.
new ring rows are measured and placed in two commits within one frame. geometry
changes can expand spacing around the key while the text is still. a focused
field or open overlay holds its row; neighbours move only enough to avoid a
collision. the existing frame retains finalized fractional tops after those
corrections. on release, each continuing row approaches the rigid target only in
the text's direction and within the three-times cap. excess or compressed gaps
can persist until text moves; immediate rigid spacing would require a jump.
changing those offsets can commit each convergence frame; unchanged rigid spacing
uses only the transform write.
height changes and new admission still require physical nonoverlap correction.
rows clip at the top like text. clicking activates a row without
realigning its neighbours.

a reveal scrolls the port to its target. the next text movement folds that offset
into the base without a jump, then the normal three-times cap returns the stack
toward its passages. dense stacks and revealed rows can remain off their passages
until text moves. popups portal outside the transformed scope. the reader's
`subscribeGeometry` publishes paired viewport and placement after source
corrections and the measuring commit, before paint; `lib/margin/useMarginLayout`
measures directly from that notification without a global scroll listener.

## relationships

user links are unordered pairs: `origin=user`, `kind=context`, no
ordinal, snapshot or source order. the database enforces viewer/pair uniqueness;
the writer retains insertion orientation, visibility and atomic materialization.
stored orientation supplies receipt provenance, never semantic direction. endpoint ordering
is independent. search and pre-submission cancellation write nothing.

connections preserves one row per fact: user, assistant, discovery, citation,
annotation and source-owned attachment. directed facts retain their meaning.
only the owning operation supplies removal. owned user, discovery and assistant
facts use preserving exact-edge unlink, independently of creation receipts.
assistant creation and historical undo remain receipt-backed. removing a link
never deletes its resources, note body or creation history.

## admission and actions

`resource_items/capabilities.py` gives each scheme one symmetric `link_mode`:
`direct` (media, library, highlight, page, note_block, message,
oracle_reading, contributor, podcast, feed, passage_anchor),
`materialize_passage` (content_chunk, evidence_span, fragment,
oracle_passage_anchor, reader_apparatus_item: confirmation creates a durable
`passage_anchors` row) or `none` (external_snapshot).
relationship ids are never targets. a link grants no ownership or edit right.
`search/pickers.py` alone owns target admission, visibility,
exclusion, dedupe and cursors (one bounded pass, see [search](search.md)); a
selected passage is never replaced by its whole document or a nearby match.

`ConnectionOut.mutation` is `remove_fact` for a removable server-owned fact,
otherwise null. authored user links use the local authored unlink command.
`creation` holds authorship, `tool_call_id`, `generation_id` and nullable
`message_id`; it is present only for the viewer's completed `nexus.edge.create`
receipt. message navigation opens the single librarian timeline. after turn
deletion, the retained receipt opens assistant-write history. citations, embeds
and highlight-note attachments have no generic unlink.

## discovery

note/page connections offer find connections. existing highlight creation,
pdf highlight creation, media-unit readiness and note reindexing enqueue scans.
the ui refreshes after settlement and announces success only for outcome `ok`;
an idle queue alone proves no successful generation.

scan starts belong to the existing visit resource draft. dispatch and an unanswered
start retain their exact source and work guard across inspector retirement; the
held recovery is visible again when the surface reopens. current shared admission
gates both start and retry. check and wake read status only. passive idle or terminal
status cannot answer an earlier request; an acknowledged retry answers that retry.
without a replay identity it cannot fence a separate still-running original. null
outcome says no result is available, never that a scan completed.

- only discovery writes `origin=discovery`: source is media, page, note or an
  owned highlight; target is media, note or evidence span; snapshot rationale is
  the stored rationale.
- `ok` replace-sets that source's discovery facts, including an empty set.
  `skipped` and `terminal_failed` leave them unchanged. assistant work survives.
- at most twelve candidates, four links and two links per work. exclude self,
  page-owned notes and existing relations.
- one job key is `connection_discovery_scan:<user>:<ref>`; queueing is flush-only
  inside a savepoint. `CONNECTION_DISCOVERY_ENABLED=false` disables admission.
- every attempt builds its `connection_discovery-input.v2` fresh and generates
  once; nothing replays. publication runs under the actual job lease in a fresh
  serializable transaction, rechecking visibility and exclusions.

already-related checks read relations incident to the source itself and project
the far endpoint to its work. a highlight scan therefore does not inherit every
relation of its media. removing a discovered connection deletes only its exact
edge, preserving siblings and both resources. discovery has no suppression
preferences; future scans, including one already running, may publish a new edge.
retrying removal of the old uuid never removes that replacement.

`useFactRemovals` retains server-fact removal in the existing visit draft above
filtered rows. dispatch and uncertainty carry the work guard; the held command
keeps its exact edge id. initial row removal stays disabled while
that command is unresolved, and only its held recovery may replay it. read
freshness alone is not settlement. authored unlink keeps its own local command
owner; generic outline presentation supplies no removal authority.

| api | result |
| --- | --- |
| `POST /connection-discovery/scans {ref}` | `202 {data:{status,outcome}}` |
| `GET /connection-discovery/scans?ref=` | `{data:{status,outcome}}` |

status is `idle | pending | running | failed`; outcome is null or
`ok | skipped | terminal_failed`. a retryable failed job reads pending; dead or
terminal model failure reads failed. both scan routes require a visible source.
the job payload is `{user_id,ref,reason}`, result `{status,error_code,ref}`;
the existing registry owns retries and its renewable 300-second lease.

## suggestions

browse, contextual lectern/library suggestions and daily share the librarian's
[selection contract](suggestions.md). selection owns ranked refs and optional
rationales; the destination owns adds. adopted order and rationales remain stable
through live eligibility updates and background publications. contextual additions
refill from their finite adopted pool. successful empty, first preparation, read
failure and suspended work remain distinct.

`GET /lectern/quick-reads` stays immediate and model-independent. it selects up to
five unfinished complete documents with under ten minutes remaining, including
lectern members. the shared add/check/on-lectern control keeps its existing owner;
opening never enqueues selection. quick-read rationale is null.
