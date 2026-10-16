# notes

the user's own writing: titled pages, one-block notes, the neutral links that order
them into outlines, a page per day, notes on highlights and links, and quick capture
into today. python owners (under `python/nexus/`): `schemas/notes.py` (the body
grammar and every notes model), `services/note_bodies.py` (the note row),
`services/outline.py` (outlines and their commands), `services/notes.py` (pages, days,
capture, annotations), `api/routes/notes.py`. web (under `apps/web/src/`):
`lib/notes/` (`noteBody`, `outline`, `useOutline`, `texts`, `writes`, `api`) and
`components/notes/`.

## contract

| route | retry rule |
|---|---|
| `GET /notes/pages?sort&direction&limit&cursor` (keyset, the chats index's views) | read |
| `POST /notes/pages {id, title}` → 201 summary | same owner: the page; another owner's id: 409 |
| `DELETE /notes/pages/{id}` → 204 | idempotent; the page's notes stay |
| `GET /notes/daily/{date}` → `{local_date, materialized, outline}` | read; writes nothing |
| `POST /notes/daily/{date}/captures {note_id, text}` → `{page_id}` | an existing own note id has landed |
| `GET /notes/blocks/{id}` → `{id, body_pm_json, body_text, body_version, embedded_item}` | read; immediate embed projection is nullable and batched |
| `GET /notes/outline/{ref}` → `{source, links[{link_id, has_link_note, target}]}` | read |
| `POST /notes/outline/commands {commands}` → `{outlines, nodes, deleted}` | every primitive idempotent |
| `PUT /highlights/{id}/note {note_id, body_pm_json, expected}` | absent: loaded highlight `links_version`; version: exact attachment and note `body_version` |
| `PUT /resource-graph/links/{id}/note {note_id, body_pm_json}` | that note attached has landed; another: 409 |
| `DELETE …/note/{note_id}` → 204 | idempotent; the note stays |
| `POST /highlights/{id}/note/delete {note_id, expected_version}` → `{deleted_note_id}` | exact attached note/body version; an already absent note stays absent |

an outline node is `{item, content}`, where `item` is the shared
`ResourceItemOut`; content is
`page{title, title_version, daily_date}` | `note{body_pm_json, body_text,
body_version, places, embedded_item}` | `resource{}`. a latent day's outline carries its page's
future id (`uuid5` of viewer and date) and default title, and no links.

commands, applied in order in one serializable transaction:

| primitive | effect | idempotence / precondition |
|---|---|---|
| `set_body {note_id, body_pm_json, expected_version}` | absolute body | current == desired: no-op; else the version must match (409 `E_NOTE_CONFLICT`, `details.current` the note) |
| `set_title {page_id, title, expected_version}` | absolute title | same (409 `E_RESOURCE_CONFLICT`, `details.current {title, title_version}`) |
| `ensure_daily {local_date}` | the day's page and binding | idempotent |
| `insert_note {endpoint, link_id, note_id, after, body_pm_json}` | the note (an own existing one is reused), linked after `after` (null: first) | `link_id` at the endpoint: no-op |
| `insert_resource {endpoint, link_id, target, after}` | link a direct-link resource | same; the pair already linked: 409 |
| `move {endpoint, link_id, after}` | reorder | absolute |
| `relink {endpoint, link_id, destination, new_link_id, after}` | move the link's target to another endpoint | `new_link_id` at the destination: no-op |
| `remove {endpoint, link_id, expected_body_version}` | delete the link; the place rule (the reply's `deleted` names the notes it deleted) | a missing link or an already deleted note endpoint: no-op |

relink and remove refuse a link that carries a link note (409). a position not in
the outline, a self-link or an endpoint that is not a page or note is 400.

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
- I8, the place rule: a note's places are its user links, annotations, link notes
  and citations. an outline `remove` (Backspace on an empty row, a join, undo of an
  insert) deletes the note it leaves with no place. links are undirected, so
  "nothing holds it" is a degree test. this rule belongs to outline edits, whose
  undo can recreate a removed note; explicit global deletion from the passage
  composer removes every place. page delete and "Remove annotation" keep notes.
  join is refused when the
  later note has another place or its link carries a note, so a join always
  deletes the later note. a batch removes deepest rows first, so a parent removed
  with its child is deleted too.
- I9 a missing version row reads as 1; the first write creates it.

## writing in the browser (online only)

the editor composes the [shared resource row and recursive list](resource-references.md).
its ordered placements precede other direct relationships; duplicate edge ids are
removed. graph-only descendants stay outside structural selection, drag, joining,
deletion and undo. editable bodies are never preview-clamped. note embeds render
their batched `embedded_item` with the same row; the containing note retains its
own identity and stored-label preview elsewhere.

source inspection decorates acknowledged canonical text without changing the
editor selection or history. the resolved body version and displayed projection
must match; a differing draft makes location unavailable until reopened against
compatible text. deletion still invalidates shared drafts and undo entries.

- `texts`: one in-memory text per note body or page title, shared by every editor
  showing it. a change saves 1.5 s after the last one, at once when the tab hides
  (`visibilitychange`, `pagehide`), on a title's blur, and as part of a structure
  edit that carries it. a server value never replaces local changes or moves the
  version they were based on, so their save 409s; a 409 parks the server's value
  until the user keeps theirs or takes the saved one. any other refusal marks the
  text "Not saved" until its next save. body and title saves publish "Notes".
  `beforeunload` warns while any text is unsaved or any write is queued. nothing is
  persisted: a tab that dies offline loses its unsaved text.
- `writes`: one FIFO per tab, one request in flight, each request built once at the
  head and resent unchanged until it gets an answer; network failures, 429 and
  502/503/504 retry with backoff (1 s doubling to 30 s, sooner online or visible);
  any other answer is final. requests go with `keepalive` under 60,000 body bytes
  (UTF-8; fetch's quota is 64 KiB), larger ones without.
- `useOutline`: the tab-wide outline graph and one pane's view and undo history
  (text items from the row editors and structure items, interleaved). a structure
  edit applies at once and records its inverse; undo sends the inverse. a refused
  write cancels the structure writes queued after it, reloads the outlines, resets
  the texts they carried to their acked values without saving them, clears undo
  history and says so. a reply's `deleted` or an acknowledged global note deletion
  stops the removed note's text saving. global deletion removes loaded placements,
  rejects older reads and clears histories that could recreate that note.
  notes/metadata invalidation refreshes the root, zoom owner and open branch owners;
  text adoption preserves dirty drafts. invalidation during an owner read retains
  one follow-up read, so an older response cannot be the final preview.
- a latent day shows one draft row; its first non-empty save sends `ensure_daily`
  and its insert. panes take the entries `EditPageTitle`, `EditNoteBody`,
  `AppendNote` and `FocusNote`; the launcher's quick note is one capture, then the
  day opened at that note.

## explicit passage notes

`SelectionDock` reuses `NoteEditor` with local `selectionDrafts` and `bodyHistory`;
it does not enroll the draft in `texts` or autosave on blur. enter saves,
shift-enter inserts the existing newline, and command/control-enter sends a new
quoted chat without changing the saved note. bodies use `NoteBody`'s canonical
`body_pm_json`/`body_text`; edits and focus use `NoteEdit`/`FocusSelection`.
composition and nested controls keep their own keys. caret, rich body and undo
history survive reader body unmounts in the existing pane visit, not reload.

highlight-note creation freezes the observed viewer attachment slot's
`links_version` in `expected: {kind: "absent", version}`. the same attached id
answers unchanged; a changed slot conflicts. updates use
`expected: {kind: "version", version: body_version}` against the exact attachment.
`AnnotationNoteEditor` also reads that slot before binding its first creator;
its other surfaces retain normal autosave and link-note creation is unchanged.

fresh backspace on an already empty paragraph (or `delete empty note`) uses the
explicit global delete command, not outline remove or annotation detach. it
checks the exact attachment and body version, then calls canonical note teardown
in one transaction. every edge, historical citation and associated view state
is removed; highlight, connected resources and stored chat text remain. there
is no new undo service. acknowledgement marks the shared text gone, announces
`resource_deleted` and uses `settleDeletedResourcePanes` for visible note panes.

these commands use the tab's online write queue and its exact in-flight retries.
there is no browser journal or reload recovery. a committed highlight may remain
after note save or chat refusal; uncertain chat retains its exact sender in the
reader visit while the tab lives. [highlight](highlight.md) owns the full
selection interaction; [chat](chat.md) owns admission and immutable quotes.
