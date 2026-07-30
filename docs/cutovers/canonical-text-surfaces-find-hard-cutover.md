# Canonical Text Surfaces Find Hard Cutover

Status: IMPLEMENTED
Type: hard cutover
Date: 2026-07-29

No blocking product question remains.

Governing contracts:

- [`docs/rules/README.md`](../rules/README.md) and all rules it indexes;
- [`pane-search-foundation-hard-cutover.md`](pane-search-foundation-hard-cutover.md),
  now implemented and authoritative for the shell, shortcut, shared types,
  session lifecycle, Companion publication, and Return affordance.

## Decision

Add pane-local **Find occurrences** to:

- web articles;
- video and podcast-episode transcripts; and
- the accepted Dossier revision in a standalone Artifact pane.

`Cmd/Ctrl+F` uses the implemented Pane Search foundation in the active capable
pane. `Cmd+K` remains the only global Search.

Web and transcript adapters search already-loaded canonical fragments through
one pure matcher. Artifact searches the rendered DOM inside its existing
opaque sandbox. No server index, persistence, compatibility path, or second
query language ships.

## Implemented Final State

These are the shipped owners:

- `paneSearch.ts` owns canonical source/result-key constructors and publication
  types, including explicit partial-source labeling.
- `usePaneFind.ts` owns the generic `PaneFindAdapter<TError>`, preparation,
  query/preview generations, stale-settlement rejection, stepping, and Return
  availability. Its required `onOpen` reprepares from the live position only
  when no Return origin exists. Chat consumes the same contract.
- `paneSecondaryModel.ts` and the desktop/mobile hosts support a transient-only
  `resource-inspector` publication.
- `MediaPaneBody` owns one Pane Find controller and selects exactly one
  route-local Web or transcript adapter. Web uses one preview lease shared by
  its progress and activity seams; transcript changes only its local selection
  and nested segment-list scroll.
- `ArtifactPaneBody` publishes only transient `resource-search` results.
  `DossierDocumentFrame` owns the accepted sandboxed document, citations, and
  the fixed revision-bound Find runtime.

No predecessor or compatibility path remains.

## Product Principle

Steal Superhuman's separation of app-wide retrieval from native in-page Find,
its shortcut-first interaction, and progressive filters/previews — not its mail
operators or ranking. Nexus treats Find as reversible inspection, never hidden
navigation: source owners define exactness, previews are transient, and Return
is the trust-preserving escape hatch.

References: [Mail search](https://help.superhuman.com/hc/en-us/articles/46005672652301-Search),
[Mac Find](https://new.superhuman.com/superhuman-for-macos-53765),
[command philosophy](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/),
[Docs search](https://help.superhuman.com/hc/en-us/articles/46210328207757-Search-for-content-within-docs).

## Goals

- Exact literal Find with count, previous/next, Match case, Whole word, exact
  narrow scope when available, transient highlights, and contextual Companion
  rows.
- One immutable **Go back to reading position** origin per prepared session.
- Result preview and Return never advance progress, engagement, completion,
  playback, URL, or pane history.
- Shared match semantics across parent and frame execution.
- The smallest production-ready slice that current client data and owner seams
  support.

## Scope Boundary

Out:

- Page/Note direct-item filtering and all Library/podcast/chat-list
  filtering/sorting; those use foundation `FilterRows`;
- EPUB, PDF, and Chat Find;
- Find inside Dossiers embedded in another resource's Companion; a successor
  may reuse the frame capability;
- semantic, fuzzy, stemmed, regex, AI, cross-resource, or global search;
- OCR, transcript generation, backend/BFF/API/database/index changes;
- workers, virtualization, saved queries, analytics, or URL state;
- a generic document-engine package, context provider, or alternate pane.

## Target Behavior

| Situation | Required behavior |
| --- | --- |
| Active capable pane receives `Cmd/Ctrl+F` | Open/focus Pane Find; never global or native Find |
| Query/options change | Search the frozen source/scope; highlight visible matches |
| `Enter` / `Shift+Enter` | Next / previous with wraparound |
| Show results | Open document-order Companion rows with typed context |
| First result preview | Capture an exact origin before any movement |
| Later result preview | Reuse that origin; never create a stack |
| Close / `Escape` | Clear Find presentation; leave the revealed occurrence visible and Return available |
| Go back | Restore and retire the origin |
| Genuine reader input after Web preview | Resume normal progress/activity; retain Return |
| Transcript preview | Select and scroll; never seek, play, or resume |
| Partial transcript | Mark `Ready`/`NoMatches` partial; never claim a complete zero |
| Source/frame/revision/theme replacement | Cancel session, origin, marks, and stale work |
| Match 2,001 | `TooManyMatches(2000)`; return no truncated rows |

There is no “Continue from here” and no Find-owned “Play from here.” Existing
ordinary transcript click-to-play remains unchanged.

## Foundation Composition

Import the implemented foundation contract; do not restate or fork it.
Canonical adapters close only:

```ts
type CanonicalFindError = { readonly kind: "OriginUnavailable" };
type CanonicalFindResponse = PaneFindResponse<CanonicalFindError>;
```

Source/frame replacement is cancellation. Stale responses are silently
ignored by identity. A missing current result, canonical/DOM disagreement,
malformed frame message, or failed Return is a defect, not product `Failed`.
`errorMessage` exhaustively maps `OriginUnavailable`.

Close clears query/presentation but retains the prepared session and immutable
origin. Return, route exit, or source cancellation retires the origin.

Standalone Artifact composes the existing transient-only host directly:

```ts
usePaneSecondary({
  groupId: "resource-inspector",
  surfaces: [],
  defaultSurfaceId: null,
  transientSurfaces: [{ id: "resource-search", body: resultsBody }],
});
```

Publish that object whenever the Artifact Find adapter/result body is
available; host activation alone owns whether results are open. Add
`secondaryGroups: ["resource-inspector"]` to the Artifact route. Do not call
`useResourceInspector`, create a durable Dossier tab, or change host mechanics.

The cutover includes one minimal foundation amendment:

- add required `onOpen` to `FindOccurrences` publication/controller;
- on a closed-to-open transition, `PaneShell` invokes it before focusing input;
- if no Return origin exists, `usePaneFind` aborts/restarts the session and
  prepares against the live position; if an origin exists, it retains that
  session so Close cannot destroy Return;
- reopening after Return therefore prepares a new current scope; refocusing an
  already-open bar does not.

This is part of the foundation lifecycle owner, not a second lifecycle.
Existing Chat forwards the required callback; its Entire-resource behavior is
otherwise unchanged.

## Matching Contract

One pure `canonicalTextFind` owner implements:

1. Literal, NFC query; case-insensitive by default. Escape the literal and use
   ECMAScript Unicode simple case folding (`iu`) or an equivalent
   length-preserving comparison. Never use `toLowerCase`, accent folding, or
   locale-specific expansion.
2. Whole word only when both edges are boundaries from
   `Intl.Segmenter("und", { granularity: "word" })`. Compute per query;
   introduce caching only after measurement.
3. Non-overlapping, left-to-right, document-order matches. Scan each logical
   fragment/block independently; a match never crosses one. The single-line
   input invariant excludes CR/LF from matcher requests.
4. Right-open Unicode-codepoint ranges. Convert JavaScript UTF-16 match indexes
   to codepoint offsets in one forward pass, never once from string start per
   result.
5. Stop at match 2,001 and return `TooManyMatches(2000)` with no rows.
6. Snippets are foundation `EmphasisSegment[]`, never HTML, with at most 64
   codepoints of context per side inside the logical unit.

`completeness` means loaded-source coverage, not permission to match across
logical boundaries. A phrase split across transcript ASR segments is an
accepted 80/20 false negative. `TooManyMatches` makes no completeness claim
because the implemented foundation state has no such field.

The parent matcher and fixed frame runtime share one behavior corpus: NFC,
case, word boundaries, astral codepoints, combining marks, punctuation,
whitespace, boundary exclusion, snippets, ordering, scopes, non-overlap, and
the result cap. Include deterministic-script boundary assertions and one CJK
smoke case.

## Domain Model

Adapter-internal shapes:

```ts
type FindSourceIdentity =
  | {
      readonly kind: "WebArticle" | "Transcript";
      readonly mediaId: string;
      readonly fragments: readonly {
        readonly id: string;
        readonly idx: number;
        readonly createdAt: string;
      }[];
    }
  | {
      readonly kind: "DossierRevision";
      readonly artifactRef: string;
      readonly revisionRef: string;
    };

type FindScope =
  | { readonly kind: "EntireResource" }
  | {
      readonly kind: "CurrentSection";
      readonly fragmentId: string;
      readonly startCp: number;
      readonly endCp: number;
    }
  | {
      readonly kind: "CurrentChapter";
      readonly ordinal: number;
      readonly startMs: number;
      readonly endMs: Presence<number>;
    };

type FindLocator =
  | {
      readonly kind: "FragmentRange";
      readonly fragmentId: string;
      readonly startCp: number;
      readonly endCp: number;
    }
  | {
      readonly kind: "ArtifactRange";
      readonly startCp: number;
      readonly endCp: number;
    };
```

- Build `sourceKey` once from the complete frozen source identity with
  `createPaneFindSourceKey`.
- Build each row key with `createPaneFindResultKey` from a compact exact
  occurrence source (`kind + mediaId + fragmentId`, or
  `artifactRef + revisionRef`) and its locator. Never repeat the ordered
  fragment snapshot in every row.
- Keep key-to-locator maps session-local and ephemeral. Consumers compare keys;
  none parses or persists them.
- Freeze one exact narrow scope during `prepare`; omit the selector when none
  exists. Duplicate transcript `chapter_idx` values are valid, so chapter
  scope identity uses session ordinal and the resolved time interval.

Row context is:

- Web: section label, when present;
- Transcript: chapter title, existing formatted timestamp, speaker, omitting
  absent values;
- Artifact: closest accepted section heading, when present.

## Web Article Contract

- Search ordered `fragments[].canonical_text`, never `html_sanitized`.
- Entire article covers every loaded fragment.
- Resolve `This section` at preparation from the reading locator against
  `ReaderNavigationSection.fragment_id/start_offset/end_offset`. Choose the
  deepest/narrowest containing range, then ordinal; omit if exact resolution
  fails. A match must fit wholly inside the frozen range.
- Preview switches the rendered fragment through new route-local
  `SearchPreview` state. It never invokes router/hash/target/normal navigation.
- Before the first move capture:

```ts
interface WebFindOrigin {
  readonly fragmentId: string;
  readonly anchorCp: number; // first visible canonical codepoint
  readonly viewportTopDeltaPx: number;
  readonly scrollLeft: number;
}
```

- Await the target fragment render, resolve the exact DOM ranges, set active
  marks, and scroll through `paneTextAnchor.ts`. No fragment-top fallback.
- Return renders the origin fragment through the same preview-only path,
  restores anchor/delta and horizontal scroll, and focuses the existing reader
  viewport.

### Canonical DOM provenance

The current cursor normalizes complete emitted text to NFC, while
`canonicalCpToRawCp` only reverses whitespace. It cannot map composition or
reordering across text nodes.

Upgrade the `canonicalCursor.ts` owner to emit a provenance-bearing canonical
span map:

- collect raw DOM UTF-16 spans across adjacent inline nodes;
- normalize complete canonical combining sequences, not individual
  characters;
- map every normalized output span to one or more source DOM spans;
- retain whitespace/block provenance and exact synthetic-boundary behavior;
- resolve one canonical occurrence to one or more DOM `Range`s.

`paneTextAnchor.ts` consumes that map for exact collapsed anchors and ranges.
The fixed frame runtime mirrors the algorithm because it cannot import parent
modules. The shared corpus must include a decomposed sequence split across
inline nodes and reordered combining marks. If reconstructed canonical text
differs from `fragment.canonical_text`, defect before movement.

Nexus Highlights may rebuild article DOM. Rebuild Find ranges after
`renderedHtml` or active-fragment change.

### Web highlight registry

CSS Custom Highlights are document-global. A small Web-only registry aggregates
ranges for all mounted pane/session owners into fixed
`nexus-find-all`/`nexus-find-active` `Highlight` objects. Clearing one owner
must retain every other pane's ranges. Style in `page.module.css` with:

- a visible all-match mark;
- a non-color active distinction;
- forced-colors treatment.

Never DOM-wrap Find marks or route them through Nexus Highlights.

## Transcript Contract

- Search readable fragments in timeline order for both video and podcast
  episodes.
- `Partial` applies when transcript state or coverage is partial. Partial
  `NoMatches` copy states that zero matches were found in available transcript.
- Preview sets `activeTranscriptFragmentId`, targets the exact occurrence span
  within that row, and scrolls it inside the dedicated `.transcriptSegments`
  container. It never calls segment click,
  `handleTranscriptSeek`, `seekTo`, `resume`, or any player capability.
- Timeline rows render all occurrence spans for that segment using existing
  typed emphasis text; do not rematch row strings. ActiveMatch has a non-color
  visual distinction and an accessible current-match label.
- `TranscriptContentPanel` receives occurrence ranges plus `activeKey` and
  projects a route-owned `Text | Match | ActiveMatch` render union. Companion
  snippets remain foundation `EmphasisSegment[]`; do not overload that
  two-state shape.
- Capture `{activeFragmentId, segmentListScrollTop}` before first preview.
  Return restores selection, awaits the row, restores that container, and
  focuses the segment-list reading surface.
- Transcript has no current scroll-progress/activity seam. This cutover adds
  none: its view does not mount the non-PDF `readerRootRef`, so
  `ReaderActivityAdapter` returns before registering an observer. Safety is
  structural: Find touches selection/list scroll only and never progress,
  activity, player, URL, or history owners.

Extend `transcriptChapters.ts` with one interval resolver used by Find and
`TranscriptPlaybackPanel`:

- start-inclusive, end-exclusive;
- end is the earlier valid explicit end or next later chapter start;
- the final open chapter covers remaining timed segments;
- untimed or ambiguously contained origins get no chapter scope.

`TranscriptContentPanel` continues consuming normalized ordered chapters for
dividers; do not rewrite its divider cursor unless implementation exposes a
real interval inconsistency.

## Web Preview Safety

`useMediaPaneFind` owns one route-local ref-backed preview lease shared with
the actual progress/activity seams. No context/provider or scattered
`isSearching` flags.

Acquire before programmatic movement:

- gate `MediaPaneBody.scheduleTextViewportCapture` before it publishes activity
  or mutates `terminalReportedGenerationRef`,
  `lastSavedTextAnchorOffsetRef`, or suppression state;
- make `useReaderProgress.reportMovement` and lifecycle flush consult the same
  lease as defense in depth;
- lifecycle flush may finish a dirty/in-flight pre-lease locator unchanged,
  but may not capture the preview location or emit a clean same-locator
  engagement write;
- make `ReaderActivityAdapter` immediately publish ineligible and accrue no
  reading time while leased.

Release synchronously before forwarding the first genuine input through the
real owners:

- `MediaPaneBody.handleTrustedTextScrollIntent` for text scroll/key intent;
- `ReaderActivityAdapter`'s internal pointer listener.

The coordinator releases both consumers once; do not add duplicate wheel/key
listeners. Absorb the existing one-shot programmatic-scroll suppression flag
into this lease. A later result reacquires it without replacing the origin.
Return uses the same preview fence. Route/source cancellation retires both.

Prove visibility loss, `pagehide`, pane deactivation, unmount, and pre-armed
terminal state cannot persist or complete from a preview location.

## Artifact Contract

Search only the accepted revision's rendered top-level `<article>` in the
iframe. Never map parent `content_text` offsets back to DOM.

The frame:

- projects eligible text nodes in DOM order, excluding `.dossier-citation`
  subtrees, using the canonical cursor/backend block, hidden, and skipped-node
  rules;
- applies the same whitespace, block-boundary, NFC, provenance, matcher,
  snippet, and cap contract as the parent;
- requires a `1..160,000`-codepoint projection; an accepted compiled document
  with no projected readable text is a contract defect;
- offers `This section` only when the prepared first-visible anchor has a
  closest accepted `section[id]`;
- owns ranges, Custom Highlights, active scrolling, and one semantic origin:
  first-visible projected codepoint, viewport-top delta, and horizontal scroll.

Keep sandbox exactly `allow-scripts` and current CSP. Never add same-origin,
network, storage, forms, popups, downloads, DOM wrappers, `innerHTML` writes,
or fallback rendering.

Append fixed Find `::highlight` rules in the frame document builder/runtime's
existing nonce-bearing style element, using existing document variables. Do
not put Find behavior in the `MachineText` typography owner.

Pass `revisionRef` to `DossierDocumentFrame`. Expose a revision-bound
imperative capability upward; `DossierSurface` may relay it but never publishes
Find. Only standalone `ArtifactPaneBody` creates the adapter, and only after
the exact frame generation is ready; replacement removes that adapter and
cancels its session.

## Artifact Frame Protocol

Replace `DOSSIER_CITATION_BRIDGE` with one fixed
`DOSSIER_DOCUMENT_RUNTIME`. Generated content remains data, never executable
source.

```text
Parent -> frame
FindHello    { channel, kind: "FindHello" }
FindEnabled  { channel, kind: "FindEnabled" }
FindDisabled { channel, kind: "FindDisabled" }
FindPrepare  { channel, kind: "FindPrepare", sessionId }
FindQuery    { channel, kind: "FindQuery", sessionId, queryId, query, scope, matchCase, wholeWord }
FindActivate { channel, kind: "FindActivate", sessionId, queryId, ordinal }
FindClear    { channel, kind: "FindClear", sessionId, queryId }
FindReturn   { channel, kind: "FindReturn", sessionId }

Frame -> parent
FindReady               { channel, kind: "FindReady" }
FindPrepared            { channel, kind: "FindPrepared", sessionId, projectionLengthCp, currentSection }
FindResults             { channel, kind: "FindResults", sessionId, queryId, result }
FindActivated           { channel, kind: "FindActivated", sessionId, queryId, ordinal }
FindActivationRejected  { channel, kind: "FindActivationRejected", sessionId, queryId, ordinal, reason: "OriginUnavailable" }
FindCleared             { channel, kind: "FindCleared", sessionId, queryId }
FindReturned            { channel, kind: "FindReturned", sessionId }
FindReturnRejected      { channel, kind: "FindReturnRejected", sessionId, reason: "OriginUnavailable" }
FindRequested           { channel, kind: "FindRequested" }
Citation                { channel, kind: "Citation", ordinal }
```

The result union is `Ready(1..2000 ordered occurrences) | NoMatches |
TooManyMatches(2000)`. Occurrences contain ordinal, right-open projected
codepoint range, `EmphasisSegment[]`, and `Presence<SectionInfo>`. Use the
repository `Presence<T>` wire shape. Exact-decode keys, discriminants, safe
integers, query `1..256`, projection `1..160000`, section/title bounds,
snippet bounds, monotonic non-overlapping ranges, and ordinal `0..n-1`.

Trust and lifecycle:

- Parent checks exact `contentWindow`, random channel, closed payload, current
  revision, frame generation, session, and query. Frame checks
  `window.parent`, channel, and closed payload. Opaque-origin messaging uses
  `"*"` only to that exact window.
- Per exact `srcDoc` generation, keep `loadSeen` and `readySeen` latches.
  After installing the parent listener and after every iframe `load`, parent
  sends idempotent `FindHello`; frame replies to every exact Hello. Become
  ready when load and the first exact Ready have both occurred in either order.
  Reset both on generation replacement. No proactive one-shot Ready can be
  lost before the listener exists.
- Rotate/remount channel and nonce for
  `(revisionRef, contentHtml, title, theme)`. Replacement cancels Find.
- Every awaited command terminal-settles with its success or closed rejection.
  One named transport timeout defects so a broken bridge cannot hang. This is
  transport settlement, not a heuristic expiry of the reading origin.
- First activation captures origin before movement; later activations retain
  it. Clear removes marks only. Return restores and retires it. A failed Return
  is a defect after the rejection settles. Successful Return focuses the
  iframe reading surface.
- The fixed runtime intercepts unshifted `Cmd/Ctrl+F`, prevents iframe-native
  Find, and emits `FindRequested` only after `FindEnabled`. Parent sends Enabled
  only while the exact route's Pane Search publication is committed and its
  pane is active, not merely after frame Ready; it sends Disabled before
  deactivation/unpublication. After exact frame validation,
  `ArtifactPaneBody` calls existing `dispatchPaneSearchRequest()` only while
  its `paneRuntime.isActive`; shifted Focus Mode remains untouched.
- Citation validation and behavior remain unchanged.

## Accessibility

- Active Companion row uses `aria-current`; the foundation announces active
  ordinal/total, and each row's accessible name includes its context.
- Highlights have non-color active and forced-colors distinctions.
- Return focuses the format-owned reader destination: Web viewport, transcript
  segment list, or Artifact frame.
- Mobile uses only the existing Companion sheet; activation collapses it as
  foundation-defined.

## API, Persistence, And Concurrency

No HTTP route, backend service, worker, database table, migration, workspace
field, URL parameter, or analytics event changes.

`sessionId`, `queryId`, `sourceKey`, and frame generation fence all async work.
Abort where possible; stale messages and settlements are inert. Adapters add
no debounce. Result keys, maps, scopes, origins, leases, and frame projections
are ephemeral.

## Files And Ownership

Create:

- `apps/web/src/lib/reader/canonicalTextFind.ts` + test — matcher, snippets,
  corpus, cap;
- route-local `useMediaPaneFind.ts` + browser test — Web projection, origin,
  preview lease, and exact DOM presentation;
- route-local `transcriptPaneFind.ts` + unit/browser tests — transcript
  projection, selection/list-scroll preview, partial coverage, and Return;
- `apps/web/src/lib/reader/webFindHighlights.ts` + test — multi-pane Custom
  Highlight registry;
- `apps/web/src/components/dossier/dossierDocumentRuntime.ts` + browser test —
  fixed Citation/Find runtime and frame-owned styles.

Extend:

- `paneSearch.ts`, `usePaneFind.ts`, and `PaneShell.tsx` — closed-to-open
  session reprepare and explicit partial-source copy;
- `Conversation.tsx` and focused tests — forward the required `onOpen` hard
  cut; no Chat behavior expansion;
- `MediaPaneBody.tsx` — composition, preview-only fragment state, central
  capture/input gates; no inline matcher;
- `paneTextAnchor.ts`, `canonicalCursor.ts`, and tests — provenance ranges,
  exact anchor/delta restore;
- `page.module.css` — Web Find highlight rules;
- `TranscriptContentPanel.tsx` — stable row targets, typed emphasis, segment
  scroll ref;
- `transcriptChapters.ts` and `TranscriptPlaybackPanel.tsx` — shared interval
  membership;
- `useReaderProgress.ts` and `ReaderActivityAdapter.ts` — Web shared-lease
  enforcement;
- `ArtifactPaneBody.tsx` — standalone adapter and transient-only publication;
- `paneRouteModel.ts` — Artifact `resource-inspector` opt-in;
- `DossierSurface.tsx` and `DossierDocumentFrame.tsx` — revision-bound
  capability and strict protocol.

Do not change foundation host mechanics or `MachineText.tsx`.

The workspace and reader module docs record the shipped composition. Artifact
has no separate module doc; its standalone-pane contract is recorded in
`workspace.md` and this canonical cutover.

## Hard Cut

- Delete `DOSSIER_CITATION_BRIDGE`; only `DOSSIER_DOCUMENT_RUNTIME` survives.
- Delete any superseded matcher, UTF-16 result contract, snippet HTML, direct
  DOM search, decoder, preview flag, shortcut listener, type, style, comment,
  and test exposed by this cutover.
- Do not add legacy shims, optional compatibility branches, fallbacks, or dual
  protocols.
- Preserve `Cmd/Ctrl+Shift+F` Focus Mode, global Search, normal transcript
  click-to-play, citations, Nexus Highlights, and unrelated navigation.

## Implementation Record

1. Matcher/corpus and compact identities.
2. Canonical DOM provenance, exact Web preview/Return, multi-pane highlights.
3. Shared lease enforcement and lifecycle proof.
4. Transcript projection, row preview/Return, and chapter intervals.
5. Fixed Artifact runtime/protocol and standalone transient publication.
6. Delete residue, update owner docs, run gates.

## Acceptance Criteria

1. Active-pane `Cmd/Ctrl+F` from the parent document or Artifact frame and
   global `Cmd+K` never conflict; shifted Focus Mode remains intact.
2. Parent and frame agree on NFC, case, whole word, codepoints, ordering,
   snippets, boundaries, non-overlap, and the 2,000 cap.
3. Web searches all loaded fragments; section scope is reprepared from the
   live position on eligible closed-to-open transitions, uses exact navigation
   ranges, and handles two sections in one fragment. Existing Chat forwards the
   required hook and retains its behavior.
4. Web exact preview/Return restores fragment, canonical anchor/delta,
   horizontal scroll, and reader focus without router or target navigation.
5. Decomposed/reordered combining sequences across inline nodes map to exact
   DOM ranges. Canonical mismatch moves nothing.
6. Two simultaneous Web panes retain independent all/active highlights;
   DOM rebuild and owner clear do not leak or erase another pane.
7. Transcript stepping targets and distinguishes the exact occurrence within a
   multi-match segment. Preview/Return changes selection/list scroll only; it
   never seeks, plays, resumes, writes progress/activity, or changes
   URL/history.
8. Chapter scope uses exact shared intervals despite duplicate `chapter_idx`;
   partial zero is explicitly partial; cross-segment phrase limitation is
   tested and documented.
9. Accepted Artifacts prepare. Inline-split NFC, punctuation, block boundaries,
   whitespace, astral text, and citation exclusion map and highlight without
   DOM mutation.
10. Frame CSP/sandbox remain exact. Wrong window/channel/key/generation/
    session/query/revision, malformed payload, and out-of-bounds ordinal are
    inert. Idempotent Hello cannot lose Ready, load/Ready work in either order,
    every command settles, and frame `Cmd/Ctrl+F` opens only its active pane.
11. First preview cannot move without exact origin. Close preserves Return;
    repeated jumps retain one origin; Go back restores and retires it.
12. Web preview/Return creates or replaces no reader-state write, activity
    time, completion, URL/history write, or playback change across lifecycle
    flush and pre-armed terminal state. Pre-lease dirty work may finish
    unchanged.
13. Companion state is transient, restores prior visibility/tab, uses the
    existing mobile sheet, and gives standalone Artifact no durable tab.
14. No backend, persistence, global-search, compatibility, or fallback path
    exists. Focused unit/browser tests, strict frontend checks, residue gates,
    and one real-stack Web + partial-transcript + Artifact journey pass.

## Residue Gates

```text
rg "DOSSIER_CITATION_BRIDGE|allow-same-origin" apps/web/src
rg "window\.find|innerHTML.*Find|<b>" apps/web/src/lib/reader apps/web/src/components/dossier
rg "ctrlKey.*[fF]|metaKey.*[fF]|window\.find" apps/web/src
rg "handleTranscriptSeek|seekTo\(|resume\(" <new transcript Find paths>
rg "Continue from here|Play from here" <new Find paths>
```

Expected shortcut residue is the implemented Pane Find owner plus existing
shifted Focus Mode. Other matches require explicit owner-by-owner
justification; comments and tests are not automatic exceptions.
