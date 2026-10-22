# resource references

a resource has one identity; each place showing it is an occurrence. an occurrence
owns its relationship, rank and folded state. it does not own replacement content
or a second resource identity. chat context, connections, search, notes, quotes,
citations, source previews and collection indexes compose this contract.
conversation messages retain their message layout.

## owners

| owner | responsibility |
| --- | --- |
| `schemas/resource_items.py` | generated wire for bounded bodies, attribution, capabilities and source targets |
| `services/resource_items/items.py` | the one visibility gate (`_rows`, `visible_refs`) and batched current previews with complete primary annotations |
| `services/resource_items/routing.py` | activations: a route, an outside url or none; passage hrefs only where `locations` says the words land |
| `services/resource_items/locations.py` | where words land now: the one location proof for capture, routing and resolution |
| `schemas/resource_evidence.py` | frozen words, attribution and complete target |
| `services/resource_items/evidence.py` | capture, historical projection and authoritative source resolution |
| `components/resources/ResourceBody.tsx` | literal content, colour, omissions and search emphasis |
| `ResourceLink.tsx` | compact title/recorded-label links and availability through canonical activation; no fetching or graph controls |
| `components/ui/ResourceRow.tsx` | common disclosure, bullet, selectable body and contextual-action shell |
| `ResourceOutlineRow.tsx` / `ResourceOutlineList.tsx` | resource bodies and occurrence-owned recursive lists |
| `OutlineSurface.tsx` / `lib/notes/useOutlineSession.ts` | shared rows, structure, selection, continuation and scoped history |
| `ResourceDisclosure.tsx` / `lib/resourceGraph/useResourceOutline.ts` | one bounded mixed adjacency read supplied to the shared surface |
| `ResourceComposer.tsx` | resource-owned creation using existing insertion primitives |
| `CanonicalNoteEditor.tsx` | canonical body binding shared by outlines, root notes and annotations |
| `lib/resources/metadata.ts` / `ResourceMetadata.tsx` | one factual metadata projection for visible and spoken labels; keyed fields, separators and source activation |
| `lib/media/kind.ts` | shared human media names; unknown structured kinds are defects |
| `lib/resources/sourceTarget.ts` | canonical href to target identity |
| `lib/workspace/targetActivation.ts` / `store.tsx` | destination selection and visit-bound delivery |
| `lib/reader/sourceArrival.ts` | cancellation, source checks and focus authority at the destination |

python paths are relative to `python/nexus`; web paths to `apps/web/src`.
prompt/read bodies remain in `resource_graph/resolve.py`; a list never fetches a
full prompt body for each row.

## visibility

one gate decides who may see a ref: the item rows (`items._rows`, exposed as
`visible_refs`). the item read, the actions read, `resolve.assert_ref_visible` (every
writer's endpoint check), prompt and read bodies (`resolve.load_resource_batch` loads
only refs the gate admitted) and citation keys all ask it, so no two reads disagree on
`missing`. an invisible ref never errors on read: its item is `missing`, labelled
"Resource unavailable", with a `none` activation (`source_unavailable`) and no verbs.
visibility is not location: an apparatus item whose locator is missing, or an oracle
anchor that no longer resolves, is visible with a `none` activation. a link or a chat
about it quotes its words (its body, the anchor's frozen quote) and lands wherever its
media still holds them uniquely; the link writer refuses them otherwise, as for any
passage.

## presentation contract

`ResourceItemOut` is `{ref, action_ref, label, preview, activation, missing}`. an
activation is `{resource_ref, kind: route | external | none, href, unavailable_reason}`;
a route href alone names the occurrence (`#highlight-`, `#fragment-`, `#evidence-`,
`#chunk-`, `#passage-`, `#oracle-passage-`, `?apparatus_id`, `?message`, `#quote-`,
`#citation-`, `#retrieval-`) and the web derives the source-target key from it.
`ref` owns disclosure; `action_ref` owns resource actions; `label` names accessible
controls and confirmations. `preview` contains `body`, nullable `source` and
nullable `annotation`. every wire key is present and snake_case; absence is null.

| body | primary content |
| --- | --- |
| `named` | title/name; kind and ordered credits are secondary |
| `media` | complete canonical `media_summary`; shared title, bibliography, consumption and commands |
| `passage` | exact words in captured/saved colour with adjacent prefix/suffix |
| `prose` | literal note/message text; code preserves whitespace |
| `images` | image count and up to three alt slots |
| `reference` | an embed note's stored label, or `embedded resource` |

row `presentation` is occurrence-owned: `inline_note` omits `note` only around a
nonmissing structural note editor; `quoted_passage` omits only generic passage
identity (`evidence_span`, `content_chunk`, `fragment`, `passage_anchor`) in a
nonmissing passage citation. ordinary references, highlights, source references
and oracle passages retain their types. open names retain canonical identity.

`resourceMetadata` returns canonical identity separately from visible keyed fields;
`resourceMetadataText` uses ordinary presentation for spoken launcher labels.
metadata fields stay ordered: occurrence, identity, role, media kind, source,
contributors, location, related-match evidence, relationship. focused roots omit
incoming occurrence labels and relationship reasons. omit blank optional text and
the empty container; each separator stays with its following field and supplies
a spoken boundary.
media kind replaces umbrella `media`; other resources retain both their own
identity and source kind. shared names are article, book, pdf, episode and video.
source links and captured attribution remain independent of label omission.

live media bodies use one batch of `media_summaries` after the visibility gate.
disappearance during hydration removes the old identity and activation together.
`MediaSummaryProvider` retains supplied seeds for collections, outlines and pane
titles, then revalidates in batches. frozen named/passages never subscribe.
full media rows render canonical supporting facts once through `MediaIdentity`;
their separate metadata retains occurrence, location, evidence and relationship
facts. compact/spoken metadata retains canonical facts when no supporting line exists.

exact/prose previews have a 600-codepoint budget, each contextual side 48.
annotations are complete: `{attachment_edge_id, note_ref, body_pm_json,
body_text, body_version, activation}`. body and version come from one batched
statement without recursive enrichment. full annotations increase payload bytes
and row height; page size does not bound bytes. image alts share one budget. truncation respects graphemes and
prefers word boundaries; flags describe omitted content. ellipses are rendering,
never stored evidence. omitted quotation tails never touch a nonadjacent suffix.
search match ranges address codepoints in a separate plain excerpt; no inserted
emphasis markup enters saved evidence. geometry-only selections say `selected
region`.

an annotation is the first highlight-note attachment in creation/id order. its
complete rich content appears with contextual highlighted words before expansion;
the chevron never hides it. other
annotations remain reachable through disclosure. notes have no invented owning
page. relationship rationale and link notes belong to the occurrence. captured
quotes never borrow today's colour, annotation or attribution; current annotations
under a historical branch are labelled as current.

## controls and composition

the resource outline row is `▸ • content`: disclosure expands; bullet and primary
reference text navigate through canonical activation. an explicitly admitted live
note's body activates canonical editing; captured evidence remains immutable.
the anchor is inline inside
a text cell, with literal line breaks and phrasing-safe body markup; live media
titles wrap fully. the title token contains no actions or supporting metadata.
metadata, attribution, annotation editors and relationship prose remain separate.
explicit `body` overrides retain their owner's editing semantics.

native modifiers remain browser-owned except shift-click and shift-enter, which
create and focus one fresh pane. touch retains open-in-new-pane. native link text
selection/copy remains available; there is no stretched link or row click handler.
`primaryLinkRef` gives search its existing return-focus target.

media rows compose one `MediaActions` group: episode play/pause, lectern membership,
libraries, then more. actions are native icon buttons independent of row activation,
selection and disclosure. a media row is an inline-size container with a descendant
grid; at 479px and below, actions/more share a lower line and may wrap at deep
indentation. other occurrence geometry remains owner-supplied.

editable outlines retain escape/menu block selection. read-only rows and embeds
keep their owner's selection semantics. [notes](notes.md) owns unlink admission,
pending state and history.

editable outline reference content is an atomic named token. its text remains a
native link; unused primary space places a caret. enter creates a sibling after
that exact occurrence; committed prose seeds its note and transfers focus. the
caret follows its explicit continuation: sibling for ordinary placements, child
for aligned roots. it never rewrites the reference or persists an `@id` wrapper. source, metadata,
disclosure and menus retain independent controls. per-row insertion buttons and
an equivalent menu command are absent. on coarse pointers, deletion at the token
boundary cannot automatically select a block for structural deletion.

lists use nested `ul/li` and labelled buttons, not a custom keyboard tree.
branches start collapsed and load one exact, paged adjacency hop, both directions
and every existing origin; unaccepted suggestions are absent. root filters do not
filter children. edge paths key folds; a repeated resource elsewhere is independent.
`lib/resources/outlineProjection.ts` owns branch classification for both shared
rows and editable notes. a traversed edge is omitted; a distinct edge to an
ancestor keeps its ordinary preview, evidence and actions, with an upward-return
button replacing expansion. `show earlier occurrence of {label}` names that
button for assistive technology and its tooltip; no extra status text is shown.
resource refs identify ancestors, edge ids identify facts, and occurrence paths
identify local rows/folds. sibling-list exclusions never enter traversal history.
highlight and annotation identities each have real local reveal targets. suppress
only the selected annotation's exact attachment edge. terminal annotation repeats
retain complete read-only rich bodies, with embed nodeviews reduced to atomic
`ResourceLink`; read-only mode alone does not terminate embedding cycles.

each shared row has explicit incoming edge, aggregate chat context or null resource
scope. a null mutation does not change that subject. connection menus contain
navigation and permitted relationship/local commands; resource lifecycle verbs
belong to resource roots. mutation targets never come from navigation/action refs.
notes composes this same menu and retains guarded user-link editing. machine
removal uses exact graph unlink outside note structural history; mixed machine
bulk cuts/deletes are refused. discovery removal permits later rediscovery.
only an acknowledged initiating removal may repair focus while it still owns
attention. nested removal targets the stable scope list because its ancestor
may disappear on refresh; direct root rows retain neighbour/list fallback.
intervening user focus cancels that claim.

focus establishes a new logical root and clears inherited resources and entering
facts. its header keeps resource content/actions; the former incoming relation
belongs to adjacency. callers supply `resourceActions`/`resourceDetails` for
resource-owned controls and status, and `occurrenceActions`/`details` for the
incoming relation. return restores the previous scope and folds. removing the
displayed focused occurrence exits focus with folds retained; keyboard focus
returns locally only when that scope owned it. lazy restoration alone does not
trigger recovery. incoming relationship editors stay mounted while hidden so a
pending first save retains its draft identity. reveal targets the current root
or an exact local occurrence, including a containing editor; it never opens
another pane. failures retain loaded children and offer local retry.
expansion never changes prompt scope or writes the graph.

reader roots have no incoming relationship. source-reference detail targets use
real resource rows and enter their own ancestry before lazy expansion; apparatus
membership supplies no invented graph edge. per-fact user/context rows expose
`add note on link` or `edit note on link` against that exact edge. the shared
`AnnotationNoteHost` also serves native highlights: per-occurrence drafts retain
the first-save uuid across collapse, filtering and focus; canonical text ownership
retains body and acknowledgement before adjacency rereads. detaching preserves
the note resource and gives the next annotation a fresh uuid. incoming editors
remain mounted while focus hides their relationship controls.
annotation items and highlight connections are separate endpoint-owned lists.
both use the shared surface; labels distinguish owners when both contain items.
annotation enter and accepted `@` insert beneath its note, never the highlight.

arranged lists interleave every incident fact in one endpoint-owned order.
collection indexes preserve their declared relevance, chronological or source order;
their typed metadata/status adapters use the same shell without per-row hydration.
display order grants no structural mutation permission: the relationship's explicit
capability owns removal; guarded note operations retain their own restrictions.
editor embeds use the same resource row; full note reads batch their immediate
`embedded_item`. editors supply acknowledged containing-note identity and a real
focus target. embed adjacency suppresses only that note's exact directed,
nonordinal `note_body`/`context` fact; parallel facts remain. resolve that fact from
current adjacency because body writes replace embed facts. empty states require
settled reads, exhausted adjacency and no visible children or failure.
launcher and target-picker options retain native selection
semantics and share body presentation without nested disclosure/menu controls.
search titles open whole resources; subordinate excerpt links open exact
occurrences. read-only note prose navigates through the same anchor. source attribution and
location availability remain independent of the bounded excerpt.

typing `@` in an empty resource-owned note composer opens in-place target search.
the input owns visit-local query, selection, source and placement; blur suspends it,
escape converts its exact text to prose. reference acceptance writes a link without
a wrapper note or body overwrite. relationship annotations remain prose-only.
`add item` belongs to the exact local occurrence or root, independently of action
ownership. transient passage sources save children under the returned durable anchor.
the exact outline's nullable `insertion_source` identifies this owner on reload.
candidate connections and durable passage items compose as separate endpoint lists;
they share occurrence identity without conflating orders, versions or facts.

reader connections use measured source positions and row heights, packing without
overlap. expanded children contribute height. the focused root stays mounted beyond
overscan and holds the focused control's viewport position until focus leaves.
independent list scrolling preserves the explicitly selected view. retained root
rows keep the same container across follow/browse layout changes, preserving their inline
editors. follow mode hides offscreen placed roots rather than unmounting them; measurement
ignores hidden geometry. mobile always uses ordinary flow.

## historical targets and arrival

`POST /resource-items/source-targets/resolve` accepts one key: current `resource`,
saved `reader_quote` message, `citation` edge, or saved `retrieval` id. historical
keys resolve their frozen facts; none reconstruct history from today's target.
authorization is checked on both the occurrence and its current source.

the answer is a state, never an error, for a resource key the viewer may open but
cannot locate: an invisible ref is `unavailable{source_unavailable}`; a publication
that moves during the read is `unavailable{location_unavailable}` with the source's
activation. 404 is only for a quote, citation or retrieval key naming nothing the
viewer can read; a malformed `resource_ref` is 400. a citation key reads for whoever
can read what cites it (a shared dossier's members, not only the edge's owner).

a frozen location is current only while its offsets still name the same normalized
words (`locations.current_locator`): notes also by body version, else a unique
requote; messages whole only; an X post's text offsets by a unique requote; pdf
boxes by publication identity, else a unique quote recovers the page; time ranges by
identity or exact unit bounds and words. capture refuses a publication that changes
under it (409). a span's, chunk's or oracle anchor's current extent is derived once
(`locations.current_passages`): routing gives it an href exactly when capture would
freeze a passage target for it now.

named resource panes consume whole historical arrivals through the shell's
`useSourceArrival` adapter; media, notes and chats own their located adapters.
whole sources validate the canonical destination route; located sources require
the exact owner and a bound source identity. external urls remain native.

the reply has an independent whole-source activation and a `resource`, `located`
or `unavailable` location. located targets carry the existing locator, precision
and nullable source publication identity. previews never determine extents.
missing location disables the passage bullet while a readable source can remain
openable. source access loss removes live enrichment, expansion and actions while
preserving an authorized output's captured text.

the workspace chooses a destination before resolving. follow prefers a matching
origin, then visible matching pane, then any match; otherwise it navigates the
origin. fork always creates a fresh pane/visit without a cap or eviction. resource arrival
parameters do not defeat reuse; collection filters/sorts still define views.

activation/pane/visit identity owns resolution, positioning, painting and focus.
a newer arrival, departure or source replacement cancels the old operation.
same-visit interaction also revokes focus authority. pending identity is saved
before delivery is claimed, so mobile unmount cannot consume it. precedence is
fresh arrival, source-valid visit state, durable reading cursor.

inspection is persistent and separate from saved highlights and composing state.
it ends on replacement, dismissal or return to the reading spot. it reveals the
complete range without seeking playback, editing, changing selection/undo or
writing reading progress. coarse geometry is visibly approximate. note inspection
requires matching acknowledged version and displayed canonical text; a conflicting
draft stays untouched. the displayed media/message must still match the resolved
source before paint. message inspection covers complete messages; partial raw-markdown
ranges are unavailable rather than presented as exact rendered selections.
forks share domain drafts and one durable cursor, but never
clone pending commands.
