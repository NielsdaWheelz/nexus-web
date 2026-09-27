# roam bullet and writing reference

status: researched reference; proposed acceptance; no live parity claim
date: 2026-09-25
scope: writing and outline interaction inside nexus notes and annotations.
product navigation, offline application support, and the full roam suite are
outside the current change. outline-local focus is an editing operation.

## evidence and limits

primary evidence below comes from roam's published syntax/schema repository,
developer release notes in the app store, and competing products' own docs.
roam's public help graph is a javascript application that the web reader did
not expose. its [machine-readable mirror](https://roamdocs.fyi/) identifies
itself as a third-party export of the public help/developer graphs, last
exported 2026-09-20. mirrored statements are documentation evidence, not direct
observation. the mirror's canonical links below work without a `.md` suffix.

confidence labels: **primary** means directly published by the product owner;
**mirror** means exported help, awaiting live corroboration; **conflict** means
sources disagree; **unknown** means the exact outcome was not established.
no mouse, touch, keyboard, latency, accessibility, or crash-survival behavior
was exercised in a running reference app during this pass.

## what the model actually says

roam's own schema reference gives blocks stable identity, raw text, sibling
order, immediate children, ancestors, containing page, and outgoing references.
page-reference query matching can inherit context from a parent. moving a block
can therefore change meaning, not merely its horizontal position.
[official query/schema reference](https://raw.githubusercontent.com/Roam-Research/roam-tools/master/skills/roam-syntax/references/queries.md)

one bullet represents one block. a soft break stays inside that block.
`[[page]]` links and creates a missing page; `#tag` is another page-link rendering.
`((uid))` displays referenced text inline; `{{embed: ((uid))}}` exposes the live
editable block and its children. an alias supplies link text; a copied string
is independent content. numbered and document views change child presentation.
roam's stored formatting differs from common markdown: `__text__` is italic;
headings and child view type have structural metadata.
[official syntax reference](https://raw.githubusercontent.com/Roam-Research/roam-tools/master/skills/roam-syntax/references/syntax.md)

the public developer documentation describes an in-memory datascript graph,
separate internal entity ids and persistent block uids, and a block's direct
parent through the reverse children relation. it also exposes collapse state.
these are model facts in mirrored documentation, not proof of roam's current
rendering, editor engine, save scheduling, transaction log, or sync algorithm.
[developer model mirror](https://roamdocs.fyi/developer-documentation/data-model)

the official tools expose create, update, move, delete, current selection, and
window navigation. they explicitly warn that api bulk changes do not have a
traditional undo history. api mutation support does not establish ui undo
semantics. copying roam's implementation is neither possible from these sources
nor necessary to reproduce its observable writing contract.
[official tools repository](https://github.com/Roam-Research/roam-tools)

## the ownership question nexus must settle

this is an architectural recommendation, not an inferred roam implementation.
distinguish a content node from an occurrence through which the user sees it.
if the same nexus note appears on two pages, does indenting a child under one
appearance change the other? exact roam semantics point toward one canonical
containment tree plus references/embeds. occurrence-local children preserve
contextual variation but intentionally depart from that model.

do not pick the migration from screenshots. first census existing repeated
placements, nested context edges, cycles, and referenced content. show before
and after examples. specify which identity survives split/join, what deleting
a placement means, and whether reference deletion changes source content.
stable identity does not by itself answer any of those questions.

the apple foundation should own document state, text selection, composition,
history, clipboard ingress, focus and persistence. the roam workstream should
own structural commands and bind keys, bullet gestures and toolbar actions to
them. a structural edit must update text/tree/selection as one coherent command.
two histories or two save paths would make the two-pr split unsound.

## documented keyboard vocabulary

these are candidates for live confirmation, not an exhaustive verified keymap.
`cmd` means the mac command key; `ctrl` is the control key. keyboard layout,
browser, focused surface and active composition matter. never mechanically
replace every mac `cmd` with windows `ctrl`.

| action | mac | windows | confidence / source |
| --- | --- | --- | --- |
| new block | `enter` | `enter` | mirror [blocks](https://roamdocs.fyi/help/blocks) |
| soft break | `shift+enter` | `shift+enter` | primary [syntax](https://raw.githubusercontent.com/Roam-Research/roam-tools/master/skills/roam-syntax/references/syntax.md) |
| indent / outdent | `tab` / `shift+tab` | same | mirror [blocks](https://roamdocs.fyi/help/blocks) |
| select block | `shift+down` | same | mirror; exact text-selection boundary unknown [blocks](https://roamdocs.fyi/help/blocks) |
| delete block | `esc` then `backspace` | same | mirror writes `esc+backspace`; sequencing needs observation [blocks](https://roamdocs.fyi/help/blocks) |
| reorder up / down | `cmd+shift+up/down` | `alt+shift+up/down` | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| collapse / expand | `cmd+up/down` | `ctrl+up/down` | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| zoom in / out | `cmd+period/comma` or `cmd+shift+period/comma` | `alt+right/left` | conflict [keys](https://roamdocs.fyi/help/key-commands), [navigation](https://roamdocs.fyi/help/navigation) |
| copy block reference | `cmd+shift+c` | `ctrl+shift+c` | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| copy embed | `cmd+shift+e` | `ctrl+shift+e` | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| toggle task | `cmd+enter` | `ctrl+enter` | mirror; editing context [keys](https://roamdocs.fyi/help/key-commands) |
| bold / italic | `cmd+b/i` | `ctrl+b/i` | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| highlight | `cmd+h` | `ctrl+h` | mirror; platform conflict requires capture [keys](https://roamdocs.fyi/help/key-commands) |
| strikethrough | `cmd+y` | `win+y` | mirror; unusual windows binding requires capture [keys](https://roamdocs.fyi/help/key-commands) |
| heading 1–3 / clear | `cmd+alt+1/2/3/0` | `ctrl+alt+1/2/3/0` | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| insert link | `cmd+k` | `ctrl+k` | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| follow reference / sidebar | `ctrl+o` / `ctrl+shift+o` | same | mirror [keys](https://roamdocs.fyi/help/key-commands) |
| first / last block | `cmd+enter` / `cmd+shift+enter` | `ctrl+enter` / `ctrl+shift+enter` | mirror; no active caret [navigation](https://roamdocs.fyi/help/navigation) |
| block start / end | `ctrl+a/e` | `ctrl+home/end` | mirror [navigation](https://roamdocs.fyi/help/navigation) |
| paste into one block | not established | `ctrl+shift+v` stated without platform qualification | mirror [faq](https://roamdocs.fyi/help/faq) |
| undo / redo grouping | unknown | unknown | observe text and structural history; do not infer from api |

the help pages disagree specifically about the shift modifier for mac zoom.
the live shortcut panel and a reproduced action must settle this before the
spec claims exact parity. the shortcut table is not permission to commandeer
an operating-system command globally.

roam groups customizable commands by everywhere, inside a block, and multiple
blocks selected. it supports conflict indication and custom bindings.
copy that context discipline; custom-keymap import/export is deferred unless
needed to resolve the user's actual keyboard layout.
[hotkey help mirror](https://roamdocs.fyi/help/customizable-hotkeys)

## pointer, touch, and visible state

the help describes clicking a bullet to focus its subtree and shift-clicking
links/blocks to open the sidebar. bullet drag moves blocks; alt-drag creates a
reference. those gestures must not be conflated with placing a text caret.
[navigation mirror](https://roamdocs.fyi/help/navigation),
[blocks mirror](https://roamdocs.fyi/help/blocks),
[reference mirror](https://roamdocs.fyi/help/block-references)

right-clicking the round bullet opens a contextual menu with focus, references,
expand/collapse, task conversion, headings, alignment and alternate child views.
the menu also includes graph-product functions beyond this writing scope.
[context-menu mirror](https://roamdocs.fyi/help/block-context-menu)

exact bullet diameter, gutter width, indentation step, hit areas, disclosure
placement, guide-line contrast, selected-row color, drag indicator, hover
behavior, animations and caret offsets were NOT measured. reference gifs are
useful leads but do not establish current metrics. capture idle, hover, edit,
text selection, block selection, expanded, collapsed, dragging, nested and
zoomed states at the chosen release and viewport before approving visual parity.

mobile is not a single reference surface. current help distinguishes full web
view, optional native view, and quick capture. native coverage is incomplete;
quick capture avoids loading the graph and records captures for later sync.
this explains a speed technique, not a requirement to add offline mode here.
[mobile help mirror](https://roamdocs.fyi/help/roam-mobile)

developer release history documents native multi-block drag with edge scrolling,
long-press on the multibar to open/close multiple blocks, and tap/swipe on a
selected block to include children. it also records fixes to paste, save,
external keyboard and offline loading behavior. these dated fixes show why
native and web require separate receipts; they do not establish current bugs.
the observed store page reports version 1.1.17; capture the installed build
instead of assuming the storefront determines it.
[developer release history](https://apps.apple.com/us/app/roam-mobile/id1609277273)

## acceptance matrix to resolve before implementation

all rows below are proposed checks. documentation establishes the broad action;
the exact edge-case result remains **unknown** until observed or deliberately
specified as a divergence. every structural case must be exercised with undo,
redo, retained caret/selection and leave/reopen after acknowledgement.

| case | fixture / action | result the spec must state |
| --- | --- | --- |
| split | enter at start, middle, end; selection; parent open/closed | sibling versus child, child ownership, surviving id, marks, caret |
| empty block | enter in empty root/nested/last block | new sibling, outdent, removal or no-op; focus remains usable |
| soft break | shift+enter inside marked text | same node, exact newline, correct continuation marks |
| join | backspace at start; forward delete at end | adjacent visible versus structural node; children, ids, marks, references |
| delete | empty/nonempty/selected parent with hidden descendants | removed scope and next focus; no invisible unintended loss |
| indent | first sibling; one/many selected blocks; deep subtree | legal destination, preserved order, descendants and caret |
| outdent | first/middle/last child with later siblings | destination and later siblings' parent; no accidental adoption |
| reorder | first/last sibling; collapsed parent; mixed selection | boundary behavior and moved subtree; exactly one logical history step |
| fold | caret in descendant; nested fold states; expand all | focus relocation and restored disclosure state; no content mutation |
| zoom | parent/leaf; edit zoom root; return to containing outline | root editability, escape route, breadcrumb and selection restoration |
| selection | wrapped lines, soft breaks, cross-block drag, repeated select-all | text range versus whole blocks; hidden descendants and marks |
| drag | multiple blocks, collapsed target, edge scrolling, cancel | before/after/inside placement, no cycles, distinct move/reference gesture |
| clipboard | plain lines, indented outline, html, rich text, internal copy | schema conversion, hierarchy, ids, formatting, references, one-block paste |
| history | type→split→indent→type→undo; edit after undo | grouping, redo invalidation, stable identities, no separate save history |
| ime | japanese/chinese/korean conversion; enter/escape mid-composition | composition commit/cancel must not also split/delete/reorder |
| mobile | touch caret, selection handles, autocorrect, dictation, toolbar | no lost selection, double action, remount or keyboard dismissal |
| keyboard | mac/windows; hardware keyboard on mobile; non-us layout | scoped bindings, accessible tab escape, no stolen text/ime navigation |
| formatting | bold/italic/link across split, join and multi-block selection | consistent toolbar/key action; no literal markup leakage unless chosen |
| references | source shown twice; split/join/delete/move source | source/occurrence ownership and reference repair explicitly defined |
| scale | measured representative long note and deep/wide outline | no input loss; measured feedback/scroll budgets, not guessed targets |

minimum capture recipe: record date, product/build, os, browser/web versus
native, keyboard layout, extensions, custom hotkeys, theme, font size, viewport
and zoom. use a disposable fixture with stable labels, siblings, grandchildren,
folded content, marked text and a reference. record before, gesture, after,
caret and undo; inspect exported identity only where the behavior depends on
identity. use actual iphone touch and mac keyboard. add windows only if its
shortcut fidelity is promised. browser automation cannot prove native input.

## objections worth preserving

outdent is a particularly revealing fault line. a 2021 user discussion reports
roam moving the promoted block after its former parent's remaining subtree,
while some writers expected it to stay visually in place and acquire later
siblings. this is historical evidence of a mental-model conflict, not a
current reference oracle. the spec must choose deliberately.
[user discussion](https://www.reddit.com/r/RoamResearch/comments/n3mby0/)

a 2020 report against roam 0.7.2 describes autocomplete reordering typed
characters under lag. it does not prove present behavior. it makes the correct
acceptance criterion clear: suggestions must never corrupt input, even when
the network or rendering is slow.
[archived issue 449](https://github.com/Roam-Research/issues/issues/449)

roam's white paper describes reusable ideas with multiple contextual views;
its later note explicitly retreats from some ambitious reasoning features
because they made the tool too complex. the useful philosophy is manipulable
thought units. the graph's grand ambitions are not a prerequisite for good
bullets. [white-paper mirror](https://roamdocs.fyi/help/white-paper)

engelbart's account connects easier rearrangement of symbol structures with
better intellectual work. our inference: the benefit lies in reducing the
effort between revising an idea and revising its expression, not in adding
metadata to every gesture.
[engelbart, 1963](https://dougengelbart.org/pubs/augment-133183-AHI-Vistas.html)

## adjacent products and deliberate exclusions

| reference | useful lesson | rejected import |
| --- | --- | --- |
| [workflowy bullets](https://workflowy.com/help/bullets) | whole branches move together; disclosure and focus have separate gestures | unrelated boards and presentation features |
| [workflowy mirrors](https://workflowy.com/help/mirrors) | one content source can have several live views; detaching creates independence | treating a normal copy as a live reference |
| [dynalist basics](https://help.dynalist.io/article/130-dynalist-basics) | action menus expose applicability; root cannot outdent | its optional bullet-click behavior as if it were roam's |
| [dynalist shortcuts](https://help.dynalist.io/article/91-keyboard-shortcut-reference) | explicit selection/navigation commands; layout conflicts matter | its shift+enter note field as roam soft-break behavior |
| [tana outline editor](https://outliner.tana.inc/learn/features/outline-editor) | a subtree can become the focused document | fields, schemas and workflow automation |
| [logseq's own introduction](https://blog.logseq.com/how-to-get-started-with-networked-thinking-and-logseq/) | the block is the reusable information unit | journals, queries and a full knowledge-management product |

deferred inventory: page/backlink search, right-sidebar workspaces, graph views,
daily notes, custom-hotkey exchange, templates, attributes, queries, tables,
kanban, diagrams, media, encryption, sharing, comments, reactions, extensions,
ai, and block versions. inline references/embeds are recorded here to prevent
identity mistakes; their full product ui is not silently included in bullet
parity. [feature catalogue mirror](https://roamdocs.fyi/help/features)

the central trade-off is explicit: adopt roam's structural grammar inside
apple-like writing continuity. literal replication of every roam editing mode,
platform conflict and graph feature would contradict the narrowed brief.
any retained difference in keys or tree behavior needs a named decision in the
implementation spec. neither a pretty bullet nor a generic outliner warrants
the word parity.
