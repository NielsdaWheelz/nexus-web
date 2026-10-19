# resource references

a resource has one identity; each place showing it is an occurrence. an occurrence
owns its relationship, rank and folded state. it does not own replacement content
or a second resource identity. chat context, connections, search, notes, quotes,
citations and source previews compose this contract. ordinary collection indexes
and conversation messages keep their layouts.

## owners

| owner | responsibility |
| --- | --- |
| `schemas/resource_items.py` | generated wire for bounded bodies, attribution, capabilities and source targets |
| `services/resource_items/items.py` | batched, visible, bounded current-resource projection |
| `schemas/resource_evidence.py` | frozen words, attribution and complete target |
| `services/resource_items/evidence.py` | capture, historical projection and authoritative source resolution |
| `components/resources/ResourceBody.tsx` | literal content, colour, omissions and search emphasis |
| `ResourceLink.tsx` | compact title/recorded-label links and availability through canonical activation; no fetching or graph controls |
| `ResourceOutlineRow.tsx` / `ResourceOutlineList.tsx` | separate disclosure/open controls, recursive direct links and occurrence state |
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

the resource outline row is `▸ • content`: the arrow expands; the bullet opens; a source label
opens the whole source. body and annotation text select/copy. native modifiers
remain browser-owned except shift-click and shift-enter, which create and focus
a fresh pane. touch retains an explicit open-in-new-pane action. no stretched body link.

lists use nested `ul/li` and labelled buttons, not a custom keyboard tree.
branches start collapsed and load one exact, paged adjacency hop, both directions
and every existing origin; unaccepted suggestions are absent. root filters do not
filter children. edge paths key folds; a repeated resource elsewhere is independent.
ancestor cycles stop with `already shown above`. failures retain loaded children
and offer local retry. expansion never changes prompt scope.

notes place their ordered editable children before other relationships and remove
duplicate edge ids. graph-only children do not join structural selection, dragging,
deletion or undo. editor embeds use the same resource row; full note reads batch
their immediate `embedded_item`. the command launcher and link picker use the shared body inside their existing
index/selection semantics; full search uses recursive rows.

reader connections use measured source positions and row heights, packing without
overlap. expanded children contribute height. the focused root stays mounted beyond
overscan and holds the focused control's viewport position until focus leaves.
independent list scrolling enters browse flow; mobile always uses ordinary flow.

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
