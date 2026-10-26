# local first writing investigation

living research and decision record, begun 2026-10-25. the owner requested this
document during the investigation. application changes are not authorized by
this document. confirmed product decisions appear separately from proposed
implementation choices and qualification requirements.

the approved direction is now specified in
[local first writing specification](local-first-writing-spec.md). that document
owns the selected implementation and work boundaries; this record retains the
research and decision rationale.

the direction is a durable local authored graph with automatic synchronization.
ordinary writing should not depend on a server response. this replaces the
online-first writing boundary; persisting its existing request queue would not
produce the intended model. reduced interface complexity is the objective, not
a new activity, synchronization or recovery application inside nexus.

## confirmed owner decisions

| subject | decision | consequence |
| --- | --- | --- |
| v1 platforms | desktop firefox and the installed android app | both must cold-open and permit writing offline after initial online provisioning; no promise for other desktop browsers in v1 |
| local corpus | all owned pages, notes, links and annotations | local opening, text search and backlinks; no selective-sync controls |
| scale | up to 100,000 individual note blocks on the phone, excluding imported media | keep the complete corpus on disk and hydrate only needed editing state |
| concurrent edits | always combine automatically; occasional surprising text or structure is acceptable | no ordinary manual conflict-resolution workflow; whole-body last-write-wins is not sufficient |
| note shape | keep exactly one block per note, including after concurrent changes | rejected expanding notes into multi-block documents; use one permanent block with separate presentation |
| agents | agent edits are treated like user edits | agents use the same authored identities, merge semantics and write authority |
| delete versus concurrent edit | restore the edited note; visible writing takes precedence | semantic deletion must retain enough causal state for an unobserved edit to make the note live again |
| graph | links are bidirectional and non-hierarchical; items are independent | unlink never deletes an endpoint; deleting one item never deletes another item |
| joining | retain joining as an explicit operation that merges two notes and deletes the source everywhere | this deliberately addresses two notes; it is not an implicit consequence of ownership or the number of links |
| history and recovery | no version-history, trash or recovery feature in v1 | ordinary outline undo remains; unwanted automatic merges may require ordinary editing to correct |
| sync lifecycle | sync during active use, including local commits, incoming changes, open/resume and reconnect | changes remain local while closed; no android background-upload requirement |
| breaking releases | reconnect and synchronize every provisioned device before a coordinated upgrade | a deliberate no-use window permits hard protocol/schema cutover without abandoning offline-only writing |
| concurrent annotations | independently created notes on the same passage remain separate linked notes | do not silently merge distinct note identities to preserve a singleton annotation field |
| highlight resizing | preserve resizing and stable independent highlight identities | independently created overlaps can coexist; each keeps its attached notes; concurrent resizes select one coherent selection |
| source downloads | annotate sources already available locally; keep download expansion separate | no new desktop source-download feature or automatic retention of every opened source |
| activity | remove the activity feature rather than move it under account | no global undo inventory, success history, recovery inbox or replacement attention badges |
| routine feedback | avoid successful-work notifications and network-failure retry chores | ordinary offline operation is a neutral state; a small status indication is sufficient |

the graph decision concerns independently identified resources. showing the same
note in two places still shows one canonical item: editing it updates both
appearances. removing an incident link affects the relationship, not the other
endpoint's content or existence. explicit two-note joining is the accepted
exception to single-item commands, not an ownership rule.

no history product does not authorize deleting metadata needed to merge a late
offline edit. that metadata is internal synchronization state. an operation
applied by synchronization must not itself count as fresh user editing and
resurrect deleted items.

## product contract proposed from those decisions

one editing model operates online and offline:

```text
editor and graph commands
          |
          v
durable local authored store <--> synchronization <--> server authored store
          |                                              |
          v                                              v
local views, search, backlinks                 postgres projections and tools
```

an edit may paint immediately, but it is saved on this device only after the
local transaction commits. connectivity is not evidence of a save. a server
acknowledgement is a separate fact. the status indicator should describe being
up to date with the server, not claim knowledge of disconnected devices.

| condition | presentation |
| --- | --- |
| locally committed and caught up with the server | quiet synchronized state |
| locally committed, disconnected | neutral offline state; editing continues |
| exchanging changes | restrained syncing state |
| remote authentication or synchronization needs intervention | status control explains the current problem; no event inventory |
| local persistence fails | explicit error at the affected writing; never claim the text is saved |

first provisioning requires connectivity to establish the account, acquire the
shell and download the corpus. ordinary subsequent startup must not require
token refresh. existing provisioned local access and remote admission are
separate. source documents and media retain their existing availability rules.
stored annotations and quoted text remain usable without their source bytes;
creating or relocating a highlight requires the relevant source locally with
its exact publication identity. a cached offset must never be applied blindly
to a newer source publication. preserve the authored quote and original anchor
when a source changes; inability to locate it now must not erase the writing.

server features operate on synchronized content. server-side retrieval and
agents cannot see edits still confined to an offline device. that is an explicit
limit of the model, not a reason to block local editing.

## what established products demonstrate

### obsidian

obsidian separates a working local vault from its remote replica. its documented
sync contract requires the application to be running; offline changes upload
when it reconnects. markdown conflicts normally use text merging, which can
produce duplicate text or formatting. its documentation also records a
same-name startup/daily-note collision that can replace newly created local
content rather than merge it. stable identity and initialization are therefore
part of the data model, not merely transport details.

sources: [local and remote vaults](https://obsidian.md/help/Obsidian%2BSync/Local%2Band%2Bremote%2Bvaults),
[sync faq](https://obsidian.md/help/sync/faq),
[conflict behaviour](https://obsidian.md/help/sync/troubleshoot).

obsidian also supplies history and local recovery. those are product choices
we are deliberately not adopting in v1. its warning against concurrent
third-party synchronization of the same vault supports one replication owner.

sources: [version history](https://obsidian.md/help/Obsidian%2BSync/Version%2Bhistory),
[file recovery](https://obsidian.md/help/plugins/file-recovery),
[sync faq](https://obsidian.md/help/sync/faq).

### google docs and apple notes

google docs demonstrates quiet document-local save status, but its documented
offline setup requires supported chrome/edge environments, initial provisioning
and available storage; coverage is selected or recent documents. it does not
establish firefox cold-start support or full-corpus availability for nexus.
its current public help does not establish a specific internal merge algorithm.

sources: [offline setup](https://support.google.com/docs/answer/6388102),
[save status](https://workspaceupdates.googleblog.com/2020/06/new-save-status-online-offline-google-docs.html?hl=en).

apple notes documents local and icloud account scopes and 30-day recovery for
deleted icloud notes. this supports keeping storage mechanics out of ordinary
editing; it does not justify copying an undocumented synchronization algorithm.
nexus v1 deliberately omits the recovery interface.

sources: [account scopes](https://support.apple.com/en-euro/guide/notes/notc3b2d538b/4.13/mac/26),
[deletion behaviour](https://support.apple.com/en-gb/guide/iphone/iph904eee369/ios).

### linear and figma

linear documents a local database, incremental catch-up and persisted pending
changes, but calls offline use a failsafe and warns that offline edits can
overwrite newer remote edits. its responsiveness and incremental synchronization
are useful precedents; its merge contract is weaker than the owner's requirement.
its large-scale delta-serving infrastructure is not proportionate to this app.

sources: [offline behaviour](https://linear.app/docs/get-the-app),
[delta synchronization architecture](https://linear.app/now/rebuilding-delta-sync-read-path).

figma's engineering account preserves object identity and defines structural
conflicts explicitly. its whole-text winner policy was chosen for a design tool,
not a prose editor. current offline help also limits reopening and availability:
durable pending changes alone do not provide an offline application shell.

sources: [multiplayer architecture](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/),
[offline limitations](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma).

### logseq and roam

logseq's 2023 smart merge moved from page-level to block-level handling to
preserve outline structure. its current database rewrite and realtime
collaboration are still described as beta/alpha in the official repository.
the lesson is to select merge granularity from the actual data model, not from
files or pages by analogy. nexus is a graph, not an ownership tree.

sources: [smart merge](https://blog.logseq.com/logseq-0-9-14-better-sidebars-and-smart-merge-for-sync/),
[current repository status](https://github.com/logseq/logseq/blob/master/README.md),
[database model](https://github.com/logseq/docs/blob/master/db-version.md).

roam's small status indicator is the owner's visual reference. no sufficiently
verified first-party account of its current internal synchronization protocol
was established here; it is not evidence for an implementation choice.

## findings in the current repository

paths below are relative to the repository; line references identify the
reviewed source and may move during subsequent implementation.

| finding | evidence | implication |
| --- | --- | --- |
| writing is tab-local memory plus server acknowledgement | `apps/web/src/lib/notes/texts.ts:2-5`, `writes.ts:3-8` | replace read/write authority; persisting the current fifo is insufficient |
| incoming writing is mounted-resource invalidation | `apps/web/src/lib/api/writingReceive.ts:124-149` | a full offline corpus needs durable catch-up, including deletions |
| body updates replace a whole body behind version checks | `python/nexus/services/note_bodies.py:239-265` | server compare-and-swap is not automatic rich-text merge |
| a note is one prosemirror block; it may appear in several pages | `apps/web/src/lib/notes/noteBody.ts:1-4`, `docs/modules/resource-references.md:3-6` | one crdt per page would duplicate canonical note bodies or obscure cross-page identity |
| links are already undirected and unique per endpoint pair | `python/nexus/services/resource_graph/edges.py:248-283` | retain graph identity; do not introduce a tree ownership model |
| each endpoint owns its own ordering | `python/nexus/services/resource_graph/order.py:1-5,72-118` | replace dense full-list rewrites with a convergent per-endpoint order policy |
| ordinary outline removal can consume a note | `python/nexus/services/outline.py:582-603` | violates the clarified independent-node rule; exact unlink must preserve endpoints |
| joining edits the destination and consumes the source | `apps/web/src/lib/notes/outline.ts:552-608` | retain only as the explicitly accepted two-note operation; remove retainer-count ownership semantics |
| daily creation refuses competing page identities | `python/nexus/services/notes.py:285-318` | parallel offline first-use needs one logical date identity and defined recreation |
| same-extent highlight creation rejects a second initial note | `python/nexus/services/highlights.py:877-890` | allow independent linked annotations under the owner decision |
| cleanup infers deletion eligibility from server-only facts | `python/nexus/services/empty_resource_cleanup.py:85-86,117-128` | disconnected edits/links are invisible; authored-node collection cannot retain this policy |
| browser startup awaits server authentication and bootstrap | `apps/web/src/app/(authenticated)/layout.tsx:24-30,48-57` | a durable local database alone cannot satisfy offline cold start |
| android already bundles the shell and admits a provisioned local account | `docs/modules/device-startup.md` | extend this owner rather than create another startup system |
| android sign-out purges stores and web storage | `apps/android/app/src/main/java/app/nexus/android/DeviceSession.kt:427-476` | explicitly protect or deliberately discard unsynchronized writing before purge |
| offline catalog contains summaries, not note bodies | `docs/modules/offline-catalog.md:3-6` | it is not an authored database or write authority |
| downloaded readers currently omit annotations | `docs/modules/offline.md:23-25` | connect available source presentations to the local annotation owner |
| tools write directly through server domain services | `python/nexus/services/tools/writes.py:212-232,336-349` | agents must enter the same replicated writing model; projected rows cannot remain another writing authority |

the online-first cutover was deliberate and is recorded in
[its release issue](issues/release-online-first-writing.md). local-first is an
explicit change in product contract. it must not restore an old queue/recovery
design while leaving server reads authoritative.

## implementation direction

### one authored owner and indexed local storage

use one logical authored-store contract for identity, body, liveness, links and
order. local transactions commit changed content, merge metadata and the data
needed to resume synchronization. local views and indexes derive from committed
state. if indexes update asynchronously, their checkpoint must be explicit and
rebuildable; they cannot become a second content authority.

the complete corpus lives on disk. load active or currently processed note
editing state into memory. pages remain graph views, not storage partitions
that own note bodies. search and backlink queries use indexes, not a scan of
100,000 live editor objects.

the local corpus includes the reference metadata its authored graph needs:
durable passage-anchor identities, quotes and source labels/stubs. this is not
source-media downloading. passage anchors can target mutable notes as well as
media (`python/nexus/services/passage_anchors.py:3-15,37`); local resolution after
merging must preserve the canonical normalization and plain-text rules.

sqlite is the selected local query store because it supplies
transactions, indexed graph queries and full-text search. native android can use
an app-private database. firefox requires a worker-backed browser persistence
adapter with deliberate multi-tab ownership. the specification selects the
released `@journeyapps/wa-sqlite` indexeddb vfs in a shared worker and native
androidx bundled sqlite, including fts5 on both. identical database names do not
prove identical platform durability. indexeddb remains viable for opaque
updates, but a complete search/index implementation must be counted in its cost.

sources: [sqlite full-text search](https://www.sqlite.org/fts5.html),
[sqlite browser persistence and locking](https://www.sqlite.org/wasm/doc/trunk/persistence.md),
[browser storage and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

### mature text merging with explicit graph semantics

stable yjs plus stable y-prosemirror is the selected text integration. npm's
published stable tags on 2026-10-25 were `yjs 13.6.33` and
`y-prosemirror 1.3.7`; yjs 14 was still beta. repository main-branch APIs must not
be mistaken for the stable release contract. this is a design selection,
not a claim that nexus's custom editor and joins have been qualified.

sources: [yjs package metadata](https://registry.npmjs.org/yjs/latest),
[binding package metadata](https://registry.npmjs.org/y-prosemirror/latest),
[binding repository](https://github.com/yjs/y-prosemirror).

the graph still needs stable ids, causal liveness and deterministic ordering.
convergence of library containers alone does not establish these semantics.
deleting a nested crdt container can hide concurrent edits; semantic note
deletion must be represented separately from physical destruction of its body.
concurrent initialization of distinct nested containers under one equal key can
also select one branch rather than combine their contents.

sources: [automerge conflict semantics](https://automerge.org/docs/reference/documents/conflicts/),
[nested deletion test](https://github.com/automerge/automerge/blob/main/javascript/test/legacy_tests.ts#L1317),
[loro mergeable initialization](https://loro.dev/blog/mergeable-containers).

### one replication path and one server writing authority

transport exchanges durable updates and checkpoints; it does not replay old
whole-body saves as the editing model. a command spanning notes and graph
changes needs an explicit atomic local commit and a coherent replication unit.
per-note crdts alone do not supply that contract.

agents must generate edits through the same semantic operations against the
content they read. replacing a body with an agent's stale full-document output
can erase intent even when the storage uses a crdt. postgres can remain the
server's relational projection for existing reads, retrieval and indexing.
direct writes to those projected bodies must cease.

a shared typescript command/schema owner avoids duplicating rich-text semantics
in python and javascript. the specification selects a bounded one-shot node
helper inside the existing api deployment, rather than another service.
`pycrdt` remains a maintained yjs-compatible alternative, but would not remove
the duplicated editor schema/projection work. helper memory and latency need
qualification within the existing api limit.

sources: [pycrdt types and transactions](https://y-crdt.github.io/pycrdt/usage/),
[yjs implementation ports](https://github.com/yjs/yjs).

## alternatives and exclusions

| approach | judgment | material trade-off |
| --- | --- | --- |
| yjs plus local indexed database and one replication path | selected architecture | graph/lifecycle rules and durability acknowledgement remain application responsibilities |
| powersync plus yjs | rejected for this v1 deployment | adds a service and licensing/operational dependency; does not supply graph semantics or eliminate the upload handler |
| automerge | credible alternative merge engine | current prosemirror binding describes itself as beta; measure integration and storage cost |
| loro | useful movable-list and initialization primitives | younger editor binding with a concrete unresolved content-writeback report; tree features do not match nexus's graph |
| zero | exclude | current documented prolonged offline writes are unsupported |
| electric | exclude as a complete solution | current product supplies the read path; offline write protocol and merging remain ours |
| rxdb | exclude from the final shortlist | default conflict resolution and lack of relational multi-document transactions do not remove this model's hard work |
| replicache | exclude for a new foundation | maintenance mode; programmable rebasing still leaves text merge to the application |
| whole-body version checks with manual conflict choices | exclude | contradicts the owner's always-automatic merge requirement |
| whole-corpus resident crdt | reject as the default | 100,000 blocks on a phone require bounded loading and measured memory |

sources: [powersync crdt composition](https://docs.powersync.com/client-sdks/advanced/crdts),
[powersync consistency](https://docs.powersync.com/architecture/consistency),
[powersync licensing](https://powersync.com/open-source),
[automerge binding status](https://github.com/automerge/automerge-prosemirror),
[loro list semantics](https://www.loro.dev/docs/tutorial/list),
[loro binding report](https://github.com/loro-dev/loro-prosemirror/issues/77),
[zero offline limitation](https://zero.rocicorp.dev/docs/connection),
[electric write-path boundary](https://electric.ax/docs/sync/guides/writes),
[rxdb transaction model](https://rxdb.info/transactions-conflicts-revisions.html),
[replicache status](https://replicache.dev/).

powersync's yjs demo is a composition example, not a durability proof. its
example compactor reads updates and then deletes document rows before inserting
a merged state, with a transaction todo. adopting the product does not authorize
copying that compactor into nexus. similarly, an initial-load `synced` event is
not acknowledgement that the most recent local edit has reached disk.

sources: [example compactor](https://github.com/powersync-ja/powersync-js/blob/main/demos/yjs-react-supabase-text-collab/supabase/functions/merge-document-updates/index.ts),
[example provider](https://github.com/powersync-ja/powersync-js/blob/main/demos/yjs-react-supabase-text-collab/src/library/powersync/PowerSyncYjsProvider.ts).

## proposed automatic rules

these are derived implementation proposals; confirmed product choices remain
in the first table.

- ordinary resources retain stable independent ids. a new resource receives a
  new id; rendering it elsewhere never creates replacement content.
- an explicit unlink removes that edge only. node deletion hides that node and
  its incident relationships, never neighboring nodes.
- deletion suppresses the edits it observed. a concurrent unobserved edit makes
  the addressed node live again. a later deliberate deletion after observing
  that edit can remove it. applying remote updates does not create new intent.
- node deletion changes only node liveness; revival reveals still-live incident
  links. separately issued unlinks remain removed.
- one logical daily page belongs to `(account, local_date)`. parallel first-use
  and later reuse must converge there rather than refuse a random competing id.
  retain its semantic identity while deleted; opening is read-only and actual
  editing/materialization revives it. existing ids survive the migration.
- one bidirectional endpoint pair has one logical link. each endpoint orders its
  adjacent links independently. concurrent reordering converges to one position
  without duplicating the link or changing the other endpoint's order.
- independently created annotation notes remain independent. existing-highlight
  attachments retain that highlight id; independently created highlights may
  overlap and keep their own notes. resizing retains identity. concurrent edits
  of the same note merge its body.
- a join preserves the destination identity and commits its text merge with
  deletion of the source identity. it does not silently redirect source links
  to the destination. concurrent destination edits must survive. if another
  device concurrently edits the source, it may reappear while the destination
  retains the joined text. this possible duplication follows the owner's
  preserve-writing preference and tolerance of surprising automatic results.
- outline undo reverses the relevant local-origin actions without erasing
  unrelated incoming edits. agent authorship changes no data privileges or merge
  policy; undo scope is an interaction concern, not a second class of content.

## costs and failure boundaries

automatic synchronization removes network waiting from editing, not all storage
failures. failed local commits remain explicit. unsynchronized writing is only
on its device; clearing browser data or losing the device cannot be repaired by
calling the local store durable. no new backup/history feature is included.

all-local replication costs disk and initial provisioning time. partitioned
hydration reduces startup memory but requires explicit cross-record commands.
automatic merge costs causal metadata and occasionally surprising output.
native android storage adds a bridge adapter; browser storage adds worker,
multi-tab and eviction concerns. a service such as powersync trades custom
replication code for another dependency and operational owner.

old offline clients also survive releases. pending writing cannot be erased by
a schema upgrade or a server hard cutover. migration and incompatible-client
admission must be explicit, and compaction cannot discard state still needed by
late edits. with no agreed offline-expiry policy, arbitrary time-based causal
deletion is invalid. no user-facing history is required to honor this invariant.

sources: [loro shallow-snapshot limits](https://www.loro.dev/docs/concepts/shallow_snapshots),
[editor schema compatibility](https://tiptap.dev/docs/editor/core-concepts/schema).

## qualification still required

the owner interview has settled the product scope above. the remaining decisions
need engineering evidence, not another preference questionnaire:

1. qualify the selected text binding against the actual single-block
   grammar, references, selection/composition, same-note concurrency and explicit
   split/join. include competing paragraph/code/object block replacements:
   the target keeps exactly one permanent block with separate presentation;
   normalization must not silently discard concurrent writing. avoid a toy
   textarea demonstration.
2. qualify the selected direct replication and sqlite implementation, including
   native bridge and firefox multi-tab ownership, commit acknowledgement, local
   search and server-agent writes together.
3. demonstrate 100,000 realistically sized and previously edited blocks on the
   target phone. measure cold opening, first usable screen, local search,
   editor latency, disk size and peak memory. no performance result is claimed
   by this source review.
4. verify specified relation revival, daily-page recreation and coordinated
   schema upgrade. v1 retains the feed and causal state without a compactor.
5. exercise interruption before local commit, after local commit, after server
   commit but before acknowledgement, and during incoming apply. include two firefox
   tabs and an agent alongside the disconnected phone.

future repository checks still run through `./scripts/test`; the existing local
testing contract owns manual/disposable verification. no implementation,
dependency installation or runtime qualification was performed in this review.

## tracked repository gaps

- [server-only retention and causal deletion](issues/local-first-retention-requires-causal-deletion.md)
- [daily-page identity](issues/local-first-daily-page-identity.md)
- [concurrent highlight notes](issues/local-first-concurrent-highlight-notes.md)
- [browser cold start](issues/local-first-browser-cold-start.md)
- [signout and unsynchronized data](issues/local-first-signout-purge.md)
- [highlight source publication changes](issues/local-first-highlight-source-generations.md)
- [editor schema under automatic merge](issues/local-first-editor-schema-merge.md)
- [replication transport limits](issues/local-first-sync-transport-bounds.md)
- [one durable local commit owner](issues/local-first-store-commit-ownership.md)
- [downloaded-reader authored admission](issues/local-first-shelf-authored-admission.md)
- [coordinated release](issues/release-local-first-writing.md)
- [activity prominence and retirement](issues/activity-entrypoints-obscure-navigation.md)
- [activity naming collision](issues/activity-label-names-two-features.md)

resolved decisions replace superseded proposals in this document. future changes
must preserve the explicit distinction between agreed behaviour, implementation
recommendations and measured results.

## scope parity decision — 2026-10-25

owner chose full offline scope parity over captured-source-only semantics.
replicate the minimal read-only facts needed to resolve media, source-backed
part, library and conversation scopes. scope resolution combines the last
synchronized metadata with current local authored state, including new offline
writes. a server-computed membership list alone cannot include those writes.
source files and a new catalogue product remain outside scope. one further
choice is pending: full current-part parity for a new capture from an older
saved publication requires current searchable source text. ids, intervals and
generation numbers cannot establish where previously unknown words now occur.
replicating that text costs storage and provisioning time; publication-specific
results until reconnect would narrow the selected parity contract.

remote authored ownership is explicit: own resources remain locally
authoritative, including server-created changes still awaiting local delivery;
authorized peer highlights retain their existing remote reader. ref schemes and
absence from the local store do not establish ownership. the resource-item wire
now states `authored_by_viewer`, derived from canonical account ownership.
