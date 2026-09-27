# reader section semantics

status: local acceptance verified; combined production rollout approved, gates unverified
origin: 2026-09-26 owner approval of [council research](reader-chapter-detection-council.md)
authority: this plan owns implementation; the research retains sources and receipts.

## goal and scope

epub/article navigation represents meaningful reading divisions. chapters,
essays, pillow's numbered entries and authored notes collections remain stops.
individual notes, commentary subdivisions and duplicate title fragments do not.
complete contents preserves published labels, hierarchy and reachable destinations.
text, annotations, source links and saved reading positions survive repair.

non-goals: note presentation/margins, progress-denominator changes, pdf/ocr,
toc editor/settings, generated headings, runtime ai, fuzzy retargeting, source
refetch/reimport, generic parsing framework, or permanent test infrastructure.
no blocking product questions remain. production file/row correspondence is an
implementation prerequisite; local results do not establish production behavior.

## behavior and designer-owned content

each package pairs its engineer with the named designer; examples precede code.
designers approve rendered labels, hierarchy and destinations, not just schemas.

| feature / designer | required content |
|---|---|
| epub contents / publishing | one boundary for a proven number/title group. wolfe's `I` + `resurrection and death` uses authored `I. Resurrection and Death`, at `chapter1.xhtml#ch1`. augustine's `BOOK I` + `Early Years` similarly uses its combined publisher label |
| notes / editorial | retain the authored notes collection and auxiliary hierarchy. pillow keeps 297 primary entries, including `[1] In spring, the dawn`; its 225 commentary headings stay outside routine stops. augustine's 30 published note targets remain accessible |
| article contents / information | preserve real headings, full multiline labels and hierarchy. note-body headings are auxiliary. an essay titled “notes,” short numbered sections and ordinary cross-references remain valid content |
| target repair / editorial | montaigne's `13. On experience` reaches `The_Complete_Essays_split_124.html` offset 0; retain the original wrong href as provenance. labels retain source case/punctuation; normalize whitespace only |
| controls / interaction-accessibility | use “sections.” picker, counter, previous/next and compact active state share one sequence. full contents offers auxiliary targets without fake chapters; absent destinations remain noninteractive labels |

no author/title/filename exceptions, numeric-label bans, invented summaries or
count caps. no synthetic “notes” grouping ui. retain publisher ordering and
grouping; source-only auxiliary headings nest under their established source group.

## capability and data contracts

reuse canonical codepoint coordinates, `Presence`, apparatus storage and
`MediaNavigationOut`. all changes are required shapes, with strict decoders.

```text
NotesGroup = {
  range: NavigationTextRange,
  heading: Presence<NavigationTextPoint>,
  provenance: Declared | Inferred
}

reader_apparatus_states.note_groups: NotesGroup[]  // new typed jsonb; internal
NoteRegion = Body { range } | Group { ...NotesGroup }  // transient only

MediaNavigation.sections: existing section[]     // reading divisions only
MediaNavigation.toc_nodes: {
  id, label, children,                          // existing
  target: Presence<NavigationTextPoint>,        // new; independent destination
  section_id: Presence<string>                  // optional reading-division link
}[]
```

`reader_apparatus.read_note_regions` combines group metadata with existing exact
note-body locators. do not copy body ranges into another store or create group
resource items. groups can exist without apparatus items; `status=empty` does
not erase structural evidence. unresolved body locators cannot suppress headings.

groups have nonempty, bounded ranges; an optional heading lies within its group.
body/group overlap is valid; body membership takes precedence. the group heading
itself is eligible, its subordinate apparatus headings are not. preserve accepted
declared/inferred provenance; group arrays are replaced with their publication.

`sections` keeps meaningful part/chapter hierarchy and existing provenance/ranges.
auxiliary targets do not acquire section extents, map scopes or find chapter labels.
every present toc target lies in a published fragment. a present `section_id`
resolves to a section with the SAME target. multiple published nodes may refer
to one section. absent linkage with present target means an independent destination;
both absent means an unresolved/group label. preserve published access without
requiring every link to be a reading division.

persist the many-to-one linkage as nullable `epub_toc_nodes.section_id`; remove
`epub_nav_locations.source_node_id`. retain source `href`, labels and order;
existing resolved fragment/offset columns describe the effective destination.
add checked `resolution`: `Unresolved | SourceTarget | BoundaryMatch |
ExactHeadingRepair`; unresolved rows have no effective point/link. the reader
does not display parser diagnostics. migration updates the existing models/tables;
no second toc table, endpoint, cache or service.

hard-change existing navigation and nested document-map responses together.
offline archives use the same navigation schema. standalone api, map and offline
composition read apparatus and navigation in one captured publication snapshot.

## derivation and composition

`raw source → apparatus bodies/groups → canonical candidates → reconciled
sections + contents targets → publication → shared reader projections`.

1. **source semantics:** `html_apparatus.py` owns declared roles and the observed
   untyped shapes. resolve empty anchors/backlink numerals to bounded containing
   note bodies. infer only from reciprocal links PLUS marker/body asymmetry and
   corroborating note context. explicit unlinked note bodies still supply exact
   structural evidence. group inference requires a governing heading and repeated
   note relationships, bounded by its container or next peer/ancestor heading.
   a word such as “notes” alone proves nothing. process each document's evidence
   once; do not add repeated whole-ancestor scans or weaken parse/memory limits.
2. **source selection:** epub3 uses the declared toc; epub2 uses ncx. for epub3
   without a usable declared toc, omit publisher candidates and derive supported
   source boundaries; do not silently substitute ncx. page lists/landmarks remain
   separate. reject promotion of unrelated typed nav lists. format support is
   explicit; obsolete parser/output paths are deleted.
3. **boundary reconciliation:** a publisher entry claims one boundary, not its
   whole file. match its resolved element/leading title group using source scope
   and label correspondence. combine adjacent number/title headings only when
   the authored combined label corroborates them and no substantive content
   intervenes. preserve distinct coincident part/chapter divisions. retain
   evidenced missing primary headings and the existing numbered-entry rule.
   matching uses nfc, whitespace collapse and casefold; title-group matching
   permits the publisher's separator between the number and title. display
   labels remain source-authored; do not strip arbitrary punctuation.
4. **auxiliary eligibility:** shared `reader_structure.py` classifies candidate
   points against `NoteRegion`. both format builders use it; neither parses note
   text again. keep auxiliary source/publisher destinations in the toc, exclude
   them before resolving reading-section parents/extents. do not reuse
   `numbering_allowed`, which also excludes legitimate quotations/lists/asides.
5. **wrong destinations:** exact-heading repair requires a unique normalized
   label match to a primary candidate, an incompatible current destination, and
   agreement with valid neighboring publisher entries. all conditions are
   required. retain the declared href and resolution reason. ambiguous valid
   links retain their source destination; unresolved links remain noninteractive.
   record unresolved specimen defects; do not guess or build a correction ui.
6. **identity:** retain surviving section ids. allocate web candidate ordinals
   before filtering; keep existing anchors. proven duplicate sections collapse
   to the publisher-bound section, or first source boundary when unauthored.
   no alias layer. rebuild web retrieval metadata through its existing owner.
7. **reader projection:** `readerDocumentPosition.ts` derives one ordered step
   sequence from sections, grouping identical points and choosing the deepest
   division, then source order on ties. all compact controls consume it; delete
   their independent dedup/count logic. keep distinct coincident ancestors in
   the full map. active compact step is the deepest containing retained step
   using its ORIGINAL extent, then shortest extent and section id as in the
   shared projection. gaps are unselected; never map a parent to an expired child.
8. **activation:** contents passes its exact point through existing epub/web
   positioning and excursion owners, including offline. no section lookup is
   required for an auxiliary target. retain existing pointer/keyboard behavior;
   contents may be available with zero routine sections. no new return/progress
   state; separately owned excursion defects stay separately scoped.

the shared source-semantic slice also serves source-note extraction. implement it
once with one editor; it can ship before rich bodies or evidence-pane presentation.
this plan specifies its navigation outputs, not a competing note extractor.

## safe repair and hard cutover

one narrow `reader_navigation_repair.py` service prepares and installs metadata;
a thin `ops/reader_navigation_repair.py` exposes `inspect` and `apply` for selected
media. inspect is read-only and reports exact source/generation and proposed
labels, groups, targets and section changes. both use the ordinary builders;
there is no separate repair algorithm or durable job framework.

prepare outside the transaction from retained originals and stored fragments.
prove source digest, package-href/anchor correspondence and exact canonical-text
equality. no network refetch. apply consumes the EXACT inspected digest/generation
(epub original digest; stored article bytes digest), rechecked under existing
media→publication locks, then uses `replace_reader_publication` to install
apparatus/group/navigation changes and advance generation atomically. a stale
snapshot requires fresh inspection; failed correspondence writes nothing. retrying
an already committed inspection is stale and cannot bump twice. a fresh inspection
with identical derived metadata is unchanged: apply does not bump or reindex.

preserve fragment ids/order, sanitized html, canonical text, assets, source refs,
existing apparatus identities/edges, highlights and saved cursors. source enrichment
uses the shared apparatus owner; do not invoke destructive import replacement.
request existing web reindex with reason `reconciliation` in the same transaction.
epub navigation alone does not require re-embedding unchanged paragraph text.

before rollout: identify production editions/stored rows; rehearse on their
isolated restored state; inventory/back up affected data; settle pending offline
progress. generation changes reject old pending writes; never erase or silently
rebase them. keep production closed during schema/data/client cutover and do not
serve unrebuilt affected publications. unresolved mandatory books block acceptance.

python, typescript and android strict offline validators cut over together.
bump reader contract and bundle from 2 to 3, or the next unused value after
rechecking concurrent work; archive grammar remains 1. reject old archives,
retain pending recovery data, regenerate/re-download through existing owners.
no dual decoder, default interpretation, compatibility flag or old detector.
use the existing deployment runbook; code revert alone cannot undo data changes.

## non-overlapping work packages

`P=python/nexus/services`, `S=python/nexus/schemas`, `W=apps/web/src`.
one editor per file, including shared source-notes work. call-site changes are
requested from their listed owner. each handoff gets independent adversarial
review before the next package consumes it.

| package / designer | exclusive files and deliverable |
|---|---|
| a: source semantics / editorial | `P/{html_apparatus,reader_apparatus}.py`, `S/reader_apparatus.py`: exact bodies/groups, public region read; shared source-notes prerequisite |
| b: navigation / publishing | `P/{epub_structure,reader_structure,web_article_structure,epub_read,reader_navigation}.py`, `S/media.py`: candidate identity, eligibility, reconciliation, targets and wire contract |
| c: publication / data fidelity | `P/{epub_ingest,web_article_ingest,reader_publication,content_indexing,offline_reading_delivery,offline_reading_packages,reader_navigation_repair}.py`, new thin op, db models/migration: integrate a/b, persist/repair once, generation/reindex |
| d: shared reader / interaction-accessibility | `W/lib/media/readerNavigation.ts`, `W/lib/reader/readerDocumentPosition.ts`, `W/components/reader/{ReaderContentsNav,ReaderDocumentMapDetail}.tsx`, `W/app/(authenticated)/media/[id]/MediaPaneBody.tsx`, `W/offline-reading/OfflineDocumentReader.tsx`: strict decoding, one step projection, exact-point activation |
| e: offline contract / recovery | `S/offline_reading_package.py`, `W/lib/offlineReading/packageContract.ts`, android `offline/reading/{OfflineReadingModels,OfflineReaderDocumentVerifier}.kt`: contract version, invariants, regenerated archive acceptance; reuse existing recovery store |
| f: acceptance / content-accessibility | temporary live probes, expected specimen tuples, independent review, completion receipt and ticket closure; owns no product implementation |

sequence: a/b agree contracts and f freezes expected content; c integrates their
outputs; d/e integrate the same schema; f verifies hosted, repair and offline paths.
delete blanket heading promotion, reverse source-node linkage, duplicated control
sequence logic, dead decoder branches and affected obsolete docs. retain unrelated
primitives; this is not a general reader cleanup.

## temporary red / green / refactor acceptance

the owner's instruction authorizes temporary executable integration/live tests.
use isolated real auth/api/worker/storage/database and actual browser import/read
journeys. no mocks, auth bypass, production fixtures, new ci gate or permanent
harness. `./scripts/test` stays unchanged and static-only.

| case | required observation |
|---|---|
| a1: four exact editions | source hashes from the research; expected `(label, parent, target, routine membership)` tuples satisfy the designer table, including correct montaigne essay 13 arrival. totals alone cannot pass |
| a2: counterexamples | ordinary epub/article, heading-bearing note, unlinked declared note, repeated titles, long notes, legitimate short/numeric sections, essay titled “notes,” prose cross-reference, coincident part/chapter with different ends, zero sections with valid toc targets, unrelated nav before toc |
| a3: reader | mac keyboard/pointer arrival, current tracking, shared counts/previous/next, auxiliary contents access, no note-induced chapter boundaries; existing return/progress behavior checked and separate defects reported honestly |
| a4: repair | baseline highlights/cursors/fragment and html/text hashes survive; generation advances once; stale/ambiguous apply writes nothing; web reindex uses revised sections |
| a5: offline | exact installed android artifact; fresh package agrees with hosted contents and targets; old contract refused; pending progress settles before cutover or remains in explicit recovery; no dropped pending bytes |

**red:** content designer defines expected tuples from source; adversarial reviewer
challenges rules/fixtures. prove setup, then capture baseline target failures.
setup errors are not red; unaffected behavior may already pass.

**green:** implement each owner, replay the SAME cases and run `./scripts/test`.
**refactor:** independent reviewer challenges contracts, source fidelity, accidental
complexity and dead paths; resolve objections, rerun affected journeys/static checks.
after acceptance, delete task-owned test code/data/dependencies/credentials; retain
concise commands, source hashes, baseline/final shas, red/green results and artifact
identity. run final static checks. blocked mandatory cases are not completion.

update the epub/reader module docs and resolve only proven tickets listed in the
research. preserve unrelated local state. the owner authorized implementation in
the subsequent request; production mutation still requires the stated cutover
prerequisites.

## explicit trade-offs

conservative classification retains some ambiguous noise; it protects real
divisions. full contents can remain verbose because published access survives.
epub3 without a usable toc loses ncx-only navigation detail under explicit format
selection; supported source headings/entries remain available.
coincident steps collapse in compact controls; parent-only tails may have no
active compact step while the full map identifies the parent. exact target repair
leaves ambiguous errors unresolved. shared apparatus reads add one dependency
but avoid duplicated semantic state. hard cutover requires a no-use window and
new offline downloads. deleting tests relinquishes ongoing regression detection.
the 44 pillow candidates without a forward spine reference remain unlinked;
promoting them would let an ordinary numbered chapter become an inferred note.
inferred candidates still count against the existing bounded apparatus index
before confirmation; an extreme book with over 10,000 numeric return-link
candidates can be refused as a resource-limit case.
`resolution` is checked by the publication writer and strict reader, not a
database `CHECK`, under [database rules](rules/database.md#constraints); an
invalid raw row is therefore detected on read rather than rejected on write.
article repair retains a previously published declared note group when
sanitization erased its source role; the source bytes and publication generation
are fenced, but the declaration cannot be independently recovered from that html.

## implementation receipt

branch: `feature/reader-chapter-semantics`, rebased onto main after the source
recovery and shared media-row changes.
the four edition digests are recorded in the [council](reader-chapter-detection-council.md).
temporary red probes reproduced four false section counts, an ordinary chapter
misread as a note, a valid anchor retarget, duplicate publisher boundaries,
and lost auxiliary headings. the same source cases now pass: wolfe 82 sections,
pillow 334 (297 numbered entries; 225 commentary headings auxiliary), augustine
30, montaigne 126. all parse within 30 seconds; the combined four-book probe took
about 11 seconds. full labels, targets, parent links and routine membership were
asserted, not only totals. isolated imports, browser navigation, repair generation
fences, fragment/annotation identity preservation, and a fresh `0236→0243`
migration rehearsal passed. the old disposable acceptance database was reconciled
from the earlier, conflicting `0242` test stamp; no production schema was changed.
main had already claimed reader contract v3, so this branch hard-cuts to v4.
python/typescript reject v3; the installed android v4 apk
(`sha256:013bf9fe99545130c6ed29ef605bda463e4c018b2f6eaea9bb2813fb9c7de046`)
marks two sealed v3 copies unsupported and preserves Retry/Remove. normal Retry
installed the v4 pillow package (`sha256:7ae8897c7539fab3e50a5932898070cb72b4c11dae3d2f696799f0c05e86a8af`);
installed `reader.json` (`sha256:52d43663be1e784b69300ca319d3b4ffe2d7c8a2d99b003a252cc70c4174d92d`)
has navigation exactly equal to hosted API. hosted and native readers both reach
`[1] In spring, the dawn` and the independent notes target at offset 315;
compact navigation has 328 steps. hosted pointer and keyboard Enter activation
reach the same notes target; native document-map activation does too. the v4
contents has 559 nodes, including 225 auxiliary note headings. `./scripts/test`
and android debug build pass.
temporary test code, fixture data, local credentials and dependency links were
deleted after acceptance; this receipt retains the outcomes and artifact hashes.

the isolated article repair published revision-2 reconciliation through the
normal exact worker job `02444e86-ac04-4fe7-a8ce-b7734787a3e7`. the index is
ready with seven content blocks; their only section ids are the repaired
`A short chapter` and `Notes` headings. a credential was supplied only to the
one-shot isolated worker process; no secret was copied into the task runtime.
production source/row correspondence, restored rehearsal, pending offline
progress, and deployment remain unverified because both ssh routes timed out:
[ticket](tickets/reader-chapter-production-correspondence-unverified.md). the
owner explicitly deferred production acceptance for this pass; no production
state was changed.
