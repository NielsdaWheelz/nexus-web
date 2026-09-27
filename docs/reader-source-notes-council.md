# source notes in the reader margin: council review

date: 2026-09-26
status: research record; presentation superseded by the approved plan below
presentation superseded: the approved [implementation plan](reader-source-notes-plan.md)
places full aligned content in the evidence pane; the narrow bar owns overview/previews.
checkout: main at `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`
scope: source-authored footnotes, endnotes, marginal notes, and bibliographic references
user priority: mixed books and essays; notes visible while reading

three native subagent reviews covered reader architecture, source semantics and
extraction, and reading/product design. the council below synthesizes expert
perspectives; it is not a claim that outside specialists reviewed nexus.

evidence: current code/docs inspection, primary web sources, selected user reports,
and small manually invoked read-only extractor probes. no running nexus browser,
device, screen-reader, or production-library journey was performed. no application
code, schema, source media, or database was changed. documentation/tickets only.
pre-existing checkout changes were left in place.

## recommendation

extend the existing reader apparatus and shared margin into a readable annotated
edition. show short source notes in place on wide panes; preserve their wording,
structure, reference label, and correspondence to the text. provide deliberate
full-body inspection for long notes and compact screens. keep bibliographic entries
compact until consulted.

the philosophy is editorial: bring supporting material to the passage where it
becomes intelligible, while preserving the reader's control over attention.
proximity reduces the work of consulting a note; visible provenance preserves the
distinction between source commentary, personal interpretation, and generated
material. the page should support understanding without deciding what the reader
must attend to next.

a note is content; its reference is a relationship; its position in the margin is
a temporary presentation. those responsibilities must remain distinct.

## what the present system actually does

| concern | inspected owner and behavior | consequence |
|---|---|---|
| source semantics | `python/nexus/services/html_apparatus.py` extracts marker and target facts before sanitization | extend this owner; do not infer relationships inside a visual card |
| durable apparatus | `python/nexus/services/reader_apparatus.py`; `python/nexus/schemas/reader_apparatus.py` | already has items, edges, confidence, provenance, and locators |
| repeated references | `html_apparatus.py:162-226`; `reader_evidence.py:244-305` | occurrences are distinct while target bodies can be shared |
| epub | `epub_ingest.py:388-449` and the shared html extractor | semantic links can resolve across chapters |
| web acquisition | `web_article_ingest.py:130-138,297-308` | raw-source apparatus is reconciled against the rendered article |
| pdf | `pdf_ingest.py:475-702` | native internal `cite.*` links; target extraction expects narrowly recognizable bibliography blocks |
| reader composition | `apps/web/src/lib/reader/documentMap.ts:164-180`; `marginItems.ts:78-110` | source references already join highlights and other evidence in one margin |
| geometry | `useAnchoredReaderProjection.ts:150` onward | canonical text ranges or pdf page geometry determine placement |
| density | `marginItems.ts:44-75`; `MarginRail.tsx` | visible referents, downward stacking, a 24-item cap, and inspector overflow already exist |
| current presentation | `MarginRail.tsx:319-336`; `MarginRail.module.css:137-145` | generic citation button and three-line excerpt |
| activation | `MediaPaneBody.tsx:7419-7434` | opens evidence and activates the referring passage |
| offline | `ReaderDocumentSource.ts:31-47`; `OfflineDocumentReader.tsx:739-743` | shared leaf rendering does not imply apparatus inspection parity |

the existing conceptual architecture is useful. its display content, interaction,
layout, and import coverage do not yet establish the requested reading experience.

## precedents worth stealing

these are feature comparisons based on documentation and research, not a ranking
from hands-on testing of every product.

| precedent | documented behavior | lesson and limit |
|---|---|---|
| [folger editions](https://www.folger.edu/about-us/what-we-do/about-the-folger-shakespeare/) | explanatory notes on pages facing the text | parallel access serves continuous reading. folger's free online text is not evidence that all commercial edition notes are present |
| [internet shakespeare editions](https://internetshakespeare.uvic.ca/Foyer/Texts/help/index.html) | brief glosses and deeper annotations; movable, resizable popups, including multiple open notes | different depths of consultation deserve different amounts of space. floating-window management would be excess machinery here |
| [tufte css](https://edwardtufte.github.io/tufte-css/) | wide-screen sidenotes and narrow-screen disclosure | steal restrained typography and proximity. authored page layouts are easier than arbitrary imported books |
| [gwern sidenotes](https://gwern.net/sidenote) | runtime positioning, collision handling, rich blocks, reciprocal emphasis, long-note collapse | the strongest direct precedent for dense margins. its admitted reflow and layout difficulties argue for modest, stable behavior |
| [wikipedia reference previews](https://www.mediawiki.org/wiki/Help:Reference_Previews) | source-content previews with text, images and tables; longer content can scroll; ordinary source navigation remains | a preview should preserve meaning and offer the original. hover should not become compulsory |
| [zotero 7](https://www.zotero.org/blog/zotero-7/) | pdf, epub and webpage reading; citation/internal-link previews | common reading interactions can span formats while extraction differs |
| [apple books](https://help.apple.com/itc/booksassetguide/en.lproj/itccf8ecf5c8.html) and [kindle guidance](https://kdp.amazon.com/en_US/help/topic/GH4DRT75GWWAGBTU) | semantic references enable note presentation; kindle guidance requires bidirectional links | source semantics and dependable return are foundational |
| [kobo specification](https://github.com/kobolabs/epub-spec#footnotesendnotes-are-fully-supported-across-kobo-platforms) | platform-dependent note handling, including rich popup content | common semantics do not imply identical platform behavior |
| [koreader](https://github.com/koreader/koreader/blob/master/frontend/apps/reader/modules/readerlink.lua) | popup notes, adjustable recognition, and opening the original target | recognition can be incomplete or overinclusive; retain source access |
| [hypothesis](https://web.hypothes.is/help/overview-of-the-hypothesis-system/) | highlights and sidebar annotations emphasize one another | correspondence needs an explicit interaction when physical proximity becomes ambiguous |
| [liquidtext](https://www.liquidtext.net/liquidtextadeeperdive) | connected excerpts and documents alongside a freeform workspace | source linkage is useful; a synthesis canvas would substantially enlarge this task |
| [readwise's epub refactor](https://readwise.io/reader/update-june2025) | chapter loading and a dedicated long-form interface replaced treating books as extremely long articles | share contracts while respecting format-specific mechanics |

three user reports reveal failure modes:

- [zotero's preview discussion](https://forums.zotero.org/discussion/116479/disable-the-pop-up-window-when-hovering-over-citation-links):
  readers describe hover popups obscuring text during reading and highlighting.
  reducing travel can still increase interruption.
- [readwise's 2024 footnote thread](https://www.reddit.com/r/readwise/comments/1dh5qkg/epub_footnotes/):
  readers describe losing their place after following notes; staff acknowledged
  difficulties then. this does not establish a current readwise defect.
- [koreader's long-note discussion](https://github.com/koreader/koreader/discussions/12501):
  a reader wants a larger paginated popup because long inline notes disrupt flow.

literary readers voice both sides. one [shakespeare discussion](https://www.reddit.com/r/shakespeare/comments/i2kbd2/)
praises same-line short glosses; another [discussion of folger and arden](https://www.reddit.com/r/shakespeare/comments/1g7rr3y/folger_shakespeare_question/)
contains both appreciation of discursive notes and complaints that they overwhelm
ordinary reading. these are self-selected accounts, not estimates of prevalence.

## what research supports, and what it does not

[scholarphi](https://scholarphi.org/assets/pdf/scholarphi-chi-2021.pdf) brought
position-sensitive definitions into a scientific reader. its 27-participant
evaluation found faster task completion and less document traversal. the study
used one paper and three tasks, with brief unstructured reading. the paper also
reports readers being misled when an incomplete definitions list appeared
complete. this supports local access and honest completeness cues; it does not
prove that permanently expanded notes improve all reading.

[citeread](https://openreader.semanticscholar.org/CiteRead) placed discussion from
later citing papers beside relevant passages. its study with 12 scientists found
better comprehension and retention of follow-on work than a list-based condition.
the relevant mechanism is contextual placement. incoming citations are an adjacent
future capability, not part of displaying a document's own notes.

the [semantic reader overview](https://arxiv.org/abs/2303.14334) treats discovery,
efficiency, comprehension, synthesis, and accessibility as separate challenges.
that is a useful warning against mistaking a catalogue of annotations for a
coherent reading experience.

## the council's agreements and disputes

| perspective | first question | position and objection |
|---|---|---|
| scholarly editor | whose words are these, and what exactly do they qualify? | preserve source wording and attribution. a reference marker may establish only a point, not a whole sentence-sized referent |
| reading researcher | is the reader consulting a gloss, checking evidence, or following an argument? | local access reduces navigation effort; indiscriminate expansion can fragment attention |
| typographer | can the body and margin both remain readable? | reserve real space. do not shrink the body or notes until everything happens to fit |
| accessibility specialist | can this be read and operated without visual adjacency or hover? | real links, selectable text, keyboard activation, logical order, and focus return |
| document engineer | which relationships and body boundaries are actually in the file? | explicit epub/html relations are stronger evidence than pdf appearance |
| systems architect | who owns source identity, content, geometry, and reading state? | use existing owners; a second sidebar/parser would create competing truth |
| product engineer | what happens at the first dense passage or broken target? | overflow, unsupported content, and return behavior belong in the initial contract |

agreement: source fidelity, explicit correspondence, stable reading position,
format-specific extraction, shared presentation ownership, and honest absence.

disagreement 1: persistent notes versus minimal distraction. the user's chosen
task settles the default in favor of visible short source notes. bibliography
entries remain compact, and long notes expand deliberately.

disagreement 2: perfect alignment versus complete display. arbitrary note lengths,
dense markers, zero overlap, unchanged body flow, and full simultaneous visibility
cannot all be satisfied. prioritize body readability and unambiguous association;
relax exact alignment, then disclose overflow.

disagreement 3: broad recognition versus trustworthy extraction. accept exact
semantic relations first. preserve supported structural inference with provenance.
do not claim that a visually plausible superscript establishes a complete note.

disagreement 4: fidelity versus publisher styling. preserve semantic structure
and meaningful content in nexus typography. reproducing arbitrary publisher css
would make layout less predictable and expand the import contract.

## proposed behavior

1. source notes appear automatically in the existing margin when the actual pane
   can accommodate the chosen body measure and readable note width. use the source
   reference label; name the material as a source note unless authorship is known.
2. short explanatory notes show their complete content. long notes show a coherent
   opening with a visible expansion affordance. citation groups expose every
   target, with compact bibliographic treatment.
3. one shared body presenter serves the margin and the existing inspector/sheet.
   full-note expansion must be directly readable; it should not require navigating
   an evidence inventory. prose is selectable and links remain independently
   actionable.
4. marker and note emphasize one another on intentional focus/selection. suppress
   eager large previews during text selection. hover is supplementary.
5. placement preserves reference order and avoids overlap. retain small local
   displacement where necessary; dense overflow remains counted and accessible.
   the active note must remain available even when it does not fit in the rail.
   start with the current stacking mechanism; do not invent a layout optimizer.
6. opening a note inspects it without changing the committed reading position.
   following a target into another chapter is a reversible excursion with the
   actual opening occurrence retained. explicit navigation remains available.
7. compact panes use the existing sheet/inspector interaction. this temporarily
   covers some context but avoids inserting long notes into the body flow.
8. source, reader-authored, and generated material keep distinct provenance and
   actions while sharing geometry. multiple visible references may share one
   source body; correspondence stays occurrence-specific.
9. preserve original source notes in their canonical document position initially.
   margin copies live outside the canonical source root. this permits duplicated
   visual access near the original note section, in exchange for preserving
   offsets, highlights, search, and resume.
10. unknown or unsupported targets offer source navigation and an honest state.
    extraction silence does not establish that a document has no notes.

[epub structural semantics](https://www.w3.org/TR/epub-ssv-11/) already distinguish
references, bodies, backlinks, and bibliographic roles. [daisy's accessible notes
guidance](https://kb.daisy.org/publishing/docs/html/notes.html) explains why note
placement also affects linear reading and why deprecated individual endnote roles
should not be copied blindly. preserve logical reading order and labelled
complementary regions; do not announce every long note via an oversized tooltip
or `aria-describedby`.

## architecture and invariants

the existing path remains:

```text
format acquisition and extraction
  -> apparatus occurrences, targets, relationships, source content
  -> document-map read model
  -> shared source-note body and interaction
  -> margin placement or compact detail
```

format adapters own discovery and source resolution. the existing apparatus owner
owns identity and relationships. the document map composes reader facts. the shared
reader layout allocates space. current text/pdf projection supplies geometry.
ephemeral inspection state owns the opener and return position.

rich content should come from sanitized source fragments, resolved through the
existing html/assets boundary. retained epub/html structure may permit derivation
from a note subtree; source-only web notes may require a persisted sanitized body.
choose one owned content contract during implementation, with plain text derived
for search where appropriate. use `HtmlRenderer`, the existing sanitized html
sink; do not introduce a second renderer/sanitizer or parse cards to recover facts.

invariants:

- a target identity is distinct from each occurrence that refers to it.
- enrichment cannot transfer a durable occurrence identity to different text.
- inspecting a note does not write progress, completion, or navigation history.
- presentation never changes the canonical text sequence used by offsets.
- relation confidence and locator availability are separate facts.
- screen coordinates are derived from the current layout, never persisted.
- missing bodies, unresolved anchors, and unsupported extraction remain distinct.
- a bibliographic target does not automatically establish an imported external
  work or authorize replacing source prose with a generated summary.

## format scope and the cost of coverage

| format | first-slice promise | explicit limit |
|---|---|---|
| epub | known semantic notes, cross-chapter targets, repeat references, supported rich content | malformed/nonsemantic markup needs demonstrated adapters; absent edition notes cannot be invented |
| web article | semantic and supported backlink notes preserved through url import and capture | readability/capture can discard evidence; previously lost browser data requires recapture |
| pdf | existing exact native citation links with honest body/source navigation | generic footnotes, author-year references, scans, and literary apparatus are not covered uniformly |
| downloaded reading | reuse the eventual shared presenter | current package/source boundary lacks apparatus inspection; parity is a separately sized addition |

for pdf, [pymupdf links](https://pymupdf.readthedocs.io/en/latest/page.html#description-of-get-links-entries)
provide destinations and rectangles, not complete note semantics.
[grobid coordinates](https://grobid.readthedocs.io/en/latest/Coordinates-in-PDF/)
can supply scholarly reference/footnote geometry, making it a credible later
adapter. it brings models, execution cost, and another extraction-quality boundary.

the [2026 fossil paper](https://arxiv.org/abs/2606.01109) specifically addresses
law/humanities reference extraction and reports substantial gains from
specialization. it is a work-in-progress extended abstract, not a universal
coverage guarantee. discursive literary notes deserve their own corpus.

a multimodal model could propose missing pdf associations from visible pages.
its output would still need source text/geometry witnesses and distinguishable
inference. generating plausible note prose would violate source fidelity.
no new model service is justified until actual target documents show a substantial
coverage gap that simpler source semantics cannot resolve.

## observed defects and repair constraints

the source-body, margin, occurrence-identity, browser-capture, wikisource,
absolute-fragment and stale-documentation defects found in this review were
repaired in the implementation. the bounded untyped-edition corpus passed;
that evidence does not imply universal untyped-note recovery. see the
[verification receipt](reader-source-notes-verification.md).

the [offline apparatus inspection gap](tickets/offline-reader-lacks-source-apparatus-inspection.md)
remains outside this cutover.

manual extractor observations:

- two semantic references to one note produced three items and two edges.
- adjacent note paragraphs produced `note emphasis sourcesecond paragraph`.
- replacing local `#n1` references with same-document absolute urls produced
  zero items and edges.
- prepending a marker to the same target transferred the old ordinal stable key
  to the new marker. database consequences were inspected, not exercised.

the geometry and frontend activation defects have static evidence only. no
production prevalence or pixel-level reproduction is claimed.

existing-media migration needs a source inventory. epub/pdf originals support
re-extraction when retained; captured browser packets do not contain arbitrary
discarded note bodies. repair stable occurrence identity before republishing
apparatus, preserve resource links, and use explicit recapture when source
information is absent. a blanket library refresh is unsafe as a migration plan.

## smallest complete delivery and verification

first make one coherent slice work for mixed epub/web reading, using the current
graph and margin: reserve actual space, fix occurrence/refresh identity, preserve
readable source bodies, provide full-note inspection and exact return, and repair
the demonstrated extraction losses. retain the narrow supported pdf path with
an explicit coverage boundary. implementation can be split into reviewable changes,
but a three-line visual mockup would not establish the requested outcome.

before choosing a pdf extraction dependency, inspect a small set of actual books,
essays, and papers. downloaded parity and annotating the note body itself require
explicit scope decisions: both add source/anchor work beyond displaying notes.

verification should use a small representative corpus: ordinary article; literary
epub with cross-chapter and repeated references; dense essay; long rich note;
supported linked pdf; unsupported scanned/literary pdf. exercise resize, larger
type, selected text, keyboard focus/return, touch, overflow, multiple citation
targets, and a refresh that inserts an earlier reference.

acceptance is behavioral: correct note beside the correct occurrence; readable
body; preserved structure; no text overlap; all targets accessible; exact return;
no unintended progress writes; no damaged existing highlights or saved links.
compare original and rendered content directly. run `./scripts/test` for required
static verification when implementation changes occur. no permanent test service
or replacement test suite is proposed.

remaining questions, with proposed defaults:

- note-body annotation: later; source notes are readable/selectable first.
- source notes competing with personal annotations: shared ordering and geometry,
  visible provenance, active-item access; no second rail.
- nested notes: ordinary explicit target navigation through the same inspection
  owner; recursive popup piles are outside the first slice.
- automatic external citation enrichment: later; preserve source references and
  allow deliberate source opening.
- offline: track separately, and never describe hosted acceptance as offline proof.
- exact pdf priority: decide from actual documents; idk their coverage in the
  user's library because that library was not inspected.

this direction spends complexity on source truth and reader continuity. the
remaining implementation is ordinary extension of existing owners, with explicit
coverage limits rather than a new annotation platform.
