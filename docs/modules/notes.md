# authored notes

titled pages, one-block notes, independent annotations and undirected links form
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
deleting a page, note or highlight never consumes an independent note. attached
annotation notes are ordinary independent notes and links, including multiple
notes and independently overlapping highlights. pdf resizing keeps the exact
highlight id and its note links.

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

ordinary and attached-note editing autosave locally. annotation creation retains
its explicit-save composer; unsubmitted composer text is ephemeral. uncommitted
writing retains the loss guard and retry/copy affordance. committed unsynchronized
writing survives app termination and does not acquire an exit warning.

split copies the observed suffix into a new note and removes only its observed
source ranges. join inserts the observed source at its destination anchor, then
covers the observed source liveness; it never redirects independent source links.
concurrent source edits can revive that source while copied words remain in the
destination. undo/redo uses local-origin crdt and graph inverses; it does not
restore an old body snapshot or overwrite an intervening scalar owner.

## outline interaction

one outline session owns one persistent prosemirror view and dom editing host.
its flat, ephemeral rows project the root, disclosed occurrences and pending
fields; they never become authored storage. an occurrence uuid survives receipt
adoption and reparenting. resource refs, relationships and placement remain
separate identities, and repeated appearances of one note have separate
displayed baselines. titles use plain shared text and admit no marks or atoms.
the projection reuses the canonical inline grammar without importing row ids or
placement from clipboard content.

each editor step routes through its own pre-step document to one field. generic
cross-field joins and splits are refused; the structural intent owner performs
them. shared-text identity preserves caret bookmarks. structural history also
records the semantic occurrence placement, so a surviving independent relation
cannot acquire the moved occurrence's identity. newer user intent cancels delayed
focus and targeted window changes; programmatic selection does not cancel its
own operation. append uses the proven absolute tail.

return splits prose at the selection; an empty nested item outdents. an empty
top-level item stays empty. backward/forward deletion at a boundary joins adjacent
notes; deleting an empty item unlinks its occurrence. code return remains an
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
native selection before choosing a field. deferred composition completion cannot
release a newer packet or record another field's edit. the packet fence
distinguishes a consumed, reconciled semantic key from permission to
refresh or adopt remote state. a field without an admitted document stays
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
membership frontier. each occurrence retains its own typing origin and displayed
frontier; another session’s received state is not proof of observation.

pending outline export reads one fresh retained-cell snapshot as literal text,
including visible completed segments and the active body. the workspace keeps
that same account-scoped guard above its error boundaries. “copy pending outline
text” and the runtime's “copy unsaved note edits” are separate exports that may
overlap. their text is never concatenated as if disjoint. the runtime's own
stopped-workspace guard remains necessary after its provider unmounts. shelf
passage composition retains its existing ephemeral policy; it has no outline
draft or new recovery owner.

touch-capable panes expose six fixed actions: outdent, indent, move up, move down,
undo and redo. desktop uses shortcuts. no insert or finish-editing control is
needed: return inserts and normal focus/keyboard dismissal ends text editing.
android reports actual keyboard visibility through its existing bridge; an inset
of zero alone does not imply dismissal.

writing rows keep a leading bullet link and a trailing disclosure only for
projected parents. retaining an open empty input does not establish child
availability. they disclose authored local links, excluding relationships
already traversed by that occurrence. a bounded batched local query proves child
availability. each data-only branch proof owns row projections, adjacent and
absolute tail relationships and child proofs; the root admits and retains all
note/title documents together. graph proofs
share a store revision; unknown data never means absent. first entry waits for
preparation; refresh retains the prior window until its replacement is ready.
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
`nexus-authored-<account>-format-1`. `IDBBatchAtomicVFS` uses strict indexeddb commit
and sqlite synchronous full. a browser web lock spans command preparation through
uncertain commit settlement; an ephemeral port lease fences a late message from a
retired or crashed owner. compatible shells reuse one account/format owner.

android uses bundled sqlite 2.7.1 on one serialized connection off the main thread.
the preparation mutex spans its javascript baseline read and native transaction.
fixed bridge chunks retain existing generation/account admission. both hosts keep
committed merge bytes and causal state independently of mounted editor objects.

browser offline readiness requires durable storage permission, the complete
corpus, and the explicit installed-shell asset closure. the shared vite workspace
entry serves desktop and android through host adapters. only the browser registers
the service worker; android retains packaged app-router delivery. compatible shell
activation waits for local commit settlement; format changes use coordinated
release draining rather than automatic database deletion.

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
