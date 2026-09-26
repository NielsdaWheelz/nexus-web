# notes writing: current implementation audit

status: static research; no product changes or runtime qualification
date: 2026-09-25
baseline: `main`, `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`

the worktree was clean at the audit's first read. later documentation changes
belong to this research and concurrent work; this pass did not alter them.
repository rules and the local verification standard were read. relevant
memory searches returned no notes-editor history; findings below use current
source. no application, database, browser, phone, or production checks ran.

the latest brief covers writing and saving across notes, annotations, link
notes and quick capture. it excludes product navigation, offline support and
complete apple/roam feature catalogues. browser draft recovery belongs to the
save contract; an offline application does not follow from that requirement.

## the central constraint

[`architecture.md:1567`](../architecture.md#87-notes-and-pages) explicitly
defines pages and notes as flat resource surfaces, not documents or trees.
pages own titles; note blocks own one prose body; ordered graph edges own
occurrences. each visible note has an independent prose editor and history.
hierarchy, collapse, cross-note merge and full-list replacement are explicitly
absent at lines 1611–1616. their absence is intentional, not a discovered bug.

therefore the roam request changes a domain contract. bullet styling and key
bindings cannot supply the missing containment, selection and history model.
apple's writing behavior also crosses the present per-note editor boundary:
selecting, replacing, pasting and undoing across rows needs one coherent owner.

## owner map

all paths below are relative to the repository root; line references describe
the baseline above.

| concern | current owner and evidence |
| --- | --- |
| page and standalone note hosts | `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx:117`; `apps/web/src/app/(authenticated)/notes/[blockId]/NotePaneBody.tsx:227` |
| surface loading, title/body host, recovery ui | `apps/web/src/components/resource-surface/ResourceSurfaceEditor.tsx:205,378,698,755` |
| flat occurrence rendering and row actions | `apps/web/src/components/resource-surface/ResourceSurfaceBodyEditor.tsx:220-447` |
| prose view, selection, composition, paste and keys | `apps/web/src/components/notes/NoteBodyEditor.tsx:142,551-755` |
| prose schema and text projection | `apps/web/src/lib/notes/prosemirror/schema.ts:15-206`; `noteBodyProjection.ts` in the same directory |
| prose history keymap and body split calculation | `apps/web/src/lib/notes/prosemirror/commands.ts:40-80` |
| surface optimistic edits, save queues and recovery | `apps/web/src/lib/resourceSurface/useResourceSurfaceSession.ts:73-953`; `model.ts:430-495`; `draftStore.ts:52-162` |
| highlight/annotation body and save session | `apps/web/src/components/notes/HighlightNoteEditor.tsx:138-460`; `apps/web/src/lib/notes/useNoteEditorSession.ts:47-339` |
| desktop popup/mobile annotation sheet | `apps/web/src/components/highlights/HighlightQuickNoteComposer.tsx:47-165` |
| reader highlight and link-note adapters | `apps/web/src/components/reader/document-map/EvidenceItemRow.tsx:258-306`; `apps/web/src/lib/resourceGraph/links.ts:131-143` |
| mobile daily input handoff | `apps/web/src/components/switchboard/MobileQuickNoteHandoff.tsx:104-175,367-401`; `apps/web/src/lib/notes/dailyDraftStore.ts` |
| surface server reads and structural commands | `python/nexus/services/resource_items/surfaces.py:59-154,161-263` |
| body/title mutations and replay/version checks | `python/nexus/services/resource_items/mutations.py:28-171`; `python/nexus/services/resource_mutation_replay.py:41-94` |
| body persistence, graph references and indexing | `python/nexus/services/note_bodies.py:109-149`; `python/nexus/services/note_indexing.py` |
| ordered occurrence edges and view state | `python/nexus/services/resource_graph/adjacency.py:112-263` |
| existing nested graph consumers | `python/nexus/services/vault.py:775-824`; `python/nexus/services/artifacts/subjects.py:527-546` |

## what the editor actually supports

the installed application declares prosemirror model, state, view, history and
keymap dependencies (`apps/web/package.json:24-28`). replacing the engine or
adding a wrapper framework has no demonstrated benefit for this request.

the schema permits exactly one body block: paragraph, code block or atomic
object embed. paragraphs permit text, hard breaks, object references and
images. marks are bold, italic, inline code, link and strikethrough
(`schema.ts:15-206`). headings, underline, checklist and table nodes are not
present. server validation has the matching closed vocabulary
(`python/nexus/schemas/resource_items.py:27-64`). schema support for marks does
not establish a complete user-facing formatting command or toolbar.

each occurrence mounts `NoteBodyEditor` keyed by resource identity
(`ResourceSurfaceBodyEditor.tsx:238-311`). each view installs its own
`history()` (`NoteBodyEditor.tsx:551-560`). the registered keymap handles enter,
shift-enter and undo/redo only (`commands.ts:70-80`); surrounding dom handlers
also handle reference selection, row movement, empty removal and splitting.

enter currently has three meanings:

- a page occurrence calls the structural split callback; shift-enter inserts
  a hard break (`NoteBodyEditor.tsx:708-718`). split requires an empty text
  selection in a paragraph (`commands.ts:40-67`).
- a standalone note body inserts a hard break. code bodies insert a newline.
- a quick annotation supplies `onSubmit`, so enter flushes and eventually
  closes the composer (`HighlightNoteEditor.tsx:291-295,391-395`;
  `HighlightQuickNoteComposer.tsx:142,160`).

these are existing product policies. the new spec should deliberately choose
where they converge. plain enter should not accidentally become a save button
just because the same text is hosted in a small sheet.

alt-up/down reorder flat rows. backspace at an empty row's start removes its
occurrence and focuses an earlier note. no domain command exists for indent,
outdent, merge, subtree move or structural undo (`model.ts:19-43`). returning
an externally changed body creates a fresh editor state, retaining the plugin
definitions but resetting their state (`NoteBodyEditor.tsx:306-321`). a split
therefore cannot be represented by the current prose-only history owner.

the editor guards key handling during composition (`NoteBodyEditor.tsx:621-623`).
that is valuable but not proof of iphone dictation, autocorrect, native
selection handles, context-menu formatting or composing-keyboard correctness.
those require real device observations, including edits arriving through input
events rather than keydown.

file paste/drop accepts one attachment into an empty or fully selected body;
upload disables editing while it runs (`NoteBodyEditor.tsx:425-479`). a sole url
pasted there becomes an imported attachment (`:601-619`). the clipboard spec
must preserve or explicitly replace those semantics, not accidentally inherit
them from a new editor package.

the current visual surface has a minimum 44px row, an 88px reserved action
gutter and two row-action menus. menus become continuously visible on devices
without hover (`ResourceSurfaceBodyEditor.module.css:35-42,93-109,161-165`).
the list suppresses markers entirely (`:12-16`). these are concrete starting
points for reducing chrome; no screenshot comparison or timing was recorded.

## saving and the important defects

surface saves debounce at 1500ms with a 5000ms maximum wait
(`useResourceSurfaceSession.ts:39-40,473`). local pending state is stored on
each edit. commands and body/title saves have separate activity tracking;
the server uses versioned lanes and exact durable replay. structural commands
run through one serializable transaction (`surfaces.py:88-154`). these are
useful foundations to retain, not reasons to replace the backend wholesale.

highlight notes instead use `useNoteEditorSession`, with its own sequences,
pending/queued bodies, local draft format and the same debounce intervals.
both owners attempt lifecycle flushing. lifecycle requests are opportunities
to finish work, not evidence a browser waited for an acknowledgement.

the concrete findings are recorded individually:

| finding | exact mechanism | record |
| --- | --- | --- |
| local saving claim can be false | `draftStore.ts:145-151` swallows failed writes; `ResourceSurfaceEditor.tsx:772-774` says changes are saved here | [durability feedback](../tickets/notes-local-save-feedback-can-overstate-durability.md) |
| an ambiguous save id can be reused for changed text | failure removes active tracking but keeps pending body; later editing reuses its id at `useResourceSurfaceSession.ts:691-699,725-732`; server rejects changed bytes at `resource_mutation_replay.py:64-68` | [mutation identity](../tickets/notes-retry-can-reuse-mutation-id-with-changed-content.md) |
| suggested recovery discards work | conflict copy at `ResourceSurfaceEditor.tsx:133-138` recommends reload; `useResourceSurfaceSession.ts:791-832` clears pending edits and retained draft | [reload loss](../tickets/notes-recovery-reload-discards-pending-edits.md) |
| failed draft decoding deletes the raw record | `draftStore.ts:63-80`, `noteEditorDraftStore.ts:29-53` and `dailyDraftStore.ts:46-61` remove undecodable payload | [raw recovery](../tickets/notes-draft-decoding-deletes-unrecoverable-payload.md) |
| a never-saved annotation draft is not rediscovered | `HighlightNoteEditor.tsx:181-199` puts a new random child id in its key; `:298-318` reads only that key on remount | [annotation identity](../tickets/annotation-draft-key-changes-before-first-save.md) |
| link adapter drops the editor's replay id | `EvidenceItemRow.tsx:264-269` omits it; `links.ts:140` invents an id per network call | [link replay](../tickets/link-note-adapter-drops-editor-mutation-identity.md) |
| reopening link-note editing has no existing body input | `EvidenceItemRow.tsx:260-274` always passes `note={null}` | [link hydration](../tickets/link-note-editor-does-not-hydrate-existing-body.md) |
| typing does surface-sized synchronous work | `useResourceSurfaceSession.ts:706-707` publishes and stores; `model.ts:430-495` projects the list; `draftStore.ts:130-151` serializes the acknowledged surface and pending work | [measurement](../tickets/notes-keystroke-cost-needs-device-measurement.md) |

these are static mechanisms. no lost production text, retry failure or measured
jank was reproduced. maintain that distinction in both pr descriptions.

the save repair needs an immutable submitted request and separately retained
successor edits. an older acknowledgement must retire only its own revision.
recovery must preserve raw content, distinguish discard from refresh, and use
stable owning identities. share the mechanism needed by current consumers;
keep highlight attachment, link attachment and surface mutation rules in their
domain adapters. this does not require a crdt or an offline notes database.

## mobile and compact surfaces are real owners

the quick annotation composer already reuses the prose editor. it owns a
desktop selection-anchored popup and a mobile sheet, keeping its temporary
identity stable while highlight creation resolves (`HighlightQuickNoteComposer.tsx:93-124`).
preserve quote context and attachment identity while repairing draft lookup.

the daily mobile handoff focuses a textarea during the initiating gesture,
buffers text and selection, and records composition state
(`MobileQuickNoteHandoff.tsx:104-175,387-401`). the prose editor claims completed
handoff data only after composition becomes complete
(`NoteBodyEditor.tsx:267-304`). removing that adapter merely to claim one dom
element would risk the very keyboard continuity being requested.

one logical editing authority does not forbid a temporary platform adapter.
the handoff must be one-way and exactly claimed, without competing persistence
or a second long-lived text truth. device verification must include dismissal
during composition and continued typing during hydration.

## identity and containment decision

`NoteBlock` has body and owner fields, no parent (`models.py:233-259`). a
`ResourceEdge` has resource endpoints, order and identity
(`models.py:356-390`); its source is a resource, not another occurrence.
two pages may point to the same note. that note's outgoing adjacency is then
shared by identity. direct self-links and duplicate direct targets are rejected
(`adjacency.py:112-124`), but longer cycles are not excluded there.

existing nested graph data cannot be assumed absent. vault writes nested note
edges and collapse state (`vault.py:775-824`); artifacts recursively read them
(`artifacts/subjects.py:527-546`). traversal is cycle-bounded by a path set
(`adjacency.py:266-315`). the visible editor's flat contract does not erase
these other consumers.

canonical block containment is closest to roam, but an existing shared note
does not identify which page is its home. converting other appearances into
references changes unlink, deletion, zoom and child ownership. the migration
needs explicit examples and a data census; no census ran in this research.

occurrence-local containment preserves contextual reuse, but needs a surface
root, acyclic parent-occurrence relation and sibling-order contract. merely
adding an indentation number is insufficient. the same note may then expose
different children in two places and a different standalone view: an explicit
roam deviation, not implementation trivia. leave this choice open until the
spec records the intended two-page example and existing-data mapping.

## two dependent prs

pr 1 should own shared writing/session behavior, normal text input, selection,
composition, formatting, clipboard, visual treatment and saving/recovery across
the existing hosts. pr 2 should own the approved containment change, structural
commands, bullet visuals and physical bindings through that same session.
touch versus keyboard is not a sound module boundary: both invoke operations
on the same text, structure, selection and history.

prefer a continuous prosemirror view for a continuous writing surface because
the current independent views cannot naturally represent cross-row ranges or
one mixed history. validate the chosen representation before declaring a
rewrite mandatory. a prosemirror document may be the in-memory projection of
stable note and occurrence identities; it must not become a second persisted
whole-tree authority beside graph data.

both specs must agree on the document and history boundary before pr 1 is
implemented. pr 2 extends that owner rather than installing new save queues or
dom mutation handlers. the root [council proposal](../notes-writing-council.md)
records the acceptance matrix and remaining choices.

required behavioral evidence should remain small and consequential: typing
and composition across each host; cross-block selection/clipboard/history;
normal leave/reopen; lost acknowledgement followed by more typing; failed
local storage; conflicting edits; annotation/link identity across dismissal;
and subtree operations after the containment decision. record actual mac and
iphone/browser versions and traces. `./scripts/test` establishes static
consistency only; none of these behavioral cases ran in this research.
