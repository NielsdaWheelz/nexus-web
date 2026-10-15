# selection composer

status: implementation contract · 2026-10-15. main’s online-only notes contract
supersedes the earlier reload-recovery design, by explicit owner decision.
[qualification](selection-composer-verification.md) records observations and limits.

## goal and scope

one passage, one immediately usable composer. show every applicable action in
the first row and the canonical rich note editor directly below. remove the
selection “more” menu, quick-note popup/sheet and creation-on-open path. reuse
main’s editor, write queue, actions, pane-entry delivery and graph teardown.
no alternate writer, replay ledger, compatibility endpoint or feature flag.

text and pdf share the interaction. chat-answer selection is outside this change.
no general draft system, offline mode, new undo service, editor redesign, schema
migration, provider/runtime provisioning or physical-device infrastructure.

## product contract

- completed desktop mouse/keyboard selection opens and focuses the editor without
  a debounce. the first typed character lands there. focus must not scroll source.
- touch keeps native selection handles until the user taps the editor. typing is
  immediate after that tap; do not force the software keyboard during selection.
- capture the passage before moving focus. editor selection never becomes a new
  reader selection. suppress the selection-completing click, not subsequent clicks.
- fresh opening and typing perform no writes. show all five highlight colours and
  applicable canonical actions; wrapping is preferable to hiding commands.
- enter saves. shift+enter retains the editor’s existing newline/code behaviour.
  command/control+enter starts a new quoted chat. visible buttons do the same.
  composing keys and escape obey the editor’s native guards.
- fresh empty enter ensures one yellow highlight and creates no note. fresh rich
  content creates one highlight and note. exact-extent reuse preserves an existing
  highlight’s colour, identity and note. colour selection is an explicit update.
- saved mark activation shows the shell immediately, then “loading your note…”.
  fetch the viewer’s zero/one linked note; prefill its complete rich body and focus
  only if this opening still owns focus. never enable a misleading blank editor.
- enter on an existing note updates that same id using its saved body version.
  clearing and enter saves that same note empty and retains every link.
- a fresh unmodified, nonrepeating backspace, with an empty paragraph already at
  the start of the event and a collapsed caret at its start, deletes the note
  globally. deleting the final character, selections, held repeats, composition,
  code, hard breaks, images and embeds never qualify. a visible “delete empty note”
  button uses the identical command. the highlight remains.
- deletion removes every incoming/outgoing association, historical citation and
  note view state atomically. old chat text and other resources remain; surviving
  citation ordinals do not change. deletion has no new undo facility.
- chat uses canonical plain-text projection, trimmed, plus the canonical quote
  preview key/revision and captured model selection. it never saves note edits.
  blank chat opens the quoted composer without starting a run. nonblank chat sends
  the prompt directly as the first user message. ordinary new-chat drafts survive.
- opening chat retains the reader’s rich draft, caret and undo history for return,
  including mobile reader-body unmount. drafts are scoped to the reader visit.
- late completion for passage a cannot close, focus or navigate passage b, even
  when both openings refer to the same draft. completion may update a’s own state.
  show an explicit open-chat action if navigation ownership has been lost.
  respect the workspace pane cap: a rejected fork keeps the composer and reports
  the limit. retry opening an accepted chat without submitting another message.

## ownership and state

`selectionDrafts.ts` owns visit-local draft records: passage/alias, authoritative
note base (`Absent | Present{id,version,body}`), rich body, revision, selection,
local history, load state, one pending command, issue and status. hidden retries
retain exact chat send closures. popup/editor mounts only subscribe. retain this
store through pane visit memory, never browser storage or shared autosave texts.

`useSelectionComposer` owns composition. opening identity, focus ownership and
draft revision are separate facts. freeze target, body, command id, model and
opening at submission. alias an ensured highlight immediately. match a reopening
by highlight id, then exact passage, so a cold-map draft cannot be orphaned.

load responses may install state only into the draft/revision/operation/issue
that requested them. dirty alias discovery requires explicit saved-note review.
conflicts offer “use saved note” or “save my draft instead”; neither may clear a
newer command. later typing remains local and is never retired by an older save.

`NoteEditor` owns rich editing and native key interpretation. use its canonical
schema and body projection, focus selection, `NoteEdit`, and shared body-history
grouping. reader drafts have explicit save callbacks and do not call autosave.

`lib/notes/writes.ts` owns one online FIFO. requests build once at the head and
retry identical bytes for network failure, 429, 502, 503 and 504; main treats other
responses, including 500, as definitive. committed acknowledgements update local
state synchronously in `settle`, before the next job builds. refresh failure must
not erase a known successful save/delete or allocate a new note identity.

reader chat uses `createReaderChatSend`: one frozen key and serialized request,
coalesced concurrent sends, cached accepted/rejected/definite-refusal outcome.
uncertain throws retain that sender for explicit exact retry. retries survive
reader-body unmount, not tab closure. do not invent a second chat transport.

on committed global deletion: stop shared note writes, publish the existing
graph-deletion fact, then settle note panes through main’s canonical owner.
quote, conversation, outline and highlight read admission reject deleted refs,
including delayed reads. outline removes deleted targets and invalidates affected
history; queued structure edits cannot recreate a globally deleted note. ordinary
outline remove/undo remains undoable. no per-surface tombstone protocol.

## api and storage contract

all routes use generated snake-case wire types, ordinary viewer authorization
and main’s matched web/api wire revision. no handwritten response decoder.

| request | success and precondition |
|---|---|
| `POST /media/{id}/highlights {anchor,color}` | `{created,highlight}`; converge on viewer’s exact extent; existing colour/note unchanged |
| `GET /highlights/{id}` | rich viewer note plus required `links_version` |
| `PUT /highlights/{id}/note {note_id,body_pm_json,expected}` | canonical linked note body and version |
| `POST /highlights/{id}/note/delete {note_id,expected_version}` | `{deleted_note_id}`; absent note is already successful |
| `PATCH /highlights/{id} {color}` | canonical updated highlight |

`expected` is `{kind:"absent",version:highlight.links_version}` for initial note
creation, or `{kind:"version",version:note.body_version}` for existing saves.
the version arm requires this viewer’s exact current attachment. a stale body or
slot, changed attachment, or inaccessible target refuses without changing data.
initial creation with the same already-attached client note id returns its current
body unchanged; a different note requires review. never overwrite it implicitly.

use canonical note-body writes and graph teardown. note body and body version
must be read together in one database statement. extent creation serializes at
the canonical text/pdf parent boundary and reuses the existing extent, including
mixed transaction isolation. no duplicate-extent precheck outside that boundary.

highlight slot versions use existing resource-version lanes, initially one.
create, detach and global deletion bump affected highlight slots. global deletion
bumps ALL affected slots, preventing a late initial create from resurrecting the
note. teardown removes historical citations too. no ledger or schema migration.

logical idempotence replaces historical response receipts: exact retries converge
on current state. a retried ensure after intervening highlight deletion may make a
new highlight. a stale note-create expectation refuses after create/delete. keep a
successfully ensured highlight after downstream save/chat refusal; no rollback.

## nonoverlapping implementation boundaries

`web` = `apps/web/src`; `media` = `web/app/(authenticated)/media/[id]`.
changes crossing an ownership row require an explicit handoff.

| owner | exclusive responsibility / principal files |
|---|---|
| reader / interaction designer | `lib/documentReader/{DocumentReader,runtime,selection,text/*,pdf/*}`, floating surface and anchored positioning: capture, hit testing, live geometry |
| editor / content designer | `components/notes/NoteEditor`, `lib/notes/bodyHistory`: canonical schema, input semantics, history and focus |
| persistence / destructive-action designer | python highlight routes/schemas/services, canonical note bodies and graph cleanup; generated wire: transactional preconditions, extent reuse, global teardown |
| chat / conversation designer | `lib/chat/{drafts,readerIntent}`, quote card and conversation store: frozen admission, quote provenance, deleted-citation admission |
| composition / interaction designer | media composer/store/dock/verbs/annotations/evidence host, pane visit memory, graph deletion facts, main outline owner: product orchestration and consumer coherence |
| verifier / independent reviewer | temporary external proof drivers, qualification receipts, module docs and resolved tickets: observed behaviour and adversarial gate |

content designers use existing schemas. interaction copy is terse, lowercase and
names the action/result: “save note”, “new chat”, “note saved.”, “your draft is
kept.” errors distinguish load, conflict, uncertain send and acknowledged change
with failed refresh. destructive copy states note + links deleted, highlight kept.
editor fixtures contain formatting, links, unicode, hard breaks, code/image/embed
and structurally empty cases. conversation fixtures include a real quote and
numbered citations; generated wording is never an oracle. no new content system.

## acceptance and verification

use temporary browser → bff → api → isolated database checks. production stays
read-only. no successful provider stubs or test-only product seams. demonstrate
red behaviour, implement, get green, refactor, rerun affected cases, delete the
drivers. `./scripts/test` remains the sole permanent automated static gate.

| family | observable acceptance |
|---|---|
| selection | text/pdf immediate first character; zero writes before commitment; all actions visible; one yellow highlight/note as appropriate; native selection extension remains usable |
| rich note | delayed prefill respects focus; same-id save; rich round-trip/newline/undo; clear+enter keeps empty note and every link; blank-looking rich content never deletes |
| chat | prompt + canonical quote, annotation unchanged, blank opens without run, ordinary draft unchanged, mobile return restores rich body/caret, exact uncertain retry while tab lives |
| ordering | repeated submit coalesces; cold-map reopening retains draft; held a cannot disturb b; stale conflict reads cannot overwrite newer saves; failed post-ack refresh cannot lose acknowledged state |
| deletion | fresh empty backspace removes all associations/citations/view state; other resources/text/ordinals survive; stale body/attachment/create refuses; delayed reads, autosave and undo cannot resurrect |
| geometry | scroll/reflow/pdf zoom/keyboard viewport keep surface in its source pane; editor focus/source return do not scroll; overlap chooser targets the chosen mark |

inspect committed rows for destructive cases. qualify desktop focus/newline in
chromium, firefox and webkit; device selection/keyboard/ime needs actual devices.
real nonblank model admission/provenance/terminal delivery requires a functioning
local generation runtime. record unavailable checks explicitly, never as passes.
record exact source identity, schema/wire and actual receipts before removing
harnesses/fixtures. do not expand testing after concrete remaining concerns settle.

## explicit costs

visible commands wrap and use height. authoritative prefill adds a read delay.
touch needs an editor tap. rich editing costs more than a textarea. in-flight
online queue work can delay other notes; tab closure loses queued-command recovery
and visit drafts. chat’s tab-local exact retry does not imply durable recovery.
no historical mutation receipt is retained. a valid highlight may remain after a
later refusal. a coarse highlight links lane may conservatively conflict initial
note creation after an unrelated link change. parent extent fences add a row write
and serialize pdf highlight writes per media. global deletion is immediate,
permanent and removes unseen/historical links; affected outline undo history is
cleared. a refused queued structure write cancels the remaining structure tail
and reloads, following main’s existing refusal rule. at the pane cap a completed chat may need a pane closed before it can open.
matched web/api deployment is required. deleting temporary tests gives up
repeatable regression coverage. these costs are intentional.
