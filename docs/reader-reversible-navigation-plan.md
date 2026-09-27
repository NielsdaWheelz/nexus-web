# reversible reader navigation

status: implemented on `feature/reader-reversible-navigation`; final acceptance remains partial
origin: 2026-09-26 owner approval of [the council review](reader-reversible-navigation-council.md)
authority: this implementation contract settles that review's proposed choices.

## goal, scope, final state

inspect a document without losing the reading place or recording the detour as
progress. one shared mounted-reader navigation owner serves hosted/offline
article, epub and pdf readers. existing transcript find consumes the same
lifecycle where necessary to remove the shared legacy lease; playback is unchanged.

include contents/section selection, highlights, find, source-note navigation,
chunk/fragment links, native pdf destinations, home/end and existing scrollbar
seeks. ordinary sequential traversal, including reading-order chapter continuation,
remains reading. clicking already-visible content without movement is not a jump.

approved decisions: one origin, explicit adoption, no timeout, position-based
progress, duration-only hosted engagement during canonical-document inspection.
adoption can advance maximum progress and mark finished at the existing 95%
threshold. this is intentional; it does not assert coverage of skipped text.

non-goals: per-hop history, read-coverage accounting, speed/dwell inference,
cross-device excursion sync, restart restoration of detours, new note previews,
new offline capabilities/analytics, playback changes, new services/endpoints,
database/native-wire changes, or permanent test infrastructure.

new-ingest source-anchor preservation was included to satisfy n1's real article
journey; stored-source repair remains in the separate source-notes package.
retain the separate
[publication/cursor repair owner](tickets/web-publication-invalidates-saved-reader-cursors.md);
this feature must expose unavailable origins without guessing replacements.

## behavior and invariants

1. capture the live departure before movement, preserving eligible unsaved reading
   through the existing writer. `a → b → c` retains `a`; a failed move from `b`
   rolls back to `b`. the rollback departure and return origin are distinct.
2. scrolling, selecting, waiting, inspector/find closure, hiding controls and
   backgrounding never adopt an inspection location. genuine input can cancel an
   in-flight move; it cannot silently switch reading mode.
3. return restores the semantic passage plus captured viewport placement and
   meaningful focus. unchanged-layout round trips must not drift. reflow preserves
   passage/alignment, not obsolete absolute pixels. an authored backlink to the
   actual recorded occurrence invokes return; other backlinks remain inspection.
4. `continue reading here` captures the settled destination while protected, closes
   its duration-only activity interval, enqueues that exact locator and ends
   inspection as one local transition. failed capture retains protection; later
   save failure/conflict uses existing recovery. no extra confirmation.
5. inspect/return movement alone cannot change cursor, high-water progress,
   completion, remaining-time projection or native pending progress. legitimate
   pre-departure writes may finish. freeze acquisition, not the entire writer.
6. remote revalidation continues; automatic viewport adoption is forbidden while
   inspecting or positioning. `use newer spot` ends inspection only after verified
   arrival. `keep my reading spot` resolves against the held eligible locator,
   never the displayed detour. without a local spot, `keep inspecting` acknowledges
   the remote baseline without writing an invented cursor. retain revision checks.
7. close/reload resumes the saved reading spot, not the detour. consume explicit
   one-shot targets; coarse location urls do not override resume on ordinary reload.
   a fresh explicit deep link inspects its target with saved progress as origin.
   without saved progress it has no return action and requires explicit adoption.
   an untargeted first open starts ordinary reading.
8. source replacement invalidates old checkpoints visibly; never map by percentage.
   authoritative reset cancels positioning and clears the origin through the
   existing reset owner. media/visit exit disposes only that visit's state.

## capability, schemas and composition

`input/find/source action → navigation owner → format adapter → paneScroll`

the owner also supplies synchronous eligibility to the existing progress writer
and activity adapter. chrome observes state; source loading remains in
`DocumentReaderSession`. no new persisted or transport schema.

```text
ReadingMode = Reading | Exploring { origin: Presence<ReaderCheckpoint> }
ReaderCheckpoint =
  Captured { source, location, placement, occurrence, focus }
  | Saved { source, locator: ReaderResumeState }
NavigationOutcome = Arrived | Unchanged | Cancelled { displaced }
  | Unavailable { reason, displaced }
reason = CaptureUnavailable | TargetUnavailable | SourceChanged | PositioningFailed
```

reuse existing location types: canonical fragment/codepoint or authored anchor,
pdf page/destination and find match. `source` uses current text publication
identity/generation, loaded pdf fingerprint, or offline package identity; signed
urls and layout generations are not publication identities. text placement is
anchor-to-viewport delta plus horizontal position; pdf uses existing page delta,
zoom and horizontal geometry. preserve rotation through existing renderer state.
occurrence/focus use actual source identity and existing focus primitives; absent
facts use `Presence`, not invented labels or geometry. saved-entry checkpoints
have no captured placement. the current viewport remains the format publication,
not a copied cursor in navigation state.

absent origin is permitted only for targeted entry without saved progress. failure
to capture an established reading place blocks the jump. one private current
request/abort controller holds the immediate departure; superseded callbacks are
inert. unavailable target/return retains recoverable state; defects retain normal
defect reporting. no generic workflow/token framework.

| internal command | contract |
|---|---|
| `inspect(target, occurrence)` | capture/fence before resolving or moving; retain first origin; publish after actual movement |
| `beginSeek()` | capture/fence before native scrollbar movement; return operation-local settle/cancel callbacks; no movement means `Unchanged` |
| `returnToOrigin()` | exact restoration; retire origin only after verified arrival |
| `adoptHere()` | capture while protected, admit to existing ordered writer, then resume ordinary eligibility |
| `applyCanonical(snapshot, reason)` | existing accepted-remote/reset authority through the same positioning boundary |

format adapters expose `capture()` and cancellable `position(target, signal)` with
typed outcomes; `displaced` reports movement performed by that operation. they
own geometry, rendering readiness and exact-arrival checks;
they own no origin, adoption, history or progress policy. inspect/return/canonical
application use one positioning path. preserve source checks and pdf access refresh.

ordering: capture departure → close this reader's activity span using its OLD
measurement → fence acquisition/remote auto-apply synchronously → move → validate
request/source/arrival → settle. only current non-user failure may roll back to
immediate departure; failed rollback retains protection/recovery. user cancellation
after displacement keeps the actual view and protected origin; before displacement
it restores the previous mode. superseded callbacks never roll back newer work.
no-op/failure before movement leaves mode intact. reflow creates no excursion.

reuse `ReaderSemanticViewport`, canonical anchor helpers, `paneScroll.ts`,
`ReaderProgressPort` and existing ordered cursor writes. enforce eligibility at
both movement and lifecycle capture. reader-find return availability/actions
derive from this owner; remove its competing origin/return lifecycle while
preserving generic conversation/artifact find behavior.

`Reading` mode alone does not authorize saving: retain semantic publication
provenance and source/layout checks. programmatic restore/reflow cannot become
reading writes; terminal reports still require eligible trusted forward traversal.

hosted main-document inspection may renew existing activity eligibility on
genuine input, with progress/word endpoints absent. close spans before each jump,
return and adoption; a later react effect is too late. copied evidence-pane notes
remain activity-free. no span may bridge skipped word positions.

## designer-owned content and interaction

each implementation package pairs its engineer with the named designer below.
designers supply examples before code and inspect rendered results; schema-valid
content alone does not pass. one shared status area reserves space outside prose;
it stays reachable when reader chrome retreats, without pinning every toolbar.

| feature / designer | content contract and quality bar |
|---|---|
| return / reading designer | `reading spot held · {origin label}`; `back to your spot`, `continue reading here`, quieter `hide details`. labels derive from the origin's real heading/page/global percentage; omit unavailable facts. never say “saved” for an unsaved origin |
| compact state / interaction designer | hide replaces details with `reading spot held`; opening restores the same options. without origin: `inspecting this passage`, compact `inspection · options`. no return button, invented origin or hidden protection flag |
| remote progress / content designer | compact `newer reading spot available · review`; expanded `use newer spot` / `keep my reading spot` (or `keep inspecting` without origin). one expanded choice group at a time; the other remains discoverable. reviewing changes no reading state |
| recovery / accessibility designer | capture: `couldn't hold your reading spot. try again.`; target: `couldn't open that passage.`; return: `couldn't return to your spot. try again.`; stale source: `your reading spot is unavailable in this version.`; adoption: `couldn't use this reading position. try again.`. retry through the failed action; unavailable return stays disabled while valid adoption remains possible |

transient positioning failure retains enabled return for retry; confirmed missing
origin/source disables return while permitting adoption of a valid current place.
save failures retain existing sync treatment; do not imply adoption was undone.
clear stale errors only when superseded/resolved. disable adoption during
positioning; available return can supersede a pending jump. when an origin becomes
unavailable, compact copy becomes `reading spot unavailable · options`; announce
the change without expanding details or ending protection.

ordinary buttons, nonmodal group, separate polite announcement. do not steal focus
when status appears or repeat announcements on every scroll/jump. intentional
navigation moves assistive reading position to its destination; return restores
the actual occurrence or resolved semantic location. hide focuses the compact
control; expansion focuses its first action; adoption focuses current reading.
wrap at narrow widths/zoom without obscuring prose, selection handles or focus.
no timeout, close `x`, hover-only action, or duplicate reader return toast.

## non-overlapping implementation packages

paths are under `apps/web/src`; one editor per file. a defines contracts first;
b/c can then work independently; d integrates; e challenges every phase. source
notes' route integrator consumes d after this cutover, never edits alongside it.

| owner / paired designer | exclusive files and responsibility |
|---|---|
| a: policy/progress / systems-content | new `lib/reader/useReaderNavigation.ts`; `lib/reader/{readerDocumentPosition,useReaderProgress,readerProgress,useDocumentReaderSession}.ts`; `app/(authenticated)/media/[id]/ReaderActivityAdapter.ts`. model, ordering, eligibility, remote/reset, duration-only activity |
| b: text/find/input / reading-accessibility | `components/reader/TextDocumentReader.tsx`; `lib/reader/{canonicalTextAnchor,epubInternalLinks,readerScrollInput,canonicalTextFindPresentation,paneScroll}.ts`; hosted `{useMediaPaneFind,useEpubPaneFind,transcriptPaneFind,mediaPaneFind}.ts`; `lib/panes/{usePaneFind,paneSearch}.ts` and necessary conversation/artifact find call sites. exact checkpoints, target/seek provenance, one reader-find return owner |
| c: pdf / document-accessibility | `components/{PdfReader.tsx,pdfReaderRuntime.ts,pdfPaneFind.ts}`; hosted `usePdfPaneFind.ts`. native destinations, loaded-source identity, geometry, cancellation and shared find integration; no vendor patch |
| d: integration/status / interaction-content | `MediaPaneBody.tsx`, `ReaderProgressHandoff.tsx`, `page.module.css`; `offline-reading/OfflineDocumentReader.tsx`; new `components/reader/ReaderNavigationStatus.tsx` and css; `ReaderDocumentMapDetail.tsx`. all host wiring, controls and old-owner deletion |
| e: acceptance/closure / independent content-accessibility | temporary probes/fixtures outside repository; this plan, relevant reader/workspace/epub module docs, tickets/register. verify actual behavior and hard-cut residue |

`hosted` means `app/(authenticated)/media/[id]`. b owns any required changes to
generic find return publication/chrome: `components/workspace/{PaneSearchBar,PaneShell}.tsx`,
`components/chat/useConversationPaneFind.ts` and
`app/(authenticated)/artifacts/[artifactRef]/artifactPaneFind.ts`. d removes
reader-only duplication. request changes through the assigned owner.

## hard cutover

delete `mediaFindPreviewLease.ts`, map/offline origin-policy duplicates,
`documentMapPositioningRef`, input/inspector-close adoption, reader-find origin
stores, `EpubRenderedFragmentOverride`'s separate adoption lifecycle,
`awaitingEpubFindAdoptionRef`, `epubAdoptionCaptureSuppressionRef`, and replaced
next-capture flags. move useful rendering/geometry into current adapters first.
remove direct pdf link bypasses, seek-as-reading branches, duplicate reader return
controls, dead props/imports/css. retain current async source loading, generic
non-reader find and platform progress transports. no flags, aliases, dual paths,
compatibility decoding or guessed-position fallback.

update web and offline bundles through their existing build/release paths;
reload clients. no migration; rollback is the previous build. anchor/data repairs
retain their separate source-owner migration/backup requirements.

## acceptance: temporary red / green / refactor / delete

the owner's request authorizes temporary executable live tests. `./scripts/test`
and ci remain static-only. three normally imported documents suffice: anchored
article, cross-chapter epub with repeated references, pdf with native links.
use isolated real services/auth and task-owned data; observe browser writes,
authenticated product reads and read-only database/native state where needed.
transport delay/disconnection is permitted; substituted responses, auth bypasses,
test-only product hooks and mocked adapters are not.

| case | required result |
|---|---|
| n1: targets | one round trip per format; distribute scoped inputs across fixtures. exact source/focus return; no-op/missing target has no false arrival; actual article ingestion preserves anchors. smoke transcript find with unchanged playback and each modified non-reader find consumer |
| n2: lifetime | `a → note b → c`, scroll/select, close inspector/find, hide, wait beyond chrome timers, background/foreground. origin survives; compact return remains reachable; actual-opener backlink returns, other backlink does not |
| n3: races/geometry | supersede delayed load, interrupt return, disconnect, change typography/viewport and pdf zoom/rotation. failed `a → b → c` after movement restores `b`, retains origin `a`; user cancellation keeps actual view. only current arrival settles; unchanged-layout round trips within 1px; changed source never guesses |
| n4: adoption/entry | failed/busy adoption retains protection; successful adoption saves exact destination, including existing completion near 95%. ordinary traversal/chapter continuation saves; reload resumes saved spot; deep links with/without saved progress follow the contract |
| n5: concurrency/activity | two real sessions; remote progress cannot seize inspection. exercise accept/keep, earlier pending save and save failure/retry. preserve revisions; no detour cursor/cross-jump span. input meeting existing activity rules records a duration-only interval with absent progress/word endpoints |
| n6: android offline | installed identified artifact, real download, offline internal links/return/adoption, background/reopen and reconnect; no detour enters native pending progress; legitimate adoption syncs. cover each supported offline format |

overlay keyboard/screen-reader, narrow/zoomed layout, touch and keyboard-obstruction
checks on n1/n2/n6. desktop emulation is not device proof. compare locator writes,
maximum progress, completion facts, remaining-time and activity endpoints after
settling or identifying pre-departure writes; unchanged revision alone is not the
invariant.

1. **red:** independent review attacks contracts, designer examples and assertions;
   prove setup works, then record baseline target failures. setup failure is
   blocked, not red; already-correct behavior may pass.
2. **green:** implement by owner; replay identical probes and `./scripts/test`.
   designers inspect rendering/content; reviewers challenge persistence and races.
3. **refactor:** resolve ownership, duplication, dead-code and correctness
   objections; replay affected journeys and static checks after changes.
4. **delete:** only after acceptance passes, remove owned probes/dependencies,
   imported fixtures and temporary credentials. retain concise baseline/final sha
   (plus relevant dirty-patch hash), source/publication identities, commands and
   outcomes; android adds apk sha256, installed version/device and nonsecret
   account identity. run final `./scripts/test`; preserve unrelated local state.

done requires n1–n6 and manual design/accessibility checks passing, review objections
resolved, retired code/tests absent and module docs current. delete only tickets
proven resolved: the five navigation tickets linked from the council, plus return
drift/find-supersession when verified. outside-scope findings get individual tickets;
blocked dependencies are never reported as passes.

costs: explicit adoption adds an action, including first targeted entry; hiding
adds a disclosure step; one origin omits intermediate history; restart loses the
detour; adoption retains position-based completion; inspection omits word-speed
statistics; natural scrolling is not proven reading; deleting tests relinquishes
ongoing regression detection. no additional product decision is pending.

## execution, 2026-09-26

baseline `47d7448c790e0eddac0378f41dceabf58577c322`; isolated auth,
postgres/minio, api, web, worker and an identified android emulator. temporary
probes and fixtures live under `/tmp/nexus-reader-navigation-live`, outside the
repository. red probes exposed jump-progress writes, find ownership races,
pdf link bypasses, and terminal capture failure; green/refactor replayed the
same journeys. `./scripts/test` passes after the final web/python changes.

| case | observed state |
|---|---|
| n1 | article, epub, pdf, transcript round trips pass. new normally uploaded article `01a0e0e4-bf52-7fb1-9459-3f181385677e` retains authored heading, named target, labelled container and same-document links; actual backlink returns, other backlink stays inspection. native pdf `XYZ`, `Fit`, `FitH`, `FitV`, `FitR` and null-coordinate links passed live geometry/focus checks; related variants were checked statically. generic conversation/artifact find is blocked and `NOT_RUN`: isolated codex host/catalog absent; [ticket](tickets/generic-pane-find-live-acceptance-blocked.md) |
| n2 | held origin survived multi-hop, scroll, hide, timeout wait, inspector/find closure and background/foreground; compact action stayed reachable |
| n3 | delayed/superseded moves, interruption, disconnect, responsive text reflow, pdf zoom/rotation and exact unchanged-layout return passed. normal same-source refresh advanced article generation 1→2; mounted inspection stayed on its loaded source, reload cleared it without a cursor write. changed-byte return remains unverified because the refreshed immutable source had the same bytes, while the saved cursor still references the removed fragment and prevents fresh rendering; [ticket](tickets/web-publication-invalidates-saved-reader-cursors.md) |
| n4 | saved and empty-entry deep links, exact adoption, failed retry, reload, sequential continuation and terminal `finished` at progression 1 passed |
| n5 | two sessions, accept/keep, pending save, failure/retry, revision ordering and duration-only activity with absent progress/word endpoints passed |
| n6 | final apk sha256 `b13c1d0bf76e38f733f89b7633689abb475842d75aecb1e7894e34a2490e9256` installed byte-identically on emulator-5560 before and after an avd restart. fresh article authored note/backlink and explicit return pass within 0.381px, with no note destination pending; epub and pdf link/return/adopt/reopen pass on the same apk. reconnect cleared native pending rows; authenticated server holds exact article Opening at revision 1, epub note at revision 29 and pdf page 3 at revision 6. earlier apk `2cdaa371365b91ea623f86f4748dd1abb434acc663e9b0d836ec45a953cc0118` is superseded because its article `#` link bypassed inspection. final-apk spoken output remains [unverified](tickets/reader-navigation-talkback-spoken-announcement-unverified.md); first offline-to-hosted deep link had an [unexplained transient boundary](tickets/android-offline-to-hosted-deep-link-transient-boundary.md) |

keyboard and narrow-layout checks pass. talkback's accessibility tree and action
activation pass; spoken announcement output was not recorded. final acceptance,
temporary-probe deletion and source repair remain open until the stated gaps are
closed. the separate worker-image local url-ingest defect has its own
[ticket](tickets/local-worker-image-misses-local-node-ingest-path.md).
nonsecret live receipts remain under `/tmp/nexus-reader-navigation-live/`,
including `source-replacement-receipt.json` and
`final-android-article-fix-receipt.md`; temporary probes and credentials remain
because the blocked generic-find gate prevents the requested delete phase.
