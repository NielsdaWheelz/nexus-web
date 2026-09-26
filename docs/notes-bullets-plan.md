# roam-style bullets over shared links

status: approved direction; implementation contract for pr 2 of 2
date: 2026-09-25; baseline: pr 1, [writing and saving](notes-writing-plan.md)
evidence: [roam reference](research/notes-roam-reference.md), [current owners](research/notes-current-system.md)

## goal, decisions and non-goals

make note bullets quick to create, rearrange, select, fold and focus using roam's
interaction vocabulary. retain apple-quality prose input and the first pr's
single writing/save/history owner. the user explicitly requires bidirectional,
nonhierarchical links: a note's linked notes follow it everywhere. indent and
outdent EDIT LINKS. there is no canonical parent or occurrence-owned subtree.

scope: explicit user context links projected in existing page/note writing
surfaces. compact annotations retain pr 1's prose contract. citations, inline
reference provenance, highlight/link-note attachment motifs and directed
stances keep their existing meanings. no navigation redesign, graph workspace,
offline mode, crdt, new editor framework, task system or full roam syntax suite.

## model and projection

| concept | owner and invariant |
| --- | --- |
| note body | `note_blocks`; one canonical body per note, shared across every appearance |
| link | one existing `resource_edges` neutral user/context row per unordered endpoint pair; canonical storage direction has no product meaning |
| endpoint order | add `order_key` to `resource_view_states`; for each eligible endpoint, order its incident links independently. link existence never depends on a view-state row |
| occurrence | derived `(rootRef, ordered link-id path)`; selection adds note ref and text offsets. neither note id nor edge id alone identifies an appearance |
| fold/focus | session view state keyed by occurrence path; no content mutation; do not persist a second graph or parent field |

reuse the existing view-state uniqueness `(user, surface scheme/id, edge id)`;
add uniqueness of endpoint/order key for ordered rows. validate membership and
visibility through graph owners; `surface` is the viewing endpoint and `target`
is its other endpoint. preserve existing saved collapse values as the initial
state for an occurrence; subsequent fold/zoom is local to that writing session.

read one-hop neighborhoods through the existing surface owner. cache each
canonical node/neighborhood once per session; expand on demand, never recursively
load the whole connected component. every appearance uses the same neighbor
set/order. repeated ancestors render a terminal reference with a return action;
stop expansion by the current path, not a global visited set. longer graph
cycles remain legal. pages and non-note resources remain reference/card rows;
only note bodies expand inline. roots retain their existing title/body controls.

an absent neighborhood is loading/error, not empty. keyboard moves needing it
wait for its real result with the caret retained. no guessed destination or
silent truncation. edits update all loaded copies of affected notes/endpoints;
unloaded copies read current state when expanded. keep one active text caret.

## commands: exact graph effects

notation: `p` is the displayed neighborhood, `a` the preceding note, `b` the
active note, `g` the enclosing neighborhood. an edge denotes one shared relation.
all structural commands update content, graph, rank, versions and replay receipt
atomically. text/selection/history changes form one local editing transaction.

| gesture / command | result |
| --- | --- |
| enter in a paragraph | delete the selected within-body text first, then split `b` at caret: `b` keeps left text, identity and ALL links; create `c` with right text and only link `p—c`, immediately after `p—b`; focus c. at end create an empty sibling; empty enter follows the same rule |
| shift-enter | hard break in the same body; no graph change |
| indent | replace `p—b` with `a—b`; append at a's endpoint; preserve b and its other links. no preceding eligible sibling: disabled |
| outdent | replace `p—b` with `g—b`, immediately after `g—p`. no enclosing neighborhood: disabled |
| reorder | change only p's endpoint rank; p has this order in every appearance; opposite endpoint order is unchanged |
| drag | before/after invokes reorder or rewire; inside invokes rewire; preview exact destination, escape cancels. menus/touch buttons invoke the identical command |
| empty backspace / explicit remove row | unlink displayed pair, preserve both notes and all other links; focus previous editable occurrence. self/ancestor terminal rows are not editable |
| nonempty boundary backspace / forward-delete | for two paragraphs only, append later content/marks to the earlier note and unlink the later displayed pair; retain the later note UNCHANGED elsewhere. only adjacent editable notes in the same neighborhood; no global identity fusion |
| fold / focus bullet | collapse only this occurrence or focus its local neighborhood with a return path; no graph writes |
| select/cut/delete blocks | explicit occurrence selection; copy bodies in visible order; cut/delete unlinks selected displayed pairs once, never deletes note resources |
| paste ordinary outline | create fresh note identities and links matching explicit clipboard nesting; preserve supported marks; soft breaks stay within a body; each copied occurrence becomes a separate fresh note |
| paste existing reference | insert/reuse a link to existing note identity; its neighbors follow; no copied content |

rewiring reuses an existing destination pair without duplication, moves that
endpoint entry to the requested position, and focuses it. never give an existing
link id new endpoints. reject self-links and stale paths/anchors before mutation.
do not transfer b's other neighbors during split, indent, outdent or joining.
code enter inserts a newline. atomic embeds/cards use row commands, not text
split/join. incompatible body-boundary joins are disabled; never flatten them.

structural removal/rewiring/join of a relation carrying its own link annotation
requires the existing explicit link action instead; reject the shortcut with
“this link has a note; use link actions”. do not instruct “remove, then retry”
after the occurrence has disappeared. this keeps a structural gesture from
silently detaching commentary about a different pair. ordinary row deletion
always means unlink, not global note deletion.

mixed text+structure undo is one session history. body edits deduplicate by
canonical note id; relation edits deduplicate by pair. undo uses a new mutation
id with current expected versions and reverses exactly the recorded effects;
redo is another new edit. saved/ambiguous requests first settle through pr 1's
TRANSPORT queue; local undo and caret update immediately. an external conflict
preserves the desired inverse and stops outbound overwrite.

before a structural request, absorb never-submitted body edits it depends on
into that same semantic edit; serialize behind already-submitted work. no late
pre-split body save may overwrite the split. retain both exact submitted request
and later desired inverse during ambiguous outcomes.

## api and intra-system composition

extend existing `GET /resource-items/{ref}/surface` to return the endpoint's
ordered incident neutral links, hydrated targets and versions; each link id is
stable, while path occurrences are client-derived. retain exact typed decoders
and current missing/forbidden target policy. no second graph-read endpoint.

extend existing `POST /resource-items/{ref}/surface/commands`:

`{ref}` is displayed neighborhood p, not the editor's outer root; position
anchors must be incident link ids at that endpoint.
exception: multi-context remove/cut uses the initiating editor root as route ref
and supplies `{endpointRef, linkId}` entries. validate every incident pair and
affected endpoint version, deduplicate shared relations, then remove atomically
with one inverse receipt. the route does not grant authority over its neighbors.

- envelope remains `{client_mutation_id, base_versions, command}`; request bytes
  freeze before submission. rename note/page `outgoing_edges` lane to `links`;
  retain independent `body` and `title` lanes.
- closed commands: existing insert/split/move/remove plus `relink`, `join_notes`,
  `paste_outline`, and `reverse_edit`. remove accepts the endpoint/link entries
  above. relink supplies old link, destination
  endpoint and `start|after(linkId)`; join supplies the two canonical notes and
  displayed relation; paste supplies validated bodies and local parent indexes.
- request versions cover every read/written body and endpoint, including the
  destination used for a duplicate check. response returns changed bodies,
  neighborhoods and committed versions, not a replacement for newer input.
- store inverse effect snapshots with the committed mutation receipt;
  `reverse_edit` references that viewer-owned receipt, validates CURRENT
  expected versions and touched postimage preconditions, then returns new
  versions to advance the session's history frontier. never compare forever
  against the original receipt's version: undo itself advances versions.
  restore removed pair ids/ranks when still valid; never accept a
  caller-authored arbitrary graph snapshot. redo reverses the reversal receipt.

record whether a destination link was created or reused and its prior rank;
undo of relink preserves a pre-existing destination relation. undo of
insert/split/paste restores prior bodies/relations but retains newly generated
note resources and ids; redo reuses them. no undo globally deletes a note that
may now be referenced elsewhere.

`resource_items/surfaces.py` composes semantic edits in its serializable
transaction through flush-only graph/body owners. extract the shared neutral
link mutation from `user_relations.py` into the graph owner so universal link
authoring and bullets enforce the SAME uniqueness, annotation and version rules.
body projection, inline-reference indexing and note reindexing retain their owners.

topology changes bump BOTH endpoint `links` versions; rank changes bump only
the reordered endpoint; duplicate no-op insertion bumps neither. all neutral
link create/delete paths participate, including existing generic link actions.
body writes bump the body lane. visible links grant no right to edit target
content; retain existing ownership/capability checks on every changed resource.

## presentation and shortcut contract

outline designer owns bullet/disclosure/hover/selection/drop/cycle states;
content designer owns accessible action names and the words “remove link”,
“copy text”, “copy reference”, “already shown above”. good content distinguishes
shared text from a particular appearance without showing ids or storage jargon.
provide a diamond and cycle specimen, wrapped/marked text, a reference and a
non-note card. no placeholder typography or raw markdown mode.

use existing tokens; subtle bullets, readable nesting, no permanent row-action
gutter; reserve usable hit areas without overlap. keyboard focus remains visible.
formatting and mobile input keep pr 1's contract. native text keys win while
editing; structural keys are scoped to the active writing surface/block selection.

in text mode, tab/shift-tab indent/outdent; escape selects the current block.
in block mode, arrows move the selection, shift-up/down extend through visible
rows, enter resumes text editing, escape clears block selection and tab leaves
the surface; on terminal/card rows, enter invokes the reference/return action.
delete/backspace unlinks selected pairs. block-mode tab/shift-tab
also leaves focus; indent/outdent remain available through menus.
indent/outdent/reorder/drag require one selected occurrence; disable them for
multi-selection rather than choose an implicit root or discard part of the set.
mac reorder is cmd-shift-up/down, non-mac alt-shift-up/down, ONLY in block mode;
text mode retains native selection. block-mode cmd-up/down (ctrl on non-mac)
folds/expands; menus provide identical actions. cmd/ctrl-z
and shift-cmd/ctrl-z undo/redo; preserve platform redo where nonconflicting.
bullet focus and menu focus always work. confirm the source-conflicted mac zoom
binding against the live panel before assigning it; do not invent a parity claim.
os-reserved bindings are never captured globally. the reference dossier's key
table is evidence, not an executable map; omit unrelated roam commands.

block selection contains only explicitly selected visible occurrences, never
hidden neighbors. copy encodes ordered `{body, parentIndex?}` records using the
nearest selected path ancestor; no selected ancestor means a paste root. use a
small typed internal clipboard payload plus indented plain text. selected
repeated appearances copy independently; terminal cycle rows copy as reference
atoms. reference paste is separate. cut deduplicates exact selected pairs and
rejects the entire action if one pair is protected by a link annotation.

## files, work split and cutover

| package / owner | exclusive files / responsibility |
| --- | --- |
| a: graph/domain engineer | `python/nexus/services/resource_graph/{adjacency,edges,user_relations,schemas,connections,cleanup}.py`; `resource_items/{surfaces,versions,capabilities}.py`; affected `notes.py`, `vault.py`, `artifacts/subjects.py`, `highlight_notes.py`; backend schemas/models/migration and thin route changes |
| b: editor engineer | `apps/web/src/lib/resourceSurface/{model,api,useResourceSurfaceSession}.ts`, resource surface decoder in `lib/resources/resourceItems.ts`, structural commands/history in `lib/notes/prosemirror/*`, `NoteBodyEditor.tsx`; canonical graph projection and command adapter |
| c: interaction engineer + outline/content designers | `ResourceSurfaceBodyEditor.tsx` and css, `ResourceSurfaceEditor.tsx` and css; bullet menus, path focus/fold/selection, accessible copy; no independent mutation/state owner |
| d: independent reviewer | temporary live driver, migration/recovery rehearsal, acceptance receipts and owning docs/tickets |

freeze a's command/schema contract before b/c work. b owns selection/history
state; c renders it. changing a shared file crosses an explicit handoff, never
two parallel editors. pr 1 and pr 2 are stacked, not independently merged.

migrate only neutral user links plus ordered PAGE/NOTE adjacency into canonical
pairs and endpoint order. preserve an existing neutral link id first; otherwise
retain a deterministic survivor, remap view-state references and preserve all
annotation motifs/content. source-side order is preserved; previously unordered
or reverse-only neighbors append deterministically. no automatic canonical parent.

IMPORTANT: directed conversation context also uses `origin=user` and order keys.
exclude it, along with all other provenance/attachment relations, from this
conversion. keep `source_order_key` for those real uses; remove the obsolete
reserved `target_order_key` and the page/note outgoing-only adjacency path.
update every active nested reader/writer, including vault, artifacts, capability
scope expansion and highlight-note ordering; no old/new traversal fallback.

before cutover, census pairs/order/annotations and checkpoint or drain pending
client requests. preserve/export undrainable raw drafts and their old identity
mapping before removing readers; old replay receipts cannot be replayed under
new bytes or interpreted as the new response schema. coordinated stopped writers,
backup, one migration and client reload; no persistent compatibility bridge.
rollback after new graph writes needs restore/forward repair, not just a binary
revert. retain a reviewed before/after mapping for the rehearsal, without secrets.

## temporary live acceptance and completion

use pr 1's explicitly authorized red/green/refactor workflow and isolated real
stack; no permanent suite or ci expansion. establish genuine reds first,
challenge each phase independently, pass the SAME assertions after code and
refactor, then delete task-owned tests only after all required cases pass.
designers inspect rendered specimens; static checks do not prove taste or touch.

| case | required real result |
| --- | --- |
| b1: shared graph | fixture `p—a`, `p—b`, `a—x`, `b—x`, `x—p`; edit x through either appearance, see both update; every x has the same neighbors; cycles terminate without hiding the other valid path |
| b2: link edits | indent/outdent/reorder by key, pointer and menu yield the exact tabled edges/ranks; duplicate destination stays one pair; both endpoints observe rewiring; stale version commits nothing |
| b3: text/history | split/join obey paragraph/code/atom rules; execute at least three acknowledged mixed edits then successive undo/redo, including relink into an existing destination; current versions advance while exact text/ids/ranks/caret restore; an external edit still conflicts |
| b4: view/clipboard | folding one occurrence leaves the other visible; focus returns; text copy/paste creates new identities, reference paste reuses one; mixed-depth/multi-context cut unlinks exactly selected pairs, one undo restores them, one annotated member rejects all; no note resource deletion |
| b5: durability | lose actual committed structural response, type/move again, retry and reload: exact replay and successor retained; old reply never replaces newer projection; annotated relation shortcut rejects intact |
| b6: cutover | rehearse duplicates, reverse edges, nested links, annotations, pending drafts, old replay receipts and conversation contexts; preserve data and explicit scope exclusions; exercise actual post-migration readers |
| b7: feel | iphone/mac specimen review, keyboard escape, screen-reader names, non-drag move and android/webview smoke; 100 edits on a 100-note/depth-10 fixture satisfy pr 1's input budget with no caret/scroll jumps |

trade-offs: this is roam's interaction vocabulary over a graph, not its ownership
tree. split changes the original text everywhere but attaches its new right half
only to the displayed context. join copies then unlinks; it does not fuse ids.
rewiring changes a shared relation everywhere; folding remains local. graph
cycles produce terminal references; annotated relations require explicit removal.
multi-selection supports copy/cut/remove, not batch indentation or reordering;
native text selection takes priority over roam's conflicting reorder bindings.
undo preserves generated note resources even after removing their new links.
these differences are intentional and must appear in the implementation pr.

done: b1–b7 and final `./scripts/test` pass, temporary tests and retired paths
are absent, owning architecture docs describe the graph projection, and resolved
graph/reference-evidence tickets are deleted from the register. code/live work:
not run. unknown reference geometry/bindings must be observed or explicitly
declared nexus choices before implementation acceptance, never guessed.
