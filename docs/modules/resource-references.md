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
| `components/ui/ResourceRow.tsx` / `ResourceList.tsx` | bounded index/search geometry, wrapping operational details and native title links |
| `ResourceIndexRow.tsx` / `CollectionRow.tsx` | resource-item and collection adapters for the index shell |
| `IndexBibliography.tsx` | compact observed author names and first-publication year; complete credits remain in existing metadata |
| `components/media/MediaIdentity.tsx` | shared index bibliography and passive consumption/remaining-time facts; `MediaFacts` also serves inline search and saved detail |
| `ResourceOutlineRow.tsx` / `ResourceOutlineList.tsx` | outline-owned hierarchy, gold bullets, editors and recursive lists |
| `OutlineSurface.tsx` / `lib/notes/useOutlineSession.ts` | shared rows, structure, selection, continuation and scoped history |
| `ResourceDisclosure.tsx` / `lib/resourceGraph/useResourceOutline.ts` | one bounded mixed adjacency read supplied to the shared surface |
| `ResourceComposer.tsx` | independent chat/message context admission using existing insertion primitives |
| `OutlineInsertionLine.tsx` | one session-owned insertion draft and captured destination |
| `PageTitleEditor.tsx` | canonical root/inline title editing and text history |
| `OutlineCommands.tsx` | accessible icon accessory for the session command interface; the pane shell renders it only on touch-capable devices |
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
| `named` | title/name, ordered credits and nullable live show artwork |
| `media` | canonical `MediaSummaryOut`: title, credits, original publication, consumption and time |
| `passage` | exact words in captured/saved colour with adjacent prefix/suffix |
| `prose` | literal note/message text; code preserves whitespace |
| `images` | image count and up to three alt slots |
| `reference` | an embed note's stored label, or `embedded resource` |

two row families compose the same resource facts. indexes serve collection panes,
search and chat context: native title links, applicable bibliography,
consumption and time, existing resource actions, and podcast-show artwork. indexes
never create outline sessions, disclosure or editors. imports/settings retain their
command primary. only shows have index artwork; episodes never do.

the shell requires `Index` (title and metadata), `Search` (also one excerpt) or
`Details` (wrapping operational/instructional content). index/search reserve empty
lines and ellipsize individual fields; content length and arriving state never
add text lines. typography may enlarge the shared line geometry. when fixed
controls and text minima cannot fit side by side, `ResourceRow` places controls
beside the title and gives metadata/excerpt the full row width, with tighter
spacing. these rows may grow taller; no bibliography or facts disappear to preserve
the former geometry. operational `Details` rows keep their wrapping layout.
`ResourceRow`'s optional compact density keeps this geometry with smaller shared
title/metadata type and padding; native touch target minima remain. the queue
composes the shell with its own occurrence commands rather than generic media
actions. finite collections through 200 mount every row. eligible larger indices
declare `UniformIndex` capability: one actual fractional row
measurement determines the full extent, while visible rows, overscan and bounded
interaction pins determine mounted content. complete data still supplies local
filtering, counts and command captures. native find, selection and accessibility
traversal reach mounted rows only; the app filter covers the complete source.
`Search`, wrapping `Details` and outlines retain intrinsic layout. the
[visual system](visual-system.md#index-rows) owns the common measured slot;
the [pane memento](workspace.md#pane-history) alone restores pane scroll and logical
anchors. the queue's bounded dom measures its homogeneous compact rows; its rendering,
anchoring and partial accessibility-tree contract belongs to
[playback sessions](playback-sessions.md#index-and-interaction).
the row's `indexRow`
container owns adaptation at its explicit base text size: above `32em - 1px`,
show up to three observed author names; at or below that boundary, show the first
and a passive omitted count. the default 15px type gives a 479px boundary;
enlarged text compacts earlier. compact media facts remain visible and do not
shrink or ellipsize. `IndexBibliography` owns a compact, left-aligned author/year
group: no level grows into spare width, and names prefer their natural text width
or a `1em` minimum, whichever is larger. under pressure, names shrink
proportionally toward that minimum and ellipsize individually; commas, omitted
count, separator and year retain natural widths. those protected minima propagate
through the group's allocation. spare width belongs outside the bibliography;
`MediaIdentity` keeps facts trailing within its allocated region, including when
separate context follows. missing facts never stretch the byline.
provenance text grows within the remaining allocation and ellipsizes without raising
the identity's protected minimum.
hidden names leave the tab order; focused hidden
links/shortcuts return to that row's surviving more/title. no surname inference or
author-only control.
source/evidence links own their ellipsizing boxes; bounded metadata/excerpt links
draw focus rings inside those boxes so line clipping never hides the indicator.

search uses one literal evidence line: a matching passage wins over an item's own
match, and its link retains that passage's exact activation. prose titles identify
their source/kind rather than repeat the evidence. complete evidence requires
navigation; the index never recursively expands matching results. failure marks
decorate the existing stable more control, whose label names the real recovery
destination. chat mutation failures retain their supplied commands and use the
workspace condition owner. static unavailable rows show a bounded reason.

outlines serve notes, pages and connections: a gold opening bullet, actual
disclosure, editable note/annotation prose and page titles, and a quiet resource
ellipsis. immutable references show title, ordered authors and original publication
in one wrapping flow. no consumption, duration, artwork or inline playback/library
controls mount in an outline. source/quoted attribution, machine-content marking,
unavailable/conflict/unsaved state and operation failures remain visible.

`resourceMetadata` projects bibliography separately from occurrence/source facts.
`MediaIdentity`, `ResourceBody` and `ResourceMetadata` share
formatting without owning family geometry. publication keeps year/month/day
precision in semantic time markup. omit unknown facts and their separators; use
readable secondary text, natural wrapping and full authored bodies. title anchors
contain only phrasing content, never editors, metadata or controls.

`MediaFacts` shows a natural-width remaining estimate of at most three characters
followed by a 0.875rem theme-accent indicator (14px at the default root size).
unread is a solid disc; in-progress removes
the clockwise saved-position sector from twelve o'clock with a continuous outline;
unknown position has a dashed empty outline; finished is a check and omits time.
state wins over percentage. position is a bookmark, not consumed coverage, and
may move backwards. zero/one never imply a different state. details call it
`saved position`. external media without a summary has no consumption facts.

remaining labels choose the smallest unit whose ceiling fits: minutes, hours,
days and weeks through 99, then 365-day years through 9; larger values are `>9y`.
zero is `0m`; absent estimates have no slot. speech retains supplied minutes,
names the estimate and reading/listening modality, and calls audio normal-speed
time. glyph/time expose one expanded sentence, with no interaction, focus stop,
live region, animation or fetch. transparent svg cutouts inherit the accent;
forced colours use system text. facts anchor to their allocated identity region;
direct consumers keep their existing inline placement and wrapping.

bounded metadata leaves inherit spacing from `ResourceRow`: `--row-metadata-gap`,
`--row-media-gap` and `--row-publication-gap`. the shell alone owns their responsive
cutover. `MediaIdentity` and `IndexBibliography` compose inside that shell;
standalone detail uses full bibliography with `MediaFacts`.

live media bodies use one existing summary batch. adapters retain supplied live
summaries through `MediaSummaryProvider`: acknowledged facts survive refresh
failure; null resolution means unavailable. historical bodies remain captured,
with no live retention/subscription or artwork enrichment. no per-row detail fetch
or new refresh clock exists. disappearance during hydration removes the old identity
and activation together. `MediaIdentity` and `ResourceMetadata` render canonical
bibliography once; index consumption composes separately. occurrence, location,
evidence and relationship facts keep their own identity.

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
page. relationship rationale belongs to the occurrence. captured
quotes never borrow today's colour, annotation or attribution; current annotations
under a historical branch are labelled as current.

## controls and composition

native title/bullet click and enter follow canonical activation; shift-click and
shift-enter create one fresh pane. other browser modifiers and title context menus
remain native. immutable references have no editor. unused primary space selects
the exact occurrence without a soft keyboard. [notes](notes.md) owns structural
keys, item-text focus, canonical page-title history and the pane's touch command accessory.

the resource ellipsis has the same canonical `action_ref` actions in either family.
loaded open/fork actions are omitted; `any-pointer: coarse` adds one local fork
from the displayed activation, preserving exact passage location. management of a
different source is labelled `source: {label}`. changed subject/activation retires
the open menu. no row-local structural command or relationship removal belongs in
this menu.

right-click, context-menu key, shift-f10 and stationary touch hold on the bullet
open the relationship menu through `ActionMenu`'s context anchor. movement, scroll,
cancel or lost ownership aborts the hold; a completed hold consumes its click.
opening never executes. authorized exact unlink preserves both resources and all
other edges. unavailable navigation can retain a focusable context-only bullet.
provenance details keep useful creation/rationale; routine “linked by” is omitted.
chat context uses an independent accessible remove control and its supplied
aggregate `detach_context` mutation, never one arbitrarily chosen admission edge.

lists use nested `ul/li` and labelled native controls. branches start collapsed and
read one bounded exact adjacency hop. root filters never filter children. a
traversed edge is omitted; a distinct edge to an ancestor remains a terminal
reference with an upward-return button. refs identify ancestors, edge ids identify
facts, occurrence paths identify folds. no branch-focus/zoom or internal structural
drag state remains. one outline-level horizontal scroll owner accommodates extreme
depth; the command accessory lives outside it.

disclosure tests the complete projected child graph with exact occurrence exclusions,
independently of loaded adjacency pages. canonical authored children are read from
local indexed state; server-owned facts have separate bounded, batched availability.
saved passage-owner adjacency counts too. empty or unconfirmed rows reserve inert
control slots; confirmed nonempty rows alone have expand/collapse buttons. terminal
return controls remain navigation. availability never closes a branch or unmounts
writing. removing a focused chevron returns focus to the same occurrence's bullet.
ordinary insertion and nesting keep their existing local command owners.

highlight annotations remain full canonical bodies before disclosure. suppress
only the selected annotation's exact attachment edge; parallel facts survive.
terminal annotation repeats retain read-only rich bodies and atomic embed links.
annotation child insertion belongs to the annotation note, not the highlight.
reader roots and source-owned membership never invent an incoming graph mutation.

arranged adjacency keeps endpoint-owned rank/version/capabilities. indexes retain
their own order. embeds share canonical body and batched `embedded_item`, while the
containing note retains its own identity. only the exact directed nonordinal
`note_body`/`context` embed edge is suppressed. empty states require settled,
exhausted reads without visible children or failure. index snippets, inline
citations, picker options and document matches retain their existing semantics.

a transient insertion composer captures one destination per editing session.
focus/render writes nothing. typed prose or explicit insert admits existing
creation; `@` remains query-local until accepted or escaped to literal prose.
unfinished/uncertain input keeps its original owner, ids and slot. source passage
candidates and their durable anchor sequence retain separate versions and facts.
external resource/file admission and flat index sorting retain their existing owners.

reader connections use measured source positions and row heights, packing without
overlap. expanded children contribute height. the keyboard-focused root stays
mounted beyond overscan and retains its control position until attention leaves.
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
can read what cites it, not only the edge's owner.

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

## suggestion interaction

`useReferenceInput` keeps the journal's reference intent and insertion context.
it consumes the [shared search bindings](visual-system.md#collections-and-searchable-pickers)
for generated option ids, keyed navigation and scoped reveal. `useLinkTargets`
owns raw-query debounce and exact admission, with endpoint-qualified read keys
and invalidation after graph/resource changes. the current `NoteEditor` and
outline insertion line share these bindings; suggestions stay bounded and inline.
editor transactions, authored snapshots, undo and context review remain with
the existing journal and outline owners.
