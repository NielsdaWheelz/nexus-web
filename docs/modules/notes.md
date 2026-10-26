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

the outline owns visible occurrence selection, structural commands, history and
focus across disclosed branches. editors expose selection bookmarks and input
capabilities; they do not own graph placement. caret bookmarks use shared text
identity through moves and remounts. pane edit/append entries use the same focus
owner and wait for the actual field; newer input cancels both focus and delayed
window changes. append uses the proven absolute tail. browser keys and native
semantic input enter the same return/deletion grammar after composition and
reference input have had their own admission.

return splits prose at the selection; an empty nested item outdents. an empty
top-level item stays empty. backward/forward deletion at a boundary joins adjacent
notes; deleting an empty item unlinks its occurrence. code return remains an
in-note break. its native DOM parser preserves literal newlines; clipboard slices
retain their separate existing import policy. explicit block removal unlinks
exactly the selected relationships.
text and structure share one session undo order. reference-query text retains its
local editing history while the query owns input.

one retained input owns typing between a split/join/first keystroke and the
mounted canonical note. return freezes semantic segments while the same live
editor immediately owns the suffix. each segment merges over the commit receipt's
exact shared-text initialization before its split commits. input admissions keep
text and structure in one undo order despite asynchronous persistence. the same
draft retains preparation progress and the loss guard; it introduces no persistent
outbox or second body cache. structural controls remain unavailable during handoff.
pending boundary plans retain their displayed peer and exact receipt identities;
prepared neighbors distinguish an unloaded relationship from absence.

handoff waits for the active native input packet and reconciles prosemirror's
own dom observer before capturing selection or destroying a view. deferred
composition completion cannot release a newer packet. this narrow observer
adapter depends on the locked prosemirror-view version and must be requalified
when it changes. titles publish readiness after their controlled value and
relative caret have reached the actual field.

history extends an inverse's causal coverage only from its own structural commits
and its own editor/undo origins' commit receipts. restoring a relationship during
one undo therefore remains reversible by an older undo, while an unrelated
replica's addition or edit stays outside that inverse.

touch-capable panes expose six fixed actions: outdent, indent, move up, move down,
undo and redo. desktop uses shortcuts. no insert or finish-editing control is
needed: return inserts and normal focus/keyboard dismissal ends text editing.
android reports actual keyboard visibility through its existing bridge; an inset
of zero alone does not imply dismissal.

writing rows keep a leading bullet link and a trailing disclosure only for
proved projected children; an open empty branch keeps its mounted input. they disclose authored local links, excluding relationships
already traversed by that occurrence. a bounded batched local query proves child
availability. one prepared window owns the row projections, adjacent and absolute
tail relationships, child proofs and retained note/title documents. graph proofs
share a store revision; unknown data never means absent. first entry waits for
preparation; refresh retains the prior window until its replacement is ready.
writing rows use that projection directly, including their native bullet links.
the opened resource retains
machine-derived connections and resource management. outline reads grow a retained
prefix in bounded pages; loading another page does not replace earlier rows.

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
