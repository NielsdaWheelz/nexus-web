# local first writing specification

implement one durable local authored graph for desktop firefox and the installed
android app. remove activity. ordinary writing works identically online and
offline; foreground synchronization exchanges committed changes automatically.
this is a hard replacement of the online-first writing boundary, not another
queue beside it. [research and decisions](local-first-writing-investigation.md)
explain the alternatives.

## scope and capability contract

| capability | v1 contract |
| --- | --- |
| offline lifetime | after online provisioning, cold-open, edit, terminate and reopen without connectivity |
| corpus | every owned page, note, authored link and annotation; local text search, reference selection and backlinks; 100,000 note blocks on the existing samsung sm-s906w/android16 |
| independence | links are bidirectional, not ownership; unlink preserves endpoints; deleting a resource never deletes another resource |
| concurrency | automatic text merge; deterministic scalar/order resolution; concurrent editing revives a deleted note; no conflict chooser |
| note grammar | exactly one rich-text block per note, including after merge; ordinary enter/split and explicit join remain |
| agents | same merge and persistence rules; existing tool permissions remain; no proposal gate or new agent product |
| annotation creation | existing explicit save commits locally; attached-note editing autosaves locally; unsubmitted composer input remains ephemeral |
| highlight identity | preserve pdf resizing and stable highlight ids; independently created overlapping highlights coexist with their own notes |
| sources | annotate already-local source presentations; retain quotes, anchors and reference labels independently of source bytes |
| synchronization | continuous while open; local commit, notification, open/resume and reconnect trigger work; no background android uploader |
| releases | every format-breaking release drains and closes all provisioned devices before migration; no old-client compatibility |

no activity/recovery inbox, history/trash product, global undo inventory,
presence/cursors, selective sync, new source downloader, offline blob upload,
offline model inference, multi-user sharing or generalized sync framework.
imports, account operations, media acquisition and other server-owned features
retain their existing owners. statistics remains under account. ordinary outline
undo remains session-scoped. existing operational database backups remain.

## architecture and ownership

```text
existing editors, reader annotations, outlines, search
                       |
             authored commands and queries
                       |
 shared typescript semantics + transactional device sqlite
                       |
       immutable pending changes / durable catch-up cursor
                       |
 existing fastapi -> same semantics -> postgres transaction
                       |
            existing server projections and tools
```

one new shared package, `node/authored`, owns the body grammar, projections,
identity, merge rules, command preparation and local query/schema definitions.
it has no react, network, auth or filesystem dependency. python and kotlin own
their platform transactions; they do not reimplement text merging.

| boundary | selected implementation | explicit cost |
| --- | --- | --- |
| rich text | `yjs 13.6.33`, existing prosemirror editors and the shared narrow transaction adapter | one permanent inline yjs text with embedded atoms; editor integration and structural undo change |
| firefox storage | `@journeyapps/wa-sqlite 2.0.8`, asyncify, `IDBBatchAtomicVFS`, one account-scoped shared worker | lower potential throughput than opfs; avoids isolation headers and tab-leader machinery |
| android storage | `androidx.sqlite:sqlite-bundled:2.7.1`, one serialized connection off the main thread | native dependency/apk bytes; system sqlite is unsuitable for the shared fts5 contract |
| server semantics | bounded one-shot node helper invoked by existing python transaction owner | node enters the api image; qualify child-process cost within the existing 384 mib api limit |
| replication | direct account-wide change feed in existing fastapi/postgres | application owns a small protocol; no powersync service, cdc or extra deployment |

the node helper reads touched states and a closed command/change envelope from
stdin, returns merged states/projections, then exits. no database or network
access, shell interpolation, persistent child supervisor or ingestion-rpc reuse.
use the existing pinned node runtime. transaction failure publishes nothing.
one helper runs at a time for this account, with a 30-second deadline and a
128 mib javascript heap ceiling; qualify total api-plus-child memory. oversize
accumulated merge state is an operational capacity failure, never permission to
drop an accepted edit. the capacity case includes repeatedly edited documents.

dependency contracts: [browser vfs](https://github.com/powersync-ja/wa-sqlite),
[native sqlite release](https://developer.android.com/jetpack/androidx/releases/sqlite),
the shared prosemirror transaction adapter. the stock `y-prosemirror 1.3.7`
binding fails the required mixed-atom concurrency case: removing an image deletes
an adjacent text container and thereby discards an unseen concurrent insertion.
keep one permanent `Y.XmlText` inside the permanent body element; inline atoms
use text embeds, so atom deletion addresses that atom instead of replacing a
neighboring container. the shared adapter owns pm/yjs position and mark mapping.

## data model and invariants

all wire keys are snake_case; absence is explicit `null`. use existing resource
refs. uuid strings are canonical; counters are decimal strings on wire and
64-bit integers in sql. database identity, sync format and wire revision are
distinct facts. a replica is one provisioned account database, not one browser
tab; fresh provisioning mints a fresh replica uuid.

| canonical state | required fields |
| --- | --- |
| replica | `account_id`, `replica_id`, `command_seq`, `store_revision`, `lamport`, `server_cursor`, `format_revision`, `provisioning_complete` |
| resource | `ref`, immutable `kind`, `touch_vv`, `delete_vv`; closed kind-specific state below |
| note | encoded yjs state with named root `body`; derived `body_pm_json`, `body_text` |
| page | nullable `local_date`; yjs root `title`; derived title |
| link | `link_id`, immutable sorted `endpoint_a`, `endpoint_b`, `add_vv`, `remove_vv`; endpoint positions |
| position | `(endpoint_ref, link_id)`, fractional `position`, register stamp `(lamport, replica_id)` |
| passage | `anchor_id`, `source_ref`, immutable normalized quote/context key; register of captured literal quote, nullable publication identity and typed locator hint |
| highlight | random stable id, immutable `source_ref`, selection register, color register and resource liveness; attached notes stay independent |
| source stub | `source_ref`, kind, last known label/publication; reference metadata, never downloaded source bytes or remote authorization |

`vv` maps replica ids to command counters. merge vectors by componentwise max.
resource visibility is `any(touch_vv[r] > delete_vv[r])`. creation, body/title
editing, highlight field editing and first daily materialization advance the
addressed resource's local touch component. deletion covers only the touch vector
observed by that command. therefore an unseen edit revives the resource; a later
observing deletion removes it. receiving, rendering and indexing never touch it.
timestamps are display metadata, never conflict precedence. authored devices
store no edit timestamps. pages use deterministic display-title/ref ordering;
empty daily titles use their date-derived display default for sorting without
writing it into the title crdt.

link visibility uses the same add-versus-observed-remove rule and requires live
endpoints. deleting a node hides incident links without deleting their state;
revival reveals them. explicit unlinks remain removed. moving a link never
re-adds it. relinking is unlink plus add in one command. derived citation/embed
facts retain their own directional meaning and are rebuilt from their owners;
they are not additional user-link writers.
authored endpoints use semantic liveness. source stubs remain valid endpoints
when source bytes/network/access are unavailable; this does not grant source access.

ordinary new resources use random client uuids. logical daily identity is
`(account_id, local_date)`. preserve seeded ids; new unseen days mint
`uuid5(account_id, "daily:" + local_date)`. opening a day writes nothing; its
first actual item/edit makes it live. an empty title displays the date-derived
default without inserting default text into the crdt. recreating a deleted day
reuses its identity and may reveal its old title and still-live relationships.

daily, user-link and passage records retain permanent semantic-key-to-id bindings,
including while deleted. bootstrap includes every binding. resolve a known key
to its immutable id; mint an unseen key deterministically. this preserves old
ids through one uniform model. conflicting bindings are invalid, never aliases.
new user links mint `uuid5(account_id, "link:" + encode(a,b))`; `encode` is utf8
byte-length-prefixed sorted canonical refs. passage identity retains existing
`(source_ref, compute_anchor_key(exact,prefix,suffix))` normalization; new passage
ids derive from that key with a distinct `passage:` prefix. publication/locator
evidence does not change passage identity. never approximately merge identities.
same-key passage captures merge their hint register; differing publication,
whitespace or locator evidence is not an identity collision. a highlight's own
selection capture retains its literal quote independently of that reusable hint.

highlights are independently identified annotations, not extent-keyed singleton
records. create mints a new uuid; retries retain it. pdf resizing updates that
highlight's selection register atomically: publication, geometry, quote and
context travel together. its id and attached-note links stay unchanged. concurrent
resizes choose one register value; color resolves separately. never coalesce or
reject independent highlights because their extents coincide. existing selection
presentation must make each overlapping annotation selectable; edit/delete names
one exact id. render each attached note independently in endpoint order.

scalar color, selection, capture and position registers select the greatest
`(lamport, replica_id)`;
advance lamport above all observed commands. sort adjacency by `(position,
link_id)`. use `fractional-indexing 4.0.0`. if insertion falls
inside equal keys, re-key only that observed tie run plus the insertion between
its nearest distinct neighbors, atomically. do not call midpoint on equal keys
or rewrite every sibling for every move. concurrent moves may choose surprising
positions, but cannot duplicate membership or alter the opposite endpoint order.

## permanent single block

the sole canonical body grammar becomes:

```text
note_body_doc -> body
body {presentation: prose|code} -> (text | hard_break | image | resource_embed)*
marks -> existing strong, em, code, underline, strikethrough, safe link
image attrs -> {src, alt: string|null, title: string|null}
resource_embed attrs -> {resource_ref, label: string|null}
link mark attrs -> {href, title: string|null}
```

create the permanent `body` xml element exactly once in a new note's creation
transaction. use `getXmlFragment("body")`; hydrate existing bytes before mounting
an editor. no load-time empty-node insertion, nested-container replacement or
outer-node type replacement. formatting changes its attributes. keep yjs session
client ids separate from durable graph replica ids.

code is presentation: retain marks, suppress their visual formatting, disable
mark commands and preserve visible atoms. a sole resource embed keeps its
standalone presentation; mixed content renders it inline. this costs a grammar
migration but preserves one-block identity during concurrent format changes.
canonical text/markdown projection and codepoint/selection mapping have one
shared implementation. matching normalization must not rewrite saved quotes.
retain existing safe-href/image validation. remove the old 200-character stored
title ceiling: merged titles can exceed it; display truncation never changes
storage. presentation attributes use yjs's own deterministic resolution, not a
second register around the same field.

use standard yjs text conflict behavior; acceptance of automatic merge is not a
promise to preserve every character intentionally deleted by a competing edit.
schema repair must never silently discard writing. the inline representation
must preserve unseen neighboring text when mixed atoms are removed; paragraph/code
conversion alone does not qualify the editor adapter.

## commands and local composition

the authored-store interface is `query`, `subscribe`, `commit`, `sync_status` and
`close`. queries are closed variants: resource, adjacency, pages/daily, annotations,
backlinks, search and exact reference resolution. paginate queries; do not expose
arbitrary sql to components or the native bridge. local authored queries own the
result online too; remote search sections cannot replace them with stale rows.

| command | atomic effect |
| --- | --- |
| create page/note | new identity, initial content and requested first relationship; preserve existing first-item publication gesture |
| edit body/title | incremental yjs edits against the displayed/read baseline plus one semantic touch |
| delete resource | advance observed deletion coverage; never cascade into neighboring resources |
| add/unlink/move/relink | exact membership/position changes under the graph rules |
| create/update highlight | immutable local source capture, color/liveness and optional independent note/link |
| split | copy observed suffix to new note; remove exactly observed source ranges; add new active-occurrence link |
| join | insert observed source content at the destination anchor, then delete source using observed coverage; preserve destination id; no source-link redirection |
| undo/redo | group local-origin yjs inverses and graph inverses; never write an old body snapshot |

split does not move unseen remote insertions. concurrent source edits can revive
a joined source while the destination keeps copied text. scalar undo applies
only while that command still owns the field; an intervening remote change is
not overwritten. undoing creation preserves concurrent edits using the same
observed-remove rules. page/link actions never inspect retention counts.
exclude permanent-body initialization from text undo: undo creation changes
liveness and membership only. undo delete/unlink emits fresh touch/add operations;
undo add covers its observed add dots. one outline group coordinates per-document
undo managers; a yjs undo manager is not a cross-document transaction.

editor state may paint before commit. one local sql transaction writes touched
merge states, query projections, fts/backlinks, command counter and immutable
pending envelope. publish the saved revision only after durable commit. use
`synchronous=FULL`; the selected browser vfs must await strict indexeddb commit.
a yjs update event is not a save acknowledgement.

one coordinator serializes local commands, incoming batches and subscriptions.
firefox tabs share its worker. android uses its serialized native store; the
active signed document supplies the shared semantic kernel. local commit frames
carry expected store revision and frozen source sequence, so an uncertain reply
is reconciled by reading committed sequence, not by issuing a new semantic edit.
retry identical bytes. failed local persistence retains live input and the real
loss guard; committed unsynchronized work does not acquire an exit warning.

commit first recognizes an already committed sequence, then requires
`command_seq = stored + 1` and the expected `store_revision`. a stale revision
returns current states for re-merging the same prepared intent/delta and sequence;
never allocate a second touch. settle uncertain commit before the next local
command. incoming apply advances `store_revision` too. document/account retirement
rejects new preparation; completed native commits remain readable after navigation.
re-merge frozen delete coverage, split suffix and selection capture; never rebuild
them from newly arrived state and thereby erase an edit the user had not observed.

keep active ydocs in a bounded cache; persist the entire corpus, not 100,000
editor objects. initial cache budget: 64 documents or 16 mib encoded state,
excluding currently mounted editors. evict clean/unmounted instances only.
pin documents referenced by retained undo groups; discard oldest whole groups
before exceeding the cache budget. closing the outline releases its history.
the visible outline uses one persistent editing host. its separate admission
budget is 64 distinct documents or 16 mib encoded state across the entire
session, including disclosed descendants, neighbors, tail, pending writing and
history. release inactive windows and oldest whole history groups before loading
more. growth of already protected writing may exceed that budget: preserve the
text and stop additional loads until room exists. never discard accepted input
or remount its editor to enforce a memory number. this is an admission bound,
not a hard resident-memory ceiling.
fts5 and indexed endpoint tables supply local queries. tokenization/query
construction belongs to the shared query owner, including literal escaping.

## storage and synchronization protocol

device sql tables: `replica_state`, `resources`, `links`, `passages`,
`source_stubs`, `pending_changes`, derived `search_fts` and reference indexes.
store merge bytes/vectors alongside indexed scalar projections. projections
are rebuildable and never independently writable. native uses the same schema
and fts5 behavior, not a parallel kotlin domain model.

keys: resources by `ref`, daily date unique including deleted bindings; links by
`link_id` with unique sorted endpoint pair; passages by `anchor_id` and semantic
key; pending changes by `command_seq`. index both link endpoints with their
position/id, annotation source, incoming embedded refs and visible page title.
fts rows use stable resource refs. one local revision covers coherent query results.

| native operation | input → result / transaction |
| --- | --- |
| hello/read/query | bound account only; closed query + nullable cursor → revision and bounded rows |
| commit | expected revision, source sequence, prepared change and projections → committed sequence/revision; atomic states/indexes/pending/counters |
| commit_status | source sequence → committed or not committed plus current revision; no new write |
| pending | after source sequence → immutable bounded changes |
| apply_remote | expected revision, full server batch, merged states/projections → revision/cursor, atomically |
| acknowledge | verified accepted sequence → delete that pending prefix only, atomically |
| finish_provisioning | snapshot watermark/counts → completed corpus and readiness, atomically |
| close/purge | existing account lifecycle authority only; document javascript cannot choose an account or path |

server tables: `authored_replicas(account_id, replica_id, accepted_seq)`,
`authored_heads(account_id primary key, head_seq, lamport)`,
`authored_resources`, `authored_links`, `authored_passages`,
`authored_source_stubs`, and
`authored_changes(account_id, server_seq, replica_id, command_seq, change)`.
primary keys include account; source `(replica_id, command_seq)` is unique.
existing relational note/graph rows become projections in the same transaction.
central visibility and all direct query callers must honor semantic deletion;
do not physically delete canonical rows and accidentally cascade foreign keys.

```text
change = {
  command_seq, lamport,
  resources: [resource_patch], links: [link_patch],
  passages: [passage_patch], source_stubs: [source_stub_patch]
}

resource_patch common = {ref, touch_vv, delete_vv}
  note      = common + {kind: "note", body_update: base64url|null}
  page      = common + {kind: "page", local_date: date|null,
                        title_update: base64url|null}
  highlight = common + {kind: "highlight", source_ref,
                        selection: register<selection_capture>,
                        color: register<existing_highlight_color>}
link_patch = {link_id, endpoint_a, endpoint_b, add_vv, remove_vv,
              position_a: register|null, position_b: register|null}
register = {value, stamp: {lamport, replica_id}}
passage_patch = {anchor_id, source_ref, normalized_exact, prefix, suffix,
                 capture: register<{quote_exact, publication: identity|null,
                                    locator: existing_typed_locator|null}>}
selection_capture = {publication: identity|null, locator: existing_typed_locator,
                     quote_exact, prefix: string|null, suffix: string|null,
                     passage_ref: resource_ref|null}
identity = {kind: "reader", generation: positive_int}
         | {kind: "note_text", sha256: canonical_text_utf8_hash}
source_stub_patch = {source_ref,
  capture: register<{kind, label, publication: identity|null}>}

POST /authored/replicas {replica_id, format_revision}
  -> {accepted_command_seq, head_cursor}
POST /authored/changes {replica_id, changes}
  -> {accepted_command_seq, head_cursor}
GET /authored/changes?after=<cursor>
  -> {changes:[{server_seq, replica_id, change}], next_cursor, head_cursor}
GET /authored/snapshot
  -> ndjson header {format_revision, head_cursor, lamport}, records, completion footer
```

define these closed pydantic variants and generate web wire types through the
existing generator. yjs updates are base64url on json wire, binary in storage.
resource kind, daily binding and link endpoints are immutable; unknown notes
must receive their one complete initializer before becoming visible. null update
means no text change, never blank text. vector merge and yjs apply are idempotent.
positions use string registers; highlight selection/color use their closed field
types. projection rows never arrive as an independent remote authority.
highlight source is immutable; reuse current pdf canonicalization and typed
text locators. null publication represents unknown provenance, not permission
to apply old offsets to new text. null passage_ref permits a geometric pdf
selection without a textual passage anchor.
reader generations come from the mounted publication/download manifest. note
hashes address the canonical text used by offsets. source-stub labels are literal
captures, not a claim of current remote metadata; refreshing them never touches
authored liveness or grants access.
all requests retain `X-Nexus-Wire`, current auth and account admission. no new
public arbitrary command executor or whole-body replacement endpoint.
400 rejects invalid schema; 409 rejects foreign identities or sequence gaps;
426 rejects format/wire mismatch. a stored valid offline edit is never refused
because its observed body version or original source publication became stale.

initial bounds: 2 mib per fully encoded atomic change, 3 mib per complete encoded
request/response, 100 query rows; count base64 and wrappers. these fit the current
[bff payload ceiling](https://vercel.com/docs/functions/limitations).
the 3 mib limit covers non-streaming envelopes and change-feed pages. snapshot
total size is not subject to it; stream bounded chunks without buffering the whole
response, within the stated time/memory limits.
an indivisible command occupies a page alone if necessary. reject oversized
input before local success, never strand a committed command at upload. migration
preflight must report existing content exceeding this budget rather than truncate
it. native transfer uses the existing 24 kib raw chunks within 64 kib frames.

the server locks `authored_heads` and processes one bounded upload in one
postgres transaction. skip its accepted prefix, require contiguous remaining
source commands, allocate consecutive feed sequences transactionally, merge and
validate touched states through the shared helper. commit canonical states,
projections, feed rows, head and accepted sequence together. source byte identity is
frozen at local commit. no replay-result ledger or `client_mutation_id` exists.
this feed is replication data, not an activity feature. a lost reply is resolved
by the verified accepted prefix returned by registration or upload. any resend
uses the same changes; it never executes a fresh delete/edit.
verified acknowledgement deletes only that replica's accepted pending prefix in
one local transaction. applying its own echoed feed changes is idempotent and
creates no new touch. permanent protocol/schema defects show one sync error and
retain pending bytes for repair; never silently drop or rewrite commands.

download complete commands in server-sequence order; apply each plus its cursor
advance atomically. notification is only a hint: reuse the existing writing
stream to wake catch-up. cursor reads recover missed events. send and receive
independently; a failed upload must not prevent downloading newer content.
transient failures back off with jitter up to 30 seconds while open; reconnect
and foreground trigger an immediate attempt. auth/format failure pauses remote
work, not local editing. no retry inventory.
each pull reads one consistent head `h`, returns a bounded ascending prefix at
or below it, and sets `next_cursor` to the last returned sequence (or the input
cursor). continue until cursor reaches `h`; never advance past unapplied changes.

first provisioning streams one repeatable-read snapshot at watermark `h` into
staging storage. publish readiness only after its completion footer and local
indexes commit; the footer repeats `h`, the captured account lamport and exact record counts.
initialize the replica lamport from that captured clock in the same local
publication transaction; source counters and feed cursors are distinct clocks. then consume
changes after `h`. interrupted provisioning restarts
the snapshot. never label a partial corpus offline-ready. request browser
persistent storage from the window, not the worker; denied/unsupported durable
storage prevents the offline-ready claim and produces a specific setup error.
use a dedicated bff stream route with existing `proxySession(..., "Stream")`,
`maxDuration=300`, `no-store/no-transform` and cancellation propagation; no json
buffering. qualify the full snapshot within the existing 280-second stream
deadline. server snapshot transactions close on completion or cancellation.

v1 retains the change feed and required causal state. no age pruning, stale-device
expiry, custom crdt garbage collector or history UI. this spends disk to avoid a
compaction protocol. a future coordinated, fully drained release may compact
transport state without discarding causal data needed by the current documents.

existing server tools call the semantic owner within their transaction, with the
same stable tool-call-derived identities. keep current additive capabilities;
one server replica per account allocates causal counters under the same head
lock; existing tool-call completion prevents retries manufacturing fresh touches.
this project does not add an autonomous rewriting tool. any existing or later
fine-grained edit must carry its actual read baseline/relative positions and use
the shared editor operations; it cannot replace a newly read body with stale
generated json. keep authorization, run fencing and tool limits unchanged.

## startup and source integration

generalize the existing vite installed-shell build for desktop and android.
one shared workspace entry and host adapters replace desktop's server-dependent
authenticated bootstrap. next remains the public/auth/bff host. a browser service
worker precaches the explicit shell asset closure, including lazy authored panes,
worker/wasm, fonts and query code; it serves known workspace navigation routes
from that shell. it never caches auth/api responses or arbitrary private html.
normal online startup uses that same shell, not a second ssr writing application.

browser local binding stores confirmed account/profile/workspace metadata beside
the authored database. android retains `DeviceSession` as account authority.
remote token expiry cannot clear a local account. first provisioning still needs
online verification. a same-account sign-in resumes transport. explicit signout
drains pending writing or requires deliberate discard before account retirement
and purge. cancel leaves data intact; account retirement prevents late callbacks
from republishing it. browser tabs close their owners before purge.

browser offline-ready requires both the completed corpus and the complete shell
cache; an earlier account binding establishes neither. register the service
worker only in the browser adapter; android retains apk/AppRouter asset delivery.
the database shared worker uses a stable same-origin url and account/format name,
plus a format handshake. hashed per-build urls must not create competing owners.
compatible shells reuse that worker; an incompatible release closes all old
ports/workers before admitting the new one.

reuse csp generation. cached shell html and its policy must agree; generate fresh
matching nonces when serving templates. permit wasm compilation narrowly for
the storage worker, never broad `unsafe-eval`. activate a new shell only after
local commits settle; incompatible format activation requires the coordinated
release procedure, not automatic storage deletion.

downloaded readers reuse reader source/progress ports and one extracted annotation
controller. the new native authored bridge admits the owned workspace entry and
the exact packaged `/shelf/index.html` document generation, never source-asset
mainframes or subframes. preserve shelf network isolation; its sync driver uses
fixed native push/pull calls through current credentials. no arbitrary url/file
bridge and no shelf access to account/settings commands. reuse existing framing,
document retirement and account checks. annotations and reader-position sync
remain separate owners.
deny direct `/shelf/copies/*` mainframe navigation. the shelf gains no account
menu; intervention requiring sign-in returns to the workspace.

store original publication, quote and locator even if the source changes before
upload. unique valid relocation may update a derived location; ambiguity remains
unresolved beside the saved quote. no stale-offset reassignment or rejected
writing because the server no longer has that publication. inaccessible source
refs confer no reading permission. note-target anchors use the shared canonical
text projection. existing image/embed references survive offline; absent bytes
and new uploads retain their online/availability limits.

## interaction and content design

each work package assigns the named feature designer below and a different
reviewer. designers own copy, empty/error states, keyboard/focus behavior and
literal content projection within these schemas. this is not a content-generation
feature. use existing feedback, button, menu, dialog and announcement primitives.

| designer | good content / interaction |
| --- | --- |
| editor and graph | preserve words/marks/refs; distinct `unlink`, `delete note`, `join notes`; no injected conflict prose; previews derive from canonical content |
| reading | verbatim quote and truthful source label; `source isn’t available on this device` or `passage couldn’t be located in this version`; retained note stays editable |
| discovery | canonical label, literal excerpt, exact target; local authored results remain available beside separately unavailable remote sections |
| shell and sync | one status control in account chrome/menu, never pane headers; current state only, no counters/event list |

status is a closed local model: `preparing`, `saving`, `offline`, `syncing`,
`current`, `sign_in_required`, `update_required`, `local_error`, `sync_error`.
copy respectively: `preparing your notes`, `saving on this device…`, `offline`,
`syncing`, `up to date`, `sign in to sync`, `update nexus to sync`,
`couldn’t save on this device`, `couldn’t sync`. offline detail is
`changes are saved on this device.` current means exchanged through a known
server watermark, not knowledge of disconnected replicas. local error appears
beside affected writing with `keep this page open. retry saving.` and retry/copy.
remote errors retain local saved status and explain the current actionable cause.
status precedence: local error, uncommitted save, provisioning, format/auth failure,
sync failure, offline, syncing, current. current requires no pending changes and
`server_cursor` through the latest observed head. disconnection is not sync failure.
no routine success toast or announcement; real failures announce once. color is
never the sole signal. preserve keyboard focus and 200% text-zoom access.

delete activity mounts, commands, undo offers and registry machinery. migrate
each remaining non-writing condition to its actual owning surface; a discrete
failed action may use existing transient feedback. do not drop import, playback,
settings or chat failures, or recreate activity under another name. remove the
reader's `/stats` activity alias; retain account statistics and consumption data.

## work packages and exact boundaries

one editing owner per file. new directory names below are prescribed; split files
inside them only for independently understandable responsibilities. reviewers
challenge contracts before implementation and completed behavior before handoff.
all packages integrate into one cutover, never independently deployed legacy arms.

| package / designer | owned paths and deliverable | dependencies / adversarial review |
| --- | --- | --- |
| a semantics / editor-graph designer | new `node/authored/`; move canonical `apps/web/src/lib/notes/noteBody.ts` grammar/projection here; new schema/identity/merge/commands/sql contracts | first; distributed-data reviewer challenges liveness, initialization, one-block preservation and ordering ties |
| b device persistence / sync designer | new web `lib/authored/`; native `authored/`; worker, sqlite adapters, pending transport, subscriptions and bridge | a; storage reviewer challenges crash, acknowledgement, account lifetime and two tabs |
| c backend / data designer | new python `services/authored/`, `schemas/authored.py`, `api/routes/authored.py`; existing note/highlight/outline/resource-graph services and routes, tools, stream, schema registration; api runtime/container packaging | a; independent transaction reviewer proves one authority and idempotent whole-command replication |
| d editing / editor-graph designer | web `lib/notes/` except moved grammar; `components/notes/`, `components/resources/ResourceComposer.tsx`, page/note panes, share capture, `lib/resourceGraph/` | a,b; concurrency reviewer challenges IME, split/join/undo and duplicate occurrences |
| e reading/discovery / reading and information designers | media annotation/controller/selection files, extracted reader annotation module, shelf presentation, downloaded episode; search pane, `lib/nexus/useNexusFind.ts`, reference pickers through d-owned contract | b,d; reader reviewer challenges source generations, multiple attached notes and offline query closure |
| f startup/interface / shell designer | shared shell build/entries, authenticated layout/entry/shell, native session/router/main activity, auth/work guards, account menu, appnav/pane shells, feedback registry and launcher rows | b; platform reviewer challenges cold startup, source isolation, status truth and displaced conditions |
| g migration/release / data designer | one new `migrations/alembic/versions/` migration and frozen conversion support; `docs/issues/release-local-first-writing.md`; owner/module docs and `docs/reauthoring.md` | a–f; independent migration reviewer challenges counts, references, unsupported data and pending devices |

package f owns routing/admission changes; b owns bridge/storage implementation.
e requests picker API changes from d. c owns backend packaging; f owns frontend
and apk packaging. every package owns its disposable cases; g coordinates final
cross-system qualification. retain no separate verification framework.
f includes `vite.android.config.ts`, `src/android/main.tsx`, native
`DeviceWorkspace.tsx`, `src/middleware.ts`, `lib/security/csp.ts` and android
`AppRouter.kt`; remove hardcoded android facts from the shared desktop entry.
f specifies displaced feedback ownership; each package edits its own consumers.

delete the obsolete memory fifo/authority in `notes/writes.ts`, `notes/texts.ts`,
`useWritingRuntime.ts` and mounted probes in `api/writingReceive.ts`; do not keep
them as fallback readers. remove whole-body/version-conflict authored write
routes and acknowledgements, retention-based `remove`/`consume_note`, authored
empty-resource collection, daily random-id conflict and singleton annotation
rules, including exact-extent highlight aliasing and duplicate-resize refusal.
adapt existing structural/selection presentation instead of duplicating it.
retain server-state hooks and fetch for server-owned domains. remove dead exports,
generated variants, callers and docs with the paths they belonged to.

## migration and hard release

first delivery preserves existing authored data. one migration after actual head
preserve live resources and every recoverable semantic binding. after every old
client is drained and closed and its wire rejected, retire obsolete old identity
tombstones. an already-deleted old link retained only one endpoint, so its erased
pair has no recoverable semantic binding; old page teardown also erased its
daily-date binding. recreating an erased pair or day uses the new deterministic
id. do not invent endpoints or reconstruct deleted history. extant unresolved
references still refuse migration.
freezes the old grammar conversion and seeds yjs once per note/page; no imports
from mutable application modules. seed semantic bindings with existing ids;
preserve node/link/anchor identities, references, each annotation note, quote
and endpoint order. convert typed embed attributes without rewriting prose.
report binding collisions/unconvertible records and raise before publication.
current highlights do not always retain original publication generation: assign
a current generation only after exact quote/extent proof. otherwise store original
publication as `null`, retain quote/locator, forbid blind offset reuse and resolve
by unique quote. incomplete provenance is a canonical state, not a legacy reader.

release issue owns the exact operator steps: inventory both provisioned clients,
drain writing, close clients and stop server writers, verify the existing backup,
run migration, pair server/web/apk, provision and verify both devices. future
format-breaking releases additionally drain the replicated cursors, not merely
an empty upload queue. missing device means postponed release or explicit owner
decision about its local-only data; silence is never discard permission.

update `AGENTS.md` authored-storage/write rules and affected module docs in the
implementation cutover. bump wire once for the release under its current rule.
old authored endpoints/types/readers disappear; incompatible clients fail the
normal revision gate. keep existing source downloads, progress and operational
backups. no reset-and-hope migration, dual write or compatibility fallback.

## acceptance and implementation workflow

use [repository verification](local-rules/testing-standards.md). temporary real
integration/live cases first, meaningful red, implementation, green, independent
adversarial review, refactor, rerun affected cases and `./scripts/test`. use the
existing lab/runtime, real storage/transport and actual firefox/android surfaces.
unchanged invariants are controls, not manufactured red cases. no production
fault injection, permanent scenario suite or test-only product seams.

| acceptance family | required result |
| --- | --- |
| offline CRUD | provision; disconnect; create/edit/delete each authored kind; search/backlinks agree; kill/reopen preserves every acknowledged local commit |
| concurrency | phone, two firefox tabs and server author merge same-note changes in both delivery orders; concurrent type/mark/atom edits stay valid; same-day creation and same-passage independent notes converge |
| graph | last unlink/page deletion preserves notes; delete/edit revives only addressed resource; explicit unlinks stay removed; equal-position insertion and concurrent moves converge |
| scoped search | owned authored results match server scope predicates at the same metadata revision for media/parts, libraries and conversations; new offline edits use the replicated scope facts immediately; metadata replacement exposes one complete revision; readable peer results retain their remote owner |
| structure/undo | rapid edit/split/join/undo/redo preserves identity, unrelated incoming edits and the documented duplication rule; test IME and repeated appearances |
| durability | interrupt before local commit, after local commit, after server commit before reply and during incoming apply; no false saved state, half-command or duplicate semantic effect; retry same bytes |
| lifecycle | auth expiry, reconnect, cross-tab signout, cancel/discard, failed purge, shell update and wrong-account callbacks obey local authority |
| sources | annotate saved pdf/text offline; reopen/sync in shelf; independent overlaps retain notes; concurrent resize preserves highlight identity and chooses one coherent capture; deleting one overlap leaves the other; publication change preserves quote/note; deny source-mainframe/subframe access |
| server/tool composition | existing tool-created note/highlight/link reaches both devices through the sole feed; no direct projection writer or permission expansion; remote retrieval sees acknowledged canonical projection |
| scale | 100,000 realistically sized and previously edited blocks on target handset and firefox; cold usable authored view ≤3s, warm note open ≤150ms, local search ≤250ms, typing paint ≤50ms; report corpus distribution, samples, peak memory, disk and initial download time |
| interface | no activity/nav/pane controls, global undo or routine offline failure toast; account stats survives; remaining failures have an owner; keyboard/zoom/announcements pass |
| migration/cutover | representative current data preserves canonical content/relations/ids; unsupported data refuses; old write routes gone; both paired clients cold-open and exchange edits |

performance numbers are target budgets, not measured results. cold startup
excludes first provisioning and uses a fresh process with the same provisioned
profile. measure firefox from navigation start to usable writing; measure android
from the launch intent to usable writing, including native initialization.
report automation attachment separately; never add percentile summaries or
substitute renderer-only timing for android launch timing.
cases declare sample counts/percentiles before
measurement and record actual handset/browser versions. qualify actual
released sqlite binaries for fts5 and durable commit, and the shared node helper
under the current server memory envelope. stop for a concrete failed contract;
do not quietly raise limits, weaken semantics or leave a second implementation.

retain temporary cases until final unchanged-source qualification, then delete
them and task-owned fixtures. retain reusable composition/provisioning only.
record results and limits in the pr; unresolved defects each get an issue file.
report static, disposable runtime, installed-device and deployed proof separately.
no deployment or data deletion is authorized by this specification alone.

## trade-offs retained deliberately

full replication spends disk and provisioning time. automatic text merge can
surprise; code presentation preserves richer content than a traditional code
node. scalar conflicts choose one value. revival may reveal old relationships;
join may duplicate concurrently edited text. internal feed retention spends disk
without adding history ui. overlapping highlights remain distinct, and concurrent
resizing selects one complete selection. direct sync avoids a service but owns
protocol code; shared semantics adds a bounded node process to python. firefox and native sqlite
need different persistence adapters. coordinated breaking releases trade downtime
for one protocol. browser clearing/device loss can destroy unsynchronized writing.
ephemeral unsubmitted passage input and unavailable media bytes retain their
existing limits. these are chosen trade-offs, not promises of recovery.
