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
| `GET /notes/blocks/{id}` → `{id, body_pm_json, body_text, body_version}` | read |
| `GET /notes/outline/{ref}` → `{source, links[{link_id, has_link_note, target}]}` | read |
| `POST /notes/outline/commands {commands}` → `{outlines, nodes, deleted}` | every primitive idempotent |
| `PUT /highlights/{id}/note`, `PUT /resource-graph/links/{id}/note {note_id, body_pm_json}` | that note attached has landed; another: 409 |
| `DELETE …/note/{note_id}` → 204 | idempotent; the note stays |

an outline node is `{ref, label, summary, missing, activation, content}`, content
`page{title, title_version, daily_date}` | `note{body_pm_json, body_text,
body_version, places}` | `resource{}`. a latent day's outline carries its page's
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
  offset basis of passage anchors and pulses.
- I2 a body is one paragraph (text, hard_break, image; marks strong, em, code,
  link, strikethrough, underline), code_block (text) or object_embed; a link href
  is `/`-relative (not `//`), http(s) with a host and no `%` in the authority, or a
  mailto without an authority.
- I3 every body create or write bumps the `body` lane, replaces the note's
  `note_body` embed edges and enqueues `note_reindex_job`.
- I4 creates take client ids: pages, notes, links (`edges.create_link(link_id)`).
- I6 a date has at most one page and a page at most one date; reading a day writes
  nothing.
- I7 a capture's blank text is 400 `E_EMPTY_NOTE_BODY`; an empty new annotation is
  never sent.
- I8, the place rule: a note's places are its user links, annotations, link notes
  and citations. an outline `remove` (Backspace on an empty row, a join, undo of an
  insert) deletes the note it leaves with no place. links are undirected, so
  "nothing holds it" is a degree test, and only outline edits, which can be undone,
  delete. page delete and "Remove annotation" keep notes. join is refused when the
  later note has another place or its link carries a note, so a join always
  deletes the later note. a batch removes deepest rows first, so a parent removed
  with its child is deleted too.
- I9 a missing version row reads as 1; the first write creates it.

## writing in the browser (online only)

- `texts`: one in-memory text per note body or page title, shared by every editor
  showing it. a change saves 1.5 s after the last one, at once when the tab hides
  (`visibilitychange`, `pagehide`), on a title's blur, and as part of a structure
  edit that carries it. a server value never replaces local changes or moves the
  version they were based on, so their save 409s; a 409 parks the server's value
  until the user keeps theirs or takes the saved one. any other refusal marks the
  text failure beside each visible editor until its next acknowledgement. the
  text owner retains request identity; shared `FeedbackNotice` presents it, and
  retrying uses quiet shared status. there is no global text-failure callback. a title save publishes "Notes".
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
  history and says so. only a reply's `deleted` stops a removed note's text saving.
  pane-entry reads, explicit reloads and observed structure refusals use
  `usePaneFreeServerValue`, including its bounded three-attempt get policy,
  same-key failure retention during retry and
  key-change fencing. recoverable reload failure stays beside the retained editor;
  absence, lost access and stale wire block editing, with app reload for stale wire.
  the graph and write queue keep their existing ownership and recovery ordering.
- a latent day shows one draft row; its first non-empty save sends `ensure_daily`
  and its insert. panes take the entries `EditPageTitle`, `EditNoteBody`,
  `AppendNote` and `FocusNote`; the launcher's quick note is one capture, then the
  day opened at that note.
