# notes

the user's own writing: titled pages, one-block notes, the neutral links that order
them into outlines, a page per day, notes on highlights, and quick capture
into today. python owners (under `python/nexus/`): `schemas/note_bodies.py` (body
grammar), `schemas/notes.py` (notes and command models), `services/note_bodies.py` (the note row),
`services/outline.py` (outlines and their commands), `services/notes.py` (pages, days,
capture, annotations), `api/routes/notes.py`. web (under `apps/web/src/`):
`lib/notes/` (`noteBody`, `outline`, `useOutlineSession`, `useOutline`, `texts`, `writes`, `api`) and
`components/notes/`.

## contract

| route | retry rule |
|---|---|
| `GET /notes/pages?sort&direction&limit&cursor` (keyset, the chats index's views) | read |
| `POST /notes/pages {id, title, initial_item}` → 201 `WritingAck` | same owner: current identity facts, including retirement; another owner's id: 409 |
| `DELETE /notes/pages/{id}` → `WritingAck` | idempotent; the page's notes stay |
| `GET /notes/daily/{date}` → `{local_date, materialized, outline}` | read; writes nothing |
| `POST /notes/daily/{date}/captures {note_id, link_id, text}` → `WritingAck` | recognized identities retain their accepted source and retirement; retries never append into a replacement day |
| `GET /notes/blocks/{id}` → `{id, body_pm_json, body_text, body_version, embedded_item}` | read; immediate embed projection is nullable and batched |
| `GET /resource-graph/outline/{ref}?limit&cursor` → `{source, insertion_source, links_version, items, next_cursor}` | bounded mixed adjacency; stale cursor is 409 |
| `POST /resource-graph/commands {commands}` → `WritingAck` | atomic; exact unlink retries converge |
| `PUT /highlights/{id}/note {note_id, link_id, body_pm_json, expected}` → `WritingAck` | absent: loaded highlight `links_version`; version: exact attachment and note `body_version` |
| `DELETE /highlights/{id}/note/{note_id}` → `WritingAck` | idempotent; the note stays |
| `POST /highlights/{id}/note/delete {note_id, expected_version}` → `WritingAck` | exact attached note/body version; an already absent note stays absent |

an outline node is `{item, content}`, where `item` is the shared
`ResourceItemOut`; content is
`page{title, title_version, daily_date}` | `note{body_pm_json, body_text,
body_version, places, embedded_item}` | `resource{}`. a latent day's outline carries its page's
proposed fresh uuid and default title, and no occurrences. the `materialized`
envelope gates resource actions until acknowledgement.
an occurrence is `{connection, content}`; `connection.other` owns its displayed
identity. captured evidence always has `content.kind=resource`.
`insertion_source` is a required nullable capability. an exact passage-candidate
read retains that candidate's source, adjacency and version; its durable insertion
owner is separate. disclosed candidate facts and durable passage items keep their
own orders and fences. no read combines them into invented adjacency.

commands, applied in order in one serializable transaction:

| primitive | effect | idempotence / precondition |
|---|---|---|
| `set_body {note_id, body_pm_json, expected_version}` | absolute body | current == desired: no-op; else the version must match (409 `E_NOTE_CONFLICT`, `details.current` the note) |
| `set_title {page_id, title, expected_version}` | absolute title | same (409 `E_RESOURCE_CONFLICT`, `details.current {title, title_version}`) |
| `ensure_daily {local_date, page_id}` | proposed page and date binding | different live binding refuses with 409 `details.current_page_ref`; newly created days require their first link in the same batch |
| `insert_note {source, link_id, note_id, position, body_pm_json}` | create/reuse a note and link without overwriting its body | owned link id first; pair reuse never moves |
| `insert_link {source, link_id, target, position, require_created}` | materialize exact endpoints and link atomically | same; returns canonical endpoints; required creation refuses reuse of another edge |
| `move {endpoint, edge_id, after, expected_links_version}` | reorder any owned incident fact | only command in batch; already desired is a no-op, otherwise version must match |
| `unlink {link_id, expected}` | remove the exact owned user/discovery/assistant connection; preserve resources, every other edge and history | absent succeeds; foreign/other origins or stale supplied endpoint/version fences are 409 |
| `relink {endpoint, link_id, destination, new_link_id, position, expected_source_links_version}` | guarded structural reparenting | minted new id first; source fenced; null position appends at commit, concrete position fences destination |
| `remove {endpoint, link_id, expected_body_version, expected_links_version}` | structural removal; consume its note only without another retainer | a missing link or an already deleted note endpoint: no-op |
| `consume_note {endpoint, link_id, expected_body_version, expected_links_version}` | join consumes the exact source note | another retainer or stale body refuses atomically |

unlink batches contain only unlink commands; mixed batches are 400 before effects.
duplicate exact ids apply once. one transaction removes all or none and
acknowledges exact removals and changed lanes. the flush-only
`resource_graph.links.unlink_in_txn` owns exact removal. highlight annotations
and independent ordinary links survive.
before applying commands, the executor collects every `set_body.note_id`. remove
and consume inspect the actual locked target and its complete graph retention;
if they would delete an edited note, the whole transaction refuses with
400 `E_INVALID_REQUEST` before removing its edge or body. this applies in either
command order and forbids temporary deletion followed by recreation. editing one
note while consuming another and removing a link to a retained edited note remain
supported. a batch cannot remove and remint the same link identity.

positions carry `{after, expected_links_version}`; null position deliberately
appends, null predecessor means first. a missing predecessor or stale version
conflicts. sources are direct resources, passage candidates, frozen reader
selections or a captured daily date and proposed `page_id`. the graph capability
owns source admission. `daily_page` sources carry `{local_date, page_id}` and obey
the same binding-conflict contract as `ensure_daily`.

## invariants

- I1 `body_text == text_from_pm_json(body_pm_json)`; `lib/notes/noteBody.ts`
  `projectBody` mirrors it byte for byte (python whitespace and line breaks), the
  offset basis of passage anchors and source inspection.
- I2 a body is one paragraph (text, hard_break, image; marks strong, em, code,
  link, strikethrough, underline), code_block (unmarked text) or object_embed; a link href
  is `/`-relative (not `//`), http(s) with a host and no `%` in the authority, or a
  mailto without an authority.
- I3 actual body creation/change bumps the `body` lane, replaces the note's
  `note_body` embed edges and enqueues `note_reindex_job`; equal writes do none.
- I4 creates take client ids: pages, notes, links (`edges.create_link(link_id)`).
- I6 a date has at most one page and a page at most one date; reading a day writes
  nothing.
- I7 a capture's blank text is 400 `E_EMPTY_NOTE_BODY`. the reader composer omits
  creation only for a canonical empty paragraph; other rich bodies save normally.
  an existing note can be saved empty without changing its identity or links.
- I8 structural retention counts every cross-owner graph fact,
  including derived endpoints and captured historical owners. it reads only
  the facts incident to what the page or note owns (itself, its passage anchors,
  evidence spans and content chunks) or that captured it, and only its owner's: no
  other user's fact reaches a page or note (premise checked by census C12).
  ordinary menu/cut/block unlink preserves user links' resources and annotation
  prose. machine rows use their shared connection menu outside structural history.
  a mixed selection containing a non-user edge or another removal capability
  refuses atomically. generic unlink retires dependent structural history and
  offers no undo; unrelated text history survives. guarded joins use
  `consume_note`; user empty-body backspace and split inverses use structural
  `remove`, with explicit body/sharing/annotation checks.
  `delete note everywhere` remains explicit global destruction.
- I9 a live resource's missing version row reads as 1; the first write creates
  it. inaccessible/deleted resources have unavailable, nullable probe lanes.

## publication and weekly retention

page creation accepts one closed initial item: a rich note with client note/link
ids, or a resource/passage link target with its client link id. the initial note
must not be a canonical blank paragraph. page, optional note/passage anchor and
first link publish in one serializable transaction. an owned page-id retry returns
current identity facts before resolving the initial target again; failed publication
leaves none of its new rows. lifetime authored identities preserve aliases and
retirement. an old create cannot recreate deleted roots or initialize new children.

`resource_graph/retention.py` owns canonical blankness, complete retention, owner
pins and activity touches. only paragraphs with no children, attributes or marks
are blank; omitted and empty containers are equivalent. whitespace, breaks, empty
code blocks, images and embeds remain content. cross-owner persisted graph
relationships in either direction retain their subjects.
reads, folding, no-op retries and semantically equivalent indexing do not renew
grace. real text/title edits, saved order changes and retaining-reference changes
touch `last_activity_at` after pinning, without changing collection ordering.

`services/empty_resource_cleanup.py` runs weekly through the existing background
registry. page eligibility is no retainer; notes additionally must be canonical
blank. both need seven days without activity. each run freezes a database cutoff;
each invocation inspects at most 100 refs in stable order. each short read-committed transaction
locks its claim and root, rechecks in a fresh statement, and checkpoints every
inspection with its cursor and counters. continuation resumes the same cutoff.
canonical teardown owns graph, binding, anchor, index and protocol
state; it never commits inside the sweep. queued or running index/discovery jobs
may outlive the resource. their handlers recheck the live root and cannot recreate
it; ordinary background pruning owns terminal job history.

`nexus cleanup-empty-resources --preview` emits at most 100 eligible, content-free
entries bound to database name/system identifier, schema revision, runtime source
sha and cutoff. each entry records owner, activity, versions and dependent counts.
`--apply <inventory>` locks the whole reviewed set and validates all surviving
entries before deleting any, in one transaction. drift refuses the batch; absent
ids have landed. `truncated: true` means apply this batch and preview again.

## writing in the browser

the editor composes the [shared resource row and recursive list](resource-references.md).
one arranged list interleaves all direct facts. the shared projection omits
traversed facts; distinct ancestor references remain terminal. selection, copy,
navigation and joins consume those same visible rows. every owned incident fact
may move; visible sibling positions translate to canonical link-order anchors.
structural note operations and removal retain explicit capabilities.

immutable outline references have no editor. their native title/bullet opens;
unused primary space selects the occurrence. the labelled occurrence target owns
space-to-select, enter-to-insert, tab/shift-tab, supported navigation, sibling move,
preserving unlink and f2 into its item text. item text is a row's own note body or
inline page title (`itemText`, set only by `ResourceOutlineRow`). it is not a
sequential tab stop: pointer, f2 and programmatic focus reach it. in editable, idle
item text, tab/shift-tab and the move chord (`outlineStructuralCommand`) belong to
the outline: executed when enabled, silent when refused, never on key repeat. root
text, the insertion line and annotation bodies keep native keys. escape from item
text selects its occurrence; the next escape clears selection and focuses the
bullet, from which tab moves on, so keyboard traversal passes every row. nested
native links/buttons retain their own keys. no focus/zoom, reference token editor,
internal structural drag or add-item button/menu remains.

every composing transaction stays editor-local until commitment; the final rich
body and selection then checkpoint together. acknowledgement projection waits
for that composition boundary. failed continuation input remains copyable in its live writing owner.

one session interface, `commandState` / `executeCommand`, serves hardware and the
touch accessory: insert, indent/outdent, sibling up/down, undo/redo. the pane shell
renders the accessory only where touch is possible (`useTouchCapable`,
`any-pointer: coarse`), in any layout; keyboard devices use the keys that settings
→ keybindings lists (`outlineShortcuts`). execution checks
the current exact target, source version and capability. note insert keeps split at
caret; page insert flushes the canonical title and inserts after it without
splitting the title. root title enter focuses/inserts the first child. composition,
native text grammar and `@` input take precedence. reference-query undo is local;
structural commands remain disabled until it settles. mixed/group moves refuse.

disclosure availability is independent of folds and composer lifetime. removing
the last child removes its parent's chevron while preserving open insertion hosts,
reference query, selection and captured destination. a closed composer host uses
the destination's occurrence prefix/path to identify its parent; sibling continuation
never retargets it. the command union has no add-child action.

undo can fence removal of its own created edge through that exact producer's
insertion receipt and live source lane. the occurrence retains this proof through
edge reminting and redo truncation. it grants no positional authority, never
refreshes an independent observation, and cannot bypass a later server version.

`PageTitleEditor` binds root and inline page titles to the same `texts` entry and
authoritative `title_version`. history uses `TextValue`, keeps caret/direction and
belongs to the editing surface; another surface's later edit invalidates old title
undo. browser history input, hardware and bar use that owner. conflicts never
overwrite dirty text; blank titles remain unsaved. root titles retain the existing
latent/new-page creator and acknowledged base; editing cannot publish an unmaterialized
page. title flush and structural admission are separate outcomes.

a single retained insertion composer captures its source, predecessor, rich body
and selection until handoff. the canonical occurrence and live write owners
retain admitted ids and requests. the empty/trailing insertion line writes nothing
on render/focus. prose or explicit insert admits existing creation; `@` query text
never autosaves. changing slots returns to the unfinished composer unless explicitly
discarded under work protection. successor edits survive delayed acknowledgement.
refused/unknown writes keep their live request owners.
an accepted reference hands off and retires its composer at admission; its later
acknowledgement cannot close another query or newer input. an unfinished composer has
one host for its exact occurrence path. if its predecessor disappears, that host
keeps the original destination and exposes review/discard rather than rebasing.

only the interacting session publishes the typed `PaneChromeState.outlineCommands`
slot. its cleanup withdraws only its own publication. the session scope revokes
inactive, modal or superseded ownership; the shell rechecks before dispatch. native 44px command
icon buttons retain text selection/keyboard, expose precise accessible labels,
wrap as needed, and sit outside the body's
horizontal scroll owner. shell flow reserves their actual height; existing mobile
viewport/inset owners account only for clearance not already consumed. done leaves
editing and releases ownership without promising save completion.

ancestor returns reveal within the current root. editable bodies are never
preview-clamped. still-owned focus requests apply when an editor becomes ready;
newer interaction revokes them. embeds retain their containing note identity and
batched `embedded_item`. select-all or deleting an embed atom changes its versioned
body, never an invented relationship command. annotation child insertion targets
its note's child sequence, never the highlight's connections.

source inspection decorates acknowledged canonical text without changing the
editor selection or history. the resolved body version and displayed projection
must match; a differing draft makes location unavailable until reopened against
compatible text. confirmed deletion fences old writes and invalidates affected
undo entries. dirty title/rich body remains visible and read-only for copying.

- `texts`: one body/title owner per account and resource in this tab. committed
  edits paint immediately; autosave is eligible after 250 ms idle or 2 s of
  continuous committed input. coalesce only unsent values, with at most one field
  save outstanding. its acknowledgement adopts the exact saved base while newer
  input remains. composition carries its captured value/version until commitment;
  only its named desired-value receipt can advance that authority. dirty input
  cannot be rebased by a read or unrelated receipt. rich comparison requires a
  choice against the displayed revision/version. title-only pages stay local.
- `writes`: one memory fifo per account in this tab. live handles own immutable
  intent, settlement and notifications. named predecessor handles authorize
  sealing method/path/body/wire bytes once; retries reuse them exactly. three
  attempts bound one automatic cycle, with a 30 s deadline and 1–30 s jittered
  backoff respecting retry-after. offline/admission pauses consume no attempts;
  reconnect does not renew an exhausted budget. explicit retry starts a new cycle.
  no-effect refusal rejects named dependents and permits independent work; an
  unknown outcome fences the suffix. a nonretryable conflict after prior response
  loss stays unknown: copy, then deliberately reload. no in-place reconciliation.
  accepted state precedes isolated canonical callbacks, promise settlement and
  presentation notifications; callbacks cannot resend or strand a write. proofs
  for identity, placement and retained-note undo live only with referenced handles.
  teardown fences old callbacks and abandons local work without promising server
  cancellation. no journal, browser locks, terminal-result archive or cross-tab
  delivery. independent tabs use server versions and explicit conflicts.
- `useOutlineSession`: the tab-wide outline graph and one surface's view and undo history
  (text, structure and creation items, interleaved). a structure
  edit applies at once and records its inverse; undo sends the inverse. a refused
  write refuses dependent structure and retains its latest text in memory. canonical read owners revalidate. unrelated text history
  survives. a reply's `deleted_refs` or an acknowledged global note deletion
  stops the removed note's text saving. global deletion removes loaded placements,
  rejects older reads and clears histories that could recreate that note.
  `useResourceOutline` owns root and branch reads, paging, failure and retry through
  `usePagePrefix` and the existing server-value primitive. the notes graph retains
  the derived editing projection and pending overlays. exact links/body/title invalidation
  refreshes read owners; text adoption preserves dirty input. a source read waits
  only for unsettled structure that names that source; independent sources load
  immediately. supplied branches
  reuse their owner's first page until invalidated; a supplied daily outline then
  refreshes through the graph read owner. only accepted daily envelopes update the
  editing projection or latent draft. an unmaterialized day remains owned by its
  daily read; its future page id grants no graph read authority. a cursor conflict discards continuations and
  starts page one. partial lists authorize captured positions or explicit
  append-at-commit; they never imply a known tail. the session itself performs no reads. `useOutline` adapts page,
  note and latent-day reads/publication; disclosures and reader roots provide
  their own authoritative reads and exact destinations. recoverable reload
  failure retains the editor; absence, lost access and stale wire block editing.
  body operations identify `{key, noteRef}` separately from the outer resource.
  command admission owns pending occurrences for ordinary edits, history, paste
  and retry. history retains its real occurrence keys; acknowledgements
  settle their own admission even when a later inverse reuses the same edge id.
  body-only projections carry explicit current/local note authority. that grants
  editing, never complete adjacency, retention or join authority. one mounted
  body editor survives the pending-to-canonical handoff.
  a direct page occurrence mounts one existing outline read to obtain its
  authoritative title/version; ordinary outline rows use their supplied page
  content. this costs one read for a direct page occurrence instead of inferring
  editable authority from its label.
  its pane visit and body occurrence own the view; canonical note binding updates
  current authority without replacing the view.
  a view consumes each explicit focus serial once, including readiness changes.
  reference readiness is read after its layout installs local ownership and
  before the view updates. canonical binding cannot temporarily disable the same
  editor. there is no branch recovery or storage readiness claim.
  text history coalesces only contiguous before/after bodies. undo/redo checks
  the expected current body before restoring text, including structural inverses;
  stale entries retire without overwriting newer writing.
- preserving unlink snapshots exact edges, both endpoints and the initiating
  occurrence. every selected occurrence must be a current editable nonterminal
  user placement; unsupported selections refuse as a whole. rows remain pending
  until acknowledgement, and live pending handles block dependent structure and
  history while unrelated text saves continue. no text is carried or reset.
  its keyed uncertainty offer survives row unmount; retry nudges that same job.
  acknowledgement withdraws its own offer before one initiating success receipt.
  single ordinary refusal offers capability refresh; reread failure stays separate.
  acknowledgement removes exact edges from graph and retained replies before
  publishing; superseded reads cannot restore them. dependent structural history
  retires in every pane; unrelated text history survives. generic unlink has no
  undo. refusal releases pending state and retains live input/selection.
  only a fresh bare deletion key on the selected section admits removal; held
  keys, modifiers, composition and nested editors cannot cross into unlink. on
  devices with any coarse pointer, automatic empty-note backspace and deletion-key
  boundary joins are disabled: soft keyboards can emit a held key as fresh taps.
  explicit block selection, cut and remove-link remain available; desktop shortcuts
  retain their fresh-key rules. focus
  returns to the next surviving control, previous control or root only while the
  initiating interaction still owns it; no neighbour is selected for deletion.
- pure insertion history, including nested mixed paste, undoes one atomic batch
  of exact `unlink` commands. all new and pre-existing resource identities/bodies
  and independent links remain. redo links those retained resources using fresh
  edge ids and proven positions,
  with `require_created=true`; it never recreates or overwrites a note body.
  absent/inaccessible resources and occupied pairs refuse without substitution.
  admission moves the undo cursor once. later typing can discard redo permanently;
  acknowledgement preserves only its still-live creation item from retirement.
  an unproven position stops redo for explicit review; a fresh read never silently
  rebases the original decision.
- `/pages/new` owns local title and first-item owners. title edits, focus,
  blur and leaving do not publish. the first real rich note uses the same autosave
  eligibility window; selecting a resource/passage admits at once. admission freezes
  ids/body, then successor edits enter the shared text owner while the same mounted editor adopts publication and route identity in place.
  blank titles become `untitled`; no blank note is manufactured for publication.
  title and body risk read the same retained cell. a transient `ComposePage`
  delivery transfers only its title before claiming the delivery; it preserves
  the cell's rich body, immutable request and editor ids.
- a latent day shows one local row; its first real body or structural insertion
  materializes the proposed page and first link in one command transaction. title
  edits stay local until publication. every successful materialization records its
  exact binding before hydration; older virtual reads cannot replace it or make
  undo repeat creation. acknowledged outlines and subsequent title edits use the
  existing graph/text owners. binding conflicts preserve rich input and require
  an explicit new request against the current binding. local rows remain visible
  until acknowledgement.
  panes take the entries `EditPageTitle`, `EditNoteBody`,
  `AppendNote` and `FocusNote`; the launcher's quick note is one capture, then the
  day opened at that note.

creation names an exact occurrence and captured destination. ordinary reference
insertion creates a sibling; aligned root insertion creates a child. blank insertion
lines use the same session composer. filters, unknown positions and unavailable
reads cannot authorize creation. a latent day's sibling creation materializes its
original visible draft in the same existing contract, outside the sibling's undo
history. queued creation retains its pending text/projection identity until ack.

a definitively refused structural batch keeps its latest writing in memory
before replacing the optimistic projection. retry preserves the
original source, predecessor and atomic edit sequence, requires reviewed current
placement and body preconditions, and never guesses an append position. missing
anchors or conflicting bodies keep the draft copyable while retry is disabled.

## explicit passage notes

`SelectionDock` reuses `NoteEditor` with local `selectionDrafts` and `bodyHistory`;
it does not enroll the draft in `texts` or autosave on blur. enter saves,
shift-enter inserts the existing newline, and command/control-enter sends a new
quoted chat without changing the saved note. bodies use `NoteBody`'s canonical
`body_pm_json`/`body_text`; edits and focus use `NoteEdit`/`FocusSelection`.
composition and nested controls keep their own keys. one active composer owns its caret, rich body and undo history. outer dismissal,
reader replacement or another passage discards unsubmitted input silently. nested
chooser dismissal preserves it. no per-passage buffer inventory or restart restore. its nested query/link/upload
cells use the existing surface scope while keeping the real visit identity.
only its upload owner participates in outer-abandonment confirmation; confirmed
abandonment aborts that browser pipeline. accepted media remains on the server.
unresolved attachments block save/send; a same-owner refresh keeps the working
editor mounted and observes changed saved data without replacing local input. canonical
rich equality determines changed input; a model or quote choice alone is clean.
saving a passage and sending its text as chat remain separate explicit operations.

an empty resource-owned composer accepts typed `@` through the shared reference
controller before persistence. mutable editor cells belong to the exact visit,
route and editor; delayed acknowledgements settle their original live owner.
unmount releases the exact host’s active report. admitted writes remain
account-owned until settlement; unsubmitted passage queries die with the composer. search text never enters canonical prose or an
autosave; blur suspends it and escape makes one ordinary literal edit using its
captured body version. accepted intents freeze ids, endpoints and placement;
escape cannot turn an admitted write into prose. a definitive position refusal
keeps the query; only an explicit review of the same live row's freshly read
position permits another acceptance. the authoritative source snapshot must
change, and its version cannot precede the refused attempt. a rolled-back
predecessor may leave that version unchanged. optimistic edits do not supply
this authority. that reviewed slot also owns creation redo.
correcting a definitively refused target keeps its original placement and starts
a new causal capture; unknown outcomes retain the original request.

hyperlink input compares against the actual loaded href, including removal to
empty. a note attachment retains its original file, upload id, captured body and
accepted result in its visit cell across harmless unmounts. only actual visit
retirement or account teardown stops its remaining browser pipeline. an older
upload acknowledgement never overwrites successor prose: insertion requires the
same captured body, or an explicit whole-body replacement. accepted media stays
on the server when its browser attachment is discarded.
selection linking materializes
the exact highlight and target in the same transaction, checking the frozen
reader publication generation for text and pdf; search alone creates
nothing. every outer save/chat/structural control is gated during search.
highlight annotation composers insert accepted `@` resources under the annotation
note.
create-reference undo removes
only its exact link; redo uses the returned durable endpoints and original slot.

highlight-note creation freezes the observed viewer attachment slot's
`links_version` in `expected: {kind: "absent", version}`. the same attached id
answers unchanged; a changed slot conflicts. updates use
`expected: {kind: "version", version: body_version}` against the exact attachment.
`AnnotationNoteEditor` reads that slot before binding its first creator.
committing an annotation child explicitly enqueues even a blank creator, awaits
its exact acknowledgement, then admits the shared split/reference operation
under the annotation note. search, render and blur do not create blank notes.
the frozen canonical base excludes raw `@` query text; intervening edits cancel
an unsent child without overwriting their draft. an established attachment can
remain after child refusal or undo.

fresh backspace on an already empty paragraph (or `delete empty note`) uses the
explicit global delete command, not outline remove or annotation detach. it
checks the exact attachment and body version, then calls canonical note teardown
in one transaction. live references, derived rows and their view state are
removed. ordinal citations may retain captured evidence after derived targets
retire; those snapshots never recreate their owner. highlight, connected resources
and stored chat text remain. there
is no new undo service. acknowledgement marks the shared text gone, announces
`resource_deleted` and uses `settleDeletedResourcePanes` for visible note panes.

these commands use the same live writer and exact sealed retries.
fresh passage plus initial note is one atomic mutation with client-minted ids and
frozen reader generation, without a prerequisite read. first acknowledgement
adopts canonical identity/base in place, preserving successor input and focus.
chat admission remains owned by the existing conversation command owner. [highlight](highlight.md)
owns selection interaction; [chat](chat.md) owns admission and immutable quotes.

## receive and account lifetime

there is no writing recovery panel, export, durable outbox or browser writing
storage. `NoteNotices` reports live saving, uncertainty, refusal, rich conflict or
deleted text beside its owner. memory is never presented as a save. explicit
capture success requires backend acknowledgement. new uploads remain online-only;
completed bodies contain no local blob urls.

`api/writingReceive` owns one writing stream per authenticated tab and bounded
256-ref probes of mounted resource lanes. each projection adopts versions only
with its accepted snapshot or complete acknowledgement facts. body changes read
that body; links changes read that outline; annotations membership and embedded
note bodies have separate watches. notes index uses the coarse writing revision.
no body autosave publishes a broad notes-topic reread. reconnect, resume and the
server's 15-second fresh revision read repair missed notification hints.
connection activity, unresolved connection failure and probe failure are separate
facts. initial connection and planned renewal are quiet; automatic recovery uses
neutral status in the shared strip. a stopped connection and failed probe have
separate targeted actions; retry retains failure until accepted recovery. stream
delivery clears neither probe nor resource failure. installed admission retains
the waiting stream and its real failure rather than replacing it on focus.

`useWritingRefresh(ref)` passively observes existing account watches; body/title
notices sit beside the affected editor, independently of outgoing writing state.
accepted adoption, retirement or account teardown clears a watch failure. retry,
foreground and reconnect directly invalidate failed watches without first clearing
their errors, allowing the same observed version to reread. healthy watches keep
their duplicate-invalidation fence. confirmed unavailable text and embedded-note
bindings retire their watches under generation and binding-identity checks, while
retaining live authored text for copying. only modeled api errors enter failure
state; authentication and defects follow their existing owners.

`useWritingRuntime` activates synchronous account memory and registers narrow
ordinary-autosave loss risk with `WorkGuard`. pane navigation leaves that owner
alive. full document exit, native back/downloads and elective signout consult the
existing guard; title-only pages and unsubmitted explicit passage/reference input
add no writing warning. automatic wire reload waits for guard work or any
unsettled submitted write. security teardown keeps its existing authority.

signout uses one guarded action, pauses admission and preserves player/native
cleanup. failure before account teardown restores memory and editing for that
same account. once native signout tombstones the account, cleanup failure never
revives it. successful teardown abandons this account’s memory and fences late
results. no old local writing is replayed on login or restart. release-only exact
store retirement is documented in `docs/issues/release-online-first-writing.md`;
no cleanup reader or maintenance route remains in the final app.
