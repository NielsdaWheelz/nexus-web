# Reader Design Rationale

This document records the reader constraints we ship and the system shape they imply.

## objectives

- improve long-form reading comfort on desktop and mobile
- preserve comprehension under reflow
- keep resume deterministic across web, transcript, epub, and pdf
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
  sentence) plus off; shortcut Cmd/Ctrl+Shift+F; auto-suspend during
  active text selection so annotation flow is uninterrupted
- contrast: high but not maximal; never pure black on pure white; reader
  surface stays in the warm-neutral family used by the rest of the app

research can support softer tinted backgrounds, but that does not justify
the additional product and maintenance complexity here. the shipped system
intentionally stays with two reader themes: light and dark.

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

## shipped architecture

### global reader profile

- `reader_profiles` stores the global reader preferences for a user
- shipped fields are `theme`, `font_family`, `font_size_px`,
  `line_height`, `column_width_ch`, `focus_mode`, and `hyphenation`
- `focus_mode` is one of `"off" | "distraction_free" | "paragraph" | "sentence"`
- `hyphenation` is one of `"auto" | "off"`; default `auto` enables only
  on viewports `<= 600px`; `off` disables on every viewport
- all reflowable reader appearance comes from this single source of truth
  across web article, transcript, and epub readers

the bootstrap read of this profile is required, not best-effort, unlike the
rest of the workspace data root. The profile's `column_width_ch`, `font_size_px`,
and `line_height` feed the pane-width probe that sizes every non-PDF pane
before the workspace mounts, so a silently defaulted profile would size and
then re-size the workspace under the user, and a frontend default (e.g.
falling back to Light) would mask a real backend/auth problem behind a
plausible-looking screen. Making the read required and surfacing failure
through `AuthenticatedWorkspaceErrorBoundary` with Retry costs one blocking
round-trip behind the already-streamed skeleton in exchange for never
lying about server state.

the profile and the reader cursor (`reader_media_state`, above) deliberately
use different conflict models for the same reason they are different data:
the profile is one small preference bag per user with no meaningful
"undo my last edit" shape, so serialization-order last-write-wins is
sufficient — distinct-field partial writes already compose, and a same-field
race is just a timing outcome, not a lost user action. The reader cursor is a
positional bookmark where silently overwriting a genuine "go back" intent
from another device is a real correctness bug, which is what the
revision/CAS protocol exists to prevent. Adding CAS to the profile would add
protocol cost without protecting anything that can actually go wrong.

the client also keeps optimistic `desired` pixels and server-acknowledged
`acknowledged` state as two separate facts rather than one. Local intent must
paint immediately for perceived responsiveness, but only a value the server
has actually confirmed is safe to treat as the baseline a later clean-tab
resume adopts from — collapsing the two would either let a background
revalidation silently overwrite unacknowledged local intent, or force the UI
to wait for the network before ever moving a control. This is also why the
profile has no generic `save(Partial<ReaderProfile>)` and no React 19
`useOptimistic`: `useOptimistic` cannot own single-flight transport ordering,
a latest-merged queue, the attempt watchdog, lifecycle-flush promotion, or
generation-guarded revalidation, so using it would either drop those
guarantees or duplicate `desired` under another name. The same reasoning is
why this coordinator is not generalized with reader progress, workspace
session, or note autosave: a revisioned single value and an unrevisioned
preference bag have different identity and conflict shapes that a shared
sync hook would blur.

### per-media progress

- `reader_media_state` stores one canonical cursor row per user/media: a
  non-null jsonb `locator` and a monotonic bigint `revision` (starts `1`,
  authoritative — `updated_at` is metadata only, not a conflict token)
- `GET /api/media/{id}/reader-state` returns exactly
  `{state:"Empty",revision:0}` or `{state:"Positioned",revision>=1,locator}`,
  never raw `null`
- `PUT /api/media/{id}/reader-state` takes the one strict envelope
  `{cursor?: {locator, base_revision}, attention?}` — at least one block is
  required; old bare locators, extra fields, and a top-level `null` clear are
  rejected with `400`
- a matching `base_revision` replaces the cursor and increments `revision`; a
  stale `base_revision` returns `409` with the exact current snapshot and
  mutates nothing; attention-only writes return `204` and never touch the
  cursor row
- `useReaderProgress` is the single browser-side coordinator that serializes
  and coalesces cursor writes (single-flight, latest-only, revision-aware);
  event-driven revalidation on pane activation, visibility, focus, `pageshow`,
  and `online` lets a clean, dormant reader auto-adopt a newer cursor from
  another device, while an active or locally dirty reader is offered the
  handoff instead of being teleported
- text readers persist explicit targets plus `locations` and quote context
- pdf persists `page`, `page_progression`, `zoom`, and coarse `position`
- the shipped contract is discriminated by `kind` and rejects removed flat
  locator bags

### reader-to-chat quote selection

- quote-to-chat is highlight-first: the reader creates a durable highlight, adds
  `highlight:<id>` as the conversation context ref, and sends a transient
  `reader_selection` anchor for that chat turn
- `reader_selection` carries `media_id` + `highlight_id`; the backend
  canonicalizes prefix/exact/suffix/source from the highlight row before
  rendering `<reader_selection>`
- the selection is bind-only context for words like "this" or "the quote"; it is
  never stored as a reference and never numbered
- citation chips point at the attached `highlight:` reference or later
  `read_resource` evidence, not at the transient selection block
- pdf quote-to-chat passes the freshly created highlight payload through the
  same path as web/epub so a just-created quote does not depend on a stale
  highlight list refresh

### reflow-safe web resume

web article resume uses canonical text offsets instead of raw scroll
pixels.

- map rendered dom text to canonical codepoint offsets
- persist the first visible canonical offset as resume state
- restore by mapping that offset back to dom position

this makes resume resilient to font-size, line-height, and column-width
changes.

### layered epub/web/pdf resume

- epub resolves one-shot hash targets such as `#loc-<section_id>` first,
  then saved exact target snapshots, then coarse fallback, then first section.
  Pane-local section navigation replaces `?loc={section_id}` as coarse
  in-visit address state; it adds no Back/Forward entry.
- once the section is open, epub restores by exact text offset,
  then quote context, then progression, then coarse publication fallback,
  then anchor fallback
- restore is one-shot and abortable; user scroll cancels any pending
  automatic restore
- web/transcript pick explicit fragment/time targets first and fall back
  to the saved explicit target otherwise
- pdf restores saved page, intra-page progression, and zoom on open and
  persists later page changes without reopening the document file

Bare routes resume the canonical cursor internally rather than through URL
state: the stable entry `/media/:id` never redirects to progress parameters.
Cold-mount precedence is fresh feature-owned hash/evidence/highlight target,
then the Positioned canonical cursor, then a coarse cold `?loc`/`?fragment`
query only when the cursor is Empty, then the default readable source. A
copied or bookmarked coarse link should not silently override real saved
progress; when the canonical cursor supersedes a cold query, pane-local
replace strips only `loc`/`fragment` and preserves unrelated query state and
hash. Ordinary scrolling never writes the URL, and pane Back/Forward is
workspace-level traversal that never persists a cursor merely because
history moved it.

### addressability versus history

reader location and pane history solve different problems and stay
independent. reader location stays URL-addressable and durable: coarse
`?loc`/`?fragment` state addresses the current mounted visit, and the
canonical cursor is the durable record across visits and devices. pane
Back/Forward is structural — a compact story of the destinations a user
visited, not a transcript of every section, fragment, or footnote touched
inside one visit. Treating in-reader movement as history noise would force
Back to take many presses to leave a single document and would force the
workspace to guess reader semantics from URL shape; instead the reader
replaces its own address and the workspace's Back/Forward stays about panes,
not passages.

the one accepted cost: pane Back/Forward no longer returns to the passage a
footnote, apparatus entry, highlight, or embed jump was launched from. the
prototype accepts this loss rather than adding a reader-local return stack or
a new affordance; Contents, section controls, Document Map/Evidence
navigation, and canonical resume remain, but none of them restores the exact
source passage.

### epub request surface

- epub navigation is sourced from `GET /api/media/{id}/navigation`
- epub section content is sourced from
  `GET /api/media/{id}/sections/{section_id}`
- `section_id` is path-encoded and may contain `/`
- `#loc-<section_id>` is the one-shot reader target shape; `?loc={section_id}`
  is the pane-local coarse address state that replace writes — not a
  Back/Forward checkpoint
- the reader no longer depends on removed chapter manifests or toc fetches

## regression strategy

required automated coverage includes:

- reader settings persistence
- web article canonical locator resume after profile typography reflow
- epub `#loc-` hash deep link precedence over saved resume
- a cold `?loc`/`?fragment` query loses to an existing Positioned cursor
- epub delayed-hydration no-snap-back after manual scroll
- epub intra-section locator resume after reload
- pdf page + zoom + intra-page locator resume after reload
- pdf in-session page persistence without file reopen
- clean, dormant cross-device re-entry auto-applies a newer cursor without
  remount; active/dirty re-entry shows the handoff
- reader-to-chat quote flow sends a durable `highlight:` reference and, when
  the highlight has nonblank exact text, a transient `reader_selection`
  carrying `media_id` + `highlight_id`

## validation commands

```bash
cd apps/web && bunx vitest run --project unit src/lib/reader/readerProgress.test.ts src/lib/reader/readerLocationHref.test.ts src/lib/reader/types.test.ts src/lib/media/readerNavigation.test.ts
cd apps/web && bunx vitest run --project unit src/lib/conversations/chatRunBody.test.ts src/lib/api/sse/events.test.ts src/lib/conversations/citations.test.ts
cd apps/web && bunx vitest run --project browser 'src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx' 'src/app/(authenticated)/media/[id]/TextDocumentReader.test.tsx' src/components/reader/ReaderDocumentMapOverviewRail.test.tsx src/components/reader/document-map/ReaderDocumentMapHighlightsLens.test.tsx src/__tests__/components/ResourceChatDetail.test.tsx
make test-e2e PLAYWRIGHT_ARGS='tests/reader-progress-continuity.spec.ts --project=chromium'
make test-e2e PLAYWRIGHT_ARGS='tests/quote-attach-references.spec.ts tests/pdf-reader.spec.ts --project=chromium'
```
