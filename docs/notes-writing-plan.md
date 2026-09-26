# apple-quality writing and saving

status: approved contract; implementation in progress for pr 1 of 2
date: 2026-09-25; baseline: cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1
companion: [bullet interaction spec](notes-bullets-plan.md)
evidence: [apple reference](research/notes-apple-reference.md), [code audit](research/notes-current-system.md)

## goal and boundary

open an existing writing surface, tap/click, type, leave. text, caret, keyboard,
selection and saving remain predictable. apply to page notes, standalone notes,
highlight annotations, link annotations and quick capture. target the nexus
web app in a mac browser and the nexus android app's webview. apple notes is a
writing-quality reference, not a device target.

no navigation redesign, offline application, synchronization platform, new
editor framework, collaboration, ai, attachment expansion, or full apple suite.
links remain bidirectional and nonhierarchical; pr 2 implements their bullet
projection. no canonical parent, ownership tree or independent copied note.

## target behavior and content

| feature | contract | designer's definition of good |
| --- | --- | --- |
| writing | first intentional tap places caret and accepts input; hydration/save replies never reset newer text, selection, composition or scroll | writing designer: text dominates, no paragraph cards or permanent action gutter; approve short/wrapped/long specimens on both platforms |
| formatting | bold, italic, underline, strike, inline code and links; toolbar, context action and key invoke the same command | writing designer: selection remains visible; concise accessible names; selected state is apparent without color alone |
| compact annotation | one body block; enter/shift-enter insert a hard break, code gets newline; done dismisses, saving is automatic | annotation designer: quote is context, not editable content; no compulsory title; identical writing mechanics in popup and sheet |
| clipboard | preserve supported marks/references; normalize unsupported presentation; compact multiline paste becomes hard breaks; ordinary url paste inserts text/link | writing designer: pasted content reads like surrounding prose; import/attach is explicit, existing images/embeds round-trip |
| saving | keep typing during saves; clearing an existing annotation saves empty content and preserves identity; explicit remove alone detaches it; untouched new empty drafts create nothing | content designer: quiet success, truthful actionable failure, no “enter to save” hints |
| recovery | reopen exact pending text through stable owner identity; refresh preserves drafts; discard is separately named | content designer: distinguish “saved on this device; not synced”, “couldn’t save; keep this open”, and “changed elsewhere”; actions explain retry/copy/discard accurately |

headings, fonts, colors, tables and task widgets are excluded. retain current
paragraph/code/embed body types and supported atoms; add only the underline
mark to the matching frontend/server vocabularies. page title ownership stays
unchanged. mobile controls preserve native selection handles, autocorrect,
dictation and composing-keyboard input; do not implement these through keydown.

designers own the above content contracts and visual specimens before code;
engineers integrate their approved copy through existing feedback/label types.
no new content registry, cms or token system. use current typography, spacing,
focus and theme primitives; remove editor-specific chrome that obscures writing.

## architecture and capability contract

reuse prosemirror and `NoteBodyEditor`; it owns native prose input and emits
typed edits. keep the gesture-time mobile textarea as a one-way composition
handoff, not a second lasting document. retain existing domain APIs for page,
note, highlight and link attachment; their adapters do not own save scheduling.

each surface owns selection and history; one account-scoped writing store per
browser runtime owns canonical pending bodies, graph edits and saving across
ALL mounted surfaces. canonical body identity is the note reference; selection
also identifies its occurrence. pr 2 contributes graph commands to this store.
the store serializes one submitted request TOTAL; later work remains a queue.
two panes cannot create independent mutations for the same revision. another
tab is a separate writer: preserve its drafts and detect conflicts by versions,
without adding cross-tab locks or realtime collaboration.

native text selection edits one note body. multi-note operations use explicit
block selection in pr 2. this deliberate roam-style boundary avoids assigning
contradictory text ranges to repeated appearances of the same canonical note.
ordinary cross-note browser selection may copy text; it must not silently become
whole-note deletion or replacement.

internal contract, implemented in the current notes/resource-surface owners:

- input: stable `draftOwner`, current canonical body/version, typed accepted
  edit, occurrence-aware selection, and one domain save adapter;
- session actions: `edit`, `flush`, `retry`, `recover`, explicit `discard`,
  `undo`, `redo`; return body, selection and truthful save state;
- adapter prepares the exact typed domain request once and executes that
  frozen request; it never allocates a different id on retry;
- session history records affected canonical bodies, selection and semantic
  graph changes, not whole rendered documents. pr 2 defines structural inverse
  receipts. remove independent per-view histories when this owner replaces them.

an edit through another surface invalidates incompatible local history entries,
not its current input. undo responds locally at once and queues its inverse;
network settlement constrains transport order, never caret or undo response.

reuse prosemirror transaction metadata to respect composition and history
boundaries. group consecutive typing in the same note; selection movement,
paste, formatting, structural commands and composition completion close groups.
no second history inside a toolbar, outline, popup or save queue.

## persistence schema and protocol

retain localstorage with a compact account-scoped pending journal. successful
local retention is distinct from server acknowledgement and is not a promise
against browser storage eviction. do not serialize acknowledged surfaces on
each keystroke. retain only touched bodies/base versions and pending commands.

one journal per account/writer contains the fields below, keyed by a fresh
runtime writer id so another tab cannot overwrite it. list retained journals
for recovery by owner before creating a new draft; never silently discard or
overwrite a different writer's record. multiple conflicting drafts require an
explicit recovery choice. clean acknowledgement removes only this writer's
acknowledged content. this is a pending-work journal, not a notes database.
recovery retains the adopted payload, frozen request and source writer/revision
together in the current journal. discovery suppresses only that exact adopted
source revision after successful storage. retain adoption markers while their
sources remain; never automatically delete another writer's record. newer source
revisions remain recoverable. archived sources allow explicit export/discard.

| field | meaning |
| --- | --- |
| `revision`, `adoptedSources` | monotonic journal revision; exact source writer/revision pairs adopted through explicit recovery |
| `entries` | stable draft-id map: typed owning context, allocated note/capture identity, desired revision/body and unsent commands; one body entry per canonical note across hosts |
| `submitted` | absent or immutable route/operation, mutation id, complete body, base versions, attachment identity and submitted revision |
| acknowledgement | per-resource/lane committed versions and exact submitted outcome needed for successors; no whole surface snapshot |

host locators are discovery metadata, not duplicate body entries. allocate ids
before typing and preserve them on reopen. account and writer identify the
journal, not any domain resource. keep one current journal-format decoder.

pending annotation entries retain media/source, complete typed selection anchor,
preallocated note id and any resolved highlight id. reader reopen discovers
entries by source; before new capture match the full anchor or real highlight
id, never quote text alone. resolve/store creation results even if the composer
unmounted. if highlight creation has an unknown outcome, refresh the actual
highlight owner and bind only a unique exact anchor match; ambiguity preserves
the draft for recovery, never blind recreation. promotion updates the same
entry/key. reuse existing anchor types; no new highlight-identity subsystem.

1. accept edit and retain its compact journal during normal input. surface a
   storage failure immediately; keep the in-memory body available to copy.
2. keep the existing 1500 ms idle / 5000 ms maximum remote-save scheduling.
   blur, done and background request a flush; they are not the durability basis.
3. submit one immutable request through the shared store. edits arriving later
   form a separate successor; coalesce only work never submitted.
4. an unknown transport outcome retries the exact request first. newer edits
   cannot overtake it. success retires only that revision and prepares the next
   request with the returned versions and a fresh id.
5. a version conflict preserves local and remote content and stops automatic
   overwrite. retry does not silently substitute a fresh base version. offer
   explicit review/reapply or copy; refresh alone discards nothing.
   a definitive noncommit releases the submitted slot; retain the conflicted
   entry and its dependent work for resolution while unrelated notes save.
6. decoding failure retains raw journal bytes for export. do not repair content
   by inventing empty text. acknowledge local retention only after storage succeeds.

keep existing body/title and annotation endpoints. highlight/link note puts add
required `expected_body`: `{kind: "absent"}` for create-if-absent or
`{kind: "version", version}` for an existing canonical body. validate at the
same note-body mutation owner as ordinary notes, before changing attachments;
return actual body, note identity and committed body version. reuse existing
mutation ids/replay, authentication and exact decoders; frontend link adapters
must forward the id. equality binds the complete request, including versions.
creation requires no attachment; update requires that the expected note remains
attached. a stale update must not silently reattach a detached note.

existing link annotations hydrate their actual body/id/version. explicit
annotation removal detaches only its highlight/link attachment motif and keeps
the note/body/other links; change the current destructive delete owners to this
contract. detach requires expected attached note id and mutation id; freeze both,
validate identity and record the outcome through existing replay in the same
serializable transaction. replay returns the old outcome even after reattachment;
a fresh request targeting the wrong note conflicts. global note deletion remains
its separate existing action. remove adapters that fabricate empty saved bodies.

## files and non-overlapping packages

| package / owner | exclusive files or responsibility | handoff |
| --- | --- | --- |
| a: editor engineer + writing designer | `components/notes/NoteBodyEditor.tsx`, its css, `lib/notes/prosemirror/*`; formatting/caret/history dispatch | emits semantic edits and selection; consumes session commands; never writes storage or transport |
| b: persistence engineer + recovery-content designer | `lib/notes/useNoteEditorSession.ts`, `noteEditorDraftStore.ts`, `dailyDraftStore.ts`, a small `lib/notes/writingSession.ts` store, `lib/resourceSurface/{useResourceSurfaceSession,draftStore,api}.ts`; consolidate shared save mechanics here | sole runtime writer/journal/replay owner; reuse existing account lifecycle, no new provider framework |
| c: integration engineer + annotation designer | `HighlightNoteEditor.tsx`, `NoteDraftRecovery*`, `HighlightQuickNoteComposer*`, `MobileQuickNoteHandoff.tsx`, `ResourceSurfaceEditor.tsx`, `ResourceSurfaceBodyEditor.tsx`, `reader/document-map/EvidenceItemRow.tsx`, `lib/resourceGraph/links.ts`; owning highlight/link callbacks | adapters preserve quote/attachment identity and real saved projections; no new save loop |
| d: domain engineer | body schema in `python/nexus/schemas/resource_items.py`, `schemas/{highlights,resource_graph}.py`, `services/{note_bodies,notes}.py`, `services/resource_graph/user_relations.py` and affected highlight owners | versioned annotation create/update and attachment-only remove; b/c consume typed results |
| e: independent reviewer | temporary live proof, this spec's receipt and ticket closure | cannot silently rewrite implementation to make an assertion pass |

paths above are under `apps/web/src/` unless prefixed otherwise. a owns history
dispatch in views; b owns session history data. interface signatures are agreed
before parallel edits. d owns backend schemas even where a requests underline.
pr 2 starts after these packages settle; it may then change their contracts
only through the owners named in its spec.

## acceptance and temporary red / green / refactor

the user's explicit request authorizes temporary executable live tests;
`./scripts/test` and ci stay static-only. use one isolated real-auth stack,
browser → bff → api → postgres, ordinary disposable fixtures and a small
task-owned driver. no mocked backend, auth bypass, production data or test-only
application seams. designers supply readable short/long/marked/quoted specimens.

| case | live assertion |
| --- | --- |
| w1 | each host accepts first input; formatting, paste, selection and undo preserve text/caret; enter never submits compact annotation |
| w2 | physical android webview composition/autocorrect/dictation/selection handles and mac browser hardware keys work; mobile hydration/handoff does not lose text or dismiss the keyboard |
| w3 | type, dismiss/background and reopen: retained text/identity survive; annotation create, clear/retype and link-note reopen preserve the resource; detach an annotation shared on a page and the page's note survives |
| w4 | commit a real server save, intercept only its response delivery, type more, retry and reload: exact replay, one creation, successor retained, old reply cannot reset caret/text; lose a detach response, attach a new annotation, retry the old detach: new attachment survives |
| w5 | deny/quota-fail real storage and fail network: no saved claim; conflict refresh preserves both versions; undecodable journal remains exportable; a stale annotation put from another tab cannot overwrite a newer ordinary body edit |
| w6 | trace 100 edits in a short annotation and a 100-note surface on named devices: p95 input-to-paint <50 ms, no network-gated paint or save-induced focus/scroll jump |

before each phase, an independent reviewer challenges contract and assertions.
red: prove the stack works, then record real failing target assertions; existing
correct behavior may pass. green: run the same cases plus `./scripts/test`;
designers inspect real rendered content and a physical android and mac web sessions.
refactor: review ownership, duplicate state and dead paths; rerun affected
cases and the static gate. delete task-owned tests, fixtures, test-only
dependencies and credentials only after all required cases pass; retain exact
sha/device/commands/red/green/limits in the pr, then run final `./scripts/test`.
missing device/runtime evidence is blocked, never passed. no permanent suite.

## hard cutover and completion

replace competing save/history paths; remove submit-on-enter, autosave-as-delete,
mutation-id creation in transport adapters, whole-surface keystroke persistence,
silent draft deletion and false recovery copy. keep only real mobile handoff
and domain attachment adapters. no feature flags, fallback editor or old/new api.
checkpoint existing pending drafts before release; convert actual stored drafts
once or export unresolved ones before removing old readers. never clear work
because its format changed. reload writing clients at the coordinated cutover.

costs: cross-note editing uses block selection; url paste stops implicit import;
localstorage still has quota/eviction limits; serial saves favor simplicity over
upload throughput; another tab may require explicit conflict/draft resolution;
deleting temporary tests relinquishes continuing regression coverage. schema or
stored-content changes require a data-aware rollback/repair, not just git revert.

done: w1–w6 pass with honest device limits, static checks pass, removed paths and
temporary tests are absent, and the saving/annotation tickets linked by the
[audit](research/notes-current-system.md#saving-and-the-important-defects) are
resolved and removed from the register.

2026-09-26 implementation receipt: desktop w1, w3 and w5 pass; w4's reachable
save/replay paths pass, while duplicate exact anchors are rejected before its
ambiguous ui can exist. desktop w6 passes; physical android w2/w6 remain blocked
by another session's use of the phone. release preflights remain open. temporary
live tests stay outside the repository until all required checks pass.
