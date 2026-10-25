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

## device ownership

firefox ports share the stable `/_nexus/authored/worker.js` worker named
`nexus-authored-<account>-format1`. `IDBBatchAtomicVFS` uses strict indexeddb commit
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
