# connections cutover plan

status: implemented and locally verified on current main; production release pending
date: 2026-10-07 · baseline: `a494f743e`
review: domain/api, interaction/content, migration/verification; blocking design findings resolved

implementation: `feat/connections-main`; baseline checkpoint `73d5982f7`; [verification receipt](connections-verification.md).
the user approved porting the verified behavior to `origin/main` at
`1b18fe8d0`, head `0263`. preserve its newer owners, use a new migration after
that head, and repeat affected proofs. the baseline remains a separate checkpoint.

make relationships understandable: **connections** is the resource side pane,
**link…** authors a connection, and **suggestions** ranks items to read or file.
one authoring command serves menus, reading selections, chats and writing.
reuse existing owners; ship one hard cutover, without aliases or dual writers.

## scope and decisions

- user links are neutral, bidirectional, nonhierarchical and unique per pair.
  remove supports/contradicts authoring. convert existing user stances to links;
  preserve endpoints and attached notes, discard stance labels outside the backup.
- remove internal inline reference atoms, autocomplete and their derived graph
  path. preserve displayed prose and create ordinary links to valid targets.
  ordinary hyperlinks, including nexus urls, and whole-block embeds remain.
- every eligible resource menu exposes the same link picker. passages become
  durable anchors on confirmation. annotations are ordinary notes; saved web
  links are media. relationship ids are not resources and cannot be link targets.
- neutral user links alone define writing-outline adjacency; linked notes remain
  expandable everywhere they appear. machine/citation/attachment facts keep their
  existing consumers.
  indent/outdent edit shared links; ordering belongs to each endpoint; folding
  belongs to each appearance. cycles stop at an ancestor on the current path.
- deliberate chat links make resources available to newly submitted turns in
  either endpoint orientation. linking two chats works both ways without
  recursively importing their other connections. frozen turns remain unchanged.
  linked-chat reading covers all completed branches with bounded continuation;
  linking one message selects narrower context, without adding branch state to links.
- citations continue attaching resources to future chat context. unlinking one
  user pair may leave an independent citation/system attachment; show its reason
  and permit detaching that context fact without erasing the citation occurrence.
- one connections entry point includes user/assistant/discovery links, citations,
  annotations, highlights, source references and attachments. retain their
  provenance, locations and owning operations; keep reader passage alignment.
- rename active synapse/resonance/slate code, routes, schemas, jobs and settings.
  historical immutable receipts retain their original bytes and cannot dispatch.
- repair defects required by this contract: missing assistant rows, discarded
  pagination, old-link response hydration, chat-link removal and passage reads.

non-goals: optmem/optchat/dreamer integration; changes to discovery models,
judgment rules, ranking, retrieval, triggers, replacement or suppression;
assistant-link eligibility in suggestion ranking; machine stance conversion;
linking to relationships; a new graph store, containment tree, pane layout,
editor, search engine, permanent test framework or general writing repair.

this owns the subsequent link/inline-reference cutover. the unaffected writing
and outline contracts remain in [notes writing](notes-writing-plan.md) and
[notes bullets](notes-bullets-plan.md). the verification receipt records actual
observations and remaining release prerequisites; implementation alone does not
establish production cutover safety.

## owners and schemas

`resource_graph` owns persisted relationships and their projection.
`resource_items` owns capability and visible target admission. existing search
provides candidates; passage anchors provide durable locations. the web renders
these contracts and never reconstructs authorization or graph lifecycle rules.

current-main port: keep the shared document reader, resource-owned editor,
server-owned chat branches, native generation journal and single-module
suggestions owner. use the reader's current evidence renderer. the deleted vault,
artifact revision table, shell generation api and former reader renderer stay
retired. the file boundaries below name current owners.

`connection_discovery` retrieves candidates through shared search, applies the
existing model judgment and persists owned links. `suggestions` deterministically
ranks existing graph, semantic and reading evidence into ephemeral results.
accepting a suggestion changes destination membership through its existing owner.

| record | contract |
| --- | --- |
| resource identity | existing `ResourceRef = scheme:uuid`; no new scheme |
| user link | existing `resource_edges`: `origin=user`, `kind=context`; canonical unordered endpoints; null ordinal, snapshot and source order; no self-link; viewer/pair unique in the database |
| endpoint view | existing `resource_view_states`: independent order at each endpoint; occurrence fold/focus remains writing-session state; view state never establishes link existence |
| machine fact | `origin=discovery` or `assistant`; preserve current direction, kind, rationale and creator. discovery replacement cannot replace explicit assistant work |
| citation | retain source, target, occurrence ordinal, role, snapshot and locator. a cites b does not mean b cites a; repeated occurrences remain distinguishable |
| attachment | retain source-owned embed/highlight-note/link-note facts. a link note stays an ordinary note with the existing pair attachment motif |
| note body | existing supported grammar minus `object_ref`; `object_embed`, text, marks, images and hard breaks remain. all writers enforce the same grammar |
| target search | existing resource/passage discriminated union; passages carry candidate identity, source, excerpt and activation; both variants expose existing-link identity |
| connection output | retain edge id, endpoints, direction, kind, origin, citation, link note, availability and creation time. add nullable creation metadata and the narrow mutation descriptor below; preserve each fact's identity |

replace split source/target/reference capability fields with symmetric
`link_mode = none | direct | materialize_passage`. keep read, attach, inspect and
placement capabilities orthogonal. a link grants no new ownership or edit right.

| link mode | supported identities |
| --- | --- |
| direct | media, library, highlight, page, note_block, conversation, message, oracle_reading, artifact, contributor, podcast, passage_anchor |
| materialize_passage | content_chunk, evidence_span, fragment, oracle_passage_anchor, reader_apparatus_item |
| none | artifact_revision, external_snapshot, relationship ids |

search must find every direct family and every locatable passage family above,
including conversation dossiers. use existing lexical/hybrid sources and
metadata candidates; close coverage gaps in those owners. keep admission,
visibility, exclusions, deduplication, refill and cursor handling centralized in
`resource_items/targets.py`. exclude missing resources and resources the viewer
cannot access; body readability is a separate capability. source passage
normalization uses existing-anchor lookup during search, without materialization;
when no durable source exists yet, confirmation owns duplicate detection.

revisions are historical identities, not durable user targets. migrate existing
user revision endpoints through current `artifacts.revision_id` → durable artifact head, with ownership
checks. citations keep their revision identity. never silently replace a selected
passage with its whole document or a missing resource with a nearby match.

## commands and composition

retain `POST /resource-graph/links` with
`{client_mutation_id, source, target}`. either endpoint accepts
`{kind:resource, ref}` or `{kind:passage, candidate_ref}`; source also accepts the
existing fragment/pdf selection variants. a selection retains its source,
offsets/quads, highlight id and color while the picker is open.

the existing command authorizes and resolves both endpoints, materializes a
selection highlight or passage anchors, rejects self-links, ensures the pair,
updates affected endpoint versions/order and records its replay response in one
transaction. search and pre-submission cancellation write nothing. stale, inaccessible or
ambiguous endpoints leave no partial highlight, anchor or link.

keep `{created, created_source_ref, connection}`. `created_source_ref` identifies
a newly authored selection highlight; the connection contains final endpoint
identities. duplicate/reverse creation returns the same link id. identical
mutation identity and bytes replay exactly; changed bytes conflict. hydrate the
known result by edge id through the connections owner, never by finding it among
the newest 100 rows. reuse existing serializable/replay machinery.

| api | final responsibility |
| --- | --- |
| `POST /resource-graph/connections/query` | existing refs, direction, exact/owner rollup, filters, limit and cursor; return items and next_cursor. no consumer discards continuation |
| `DELETE /resource-graph/links/{link_id}` | idempotently unlink the pair, detach its note motif and update endpoint state; never delete either resource or the note body |
| `DELETE /conversations/{conversation_id}/context-refs/{edge_id}` | detach only a citation/system context fact; reject user links and citation occurrences; retain its distinct owner |
| `PUT` / `DELETE /resource-graph/links/{link_id}/note` | existing note identity/body-version/replay contract; detach removes the attachment, not the note |
| `POST /resource-items/targets/search` | retain query, sourceRef, schemes, excludeRefs, cursor and limit; remove the now-redundant purpose field and reference profile |
| `POST` / `GET /connection-discovery/scans` | renamed existing scan request/status contracts |
| `POST /connection-discovery/edges/{edge_id}/dismiss` | remove a discovery fact and preserve existing pair suppression |
| `GET /lectern/suggestions` | renamed lectern ranking, with existing eligibility, size and response content |
| `GET /libraries/{library_id}/suggestions` | renamed library ranking; destination membership remains its existing command |
| `GET /lectern/quick-reads` | retain the meaningful short-reading subset |

neutral pairs match either orientation of the direction and source/target scheme
filters. directed facts keep their existing orientation-sensitive filters.

delete stance routes/models/clients and retired discovery/slate routes. no redirects,
aliases or old setting readers. type every rewritten route with the existing
response envelope, retain its casing, generate `wire.gen.ts`, and remove its
handwritten web decoder; follow [typed wire](local-rules/typed-wire.md).

`ConnectionOut.mutation` is a nullable discriminated union of `unlink`,
`dismiss_discovery`, `detach_context {conversation_id}`,
`undo_assistant_chat {conversation_id, tool_call_id}` and
`undo_assistant_generation {position_id}`. the row already supplies `edge_id`.
project only actions the actual owner can perform. the authorship owner resolves
assistant undo identity; the graph does not inspect generation internals.
`creation` is null without authorship; otherwise it contains the existing
`MachineAuthorshipOut` and a `record` union: `chat {conversation_id, message_id,
tool_call_id}`, `generation {generation_id, position_id}`. main’s durable receipt foreign key
keeps authorship inspectable after execution-history retirement; unowned legacy
edges have null creation metadata and no guessed undo. only a verified receipt enables
navigation. citations, embeds and link-note attachment facts have no generic
unlink action. an annotation note exposes both existing attachment facts in its
connections; the neutral pair also retains its note preview.

all authoring entry points use the same graph primitive. replace `LinkHighlight`
with one `LinkResource` action admitted by link_mode. resource menus, the
connections pane and reader selection use one picker/controller. initial chat
attachments and structural outline commands call the flush-only link primitive
inside their own existing transaction, retaining their broader command/replay
contract. this is composition, not a second relationship writer.

retain pane file upload/drop: import once, then link the returned media through
the same command; a failed link retries against that saved media without another
upload. choosing a file starts an import effect; cancellation guarantees apply
before that submission. closing afterward retains saved media. closing a picker
after link submission does not cancel it; its owner retains frozen retry intent
and completion/uncertainty feedback. undo removes the new pair, never the media
or selection highlight.

mixed outline clipboard/paste items become
`{kind:note, body_pm_json, parent_index?}` or
`{kind:resource, ref, parent_index?}`. parent indexes reference earlier copied note
items; reference/card rows cannot acquire children through paste. copied notes
create new notes; resource/terminal rows create links to the existing item. extend
the existing atomic paste command and clipboard version together, preserving the
current rules for eligible nesting/cycles. reject old typed payloads without
mutation; do not resurrect atoms or invent a second paste writer.

`context.py` owns one membership projection: incident neutral user links plus
outgoing citation/system context facts, excluding citation occurrences. dedupe
targets for assembly/admission, preserve individual reasons in connections. use
this projection for prompt assembly, frozen tool admission, conversation-scoped
search, direct reads, reverse chat lookup and dossier context. retain existing
resource-specific expansion limits; never walk arbitrary linked neighbors.
system source companions remain owned context facts. the context-fact writer
accepts only citation/system origins; all user attachment paths create neutral
links. citation publication keeps its current ensure-availability rule: add a
context fact only when the shared projection says the target is absent. a citation
does not guarantee a second attachment beside a user link. narrow context deletion
to non-user facts; do not reconstruct historical attachments that were removed.

chat attachment order uses existing endpoint view state for user links and source
order for citation/system facts. keep conversation outline capability disabled.
one allocator in `edges.py` reuses the target's earliest rank or appends beyond
both stores under the conversation row lock; lock two chats in id order. each
chat endpoint has its own rank. context projection dedupes by earliest rank;
removing one reason must not reorder a still-attached resource.

delete the public context-list route and dedicated pane/store; connections query
serves inspection, and existing context events invalidate that query. removing
one reason does not remove another. detaching cited context preserves historical
citations; later citations may attach it again under the existing rules. reuse
quote presentation for readable passage anchors so linked passages are readable.

extend existing `nexus.resource.read`: `ResourceReadInput.cursor` is nullable;
`ResourceReadSuccess` adds nullable `next_cursor` and the `conversation` kind.
other than conversation/message reads, cursor must be null.
the conversations owner pages complete user/assistant messages across all branches
in `(seq,id)` order. retain the existing body-string output: label each segment
with message ref, parent ref/root, role and `[start,end)/total`. use canonical
stored content and reader-selection snapshot rendering, without loading the full
ui tree or trust trail. return at most 20 segments and `READ_DOCUMENT_MAX_CHARS`
including labels. split oversized messages exactly; continue the same message
before advancing. offsets are unicode code points, distinct from selection offsets.

reuse the keyset cursor codec, binding viewer/uri, sequence/id/offset and a hash of
ordered complete-message `(id,seq,parent_message_id,role,updated_at)` metadata.
read that metadata and selected bodies in one sql statement snapshot. source
change returns `StaleCursor`, malformed continuation `InvalidCursor`; restart with
null cursor. this scans metadata per page and avoids transcript copies or a new
revision system. conversation pages are noncitable; individual message reads keep
their citation policy and support continuation. prompts remain compact; the model
fetches pages when needed. a frozen admitted conversation permits reads of its
messages, subject to current visibility; never consult current links to revoke
that turn's scope or import the other chat's attachments. scoped search includes
completed messages of directly attached chats without expanding their attachment
sets. generation tools use frozen admitted refs; ordinary app queries use current
membership. existing search-acquired read admission remains available.

the reader composes graph facts with its existing source-apparatus/highlight
owners under the shared connections title. retain follow-text versus all-items
mode, passage grouping, note expansion, locators, highlight editing and return
position. preserve specialized rendering; do not replace it with the flat list.

rename the current discovery service to `connection_discovery.py`; origin to `discovery`;
job/ledger owner to `connection_discovery_scan`; generation operation to
`connection_discovery`; suppression table to `connection_discovery_suppressions`;
setting to `CONNECTION_DISCOVERY_ENABLED`. keep one `services/suggestions.py`
and one web `lib/suggestions.ts`, with suggestions models/functions and
`SuggestionsSection`. the discovery registry calls its service directly; no
task wrapper. update active imports, registries, schemas, generated
contracts, prompt identity wording and deployment settings together. preserve
judgment instructions and all ranking/generation rules.

terminal history inspection belongs to the ledger's explicit read-only history
projection: expose original sealed facts without decoding them as an active
GenerationSpec. active lifecycle reads remain strict. never catch active decode
failure and fall back, rewrite fingerprints, or dispatch a historical operation.

## feature content and interaction

each feature below has a content/interaction designer accountable for its row.
the designer creates realistic specimens from the listed fields and reviews the
implemented states with an independent reviewer. use existing tokens, dialogs,
target listbox, resource rows, feedback notices and action runtime; no new content
schema service, decorative redesign or generated explanatory prose.

| feature and designer remit | good content and behavior |
| --- | --- |
| universal linking | source title or retained quote; target title/type and parent/excerpt for passages. title `link {item}`, search `search items and passages`, badge `linked`. selecting commits; pre-submission cancel writes nothing. success `linked` or `already linked`; undo only for a newly created pair |
| connections | one fact per row with the other item's title, provenance/reason, supplied rationale/excerpt and location. use `linked by you`, `machine-created link`, `cites` / `cited by`, `attachment`. the same item can appear for different facts; preserve reader passage groups |
| relationship actions | user `remove link`; discovery `dismiss link` with “removes this link and prevents this connection from being generated again”; assistant `undo assistant link` through its creator. `view creation` opens a verified surviving chat receipt or account-owned background effect. current durable authorship requires its matching receipt; legacy edges without authorship expose no creator or undo. never guess a source. resource deletion is a separate resource action |
| chat connections and reading | explain `linked items are available to future replies in this chat`; show its reason. `remove from chat` detaches non-user context, preserving citations. transcript segments preserve role/parent/identity and label partial content; shared ancestors appear once and siblings remain alternatives. never imply a linear dialogue across branches or that every item was read |
| notes and outline | ordinary prose replaces inline atoms. remove @/[[ resource autocomplete, internal picker and atom parsing; hyperlink control uses `hyperlink…` and `address`. `copy link` copies a navigable url plus existing typed clipboard identity; outline reference paste creates the ordinary pair, never an inline atom |
| discovery control | `find connections`, `finding connections…`; show stored rationale. refresh when a scan becomes idle; idle alone proves no success. announce `connections updated` only from a proven successful outcome. preserve failure/suppression semantics |
| collection suggestions | `suggestions`, with destination in its accessible name; use existing item content and supplied evidence only. `add to lectern` / `add to {library}` uses destination membership. retain quick reads and existing empty-section behavior; no invented relevance explanation |

all loading/error/empty states name the operation: `loading connections…`,
`no connections yet.`, `couldn’t load connections.` with retry; picker
`type to search`, `searching…`, `no matches`; stale passage `that passage changed.
search again.` uncertain mutation `couldn’t confirm the change.` retries preserve
the frozen intent. refresh retains loaded content; addition/removal/refill keeps
focus on a surviving control. no silent limit, success toast on failure or
destructive undo for an existing link.

picker continuation exposes `load more` and retry, retaining results and active
selection on failure. reset cursor/results on changed query, source or filters;
existing request-key ownership rejects stale responses. connections pagination
likewise retains loaded rows and exposes failed continuation rather than emptiness.

review keyboard, pointer and touch. search receives focus, active-option ids are
instance-unique, escape and a visible close control work, focus returns to the
opener, and the mobile keyboard does not hide selection/close controls. announce
loading/results/failure without announcing every keystroke. review long and
duplicate titles, a selected pdf passage, missing target, repeated citation,
expanded source note, annotated link, empty results and failed/uncertain writes.

## data cutover

use one new self-contained alembic migration after the current head; do not edit
historical migrations. old vocabulary may occur in migration inputs and immutable
history, never as an active alias or compatibility reader.

1. census target data: user stances and ordered chat attachments, inline atoms,
   missing/self targets, revision endpoints, duplicate/reversed pairs, link-note
   motifs, endpoint order, affected mutation/inverse receipts and discovery jobs.
   prove each row matches a declared conversion; unexplained shapes block release.
2. save or export pending writing on every used client, including writing journals
   and daily draft seeds; close old clients. reconcile dispatched requests before
   clearing only settled local state. no decoder may erase unsaved data to make
   the new schema load. affected undo history resets at cutover.
3. disable old discovery, drain/cancel undispatched work and apply completed work
   through its existing owner. uncertain dispatch blocks release until reconciled;
   never delete/reissue it under the new name. also settle nonterminal chat runs
   and ledger generations whose `MetadataResearch` or `ChatReadAdditiveWrite`
   snapshot contains the old `nexus.resource.read` contract. the migration guards
   those exact grants before ddl, including admitted chats without a ledger row;
   unchanged plans and terminal receipts remain untouched. then stop writers and the generation
   host using the existing release controller and take a verified database backup.
4. convert approved user relations to canonical neutral pairs. prefer an existing
   neutral id; otherwise keep the oldest eligible id by `(created_at,id)`. map
   revisions to durable heads, dedupe and remap endpoint view state. preserve
   existing endpoint order/collapse; move user chat attachment ranks into the
   surviving conversation view-state row before clearing source order. preserve
   non-user source keys except identity merges: choose the merged target's earliest
   rank and align its surviving reasons, preserving other targets' relative order.
   unexpected multiple automatic slots or constraint conflicts block cutover
   pending explicit repair.
   append new reverse neighbors deterministically.
   preserve note bodies and motifs; conflicting annotations require explicit
   repair, not choosing one silently. revision mapping can collapse endpoints
   to self: count and drop unannotated collapsed pairs; annotated cases block for
   repair with their note bodies retained.
5. replace every `object_ref` with its stored displayed label, using the existing
   label fallback, preserving marks. assert identical canonical body_text before
   and after. create one ordinary pair per valid distinct non-self target.
   confirmed deleted targets and self references retain text without a new pair;
   record counts and original identities. unknown/forbidden targets block review.
   extant legacy raw passage/external identities that were not eligible direct
   inline targets block for explicit repair; do not infer a durable anchor from
   a displayed label. the production census found no inline atoms.
   preserve object_embed and hyperlink marks; rebuild note-body facts from embeds
   only. a target referenced and embedded retains both the new link and embed fact.
6. bump changed body/endpoint versions; invalidate affected replay/inverse
   receipts after quiescence, including unchanged links whose stored responses
   lack the new output schema. no receipt may restore removed shapes or identities.
   reset `resource_graph:link`, `link_note:*`, `resource:*`, `daily:capture` and
   affected `highlight_note:*` receipt families; follow migration 0244's scoped
   reset, without defaulting missing fields or retaining an old decoder.
   enforce the new user-link shape in the graph writer and retain database pair uniqueness. rename mutable discovery state,
   including suppression, without changing pairs or rationale. preserve terminal
   historical ledger/spec/job bytes; exclude them from dispatch/requeue entirely.
7. rehearse destructive/migration cases in isolation, then deploy matched
   web/backend/workers through the existing controller. verify migration head and
   bounded live acceptance before the user resumes. restarted workers may already
   write, so the post-write rollback rule applies from their restart. stale body
   requests and retired routes fail without mutation.
   refresh active docs and delete all obsolete producers, clients and config paths.

before reopening writes, rollback restores the previous application and matching
backup together. after new writes, use forward repair; restoring a backup would
lose those writes and requires an explicit loss decision. a downgrade cannot
reconstruct discarded stance labels or inline positions.

## work boundaries and files

freeze schemas and the capability matrix first. each row has one implementation
owner and the corresponding content designer above; the independent reviewer
challenges it before handoff. shared-file edits are sequential handoffs, never
parallel ownership. paths below are relative to `python/nexus/` or `apps/web/src/`.

| workstream | exclusive file ownership and deliverable |
| --- | --- |
| graph and wire | services/resource_graph/{schemas,edges,user_relations,connections,adjacency,cleanup}.py; schemas/resource_graph.py; api/routes/resource_graph.py; services/assistant_write_authorship.py narrow provenance query. neutral contract, exact-id hydration, actions; owns wire generation after other schema handoffs |
| admission and search | services/resource_items/{capabilities,targets,action_snapshots,surfaces}.py; schemas/{resource_targets,resource_action_snapshots,resource_items}.py; services/search/candidates.py; generated lib/resources/resourceCapabilities.ts. body/paste/capability wire contracts, symmetric modes, stable endpoints, target coverage and general link action |
| note grammar | services/note_bodies.py; services/agent_tools/writes.py note producers; components/notes/NoteBodyEditor.tsx; lib/notes/prosemirror/{schema,commands}.ts; lib/resourceSurface/outline.ts. no inline producer/consumer; consume the admitted body/paste schema, retain embeds, urls, typed clipboard and shared outline |
| chat composition | services/resource_graph/context.py; services/{context_assembler,conversations,chat_runs,chat_run_citations}.py; services/search/scope.py; services/dossier/inputs.py; services/agent_tools/read_resource.py; services/tool_runtime/{declarations,handlers,resource_scope}.py; api/routes/conversation_context.py. context projection, passage reading and bounded transcript reads |
| web interaction | lib/actions/{resourceActions.ts,resourceActionMenu.tsx}; components/resources/LinkTargetDialog.tsx; lib/resources/useResourceTargetSearch.ts and common target controls; components/connections/*; reader connection renderer; chat context surface/store retirement; lib/panes/paneSecondaryModel.ts. one picker, action dispatch, complete pagination and consistent title |
| discovery and suggestions | services/{connection_discovery,suggestions}.py; schemas/{connection_discovery,suggestions}.py; api/routes/{connection_discovery,lectern,libraries}.py; tasks/{media_unit_build,note_reindex}.py; jobs/registry.py; job_topology.py; services/{generation_spec,generation_policy,generation_ownership,llm_ledger,highlights,pdf_highlights,atlas}.py; config.py, repository-root .env.example and deployed settings; lib/{connectionDiscovery,suggestions}.ts, components/collections/SuggestionsSection.*. active rename and callers; preserve current-main judgment/ranking owners |
| migration and verification | db/models.py mappings/names; one new repository-root migrations/alembic/versions file owns constraints/indexes; temporary live/integration harness; cutover receipts and docs/tickets. consumes frozen contracts, does not create alternate domain implementations |

additional sequential handoffs: graph owns the current generated browser tool contract at `lib/chat/toolContractProjection.ts`
and reader creation metadata; admission owns exact action-state output models
and `services/document_embeds.py` output constructors. web owns
`lib/resourceGraph/{useLinkComposer,connectionMutations}` and
`lib/resources/resourceOverlaysController.tsx`,
`lib/api/useCursorPagination.ts`, `components/resources/ContextEdgeMenu.tsx`,
the existing account background-effects focus projection, and the reader's
distinct user-link fact projection in `services/reader_evidence.py` and
`app/(authenticated)/media/[id]/evidence/`. native assistant actions share
`lib/chat/toolCallUndo.ts`. the existing `scripts/test` already owns generated
tool-contract freshness; no duplicate gate.

web also owns the narrow feedback-layout repair: persistent notices reserve a
bounded scrollable row, preserving frozen retry identity and reachable controls.
`components/feedback/` owns that element; the existing `lib/mobileViewport/`
measurement owner places nexus above feedback/player bounds. no new lifecycle
or layout framework. the rail consumes workspace height while notices are present.

the web owner handles graph api clients; the rename owner handles discovery and
suggestion clients. admission publishes body/paste schemas before note authoring;
graph regenerates wire after all schema changes. migration owns database changes,
with graph/discovery review. a caller outside a row's file set is changed through
its owner; add a file to exactly one row before assigning implementation.

## acceptance and adversarial gates

the user's temporary integration/live-test request is a scoped exception to
[static-only verification](local-rules/testing-standards.md). use a small removable
driver against the real api/database and browser, a disposable database for
migration/failure cases, and one bounded real discovery run. no permanent ci
suite, production test seam, alternate writer or model-response equality test.

| proof | required observation and adversarial challenge |
| --- | --- |
| universal authoring | real menu, pane and fragment/pdf selection use the same source/picker/command. find every target family and choose a result beyond page one. exercise both endpoint modes, including two candidates resolving to the same anchor. pre-submit cancel/stale/forbidden/self cases leave no residue; reverse/retry returns one pair, including an old pair behind more than 100 newer facts |
| durability and scope | lose a successful response and retry exact bytes: one pair and exact replay. changed intent under the same id conflicts; inaccessible resources remain excluded. upload succeeds/link fails/retry/undo leaves one saved item and no link. artifact regeneration preserves a link to its head; index replacement preserves a passage link |
| shared outline | diamond and cycle: user-linked neighbors follow notes everywhere; path cycles terminate; shared edits agree; endpoint ordering stays independent. mixed copy/paste clones note bodies and reuses resource identities without atoms. deleting former inline label text leaves its durable link |
| connections and content | reach all rows beyond the first page; assistant/discovery provenance appears; remove the user link while preserving a citation to the same item. discovery suppression survives rescan; assistant undo uses creator provenance. reader location, source expansion and mobile/keyboard focus survive |
| chat | both endpoint orientations and chat–chat: newly admitted prompt, frozen tool scope and scoped search agree. unlink removes only its reason; citation/system context survives separately and can be detached without erasing citations. mixed origins retain attachment order and chat–chat ranks are independent. linked passages are readable; existing/in-flight turns remain unchanged |
| linked-chat reading | fork with shared ancestor, two sibling replies and an oversized message: all completed content reconstructs without duplication or loss across pages, with roles/parents intact. new completion invalidates continuation; restart works. message admission follows the frozen linked chat, current visibility and existing acquired-read rules; unrelated chats and unfinished output remain excluded |
| migration | real prior-head database → new head preserves text, neutral ids, notes, view state and suppression; zero user stances/inline atoms remain. include marks, unicode, reverse duplicates, missing/self refs, embeds, urls, revision mapping and replay receipts. unequal-rank identity merge keeps position after removing either reason. old inverse/body requests cannot resurrect removed shapes; unsaved text is exported/recovered |
| rename and suggestions | old active routes/settings/jobs are absent. same fixed inputs give the same eligible/ranked suggestions after vocabulary normalization; membership additions work. discovery trigger → job → generation → edge → pane works; old terminal receipts remain inspectable without replay |

sequence: designer specimens and independent contract challenge → write desired
behavior tests and observe meaningful red failures → implement owner slices →
green integration/live proof → adversarial code/interaction review → refactor
under the same tests → delete tests, fixtures, temporary dependencies and seams →
run `./scripts/test` and record final receipts. unchanged invariants may pass at
red; at least each new behavior must fail for its intended missing behavior,
not broken setup. repeat checks only after relevant changes or unresolved failure.

reviewers reject: ambiguous ownership; hidden data loss; citation/assistant facts
collapsed into generic edges; duplicated picker/state/query logic; capabilities
that search cannot deliver; runtime legacy parsing; unbounded graph traversal;
unverified UI/API/data claims. fix at the responsible owner and rerun the affected
proof. record unrelated findings immediately in individual tickets.

retain concise run results, deployment/data identities and unresolved limits in
this plan's eventual verification receipt; remove resolved tickets only after
implementation and observation. deleting temporary tests deliberately gives up
automatic future regression detection. stopped-client maintenance and reset undo
avoid a legacy runtime; one row per fact can repeat item titles; source-owned
removal policies preserve meaning at the cost of more than one internal command.
