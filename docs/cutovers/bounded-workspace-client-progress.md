# bounded workspace client progress

status: implementation in progress; no commit or deployment.
origin: 2026-09-13; spec steps b/c and initial e.

latest bounded reader integration — 2026-09-13:

- pdf paint now reads complete bounded pages for the selected document digest,
  with compact geometry only. exact selected highlight details own quotes,
  notes and bounds editing. the leaf no longer copies full server records or
  accumulates visited pages. actual creation/reconciliation and unpainted
  reattachment are green `cba80e7b3a3a0a16`. late acknowledged bounds edits survive
  reader teardown (`a9eb9d868e2dbf38`). source-note location holds its exact
  projection/node reservation through actual pulse retirement; combined occupancy
  and parent-close conservation proof is green `7b31ffd9e7661eba`.
- pdf rectangle payload and nodes are reserved on the same query lease before
  projection. the leaf constructs them inside its dom owner and detaches the
  layer before releasing committed ownership. a saved write whose projection
  cannot be admitted remains saved, with an explicit retry-highlights notice.
- contents now keeps only its exact page-owner wrapper in react state; the
  imperative list holds committed ownership through actual removal. selected
  section changes update aria-current in place and preserve button focus. held
  display/query withdrawal/paging proof is green `bcc73604f8cf59df`.
- session close aborts queries and withdraws unpublished work. published result
  reservations remain with their real consumers until row/dom retirement.
  residency exposes existing primitive payload, dom nodes and admission-counted
  leases: units plus index/find/overlay entries; resolve/context metadata only
  contribute payload. these are experiment inputs, not actual heap measurements.

- find return availability is independent of completed match preview. a first
  unit may be displayed before the tail reaches capacity; the original position
  stays returnable. actual three-unit regression red `43134c7f7cb2b9fe` → green
  `ebb5771ebb3c8377`. the complete path additionally asserts both painted ranges.
- result rows stay charged to their exact response through desired state,
  committed result/retry closures, and pending controller previews. replacement
  withdraws lookup ownership; only the last real consumer releases the lease.
  composed held-preview/replacement/retry and return proofs green
  `a2f6a56ea2713135`; dedicated early-release sensitivity remains queued. strict
  preview-defect retry rereads its query so external recovery callbacks retain no
  old rows; expected preview failures keep their current rows and retry action.
- prepared-root waits cancel when their exact unit is retired, including a
  completion retired before its wait registers. the lease exposes its existing
  released state; no new request or lifecycle owner. actual body proof pending.

- retained section controls render exact previous/current/next summaries and
  source position/count even when content lease count is full. focused green
  `a67469c6f8971a6f`. constant-cardinality context still reserves payload and
  physical read permits; content/index/find remain count-bounded. the whole
  section dropdown becomes the paged contents surface.
- authored epub links use the clicked unit's source base. source href spelling
  stays unchanged; browser pathname normalization is the one shared lookup
  owner. independently declared unicode/percent/path corpus and find collector
  green `be8cc1a16e0bba2b`.
- hosted reader sessions are acquired/disposed by one effect lifetime. shared
  released-unit unpin is idempotent; acquiring a new pin remains a defect.
  runtime's actual native strict-mode close red `89c0b0c06d4078ba` → green
  `2bc2481945e0635e` proves that teardown correction.
- actual publication find composes retained query/session/window/direct-dom and
  the pane find controller. a held `bea|con` tail cannot acknowledge a complete
  preview; the original reading position remains returnable after admission.
  focused green `a2f6a56ea2713135`; registered tail-omission sensitivity pending.
  read scratch remains reserved through sizing one projected row at a time;
  all result rows are reserved before construction and retained on the same
  result lease. only the final result projection is retained. its charge survives replacement
  until committed consumers and old pending previews settle. modeled preparation/return capacity keeps the existing retry
  owner; strict defects remain scoped to reader content.
- removed the old epub find section overrides and adoption state from the media
  body. preview movement uses the admitted unit window and existing genuine-input
  fence. the body owns one exact prepared-root completion, with cancellation on
  replacement/unmount and explicit dom-capacity failure.

- the contents surface consumes one purpose-separated `contents_ref` page while
  visible. first/next/retry re-read exact retained members; withdrawal clears the
  exact old result and returns its payload/dom leases. source depth is exposed
  through native list-item `aria-level`; standard button keyboard behavior stays.
- find occurrences carry the retained canonical locator. the collector keeps the
  existing 2,000-match limit and proves overflow with the 2,001st occurrence.
  locator ingress red `d00e34638a65c364` → green `8869df1810eba72e`.
- the existing css highlight owner paints one occurrence across admitted unit
  pieces; an unadmitted tail reports incomplete. red `c6ffd5cb5c64c3e8` → green
  `5f9b969d49c87b1e`; same green covers contents replacement/withdrawal and levels.
  contents sensitivity still needs its coherent fault; its first fixture failure
  `c38c613eadc7f3e3` was an incorrect external query-url stub, not product evidence.
- hosted contents navigation now records movement only after addressed-unit
  admission. canonical reset waits for the selected first unit's prepared root.
  the window's existing neighbor request now returns its exact completion too.
- `usePaneFind` can publish keyed strict defects to the existing reader-content
  boundary, preserving the media controller. this latest observer seam is staged,
  not yet qualified by its actual media composition proof.

remaining activation blockers: old full-navigation/annotation/document-map consumers
in `MediaPaneBody`, final sensitive find/section/link composition,
figure/vector activation, final two-pane
capacity qualification, and sensitive actual hosted/native reader proofs. no
complete reader or release claim follows from the focused receipts above.

implemented:

- one transport decoder preserves owned errors/metadata and normalizes raw
  502/503/504. replacement gateway bodies lose obsolete representation headers;
  head remains bodyless. successful bodies remain streamed by the bff.
- one three-attempt read schedule; exhaustion stays a defect. nexus retains its
  controller/drafts while a descendant boundary catches published read defects.
  the read boundary keeps its children mounted while it renders a failure: a
  pane's reader, selection and drafts survive a failed read inside it, because
  unmounting the subtree to show a notice is how a contained failure became an
  uncontained one in the incident this cutover exists to answer.
  imports retains last-good rows and confines refresh defects to its existing
  freshness notice. initial reads still fail at their owning boundary.
- scoped structural telemetry for pane, workspace, nexus, imports and reader
  progress; no private content or fabricated pane identities.
- prefetch adoption/cancellation remains charged until settlement. exact-entry
  claims and completion cannot consume or overwrite a replacement. reference-
  counted hover withdrawal cannot abort an adopted foreground read.
- seed only the selected pane; preserve original resume/navigate intent when
  recovering a local workspace.
- hosted reader capture commits account/visit intent to indexeddb before
  `durably pending`. delivery freezes attempts, reconciles lost acknowledgments,
  conditionally retains newer movement, and installs the acknowledged baseline
  before deletion. one-row orphan scans continue past conflicting writers.
- active ports register acknowledgment ownership before capture. foreign browser
  completion forces authority reconciliation when the local acknowledgment is
  missing; ordinary acknowledged cleanup adds no read. teardown retains started
  capture and fences later network dispatch at account lifetime end.
- exact orphan recovery choices retain their writer/sequence/attempt identity.
  hosted and native adapters use capture/flush; native delivery remains owned by
  its existing synchronizer.
- source selection reads the actual publication descriptor before progress.
  unknown/changed source positions remain visible recovery data and are never
  automatically applied. body reads still use legacy content endpoints: the
  intermediate source seam is NOT release-ready.
- canonical character counts no longer materialize code-point arrays. offline
  article navigation counts each fragment once and derives prefix offsets once.

observed focused evidence through `./scripts/test`:

| contract | red receipt | green receipt |
|---|---|---|
| raw browser gateway | `a7a9ad0c18dbab45` | `41f46285f20b7a2f` |
| raw bff gateway | `bedc850a9b676a37` | `41f46285f20b7a2f` |
| adopted prefetch capacity | `f5619ba2516cb0b7` | `13fbe745f2974e1e` |
| stale prefetch settlement | `2b8040e52818123c` | `13fbe745f2974e1e` |
| exact observed-entry claim | `7d5bd38a2383a6a9` | `13fbe745f2974e1e` |
| running obsolete hover withdrawal | `351a1ac3d9ffa8fc` | `13fbe745f2974e1e` |
| nexus exhaustion preserves draft | `b502d8c0064d8f6a` | `4867bb6f59fd61e9` |
| imports exhaustion preserves stale rows | `506926e361b1069d` | `4867bb6f59fd61e9` |
| source-aware hosted acknowledgment | `e376ccd6d21ab8cd` | `2ddce83e9bf708f1` |
| acknowledgment retains newer intent | `40f5ae8107ba6634` | `2ddce83e9bf708f1` |
| foreign acknowledgment updates live writer | `89f7f79cc067b296` | `c1bdee2c33c224bf` |
| delayed authority cannot regress live writer baseline | `5d419d48f16d8e15` | `7792a7bf74a0c81e` |
| find return cannot establish an unknown-source position | `bab202e42f160141` | `c18eda40fe15d9dc` |

additional focused green: envelope metadata/head, unicode history contract and
indexeddb store `ae593ad85683750c`; composed hosted/native/pdf
`d996b85b9b2ff885`; runtime lost-ack/teardown/outage `117d0f9266377704`.
offline unicode prefix navigation and expanded server telemetry scopes pass
`a776c56ce5276f23`.
raw immutable-member integrity/length/generation and gateway classification pass
`12922b36bba24f56`; initial shared-unit race/pin/admission composition passes
`bdd6dd151834e80d`. these new primitives still require sensitivity and final
source/session integration. decoded reservation now includes simultaneous wire,
utf-16 json, parsed primitives and typed primitives (11× member bytes), then
contracts to retained primitive payload. it does not claim to bound js/dom heap.
the intact-table recipe in `testdata/capacity/reader-tables.json` is an experiment;
128k/512k/2mib profiles and one/two complete reader bodies are not safe defaults.
temporary controlled faults were restored in `finally`; expected behavioral
assertions failed. `prove` receipt `de076f74f7765a05` was unavailable because it
requires a clean committed checkout. the registered patches remain for that gate.

remaining: final independent review, enclosing real-stack proof, immutable-unit
source/lease/render integration, complete generation-bound find/navigation,
pinned interaction and twelve-pane browser qualification, native publication
conversion, exact clean checkpoint gates. these kernels do not establish those
contracts or production memory savings.

price (2026-09-14): the document-map overview rail no longer activates a
single-destination bucket in one click. bucket buttons are disclosures
uniformly, because a bucket's cardinality is data and a control whose meaning
changes with its contents cannot be announced honestly. a one-destination bucket
now announces that destination by name (`Highlight near 24% through document`)
and its list is one keystroke away. the lost click is the price of a stable
control contract.

prices: descriptor-before-progress adds a cold round trip. reduced speculation
can increase first-paint latency. unobserved foreign acknowledgments require a
small authority read. retained pending intent adds local storage and explicit
conflict feedback. prefix lookup retains one small record per fragment; text is
counted once. existing 16-prefetch limit remains a legacy bound, not a qualified
api or browser memory budget. immutable lease budgets have no invented safe
fallback values.

2026-09-14 intermediate source cutover (not buildable/release-ready):

- source now requires account cache and the explicit `readerCapacity.ts`
  experiment profile. descriptor/member bytes verify length, generation and hash;
  old full-fragment/section methods are removed. session and hosted/native callers
  are being moved together; incomplete consumers are not acceptance evidence.
- selected download generation and label pass the actual resource-menu boundary
  in `397f6df769f17d45`. generation sensitivity is still outstanding. correction
  (2026-09-14 adversarial review): the owners behind this receipt have changed
  since it was taken (the resource-action fixtures now compose the real account
  cache and artwork provider, and the member-response fixture was consolidated),
  so `397f6df769f17d45` no longer identifies the bytes it certifies and MUST be
  re-run before it is cited as acceptance.
- raw-member bff finalization/compression red `589df29ee0d2d152`, obsolete digest
  red `b94c6fc64e685e84`, matching green `397f6df769f17d45`.
- table experiment `a6b1e927cbd3818f/reader-table-capacity.json`: two complete
  2-mib dense tables add about 970 mib of blink/embedder heap and 619k nodes;
  js heap alone misses this cost. this does not qualify 64-mib tables, native
  webviews, or decorated workspace readers. oversized table continuation is
  required; atomic-table exceptions are not justified.
- runtime review found dropped HTTP retry-after guidance. early-retry red
  `7bf50498c2ce778d`, dropped-header red `65e8a91f87c6f989`, deadline-guidance
  red `b22f451636167d60`, and late-success/hidden-decode-defect red
  `760782601db3d8fe` now pass in `57bf7fdbbd98b07e`. the explicit 30-second
  total foreground budget is an experiment input, not a qualified production
  deadline. server guidance is never shortened to fit it; exhaustion stays loud.
- raw publication and artwork reads share `readBoundedResponseBytes.ts`.
  publication integrity/classification proofs pass in `80fd0e3031bf78f2` after
  extraction. the helper validates declared length before allocation and counts
  actual streamed bytes; callers retain their distinct type/digest contracts.
- device-bearing progress views now carry their actual source. hosted intent
  proofs pass in `4c95304361e59980`; native resolve additionally carries the
  reviewed view and opened publication identity for conditional disposition.
- browser html parsing can repair/expand a valid lxml tree before a post-parse
  limit runs. the agreed publication display cut replaces html with explicit
  flat render nodes, counted before direct dom construction. this is still
  being implemented, including admitted highlight/embed additions. legacy
  transcript html remains its existing format; there is no whole-document
  publication fallback. price: more wire bytes and explicit construction;
  malformed legacy markup can lay out differently from browser-repaired html.
- session composition no longer memoizes a promise owned by an earlier
  caller's abort signal. the existing resource hook owns request lifetime;
  selected generation and explicit unit leases remain session-owned.

- 2026-09-13: exact render-tree decoder/direct `HtmlRenderer` adoption green `0acf8ccc410e8ca8`; prior HTML-only decoder red `7db7ffbb20c58d76`, ignored prepared root red `f984fb77d7d78538`. DOM-name/text grammar red `7f1fd1b2e17a2879` → green in `dee8c57d07268a44`.
- original-fragment locator coordinates red `9ce0c90f39feb682` → green `3835cfe87e101ca1`. canonical word continuation red `d673d1f4463aed6a` → green `dee8c57d07268a44`; `starts_in_word` prevents counting one source token twice across units.
- highlight plan/application and privacy diagnostics green `409cb06de75af3a6`; private-text logging red `55790db5418becc8`. new API import failure `17ff97613a9e169a` is not behavioral sensitivity.
- direct publication node construction reserves source nodes plus two mounts before allocation, then reserves highlight additions before modifying the same tree. actual session/DOM capacity and selection proof green `965f715b36c8ddad`; local SVG `use` reference bypass red `252421040997da26` → same green. non-navigation local references now wait for vector/figure admission too. unavailable images retain authored dimensions without setting a source URL.
- exact view acquisition handles replace key-only release. immutable request/byte sharing stays in ResourceCache. initial descriptor/authority load now returns an addressed unit; the view owns acquisition. cancellation cannot erase a later visit by member key. exact lease/cache/DOM proof green `b2a39c09b6b497ae`; source response identity red `45171250e61ddc23` → green `c8b4c3648c85c662`.
- remaining source hazards are recorded in `reader-highlight-query-residency.md`, `reader-svg-instance-residency.md`, and `reader-svg-metadata-canonical-text.md`. no full workspace, figure-decoder, native renderer, or release-capacity claim.

- typed local SVG reference decoding/deferral and exact unit leases pass in `429e73b88ae2d82e`. resource attributes remain deferred until their separate figure/vector admission owner runs; this is not a decoder residency qualification.
- original full-document projection red `76ec75540009f22e`, cross-unit source selection red `cf3e9716265fa34c`, and direct two-root reader adoption red `7fa3a51cd1e2b415` → combined green `7e4175db8f6eacd2`. selection extraction retains at most 2,000 canonical codepoints; wrapper paragraphs never become source separators. different original fragments retain native selection/copy only under the existing single-fragment highlight contract.
- image-only zero-extent projection red `4f92c2f4e18aa01d` and authoritative lease-pin inspection red `1daede1d19bdde35` → green `d23dfb7c168ea9ba`. the body continues to omit text metrics when no canonical text exists; addressed-unit navigation is independent.
- disk-stalled reader run `cdb511d64ecf1c3d` was interrupted and is `not_run`, never behavioral sensitivity. focused verification resumed after runtime-owned artifact cleanup; no full build or qualification was claimed.

- required retained `epub_target` removes the need to load navigation merely to save position after entering a new EPUB fragment. decoder sensitivity `974ad7a036515360` → green `fea0fbb429e1ba6c`; existing target validation is reused, and its strings count toward payload residency.
- direct DOM/cursor/source-span/reader-leaf composition passes `fb47417597bafcdb`. actual media body now stages source-unit content, lease-keyed prepared roots, original selection/viewport coordinates and descriptor-derived document extent. the body retires roots before the view hook returns payload handles; all pins are checked before any retirement. its old navigation/find/overlay consumers are still being cut over, so the body is not buildable or acceptance-ready yet.
- explicit navigation may replace the unpinned window with a short loading interval. pinned windows retain their roots and exact pending target for retry. when the experiment lease bound fills before a viewport does (for example, tiny or image-only units), explicit forward/backward continuation remains reachable; the lease count still requires measured qualification.

2026-09-13 reader-content containment and window integration (incomplete):

- opaque publication fragment identities preserve valid legacy ids and 256
  unicode code points; media/account ids remain uuid. red
  `39f49aa9d1e6e2a8`, green `c472238f4aeb99fd`.
- exact read keys/request ids publish defects to a reader-content descendant
  boundary. initial retry keeps the selected descriptor; neighbor failure keeps
  admitted text, note drafts, and other readers mounted. delayed superseded
  retry failure cannot revive the old notice. red `4fd8233b31ec62c3`, green
  `83921e95f0919d97`. telemetry uses structural reader-content scope.
- body now stages contiguous viewport demand, authoritative pin checks, detach
  before payload release, and canonical-anchor preservation around replacement.
  ordinary activated links transfer focus to the reader viewport; selections
  and editors retain pins. enclosing body proof remains outstanding: legacy
  find/navigation/sidebar consumers are still being cut over. no build or
  release acceptance is claimed.
# shared read admission and source load — 2026-09-13

- nullable `word_boundaries` is an explicit schema refinement for converted native packages, whose existing capability omits Find. shared decoder preserves null; hosted source rejects null. observed reds `e37bf2fae4425a12` / `d1042fa3b59e5688`, green `c8eb09fd0ac6c43f`. display does not consume this metadata.
- account cache invalidation removes lookup ownership while retained active payload and unfinished physical work remain charged. native adds its concrete lease id to account/media/g/member identity. focused green `6e29c71d0c6a2e15`; missing clear-method red `74c7e779bca090a7` precedes the independent accounting oracles.
- exact window navigation completion is staged and focused green `df6a58d6f895f937`. fault `reader-window-navigation-completion` targets abandoned old completion on supersession. dirty-main prove refusal `08877cee27d6b9a8` is not sensitivity evidence; an isolated checkpoint or coordinated fault run remains required.

- session/window/find collector: `bb280cc506ccb423` passed. authority selection returns an initial target; the window resolves it under source scratch admission. initial unresolved intent remains visible while first-unit fallback loads.
- all publication reads now share the account cache's execution permits. query-vs-unit cancellation regression: red `00c64bbbac191553`, green `04174fee0c5cfea9` (also unit/cache/window/query focused owners). cancellation keeps admission until physical settlement; retry backoff releases execution admission but retains its payload reservation.
- initial descriptor capacity is a typed load outcome with explicit retry. no progress authority is synthesized. downloaded readers use the extracted unit window with their existing progress writer; native find remains unavailable under its existing contract.
- query result and index leases use primitive-payload accounting (keys and values); arrays/objects/allocator/DOM overhead still require independent actual-heap qualification. experiment profile remains unqualified.
- selected query bff routes retain exact identity bytes and no-transform policy. embeds/highlights/summaries forwarding is staged; enclosing product integration and real proxy query-byte proof remain outstanding.

2026-09-13 find completion, retained layers, and selected highlight detail (body cut incomplete):

- complete find preview requires every intersecting unit and its actual prepared root. displacement may expose return even when tail admission fails; return availability is independent of successful full-match painting. ordinary green `a2f6a56ea2713135`; frozen tail sensitivity `582036fe1ac37426` and live-row retention sensitivity `72f6536d8b8a30f1` at `adb73a7508`.
- find rows remain charged while desired state, committed ui, or a pending preview callback consumes them. strict defect retry rereads the query instead of retaining an uncharged stale row closure. explicit unpinned distant navigation may show a brief loading interval; source selection and editing pins prevent retirement.
- selected-unit live overlays aggregate every bounded page before success. partial paint/cards never become a successful complete layer. exact immutable occurrence/range metadata is projected before awaiting, under the existing session reservation. two-page aggregation and source-range ordinary proof green `db114a45c75478ee`; source-range sensitivity is running in the root proof checkout.
- duplicate highlight conflict recovery reads only the backend-addressed owned id through the existing cancellable highlight read owner. publication keeps only selected/requested authored detail; transcript retains its existing fragment projection. green `9519ae0912c58dd7`; dedicated address-loss fault registered, sensitivity pending. correction (2026-09-14 adversarial review): this owner has since changed (the mutation-session supersession case was added), so `9519ae0912c58dd7` is stale as an identity and MUST be re-run rather than re-cited. local duplicate preflight now requires ownership.
- retained live cards preserve authored placeholder nodes. the prepared source cursor is captured before live ui insertion; ui boundaries cannot become source selection offsets. added card nodes are reserved before construction; thumbnails receive no source until the existing visible artwork owner admits them. ordinary source/ui selection and dom-admission proof green `193453705ef84b55`; canonical-ui inclusion fault registered, sensitivity pending. artwork provider's two composed scenarios passed in `f1f4a9042f879800` (that run failed only the new embed fixture's missing required source declaration, then corrected).
- explicit prices: live cards sit beside authored content; pinned roots delay layer refresh until the interaction finishes and the reader retries. source remains available when a complete annotation/card layer cannot be admitted. these states do not qualify the experiment profile for maximum supported workloads.
- body now stages exact prepared-root ownership of live layer leases and visible artwork demand. legacy full evidence/map composition, figures/vector activation, and enclosing body proof remain incomplete. no whole-app build, final capacity, or release claim. unchanged transcript source/ui and image bypass is recorded in `transcript-embed-display-canonical-mismatch.md`.
- root checkpoint overlay source-range sensitivity passed `866449f1af90caa9` at `576e3baa61`; contents DOM sensitivity passed `ded70eded3573206` at `abf018a091`. the later embed child-id binding is a separate stricter field check, not covered by that paint fault.
- observer lifetime and two-inline-card ordering/provenance ordinary checks passed `ea1e6ac976d12103`. queued observer callbacks cannot reacquire after owner retirement; the final entry in a visibility batch controls demand. cleanup removes src and busy state before releasing the artwork lease. runtime independent review passed; shared artwork core/provider ordinary checks passed `742c0825a92dbd2c` after exact fixture-file access cleanup.
- two inline cards sharing one paragraph insert in source order. the fixture's materialized/live child identity was subsequently aligned to the same canonical uuid without changing text, order or DOM oracles; root's next exact snapshot will include this correction. a controlled forward-insertion fault still needs an observed red/green.
- per-unit completion now carries only exact lease identity, request token and projected read promise across awaits. item/view lookup is synchronous between reads; a retired unit cannot be retained by that pending continuation. failed decoration reconstructs the known undecorated source before publishing its strict defect. enclosing held-response retirement proof remains required.

2026-09-13 source-note read ownership (body cut incomplete):

- selected highlight detail containment ordinary green `9852a89758bbbddd`; canonical duplicate recovery sensitivity `5c68a3bf3fdef12d` at `b66b68439d`. root's selected-detail sensitivity remains pending. initial header/path-policy failures ran no app behavior.
- canonical embed source/UI sensitivity `f753a6792fbc370d`; retired artwork observer sensitivity `acde25fbd39114d5`, both at `36d3f6341d`. independent forward-card ordering sensitivity `e67c91cbb8d935ed` at `41e861467c` uses the same source/cursor/order proof; its temporary fault was restored.
- source-note summaries/targets/text/location now share the closed overlay capability and exact session read/result leases. previews hold one excerpt and retire DOM before payload. superseded physical reads remain charged until settlement; their late failures cannot clear a new target. ordinary `6497e78a7405a149`, canonical sensitivity `2cee24c770655b1e` at `133f4334e7`.
- final source-note detail reads one page at a time. full text reads use the attested label/body source id, not the containing reference id; Unicode continuation never concatenates pages. ordinary `e3bb9f269d98913c` with one available view lease. body-source-substitution sensitivity is registered and pending.
- tooltip stays text-only; strict read defects publish to the retained reader notice. retry cannot resurrect a retired hover target. full text and target paging add explicit navigation steps. precise Locate holds its source result through prepared-window/PDF geometry completion.
- body still uses the old full evidence/map pending the graph owner's compact fact/association projection. obsolete full navigation references, exact local Locate integration, figures/vector activation, mixed layer capacity qualification and enclosing body proof remain incomplete. source-only receipts do not qualify these boundaries.

- completed window navigation now exposes an exact current-command predicate, invalidated synchronously by newer explicit navigation/retry and session closure. automatic neighbors preserve it. find held-root supersession is ordinary green `cc73714135141f0a`; the real source-note operation plus indexeddb movement is green `aa51954f10408ab2`. final detail automatic-location composition is green `83f6524e1552f407`; canonical sensitivity refresh is pending on those final component bytes.
- source-note links keep automatic positioning through selected-g lookup/location; full text remains explicit one-page reads. the shared operation retains only its exact lease identity across scroll completion, re-observes the prepared unit, and saves its original source position only while current. hosted pdf component identity now includes account/media/g/document-member/reset; runtime owns its local completion proof.
- source-note pulse now follows its node's css animation without a global timer retaining detached source dom. actual restart/finish/detach/zero-duration proof is ordinary green `d77c7ae198d0865b`; registered animation-completion sensitivity is pending. no whole-body or mixed-capacity acceptance is implied.

2026-09-14 compact evidence and visible margin integration (qualification pending):

- publication evidence, overview, source-note detail and margin now use selected-generation bounded pages in the actual body; transcript keeps its existing timeline/evidence owner. ordinary gutter geometry, held-response retirement and overview checks passed `605f7a874df7e54f`. margin retirement exercises actual browser collection while the old HTTP response remains held, then requires exact occupancy conservation after physical settlement.
- text margin requests preserve the union of visible canonical intervals; PDF requests invert the displayed page rotation into original source rectangles. request construction reserves the existing query-byte bound before measuring source DOM. results attest against that frozen window, including cross-unit source ranges and PDF digest/quad intersection. payload and physical scratch remain owned through cancellation settlement.
- explicit prices: margin pages expose First/Next, overview buckets disclose bounded members before focused preview, and complete counts remain separate from the visible page. source-note and highlight authored details remain separately addressed. the decorative empty-margin inscription uses known positioned fact counts; unknown stance-only presence does not pretend the document is empty.
- canonical margin/source geometry faults are registered for independent replay. full web validation passed CSS marker ownership after restoring actual glyphs; then exposed missing artwork runtime-token registration and stale body/native lint findings, corrected before the next full run. focused browser green is not full typecheck or enclosing body navigation proof.
- remaining acceptance includes actual body position-before-persistence/source replacement, pane-addressed source-attested citation activation, sparse table/header context, original figures/vector activation, and measured mixed-reader capacity. capacity refusal is not successful support for an ordinary supported workload.

2026-09-14 source activation cut (staged, integration proof pending): media
citations now deliver to the pane returned by workspace activation. text targets
use the selected-generation source-range query, which requires the full existing
quote selector; a reader-selection snapshot supplies its independently complete
exact text and affixes. returned epub locator identity is preserved. missing or
ambiguous verification remains unavailable rather than using plausible offsets.

an admitted cited range owns its exact visible rectangle cue through animation
retirement. ranges spanning nonresident units position their selected start and
pulse only the visible selected text. full source provenance remains in the
charged location lease. capacity/error retains the original pending target and
its admitted lease for explicit retry; workspace navigation/close/supersession
retires the same delivery. the note pulse branch remains a separate recorded
pane-scope gap. these changes are not yet whole-body or mixed-capacity acceptance.

whole-web check `a5a8aff55e7c9e72` passed full lint and reduced type failures to
five fixture/external-trace issues; those are now corrected in source. queued
follow-up `e2d7393760e94077` was explicitly interrupted before a new claim.

- 2026-09-14: whole static `ad8cabea57943701` was interrupted while queued before
  any child ran. no static pass is claimed. a separate client proof checkout now
  freezes queued browser/static inputs while main body work continues.
- the media-only pdf pulse listener was removed after parent released the
  qualified loading/worker owner. source pulses now enter the accepted pane's
  selected publication and use its charged local location command.

2026-09-14 pending source input admission (staged; sensitivity pending):

- the existing account payload cache now admits a publication citation before
  workspace activation can retire its original message. one pending pane/media
  delivery keeps that reservation until its actual consumer settles. retry waits
  for the prior command and reuses the same input. session admission also counts
  the input against its view budget; there is no ownership transfer or second
  payload pool.
- all four citation callers use the same account/feedback hook. capacity is a
  handled link event, so it cannot fall through to raw navigation. input beyond
  the existing source request bound produces explicit feedback and retains no
  new quote or retry closure. the original citation remains the retry action.
  mounted transcript pulses keep their existing immediate event path.
- the exact visible text cue keeps one CSS animation lifetime. reduced-motion
  presentation holds a steady visible cue until that lifetime ends. cancellation
  removes actual rectangle DOM before either view or account charge retires.
- client snapshot `22d1630ff4f79bef` passed whole-web lint; typecheck stopped at
  two calls through a stale test-only held-response map annotation. that map now
  describes its actual zero-argument closures; the source and behavioral oracles
  are unchanged. no browser green or full typecheck is claimed from that run.
- actual source table members are retained unchanged from the publisher artifact
  `4af6dce5cd5b557b5f53bf5a2708ed6b9b4f8e3b97a09c1169e9257cb821abea`.
  its member graph passed while separate ZIP byte equivalence failed. the web
  sanitizer's missing caption identity is recorded separately; the reader does
  not infer missing caption context from the surviving words.


2026-09-14: client snapshot `8253d078e933c1cc` passed all three whole-web static commands. the subsequent release kernel failed in the existing external parser-temp permission fixture; recorded separately. focused `b499e8aee2511c25` passes document-session restore/moved-locator save (13 cases), exact source-pulse geometry/reduced motion (2), account input admission (3), and pane delivery (2). the document-session fixture now keeps get revisions stable, submits distinct movement, and isolates accounts. actual table chromium roles pass; its first query wrongly searched only role `cell` for authored column headers. corrected the proof to recognize existing header roles. no role rewrite is justified. body was not run because that table error stopped the batch.

2026-09-14 actual strict-root and table composition follow-up:

- `a9dd0b852ec834f4` passes both account replacement/retirement cases with the
  public `reactStrictMode:true` render option. a nested JSX strict boundary had
  not replayed mount effects because the test environment wrapped it. account
  replacement keeps same-key source seeds isolated; replay may re-fetch an
  unclaimed seed. canonical fault replay remains pending.
- later source excerpts expose a real Chromium classification loss when the
  original column header is outside that excerpt: red `e0c4fa8596333538` loses
  the accessible table role. adding only missing `role=table` to marked excerpt
  tables makes every emitted excerpt pass in `a9dd0b852ec834f4`. authored roles
  and unmarked ordinary tables remain exact. this corrects the earlier note
  that no role rewrite was needed, which covered only the first excerpt.
- main now carries unchanged complete producer artifact `cad7bb4a12fc7ce918c3ee3589fb80e61eed8ec1c2c9649740f45303fff669ca`
  from fully green archive/service `78c3004b3b782f1a`. its canonical text and
  unit structures equal the earlier artifact apart from fresh source UUIDs.
  final browser replay of these exact new identities remains pending.
- composed body run `e666c5836dde1335` reaches section navigation but does not
  save the chosen locator after held source delivery. the failure is under
  investigation; no body navigation acceptance is claimed.

2026-09-14 pending-write source retirement (client proof checkout; integration pending):

- body collection red `811ac360c67ebd4c` shows a held highlight Ask keeps retired
  source DOM alive. selection identity/ref cleanup preserves ordinary behavior
  but does not suffice (`dfff5f998d83af76`). transient diagnostics `06fe0f6610573cd0`
  and `9ed91990378d347b` identify two concrete owners: the released prepared
  projection and a viewport callback capturing a prepared-root content-state
  object when it needs only readiness. no heap snapshot or diagnostic parser
  remains in the repository or task artifacts.
- `37d5484723bad8d2` passes actual DOM collection plus the exact acknowledged Ask
  destination after reader close. it also passes all selected highlight outcome,
  ordinary selection, actual body navigation, retained-selection, and native
  shelf cases. the whole command fails later at the shared Find fixture's stale
  prepared-root publication; its retire callback now publishes the remaining
  owned entries, preserving the existing supersession assertions.
- those passing DOM bytes are bound to body `3744262cd3312a876a0e72fd47916328aab364406231229b51b66fdd4d01963f`,
  prepared owner `24093cc37ee56597cb87613b6f0868718d0393bc49ed86a5916856c9e836b826`,
  and proof `9c791cb20e35c2a5c3a768eb9cfcdaf5cb0f6300141776e591715cf1a99aef03`.
  additional reviewed current-map borrows and the fixture correction await the
  next coupled result. no canonical sensitivity or decoded-payload retirement
  is claimed from the DOM result.
- decoded payload has a separate retained path through settled cache/session
  unit promises and active content's stored slice. the reviewed candidate clears
  existing handles, preserves the clearing getter through the window, and borrows
  text using precomputed UTF-16 cuts. repeated substring cost still needs browser
  qualification. Share trigger and PDF Range retirement have separate real
  boundary proof drafts; their product fixes await pre-fix execution.
- workspace `e278312ae9e186d3` passes focus/blur/return interactions but fails
  before the drag: the fixture targeted the pane's resize separator. the next
  attempt uses the separator's measured rectangle to reach actual blank chrome.
  drag and local-storage-failure retention remain unqualified.


2026-09-14 consolidated preparation failure ownership (applied; validation pending):

- the preparation effect could retry a failed source when the unit window changed,
  despite an error belonging to the same session, render attempt and navigation
  id. pending settlement also preferred a connected root over that exact error.
  both are confirmed in source; the reviewed correction stops that attempt and
  settles its failure first. explicit retry and new navigation keep their existing
  identities. no counter, ref or retry owner was added.
- prior receipt `29368beb978cb403` observed the retry button disappear after the
  external DOM refusal was lifted. its trigger remains unobserved: neighbor-window
  churn is a possible path, while normal viewport maintenance is suppressed during
  Find preview. source inspection alone does not establish that causal chain.
- patch `aff342b327c35c23e558b0b0d0886b6fc9038a8f291a2523d95650692a5bce3e`
  changes only the existing body owner, from `518ad1b9b5218dc92a5a0bc4d8ac9b59eafc246b33f82022dfd673830b5734ab`
  to `e852ee697956a6af4f2f4a0ddacaf87460830f7b58d4f0f66b486409951d3d3d`. the already-connected-unit fast path and proof assertions are unchanged.
- acceptance still requires the exact old-source red and current-source green
  for section preparation, Find preview and return, durable origin and geometry,
  with trusted-input supersession preserved. no test ran during this batch and
  no resolved status is claimed. if necessary, the reviewed public protocol/DOM
  trace must establish the trigger during the next controller-owned run.

## 2026-09-14 preview ingest-route module failure

- actual Vercel deployment `dpl_GpwKP6JAuJ3Fb9d64nbcXp1cJww5`, from
  `5d687cdc8a9e1a9b2a0106d0e136df4537c281d7`, compiled and then failed type
  validation: `src/app/api/media/[id]/ingest/route.ts is not a module`.
- the retained route was zero bytes
  (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
  removed that dead module. no placeholder export or replacement endpoint was
  added. the route was already deleted by the document-import hard cut
  `b379a0cfa18a6b518a0cfec53f3ebf1702ab6268`; consolidation had retained an empty
  path instead of its deletion.
- no product caller targets media-scoped `/ingest`. current imports use
  `/api/media/uploads/:session/confirm`, `/api/media/from-url`, and explicit
  source retry/refresh; the backend owns those contracts and has no media-scoped
  ingest endpoint. the sole direct web reference is the existing negative
  journey assertion at `durable-ingest-reader-open.journey.spec.ts:216`, which
  requires the retired route to return 404. it is unchanged.
- an app-route scan found no other empty or comment-only route module and no
  `export {}` route tombstone. no test or build ran during the merge batch. the
  next actual preview must pass type validation; preview success is not claimed.


## 2026-09-14 preview selection narrowing failure

- actual Vercel deployment `dpl_8KNUUCCDvdrtTv7LvNs6QsCzbM1F`, from
  `dd21213bfaca8650e60049d939c7b2195240820e`, failed type validation at
  21:08:38 UTC: `MediaPaneBody.tsx:3513:47`, `activeSelection` is possibly null.
  the duplicate-highlight lookup captured the mutable selection borrow, which
  is deliberately cleared before awaiting the write.
- move the existing identity/fragment/offset scalar destructuring before that
  lookup and compare its scalar offsets. retain `activeSelection = null` before
  the write, exact identity retirement, and the duplicate-row acknowledgment.
  no selection object is newly captured across the await. adjacent note/link
  callbacks use synchronous const borrows; they do not share this narrowing flaw.
- this is a source correction for the actual build failure. no test or build ran
  during the frozen batch; the next paved type/build check and pending-selection
  behavior proofs remain required. preview success is not claimed.
