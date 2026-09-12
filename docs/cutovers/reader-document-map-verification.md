# reader document map verification

status: implemented; final repository gates and operator acceptance pending.
branch: `codex/reader-document-map`.
base: `7fa89b88c8342bca9edfb46a6d20053c49555fb2`.
contract: [hard cutover](reader-document-map-structure-hard-cutover.md).
receipts live under `test-results/runs/<id>/summary.json` in the worktree named below.

| boundary | behavioral red | current green | review |
| --- | --- | --- | --- |
| source extraction | `8e77c3ff3fc84ce3`, `e8f051ff1ff46e06`, `0c4f27f0500d19b3`, `ac3776e24d0e3399` | `266ee9d2b5c3406e`, `7bc0d286bf1bab87` | independent literal positions; exact heading ancestry, containers, aliases, tails, numbered entries, publisher/lexical boundaries and repeated long-path identities reviewed |
| publication/api | `7ff9ac2851cd984a` | `b7af98b43051abbc`, `d83e2e133eaabbde` | persisted positions, package kernel and final evidence/search consumers pass |
| migration | `d12d8b1df08293be` in sibling `nexus-reader-structure-red` at base | `1df62fc821caee26` | atomic rollback, exact/anchor/manual cursor conversion, durable reference preservation and repeatability pass |
| rail/browser | `fcf20dc59bbc7f22` | `bb3b9046b63d607f` | 31 ticks with 18px gaps collapse under predecessor grouping; fixed-cell hit groups keep exact source ticks |
| offline | `2cb243a45b4aeeb2`, `c5fae5708c454ef1` (native); `096a2704a6612428` (pixel sensitivity) | same sensitivity receipts; `bb3b9046b63d607f` | reader2 only; unique content; exact canonical capture, bounded phone layout, literal paths and unsupported pending-progress preservation; final packaged assets pass native host proof |
| integration | `4cf713e3c75e2b98` (hosted eof); `8b0b983d002cd181` (restore-write sensitivity) | exact editions `933ea7a501a0bd64`; hosted `8b0b983d002cd181` | actual same-fragment section tracking, source-order toolbar, exact eof/reflow, quiet map/return/restore, away/back and reset pass |

format/import/setup failures are not behavioral reds. `fecdacafad31ee49`
exposed whitespace in the authored source fixture; adjacent source tags now
match the independently counted canonical literals without changing canonicalization.
`f58688747a89f64f` was a canceled queued migration run, not proof.

## accepted decisions and counterexamples

- numbered entries: user approved inference on 2026-09-11. strict anchored,
  consecutive, emphasized openings; inferred provenance remains visible.
  malformed numbering abstains. no book-specific matcher.
- shadow & claw splits chapter numbers and titles into sibling h1 elements.
  next-h1 termination would give a chapter only its numeral. source container
  ownership retains the whole chapter and nests the title heading.
- publisher contents grouping and semantic containment are separate: a short
  part-title container cannot erase independently bounded chapters in other files.
- failed map navigation restores its captured departure through the existing
  positioning owner; only a verified arrival establishes an excursion origin.
- rail uses two 24px interaction lanes, 52px overall. this costs width; adding
  evidence cannot displace structural ticks or targets.
- the offline map uses 45% of the available reader height while open, leaving
  55% for text at full phone width. the bounded reader shell trades vertical
  reading space for simultaneous map, arrival and return visibility. text/pdf
  owns scrolling; the shelf retains ordinary page scrolling. long book/section
  labels ellipsize visually to one line while retaining full accessible text.
- publication generations also fence find scope: fragment identity alone cannot
  detect a metadata-only structure replacement.
- hosted web bodies have immutable fragment identities. every supported source
  replacement deletes old fragments and inserts fresh ids; metadata reindexing
  leaves their text and html unchanged. the session checks source identities,
  order and canonical lengths against navigation without another body envelope.
- offline bodies carry real source fields once. metadata grows with headings;
  full chapter text does not. accessible missing-image labels must not enter
  canonical text and shift every later position.
- native reader1 packages must drain pending progress through the old supported
  client before deployment. this device prerequisite has not been verified.
  reader2 excludes unsupported packages while preserving pending and baseline
  bytes. remaining pending rows expose recovery-required and prevent refresh,
  conflict resolution, or a new download from rebinding them to reader2.
  a fresh reader2 package requires a fresh server-attested baseline; there is no
  runtime reader1 decoder or automatic conversion of unsynced local progress.

## exact-edition witnesses

copyrighted sources remain outside git in `/tmp/nexus-reader-acceptance/`.

| edition | sha256 | independently inspected source facts |
| --- | --- | --- |
| shadow & claw, gene wolfe, first orb, isbn 9780312890179 | `5e89f049ae8dd00b29053ed588e27e4d0ae5852225a96ab164827f90563ce0d3` | 79 spine resources; 66 chapter resources with labelled chapter containers and split numeral/title headings |
| the pillow book, sei shōnagon, meredith mckinney, penguin 2006, isbn 9780141906942 | `8f625aa3c9f1fd0084e1c014fc27a390f3d278bc1f50519a0272ebef7a60e88f` | 297 numbered openings over three main files; entries continue across file boundaries; source toc does not describe individual entries |

pillow book extraction passed with all 297 entries and both cross-file
continuations in `ebf47517dd301c1c` and `67e19982c8033132`. shadow exposed a
toc-parent/title-container conflict; the independently authored source proof now
passes the correction. both publication exports passed in `3b4510d6c8156dde`;
both browser witnesses pass in `b8c2648b90543cc2`. shadow covers the first,
middle, shortest, longest and final chapters. pillow covers entries 1, 82/83,
153/154, 297 and the appendix. the witnesses check independently specified
global/local proportions, exact source anchors and visible glyphs, native asset
resolution, dense-marker activation, return and zero progress writes. source
books and temporary proofs remain outside git. no production data was changed.

## run history and release constraints

- `dca8beee3d3aed58` and `85bbf29efd4d4c83`: web lint failures, corrected;
  no browser or typescript green is implied.
- `1dacd6acf7f9ef9a`: python static and shared package kernel passed;
  delivery assertion failed on legitimate top-level tail text. its oracle now
  includes the full document text. final service run pending.
- `31412c8b4ca972bb`: native owners were deferred to `full`; no native proof ran.
- reader1 packages are excluded. preserved old pending/baseline bytes cannot be
  opened, synchronized, retried, or conflict-resolved through reader2. deployed
  reader1 progress must be drained before the cut; no compatibility reader exists.
- package projection removes non-content comments/processing instructions and
  preserves their tails; stored source bytes and canonical text remain immutable.


- `66b467c42ff079ba`: selected web lint passed. broader source routing then
  reached an unrelated host-release sudo failure before browser execution;
  [ownership prerequisite](../tickets/test-host-release-worker-owner-privilege.md)
  records the exact evidence.
- `603816d42a188be1`: service/migration admission required 2048 mib with 1150
  available; no behavioral result.
- `eb064a1097e4a392`: stale pulse-fault patch rejected by policy; refreshed to
  the new visibility owner, retaining a meaningful premature-decoration fault.
- `fe03f3b910616d94`: css registry still named removed history token
  `--vine-reach`; obsolete registry entry removed, other live solar tokens kept.
- html rendering now owns decoration only. the existing target owner navigates;
  post-arrival map pulses preserve position and cannot queue a second jump.

- `eb243ee3cb6501e9`: full css and eslint passed; typescript caught invalid
  testing-library role options, an untyped absent section, nullable pdf viewer,
  and a browser matcher type mismatch. corrected; final static run pending.
- pre-existing decoded `#`/`?` filenames lose url identity before reader loading;
  original-source reconstruction is a separate source-ingest change, recorded in
  [its ticket](../tickets/epub-normalized-href-reserved-delimiters.md). the required
  editions use ordinary paths. no guessed compatibility parser was added.
- `ef6ee870628e7e2f`: python static, package kernel, epub2 doctype and
  three source-structure scenarios passed. the llm read preview assertion then
  failed; final publication, actual-book exports and migration were not reached.
  source proof includes literal percent paths and deep, long toc identities.
- `021a470d0f4d46fe`: package focus cleared the web static stage and selected
  the broad production-release kernel. interrupted by the owning controller
  after roughly eighteen minutes to prioritize exact reader owners. the run is
  failed/interrupted, not a full static or kernel gate receipt. final checks remain.
- `3b4510d6c8156dde`: source and both exact-edition reader2 package exports
  passed against independent raw-source censuses. migration stopped at its fixture’s
  old toc order key (`000` violates the historical four-digit shape); corrected
  to `0000`. no migration behavioral result from that run.
- `2668b3eef454e0dd`: selected web static and coordinate kernel passed; offline
  browser exact jump/return/save reached the reflow assertion, which detected
  about 246px of source-anchor drift. correction and final browser run pending.
- `28ac46f2d106a540`: offline geometry also fails under the actual global
  stylesheet. width reflow clamps browser scrollTop before ResizeObserver; the
  resulting scroll capture overwrote the retained source anchor. restoration
  must finish before publishing a position for the new layout.
- `5c9c5cc5169f244c`: migration reached the rewrite and exposed foreign-key
  installation after pending deferred events. replacement constraints now belong
  before row mutation, inside the same transaction; corrected run pending.
- `82474d0d8d55d184`: python static, package kernel and eight service
  scenarios passed: exact cursor admission, llm reads and six package-delivery
  scenarios, including reader2 account binding. the positions proof still
  expected a flat slice for a parent h1; its independently authored h1/h2
  hierarchy requires parent extent to eof. oracle corrected; publication code
  unchanged.
- `aa4c1c2e26ee4d45`: the layout fence removed the large reflow clamp drift.
  remaining motion exposed persistence on the first keyboard-scroll frame.
  offline now targets native `scrollend` for durable writes, with continuous
  orientation updates. this waits for the gesture/animation to finish and
  requires current chromium/webview (chromium114+); there is no timer polyfill.
  forward input already at eof is handled directly because no-motion gestures
  emit no scrollend. [browser contract](https://developer.chrome.com/blog/scrollend-a-new-javascript-event).
- `1df62fc821caee26`: migration passes after installing replacement foreign
  keys before row mutation. source, cursor, reference and generation changes
  remain inside the single alembic transaction.
- `67217cde33471fc1`: coordinate kernel, all eighteen offline scenarios and
  fourteen session scenarios pass. pdf then rejects the new proof's incomplete
  pulse locator before its decoration assertion; the fixture now supplies its
  required exactness field. remaining component owners are pending.
- offline decoder review found python normalizing nested navigation uuids
  while typescript/native compare exact wire identities. python now requires
  its validated navigation to round-trip unchanged; the shared rejection vector
  changes only the nested media uuid's case. final cross-language run pending.
- `844c27b775c083ca`: shadow & claw passes actual-source global/local geometry,
  chapter selection, dense-marker activation and return without progress writes.
  pillow book passes its document total and source/image arrival checks, then
  reports two local ticks where the source witness expects three; diagnosis is
  pending. its external census now excludes non-rendered xml comments. the
  earlier python witness covered selected target resources, not every resource's
  count; full-document prefix arithmetic belongs to this browser witness.
- `b7af98b43051abbc`: both publication positions scenarios and the python
  package kernel pass, including the canonical nested-uuid rejection vector.
- final consumer audit found an epub evidence decoder still requiring removed
  section identity, and direct search labelling whole fragments with a nearest
  chapter. both consumers now use exact fragment addresses; verification pending.
- node activation prefers retained unique source anchors, including image-only
  destinations in otherwise nonempty fragments. ambiguous authored anchors fail
  explicitly. the primary text point uses the same geometric reading line as
  exact positioning; the visible band retains preceding context. no click-selected
  section latch is introduced. final geometry proof pending.
- import-stage progress still calls staged content files chapters; repairing its
  separate live/history vocabulary is outside the reader cut. recorded in
  [its ticket](../tickets/epub-import-progress-counts-files-as-chapters.md).
- `d83e2e133eaabbde`: exact epub evidence decoding and real sql document/highlight
  search resolution pass after removing the stale section assumptions.
- `8210e9670db6b340`: coordinate kernel and both pdf scenarios pass. offline
  persistence saves the literal source offset 1924 under the shared reading-line
  contract. its independent glyph oracle was stricter than that contract across
  an image gap; corrected to observe the actual first glyph below the line.
  closing the offline pdf shell before its document loaded also exposed an
  unowned pending pdf.js task. the existing bootstrap now fences module/document
  awaits and owns cancellation through handoff; combined component rerun pending.
- `b8c2648b90543cc2`: both exact-edition browser witnesses pass against the final
  text renderer and independent source census. the primary reading-line correction
  resolves pillow entry 297's local scope; both coincident appendix destinations
  remain visible at its endpoint. temporary serving paths are removed before
  artifact generation and commits.
- `5db881bf986ff4af`: the offline browser owner passes, including zero-text,
  mixed image/text destinations and ambiguous-anchor rejection. temporary native
  event traces in `d45b0fe02d1e72ba` show real map and return scrolls finishing
  before the next trusted arrow input; each resulting gesture saves its final
  location. no stale-end loss was established. diagnostic assertions were removed;
  their deliberately failed run is not a passing gate or a universal timing proof.
- `da004305ad280852`: natural offline layout lets long content expand the page
  while capture observes an inner viewport. the open-reader shell needs a bounded
  height and a continuous shrinking flex chain. a fixed-height test fixture alone
  would conceal this production defect. layout correction and verification pending.
- native source-path review found java uri parsing rejects literal spaces and
  percent signs admitted by python/typescript. shared accepted vectors now retain
  those exact filenames; native validation correction and cross-language proof
  are pending. no source-path decoding or normalization is introduced.
- `bb3b9046b63d607f`: all twelve focused web owners pass after the bounded
  offline shell, parent-sized pdf, exact source-reference return and same-glyph
  passive reflow corrections. natural phone geometry, mixed image/text targets,
  ambiguous-anchor rollback, durable canonical saves, eof, pdf cancellation and
  map/detail/pulse/session contracts pass. full web static/portfolio is pending.
- `3df66a0922474b48`: full web css/eslint/typescript, kernel and browser-component
  portfolio passes on the final product source. no repeated unchanged-green run.
  native artifacts, deliberate-fault proofs, hosted journey and `pr` remain open.
- `8f92020f20a93dd5`: both books pass through the actual offline shelf/native
  open flow at 390×720, without leaf sizing overrides. independently specified
  source loci/proportions, bounded map/text geometry, no outer-page movement,
  exact jump/return, image decoding and zero saves pass. both phone captures were
  manually inspected for clipping; they use the test's light theme, not a dark
  theme appearance proof. private screenshots and temporary serving/proof files
  are removed from the worktree and retained only outside git. preceding run
  `4749a52c0c4fe516` failed only because screenshot output to `/tmp` was forbidden
  by vite; it is not a product red.
- python literal-path sensitivity: `d99b6e32a3442d57` restores the previous
  `urlsplit` implementation and fails at `reject-epub-empty-source-query` with
  `DID NOT RAISE`. after immediate restoration, `f1745188b5743c88` passes the full
  package kernel, including both empty-delimiter rejects and literal space/percent
  accepts. no deliberate fault remains in product code.
- offline reader assets regenerated successfully with `bun run build:offline-reading`;
  source/asset closure is current. existing custom-highlight selectors trigger
  minifier warnings recorded in [their ticket](../tickets/offline-css-minifier-rejects-highlight-syntax.md).
  native execution remains pending.
- checkpoint `e169805fa9` contains the implementation and rebuilt offline assets.
  native attempt `52f83fb860cc0c0f` stopped before execution: the global fault
  registry rejects literal `[id]` in the evidence proof's existing route path.
  [controller defect](../tickets/fault-registry-rejects-literal-route-brackets.md).
  the evidence test remains registered; its owner exists at base and uses
  ordinary base sensitivity instead of an unnecessary injected fault.
- native `ea0671f6e9e7d495` compiled and executed the host portfolio (186 tests).
  the injected filename defect failed at `OfflineReadingSharedContractTest.kt:98`,
  but gradle's short exception format omitted its assertion message. the controller
  therefore rejected the run as a behavioral witness and did not run green.
  full exception diagnostics belong in the existing app test-task configuration;
  the controller's assertion classification remains strict. normal gradle test
  output now retains full exception messages without stack frames, keeping the
  assertion and case identity within the controller's bounded output tail.
- native `2cb243a45b4aeeb2` passes deliberate-fault sensitivity: adding the old
  java uri parser rejects the shared literal-space case at its named assertion;
  the clean candidate passes the host suite. together with python
  `f1745188b5743c88` and web `3df66a0922474b48`, the three decoders agree on the
  literal-path corpus. oi-077 is resolved and its ticket removed. unsupported
  pending-progress fault sensitivity remains separate and pending.
- native `176851af2da64494` passes the separate pending-progress sensitivity:
  deliberately deleting unsupported-package progress fails at the named row
  preservation assertion; the clean host suite passes. reader1 bytes remain
  protected without a reader1 decoder.
- `0538379d1a45427d` passes evidence-decoder sensitivity against the actual
  base revision: the new fragment-only epub payload fails the old section-bound
  decoder and passes the current one. no alternate proof path or controller
  exception was needed.
- final ticket audit requires two direct hosted interaction witnesses: scrolling
  through three headings in one fragment changes current context/local progress;
  previous/next traverses source order once despite reversed toc and coincident
  section aliases. the existing mandatory journey owns these route interactions;
  no second journey or production harness abstraction is introduced.
- `4cf713e3c75e2b98`: hosted current-section, pinned local progress, source-order
  toolbar traversal, coincident aliases and quiet navigation/restore pass. natural
  end-of-book then saves offset 8274 instead of the independent literal 8762.
  restore-phase callback changes restart the resize observer and erase a fresh
  forward gesture. observation now depends explicitly on source/layout identity;
  its existing callback ref supplies current capture behavior. rerun pending.
  the retained faulted phase reaches the expected restore-write assertion;
  failed candidate execution means the combined sensitivity gate is not green.
- activity `38f298bee272ad66` → `6e6b5b476f5b38d7`: source/control activation
  incorrectly adopts restored reading; the existing real recorder boundary now
  stays idle for those activations while prose taps and scroll keys remain valid.
  epub toolbar and inline links reuse the map's existing positioning/return owner.
  follow-up review found inherited same-source restore eligibility and Space on
  owned inline buttons; those additional counterexamples remain under correction.
- activity `80eb006860477541` → `27c5cc5ba1e23706`: a prose tap adopts one
  restored viewport, then another restore in the same fragment must become idle.
  admission now retains the exact adopted viewport instead of a reusable source
  key. an ordinary `Reader` publication already cleared adoption; the actual
  defect was a second restoration before that publication. no new epoch or
  activity lifecycle was introduced.
- text input `3178da7c476361a5` → `34b5b925426e03fa`: space on the actual
  inline resource button formerly emitted forward reading intent before its
  activation. one shared keyboard-direction classifier now excludes control
  activation while retaining native scrolling over links. the existing text-leaf
  and activity browser owners pass together; no compatibility type export remains.
- source `e8f051ff1ff46e06` → `76487e7d2462ea6a`: an unrelated publisher
  paragraph must not parent the next source heading. actual-book export
  `96205f8d145565be` then exposed stale lexical context across a later publisher
  root boundary. the first correction's source green does not prove that second
  case; final hierarchy correction and book metadata/browser review remain open.
- source `0c4f27f0500d19b3` → `7f5f00d4cf40c0fb`: a publisher root boundary
  ends the preceding heading context. the lexical stack is rebuilt from actual
  heading/container ancestry at every boundary; an ordinary publisher paragraph
  neither becomes a heading parent nor leaves an expired heading active. literal
  parentage and all three adjacent end offsets pass, along with the prior source
  cases. final book export/browser recertification follows this correction.
- `e1e1e2d52d9197f6` and `ed4a7886d486dcc6`: final source exports and both
  natural 390px phone-shelf witnesses pass after hierarchy and input corrections.
  canonical text and every section target are unchanged; all 297 numbered entries
  retain their metadata. obsolete publisher ancestry changes 73 shadow sections
  and 30 pillow sections, including 2 and 11 extents respectively. rendered html
  is unchanged apart from fresh-import uuid names. both final screenshots were
  inspected for bounded panes and clipping. private inputs/proofs/screenshots are
  outside git, and temporary serving paths are removed.
- source review of those metadata changes found opening anchors nested inside
  headings (`a#int` within `h2#page_ix`, among others). treating the anchor as an
  unrelated publisher boundary duplicates its heading subject and can discard
  the heading's lexical context. the selected book checks did not target this relation;
  their green does not prove it. exact ancestry plus equal canonical start now
  defines the required heading-subject reconciliation, preserving publisher ids
  and source jump anchors. the source owner is adding its direct counterexample
  before correction and renewed book verification.
- `ac3776e24d0e3399` → `f815c0ae8b2490bb`: a publisher anchor at its containing
  heading's start now augments that heading rather than producing two section
  subjects. the original publisher id, anchor and target are retained. the same
  source proof keeps a coincident sibling anchor distinct and preserves a later
  inline anchor at offset 18 instead of moving it to heading start 14. full book
  recertification follows; this is source ancestry, not title/position inference.
- raw-xml review corrected the preliminary introduction diagnosis: its next
  heading at fragment 3 offset 5366 is h2, not h3, so the introduction ends there
  under authored peer-heading semantics. chronology's h2 at 2131 does contain a
  following h3 and extends to 4275. no inferred introduction hierarchy was added.
  export `7bc0d286bf1bab87` passes: shadow retains 149 sections; pillow has 567,
  removing seven duplicate heading/publisher subjects. all 297 inferred entries,
  their cross-file continuations, appendix starts and canonical text are preserved.
- book browser `527da545db2ccb39` passes shadow and exact appendix-anchor
  visibility, then fails its temporary glyph oracle. diagnostic
  `0a504b9ae7301823` identifies the bad premise: `HtmlRenderer` projects source
  heading levels beneath the route heading, so source h2 need not render as h2.
  the oracle now locates the independently authored enclosing id `page_257`;
  its actual glyph-visibility requirement is unchanged. no product correction
  or relaxed arrival requirement is justified by this failure.
- `933ea7a501a0bd64`: both final natural-shelf book witnesses pass against the
  final ancestry reconciliation and shared input classifier. unique source
  coordinates, all 297 numbered entries, canonical text, exact arrivals/return,
  local/global geometry and quiet navigation are retained. shadow has 149 sections;
  pillow has 567 after seven redundant generated heading subjects are reconciled
  with their preserved publisher nodes. temporary assets/proofs are removed.
- checkpoint `90c1696a15` includes final source/input corrections and the
  regenerated offline bundle. final screenshots are manually inspected; packaged
  source/asset manifests contain no private acceptance inputs.
- hosted `55aeafdd877e53be` receives sigterm during isolated setup, before any
  executable proof; exact cleanup completes. unchanged retry `c39c87080ba3c3a5`
  completes the hosted scenario, including exact eof, but its old one-arm-removal
  fault also passes. that fault is ineffective; this is not sensitivity green.
  the registered product-only fault now removes the central capture-suppression
  consume guard while retaining exact locator/equality checks. assertions and
  the existing no-write fingerprint are unchanged; new red/green remains required.
- final shared-input offline bundle rebuilt successfully: `index-Y7sNzIEk.js`,
  416.27 kb before gzip; css unchanged. source and asset manifests regenerated.
  the same existing custom-highlight minifier warnings remain tracked in oi-078.
- existing web ingest replaces authored heading ids without updating links or
  labelled-container references. source repair is outside this metadata-only cut,
  recorded in [oi-080](../tickets/web-ingest-replaces-authored-heading-anchors.md).
- ordinary pdf page turns already count as genuine reading under the prior
  continuity contract. that behavior remains. zoom shares their wrapper and can
  incorrectly renew reading eligibility; this separate control defect is
  [oi-081](../tickets/pdf-zoom-renews-reading-activity.md), outside map orientation.

## final focused acceptance

all following `./scripts/test prove --proof <owner> --against fault:<id>` runs
use candidate `3bfa2e2db5`. every retained red reaches its registered assertion;
every clean candidate passes. the registry names each exact owner and patch.

| fault | red/green receipt |
| --- | --- |
| reader-restore-write-suppression-bypass | `8b0b983d002cd181` |
| reader-position-fragment-prefix-bypass | `18fa8a23d4ba119a` |
| reader-position-end-locus-bypass | `3d3cd6402f80c476` |
| document-map-pulse-early-release | `d8d480a6a404202c` |
| epub-structural-anchor-preservation-bypass | `3dae7bafc1f26d11` |
| reader-map-transitive-cluster-bypass | `00e6ce31846dcf19` |
| reader-structure-cursor-migration-bypass | `372632436febeebe` |
| reader-map-detail-scope-follow-bypass | `c6cbe7a83935ec23` |
| offline-reading-account-binding-reader-version-bypass | `980f0b30b5640e15` |
| offline-reader-pixel-offset-bypass | `096a2704a6612428` |
| epub-reader-cursor-source-admission-bypass | `9c8623df5b423c59` |
| offline-reading-unsupported-package-progress-deletion | `c5fae5708c454ef1` |

the final native run executes 186 host tests, including 16 request-router tests,
against the regenerated `index-Y7sNzIEk.js` bundle and its manifests. this resolves
oi-051's packaged-bundle verification debt; oi-052's selection defect remains.
it is not physical-device or signed-promotion evidence.

`./scripts/test changed python/tests/service/test_epub_structural_anchors.py`
passes as `266ee9d2b5c3406e`: two physical resource paths share a 256-character
prefix; duplicate and distinct publisher targets have bounded unique ids and
repeat extraction retains those ids. canonical text and all independently
specified offsets remain unchanged. generated heading ids depend on new fragment
identities and are correctly excluded from cross-extraction identity equality.

oi-061–068 and oi-070–073 are resolved at their software ownership boundaries.
oi-070's original actual-book highlight clause is superseded by the approved
available-target scope: the exact-edition witnesses use the offline shelf, whose
annotation snapshots are an explicit non-goal. no actual-book highlight proof is
claimed; the shared rail owner proves clipping preserves the original passage
activation target.
oi-071 combines real many-section exports, the independent source census, and
strict one-to-one fragment/content decoding; its python export proof does not
contain a literal 23-fragment/567-section paired-count assertion.

[oi-069](../tickets/reader-map-inert-position-and-mobile-controls.md) retains
manual assistive-technology and actual-touch review. pointer/keyboard proof and
reviewed phone screenshots do not discharge it. mandatory repository gates and
the predeployment drain/census/coordinated-artifact obligations above remain
separate from these focused passes.

`69ca1fecb5d3ed24` repeats source fault sensitivity successfully at `faba868779`
after the stronger long-path witness. the same candidate's actual-base `pr`
(`NEXUS_TEST_BASE_SHA=7fa89b88c8342bca9edfb46a6d20053c49555fb2 ./scripts/test pr`)
fails as `f5e5b75ff8fbd0cb`: native BASE replay runs reader2 fixtures through
reader1 admission and fails before the intended assertion. every ordinary pr
capability is `not_run`. [oi-058](../tickets/pr-sensitivity-cannot-accept-new-vitest-owners.md)
records this native instance of the changed-non-python hard-cut limitation.
controlled fault passes do not waive the mandatory pr gate. independent
`confidence --base` execution follows for full static/kernel and affected
service/component evidence.

first confidence run `5f0346622e5d8987` stops at full policy: the changed risk
ownership registry has a stale frozen digest and the hosted journey still names
deleted `epubHelpers.ts`. independent mapping review also finds that repointing
the delivery and source-structure canonical nodes dropped their sibling cases
from ordinary source-triggered selection. restore both whole-file routes beside
their single fault-bound exact owners, remove the deleted helper glob (the
existing `lib/reader/**/*` route covers its replacement), then update the reviewed
ownership pin. no prior risk source coverage or capability is removed; no policy
guard or sensitivity rule changes. full confidence rerun remains required.
