# pane controls: less form, more collection

date: 2026-09-25
status: research; direction approved 2026-09-25; implementation belongs to [the plan](pane-controls-plan.md)
baseline: cfa27d6ce
scope: collection filter/sort presentation and the duplicate pane menu command

## verdict

remove the collection menu's "search this pane" entry. it focuses the existing
input; it is not a second search capability. retain the active-pane keyboard
command, document find, and page/note editor filtering.

replace the permanent expanded form with a quiet collection row: text input,
readable current order, and a filters trigger where structured filters exist.
disclose the editors; expose the applied constraints. retain truthful partial,
retained, failed, and complete result states.

this revises the presentation policy in
[the previous contract](collection-controls-plan.md), whose always-visible,
wrapping form is substantially responsible for the current result. this report
no longer owns implementation detail; [the approved plan](pane-controls-plan.md)
supersedes the relevant presentation policy. the earlier
[council](collection-controls-council.md) already distinguished visible state
from expanded configuration; its implementation policy failed to preserve
that distinction.

## method and evidence limits

three native subagents reviewed architecture, comparable products, and
interaction/accessibility. the parent independently checked the key code,
source documents, and research, then reconciled their recommendations.
disciplinary positions below are analytical perspectives, not human experts
who inspected this product.

this is a source audit and web research, not a rendered visual or usability
test. no authenticated browser, touch, or screen-reader journey was run.
product docs establish documented behavior; user reports reveal failure modes,
not prevalence. research from image retrieval and commerce needs judgment when
transferred to a personal reading workspace. numerical size targets below are
design proposals, not measured improvements.

## what the code actually does

frontend paths in this report are relative to `apps/web/src/`.

| evidence | consequence |
| --- | --- |
| `components/workspace/PaneShell.tsx:344-347,458-470` | the collection menu command calls the existing `collection.focusInput()` |
| `components/workspace/WorkspaceHost.tsx:1386-1419` and `PaneShell.tsx:362` | shortcut dispatch is independent of the menu projection; removing the menu row need not remove cmd/ctrl+f |
| `components/workspace/usePaneCollectionInput.ts:7-25` | explicit focus scrolls the pane body to its input, focuses it, and selects existing text |
| `components/ui/PaneToolbar.module.css:83-104` | at widths up to 479px, search, filters, and status/actions become full-width groups; below 360px, labelled selects also become full width |
| `components/workspace/PaneShell.module.css:88-94` | separate background, border, and 12px vertical padding make the controls a conspicuous panel |
| `components/ui/SelectField.module.css:1-10` | labels stack over selects with another gap |
| `components/workspace/PaneCollectionBar.tsx:79-88` and `lib/panes/paneFilterRows.ts:59-76` | routine counts and exceptional result states both render as visible prose |
| `app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx:678-686` | reset occupies space even when disabled |

changing padding alone cannot remove the three-group layout. conversely,
removing the count/status channel would erase real information. the responsible
layer is collection presentation, with domain composition revised alongside it.

| context | meaning of the text input |
| --- | --- |
| authors, chats, notes index, libraries, library entries, podcasts, episodes, lectern | local substring filtering over loaded rows and domain-selected fields |
| search | remote debounced retrieval; `app/(authenticated)/search/SearchPaneBody.tsx:252-279` |
| browse | explicitly submitted provider query; `app/(authenticated)/browse/BrowsePaneBody.tsx:271-316` |
| imports | explicitly committed remote query; `components/imports/ImportsWorkspace.tsx:343-386` |
| page/note editors | transient filtering of direct authored items |
| documents and individual conversations | occurrence find with navigation and reading-position behavior |

`lib/panes/paneRowFilter.ts:1-11` implements trimmed, nfc-normalized,
case-insensitive substring matching. it does not search document contents.
`usePaneFilterRows.ts` owns visit-local text; domain view codecs and
`usePaneUrlState.ts` own persistent pane-url refinements. in-place refinement
preserves local text; a different source retires it.

## philosophy

a collection should remain intelligible while being changed. four facts explain
it: its scope, the constraints excluding rows, its ordering, and whether the
result is complete. those facts deserve visible expression. every possible
way to edit them does not.

visual simplicity means reducing competing decisions while preserving this
explanation. a blank interface that conceals active constraints merely moves
the work into memory. an always-expanded form spends attention on choices the
user is not making. both are failures of hierarchy.

delight comes primarily from preserving intention: the right pane responds,
the next keystroke lands where expected, clearing one condition leaves the
others alone, and an empty result tells the truth. animation cannot compensate
for an unexplained list or stolen focus.

the professional invariant is semantic ownership. scope and retrieval belong
to the domain; presentation and focus mechanics belong to the shared controls.
uniform appearance should make operations learnable without pretending that
publication chronology, manual order, provider relevance, and last activity
are interchangeable.

## precedents worth borrowing

| source | documented behavior | transfer and limit |
| --- | --- | --- |
| [linear search](https://linear.app/docs/search) | cmd/ctrl+f narrows the current view by title/id; escape clears; broader workspace search is separate | preserve the contextual shortcut and temporary narrowing. its keyboard entry is not sufficient discoverability for nexus touch use. |
| [linear display options](https://linear.app/docs/display-options) and [filters](https://linear.app/docs/filters) | ordering/display and membership filters are distinct, contextual capabilities | use separate readable order and filter access. do not import a general view builder. |
| [things tags](https://culturedcode.com/things/support/articles/2803581/) | relevant tags are exposed in mac lists; mobile uses menu access and active filter presentation | keep contextual vocabulary and applied state. hiding vocabulary has a discoverability cost. |
| [notion views](https://www.notion.com/help/views-filters-and-sorts) | view settings contain property filtering, sorting, and other presentation choices | distinguish the collection from its editable view. a database configurator is excessive for a reading pane. |
| [zotero search](https://www.zotero.org/support/searching) and [sorting](https://www.zotero.org/support/sorting) | quick-search modes distinguish metadata from attachment contents; column sorting exposes direction | make coverage and order inspectable. borrow the clarity, not the table layout. |
| [readwise search](https://docs.readwise.io/reader/docs/faqs/searching) | filtered metadata views and full-text search remain distinct; integrating scoped search and sorting is documented future work | treat this discontinuity as a warning. changing nexus labels cannot create missing full-text scope. |
| [carbon tables](https://carbondesignsystem.com/components/data-table/usage/) | supports both open and collapsed search and compact toolbar compositions | input disclosure is a contextual choice, not a universal design law. |

these are useful features, not an objective league table of products.

[notion users](https://www.reddit.com/r/Notion/comments/1causbz/the_one_option_i_wish_notion_had/)
describe persistent filter/search controls consuming limited mobile space.
[things users](https://www.reddit.com/r/thingsapp/comments/1ggphyg/tags_are_still_basically_unusable_on_the_iphone/)
describe the opposite failure: hidden tag vocabulary turns recognition into
recall; other participants defend the tidier view or point out existing access.
[readwise users](https://www.reddit.com/r/readwise/comments/1kplxp9/sorting_reader_search_results/)
ask for filtering and sorting to remain available within search. these reports
support testing both clutter and concealment, not claiming universal preference.

[shneiderman's dynamic-query work](https://drum.lib.umd.edu/items/fa80d456-56ae-4f72-916f-a033607b39ec)
examines incremental query adjustments coupled to rapidly updated results.
the applicable principle is short, observable cause and effect. immediate local
filtering should remain immediate; a remote operation must still expose its
latency and preserve its existing submission contract.

[yee, swearingen, li, and hearst's study](https://flamenco.berkeley.edu/papers/flamenco-chi03.pdf)
compared faceted browsing with a baseline using 32 art-history students and
35,000 images; 90% preferred the faceted interface. this supports meaningful
dimensions for exploration, not permanent expansion of every control or any
particular toolbar height.

[baymard's applied-filter research](https://baymard.com/research-articles/how-to-design-applied-filters)
supports a visible overview of selected constraints and easy removal. its
commerce context limits direct generalization, but the causal problem transfers:
people cannot interpret missing results when they cannot see what excludes them.

## council: questions, agreement, dissent

| perspective | question it would insist on | recommendation and objection |
| --- | --- | --- |
| product / information architecture | is this retrieving new material, narrowing a list, or finding a passage? | name scope truthfully; reject a universal "search" interaction that hides distinct contracts |
| visual design | what must be seen while reading, rather than while configuring? | one low-emphasis row aligned with content; reject the separate panel of field boxes |
| interaction design | where does the next keystroke go after clear, selection, dismissal, or a delayed response? | stable input, reversible edits, explicit focus return; reject elegant-looking focus loss |
| accessibility | are current constraints, changed results, and each target perceivable and operable? | visible text and adequate targets; reject icon-only meaning, tiny hit areas, and clipped labels |
| retrieval / data systems | does zero mean no matches, or no matches among loaded rows? | retain scope/completeness and old-view warnings; reject cosmetic certainty |
| architecture | which owner knows what changed and what must survive? | reuse domain state and existing publication; reject duplicate query state or a general toolbar/query engine |

agreement: remove the duplicate collection menu entry; separate visible state
from expanded editors; retain keyboard access, domain semantics, and truthful
results. all regard changing only spacing as an incomplete fix.

the genuine disagreements and decisions are:

- **permanent input or expandable affordance:** expansion saves width but adds
  an entry step and disclosure/focus state. choose a small visible input for
  this iteration; it preserves direct touch access and avoids a new mode.
- **visible order or one combined view menu:** a single menu is visually quieter
  but conceals how the collection is arranged. choose the current order as the
  trigger. the cost is persistent horizontal space.
- **all active chips or summarized count:** a count saves space but does not
  explain missing rows. show actual constraints and allow wrapping. a second
  row carrying active information is justified. do not add an overflow-chip
  disclosure solely to satisfy an arbitrary one-row rule.
- **sticky or scrolling controls:** sticky controls help repeated adjustment
  but permanently consume reading area. keep the existing body scrollport;
  cmd/ctrl+f already brings the input into reach. pointer users must scroll back.
- **native select or custom sort widget:** prefer a compact native select when
  it can express the value clearly. accept less visual control over its popup
  in exchange for established keyboard and mobile behavior. custom radios need
  a concrete benefit, not merely a desire to redraw the operating system.
- **immediate or staged structured edits:** retain immediate application for
  current simple facets and preserve remote draft/commit forms. an apply/cancel
  transaction would add state and delay feedback without a present need.

unknown usage frequency remains relevant: idk whether sort changes or typed
filtering dominate this user's day. the visible-input choice is a judgment,
not a telemetry result. no instrumentation project is justified to settle it;
ordinary use of the proposed layout can answer it.

## proposed anatomy

schematic, not a rendered mockup. square brackets indicate controls.

```text
author works, idle
[filter titles…              ]  [oldest published v]
24 works

library, constrained
[darwin                    x]  [recently added v]  [filters 2]
[pdfs x]  [unfinished x]                          8 of 24 entries
```

exact nouns come from supported domain options: library types include web
articles, epubs, pdfs, videos, podcast episodes and podcast shows. do not invent
an unsupported "books" or "media" facet.

the input and order sit on the collection's existing surface. use row alignment,
quiet borders, and typography; remove the tinted outer filter panel. avoid
stacked "sort by" captions when the control itself can express the current
order. expose its full accessible name, such as "sort works: oldest published".
the full option text remains available without hovering.

aim for 32px desktop controls with modest vertical spacing, around a 40–48px
idle control row. use approximately 44px touch targets where coarse input is
in play. these are proposed sizes to verify against existing tokens and actual
layouts; [wcag's minimum target guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
is a floor, not a reason to make every touch target as small as possible.

respond to pane width, not window width. shorten the idle placeholder before
reducing input usefulness. permit wrapping at narrow widths or increased text
size; no horizontal toolbar scrolling or clipped active sort label. normal
idle layouts should not reserve three rows simply because the pane is narrow.

put the concise result summary at the list boundary, sharing available space
with active criteria where it fits. complete idle: "24 works". complete local
filter: "8 of 24 works". partial: "8 matches in 50 loaded; loading more".
retained: "updating; showing previous results". failed: "update failed; showing
previous results" with the existing retry affordance. these are distinct states,
not variants of a decorative count. do not announce a successful new ordering
while showing the previous one.

## interaction contract to carry into implementation

| action or state | proposed behavior |
| --- | --- |
| enter a collection | controls are available without stealing focus; idle defaults need no removable chips or disabled reset button |
| activate cmd/ctrl+f | focus and select the active pane's input, bringing it into view; retain responsive handoff and unsupported-pane browser behavior |
| type in a local filter | narrow rows immediately; keep focus, source, sort, and other constraints |
| use clear text | clear only text and keep focus in the input; the button has an accessible name |
| press escape | the innermost open editor handles dismissal first; otherwise local input clears text. remote inputs retain their current draft-only clearing rules |
| select sort | apply the supported criterion/direction, preserve constraints, and return to the stable sort control; fixed order is text with no false dropdown |
| open filters | show domain-owned fields in a labelled anchored form; focus its first appropriate control; keep it open across multiple facet changes |
| dismiss filters | close the editor without clearing applied constraints; restore keyboard dismissal to its trigger; outside pointer dismissal respects the clicked target |
| remove a chip | remove that constraint only; move focus to the next removal control, or the stable filters trigger when none remain |
| clear structured filters | restore those facets' defaults while preserving text and order; use explicit scope in the label, not ambiguous "clear all" |
| reset view | put the existing all-view reset in the filters editor when the view differs from default; on sort-only panes, show a quiet reset action beside a non-default sort. clear text/facets and restore default sort while preserving route identity and domain scope; return focus to a stable control. text-only changes already have the input clear action |
| receive delayed results | keep current focus and text; never refocus an editor the user has left; preserve existing latest-request-wins and retained-row semantics |
| get zero matches | retain the controls and constraints; distinguish a complete empty answer from partial loading; offer the narrowest useful clear action |
| change source | retire visit-local text as today; sorting/filtering within the same source preserves it |

an anchored form is not an aria menu full of arbitrary input fields. reuse the
existing floating-surface and modal machinery with the appropriate semantics.
if a phone cannot accommodate the form, use the existing sheet presentation
with the same fields and state; no separate mobile filter implementation.
modal sheets follow [the dialog focus contract](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

one status owner should announce settled result changes, including restoration
after clearing. [w3c's status guidance](https://www.w3.org/WAI/WCAG21/Understanding/status-messages)
explicitly covers search-result messages. avoid duplicated announcements from
the existing exhaustion and error owners. initial idle mounting should remain
quiet; ordinary typing should not produce an announcement for every keystroke.

## architecture and proportional scope

retain `PaneCollectionPublication`'s existing `{label, content, focusInput}`
contract unless concrete composition work proves a change necessary. keep
query/view codecs, retrieval, pagination, source identity, and reset semantics
with their present domain owners. disclosure state belongs beside the controls.

`PaneCollectionBar` and the collection wrapper in `PaneShell` own the visual
revision. domain panes compose their current sort, filter editors, and applied
state. adapt browse/search/import presentation while preserving each query's
execution contract and operational navigation. author sort-only panes must not
acquire an empty filters button. authored-order panes must not acquire invented
sort options.

reuse native inputs/selects and applied chips. current `AppliedFilters` labels
its broad action "Clear all"; make the proposed scope explicit when used here.
reuse existing floating geometry and sheets; build only the small collection
composition needed to give the editor coherent focus/dismissal behavior.
`FloatingActionSurface` supplies geometry/dismissal, not a complete accessible
form lifecycle by itself.

some domain owners currently refocus select refs after commits, for example
`AuthorPaneBody.tsx:314-323`. relocation/disclosure must account for those effects:
late responses may not pull focus into closed controls or undo a later user
action. do not add another focus owner alongside them.

scope the styling explicitly to collection controls. `PaneToolbar` also serves
document instruments and transient editor filters, so changing all refinement
or instrument css indiscriminately would exceed this decision.

no backend, database, new query syntax, saved-view system, dependency, feature
flag, compatibility layer, general toolbar registry, or permanent test harness
is justified. cut over the supported collection surfaces together; delete
replaced markup, styles, and the collection menu branch. update the old plan,
architecture table, and pane/workspace docs when implementation is approved.

## acceptance and open findings

later implementation: run `./scripts/test` for static consistency. manually
verify a sort-only author pane, a library with several constraints, authored
order, remote query forms, and document/editor find. inspect idle, active,
empty, partial, retained-failure, and loading states at wide/narrow pane widths,
mobile touch, keyboard-only use, and enlarged text.

particularly verify two-pane shortcut isolation; offscreen input focus;
escape and outside dismissal; last-chip removal; reset focus; no focus stealing
after delayed commits; and one useful screen-reader result announcement after
clear. these checks address concrete risks; no broad test-system reconstruction.

recorded separately, with exact evidence and acceptance:

- [excessive permanent collection controls](tickets/collection-controls-reserve-too-much-pane-space.md)
- [duplicate collection menu search](tickets/collection-menu-search-duplicates-existing-input.md)
- [suppressed restored-result announcement after clear](tickets/clearing-collection-filter-suppresses-result-announcement.md)

application code is unchanged. static gates and live behavior are not run for
this research-only change. unrelated concurrent work is preserved.
