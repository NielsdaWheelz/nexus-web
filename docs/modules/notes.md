# authored notes

titled pages, one-block notes, annotated highlights and undirected links form
one account-scoped authored graph. the same local query and commit owners serve
writing online and offline. source downloads, chat, imports and account operations
retain their separate owners.

## ownership

- `node/authored` owns the closed body grammar, literal projections, identity,
  causal merge, command preparation, query contracts and sqlite schema.
- `apps/web/src/lib/authored` owns the account worker/store client, durable browser
  storage, native adapter, subscriptions, provisioning and foreground transport.
- android `authored/` owns one serialized bundled sqlite connection and the fixed
  native bridge; account/document admission remains with the native session.
- python `services/authored` owns the account head transaction, bounded node
  helper, canonical postgres state, feed and relational projections. existing
  note/graph/highlight readers consume those projections and semantic visibility.
- editors own their live input and session undo groups. their adapter translates
  actual editor transactions to incremental shared operations, never a stale
  whole-body replacement.

native operations share one admitted dispatcher. requests up to 24 kib of utf8 json
use one inline frame; replies up to 24 kib return bounded inline bytes, while larger
replies return the existing transfer handle and are read without re-execution.
larger requests retain staged framing. both encodings retain the same account,
document, command lease, cancellation and 16 mib result limits; neither retries an
operation after a lost reply.

authored query subscriptions require success and failure callbacks and return one
unsubscribe function. one initial read and subsequent invalidations use those same
owners; adapters do not report failures behind the caller. read surfaces retain
accepted rows on refresh failure and publish recovery outside the content flow;
retry retains the incident, action and accepted same-query prefix until settlement.
account, query and null changes never borrow another read's rows. direct runtime,
reader, media and title subscribers explicitly retain global failure reporting.
all authored pane locators retain their canonical title subscriptions. the active
root separately publishes its literal display label through pane chrome; previews
and unfinished input never become acknowledged workspace hints.
`useAuthoredPrefix` owns one revision-consistent paginated read for both the
picker's page-count wrapper and controlled local search. null disables its read;
showing more retains the accepted prefix until its replacement lands.
document loading reads state and revision together. its first successful resource
subscription delivery may reuse that actual snapshot resource only at the exact
same revision, through the ordinary receive/bookkeeping path. the certificate is
consumed once; changed revisions, synthetic pages and prepared documents read
canonical state normally.
the note route and outline share one root-window read. its actual root request
owns paging and branch provenance; descendant windows retain their collectors.
same-account, same-ref canonical root metadata advances by successful revision,
including absence, and survives paging or refresh failure without retiring the
editing host. arrivals and inspection use that exact canonical text; edit-note
delivery waits for the actual editor handle. unknown and unavailable notes do
not admit writing documents. android's existing aggregate window cap also bounds
this canonical note-route read; failures retain their owned read retry.

an accepted `WritingDocument` owns its refresh snapshot and subscription. a failed
refresh retains the same yjs document, undo and text; `retryRead` rearms that read.
account, cached-document and attempt identity fence both success and failure.
modeled local storage errors retain recovery; invariant defects reach the existing
defect boundary. only current successful adoption clears a read incident.

`WritingRuntime` save errors describe uncommitted commands only. their inert
occurrence identity survives retries and presentation changes. one account adapter
offers the exact retry and exports only actual endangered writing, never clean
text from a failed graph operation. locally committed pending synchronization is
already saved and acquires no loss guard. pending outline input remains its own
buffer, export and recovery owner.
while a command is pending, its runtime owns the failure occurrence; a transient
store status cannot create a second stopped-store incident for that command.

branch collectors publish read and admission state into their existing controller
request. row chrome consumes that projection without starting another read. the
existing disclosure slot carries foreground waiting; root waiting uses pane
chrome. selection and routine autosave produce no narration or success notice.
failed admission retains its request, proposal and recovery through selection
and blur. automatic reconciliation resumes deferred healthy proposals only;
explicit retry renews the failed request's navigation lease before admission.

`cd apps/web && bun run gen:authored-helper` bundles `node/authored/helper.ts`
and its shared semantic imports into the shipped `node/authored/helper.mjs`.
`./scripts/test` regenerates into a temporary file and rejects stale bytes.
the frozen migration seed bundle retains its own historical semantics and is
never regenerated from the current helper.

## content and identity

one note has one permanent body element and one permanent inline yjs text. its
prosemirror shape is `body{presentation:prose|code}` with text, hard breaks, images
and typed resource embeds. formatting changes attributes and marks, not the outer
identity. code is presentation: marks and visible atoms remain stored. canonical
text and selection offsets derive from the shared projection.

ordinary resources use fresh client uuids. daily identity is account plus local
date; known bindings preserve seeded page ids, unseen days derive uuid5. opening
a day writes nothing. an empty stored title displays its date-derived default
without inserting that default into the title crdt. title storage has no display
length ceiling.

links are relationships, never ownership. explicit unlink preserves endpoints;
deleting a page, note or highlight never consumes an independent related note.
a highlight owns its single annotation body; ordinary note links confer no
annotation meaning. pdf resizing preserves the highlight id, annotation and links.

source stubs retain literal references when a source disappears, including a
deleted conversation. source deletion does not unlink the authored graph; a
captured label grants no source access.

## merge and local commit

resource visibility is any touch component greater than the corresponding
observed deletion component. deletion covers the touch vector the command read.
an unseen concurrent edit therefore revives only its addressed resource. link
membership uses the equivalent add/observed-remove rule and endpoint liveness.
explicit unlinks remain removed when an endpoint revives.

scalar selection/color/position registers choose greatest lamport and replica id.
a selection captures publication, geometry, quote and context together. endpoint
order is fractional position then link id; equal-key insertion rekeys only the
observed tie run. receiving and indexing never manufacture a touch. local pages sort by display
title and ref, including date-derived display titles for empty daily titles;
authored devices store no edit timestamps.

one local sql transaction commits touched merge bytes, projections, indexes,
source sequence, store revision and immutable pending change. only durable commit
acknowledges saved writing. uncertain replies reconcile the same source sequence;
stale revisions remerge the frozen intent without allocating another touch.
local acceptance, server acceptance and availability to server tools are distinct
facts; a local save alone promises neither of the latter two.
before returning a local receipt, the runtime merges its committed state into
already open writing documents. subsequent edits therefore see the shared-text
identities they reference; subscription delivery is not a commit barrier. incoming
receipt state does not create another write or text-history item.

`WritingRuntime.admitWriting` reserves one command before publishing canonical
new notes or synchronously changing existing documents. callers declare each
document's origin; the runtime captures those actual yjs mutations and freezes
each new initializer once. asynchronous preparation supplies graph intents only,
using store reads and previously sealed proofs. it must not capture its own
pending documents or submit another writer. graph preparation may retry;
canonical mutation never does. participant captures and pins follow eventual
settlement, while the returned result reports the first failure. a partial
mutation fault retains unsaved writing for copy or deliberate discard and blocks
later commands. unsaved-copy includes open documents queued behind that fault.

local receipts also retain `before`: touch/delete or add/remove vectors per
changed resource or relationship from the successful compare-and-swap prestate. a stale result
replaces that certificate before remerge; an uncertain committed retry retains
the original attempt's certificate. requested absence can certify an empty
vector; an omitted identity supplies no coverage proof. coverage advances each
added replica component only when its prestate touches are already covered or
removed in that exact prestate. this command’s removals cannot supply that proof.
it never imports other prestate lanes or covers a live intervening same-replica
edit merely because text is unchanged.

ordinary note and bound highlight annotation editing autosave locally. annotation creation retains
its explicit-save composer; unsubmitted composer text is ephemeral. uncommitted
writing retains the loss guard and retry/copy affordance. committed unsynchronized
writing survives app termination and does not acquire an exit warning.

a first annotation save locks its submitted clone until the reserved command
settles. the existing retained draft owns that lock through navigation; durability
clears the same clone and revision even while its editor is absent. subsequent
body editing uses the ordinary autosave owner.

split copies the observed suffix into a new note and removes only its observed
source ranges. join inserts the observed source at its destination anchor, then
covers the observed source liveness; it never redirects independent source links.
concurrent source edits can revive that source while copied words remain in the
destination. undo/redo uses local-origin crdt and graph inverses; it does not
restore an old body snapshot or overwrite an intervening scalar owner.

## outline interaction

one outline session owns its retained root and one persistent descendant
prosemirror view. authored panes render the root only in their header: pages use
their native title textarea; notes use one retained rich-body editor. the flat,
ephemeral descendant rows project disclosed occurrences and pending fields; they
never become authored storage. an occurrence uuid survives receipt
adoption and reparenting. resource refs, relationships and placement remain
separate identities, and repeated appearances of one note have separate
displayed baselines. titles use plain shared text and admit no marks or atoms.
the projection reuses the canonical inline grammar without importing row ids or
placement from clipboard content.

`useLocalOutlineRoot` publishes provider-wrapped header nodes and descendant
content. `OutlineController` owns the root document, creation prelude, admission,
shared history and focus requests. the root's independent displayed baseline
remains charged to that admission budget. native selection is separate across
root and descendants; their text and structure share undo. root bookmarks carry
relative selections, and history can reveal a hidden root before restoring it.
only the attachment committed inside chrome acknowledges root visibility.

note headers preview the literal first logical line with an ellipsis for hidden
lines, omitted atoms or overflow. disclosure reveals the entire canonical body;
prose return inserts a hard break, code return a literal newline. root text never
participates in child split, join, range selection or arrangement. embedded
descendants retain the same outline session and appear in its flat projection.
filtering descendants does not disable the root.

focus departure from the editor and its owned controls collapses the note after
outside pointer activation and native input settlement. hidden content retains
its document, guarded drafts, selection and history. fresh disclosure starts at
the beginning; reopening within the mounted visit retains position. return visits
start collapsed, including restored source inspections; fresh source arrivals may
reveal without taking focus. local save failure and complete-current-text copy
remain visible outside the folded editor. opening a latent page writes nothing;
its first title or child edit commits creation with that edit.
source-driven expansion requires a fresh open intent. arrival purpose stays
separate from whether an inspection was already applied.
`settleNativeInput` reconciles native packets without requiring a query to close;
`canArrange` still fences guarded drafts. structural commands require both.

item text means an occurrence’s own note body or inline page title.
item text is entered by pointer or f2, not sequential tab. each occurrence's
read-only head is its native navigation target; f2 from that target or its own
head controls enters editable item text at the end. text, embedded content,
terminal references and an open query never borrow that command. escape selects
an item; a second escape returns to its bullet. native traversal skips item
text in either direction and can return to the admitted root or insertion field.
root text, insertion fields and annotation bodies retain native tab behavior.
idle editable item text reserves tab/shift-tab and the move chord for outline
structure; unavailable moves are silently refused. native links and buttons keep
their own keys.
the existing focus request owns a plain-tab entry certificate while the host is
unfocused. actual native focus installs its authorized insertion caret
synchronously before selection observation; pointer and later keyboard intent
revoke it, and explicit focus replaces it. the same selection notifications retry
an entry held by input ownership; its row, ref, field kind and lease must still
match. native tab still chooses its target.
flat structural moves and return execute once per press; held backward/forward text
deletion retains the native repeat path. local writes already sequence through
the same runtime tail, without an additional keyboard queue.

the outer projection replaces complete changed rows at row boundaries. isolating
row wrappers never enter the inline input fitter; binding owns inline diffs.
each editor step routes through its own pre-step document to one field. generic
cross-field joins and splits are refused; the structural intent owner performs
them. shared-text identity preserves caret bookmarks. structural history also
records the semantic occurrence placement, so a surviving independent relation
cannot acquire the moved occurrence's identity. newer user intent cancels delayed
focus and targeted window changes; programmatic selection does not cancel its
own operation. append uses the proven absolute tail.

within the descendant outline, return splits prose at the selection; an empty
nested item outdents. an empty top-level item stays empty. backward/forward
deletion at a boundary joins adjacent notes; deleting an empty item unlinks its
occurrence. code return remains an
in-note break. its native DOM parser preserves literal newlines; clipboard slices
retain their separate existing import policy. explicit block removal unlinks
exactly the selected relationships.
title return and shift-return enter the root's first item or create the following
item for a title occurrence. pasting literal title text remains separate from
that keyboard command.
text and structure share one session undo order. reference-query text retains its
local editing history while the query owns input.

the existing retained workspace input cell owns pending occurrence metadata and
literal copy text. every accepted field binds its actual canonical document at
synchronous admission. the runtime reserves one command slot before mutation,
seals the real y updates and newborn initializers, and prepares only graph
metadata afterward. following typing, return and undo use those same documents
and their real undo managers; no receipt-time body replay or inverse snapshot
restore is involved. deferred graph preparation waits for a predecessor's
eventual receipt, while its first failure remains visible through the original
error owner. exact immutable retry stays with the runtime.

receipt adoption acknowledges only its admission. it never overwrites later
writing, placement or the editing host. canonical settlement also clears the
same retained cell while its pane is absent. hidden history occurrences retain
their displayed causal baselines; redo reuses those baselines rather than
acquiring a newer unrelated frontier.

native packets, composition and reference queries retain their field and
baseline together. incoming projection changes cannot withdraw an owner while
its dom remains protected. commands reconcile prosemirror's own dom observer and
native selection before choosing a field. a composition handoff finishes its
previous owner, then synchronizes the native range before capturing the next.
deferred composition completion cannot release a newer packet or record another
field's edit. the packet fence stays held through canonical handoff or
query-draft admission; only then may
selection notification refresh from canonical data. a failed literal handoff
retains the existing query draft and its canonical base.
consuming a reconciled semantic key grants no permission to refresh or adopt
remote state. a field without an admitted document stays
read-only until synchronous admission binds its real initializer.
the narrow observer adapter depends on the locked prosemirror-view version and must be requalified
when it changes. a query consumes its transient text synchronously on acceptance;
ordinary typing in other fields continues, while structural commands wait for
the open query to finish.

one resource undo manager tracks distinct occurrence origins within the same
session history. origin changes break typing groups. an inverse extends coverage
only through owned receipts whose prestate permits that component's advance.
this preserves independent work from another history even on the same replica,
including a touch-only restore. an already removed predecessor does not block an
owned redo from remaining undoable. frozen field proofs additionally retain
shared-text identities and deletion sets; conservative coverage may keep a
concurrently changed source visible.
position receipts update relationship positions without replacing their observed
membership frontier. history replay synchronously installs an eventual receipt
future in the same occurrence owner before another command can observe it. that
future folds every matching link patch through its actual prestate certificate;
new membership starts with empty coverage. its safe result reaches the retained
field before the bound retires, including offscreen. bound/promise/ref/parent
identity governs relationship publication; receipt ownership governs command
settlement. same-parent scalar history keeps the current proof; reparenting uses
the target bookmark's proof. each occurrence retains its own typing origin and displayed
frontier; another session’s received state is not proof of observation.

an occurrence keeps its earliest unproved admitted source through rapid moves
and history replay. a canonical target joins only its needed source proofs in
one revision-consistent window admission; reciprocal moves can therefore settle
together. every selected request and current placement receipt is revalidated
after awaits, including dependencies already admitted. successful installation
retires only placement metadata. the same field keeps its guarded relationship,
body and baseline until canonical projection can take over synchronously.
source proof may contain independent membership; it does not require absence.
an installed ancestor can also withdraw an unfocused target from this projection.
visible parents count before their first data window exists. retiring that local
obligation keeps the field and never asserts canonical deletion; retained docs
stay charged until the existing history/admission owners actually release them.
detaching an embedded branch immediately revokes its projection and queries.
the same record retains only owner ancestry while pending placement, history,
focus or an unresolved capture needs that path. detached ancestry never loads or
renders a window; only actual unfinished writing can keep its old host visible.
registration identity fences late cleanup from a replacement attachment.
standalone embedded outlines use their containing field occurrence and target as
logical scope. the portal's separate mount key never enters history identity.

pending outline export reads one fresh retained-cell snapshot as literal text,
including visible completed segments and the active body. the workspace keeps
that same account-scoped guard above its error boundaries. “copy pending outline
text” and the runtime's “copy unsaved note edits” are separate exports that may
overlap. their text is never concatenated as if disjoint. the runtime's own
stopped-workspace guard remains necessary after its provider unmounts. shelf
passage composition retains its existing ephemeral policy; it has no outline
draft or new recovery owner.

touch-capable panes expose six fixed actions: outdent, indent, move up, move down,
undo and redo. the shared render-environment owner detects touch capability with
`any-pointer: coarse`, independently of layout. hardware keyboards use the
outline shortcuts listed in settings; platform modifiers share `usesMeta`. no insert or finish-editing control is
needed: return inserts and moving focus ends text editing.
window navigation uses the same native-control recipe and comfortable touch size
as other commands. noneditable islands remain interactive without being treated
as soft-keyboard entry through the surrounding editor.
android reports actual keyboard visibility through its existing bridge; an inset
of zero alone does not imply dismissal. hiding the keyboard hides the touch
accessory without blurring the editor, changing its caret or revoking input.
actual focus entry, trusted editing intent inside the editor, or keyboard show
reveals the accessory again; projection and selection updates do not. selected
blocks always retain their touch commands. native keyboard hiding also restores
the mobile player without changing focus; browsers retain their focus-based
player suppression.

writing rows keep a leading opening link and a trailing disclosure only for
projected parents. notes and uncommitted drafts use dots; other resources use the
canonical scheme glyph. currently unmarked roots, tail and continuation rows stay
unmarked. markers remain noneditable chrome outside `contentDOM`; glyphs never
enter authored bodies, history or clipboard serialization. opening and relationship
menus retain the same native control and focus target. retaining an open empty
input does not establish child
availability. they disclose authored local links, excluding relationships
already traversed by that occurrence. a bounded batched local query proves child
availability. one `outline_window` query reads a bounded raw page, root and
boundary projections, adjacent and absolute tail relationships, and aligned child
proofs in one indexed sql statement. sql emits ordered graph records and each
bounded resource projection once; host adapters assemble the closed response.
projection construction never feeds back into graph or cursor derivation.
each endpoint arm selects a bounded range;
it never materializes the complete incident graph. raw cursors and child proofs
precede traversal omission; neighbors surround the first and last remaining
rows, while the absolute tail excludes only the entering relationship. full
resource projections retain literal rendering, filtering and copy behavior.
the native bridge's existing 16 mib aggregate output cap also applies to this
complete window. an extreme window may fail where separate reads previously
fit; the existing read error and explicit retry retain writing without truncating,
shrinking or partially publishing the proof. the root admits and retains all
note/title documents together. its admission snapshot also supplies the actual
initial note/page state for missing runtime documents. the existing per-ref
reservation wins for live, loading and prepared documents; supplied state never
replaces them. absent states retain ordinary loading and latent-page preludes.
newer subscriptions merge through the existing initial-revision catch-up.
graph proofs share a store revision; unknown data
never means absent. first entry waits for
preparation; refresh retains the prior window until its replacement is ready.
a cold append keeps its existing focus intent through initial prefix admission,
then requests the bounded absolute-tail window before focusing the field.
compatible child proofs refresh independently of raw field admission. each
proof identifies its resource, relationship, parent and traversal context;
relocation discards availability but retains its revision watermark, so an
older admitted window cannot resurrect stale disclosure. only the disappearing
disclosure's actual focus moves to its existing bullet before it hides.
writing rows use that projection directly, including their native bullet links.
the opened resource retains machine-derived connections and resource management.
embedded targets render rich read-only previews; editing opens their resource.
their disclosed descendants enter the containing flat session rather than
constructing nested editors.

reserved blank inputs use the editor's existing placeholder treatment. the hint
is generated presentation, clears with field content, and never enters authored
writing or clipboard data.

one session admits at most 64 unique document identities and 16 mib of encoded
state across root, disclosed branches, neighbors, tail, pending input and history.
the byte charge includes each canonical y encoding once, every independently
retained occurrence baseline (including hidden history occurrences), retained
history metadata and unresolved independent frozen encodings. baseline and
history owners report their charges through their existing maps; there is no
second inventory. visual anchor ids alone retain no writing. the same owned
snapshot is counted once; different causal baselines count separately even when
their ref or bytes match. prosemirror model, dom
and general heap allocations are outside this encoded-state contract. new aliases
reserve their baseline and initial capture even when their canonical document is
already held, so repeated large aliases admit fewer fields. provisional fields
reserve capacity before they become editable. this is a
new-admission bound, not a heap guarantee or an authoring quota: accepted typing,
composition and incoming growth remain protected and stop additional loads when
over budget. inactive windows and whole old history groups release through their
existing owners first. manual paging replaces a bounded window, exposes earlier
items and retains “write at end” beside show-more. a failed admission explains the
limit at the requested action. absolute-tail input resolves the current tail at
command preparation, rather than retaining a relationship that an earlier
accepted unlink may remove. explicit insert-after retains its chosen anchor.
if history retirement needs settlement, a new gesture requests insertion after
it finishes; a delayed split is not replayed.
the proven tail retains a manual entry even when it cannot reserve a blank field.
no account-wide status or recovery inventory is
introduced. the runtime's unpinned document cache remains a separate owner.

## device ownership

firefox ports share the stable `/_nexus/authored/worker.js` worker named
`nexus-authored-<account>-format-4`. `IDBBatchAtomicVFS` uses strict indexeddb commit
and sqlite synchronous full. a browser web lock spans command preparation through
uncertain commit settlement; an ephemeral port lease fences a late message from a
retired or crashed owner. compatible shells reuse one account/format owner.

android uses bundled sqlite 2.7.1 on one serialized connection off the main thread.
that connection lazily reuses compiled statements only for validated packaged
query and search-read plans. each read drains, resets and clears bindings before
returning; any failure discards its statement and preserves the original error.
connection retirement closes all compiled statements before the connection.
dynamic reads and writes retain transient statements; no query results are cached.
the preparation mutex spans its javascript baseline read and native transaction.
fixed bridge chunks retain existing generation/account admission. both hosts keep
committed merge bytes and causal state independently of mounted editor objects.

browser offline readiness requires durable storage permission, the complete
corpus, and the explicit installed-shell asset closure. the shared vite workspace
entry serves desktop and android through host adapters. only the browser registers
the service worker; android retains packaged app-router delivery. compatible shell
activation waits for local commit settlement; format changes use coordinated
release draining rather than automatic database deletion.

firefox boundary: normal browser quit preserves a compatible waiting update
through offline restart. forced quit during that update may require one online
reopen before the cached shell loads.
the product does not add a second activation protocol to repair that platform
boundary. local corpus ownership remains independent of shell asset delivery.

## replication

`POST /authored/replicas` provisions a fresh account replica. immutable contiguous
changes upload through `POST /authored/changes`; accepted prefixes are recognized
and compared before new commands merge. the account head lock commits canonical
states, projections, consecutive feed sequences and source acceptance together.
server tools use that same owner within their existing fenced transaction.

`GET /authored/changes?after=…` returns a bounded ascending prefix through one
captured head. applying each command and advancing its cursor is one device
transaction. sending and receiving proceed independently. the writing stream is
a wake hint; cursor catch-up remains authoritative.

`GET /authored/snapshot` streams a repeatable-read corpus with head and lamport in
its header and completion footer, plus exact record counts. interrupted staging
never becomes ready. publication commits all records/indexes and initializes the
local clock before consuming changes after that watermark. a corpus alone does
not establish browser offline readiness: the complete installed shell and durable
browser storage permission must also be confirmed.

scoped local search reads separate derived inputs, never another authored writer.
fixed `POST /authored/scope-inputs` metadata/status/final-fence and
`POST /authored/scope-text` pages reuse foreground sync without taking the account
head lock or extending the corpus snapshot. metadata hashes authorization,
membership and publication facts. a device publishes complete inputs atomically;
raw text and unfinished normalization resume from durable staging. local writing
remains available during hydration. explicit denial immediately blacklists only
the affected scope/reading and removes its copied text. readmission waits for a
complete fenced repair, including when permission changes return the same hash.

authorized pieces supply only body and proved required-note slices. highlights
follow complete canonical-anchor containment within one reading; saved passages
resolve normalized quote/context within each piece, while a whole source retains
its saved literal even when unlocated. local live links supply offline membership.
peer-highlight membership is metadata only, never peer writing ownership. shared
query execution applies eligibility and clipped lexical matching before paging;
its excerpt is separate from canonical content. both sqlite hosts use the same
fts tokenizer; native compound search rechecks the store revision before returning.

launcher `search_preview` is a compound nonpaged read with at most eight rows and
null cursors. bounded literal-name reads precede ordinary lexical filling and
reuse the same scope/evidence admission. exact, prefix and substring names are
ranked before truncation; prose remains evidence. firefox serializes the whole
read and android applies its store-revision fence to the entire operation.
`SEARCH_READ_SQL` owns its finite packaged native statements. ordinary `search`
retains its cursor and full-search/picker contract.
`search_admission` reuses that compound admission for at most eight held
`{ref, field}` targets, including current query membership and scoped evidence.
it proves the held field itself: a quotation cannot admit a cleared annotation,
and a stronger quotation cannot revoke an annotation that still matches.
it returns null cursors and avoids a corpus scan; resource existence alone cannot
prove scoped admission.

`workspace_member` identifies readings admitted by canonical global search;
independent retained-source readability does not add workspace membership.
global search keeps ordinary owned rows available during hydration and validates
highlight/media-passage candidates against complete active reading inputs.
`activation_ref` carries the selected reading without changing the capture.
the closed `source_alias` query returns active part-to-publication provenance in
`canonical_source_ref`; the destination owns read permission and location bounds.
a passage keys its semantic slice while its locator names the physical
publication. highlight locators retain exact source-owner equality.

auth/format failures pause transport while local writing remains available.
permanent sync defects retain pending bytes and show one actionable error. no
activity list, writing recovery inbox, global undo inventory or age-based causal
state pruning exists. [release steps](../issues/release-local-first-writing.md)
own coordinated format changes and device draining.

child disclosure is independent of fold and composer lifetime. removing the last
projected child removes its chevron without discarding writing, reference intent,
selection or the exact insertion destination. existence reads inspect the complete
local graph with the same occurrence exclusions as rendering, never a loaded page.
server facts remain a separate read; their availability cannot replace local state.
