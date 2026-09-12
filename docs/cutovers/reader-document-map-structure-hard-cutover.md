# reader document map structure hard cutover

status: implemented on `codex/reader-document-map`; final repository gates and
operator acceptance pending. approved direction:
[council review](reader-document-map-council-review.md). this document owns the
implementation contract; the review owns research and rationale.

## goal, scope, and decisions

make every source-backed chapter/heading and available evidence mark locatable
in correct document and section proportions. repair existing imports, hosted
reading, mobile presentation, and offline text positioning. include
*shadow & claw* and *the pillow book*, using their actual imported editions.
no product questions remain; exact-book access is an acceptance prerequisite.

one coordinated hard cutover: no feature flag, old/new decoder, approximate
locator, fake chapter-per-file, or legacy route. brief maintenance downtime
and offline package redownloads are accepted costs. preserve user annotations,
canonical text, fragment identities, and accepted reading progress.

locked choices:

- length means canonical unicode codepoints over all retained text fragments,
  counted once. it does not mean reading time, image area, or comprehension.
- resource identity is independent of structure. epub content loads by
  fragment; current section is derived, never a persisted cursor identity.
- explicit publisher navigation plus content headings determine structure.
  missing structure remains missing; the approved numbered-entry exception below
  exposes inference. no guessed offset.
- every plotted structural mark retains its source coordinate. dense targets
  cost a detail/list interaction; their spans are never stretched or merged.
- offline parity covers structure, position, and available targets. existing
  offline packages contain no annotation snapshot; annotation sync is outside
  this cut.

non-goals: renderer replacement, pdf outline extraction, changed pdf page-space
metrics, cfi interchange, ocr/ai heading inference, manual outline editing,
reading-time/coverage models, continuous scrubbing, semantic graphs, new
services, unrelated testing-platform repairs, or a general navigation framework.

## target behavior and invariants

1. scrolling updates the deepest containing section and ancestor context,
   including several headings in one mounted fragment. loading a fragment or
   clicking a toc entry does not itself establish the current section.
   the primary text point is the first visible glyph at the existing scroll-padding
   reading line; the viewport band includes visible context above that line.
   a short document wholly above the line uses its first visible glyph. a viewport
   without visible text has no text primary, except genuine arrival at document
   end. source anchors still support exact image-only jumps and return.
2. for absolute source position `x`, total text length `l`, and section `[a,b)`,
   global position is `x/l`, local position is `(x-a)/(b-a)`, and its global
   span is `(b-a)/l`. headings, highlights, resizing, and reflow cannot change
   these quantities for the same source loci.
3. parent extents include descendants. draw a disjoint partition of every
   start/end boundary; never sum parent and child lengths. include uncovered
   introductory, interstitial, and trailing spans without calling them chapters.
4. intervals are half-open; a boundary belongs to the following section.
   document end uses the final nonempty coverage interval; section context
   exists only when a semantic extent contains it. coincident starts may have
   different nonzero extents. zero-length sections have no local percentage;
   zero-total-text documents retain outline navigation without text percentages.
   retain source anchor identity on sections so distinct image-only destinations
   sharing offset zero remain distinct exact jumps; this identity adds no length.
   equal-depth containing sections resolve by smallest extent, then section id.
5. chapter nodes jump to exact starts; highlight marks reveal their original
   passage. targetless outline groups disclose children and are not plotted.
   unresolved targets have no approximate mark. successful arrival means the
   target is visible, including when end-of-document prevents top alignment.
6. next/previous section uses unique source positions relative to the current
   locus, never publisher presentation order. resource continuation remains
   fragment/spine order and works with an empty outline.
7. document-map, section, and source-link jumps, restore, preview, and return
   update orientation without claiming reading or completion. keep the existing
   trusted-input/save fences. ctrl-wheel zoom and multi-touch movement are not
   reading. touch adopts reading on a completed prose tap or one-finger scroll,
   not initial contact, which cannot distinguish a pinch. ordinary pdf page-turn intent retains its existing
   contract; this cut does not redesign those controls.

## source model, storage, and api

reuse the current navigation endpoint and aggregate. the following is the
complete changed structure vocabulary; use existing `Presence<T>` for absence,
strict objects, integer codepoint bounds, and media-scoped identities.

| type | fields / meaning |
| --- | --- |
| text point | `{fragment_id, offset}`; offset is within that canonical fragment |
| text range | `{start: text point, end: text point}`; may cross fragments |
| navigation fragment | existing `{fragment_id, fragment_idx, char_count}` |
| navigation section | `{section_id, anchor_id: Presence<string>, label, parent_section_id: Presence<id>, target: text point, extent: Presence<text range>, source: Publisher \| Heading \| Both \| InferredNumberedEntry}` |
| toc node | `{id, label, section_id: Presence<id>, children: toc node[]}`; array order preserves publisher presentation, augmented with missing headings |
| landmark/page entry | `{id, label, target: Presence<text point>}`; retain source list order |
| navigation | `{media_id, kind, generation, fragments, sections, toc_nodes, landmarks, page_list}`; fragments and sections are in canonical source order |

when present, `extent.start` equals `target`. `extent` is absent only when an exact target has no defensible semantic range,
such as conflicting publisher nesting. it remains jumpable but supplies no
local percentage. expose incomplete structure through the existing partial
status/diagnostics surface. trusted stored violations are defects; malformed
external structure is an explicitly classified ingestion result.

extraction algorithm:

1. extend the canonicalization pass to emit h1–h6 starts and supported
   section/article container ends against the exact canonical text. reuse
   `web_article_structure.py` heading semantics; extract shared stateless logic
   only where both web and epub actually call it. do not inject epub ids.
2. reconcile publisher targets and heading elements by exact source anchor,
   never title equality. publisher labels/order remain in the toc. retain
   existing authored alias ids as distinct source-backed nodes sharing a target;
   count their content once and deduplicate sequential visits by coordinate.
   parent and first child remain distinct. a detected heading at an existing
   source element augments its node instead of creating another alias.
   an authored anchor inside a heading identifies that heading only when source
   ancestry proves containment and their canonical starts coincide. reconcile
   before grouping aliases; preserve the publisher id and original jump anchor.
   sibling anchors and later anchors inside heading text remain distinct.
3. semantic parent is the nearest source-supported containing section. use
   explicit enclosing structural ends, otherwise the next peer/ancestor start
   in source order. file boundaries alone never terminate a chapter. resolve
   unsupported contradictory hierarchy and its descendants as absent extents,
   not guessed containment. independently bounded source containers remain
   valid when a publisher presentation parent cannot contain them: preserve the
   toc grouping, omit that semantic parent, and retain their exact extents.
   a heading explicitly labelling a source container owns its
   full extent; a sibling title heading does not truncate that owner. retained
   sources lacking `aria-labelledby` may establish ownership only through a
   unique source target at the container start. other headings end at their
   next peer, capped by their enclosing container.
4. preserve surviving authored section ids. mint new heading ids as
   `heading:<uuidv5>` using media id as namespace and
   `fragment_id:offset:heading_rank` as the name. remove
   truncation-and-suffix identity generation. unsectioned fragments need no
   synthetic section because fragment loading is independent.

retain `epub_toc_nodes` for publisher order/hierarchy; add nullable `target_offset`
for exact landmark/page/outline targets computed once during canonicalization. adapt
`epub_nav_locations` for source-backed semantic sections: retain target
`fragment_idx/start_offset`, add `parent_section_id` and `end_fragment_idx`,
make end-fragment/end-offset jointly nullable, and extend the source enum.
retain media-scoped keys and enforce same-media parent/end-fragment references,
nonnegative bounds, ordered extents, acyclic parents, and child containment
when extents exist. validate bounds, correlated end fields, and ancestry at the
owning write boundary; database enforcement is limited to storage shape, keys,
uniqueness, and foreign keys, per the database rules. web headings retain
their existing retrieval storage owner and use the same semantic range builder.
reader navigation derives web structure from immutable stored source in the
publication snapshot; it does not wait for asynchronous retrieval indexing.
the bounded html parse (existing 2 mib article limit) is an accepted read cost;
no second structure store or cache is introduced.

| boundary | final contract |
| --- | --- |
| `GET /media/{id}/navigation` | returns the navigation above; removes flat section `start_offset/end_offset`, duplicated level/depth/ordinal, and href-derived loading fields |
| `GET /media/{id}/fragments/{fragment_id}` | authenticated epub render-unit read; returns existing fragment content/count fields plus generation and source href; removes section label/provenance/previous/next fields |
| `GET /media/{id}/document-map` | embeds the same navigation and `generation: Presence<number>` (present for publication-backed ebook/web/pdf; absent for existing non-publication formats); retains marker ids, exact-source-derived `position`, activation item refs, and decoration fields; adds `end_position: Presence<number>` for exact ranges |
| epub resume target | `{fragment_id, href_path, anchor_id: Presence<string>}`; remove `section_id`; retain fragment-relative `locations.text_offset`, quote context, resource progression, and cursor revision/cas protocol |
| source port | `loadEpubFragment(fragmentId)` replaces `loadEpubSection(sectionId)`; session loads first fragment when the cursor is empty, even with no sections |
| offline reader | unique fragment content array plus the same complete navigation; no content copies per heading and no client reconstruction of navigation |

remove `/sections/{section_id}` and its bff route/client methods. keep source
outline links addressable through their surviving node identities; resolving
one obtains a text point, then loads its fragment. rewrite internal epub links
through package-href→fragment-id metadata; replace `data-nexus-section-id`
with `data-nexus-fragment-id` plus its source anchor in hosted/offline link
handlers. resolve named anchors exactly after loading, independent of outline
membership. missing anchors are unresolved. adapt exact highlight and
find activation outputs to fragment loading; explicit unannotated passage links
use `#text-<fragment_uuid>:<start>:<end>` (integer bounded codepoints, start ≤ end),
consumed by the existing reader target owner; persisted fragment-offset passage
anchors remain unchanged. existing marker fractions remain projections, never
jump addresses; local drawing uses those fractions and the same section bounds.

`epub-find` requires `source_generation` and the existing fragment witness;
all result variants echo both. a mismatch returns `E_EPUB_FIND_SOURCE_CHANGED`.
find scope uses the deepest section containing the visible canonical locus,
including cross-fragment extents and fragments with several sections.

`reader_publication` owns a coherent generation across navigation, content,
aggregate capture, and offline packaging. consume its existing capture/fencing
mechanism; do not mix projections from different generations or add another
version store. all changed same-system decoders accept only the new shape.

the user-approved numbered-entry extension admits conservative, source-anchored
numbered paragraph sequences as `InferredNumberedEntry`. it must preserve exact
canonical starts, continue entries across render files, expose inferred provenance,
and abstain on ambiguous source patterns. no title, css class, or edition-specific
matcher. use independently authored analogues and the supplied pillow book source
as acceptance witnesses. explicit navigation/headings retain precedence.

admission requires at least three document-wide, source-ordered candidates with
unique consecutive positive numbers. each paragraph begins `[n]`, has its own
source id or a leading empty named anchor at exactly that offset, and follows
the number with an emphasized incipit separated only by opening punctuation,
spaces, or asterisks. exclude lists, quotes, asides, and declared apparatus.
reject gaps, repeats, restarts, and emphasis enclosing the number. new ids are
`numbered:<uuidv5>` with media namespace and `fragment_id:offset:number` name.
this deliberately misses unanchored/plain-text entries and ambiguous sequences;
it spends recall to avoid presenting invented chapters as source structure.

offline reader2 embeds the hosted snake-case navigation and full epub fragment
DTOs plus `asset_paths`, once per fragment. web fragment bodies retain their
camel-case envelope, with explicit `fragmentIdx` and real `createdAt` metadata.
the small metadata overhead avoids fabricated fields and a second source
adapter contract. the strict json nesting bound is 128 to carry the supported
32-level source toc plus its object/array envelopes; byte limits are unchanged. archive1 bounds and grammar stay unchanged.

## composition and presentation

`canonical content → navigation/ranges → reader session → exact semantic
viewport → readerDocumentPosition → global/local views → exact activation`.

extend `readerDocumentPosition.ts` for absolute/local projections and active
section selection. backend marker projection stays in `reader_locations.py`;
one independently authored coordinate corpus binds the two language adapters.
move the reusable canonical capture/reveal primitives from `paneTextAnchor.ts`
under shared reader ownership. hosted and offline text leaves use those same
primitives and intent fences. delete `TextDocumentReader`'s scroll-fraction
capture/restore and `DocumentReaderSession`'s fabricated offline web offsets.

the global rail paints independent structure and evidence lanes, the current
locus, and the viewport band. labels may hide; source ticks may not move.
pointer groups must have total projected span below 24px, not merely adjacent
gaps below 24px; each opens all member destinations. no group replaces the
structural ticks. use existing native buttons, roving focus, and member lists.
the current-position control reveals the exact primary locator; excursion
return restores its captured origin. neither substitutes the persisted resume
cursor. mobile map disclosure is a separately named action.

one shared outline/detail body supports desktop and mobile; offline supplies
its local shell disclosure, not hosted inspector/network machinery. the mobile
ribbon gains a named, adequately sized control opening the existing inspector.
the open offline shell fits the dynamic viewport. text/pdf owns its bounded
scrolling area; long content cannot move reading onto the outer page. the inline
offline map takes 45% of the remaining reader area while open, leaving 55% for
full-width text. both panes may shrink and their contents scroll internally.
opening detail selects the deepest containing positive-length section; when
none exists, show document scope, explicitly labelled. breadcrumb selection
pins another scope. scope stays fixed until explicit selection/reopen. outside
the pinned scope, hide local current position; do not clamp it to 0%/100%.
clip viewport/highlight ranges for drawing only; activation keeps the original
source target. preserve distinguishable shapes and keyboard/touch access.

reuse `usePendingDocumentMapPulse`, exact evidence resolution, and existing
positioning fences. one pane-local excursion origin is captured before the
first map jump and retained only if the jump succeeds; subsequent jumps retain
it. return restores it exactly. clear on successful return, dismissal, genuine
reading adoption, or source replacement. a failed jump/return preserves prior
state. find return is search-scoped: share its capture/reveal primitives, not
its search controller. never create a second history stack or cursor store.
the latest explicit navigation owns arrival: superseded operations cannot
reposition, commit/clear the origin, or acknowledge success. use existing
cancellation and source/layout-generation owners.

delete rail-owned timers, dwell/high-water storage, `nx-solar:*` interpretation,
and associated history rendering. retained ornament is a pure position view.
remove last-selected/loaded-section state as current-reading truth and every
superseded proof/stylesheet/doc clause once its replacement is proven sensitive.

## nonoverlapping implementation boundaries

paths below are relative to `python/nexus/` or `apps/web/src/` as labelled.
each row owns its implementation and proof; consumers change only after the
producer contract is fixed. cross-boundary edits belong to the listed owner.
these are review boundaries inside one release, not independently deployable
intermediate states. source/cursor restoration consumers in `epubRestore.ts`,
`epubHelpers.ts`, pane find, and evidence activation change with their owning
rows b/d; no section-loading consumer survives by omission.

| owner / order | exclusive files and work | one canonical proof owner |
| --- | --- | --- |
| a. source structure | python `services/canonicalize.py`, `web_article_structure.py`, `epub_ingest.py`; pure range builder; independent fixture expectations | `python/tests/service/test_epub_structural_anchors.py`: source → exact structure, nested/multi-file/alias cases, bounded identity generation |
| b. publication and api, after a | python `db/models.py`, `schemas/media.py`, `schemas/reader.py`, `schemas/reader_document_map.py`, `services/epub_read.py`, `reader_navigation.py`, `reader_locations.py`, `reader_evidence_markers.py`, `reader_document_map.py`, `reader_publication.py`; routes/bff, navigation/map/cursor decoders, `lib/reader/types.ts`, shared `ReaderDocumentSource`/`DocumentReaderSession`, hosted fragment loading/link rewriting | `python/tests/service/test_reader_document_positions.py`: real persisted navigation/aggregate/render-unit contract and independently specified fractions |
| c. migration, after b | one new alembic revision carrying b's constraints, cursor conversion and metadata repair; no source re-ingest | one migration proof: pre-cut database → final schema, identity preservation, cursor revision, rollback and repeatability |
| d. reader geometry and actions, after b | web `lib/reader/readerDocumentPosition.ts`, shared canonical text helpers, `TextDocumentReader`, `ReaderDocumentMapOverviewRail`, `ReaderContentsNav`, detail body, `MobileReaderPositionRibbon`, hosted `MediaPaneBody.tsx` wiring | existing projection unit owner for algebra; existing rail browser owner for actual marks/controls/text geometry; distinct boundaries, no repeated oracle |
| e. offline adapter/artifact, after b–d | python `services/offline_reading_delivery.py`, `schemas/offline_reading_package.py`; web `OfflineReaderAdapters`, `packageContract.ts`, `OfflineDocumentReader`; kotlin `OfflineReaderDocumentVerifier`, `OfflineReadingPackageContract`, `OfflineReadingModels`, `OfflineReaderStateValidator`; shared contract vectors and packaged assets | existing package-contract owner for serialization/native validation; `OfflineReading.browser.test.tsx` for exact renderer/native-progress-port composition |
| f. integration, after c–e | existing reader-progress-resume journey, shared proof/fault registry, final module/cutover docs and ticket closure | extend the existing journey for one source → map jump → exact passage → return → persisted resume flow |

## hard-cut migration and release

1. census affected media, source witnesses, cursor revisions, and old offline
   packages. synchronize pending browser/native progress with the old deployed
   system before maintenance; inability to drain is a release blocker, never
   permission to discard it. stop old writers before changing schema.
2. rebuild metadata from stored sanitized html, canonical text, source-fragment
   records, and toc. require recomputed canonical text to match exactly. do not
   replace fragment rows, source objects, highlight anchors, or quoted text.
   retain owned ids that still identify source structure. before deleting fake
   spine chapter rows, remove their obsolete `section_id` hints from
   `content_blocks.locator/metadata/selector`, `content_chunks.summary_locator`,
   `evidence_spans.selector`, and matching `passage_anchors.selector` and stored
   `message_retrievals` locators/links and `resource_edges.snapshot` citation links
   found by the census. preserve exact
   fragment addresses, source anchors, quotes, row ids, and provenance; do not
   regenerate quoted evidence. citation snapshots retain their original passage
   range through the cited retrieval or an exact target-owned locator; a whole
   fragment target does not justify replacing that passage with the file start.
   rewrite owned links to their exact fragment
   target. repair the same typed navigation copies in tool-call results,
   selected context, and replay events; preserve event identities, sequences,
   timestamps, generated text, and audit facts. immutable reader-selection
   snapshots retain their exact fragment locators and quote identity: they store
   no section-dependent link and need no rewrite. a record lacking the required
   exact address aborts the migration.
3. before removing old nav rows, convert every epub resume target using its
   existing section→fragment relation. preserve populated locations/text. an
   entirely empty, unanchored old cursor becomes fragment offset 0: old manual
   navigation opened the whole fragment at `scrollTop=0`, not the old semantic
   section start. preserve anchor-only states when the source anchor is unique.
   reject null offsets with populated quote/fraction/position data unless a
   unique exact source anchor resolves them. convert anchor
   absence to `Presence`, increment its revision once, and record no engagement
   or completion. missing joins or unsafe dependent references abort the cut.
4. publish repaired metadata through the existing publication owner, advancing
   each changed media generation once. the alembic revision owns one database
   transaction for schema, all metadata, cursor conversions, and generations.
   helpers use its connection without committing; any failure rolls back the
   entire revision. no external object mutation occurs in that transaction.
5. bump the offline reader contract and minimum reader bundle version to 2, retaining the archive
   envelope version if its grammar is unchanged. update python/typescript/kotlin
   together. reject old reader payloads; after progress drain, require package
   redownload and fresh attested cursor baselines. regenerate/verify committed
   offline assets. no old reader/cursor decoder or v1-only contract fixture remains.
6. deploy the matching api/web/native artifacts and reopen only after census
   convergence and the gates below. retain migration history, not runtime
   compatibility. revise previous canonical-map, passive-mobile, and passage-
   return clauses to describe this final state.

## red/green/refactor and acceptance

follow [testing standards](../local-rules/testing-standards.md). one proof owner
per actual boundary means one home for each invariant, not one enormous test.
independent behaviors remain independently falsifiable scenarios. concentrate
proof in real service/browser components, a small algebra kernel, and the one
existing journey. no screenshot corpus or combinatorial browser matrix.

for every row a–f: adversarially review contract/oracle first; demonstrate red
against the unfixed defect or a product-only fault; implement green; refactor
and delete replaced paths; adversarially review final diff, proof sensitivity,
and dependent contracts. record counterexample, disposition, command, revision,
and receipt. an import/setup failure is not a behavioral red. unresolved data
loss, coordinate, or ownership objections block progression to the next row.

acceptance witnesses:

- one file/many headings, no/coarse toc, multi-file chapter, duplicate labels,
  co-located parent/child, out-of-order toc, unlinked groups, long ids, and
  leading/interstitial/trailing text yield independently specified structure.
- 1:3:6 content produces 1:3:6 spans; a 600px rail with 18px neighbour gaps
  never collapses into one chapter. adding highlights cannot move boundaries.
- non-bmp text, images, unequal paragraphs, resizing, and reflow preserve exact
  loci in hosted/offline capture, jump, and resume. programmatic movement emits
  no reader-intent save; genuine reading resumes ordinary persistence.
- a cross-section highlight clips visually but every representation jumps to
  its original passage. pinned local scope never claims an outside position.
- hundreds of headings add metadata, not copies of fragment content, to the
  offline payload; package limits stay unchanged. rejected old packages never
  silently delete pending progress.
- both named imported editions pass representative heading, short/long section,
  local/global marker, jump, and return checks. record edition/source digest and
  expected source boundaries; do not assume chapter counts or *pillow book*
  numbering. minimal authored analogues belong in fixtures, copyrighted books
  do not. unavailable exact-book access leaves this gate open.

commands: `./scripts/test changed <owner>`, `./scripts/test prove --proof ...`,
then `./scripts/test pr`; applicable package/native and release capabilities
remain mandatory under the controller. existing sensitivity/offline gate debt
must be resolved by its owner before claiming those gates; no waiver or direct
runner bypass. implementation evidence is recorded in
[the verification log](reader-document-map-verification.md).

close the thirteen reader-map/structure tickets only against their acceptance
evidence; retain unrelated register entries. final state has one structure
model, one exact text capture/reveal path, fragment-based loading, one position
projection per language boundary, and no approximation or compatibility path
for the replaced contracts.
