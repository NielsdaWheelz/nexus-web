# notes

the user's own writing: titled pages, one-block notes, the neutral links that order
them into outlines, a page per day, notes on highlights and links, and quick capture
into today. python owners (under `python/nexus/`): `schemas/note_bodies.py` (body
grammar), `schemas/notes.py` (notes and command models), `services/note_bodies.py` (the note row),
`services/outline.py` (outlines and their commands), `services/notes.py` (pages, days,
capture, annotations), `api/routes/notes.py`. web (under `apps/web/src/`):
`lib/notes/` (`noteBody`, `outline`, `useOutline`, `texts`, `writes`, `api`) and
`components/notes/`.

## contract

| route | retry rule |
|---|---|
| `GET /notes/pages?sort&direction&limit&cursor` (keyset, the chats index's views) | read |
| `POST /notes/pages {id, title, initial_item}` → 201 summary | same owner: the page; another owner's id: 409 |
| `DELETE /notes/pages/{id}` → 204 | idempotent; the page's notes stay |
| `GET /notes/daily/{date}` → `{local_date, materialized, outline}` | read; writes nothing |
| `POST /notes/daily/{date}/captures {note_id, text}` → `{page_id}` | an existing own note must still have its live placement on this date; otherwise 409 |
| `GET /notes/blocks/{id}` → `{id, body_pm_json, body_text, body_version, embedded_item}` | read; immediate embed projection is nullable and batched |
| `GET /resource-graph/outline/{ref}?limit&cursor` → `{source, links_version, items, next_cursor}` | bounded mixed adjacency; stale cursor is 409 |
| `POST /resource-graph/commands {commands}` → `{outlines, nodes, deleted, insertions, link_versions, daily_pages}` | every primitive converges under exact retries |
| `PUT /highlights/{id}/note {note_id, body_pm_json, expected}` | absent: loaded highlight `links_version`; version: exact attachment and note `body_version` |
| `PUT /resource-graph/links/{id}/note {note_id, body_pm_json}` | that note attached has landed; another: 409 |
| `DELETE …/note/{note_id}` → 204 | idempotent; the note stays |
| `POST /highlights/{id}/note/delete {note_id, expected_version}` → `{deleted_note_id}` | exact attached note/body version; an already absent note stays absent |

an outline node is `{item, content}`, where `item` is the shared
`ResourceItemOut`; content is
`page{title, title_version, daily_date}` | `note{body_pm_json, body_text,
body_version, places, embedded_item}` | `resource{}`. a latent day's outline carries its page's
proposed fresh uuid and default title, and no occurrences. the `materialized`
envelope gates resource actions until acknowledgement.
an occurrence is `{connection, content}`; `connection.other` owns its displayed
identity. captured evidence always has `content.kind=resource`.

commands, applied in order in one serializable transaction:

| primitive | effect | idempotence / precondition |
|---|---|---|
| `set_body {note_id, body_pm_json, expected_version}` | absolute body | current == desired: no-op; else the version must match (409 `E_NOTE_CONFLICT`, `details.current` the note) |
| `set_title {page_id, title, expected_version}` | absolute title | same (409 `E_RESOURCE_CONFLICT`, `details.current {title, title_version}`) |
| `ensure_daily {local_date, page_id}` | proposed page and date binding | different live binding refuses with 409 `details.current_page_ref`; newly created days require their first link in the same batch |
| `insert_note {source, link_id, note_id, position, body_pm_json}` | create/reuse a note and link without overwriting its body | owned link id first; pair reuse never moves |
| `insert_link {source, link_id, target, position}` | materialize exact endpoints and link atomically | same; returns canonical endpoints |
| `move {endpoint, edge_id, after, expected_links_version}` | reorder any owned incident fact | only command in batch; already desired is a no-op, otherwise version must match |
| `unlink {link_id}` | remove the connection and preserve resources/annotation prose | absent succeeds |
| `relink {endpoint, link_id, destination, new_link_id, after, expected_source_links_version, expected_destination_links_version}` | guarded structural reparenting | minted new id first; otherwise both captured versions must match |
| `remove {endpoint, link_id, expected_body_version}` | structural removal; consume its note only without another retainer | a missing link or an already deleted note endpoint: no-op |
| `consume_note {endpoint, link_id, expected_body_version}` | join consumes the exact source note | another retainer or stale body refuses atomically |

relink and structural remove refuse a link that carries a link note (409).
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
  link, strikethrough, underline), code_block (text) or object_embed; a link href
  is `/`-relative (not `//`), http(s) with a host and no `%` in the authority, or a
  mailto without an authority.
- I3 every body create or write bumps the `body` lane, replaces the note's
  `note_body` embed edges and enqueues `note_reindex_job`.
- I4 creates take client ids: pages, notes, links (`edges.create_link(link_id)`).
- I6 a date has at most one page and a page at most one date; reading a day writes
  nothing.
- I7 a capture's blank text is 400 `E_EMPTY_NOTE_BODY`. the reader composer omits
  creation only for a canonical empty paragraph; other rich bodies save normally.
  an existing note can be saved empty without changing its identity or links.
- I8 structural retention counts every cross-owner graph fact and saved dossier
  head, including derived endpoints and captured historical owners.
  ordinary menu/cut/block unlink preserves user links' resources and annotation
  prose. machine rows use their shared connection menu outside structural history.
  a mixed selection containing a non-user edge or another removal capability
  refuses atomically. generic unlink retires dependent structural history and
  offers no undo; unrelated text history survives. guarded joins use
  `consume_note`; user empty-body backspace and split inverses use structural
  `remove`, with explicit body/sharing/annotation checks.
  `delete note everywhere` remains explicit global destruction.
- I9 a missing version row reads as 1; the first write creates it.

## publication and weekly retention

page creation accepts one closed initial item: a rich note with client note/link
ids, or a resource/passage link target with its client link id. the initial note
must not be a canonical blank paragraph. page, optional note/passage anchor and
first link publish in one serializable transaction. an owned page-id retry returns
current state before resolving the initial target again; failed publication leaves
none of its new rows. unknown old create retries may recreate physically deleted
ids; there are no permanent identity tombstones.

`resource_graph/retention.py` owns canonical blankness, complete retention, owner
pins and activity touches. only paragraphs with no children, attributes or marks
are blank; omitted and empty containers are equivalent. whitespace, breaks, empty
code blocks, images and embeds remain content. cross-owner persisted graph
relationships in either direction and saved dossier heads retain their subjects.
reads, folding, no-op retries and semantically equivalent indexing do not renew
grace. real text/title edits, saved order changes and retaining-reference changes
touch `last_activity_at` after pinning, without changing collection ordering.

`services/empty_resource_cleanup.py` runs weekly through the existing background
registry. page eligibility is no retainer; notes additionally must be canonical
blank. both need seven days without activity. each run freezes a database cutoff;
each invocation inspects at most 100 refs in stable order. each short read-committed transaction
locks its claim and root, rechecks in a fresh statement, and checkpoints every
inspection with its cursor and counters. continuation resumes the same cutoff.
canonical teardown owns graph, binding, dossier, anchor, index and protocol
state; it never commits inside the sweep. queued or running index/discovery jobs
may outlive the resource. their handlers recheck the live root and cannot recreate
it; ordinary background pruning owns terminal job history.

`nexus cleanup-empty-resources --preview` emits at most 100 eligible, content-free
entries bound to database name/system identifier, schema revision, runtime source
sha and cutoff. each entry records owner, activity, versions and dependent counts.
`--apply <inventory>` locks the whole reviewed set and validates all surviving
entries before deleting any, in one transaction. drift refuses the batch; absent
ids have landed. `truncated: true` means apply this batch and preview again.

## writing in the browser (online only)

the editor composes the [shared resource row and recursive list](resource-references.md).
one arranged list interleaves all direct facts. the shared projection omits
traversed facts; distinct ancestor references remain terminal. selection, copy,
navigation and joins consume those same visible rows. every owned incident fact
may move; visible sibling positions translate to canonical link-order anchors.
structural note operations and removal retain explicit capabilities.

generic graph/embed focus suspends the surrounding outline's editing, insertion
and structural commands until return. notes-owned zoom remains editable and seeds
ancestry from its resolved endpoint; historical paths retain editing and fold
identity. ancestor returns reveal within the current root. editable bodies are
never preview-clamped. note embeds render their batched `embedded_item` with the
same row; the containing note retains its own identity. `NoteEditor` receives an
explicit nullable acknowledged note ref and shares its branch context with embeds;
an editor key or client-minted draft id supplies no read authority.

source inspection decorates acknowledged canonical text without changing the
editor selection or history. the resolved body version and displayed projection
must match; a differing draft makes location unavailable until reopened against
compatible text. confirmed deletion fences old writes and invalidates affected
undo entries. dirty title/rich body remains visible and read-only for copying.

- `texts`: one in-memory text per note body or page title, shared by every editor
  showing it. a change saves 1.5 s after the last one, at once when the tab hides
  (`visibilitychange`, `pagehide`), on a title's blur, and as part of a structure
  edit that carries it. a server value never replaces local changes or moves the
  version they were based on, so their save 409s; a 409 parks the server's value
  until the user keeps theirs or takes the saved one. any other refusal marks the
  text failure beside each visible editor until its next acknowledgement. the
  text owner retains request identity; shared `FeedbackNotice` presents it, and
  retrying uses quiet shared status. there is no global text-failure callback. body and title saves publish "Notes".
  `beforeunload` warns while any text is unsaved or any write is queued. nothing is
  persisted: a tab that dies offline loses its unsaved text.
- `writes`: one FIFO per tab, one request in flight, each request built once at the
  head and resent unchanged until it gets an answer; network failures, 429 and
  502/503/504 retry with backoff (1 s doubling to 30 s, sooner online or visible);
  modeled transactional rejections permit correction. `fail` is terminal: an
  unsent build failure or a definitive transactional rejection. `retrying` keeps
  the job and its promise pending. unmodeled replies and malformed transport
  responses surface as defects and retain the sealed request for an explicit
  retry after repair; visible writing status offers that same-request retry.
  a write must return an acknowledgement before it releases the queue; response
  bodies use their generated wire contract without another decoder. callback
  defects cannot resend accepted writes or
  strand the queue. causal version advancement requires an acknowledged predecessor proof;
  a newer read never rebases captured placement. requests go with `keepalive` under 60,000 body bytes
  (UTF-8; fetch's quota is 64 KiB), larger ones without.
- `useOutline`: the tab-wide outline graph and one pane's view and undo history
  (text items from the row editors and structure items, interleaved). a structure
  edit applies at once and records its inverse; undo sends the inverse. a refused
  write cancels the dependent structure writes, retains their latest drafts in
  visit-owned recovery state and reloads the outlines. unrelated text history
  survives. a reply's `deleted` or an acknowledged global note deletion
  stops the removed note's text saving. global deletion removes loaded placements,
  rejects older reads and clears histories that could recreate that note.
  `useResourceOutline` owns root and branch reads, paging, failure and retry through
  `usePagePrefix` and the existing server-value primitive. the notes graph retains
  the derived editing projection and pending overlays. notes/metadata invalidation
  refreshes read owners; text adoption preserves dirty drafts. supplied branches
  reuse their owner's first page until invalidated; a supplied daily outline then
  refreshes through the graph read owner. only accepted daily envelopes update the
  editing projection or latent draft. an unmaterialized day remains owned by its
  daily read; its future page id grants no graph read authority. a cursor conflict
  discards continuations and starts page one. partial lists cannot authorize an
  unknown end or structural destination. recoverable reload failure retains the editor; absence, lost
  access and stale wire block editing.
- `/pages/new` is a visit-owned title and first-item draft. title edits, focus,
  blur and leaving do not publish. the first real rich note uses the existing
  1.5-second delay; selecting a resource/passage admits at once. admission freezes
  ids/body, then successor edits enter the shared text owner before route handoff.
  blank titles become `untitled`; no blank note is manufactured for publication.
- a latent day shows one draft row; its first real body or structural insertion
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

creation controls name an exact occurrence: row `+` inserts after that row under
the same endpoint; root-note `+` appends to that note's own outline. an empty
loaded page has one invitation; populated pages have no creation footer. filters,
unknown placements and unavailable reads cannot authorize insertion. a latent
day's explicit sibling creation persists its original visible draft;
materialization stays outside the added sibling's undo history. queued creation
uses the existing pending text/projection identity until acknowledgement.
an empty zoomed latent note links from its own identity: the existing day/draft
materialization precedes its reference in one atomic batch, outside reference undo.

a definitively refused structural batch keeps its latest writing in visit-owned
recovery state before replacing the optimistic projection. retry preserves the
original source, predecessor and atomic edit sequence, requires reviewed current
placement and body preconditions, and never guesses an append position. missing
anchors or conflicting bodies keep the draft copyable while retry is disabled.

## explicit passage notes

`SelectionDock` reuses `NoteEditor` with local `selectionDrafts` and `bodyHistory`;
it does not enroll the draft in `texts` or autosave on blur. enter saves,
shift-enter inserts the existing newline, and command/control-enter sends a new
quoted chat without changing the saved note. bodies use `NoteBody`'s canonical
`body_pm_json`/`body_text`; edits and focus use `NoteEdit`/`FocusSelection`.
composition and nested controls keep their own keys. caret, rich body and undo
history survive reader body unmounts in the existing pane visit, not reload.

an empty resource-owned composer accepts typed `@` through the shared reference
controller before persistence. mutable draft cells belong to the exact visit,
route and editor; delayed acknowledgements settle their original cell, including
after unmount/remount. search text never enters canonical prose or an
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
selection linking materializes
the exact highlight and target in the same transaction, checking the frozen
reader publication generation for text and pdf; search alone creates
nothing. every outer save/chat/structural control is gated during search.
relationship-annotation composers keep `@` literal. create-reference undo removes
only its exact link; redo uses the returned durable endpoints and original slot.

highlight-note creation freezes the observed viewer attachment slot's
`links_version` in `expected: {kind: "absent", version}`. the same attached id
answers unchanged; a changed slot conflicts. updates use
`expected: {kind: "version", version: body_version}` against the exact attachment.
`AnnotationNoteEditor` also reads that slot before binding its first creator;
its other surfaces retain normal autosave and link-note creation is unchanged.

fresh backspace on an already empty paragraph (or `delete empty note`) uses the
explicit global delete command, not outline remove or annotation detach. it
checks the exact attachment and body version, then calls canonical note teardown
in one transaction. live references, derived rows and their view state are
removed. ordinal citations may retain captured evidence after derived targets
retire; those snapshots never recreate their owner. highlight, connected resources
and stored chat text remain. there
is no new undo service. acknowledgement marks the shared text gone, announces
`resource_deleted` and uses `settleDeletedResourcePanes` for visible note panes.

these commands use the tab's online write queue and its exact in-flight retries.
there is no browser journal or reload recovery. a committed highlight may remain
after note save or chat refusal; uncertain chat retains its exact sender in the
reader visit while the tab lives. [highlight](highlight.md) owns the full
selection interaction; [chat](chat.md) owns admission and immutable quotes.
