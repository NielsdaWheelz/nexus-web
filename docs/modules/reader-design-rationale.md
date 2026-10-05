# Reader Design Rationale

This document records the reader constraints we ship and the system shape they imply. How it is built: [reader-implementation.md](reader-implementation.md).

## objectives

- improve long-form reading comfort on desktop and mobile
- preserve comprehension under reflow
- keep resume deterministic across web, transcript, epub, and pdf
- make text lookup reversible without redefining reading progress
- keep the reader system small enough to understand quickly

## distilled constraints

- line length: target 50-75 characters per line on desktop; 60ch on mobile
- font size: default around 16px, with user-adjustable larger sizes
- line height: keep body text around 1.4-1.6
- themes: ship high-contrast light and dark modes only
- layout: prioritize a single-column continuous reading surface
- mobile ergonomics: preserve readability and controls at narrow widths
- active reading: highlights and resume must survive typography changes
- paragraph spacing: block style only; gap between paragraphs equals one
  line-height; no first-line indent; no extra blank lines
- text alignment: left-aligned, ragged right; no user toggle for justify
- hyphenation: off on desktop (column ≥ 65ch); on for narrow viewports
  (≤ 600px) using `hyphens: auto` with
  `hyphenate-limit-chars: 6 3 3` and `hyphenate-limit-lines: 2`;
  user can disable globally for accessibility
- focus mode: three discrete levels (distraction-free, paragraph,
  sentence) plus off; Cmd/Ctrl+Shift+F cycles, Shift+Esc turns it off;
  auto-suspend during active text selection so annotation flow is
  uninterrupted
- contrast: high but not maximal; never pure black on pure white; reader
  surface stays in the warm-neutral family used by the rest of the app

research can support softer tinted backgrounds, but that does not justify
the additional product and maintenance complexity here. the shipped system
intentionally stays with two reader themes: light and dark.

## mobile attention and recovery

Mobile chrome follows one principle: attention without disorientation. Sustained
forward reading retreats global commands without moving content; reverse
reading, top/Home, or command focus restores them. All reader formats feed one
direction-aware policy from their actual scroll owner, and all moving surfaces
share one continuous progress value.

Stable layout matters more than reclaiming a few measured pixels. Chrome moves
with transforms while its layout and Nexus bottom-surface wrapper remain fixed,
so the reader's place, selection, last line, and player clearance do not jump.
Partially retreated controls are not useful controls: the complete moving roots
leave hit testing and accessibility navigation until fully visible again. A
blank-canvas tap is convenient pointer recovery, but reverse/top/focus are the
input-independent recovery contract.

## research basis for the typography rules

- left-align is the screen-reading consensus (Reynolds & Walker 2004,
  Bernard et al. 2002): justified text on screen reduces reading speed
  ~5-10% because browser line breaking lacks Knuth-Plass and proper
  hyphenation, producing rivers and irregular spacing
- block paragraph spacing chunks aids working-memory consolidation
  (Mayer's cognitive theory of multimedia learning); indent vs block is
  null on comprehension when leading and measure are correct, so we
  pick block to match scroll-based reading
- hyphenation has no comprehension effect on left-aligned text at long
  measure (Beier & Larson 2010); enabling it costs aesthetic clarity
  on desktop and helps it on narrow mobile measure
- focus mode levels are evidence-graded: distraction-free is strongly
  supported by cognitive-load theory (Sweller, Mayer); paragraph and
  sentence focus are HCI-suggestive (improved careful reading at the
  cost of overall pace), so they are opt-in not default
- annotation is the largest retention lever (generation effect,
  Slamecka & Graf 1978; testing effect, Roediger & Karpicke 2006); the
  reader's chrome must keep annotation frictionless, which is why focus
  mode auto-suspends during selection

## color and contrast

the reader path uses a warm-neutral palette aligned with the app shell
rather than the prior cool slate/catppuccin palette. high contrast
without halation: text and background never sit at pure black or pure
white because pure values amplify perceived halation and increase
fatigue under long sessions.

- light reader theme:
  - background `#faf8f3` (warm off-white, never `#ffffff`)
  - body text `#1a1916` (warm near-black; ~13.5:1 contrast on background)
  - secondary text `#4a463e`
  - muted text `#7a7468`
  - accent `#7d5e35` (matches app accent)
- dark reader theme:
  - background `#15140f` (warm near-black, never `#000000`)
  - body text `#ebe5d6` (warm cream; ~13:1 contrast on background)
  - secondary text `#c2baa7`
  - muted text `#8a8270`
  - accent `#c4a472` (matches app accent)

both themes meet WCAG AAA for body text. the warm cast reduces blue-light
fatigue and matches the app's editorial palette so the boundary between
shell and reader is calm rather than abrupt. reader colors are still
exposed as `--reader-*` custom properties so that user font-family,
font-size, line-height, and column-width settings can be applied without
touching app theme tokens.

## the shape: three facts and one policy

the reader is a publication (what is read), a placement (where the eye is), a
cursor (where the reader means to resume) and a mode (whether the placement may
move the cursor). everything else, the rail, contents, evidence, marks, find and
the status strip, is a projection of those facts or a writer of targets. the
old pane was 38k lines because it re-derived these facts in many places: three
text-positioning engines, two positioning state machines, thirteen point shapes,
four cross-read consistency checks and the url as transport. the rewrite owns
each fact once, in `lib/documentReader`, and makes the format surfaces geometry.
three structural moves carry most of the reduction.

### mount the whole text document

web articles, epubs and transcripts are one model: an ordered list of units in
one scroll, positions `(unit, codepoint offset)`. fragment switching, the epub
restore-phase machine, fragment loading states and the transcript's segment list
go. the cost is dom size and initial parse on large books;
`content-visibility: auto` per unit at an estimated height bounds the layout
cost, and the gate on the largest corpus book on the phone is still open
(`tickets/reader-whole-mount-large-book-unmeasured.md`). windowing can slot in
behind the same geometry interface if it fails.

### paint with css custom highlights

marks, find, focus dimming, hover and pulses are ranges in named
`::highlight()`s. the document dom is never rewritten: no remounts, no "loading
highlights" gate, text paints before annotations arrive, a selection survives a
recolour. the owner approved this on the condition that a probe prove it across
engines; the probe (chromium, chrome, firefox, webkit, android webview 113)
returned *go with conditions*, and every condition is a rule of `text/paint.ts`:

- overlaps split into disjoint segments in the topmost colour, because
  translucent per-colour layers blend into colours no one chose and rank by
  colour rather than recency;
- `StaticRange` only, because every live range taxes every dom mutation in the
  document (find had the same defect);
- repaint only when marks change, a unit remounts, or a unit enters or leaves the
  window one viewport around the visible band: static ranges follow reflow for
  free, firefox pays per registered range at layout, and webkit never paints a
  range registered while its unit was skipped by `content-visibility`;
- strict priorities with colour-setting dimming above background tints (webkit
  draws text in the topmost highlight's colour);
- literal colours, since older chromium and webviews ignore `var()` in
  highlight pseudos;
- hit-testing through the caret apis, confirmed by grapheme rects, with node and
  element scans for mixed-direction lines, answering every covering id topmost
  first; overlapping marks open a chooser instead of hiding one another.

styling is limited to what `::highlight` supports: no radius, outline or shadow;
focus is an underline.

### one reader read, typed

`GET /media/{id}/reader` returns the whole publication from one snapshot, and
every reader route has a response model, so the client decoders, the
cross-read consistency checks and the map's second copy of navigation go.
contents arrive with the text. the document map is the one source of marks;
writes paint at once through a ledger that a later map read settles, for text
and pdf alike.

## position and progress

### reversible inspection, first origin

contents, links, footnotes, evidence rows, rail markers, find, section and page
buttons, home/end and scrollbar seeks are inspection. the first jump holds the
departure; later jumps keep that first origin, because *back to your spot* means
the reading spot, not the last place visited (owner decision; find is one more
inspection). inspection never writes progress or completion; input and waiting
never adopt a detour; only *continue reading here*, or reading on after return,
moves the cursor. a failed jump rolls back to its departure. one owner (the
navigator) makes this independent of format.

### only reading moves the cursor

a viewport becomes the cursor only within a second of genuine input, never while
positioning. the old pane wrote positions on open (pdf), on jumps in a
never-read article and from the transcript list's selection; each was a write
without reading. a save that fails while the page leaves is not an error and is
not retried (its outcome is unobservable; a retry there became a request storm):
the locator waits for the next movement, and the cursor is re-read next time.

### the cursor is revisioned, the profile is not

the cursor is a positional bookmark where silently overwriting a genuine "go
back" from another device is a correctness bug, so revision is authority and a
stale write is refused with the current snapshot. a newer cursor is adopted
silently only when this reader was away and has nothing unsaved; otherwise the
reader offers the choice and movement waits. the profile is a small preference
bag with no meaningful "undo my edit" shape, so last write wins: a same-field
race is a timing outcome, not a lost action, and a cas would add protocol cost
protecting nothing. its bootstrap read is required, because the profile sizes
every pane before the workspace mounts and a silent default would size and then
re-size the workspace under the user.

### the locator wire stays

android stores locators opaquely, so changing their schema needs an apk and a
data migration. the web writes the fields it means exactly (`target`,
`text_offset`, `total_progression`; pdf `page`, `page_progression`, `zoom`) and
`null` for the legacy `progression`, `position` and quote triple. completion
needs end evidence, not a percentage: the terminal locator is the last unit at
full length with `total_progression = 1`, observed only after trusted forward
input at the end, so restore, links and reflow cannot finish a document.

### the address is not the reader's state

the reader never writes its location into the url. a hash, `?fragment` or
`?apparatus_id` is a one-shot target consumed with one replace; the cursor is
the durable record across visits and devices, and pane back/forward stays about
panes, not passages. precedence on open is a fresh target, then the saved
cursor, then a cold target, then the start: a copied coarse link must not
override real saved progress.

## the rest of the hosted pane

- **transcripts are continuous text** (owner decision) with a time stamp per
  segment; choosing a time reads from there. a click on the text does not seek:
  in a reading surface the first click of a word selection, a tap or a click
  that dismisses a menu would start audio and move the cursor. a deep link that
  moves a transcript seeks without resuming. the player does not move the text;
  the active chapter follows the player.
- **evidence follows without alignment**: the list keeps the group at the
  reading position in view and marks groups inside the visible band. geometric
  alignment beside referents (~600 lines) went.
- **pdf urls refresh on failure only**: pdf.js fetches the remaining ranges
  after open, so proactive refresh cannot help a loaded document; a failed fetch
  reopens with a fresh url at the placement.
- **the note editor stays with notes**: the reader hosts
  `HighlightNoteEditor` through its props; its durability and cas belong to the
  notes slice.
- **note markers bind from server locators**: the link around a resolved source
  reference's range is the marker, so repaired legacy html needs no server
  restamping.

### offline reading is a local copy, not a second Nexus

offline reading keeps the document and the latest pending position needed to
read; it does not reproduce the workspace, annotations, search, ai, or server
authorization. a copy is the hosted reader's own payload, zipped, so there is no
second projection to keep faithful; the shelf renders it with the same
`DocumentReaderView` and a device progress port. publication generation is
separate from cursor revision: generation says which publication a copy and its
locator belong to, revision arbitrates same-publication progress, and a
same-generation conflict keeps both choices and asks the user. see
[offline](offline.md).

### reader-to-chat quote selection

quote-to-chat is highlight-first: a durable highlight exists before launch, the
send carries only `reader_selection = {key: {media_id, highlight_id},
revision}`, and the server captures an immutable per-message snapshot. a sent
quote is fixed: editing, moving or deleting the highlight afterwards cannot
change the displayed or prompted passage. new-chat send is atomic, so a failed
first send leaves no conversation behind.

## regression strategy

the reader harness (isolated stack, playwright-managed browsers) is the
behavioural contract: `R.*` journeys per surface, `S.*` public shares, `O.*`
shelf copies, the find subset, and `R.HL.*` for the paint conditions on
chromium, firefox and webkit. by hand: android webview paint and taps, real
safari, the largest book on the phone.

## static verification

`./scripts/test` checks static consistency. it does not exercise the reader.
