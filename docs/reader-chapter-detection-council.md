# chapter detection, source notes, and reader contents

date: 2026-09-26
status: direction approved; [implementation plan](reader-chapter-detection-plan.md) owns execution
scope: epub and web article navigation, with four local epub editions

recommendation: reconcile source-backed reading boundaries and auxiliary ranges
in the existing ingestion/structure owners. retain the published navigation,
classify note destinations, combine multiple representations of one chapter,
and preserve genuine omitted primary sections. derive routine navigation and
the complete contents map from that shared model. no macbook-specific filter.

three native subagents covered publishing/accessibility standards, reader
products, and repository architecture. the council is a synthesis of expert
perspectives, not interviews with outside specialists. evidence includes primary
docs and implementation source, user/maintainer reports, four local epub
inspections through current parser owners, and two small in-memory reproductions.

local checkout: `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`. production api `/version`
reported `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`; git comparison found no
differences in the inspected epub ingest/structure/sanitizer/read, html apparatus,
canonicalization, html tree, reader structure/navigation, and web structure owners.
production ssh and a dev-server route timed out. production media rows, original
file digests, stored navigation, import dates and the macbook ui were not inspected.
matching parser source does not prove that old persisted navigation matches a new
local extraction. no application code, source books, database, or deployment changed.
documentation and tickets were added; unrelated dirty work was preserved.

## what the four editions show

these are local parser observations, not production counts or desired counts.
the probe invoked existing package parsing, staged resource rewriting, apparatus
extraction, sanitization, canonicalization, publisher parsing and structure
construction. it did not publish fragments, upload assets, or call the database.
temporary probe code and data were deleted after local acceptance; source hashes,
counts and conclusions remain here.

| edition | spine files | published toc entries | current derived sections | demonstrated cause |
| --- | ---: | ---: | ---: | --- |
| shadow & claw, orb/overdrive | 79 | 75 | 149 | chapter number and title are separate h1 elements; publisher entry already names their combined chapter |
| pillow book, meredith mckinney, penguin | 23 | 24 | 567 | 297 genuine numbered primary entries coexist with 225 subordinate commentary headings in the notes section; frontmatter and duplicate entries add further noise |
| confessions, henry chadwick, oxford | 25 | 50 | 86 | the source ncx itself includes 30 numeric note links as roots; all 36 source headings are also independently added |
| complete essays, montaigne, penguin/calibre conversion | 1,334 | 119 | 241 | 115 excess entries share exact source positions; the 1,207 trailing note files contribute zero sections in this extraction |

source sha256 values, in table order:

```
5e89f049ae8dd00b29053ed588e27e4d0ae5852225a96ab164827f90563ce0d3
8f625aa3c9f1fd0084e1c014fc27a390f3d278bc1f50519a0272ebef7a60e88f
0d4b869602edd2b33cbe500cd6229f3557e3f11f69df6bf7f42d7b89fc15c201
01c64cceac36df2ee70ea4a1be0696a1bed2fd27e2f70f736ab7c33cc5e9c597
```

wolfe's navigation also contains 518 page-list entries and three landmarks;
the inspected parser keeps those separate from its 75 toc entries. summing every
link in a navigation file would itself reproduce the conceptual mistake.

the local montaigne result does not establish the reported production symptom.
older persisted rows, a different source file, or another navigation surface are
possibilities to inspect, not findings. there is a separate source defect:
`13. On experience` points to
`The_Complete_Essays_split_117.html#filepos3028407`, a quotation in essay 6;
its real heading is in `The_Complete_Essays_split_124.html`. the wrong anchor
exists, so successful link resolution is insufficient evidence of correctness.

all four local extractions emitted zero apparatus items. this does not mean the
books lack notes. the three note-heavy editions use untyped links and anchors
whose surrounding paragraph contains the body. pillow's `notes.html#ich01en01`
and montaigne's `The_Complete_Essays_split_127.html#filepos3929743` are empty
anchors beside backlinks and prose. augustine's
`dummy_split_009.html#filepos137540` is a backlink anchor containing only a
superscript numeral; the note prose follows in its surrounding span.

these four books are a contrast set. an intersection of their superficial markup
would discard precisely the distinctions we need. pillow's short numbered entries
must survive; augustine's numbered notes must not become primary sections. the
2013 [wu, mitra and giles study](https://clgiles.ist.psu.edu/pubs/ICDAR2013-ToC.pdf)
finds that heterogeneous book layouts defeat rules learned from narrow samples.
it studies document/pdf toc extraction, not epub semantics; it supports the
sampling method, not an algorithm to transplant.

## the philosophy and precedents

a book has reading order, literary structure, published navigation, and supporting
apparatus. a file is a storage unit; a heading is evidence of structure; a toc link
is an editorial claim about a destination. none alone establishes a chapter.
the reader should preserve the work's organization and the reader's orientation.
fewer entries is not success if meaningful divisions disappear.

[epub 3.3](https://www.w3.org/TR/epub-33/#sec-spine) separates spine order from
[the toc hierarchy](https://www.w3.org/TR/epub-33/#sec-nav-toc). auxiliary material
may be in the spine; `linear="no"` is a hint, not a complete note classifier.
[reading-system requirements](https://www.w3.org/TR/epub-rs-33/#sec-nav) require
access to the published toc links and headings. a quieter compact sequence is
compatible with preserving the full published hierarchy.

| precedent | documented behavior | judgment to borrow |
| --- | --- | --- |
| [apple books](https://help.apple.com/itc/booksassetguide/en.lproj/static.html) | authored toc, separate spine order, semantic note references and note popup support | preserve source intent and contextual access |
| [kindle](https://kdp.amazon.com/en_US/help/topic/G201605710) | logical navigation toc is distinct from a visible contents page | navigation is a first-class publication structure |
| [readium parser](https://raw.githubusercontent.com/readium/kotlin-toolkit/develop/readium/streamer/src/main/java/org/readium/r2/streamer/parser/epub/EpubParser.kt) | selects navigation document, otherwise ncx; does not union every heading into that source toc | source selection and structural supplementation are different decisions |
| [koreader](https://koreader.rocks/user_guide/) | reduced toc depth can drive chapter movement and marks; alternative/custom contents preserve access to the original | full map and routine controls can use different detail; corrections should be reversible |
| [calibre](https://manual.calibre-ebook.com/conversion.html), [toc editor](https://manual.calibre-ebook.com/edit.html#editing-the-table-of-contents) | separates chapter detection from page breaks; supports authored contents, explicit replacement and target editing | make repairs inspectable; avoid exposing its configuration burden in ordinary reading |
| [readwise reader](https://docs.readwise.io/changelog) | documents expandable epub parts/chapters and preservation of book structure | hierarchy matters beyond counting chapters; no superior proprietary detection algorithm is established |
| [wikipedia](https://www.mediawiki.org/wiki/Reading/Web/Desktop_Improvements/Features/Table_of_contents) | persistent, collapsible contents supports overview and section orientation | retain a usable map while keeping the reading surface quiet |

these are documented precedents, not a hands-on product ranking. the last column
is architectural interpretation. koreader's optional hidden flows also change
progress and page-turning; that broader feature is outside this navigation repair.

note handling is also imperfect in mature readers. [koreader's source](https://github.com/koreader/koreader/blob/master/frontend/apps/reader/modules/readerlink.lua)
prefers explicit semantics and uses guarded heuristics; some guards reject toc
targets and headings. copying that popup classifier would miss augustine's notes
because they already appear in its toc. [kindle guidance](https://kdp.amazon.com/en_US/help/topic/GQ6JQ7FM6C72HE4X)
warns that reciprocal non-note links can trigger unwanted popups. reciprocity
alone is not proof. [calibre's classifier](https://github.com/kovidgoyal/calibre/blob/master/src/pyj/read_book/footnotes.pyj)
likewise combines semantic and structural evidence.

[daisy's notes guidance](https://kb.daisy.org/publishing/docs/html/notes.html)
distinguishes note references, bodies, groups and backlinks. [dpub-aria](https://www.w3.org/TR/dpub-aria-1.1/#doc-endnotes)
explicitly permits a heading in an endnotes section. distinguish the useful
notes-collection destination from its individual notes and commentary subdivisions.
deprecated authoring tokens in older books still carry importable meaning.

user reports supply failure examples, not prevalence estimates. a [calibre report](https://www.reddit.com/r/Calibre/comments/1bgg0vq/calibre_improperly_detecting_chapters/)
describes contents being mistaken for chapters. an older [reader discussion](https://www.reddit.com/r/readwise/comments/14qcie8/larger_ebook_navigation_and_internal_linking_is/)
describes unwieldy outlines and internal linking; newer reader releases address
part expansion, so the old report is not a current capability audit. a
[koreader maintainer discussion](https://github.com/koreader/koreader/issues/5925)
explains why treating every internal link as a note turns contents links into
chapter-sized popups. [w3c participants](https://github.com/w3c/epub-specs/discussions/2870)
also disagree about mandatory popups for long notes. preserve dependable access
and return; note display design remains owned by the separate source-notes work.

## council questions, disagreement, and resolution

| perspective | question or strongest objection | proposed resolution and cost |
| --- | --- | --- |
| publishing | why infer structure already supplied by the edition? | prefer published labels/hierarchy when corroborated, but augustine proves membership cannot establish semantic role |
| information architecture | does a toc entry cover one boundary or its entire file? | one boundary. pillow's book-level entry does not replace its 297 primary sections; supplement real missing divisions |
| accessibility | does hiding notes remove legitimate access? | preserve published links and notes collections in the full map; exclude individual notes from routine movement, not from the document |
| interaction design | what does previous/next promise? | meaningful reading sections: chapters, essays, numbered entries and a useful notes collection. retain full hierarchy in the inspector; do not label every unit a chapter |
| inference | how can untyped notes be recognized without a title blacklist? | combine reference direction, reciprocal anchors, local block boundaries, and group context; ambiguous material stays accessible |
| systems | can repair move existing highlights or saved positions? | replace derived navigation while preserving source text, fragments and canonical offsets; explicitly version changed publications |
| maintainer | does every malformed book require another special case? | encode observed structural relationships, never author/title/filename exceptions; use explicit corrections when evidence is insufficient |

agreement is on invariants and examples, not a majority vote. the publishing
specialist's strict publisher-only proposal loses pillow's entries and retains
augustine's notes. the inference specialist's exhaustive heading union duplicates
wolfe's title groups. both are refuted by the actual corpus.

the useful unanswered questions are which exact production media/files are involved,
what stored rows currently feed their controls, whether the complaint concerns
compact movement or the full outline, and which legitimate fine divisions the
reader wants as stops. the owner approved keeping pillow entries and montaigne
essays as stops; individual notes and duplicate title fragments are excluded.

## proposed implementation boundary

1. **recover source semantics at ingestion.** extend `html_apparatus.py`, which
   already owns raw note relationships. normalize declared note bodies/groups;
   recognize the observed untyped shapes through marker/body asymmetry and
   reciprocal links. map an empty anchor or backlink numeral to its surrounding
   note body. preserve declared versus inferred provenance. broadening recognition
   risks false positives, so ordinary contents links and prose cross-references
   are explicit counterexamples.
2. **classify auxiliary ranges, not only individual targets.** pillow's commentary
   h4s are not note targets themselves. a governing notes heading plus repeated
   corroborating note relationships can establish a bounded auxiliary section.
   heading rank/containment delimit the range. a title containing “notes” alone
   cannot do this. conservative inference can leave noise; it must not hide an
   essay merely because its title resembles apparatus.
3. **reconcile boundaries in `epub_structure.py`.** merge publisher and source
   candidates describing one boundary, including fragmentless leading headings
   and a chapter's number/title group. source label, target and structural owner
   matter; equal offsets alone cannot distinguish a coincident part and chapter.
   retain distinct primary subsections and pillow's existing numbered entries.
   this is more work than blanket publisher precedence, but the samples require it.
4. **share role-aware eligibility with articles.** `canonicalize.py` carries the
   structure; `web_article_structure.py` and the epub builder consume it. do not
   repurpose `numbering_allowed`: it also excludes lists, quotations and arbitrary
   asides. no browser text scan, title blacklist, duplicate parser or mac-only rule.
5. **retain all destinations; derive routine navigation.** `epub_read.py:242–256`
   currently appends all sections to the publisher outline. its toc nodes refer to
   section ids, so simply deleting auxiliary sections would break their links.
   the shared contract needs an explicit distinction between addressable auxiliary
   destinations and routine reading sections. source provenance (`Publisher`,
   `Heading`, etc.) is independent of role. compact picker, counter, previous/next
   and active-section behavior must use one agreed projection. the complete map
   retains published access and hierarchy. this adds a derived view, not a second
   independently maintained toc.
6. **repair erroneous targets only with sufficient evidence.** montaigne provides
   a unique exact normalized heading, a clearly incompatible current target, and
   neighboring publisher entries agreeing with the correct order. a deterministic
   reconciliation rule may repair that case while preserving the declared href
   and repair reason. otherwise require an explicit inspected correction. exact
   wire/persistence design belongs in the implementation specification; no fuzzy
   title retargeting, general toc editor or runtime model service is justified.

ai is useful for inspecting weird editions, proposing corrections, and finding
counterexamples. an agent can produce a small list of proposed boundaries with
source anchors and reasons, which the deterministic owner validates. making a
model decide every import would introduce uncertain output, latency and another
failure boundary before exhausting the source evidence. postponing that breadth
is an explicit trade-off, not a claim that automatic literary interpretation is
impossible. a persistent correction facility is warranted only where validated
structural rules cannot resolve actual remaining defects.

## existing data and verification

do not reimport books as the repair mechanism. `epub_ingest.py:575–598` deletes
fragments and installs fresh identities. instead reconstruct navigation from
existing fragment ids, package hrefs, canonical text and source metadata; require
re-canonicalization to match stored text exactly. original epubs can enrich lost
roles only after source-to-stored correspondence is proved. sanitized html often
lacks raw roles/classes, so absence of retained stamps proves little.

retain existing epub section identities where their boundaries survive. web ids
include heading ordinals (`web_article_structure.py:350–357`), so allocate identity
from the original candidate order before eligibility filtering; otherwise every
later heading can be renamed. preserve stored heading anchors. rebuild parents
and extents only after eligibility is settled.

install derived changes through `replace_reader_publication`
(`reader_publication.py:149–191`) and advance generation. keep fragments, note
bodies, highlight offsets and reader cursors intact. update existing retrieval
projections where they retain section metadata. downloaded archives contain old
navigation and need regeneration/re-download; a frontend-only filter would leave
the published model inconsistent. this metadata repair path is required work;
no standalone owner currently exists. its cost is justified by preserving annotations.

verification should use the four exact editions plus one ordinary epub and one
article with real headings and heading-bearing notes. record expected destinations,
roles and parents, not merely counts. include a real numbered short section,
coincident part/chapter, repeated labels, a long note, a prose cross-reference,
and an essay titled “notes” as focused counterexamples.

acceptance: wolfe's number/title pairs yield one chapter stop; pillow keeps its
297 entries while commentary stays auxiliary; augustine's 30 note destinations
remain reachable without entering routine chapters; montaigne's duplicates and
wrong essay target are corrected. verify exact arrival, current position,
previous/next, return from notes, existing highlights/resume, keyboard behavior on
macbook, and regenerated offline navigation. investigate production montaigne
separately before claiming its reported symptom resolved.

`./scripts/test` remains the sole automated command and establishes static
consistency only. no static suite, browser, device, screen-reader or production
reader journey was run for this research. future maintained tests require the
repository's concrete cost/risk justification; a handful of small owner regressions
may qualify, but no new benchmark service or replacement suite is proposed.

## recorded work

- recognized note headings, untyped note bodies, augustine's published note
  targets, montaigne's wrong destination, fragmentless duplicate sections, and
  unrelated typed navigation lists were resolved in the chapter implementation;
  [epub](modules/epub.md) and [reader](modules/reader-implementation.md) own the
  final contracts.
- [ambiguous frontmatter headings](tickets/epub-contents-union-overpromotes-source-headings.md)
  remain open after the wolfe title groups and pillow commentary were repaired.
- [production correspondence](tickets/reader-chapter-production-correspondence-unverified.md)
  remains unverified.

the broader source-notes work owns readable note bodies and their presentation.
this proposal shares its semantic owner but
does not require shipping the entire margin redesign, excluding notes from reading
progress, or changing book text to make chapter navigation correct.
