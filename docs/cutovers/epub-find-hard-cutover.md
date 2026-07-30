# EPUB Find Hard Cutover

Status: IMPLEMENTED AND VERIFIED
Type: hard cutover
Date: 2026-07-29

Open questions: none. Approved defaults are `Cmd/Ctrl+F`, **Entire book**,
exact **This section** when available, literal occurrences, Match case, Whole
word, Previous/Next, Companion results, search-neutral reading progress, and
only **Go back to reading position**.

Governing contracts:

- [`docs/rules/README.md`](../rules/README.md) and every rule it indexes;
- [`pane-search-foundation-hard-cutover.md`](pane-search-foundation-hard-cutover.md);
- [`canonical-text-surfaces-find-hard-cutover.md`](canonical-text-surfaces-find-hard-cutover.md);
- [`docs/modules/epub.md`](../modules/epub.md);
- [`docs/modules/reader-implementation.md`](../modules/reader-implementation.md).

## Decision

Add complete pane-local Find to readable EPUBs through the implemented
`FindOccurrences` capability.

- The backend scans current `fragments.canonical_text` in EPUB spine order and
  returns exact occurrences. It never returns all chapter HTML or all book text.
- The frontend uses the shared pane-find controller, Companion results,
  canonical DOM cursor, text-anchor scrolling, CSS Custom Highlights, and media
  preview lease.
- Cross-section activation uses a new preview-only section path. It never calls
  EPUB navigation, restore-session, URL, target, or progress commands.
- A bounded foundation amendment lets each adapter nominate the initial Ready
  result without reordering rows. EPUB chooses the nearest forward occurrence
  from the frozen reading anchor, wrapping once; it never yanks a mid-book
  reader to the book's first match merely because a query settled.
- **This section** is offered only when exactly one navigation section owns the
  current rendered EPUB spine item. A TOC may expose several anchors inside one
  spine item; those ambiguous items get **Entire book** only. Exact
  TOC-subsection bounds require an ingest-time anchor-offset model and are out
  of scope.

This is the 80/20 cut: complete whole-book results, exact activation, and safe
Return without a search index, worker, migration, client-side book download, or
EPUB CFI engine.

## Goals

- Find exact literal occurrences across an entire EPUB or its current section.
- Preserve one immutable reading origin while results are previewed.
- Keep preview movement out of progress, engagement, completion, URL, and pane
  history.
- Keep matching memory bounded to one canonical fragment and stop at occurrence
  2,001.
- Reuse existing pane, reader, and canonical-text primitives. Outside
  EPUB-owned source/query/preview code, permit only the bounded foundation
  amendments, mechanical adapter migrations, and shared-owner extractions
  named here.

## Scope

In: readable EPUB panes, a bounded server-side literal scan, exact result
locators/snippets, an EPUB pane-find adapter, preview-only section rendering,
Companion results, progress isolation, Return, the bounded foundation migration,
and only the shared-owner renames/extractions required to reuse current
primitives.

## Non-goals

- Fuzzy, semantic, stemmed, regex, accent-folded, AI, global, or saved search.
- Searching metadata, annotations, notes, apparatus, images, alt text, or
  package resources not materialized as current readable fragments.
- Exact nested TOC-subsection scope, EPUB CFI, pagination, ranking, or snippets
  spanning fragments.
- A database index, persisted search state, cache table, worker, migration, or
  analytics.
- Native browser Find fallback, **Continue from here**, multiple origins, or a
  Find-owned navigation stack.
- EPUB ingestion, navigation, resume, highlighting, or progress redesign.

## Hard-cut Rules

- EPUB publishes only `FindOccurrences`; no native Find, `window.find`,
  compatibility adapter, legacy search, or fallback remains.
- Find never calls ordinary EPUB navigation/restore paths.
- Do not fetch `/fragments` or transfer whole-book text/HTML to the client.
- Hard-rename shared owners and delete superseded files/exports in the same cut.
- No dual source identity, query path, or result representation.

## Target Behavior

| Event | Required result |
| --- | --- |
| `Cmd/Ctrl+F` in a readable EPUB | Open/focus **Find in book** in that active pane |
| Open Find with no Return origin | Freeze current source, reading anchor, and exact current-section scope |
| Reopen Find while Return exists | Retain the prepared session/origin; do not re-freeze |
| Query/options change | Debounced complete search; no reader movement on empty, failed, or zero results |
| First Ready result | Select/preview the nearest forward occurrence from the frozen anchor, wrapping once |
| Previous/Next or Companion row | Activate exact occurrence, wrap through document order |
| Activate within the rendered section | Verify/re-mark/scroll locally; do not refetch or rerender the section |
| Show results | Existing transient `resource-search` Companion with section label and emphasized context |
| Close/Escape | Clear marks/query and close results; leave revealed location and Return available |
| Go back | Restore exact section, canonical anchor, viewport delta, and horizontal scroll; retire origin |
| First genuine input after any preview/Return move | Adopt the rendered section through ordinary state, release the fence, retain Return, and suppress progress/completion for that triggering input |
| Route/source replacement | Abort query/preview, clear results/marks/origin, reload source identity |
| Match 2,001 | `TooManyMatches(2000)` and “More than 2,000 matches. Refine your search.” |

The selector defaults to **Entire book**. Publish **This section** only when
the active rendered fragment has exactly one current navigation location
during `prepare`; otherwise publish no scope selector.

Ready rows always remain in document order. Given a prepared
`{ fragmentIdx, anchorCp }`, EPUB selects the first occurrence at or after that
position, then wraps to the first row. With no exact rendered anchor it selects
the first row. Previous/Next wrap from that nominated row.

## Final Architecture And Ownership

```text
PaneShell / Cmd-F
  -> usePaneFind (session, debounce, stepping, Return)
    -> EPUB adapter
      -> POST /media/{media_id}/epub-find
         -> epub_find service -> current canonical fragments
      -> preview-only section loader -> existing section read API
      -> canonical cursor + paneTextAnchor + shared highlight registry
      -> media preview lease -> progress/activity fences
    -> existing resource-search Companion
```

- `usePaneFind` remains the only session/query/preview generation owner and
  gains only the bounded initial-key/unavailable-capability amendments below.
- `epub_find.py` owns source-witness validation, matching, snippets, ordering,
  cap, and query result DTO construction.
- `epub_read.py` remains the authorization/readiness and section-content owner.
- `useEpubPaneFind.ts` owns the EPUB adapter, result locator map, immutable
  origin, override transitions, source-change cancellation, and Return
  semantics.
- `MediaPaneBody` owns the route-local `epubSourceGeneration` and
  `EpubRenderedSectionOverride` React state because its navigation, section
  resources, rendered-content derivations, and genuine-input seam consume them.
  It passes typed state/setters/commands to the EPUB hook.
- Existing reader progress/activity services remain lease-driven. The
  route-local genuine-input seam owns adoption and one-input
  progress/completion suppression; no backend progress contract changes.

`MediaPaneBody` selects one explicit capability:

```ts
type MediaPaneFindSelection =
  | { readonly kind: "Available"; readonly format: "Web" | "Transcript" | "Epub" }
  | { readonly kind: "Unavailable" }; // PDF until the PDF Find cutover
```

Selection is exhaustive on media kind. It maps to a generic foundation
capability:

```ts
type PaneFindCapability<TError> =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Available";
      readonly adapter: PaneFindAdapter<TError>;
    };
```

`Unavailable` runs no preparation and returns no publication. Delete the
empty-Web adapter instantiated for non-Web media; no dummy adapter, nullable
ambiguity, or precedence chain survives.

Widen the route-local `MediaPaneFindError` exhaustively to
`OriginUnavailable | RequestUnavailable`. Existing Web and Transcript adapters
continue to emit only `OriginUnavailable`; EPUB is the first producer of
`RequestUnavailable`. `mediaFindInputLabel` gets an exhaustive EPUB branch that
returns **Find in book**.

Do not put EPUB logic in the shell, Companion, `usePaneFind`,
`navigateToSection`, `epubRestore.ts`, or global Search.

## Required Bounded Foundation Amendment

Add one field to the `Ready` adapter response:

```ts
{
  readonly kind: "Ready";
  readonly rows: readonly PaneFindResultRow[];
  readonly initialActiveKey: PaneFindResultKey;
  // existing request/source/completeness fields unchanged
}
```

`usePaneFind` requires `initialActiveKey` to occur exactly once and defects
otherwise. It preserves row order, makes that key active, and auto-previews it.
Existing Web, Transcript, Chat, and Artifact adapters return `rows[0].key`;
EPUB applies the nearest-forward rule above. Add no sorting callback or reader
knowledge to the foundation.

The same amendment makes `usePaneFind` accept the generic capability union
above and return a tagged result:

```ts
type PaneFindUseResult =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Available";
      readonly controller: PaneFindController;
    };
```

Its `Unavailable` branch performs no preparation/query/preview work and
publishes no controller. All existing capable panes pass `Available` and unwrap
the controller through the tagged branch; no nullable controller or dummy
adapter survives.

Update the implemented foundation spec with this successor amendment when code
lands. This child does not silently fork the foundation contract.

## Capability Contract

After the bounded amendment above, compose the implemented
`PaneFindAdapter<EpubFindError>`:

```ts
type EpubFindError =
  | { readonly kind: "OriginUnavailable" }
  | { readonly kind: "RequestUnavailable" };

interface EpubFindSnapshot {
  readonly mediaId: string;
  readonly sourceKey: PaneFindSourceKey;
  readonly sourceWitnessFragmentId: string;
  readonly fragments: readonly {
    readonly fragmentId: string;
    readonly fragmentIdx: number;
    readonly activationSectionId: string;
    readonly label: string;
    readonly charCount: number; // Unicode codepoints, never JS UTF-16 length
    readonly navigationLocationCount: number;
  }[];
}

interface EpubFindPreparedAnchor {
  readonly fragmentIdx: number;
  readonly anchorCp: number;
}

interface EpubFindOccurrence {
  readonly key: PaneFindResultKey;
  readonly sectionId: string;
  readonly fragmentId: string;
  readonly fragmentIdx: number;
  readonly startCp: number;
  readonly endCp: number;
}

interface EpubFindOrigin {
  readonly sectionId: string;
  readonly fragmentId: string;
  readonly anchorCp: number;
  readonly viewportTopDeltaPx: number;
  readonly scrollLeft: number;
}
```

- Preserve `scrollLeft` for parity with the shared exact-viewport restore
  helper even though the current EPUB reader is vertical-only.
- Source key: `{ kind: "Epub", mediaId, fragments }`, where the exact identity
  subset is ordered
  `{ fragmentId, fragmentIdx, activationSectionId, charCount,
  navigationLocationCount }`. Display `label`, witness, and prepared reading
  anchor are excluded.
- Result key source:
  `{ kind: "EpubFragment", mediaId, fragmentId }`.
- Result key locator:
  `{ kind: "FragmentRange", fragmentId, startCp, endCp }`.
- Build `fragments` once from exact-decoded navigation: unique
  `fragment_id/fragment_idx`, first navigation ordinal as activation section,
  that row's canonical codepoint `char_count`, and navigation-location count.
  Compare client text lengths only with `canonicalCpLength`; missing or
  contradictory facts defect.
- Set the source witness deterministically to the snapshot's first fragment id,
  not the currently rendered fragment. An empty readable EPUB defects. An
  active rendered section, when present, must belong to the snapshot; otherwise
  increment the source generation before constructing the adapter.
- Freeze `EpubFindPreparedAnchor` during `prepare` only when the rendered
  section/cursor is exact. Its absence permits Entire-book Find but selects the
  first result and offers no current-section scope.
- Keys and locator maps are transient and never parsed, persisted, or placed in
  URLs.
- `preview` may reject either `OriginUnavailable` or `RequestUnavailable`.
  Query may fail only with `RequestUnavailable`. Both map exhaustively through
  `epubFindErrorMessage`; preview Retry re-attempts the same key, while
  auto-preview Retry reruns the exact query and nominated initial key.
- `epubFindErrorMessage` maps `OriginUnavailable` to **Reading position is
  unavailable** and `RequestUnavailable` to **Find request unavailable.
  Retry.**
- This is the first network-backed preview and the first shipped adapter to
  exercise foundation `Failed`; focused browser tests are mandatory.
- Known source replacement cancels instead of publishing `Failed`; malformed
  responses and impossible source/DOM states defect.

## HTTP API

Use one EPUB-specific, read-only structured request. It authorizes visibility,
requires EPUB kind/readiness, and runs in one repeatable-read transaction.

```text
POST /media/{media_id}/epub-find
```

The Next route proxies the POST unchanged and owns no validation or matching.

```ts
type EpubFindScopeIn =
  | { readonly kind: "EntireResource" }
  | { readonly kind: "Section"; readonly section_id: string };

interface EpubFindRequest {
  readonly source_witness_fragment_id: string; // deterministic first snapshot fragment UUID
  readonly query: string;        // 1..256 codepoints, no CR/LF; server NFC-normalizes
  readonly match_case: boolean;
  readonly whole_word: boolean;
  readonly scope: EpubFindScopeIn;
}

interface EpubFindOccurrenceOut {
  readonly section_id: string;   // canonical preview target for the fragment
  readonly section_label: string;
  readonly fragment_id: string;
  readonly fragment_idx: number;
  readonly start_offset: number; // right-open Unicode-codepoint offsets
  readonly end_offset: number;
  readonly snippet: readonly {
    readonly text: string;
    readonly emphasized: boolean;
  }[];
}

type EpubFindResultOut =
  | {
      readonly kind: "Ready";
      readonly source_witness_fragment_id: string;
      readonly occurrences: readonly EpubFindOccurrenceOut[];
    }
  | {
      readonly kind: "NoMatches";
      readonly source_witness_fragment_id: string;
    }
  | {
      readonly kind: "TooManyMatches";
      readonly source_witness_fragment_id: string;
      readonly threshold: 2000;
    };
```

The method returns this DTO inside the standard exact `{ data }` envelope.
Request and response models are strict, extra-forbidden tagged unions. Add
`E_EPUB_FIND_SOURCE_CHANGED` (409). A witness absent from the current media
source returns it before scanning. The client clears preview, increments one
`MediaPaneBody`-owned `epubSourceGeneration` that keys navigation and
committed-section resources, and aborts the pane-find session. Existing
navigation reconciliation renders the replacement source and constructs a new
adapter. The hook requests this transition through one callback; it does not
own or mirror the generation. The generation is not domain state, persistence,
a user-visible zero, or a generic failure.

The response must echo the request witness. The exact decoder also checks every
occurrence against the snapshot's fragment id, index, activation section, and
`charCount`.

The service order is visibility -> EPUB kind -> ready -> witness -> scope.
Unknown scope, or narrow scope for a fragment with other navigation locations,
is `E_INVALID_REQUEST`. It scans each unique current fragment once, in
`fragments.idx` order. Each result targets the first navigation location for
that fragment; narrow scope retains its sole requested section as
target/context. Missing navigation for a current fragment is a defect.

Whole-book result labels are intentionally spine-item granular: a match below
a later TOC anchor in the same XHTML item uses that fragment's first navigation
label. This cosmetic limitation is the accepted cost of not persisting
anchor-to-canonical-offset ranges.

The witness is sufficient because EPUB publication atomically deletes and
recreates every fragment and navigation row, and no in-place source mutator
exists. A future mutator must replace this contract, not weaken it.

## Matching Contract

Match the shipped canonical-text product semantics over their verified common
domain:

1. NFC literal query; case-insensitive by default with non-expanding Unicode
   folding. Never `lower()`, `casefold()`, accent fold, or locale-expand.
2. Whole word requires the owning runtime's Unicode word boundaries at both
   match edges.
3. Non-overlapping, left-to-right matches; after a rejected boundary candidate,
   advance one codepoint so a later valid overlap is discoverable.
4. Never match across fragments. Offsets and 64-codepoint snippet context are
   Unicode-codepoint based and right-open.
5. Stop immediately after occurrence 2,001 and return
   `TooManyMatches(2000)`.
6. Results are always complete; there is no partial EPUB source.

The EPUB backend pins the existing Python dependency to
`regex.V0 | regex.IGNORECASE | regex.WORD`, with escaped literals and a
hand-rolled scan loop implementing rejected-boundary advancement and the cap.
Never use V1: it force-enables expanding `FULLCASE`. Match-case omits
`IGNORECASE`; Whole word alone controls the two explicit `\b` checks.

`testdata/pane-find/canonical-text.json` is authoritative only for the verified
TypeScript/Python agreement subset: NFC, escaped literals, ordinary case,
Latin-like boundaries, astral codepoints, combining marks, punctuation,
non-overlap, snippets, ordering, and cap. Both runtimes consume it.

Two known platform differences are explicit and tested outside that fixture:

- TypeScript retains ECMAScript `/iu`; Python retains `regex.V0` folding.
  SCF-excluded codepoints such as `İ` are platform-local.
- TypeScript retains ICU `Intl.Segmenter` dictionary boundaries; Python retains
  `regex.WORD` UAX #29 boundaries. Dictionary-segmented CJK Whole word is
  platform-local.

Do not claim byte-identical cross-runtime parity. Exact parity would require a
shared matcher runtime or ICU plus an ECMAScript-compatible folding table and
is outside this cut. The standalone Dossier frame retains its existing
sandbox-local conformance corpus; this fixture does not replace it.

The scan uses a per-fragment keyset loop inside the same repeatable-read
transaction:

```text
SELECT current fragment WHERE media_id = ? AND idx > :after_idx
ORDER BY idx ASC LIMIT 1
```

Advance `after_idx` only after scanning that row. This deliberately trades
round trips for the stated one-fragment memory bound. Do not call `.fetchall()`
for canonical text, materialize the whole book, join through duplicate
navigation rows, use a server-side cursor without an explicit lifecycle, use
global `/search`, or add an index for v1.

## Preview And Reading Safety

`MediaPaneBody` owns an ephemeral `EpubRenderedSectionOverride`, separate from
committed `activeSectionId`, `activeEpubSection`, and `epubRestoreRequest`:

```ts
type EpubRenderedSectionOverride =
  | { readonly kind: "FindPreview"; readonly section: EpubSectionContent }
  | { readonly kind: "ReturnedOrigin"; readonly section: EpubSectionContent };
```

The immutable Find origin is orthogonal to this override and survives ordinary
navigation until Return, route/source replacement, or adapter disposal.

### Preview

1. Before the first move, capture section/fragment, first visible canonical
   codepoint, viewport-top delta, and horizontal scroll.
2. Acquire the existing media preview lease.
3. If the occurrence belongs to the rendered fragment, validate cursor/range,
   re-mark, and scroll locally. Do not fetch, replace content, or reset the
   reader.
4. Otherwise fetch the target through the existing section endpoint with the
   preview `AbortSignal`; validate section id, fragment id, snapshot membership,
   canonical cursor, and right-open range.
5. Before publishing a different rendered section, run the rendered-section
   auxiliary reset below. Publish `FindPreview` without changing committed
   section/navigation state, router params, targets, or restore phase.
6. Publish every occurrence range in that rendered fragment, mark the active
   range, and use `scrollToExactCanonicalTextAnchor`. No section-top fallback.

If transport exhausts before the view changes, reject
`RequestUnavailable`. If it exhausts after any override/render change, restore
the exact origin first, then reject `RequestUnavailable`. Reject
`OriginUnavailable` only when the origin cannot be captured. Abort/stale/source
replacement follows cancellation rules and publishes neither rejection.

### Return, adoption, and ordinary navigation

Return uses the same local/loader fast path and
`restoreCanonicalTextAnchorViewportPosition`, retags the loaded origin as
`ReturnedOrigin`, clears marks/origin, keeps the preview lease fenced until
the first genuine-input adoption, and focuses the reader viewport. It never
writes URL, history, progress, engagement, or completion.

The route owns these transitions:

```text
Committed -> FindPreview       cross-section result preview
FindPreview -> Committed       first genuine input or ordinary navigation
FindPreview -> ReturnedOrigin  Return
Committed with Return origin -> ReturnedOrigin  Return after adopted/navigation state
ReturnedOrigin -> Committed    first genuine input or ordinary navigation
Any -> Committed               route/source replacement, with Find state retired
```

- A layout effect keyed by committed `activeSectionId` clears any override only
  after ordinary navigation commits its target. This is the owner seam;
  `navigateToSection` gains no Find branch. Clearing an override never replaces
  the immutable origin.
- First genuine reader input while any override is rendered adopts that exact
  loaded section into ordinary `activeSectionId`/`activeEpubSection` and
  `replaceReaderLocation` state, clears the override, releases the lease, and
  retains Return. This user-driven adoption is the first point at which the URL
  may change.
- The adoption-triggering input emits no locator/progress/completion capture,
  resets the progress generation, and disarms natural completion; ordinary
  reader activity may resume. The next genuine input uses ordinary locator
  capture; only a subsequent trusted forward input may finish the book.
- First genuine input after a same-section preview also releases the lease and
  is completion-suppressed for that input, even though no override exists.

Search-driven fetch/render/scroll/Return never calls
`reportReaderMovement`, `replaceReaderLocation`, `setTarget`,
`beginRestoreSession`, or `navigateToSection`. Only the genuine-input adoption
command may reuse `replaceReaderLocation`.

### Rendered-section consumers

Define once:

```ts
const renderedEpubSection =
  epubRenderedSectionOverride?.section ?? activeEpubSection;
```

| Consumer | Required state |
| --- | --- |
| HTML/canonical content, cursor, source/anchor, selection, Highlights, apparatus | `renderedEpubSection` |
| `activeTextStartOffset`, locator geometry, `documentSpan`, overview rail, endcap, mobile chrome baseline | rendered section; progress/completion fences still apply |
| Contents current indicator, EPUB section selector/count, Previous/Next basis | rendered section; invoking a control is ordinary navigation |
| Progress/activity locator | rendered section only after lease release/adoption; never on the adoption-triggering input |
| URL, restore request/phase, committed section resource key, pane history | committed state only |

Natural completion is unavailable while an override exists or for the
generation/input that releases a Find preview lease. Merely previewing the last
section and scrolling once cannot mark the book Finished.

### Auxiliary state lifecycle

Before rendered fragment identity changes:

- increment/cancel the Highlight request generation;
- clear current Highlights, retained selection, focused Highlight/action anchor,
  temporary evidence emphasis, and apparatus hover/focus presentation;
- render no old-fragment annotation against the new canonical cursor; and
- fetch Highlights only for the new rendered fragment, accepting the response
  only while both request generation and rendered fragment still match.

Apply the same reset on Return, ordinary navigation away, source replacement,
and override disposal. Add no preview retries to the existing Highlight loader.

Rename `webFindHighlights.ts` to `canonicalTextFindHighlights.ts` and migrate
Web + EPUB together. Rename every exported identifier to
`CanonicalTextFind*` / `CANONICAL_TEXT_FIND_*`; preserve only the existing
multi-pane registry behavior and `nexus-find-*` CSS highlight names.
Extract `createMediaFindPreviewLease` from `useMediaPaneFind.ts` into its own
route-local owner. Delete old exports/files; no compatibility re-exports.

## Concurrency And Failure Rules

- Every query/preview carries foundation session, query, source, and abort
  identities. Reject every stale settlement.
- Witness validation and the POST scan observe one repeatable-read snapshot.
- `AbortError`, stale session/query/preview settlement, route disposal, and
  known source-generation replacement are cancellation: publish no failure.
- `E_EPUB_FIND_SOURCE_CHANGED`, a stale section response, or a section/fragment
  mismatch increments the source generation, retires Find state/origin, and
  cancels. It is never Retry.
- Failure to capture the immutable origin rejects
  `{ kind: "OriginUnavailable" }`.
- A network failure with no well-formed same-system response, after the standard
  request retry policy is exhausted, rejects
  `{ kind: "RequestUnavailable" }`. The foundation renders retryable `Failed`;
  Retry preserves the exact query/options/key contract described above.
- `RequestUnavailable` is an intentional modeled outcome because a no-response
  transport failure leaves this ephemeral, read-only operation safely
  repeatable. Once the backend returns a contract-bearing response, that
  response—not its HTTP class—owns classification.
- A well-formed 5xx response from the Nexus backend, an undocumented status or
  error code, an invalid request emitted by this typed client, a malformed
  envelope, impossible DTO, canonical DOM disagreement, or restore failure is
  a defect. Never disguise a persistent same-system bug as
  `RequestUnavailable`.
- Authentication/authorization and media-not-ready errors retain their owning
  route boundaries; they do not become pane-Find Retry states.
- After any override/render change, restore the exact origin before publishing
  either permitted preview rejection. If restoration cannot complete, defect
  after retiring unsafe Find state; never leave a rejected preview rendered.
- Empty query is `Idle`; zero results is `NoMatches`;
  `TooManyMatches(2000)` has zero rows and asks the user to refine the query.
  Do not invent partial results, stepping, or a higher client cap.
- No query text, options, result, origin, or source identity enters persistence,
  history, analytics, progress payloads, or global Search.

## Files

Create:

- `python/nexus/schemas/epub_find.py`
- `python/nexus/services/epub_find.py`
- `python/tests/test_epub_find.py`
- `apps/web/src/app/api/media/[id]/epub-find/route.ts`
- `apps/web/src/lib/media/epubFind.ts`
- `apps/web/src/lib/media/epubFind.test.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useEpubPaneFind.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useEpubPaneFind.browser.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaFindPreviewLease.ts`
- focused lease tests beside `mediaFindPreviewLease.ts`
- `testdata/pane-find/canonical-text.json`

Modify:

- `apps/web/src/lib/panes/{usePaneFind.ts,usePaneFind.test.tsx}`: required
  initial-key and unavailable-capability amendments
- mechanically add `initialActiveKey` to the existing capable adapters and
  focused tests:
  - `apps/web/src/app/(authenticated)/media/[id]/{useMediaPaneFind.ts,useMediaPaneFind.browser.test.tsx}`
  - `apps/web/src/app/(authenticated)/media/[id]/{transcriptPaneFind.ts,transcriptPaneFind.test.ts,transcriptPaneFind.browser.test.tsx}`
  - `apps/web/src/app/(authenticated)/artifacts/[artifactRef]/{artifactPaneFind.ts,artifactPaneFind.test.ts}`
  - `apps/web/src/components/chat/{useConversationPaneFind.ts,useConversationPaneFind.test.tsx}`
- `python/nexus/api/routes/reader.py`
- `python/nexus/errors.py`
- `python/nexus/services/epub_read.py`: hard-rename its private guard to the
  public `require_readable_epub` and reuse it from read and Find
- `apps/web/src/app/(authenticated)/media/[id]/{MediaPaneBody.tsx,MediaPaneBody.test.tsx}`:
  own/compose source generation, rendered override, PDF-unavailable selection,
  rendered consumers, auxiliary reset, adoption, and completion fence
- `apps/web/src/lib/reader/canonicalTextFind.test.ts` for the shared fixture
- hard-rename
  `apps/web/src/lib/reader/webFindHighlights.{ts,test.tsx}` to
  `canonicalTextFindHighlights.{ts,test.tsx}`
- `e2e/tests/epub.spec.ts`
- `docs/cutovers/pane-search-foundation-hard-cutover.md` to record the implemented
  successor amendment
- `docs/modules/{epub,reader-implementation,reader-design-rationale}.md` when
  implementation lands

No model, migration, index, worker, shell, Companion, keybinding, global
Search, `paneTextAnchor.ts`, PDF implementation, or persistence file belongs in
this cut.

## Implementation Order

1. Red/green the bounded foundation amendment. Migrate every existing adapter
   mechanically and make PDF explicitly `Unavailable`.
2. Red/green the verified common matcher fixture, Python-local edge cases, and
   backend service: V0 scan loop, keyset transaction, witness, snippets, cap,
   strict API, and error classification.
3. Hard-rename the shared highlight registry and extract/test the preview lease.
4. Build the EPUB adapter and route-owned renderer state: nearest-forward
   initial key, same-section fast path, cross-section preview, auxiliary reset,
   Return, adoption, and source cancellation.
5. Prove foundation `Failed -> Retry`, 5xx defect, progress/URL/completion
   isolation, Companion, scope, stale source, Return, and mobile behavior in
   focused browser and real-stack EPUB E2E tests.
6. Delete superseded symbols/tests, update governing/module docs, and run
   residue gates.

## Acceptance Criteria

1. `Cmd/Ctrl+F` in a readable EPUB opens **Find in book**; `Cmd/Ctrl+K` remains
   global and native Find is prevented only while the capable pane consumes it.
   PDF publishes no Find capability.
2. Ready rows remain in document order, but initial activation is the nearest
   forward occurrence from the frozen reading anchor, wrapping once. Existing
   adapters retain first-row activation through explicit `initialActiveKey`.
3. Entire-book and current-section literal results are complete, correctly
   ordered, non-overlapping, and capped at 2,000; match 2,001 returns zero rows
   and the refine-query message.
4. The shared fixture passes in TypeScript and Python over the declared
   agreement subset. Dedicated tests preserve the documented ECMAScript/Python
   folding and ICU/UAX29 CJK boundary differences.
5. A fragment shared by multiple TOC locations is searched once and offers no
   **This section** scope; a singly owned fragment offers the exact narrow
   scope.
6. Previous, Next, Enter, Shift+Enter, and Companion rows activate the exact
   canonical range across sections and wrap correctly.
   Same-section activation performs no section request or content rerender.
7. Companion rows show the canonical section label plus safe emphasized text;
   no HTML enters the snippet.
8. First activation captures exactly one origin; later activations do not
   replace or stack it.
9. Close clears marks/results without returning; **Go back to reading
   position** restores once, including after intervening ordinary section
   navigation, and then disappears. No Continue control exists.
10. Querying, cross-section preview, and Return do not change reader-state API
    payloads, engagement, completion, URL/query/hash, pane history, or ordinary
    EPUB navigation state.
11. The first genuine input adopts any rendered override, may then update the
    URL through ordinary machinery, retains Return, and emits no
    locator/progress/completion for that input. A previewed final section cannot
    finish the book; only a later trusted forward input can.
12. Content, cursor, geometry, overview, Contents state, section controls,
    endcap, and mobile chrome use the rendered section, while URL/restore/history
    remain committed. No surface shows mixed-section state.
13. Cross-fragment preview/Return/navigation cancels old Highlight loads,
    clears section-bound selection/apparatus state, and never publishes an old
    fragment annotation against a new cursor.
14. Query or preview transport exhaustion renders retryable `Failed`; Retry
    reruns the exact operation. A well-formed backend 5xx, malformed payload, or
    impossible DOM/source state defects instead of offering Retry.
15. Source replacement, stale responses, and route exit cancel session,
    preview, marks, Companion results, and origin; no fallback path survives.
16. Whole-book Find transfers occurrences/snippets only, reads canonical text
    one fragment at a time by keyset inside one repeatable-read transaction,
    and uses no global search/index.
17. Focused unit, API integration, browser component, real-stack EPUB E2E,
    static, and existing reader-progress tests pass.

## Residue Gates

```bash
rg -n "createWebFindHighlightOwner|WebFindHighlightOwner|WebFindHighlightRanges|WEB_FIND_|webFindHighlights" \
  apps/web/src
rg -n "navigateToSection|reportReaderMovement|replaceReaderLocation|beginRestoreSession|setTarget" \
  apps/web/src/app/'(authenticated)'/media/'[id]'/useEpubPaneFind.ts
rg -n "response\\.rows\\[0\\]" apps/web/src/lib/panes/usePaneFind.ts
rg -n "regex\\.V1|FULLCASE|fetchall\\(" python/nexus/services/epub_find.py
rg -n "window\\.find|Continue from here|fallback" \
  apps/web/src/app/'(authenticated)'/media/'[id]'/useEpubPaneFind.ts \
  python/nexus/services/epub_find.py
```

Expected: all commands are empty.
