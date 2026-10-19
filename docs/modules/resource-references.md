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
| `services/resource_items/items.py` | batched, visible, bounded current-resource projection |
| `schemas/resource_evidence.py` | frozen words, attribution and complete target |
| `services/resource_items/evidence.py` | capture, historical projection and authoritative source resolution |
| `components/resources/ResourceBody.tsx` | literal content, colour, omissions and search emphasis |
| `ResourceLink.tsx` | compact title/recorded-label links and availability through canonical activation; no fetching or graph controls |
| `components/ui/ResourceRow.tsx` | common disclosure, bullet, selectable body and contextual-action shell |
| `ResourceOutlineRow.tsx` / `ResourceOutlineList.tsx` | resource bodies and occurrence-owned recursive lists |
| `ResourceDisclosure.tsx` / `lib/resourceGraph/useResourceOutline.ts` | one bounded mixed adjacency read and local resource-owned composer |
| `lib/resources/metadata.ts` / `ResourceMetadata.tsx` | one factual metadata projection for visible and spoken labels; keyed fields, separators and source activation |
| `lib/media/kind.ts` | shared human media names; unknown structured kinds are defects |
| `lib/resources/sourceTarget.ts` | canonical href to target identity |
| `lib/workspace/targetActivation.ts` / `store.tsx` | destination selection and visit-bound delivery |
| `lib/reader/sourceArrival.ts` | cancellation, source checks and focus authority at the destination |

python paths are relative to `python/nexus`; web paths to `apps/web/src`.
prompt/read bodies remain in `resource_graph/resolve.py`; a list never fetches a
full prompt body for each row.

## presentation contract

`ResourceItemOut` is `{ref, action_ref, label, preview, activation, missing}`.
`ref` owns disclosure; `action_ref` owns resource actions; `label` names accessible
controls and confirmations. `preview` contains `body`, nullable `source` and
nullable `annotation`. every wire key is present and snake_case; absence is null.

| body | primary content |
| --- | --- |
| `named` | title/name; kind and ordered credits are secondary |
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

exact/prose previews have a 600-codepoint budget, each contextual side 48,
annotations 240. image alts share one budget. truncation respects graphemes and
prefers word boundaries; flags describe omitted content. ellipses are rendering,
never stored evidence. omitted quotation tails never touch a nonadjacent suffix.
search match ranges address codepoints in a separate plain excerpt; no inserted
emphasis markup enters saved evidence. geometry-only selections say `selected
region`.

an annotation is the first highlight-note attachment in creation/id order. other
annotations remain reachable through disclosure. notes have no invented owning
page. relationship rationale and link notes belong to the occurrence. captured
quotes never borrow today's colour, annotation or attribution; current annotations
under a historical branch are labelled as current.

## controls and composition

the resource outline row is `▸ • content`: disclosure expands; bullet and primary
reference text navigate through canonical activation. the anchor is inline inside
a clamped text cell, with literal line breaks and phrasing-safe body markup.
metadata, attribution, annotation editors and relationship prose remain separate.
explicit `body` overrides retain their owner's editing semantics.

native modifiers remain browser-owned except shift-click and shift-enter, which
create and focus one fresh pane. touch retains open-in-new-pane. native link text
selection/copy remains available; there is no stretched link or row click handler.
`primaryLinkRef` gives search its existing return-focus target.

editable outlines retain escape/menu block selection. read-only rows and embeds
keep their owner's selection semantics. [notes](notes.md) owns unlink admission,
pending state and history.

editable outline reference content is an atomic named token. its text remains a
native link; unused primary space places a caret. enter creates a sibling after
that exact occurrence; committed prose seeds its note and transfers focus. the
caret never rewrites the reference or persists an `@id` wrapper. source, metadata,
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

reader connections use measured source positions and row heights, packing without
overlap. expanded children contribute height. the focused root stays mounted beyond
overscan and holds the focused control's viewport position until focus leaves.
independent list scrolling enters browse flow. retained source groups keep the
same container across follow/browse layout changes, preserving their inline
editors. follow mode hides unplaced groups rather than unmounting them; measurement
ignores hidden geometry. mobile always uses ordinary flow.

## historical targets and arrival

`POST /resource-items/source-targets/resolve` accepts one key: current `resource`,
saved `reader_quote` message, `citation` edge, or saved `retrieval` id. historical
keys resolve their frozen facts; none reconstruct history from today's target.
authorization is checked on both the occurrence and its current source.

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
