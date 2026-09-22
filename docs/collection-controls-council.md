# collection controls council

date: 2026-09-22
status: research; implementation decisions belong to collection-controls-plan.md
scope: author chronology and collection presentation across the app

## recommendation

make collection controls visible on entry. share their anatomy, labels, focus
behavior, state presentation, and row components. retain domain-owned scope,
filter semantics, ordering, retrieval, and actions.

the user confirmed oldest first, date ascending. author chronology should use original-work
publication dates, unknown dates last, and deterministic ties. correct the
gutenberg date substitution before treating that chronology as trustworthy.

the app already has shared collection rows. the main change belongs to the
pane controls contract. do not build a second list system.

## method and limits

three native subagents independently audited architecture, interaction and
accessibility evidence, and comparable products. the parent checked the
responsible code, reviewed source documents, and reconciled the recommendations.
the council below represents disciplinary perspectives, not named human
experts who reviewed the product.

this is a static source audit and web research. no authenticated app session,
mobile layout, or keyboard journey was exercised. product documentation
establishes documented behavior; studies establish findings within their
studied populations; forum posts supply failure cases, not prevalence estimates.
recommendations are judgments drawn from those sources and this repository.

## the governing concept

a collection view answers four questions: what material is in scope, which
constraints are active, why this item comes first, and whether the result is
complete. its controls make that explanation inspectable.

consistency should let a learned operation transfer between contexts. the same
sort control can express publication chronology, last activity, or authored
order without claiming those concepts are interchangeable. an author page
invites study of a body of work; a chat index invites resumption; a queue
expresses intention. defaults are judgments about those purposes.

progressive disclosure can hide complicated editors. hiding the current order
and active constraints makes the collection harder to understand. the useful
distinction is visible state versus expanded configuration.

## what the repository already does

frontend paths below are relative to `apps/web/src/`; pane paths are under
`app/(authenticated)/`.

| surface | current components and controls | current order |
| --- | --- | --- |
| author works | `CollectionView`, shared rows, hidden pane controls; `authors/[handle]/AuthorPaneBody.tsx:603,636,811` | publication newest; oldest and title alternatives |
| chats | shared collection and hidden pane controls; `conversations/ConversationsPaneBody.tsx:436,469,551` | updated newest |
| notes index | shared collection and hidden pane controls; `notes/NotesPaneBody.tsx:290,323,489` | updated newest |
| libraries index | shared collection and hidden pane controls; `libraries/LibrariesPaneBody.tsx:548,581,787` | created oldest |
| library entries | shared collection and hidden pane controls; `libraries/[id]/LibraryPaneBody.tsx:1629,1753,2253` | recently added in the default library; authored order in named libraries |
| followed podcasts | shared collection and hidden pane controls; `podcasts/PodcastsPaneBody.tsx:686,792` | recent episode |
| podcast episodes | shared collection with episode controls; `podcasts/[podcastId]/PodcastDetailPaneBody.tsx:944`, `PodcastEpisodeList.tsx:254` | newest; oldest and duration alternatives |
| lectern | shared collection and hidden pane controls; `lectern/LecternPaneBody.tsx:334,392,474` | authored order |
| browse | shared collection in provider sections; custom visible toolbar; `browse/BrowsePaneBody.tsx:270,341`, `components/browse/BrowseSection.tsx:285` | provider relevance; youtube additionally supports newest |
| search | shared collection and custom visible toolbar; `search/SearchPaneBody.tsx:505` | relevance |
| imports | `ResourceList`, `ResourceRow`, and visible `PaneToolbar`; `components/imports/ImportsWorkspace.tsx:342,610` | operational views and history, with recovery actions |

`CollectionView.tsx:36-39` already assigns retrieval and toolbar content to
panes while retaining shared row presentation. its body uses `CollectionRow`
and `ResourceList`; `CollectionRow` delegates layout to `ResourceRow`.
presenters project domain objects into that shared anatomy.

the responsible visibility boundary is
`components/workspace/PaneShell.tsx:305-312,407-412`: both collection filtering
and document find require expansion. `PaneSearchBar.tsx:383-390` gives
collection controls a close button; its escape handler dismisses the bar.
this is current documented policy, not accidental author-page markup:
`docs/modules/panes-tabs.md:47-66` and `docs/modules/workspace.md:122-143`.

there are two important traps:

- `FilterRows` also serves page and note editors
  (`pages/[pageId]/PagePaneBody.tsx:191`, `notes/[blockId]/NotePaneBody.tsx:94`).
  making every `FilterRows` publication permanent would conflate editor find
  with collection browsing.
- `PaneShell.tsx:322-325` focuses the input when expansion changes. merely
  forcing expansion would steal focus on entry. visibility and focus need
  separate intent.

## what to borrow

| precedent | documented behavior | applicable lesson and limit |
| --- | --- | --- |
| [readwise reader](https://docs.readwise.io/reader/docs/faqs/filtered-views) | author, tag, and feed navigation create filtered views over a common document database | author navigation should reuse collection machinery. nexus still needs its existing broader contributor-work scope, including external catalogue entries. |
| [calibre](https://manual.calibre-ebook.com/gui.html) | author/tag selections restrict the existing book list; visible search expressions and saved searches describe selections | navigation and filtering can compose transparently. advanced query syntax need not be required for ordinary browsing. |
| [linear display options](https://linear.app/docs/display-options) | views share display operations but expose different capabilities; preferences persist per view; reset restores defaults | share a language with contextual policy. its settings menu is not evidence that all editors should be permanently expanded. |
| [linear filters](https://linear.app/docs/filters) | main applied filters are represented in urls; available filters depend on the view | make views reproducible. linear excludes some display/quick-filter settings, so nexus must define its own complete url contract. |
| [zotero sorting](https://www.zotero.org/support/sorting) | column headers change sorting and show direction; secondary sorting resolves ties | expose order directly and make ties stable. a bibliographic table is useful precedent, not a reason to turn narrow mixed-media panes into spreadsheets. |
| [apple podcast ordering](https://podcasters.apple.com/support/3143-how-to-set-the-order-of-podcast-episodes) | episodic shows emphasize recent episodes; serial shows use episode sequence, with season and trailer rules | order answers where to begin. serial sequence is not simply ascending publication date. |
| [pocket casts](https://support.pocketcasts.com/knowledge-base/episode-sorting/) | newest-first default, per-podcast choices; web sort icon, mobile overflow access | use human-readable directions and contextual choices. the mobile extra step illustrates the discoverability cost the user wants removed. |
| [notion views](https://www.notion.com/help/views-filters-and-sorts) | one database supports views with independent layout/filter/sort settings | separate material from its view. a general database configurator would exceed this task. |

these are useful exemplars, not an objective ranking of entire products.

## evidence and dissent

[yee, swearingen, li, and hearst's chi 2003 study](https://flamenco.berkeley.edu/papers/flamenco-chi03.pdf)
compared faceted browsing with a conventional image-search interface using
32 art-history students and 35,000 images. about 90% preferred the faceted
approach. the study supports meaningful dimensions for exploratory work; it
does not settle whether this app should pin a toolbar or display every filter.
the paper also describes prior users avoiding an interface with roughly
40 form controls. expressiveness and legibility have to coexist.

[baymard's applied-filter research](https://baymard.com/research-articles/how-to-design-applied-filters)
supports keeping active constraints visible and removable. its observed
failures include uncertainty about active filters and difficulty undoing them.
the evidence comes from commerce; applying it to a personal research library
is a reasoned transfer, not a direct measurement here.

[carbon's table guidance](https://carbondesignsystem.com/components/data-table/usage/)
provides common toolbar anatomy while supporting open and collapsed search.
borrow stable placement and composable controls; it supplies no universal
mandate to expand every option. [nn/g's mobile faceted-search discussion](https://www.nngroup.com/articles/mobile-faceted-search/)
explains the competition between meaningful results and extensive filters on
a narrow screen.

user reports expose both sides. [readwise users asking for sortable search
results](https://www.reddit.com/r/readwise/comments/1kplxp9/sorting_reader_search_results/)
describe losing familiar collection operations after searching. reader's
[search documentation](https://docs.readwise.io/reader/docs/faqs/searching)
still distinguishes full-text search from filtered views. the inference for
nexus is that consistent markup alone cannot repair inconsistent capabilities.

[notion users objecting to always-visible filters](https://www.reddit.com/r/Notion/comments/1causbz/the_one_option_i_wish_notion_had/)
cite mobile space and clutter. this 2024 anecdote is a counterexample to
universal preference, not a reason to override this user's expressed choice.
[podcast listeners missing an existing sort control](https://www.reddit.com/r/podcasts/comments/vrkggn)
illustrate the opposite cost: functionality can exist and remain undiscovered.

## council positions

| perspective | recommendation | challenge |
| --- | --- | --- |
| product and information architecture | one collection language with explicit scope and contextual defaults | is the author page a bibliography, a feed, or only owned media? preserve current scope until deliberately changed. |
| interaction design | expose text filtering, current order, applicable controls, and active state | do not confuse visible access with permanently open option menus. |
| visual design | keep a quiet, compact control band aligned with shared rows | avoid a stack of decorative boxes or a large filter dashboard above a short list. |
| accessibility | reuse labels, keyboard behavior, focus continuity, and result announcements | opening a page must not focus a filter automatically; sticky controls must not obscure focused rows. |
| bibliography | order original works by original publication and preserve uncertainty | a provider's digitization/release date cannot stand in for the work's date. |
| systems engineering | sort/filter at the owner of the complete eligible collection, before pagination | sorting only loaded rows counterfeits a global sort; local text matching must disclose incomplete loading. |
| maintainability | extend existing primitives and delete real duplication | reject a universal engine that makes every domain implement irrelevant concepts. |

agreement: visible state, common mechanics, explicit domain meaning, stable
pagination, and no parallel author-list implementation.

disagreement: how much screen space to reserve, how broadly to persist choices,
and whether bibliography or recency is the right author default. this user's
stated preference resolves the first-order choices: visible controls and
confirmed oldest-first author chronology.

## implementation

[the implementation contract](collection-controls-plan.md) owns final behavior,
capabilities, api changes, work boundaries, cutover, and temporary live proof.
its hard-cutover url policy and user-authorized temporary tests supersede the
earlier research proposals. this report retains evidence and rationale only.

## recorded work

- [persistent collection controls](tickets/collection-controls-hidden-behind-pane-find-disclosure.md)
- [author default chronology](tickets/author-works-default-does-not-match-requested-chronology.md)
- [mixed original and gutenberg dates](tickets/author-chronology-mixes-original-and-gutenberg-release-dates.md)
- [duplicated contributor vocabulary](tickets/author-work-presenter-duplicates-contributor-role-vocabulary.md)
- [library duplicate-key decoding](tickets/library-view-codec-accepts-duplicate-owned-keys.md)
- [existing missing-contract references](tickets/collection-contract-docs-reference-deleted-cutovers.md)

the existing [narrow collection-row review](tickets/resource-row-narrow-state-layout-is-unreviewed-for-collections.md)
remains relevant to manual layout verification. earlier unrelated reader-map
work in the checkout was preserved.
