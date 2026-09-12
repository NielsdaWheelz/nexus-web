# reader document map verification

status: implementation in progress, branch `codex/reader-document-map`.
base: `7fa89b88c8342bca9edfb46a6d20053c49555fb2`.
contract: [hard cutover](reader-document-map-structure-hard-cutover.md).
receipts live under `test-results/runs/<id>/summary.json` in the worktree named below.

| boundary | behavioral red | current green | review |
| --- | --- | --- | --- |
| source extraction | `8e77c3ff3fc84ce3` | `ef6ee870628e7e2f` (source cases) | independent literal positions; split chapter heading, toc-only parent, alias, container, tail, cross-file entry and emphasized-number counterexamples reviewed |
| publication/api | `7ff9ac2851cd984a` | `b7af98b43051abbc`, `d83e2e133eaabbde` | persisted positions, package kernel and final evidence/search consumers pass |
| migration | `d12d8b1df08293be` in sibling `nexus-reader-structure-red` at base | `1df62fc821caee26` | atomic rollback, exact/anchor/manual cursor conversion, durable reference preservation and repeatability pass |
| rail/browser | `fcf20dc59bbc7f22` | `bb3b9046b63d607f` | 31 ticks with 18px gaps collapse under predecessor grouping; fixed-cell hit groups keep exact source ticks |
| offline | pending | `bb3b9046b63d607f` (browser) | reader2 only; unique content; exact canonical capture, trusted intent and bounded phone layout; native pending |
| integration | pending | exact editions `8f92020f20a93dd5`; journey pending | both imported editions pass through the natural phone shelf; full hosted journey outstanding |

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

## incomplete runs and release constraints

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
