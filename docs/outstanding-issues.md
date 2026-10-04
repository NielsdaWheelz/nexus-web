# Outstanding Issues & Follow-ups

A register of **open code-level work** — issues found but left out of scope, bugs,
refactors deferred because they were too much churn, and things that warrant a
closer look later. **Add entries as they surface; delete them once resolved (record
the fix in the commit/PR). This doc tracks only outstanding work, never history.**

It is **not** a checklist for routine static or manual verification, release
process (commit / PR / merge), or already-settled design decisions
— those belong in CI, the PR, or the relevant spec/memory.

The register is repo-wide: tag each entry with an `area`.

## How to add / update an entry

- Copy the template below, give it the next free `OI-NNN`, append it under `Open`.
- **Statuses:** `OPEN` (actionable now) · `DEFERRED` (blocked on a decision or
  another change).
- Keep the one-line metadata: `area · opened YYYY-MM-DD by <name/agent> · P0–P3`
  (P0 = ships-blocking, P3 = nice-to-have).
- When an entry is resolved, **delete it** — record the fix in the commit/PR.

```
### [OPEN] OI-000 — <short title>
area · opened YYYY-MM-DD by <who> · P2
<the code issue / bug / investigation, why it matters, and how to resolve>
```

---

## Open
- [open] epub / navigation · 2026-10-04 source review · a publisher href-based section id may retire when its point becomes note content; qualify the unobserved saved-location case before the rearnote alias release: [ticket](tickets/epub-publisher-href-loc-retirement-on-note-promotion.md).


- [open] operator credentials · 2026-10-02 cleanup workflow · skid's three peer bearer fields were printed into a tool transcript; coordinate rotation with active sessions: [ticket](tickets/local-qualification-credential-transcript-exposure.md).
- [open] processing recovery / release · 2026-09-28 pr #387 investigation · the keats normalizations and gutenberg correction never ran in production (commands are unreleased); run them after the release, then land #387: [ticket](tickets/processing-repairs-await-release-then-387.md).
- [open] release / production · 2026-09-28 cleanup campaign · production remains 7dc68929b/0241; frozen bcb86e/0257 preparation is green, pending fresh drained backup/actual restore/source review, loss approval and aligned release; saved-item repair remains reserved: [ticket](tickets/production-release-pending-since-7dc68929b.md) · [github #483](https://github.com/NielsdaWheelz/nexus-web/issues/483).
- [open] resource sharing / production migration · 2026-09-28 resource-sharing reauthoring · run 0249's malformed/duplicate `resource_grants` count read-only against production before deploy: [ticket](tickets/resource-grants-0249-production-preflight.md).
- [deferred] resource sharing / sealed handles · 2026-09-28 resource-sharing reauthoring · owner call: keep `nxps1_`/`nxpa1_` byte-stable across deploys, or scope them to the open tab: [ticket](tickets/public-sealed-handle-codec-stability-decision.md).
- [deferred] resource sharing / public reader · 2026-09-28 resource-sharing reauthoring · owner call: public PDF bytes keep streaming through the api, or move to signed storage urls: [ticket](tickets/public-pdf-signed-url-decision.md).
- [open] resource sharing / share overlay web · 2026-09-28 resource-sharing review · the Native and X bearer-link triggers stay enabled while another change is in flight: [ticket](tickets/share-overlay-bearer-warning-triggers-ignore-busy.md).
- [open] web / python comments · 2026-09-28 pr-06 library placement · 25 code comments cite deleted `docs/cutovers/` files as rule owners: [ticket](tickets/code-comments-cite-deleted-cutovers.md).
- [open] ingest-imports web · 2026-09-28 pr-06 library placement · Add Content still rereads and decides settlement-unknown placement writes and publishes the bus by hand, where the overlay now resends: [ticket](tickets/add-content-placement-unknown-machine.md).
- [deferred] lectern / typed wire · 2026-10-04 reduction source audit · web HTTP success paths rebuild owned output DTOs; retain native descriptor and listening-domain converters: [ticket](tickets/lectern-http-responses-rebuild-owned-wire.md).
- [open] epub reads · 2026-10-04 structural source audit · the ordinal source wrapper has no tracked caller; retain the shared list and authorized reader: [ticket](tickets/epub-source-ordinal-wrapper-has-no-caller.md).
- [open] oracle rest · 2026-10-04 pr #499 follow-up · browser bounds count utf-16 units instead of canonical code points: [ticket](tickets/oracle-rest-string-bounds-count-different-units.md).
- [deferred] oracle rest · 2026-10-04 pr #499 follow-up · outer readers rebuild existing named outputs; all-source gain is unmeasured: [ticket](tickets/oracle-rest-readers-repeat-owned-outputs.md).
- [open] jobs / documentation · 2026-10-04 backend owner audit · the jobs module still describes retired chat result kinds and a media-unit failed-result declaration absent from the registry: [ticket](tickets/jobs-handler-outcome-docs-stale.md).
- [open] jobs / child result · 2026-10-04 backend owner audit · child success/reschedule/terminal-failure variants duplicate the handler result contract before worker settlement: [ticket](tickets/jobs-child-results-repeat-handler-contract.md).
- [open] library governance / web · 2026-10-04 frontend source audit · failed role command feedback does not use the authoritative reread; actual user-visible ambiguity needs diagnosis: [ticket](tickets/library-role-feedback-needs-outcome-qualification.md).
- [open] library governance / web · 2026-10-04 source audit · caught 401 errors in search, load-more and command paths miss the existing auth handoff and reach render-defect handling: [ticket](tickets/library-governance-unauthenticated-errors-render-as-defects.md).
- [open] wikisource / article apparatus · 2026-10-04 native baseline · `On Liberty/Chapter 2` retains note links but yields zero bound note items; the exact loss point needs qualification: [ticket](tickets/wikisource-note-links-unbound-after-extraction.md).
- [open] epub / apparatus extraction · 2026-10-04 native baseline · official gutenberg 34901's plain inline footnote anchors yield zero reader apparatus items: [ticket](tickets/gutenberg-inline-footnotes-not-classified.md).
- [open] epub / apparatus extraction · 2026-10-04 native baseline · official idpf wasteland's declared `rearnote` bodies yield zero reader apparatus items: [ticket](tickets/epub-rearnote-bodies-not-classified.md).
- [open] hosted reader / web · 2026-10-04 source audit · the pane recomputes epub/web fragment position data already owned by its document structure; web content/navigation timing needs qualification: [ticket](tickets/media-pane-repeats-document-fragment-position-work.md).
- [open] resonance / arrival slate · 2026-10-04 source audit · sql admission and final ranking use different arrival comparators; determine whether the coarse cap is intentional: [ticket](tickets/slate-arrival-cap-disagrees-with-final-order.md).
- [open] collections / offline audio · 2026-09-27 cleanup pr 01 · episode rows lost download status in #385; CollectionRow's localAvailability path is dead until restored or deleted: [ticket](tickets/media-rows-lost-offline-download-status.md).
- [open] android / offline-hosted handoff · 2026-09-26 reader navigation acceptance · shelf-to-hosted bootstrap can fail in mobile viewport and leave a late bridge reply; cold restart recovers: [ticket](tickets/android-offline-to-hosted-deep-link-transient-boundary.md).
- [open] reader / accessibility · 2026-09-26 reader navigation acceptance · talkback exposed the held-position live region, but its spoken words could not be independently observed: [ticket](tickets/reader-navigation-talkback-spoken-announcement-unverified.md).
- [blocked] conversation and artifact find / live acceptance · 2026-09-26 reader navigation acceptance · the isolated generation catalog needs an unavailable codex host, so no ordinary chat or dossier exists: [ticket](tickets/generic-pane-find-live-acceptance-blocked.md).
- [open] collection controls / live verification · 2026-09-25 pane-controls implementation · 26/30 live checks pass; search/podcast prerequisites and device/accessibility cases remain blocked or not run: [ticket](tickets/pane-controls-live-proof-blocked.md).
- [open] podcast publisher transcript · 2026-09-26 reader acceptance · configured discovery through publisher transcript read/find remains unqualified: [ticket](tickets/podcast-publisher-transcript-journey-unqualified.md).
- [open] android offline reading · 2026-09-26 source-note implementation · authored note links work, but downloaded readers lack aligned evidence inspection: [ticket](tickets/offline-reader-lacks-source-apparatus-inspection.md).
- [open] reader / find · 2026-09-24 reader-inspector-controls · epub find previews wait without a fragment-failure signal: [ticket](tickets/epub-find-preview-has-no-fragment-failure-signal.md).
- [open] reader / find · 2026-09-24 reader-inspector-controls · web and transcript find keep a render frame budget: [ticket](tickets/web-and-transcript-find-render-budget.md).
- [open] reader / inspector · 2026-09-24 reader-inspector-controls · reload open on Contents briefly shows Evidence: [ticket](tickets/reader-contents-publishes-after-navigation.md).
- [open] reader / apparatus · 2026-09-26 reader chapter repair · newly inferred notes in preserved legacy html lack inline marker activation: [ticket](tickets/reader-repaired-note-markers-not-inline.md).
- [open] epub / sections · 2026-09-26 chapter implementation · ambiguous pillow frontmatter headings still become routine stops: [ticket](tickets/epub-contents-union-overpromotes-source-headings.md).
- [open] reader / production · 2026-09-27 release preflight · four exact ready books need source-byte proof and fenced 0243 repair before the deferred cutover: [ticket](tickets/reader-chapter-production-correspondence-unverified.md).
- [open] reader / production migration · 2026-09-27 source-note integration review · confirm every apparatus media has a publication before applying 0245: [ticket](tickets/reader-source-body-production-publication-preflight.md).
- [open] reader / production repair · 2026-09-27 pr #398 acceptance · 234 source-note publication changes remain clone-only: [ticket](tickets/reader-source-notes-production-repair-pending.md).
- [open] reader / evidence delivery · 2026-09-27 pr #398 browser acceptance · 7–10 mb document maps need production transfer and phone latency proof: [ticket](tickets/reader-document-map-large-transfer-unverified.md).
- [open] epub / retained reader content · 2026-09-27 source-note integration review · authored inline text is reordered in a retained note and needs an identity-safe repair: [ticket](tickets/epub-retained-inline-text-order-differs-from-source.md).
- [open] epub / historical repair · 2026-09-27 corpus census · 17 source/retained text or href mismatches need full retained-coordinate replay: [ticket](tickets/reader-epub-source-correspondence-drift.md).
- [open] epub / target identity · 2026-09-27 corpus census · seven source-only anchors need relevance classification before repair: [ticket](tickets/reader-epub-source-only-anchors.md).
- [open] epub / apparatus · 2026-09-27 corpus census · one old note body cannot be proved for preservation: [ticket](tickets/reader-epub-old-apparatus-body-unproved.md).
- [deferred] epub / apparatus · 2026-09-27 pr #398 review · row 232's second false backlink awaits a deletion-scope decision: [ticket](tickets/reader-epub-row232-backlink-classification.md).
- [open] epub / parser bound · 2026-09-27 corpus census · two backlink indexes exceed the bounded extractor: [ticket](tickets/reader-epub-backlink-index-exhaustion.md).
- [open] api / operations · 2026-09-27 release preflight · a read-only live source-hash probe exited 137 and restarted the api once: [ticket](tickets/live-api-source-hash-probe-restarted-container.md).
- [open] reader / selection · 2026-09-24 reader-inspector-controls · retained selection geometry ignores a canonical reset: [ticket](tickets/retained-selection-geometry-ignores-canonical-reset.md).
- [open] workspace / geometry · 2026-09-24 reader-inspector-controls · pdf inspector overflows the viewport at the pane minimum: [ticket](tickets/pdf-inspector-overflows-viewport-at-pane-minimum.md).
- [open] workspace / copy · 2026-09-24 reader-inspector-controls · secondary tab close label case differs from pane close: [ticket](tickets/secondary-tab-close-label-case.md).
- [open] epub ingest · 2026-09-26 fragment-only nav fix review · unsafe authored nav hrefs lack source issues: [ticket](tickets/epub-unsafe-nav-targets-have-no-source-issue.md).
- [open] worker / indexing · 2026-09-24 reader-inspector-controls · a missing indexing credential is classified as a child defect: [ticket](tickets/indexing-without-credential-is-a-child-defect.md).
- [open] android offline reading · 2026-09-24 reader-inspector-controls · back from the downloaded reader shows Not found: [ticket](tickets/android-back-from-downloaded-reader-shows-not-found.md).
- [open] local development · 2026-09-24 reader-inspector-controls · worker overlay memory bound fails the lane check: [ticket](tickets/local-worker-overlay-memory-bound-fails-lane-check.md).
- [open] reader / inspector contract · 2026-09-25 article-contents review · empty contents is published despite the documented toc-node availability condition: [ticket](tickets/reader-empty-contents-availability-contract.md).
- [open] reader / epub routing · 2026-09-25 article-section-navigation acceptance · Return restores chapter IX while pane href retains the chapter XI `loc`: [ticket](tickets/epub-map-return-keeps-jump-loc.md).
- [open] workspace / deep links · 2026-09-25 article-section-navigation acceptance · a full-page article deep link can revert to the restored EPUB pane during bootstrap: [ticket](tickets/workspace-deep-link-reverts-during-reader-jump.md).
- [open] android / local auth · 2026-09-25 article-section-navigation acceptance · isolated Next dev login showed an unattributed JSON.parse overlay; standalone login passed: [ticket](tickets/android-isolated-login-dev-overlay.md).
- [open] android / local startup · 2026-09-25 article-section-navigation acceptance · isolated standalone redirects unauthenticated 127 root to localhost; authenticated cold launch works: [ticket](tickets/android-isolated-root-redirect-blank.md).
- [open] offline reader / presentation · 2026-09-25 article-section-navigation device check · offline csp blocks the canvas grain data svg: [ticket](tickets/offline-reader-csp-blocks-canvas-grain.md).
- [open] chat / layout · 2026-09-25 article-section-navigation integrated build · generation picker `end` alignment emits an autoprefixer support warning: [ticket](tickets/chat-generation-picker-flex-end-build-warning.md).
- [open] android / test hygiene · 2026-09-25 article-section-navigation device check · the apk and network were restored but pretest auth identity was not captured, so final account identity is unverified: [ticket](tickets/android-device-auth-baseline-not-captured.md).
- [open] reader / workspace docs · 2026-09-25 article-section-navigation final review · reader and workspace modules cite deleted cutover contracts: [ticket](tickets/reader-workspace-docs-reference-deleted-cutovers.md).
- [open] android / workspace · 2026-09-22 device verification · an intermediate compatibility probe showed an unproven transient bootstrap failure on reconnect: [ticket](tickets/android-reconnect-transient-workspace-bootstrap.md).
- [open] collection docs · 2026-09-21 council · library and lectern contracts still point to deleted cutovers: [ticket](tickets/collection-contract-docs-reference-deleted-cutovers.md).

### [OPEN] OI-005 — The Imports upload retry guard cannot check the file's size
frontend · opened 2026-09-08 by Claude (imports cutover, Track E) · P3
`ImportItem` carries no upload size, so a same-named file of a different size is
now refused by the server after its bytes are sent instead of by the browser
before. See
[docs/tickets/imports-upload-retry-cannot-check-the-file-size.md](tickets/imports-upload-retry-cannot-check-the-file-size.md).

### [OPEN] OI-012 — Import history collapses three queue execution codes
backend · opened 2026-09-08 by Claude (imports cutover, Track A) · P3
`queue_failure_code` maps three distinct queue execution codes onto
`E_WORKER_HANDLER_FAILED`, which costs the inspector precision it could keep. See
[docs/tickets/import-history-collapses-three-queue-execution-codes.md](tickets/import-history-collapses-three-queue-execution-codes.md).

### [OPEN] OI-013 — `E_PDF_TEXT_UNAVAILABLE` is a catalogued code that names no failure
backend · opened 2026-09-08 by Claude (imports cutover, Track A) · P3
The safe-code catalog carries a PDF text warning as if it were a failure; the
browser copy is corrected, but warnings still share the failure vocabulary. See
[docs/tickets/import-history-pdf-text-warning-is-not-a-failure.md](tickets/import-history-pdf-text-warning-is-not-a-failure.md).

### [OPEN] OI-023 — X-post quote completion defects when its ingest job is not running
backend · opened 2026-09-08 by Claude (imports cutover, Track B) · P2
A pre-existing defect surfaced while fixing the completion's lock cycle: quote
completion raises when its ingest job is not running. See
[docs/tickets/x-quote-completion-defects-when-its-ingest-job-is-not-running.md](tickets/x-quote-completion-defects-when-its-ingest-job-is-not-running.md).

### [OPEN] OI-030 — the source-refusal sentence duplicates browser copy
backend · opened 2026-09-09 by Claude (imports cutover, Track C2) · P3
The repairable-state refusal in `media_source_ingest.py` now repeats, word for
word, the copy `mediaErrorMessage.ts` composes from the action catalog; make the
server message diagnostic to remove that duplicate responsibility. See
[docs/tickets/server-refusal-copy-duplicates-the-browser-owner-with-no-mirror.md](tickets/server-refusal-copy-duplicates-the-browser-owner-with-no-mirror.md).

### [OPEN] OI-031 — The counted unit recorded at a source failure is free text on the wire
frontend · opened 2026-09-09 by Claude (imports cutover, Track E) · P3
`SourceFailureProgress.unit` is `Presence[str]` while the live progress schema
carries the same column as `Literal["Page", "Chapter"]`, so the copy owner
lowercases the recorded unit instead of matching it exhaustively. See
[docs/tickets/history-failure-progress-unit-is-free-text-on-the-wire.md](tickets/history-failure-progress-unit-is-free-text-on-the-wire.md).

### [OPEN] OI-035 — The Imports summary counts a row its own page read would reject
backend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain P) · P3
Every Imports defect check is now per row in `_item`/`_state`, and
`read_import_summary` materializes no row, so the badge is computed from a state
no owner transition produces. See
[docs/tickets/imports-summary-read-cannot-see-a-per-row-defect.md](tickets/imports-summary-read-cannot-see-a-per-row-defect.md).

### [OPEN] OI-036 — The Imports Reason filter's X options read as a placeholder
frontend · opened 2026-09-09 by Claude (imports cutover, D15 visual review) · P3
Five of the 46 alphabetised Reason options begin with a bare `X`, which in a flat
menu reads as an unsubstituted template variable rather than the platform name;
the row and inspector copy, where the source is on screen, reads correctly. See
[docs/tickets/imports-reason-filter-x-options-read-as-a-placeholder.md](tickets/imports-reason-filter-x-options-read-as-a-placeholder.md).

### [OPEN] OI-043 — The collapsed count chip scales out of its fixed-width rail
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2) · P3
The collapsed rail is fixed px while the count chip anchored inside it is sized
in rem, so a large document root font size grows the chip past the rail's left
edge, which clips it; the proof measures the default root only. See
[docs/tickets/collapsed-count-chip-scales-out-of-its-fixed-width-rail.md](tickets/collapsed-count-chip-scales-out-of-its-fixed-width-rail.md).

### [OPEN] OI-045 — The collapsed rail's count capture has no reviewer verdict
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2 re-review) · P3
Successor to OI-032. The D15 journey run records the post-fix capture
(`F-imports-review-6/rail-badge-collapsed.png`), so the capture clause is met;
the D15 collapsed-rail gate stays `not_run` until the visual reviewer reads it. See
[docs/tickets/collapsed-rail-count-has-no-recorded-review-capture.md](tickets/collapsed-rail-count-has-no-recorded-review-capture.md).

### [OPEN] OI-047 — `Pill`'s danger and accent tones fail AA contrast against their own fill
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W4) · P2
`.toneDanger` and `.toneAccent` still paint their text in the tone over an 18%
mix of the same tone, measuring 3.07:1 to 4.16:1 against their own fill — below
WCAG AA for text at `--text-xs`. The info, success and warning tones were fixed
with per-palette `--*-ink` steps in Phase 7 chain Z; these two are painted only
by surfaces outside the imports cutover's ownership. See
[docs/tickets/pill-tone-text-fails-aa-contrast-against-its-own-fill.md](tickets/pill-tone-text-fails-aa-contrast-against-its-own-fill.md).

### [OPEN] OI-048 — The mobile Imports entry has no D15 capture
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W4) · P3
Contract D9's mobile entry — the shared `AccountMenu` item `Imports` with its
`Pill` badge — is captured in no D15 artifact set, so the visual gate reads it
from the browser proof alone. See
[docs/tickets/mobile-imports-entry-has-no-d15-capture.md](tickets/mobile-imports-entry-has-no-d15-capture.md).

### [OPEN] OI-050 — Four rules outside `Pill` paint a tone as text over its own tint
frontend · opened 2026-09-10 by Claude (imports cutover, Phase 7 chain Z review) · P2
`.mismatchBanner` and `.partialCoverageWarning` (media pane) and `.error`
(`PdfReader`) paint `--warning` / `--danger` over a 10% mix of the same token and
measure 4.20:1 to 4.47:1 on their worst ground — under WCAG AA for `--text-sm`
body copy. Sibling of OI-047, which owns the two remaining `Pill` tones. See
[docs/tickets/tone-text-on-its-own-tint-fails-aa-outside-pill.md](tickets/tone-text-on-its-own-tint-fails-aa-outside-pill.md).

### [OPEN] OI-053 — durable activity storage needs a browser check
frontend · opened 2026-09-10 by Claude (imports cutover, Phase 7 chain Z2) · P2
the removed browser suite observed missing durable writes in its linux
container. manually distinguish a product storage defect from a runner-only
capability problem. See
[docs/tickets/durable-activity-outbox-suite-fails-in-the-imports-runner.md](tickets/durable-activity-outbox-suite-fails-in-the-imports-runner.md).

### [OPEN] OI-054 — Docker Desktop VM crashes block trustworthy database/process verification
infrastructure · opened 2026-09-09 by Claude (shared-kernel worktree) · P1
Docker Desktop's Apple Virtualization VM stops with `VZErrorInternal` during
verification; recover the shared engine, then clean only owned interrupted
resources and repeat the blocked checks. See
[docs/tickets/docker-desktop-virtualization-crash.md](tickets/docker-desktop-virtualization-crash.md).

### [OPEN] OI-055 — supervisor imports retain unexplained memory growth
backend · opened 2026-09-10 by Claude (imports cutover, Phase 9) · P2
the imports cutover fixed a large import leak but left 4 mib of additional
retention unexamined. inspect current supervisor imports and explain or remove
avoidable coupling; the old automated memory gate is retired. See
[docs/tickets/supervisor-residency-limit-hides-import-growth.md](tickets/supervisor-residency-limit-hides-import-growth.md).

### [OPEN] OI-060 — Production synapse scans repeatedly time out
background jobs / semantic search · opened 2026-09-11 by Codex (production deployment) · P1
The production background worker repeatedly records PostgreSQL statement
timeouts while scanning synapses, leaving inherited work pending. Deploy the
current execution cutover, then prove the backlog converges without new
unexpected timeouts. See
[docs/tickets/production-synapse-scan-statement-timeout-backlog.md](tickets/production-synapse-scan-statement-timeout-backlog.md).

- [open] oi-069 · reader interaction · 2026-09-22 acceptance · bounded android touch passed; spoken screen-reader and downloaded-map operator review remain: [ticket](tickets/reader-map-inert-position-and-mobile-controls.md).
- [open] oi-075 · epub ingest · 2026-09-12 source review · decoded reserved delimiters make stored source urls ambiguous: [ticket](tickets/epub-normalized-href-reserved-delimiters.md).
- [open] oi-076 · import progress · 2026-09-12 source review · extraction progress calls spine files chapters: [ticket](tickets/epub-import-progress-counts-files-as-chapters.md).
- [open] oi-078 · web build · 2026-09-12 offline artifact · css minifier warns on existing custom-highlight syntax: [ticket](tickets/offline-css-minifier-rejects-highlight-syntax.md).
- [open] oi-080 · web ingest · 2026-09-12 source review · new imports retain authored anchors; older stored imports still need source-evidenced repair and cursor reconciliation: [ticket](tickets/web-ingest-replaces-authored-heading-anchors.md).
- [open] oi-085 · epub extraction · 2026-09-12 memory review · utf-8 output caps do not bound retained unicode string memory: [ticket](tickets/epub-utf8-output-cap-does-not-bound-resident-text.md).
- [open] oi-087 · ci actions · 2026-09-12 reader publication · the pinned buildx action targets a deprecated node runtime: [ticket](tickets/ci-buildx-action-deprecated-node-runtime.md).
- [open] client telemetry malformed json · 2026-09-17 telemetry cleanup · malformed beacons return an unstructured 500 before authentication or backend validation: [ticket](tickets/client-defect-telemetry-malformed-json-returns-500.md).

- [open] resource actions · 2026-09-14 highlight popup verification · manual follow-up must distinguish a mobile navigation defect from the removed journey's readiness race: [ticket](tickets/resource-action-parity-mobile-pane-readiness.md).
- [open] agent tools · 2026-09-14 pr #246 memory review · resource reads load full bodies before enforcing their output limit: [ticket](tickets/resource-reader-loads-full-body-before-limit.md).
- [open] oi-109 · local s3 development · 2026-09-15 pr #255 qualification · p2 · the pinned minio image pull failed on the devbox; establish supported access and prove a fresh pull: [ticket](tickets/local-minio-image-pull-fails-on-devbox.md).
- [open] oi-111 · reader publication · 2026-09-15 restoration rehearsal · p2 · web replacement can retain a cursor for a deleted fragment: [ticket](tickets/web-publication-invalidates-saved-reader-cursors.md).
- [open] oi-113 · interactive worker · 2026-09-15 pr #255 qualification · p2 · exact-image startup is oom-killed at 256 mib; isolate provider imports and qualify real execution demand: [ticket](tickets/interactive-worker-startup-reaches-memory-cap.md).

- [open] oi-115 · api availability · 2026-09-28 pr #412 · cold startup and saved reads passed without codex; catalog recovery on the merged tree remains unverified: [ticket](tickets/api-startup-requires-codex-catalog-availability.md).



- [open] oi-125 · epub assets · 2026-09-15 source review · p2 · complete asset bodies, broad media reads and per-request storage clients lack an aggregate allocation budget: [ticket](tickets/epub-asset-response-allocation-and-client-lifetime.md).
- [open] oi-126 · backend publication · 2026-09-15 restoration release · p2 · disk exhaustion aborts the runner before bundle upload and cleanup: [ticket](tickets/backend-publication-can-exhaust-devbox-disk.md).
- [open] oi-127 · devbox operations · 2026-09-15 memory diagnosis · p2 · runner stopped and user/docker services restarted during diagnosis; cause remains unresolved: [ticket](tickets/devbox-services-interrupted-memory-diagnosis.md).
- [open] oi-128 · generation · 2026-09-15 ecbe manual check · p2 · deployed codex chat failed with invalid_request; isolated shell success has not closed the production incident: [ticket](tickets/restored-chat-codex-dispatch-fails.md).
- [open] chat cancellation · 2026-09-28 pr #412 · safe dead-state settlement passed on the candidate; merged-tree native interrupt/drain remains unverified: [ticket](tickets/chat-cancel-requeues-uncertain-dead-job.md).
- [open] chat browser · 2026-09-28 pr #412 · run-owned stop passed targeted proof; merged-tree new/existing reply and reload journey remain unverified: [ticket](tickets/chat-composer-loses-durable-stop-state.md).
- [open] chat release · 2026-09-28 pr #412 · new exact chat decoder requires a matching backend before web promotion; production pairing unverified: [ticket](tickets/chat-contract-release-pairing.md).
- [open] chat recovery copy · 2026-09-28 pr #412 · copy changed; merged-tree terminal-defect browser journey remains unverified: [ticket](tickets/chat-operator-defect-copy-invites-new-command.md).
- [open] chat incident · 2026-09-25 report, reviewed 2026-09-27 · original pane crash has no initiating exception: [ticket](tickets/production-chat-pane-crash-unattributed.md).
- [open] model history cutover · 2026-09-27 combined-release plan · frozen bcb86e actual0241→0257 restore/undo and atomic refusal proofs are green; production 54 null parents/69 jobs/one orphan still await reviewed exact-id disposition: [ticket](tickets/model-history-cutover-blocked-by-uncertain-work.md) · [github #484](https://github.com/NielsdaWheelz/nexus-web/issues/484).
- [open] model history cutover / media enrichment · 2026-09-27 production census · fresh census has 52 uncertain media parents and 56 dead metadata jobs; reviewed production disposition and new enrichment remain: [ticket](tickets/model-cutover-dead-media-generations.md).
- [open] codex host diagnostics · 2026-09-28 pr #412 · bounded first-cause log passed a local probe; merged-tree native-to-caller journey remains unverified: [ticket](tickets/codex-host-original-failure-not-retained.md).
- [open] write undo · 2026-09-25 model cutover review · shared receipt transaction and note SIGKILL/retry proof pass; broader resource/background interruption coverage remains: [ticket](tickets/chat-write-undo-can-commit-before-completion-stamp.md).
- [waived] api model qualification · 2026-09-26 owner decision · 61 api cells pass; 4 xai cells lack a key and are not live-qualified: [ticket](tickets/latest-model-api-live-cells-unqualified.md).
- [open] codex credential refresh · 2026-09-25 model cutover · actual 0.157.1 refresh/write semantics were not witnessed: [ticket](tickets/codex-auth-refresh-not-qualified.md).
- [open] latest model end-to-end proof · 2026-09-25 model cutover · final permitted provider, codex shell and brave paths passed; background, lifecycle, auth-refresh and owner-blocked anthropic cells remain: [ticket](tickets/latest-model-end-to-end-qualification-incomplete.md).
- [open] codex background effects · 2026-09-27 shell qualification · a cited dossier ignored a persisted note-create instruction despite `CodexShell` authority: [ticket](tickets/codex-background-write-instruction-ignored.md).
- [deferred] anthropic nexus cells · 2026-09-27 owner decision · 20 browser/api/worker cells remain blocked by the retention decision: [ticket](tickets/anthropic-nexus-live-cells-owner-blocked.md).
- [open] nexus url ingress · 2026-09-28 launcher rewrite review · `?nexus=1` returns after a reload via the SSR pane href: [ticket](tickets/nexus-url-ingress-reappears-after-reload.md).
- [open] daily page · 2026-09-28 launcher rewrite review · the Today editor drops focus ~150 ms after mobile Add to Today: [ticket](tickets/add-to-today-editor-loses-focus.md).
- [open] nexus pane warm · 2026-09-28 launcher rewrite review · the first pane warm delays the active-row commit ~60 ms, so a fast Enter hits the previous row: [ticket](tickets/nexus-first-pane-warm-delays-active-row.md).
- [deferred] nexus history · 2026-09-28 launcher rewrite (F7, owner decision) · unused provenance/output retirement is unadopted; preserve creation time, eligibility and replay guards, with sequential-release quiescence undecided: [ticket](tickets/nexus-usage-provenance-columns-have-no-reader.md).
- [deferred] nexus url ingress · 2026-09-28 launcher rewrite (F10, owner decision) · `?nexus=1&intent=&action=` has no producer; delete or document it: [ticket](tickets/nexus-url-ingress-has-no-producer.md).
- [deferred] nexus rows · 2026-09-28 launcher rewrite (F13, owner decision) · the row projection branches on surface instead of leaving presentation to the shells: [ticket](tickets/nexus-row-projection-is-surface-aware.md).
- [deferred] nexus error policy · 2026-09-28 launcher rewrite (F19, owner decision) · an openables or `/search` defect or 500 replaces the whole workspace: [ticket](tickets/nexus-retrieval-defects-replace-the-workspace.md).
- [open] codex shell runtime · 2026-09-26 owner-approved redesign · shell/api chat proof passed; auth refresh, full lifecycle denials and twelve background roles remain unqualified: [ticket](tickets/codex-shell-runtime-unqualified.md).
- [open] oi-130 · synapse jobs · 2026-09-15 ecbe production observation · p2 · cancellation after lost admission claim requires an absent Prepared checkpoint: [ticket](tickets/synapse-cancellation-missing-prepared-checkpoint.md).
- [open] oi-131 · background memory · 2026-09-15 ecbe observation · p2 · retained peak447.902/448 mib leaves100 kib margin, without observed oom: [ticket](tickets/background-worker-production-memory-margin.md).

- [open] oi-132 · api observability · 2026-09-15 reader oom diagnosis · p2 · access logs label headers as completion and omit requests killed before headers: [ticket](tickets/api-request-logs-stop-at-response-headers.md).
- [open] oi-133 · dependency maintenance · 2026-09-15 pr #270 · p2 · integrate the isolated embedding import fix from published maintenance revisions into upstream main: [ticket](tickets/embedding-memory-maintenance-pins-need-upstream-integration.md).
- [open] oi-134 · search · 2026-09-15 pr #270 diagnosis · p1 · query fixes deployed; native and production search still exceeds the 30-second web deadline: [ticket](tickets/semantic-document-search-times-out-on-restored-corpus.md).
- [open] oi-135 · search memory · 2026-09-15 pr #270 review · p2 · selected result pages still retain complete fragment quotes without an aggregate byte bound: [ticket](tickets/search-result-pages-retain-full-fragment-quotes.md).
- [open] oi-136 · search performance · 2026-09-15 pr #270 diagnosis · p2 · semantic ranking still scans/sorts the embedding corpus and spills substantial temporary data: [ticket](tickets/semantic-ranking-still-scans-embedding-corpus.md).
- [open] oi-137 · api memory · 2026-09-16 utc pr #270 manual acceptance · p2 · paired readers stayed usable but reached the 320-mib cap; sustained margin remains unproved: [ticket](tickets/api-reader-search-memory-margin-remains-small.md).
- [open] oi-139 · codex host provisioning · 2026-09-16 retained pr #203 finding · p2 · encrypted-state formatting lacks a qualified memory bound and usable-keyslot check: [ticket](tickets/codex-state-luks-format-oom.md).

- [open] oi-161 · web panes · 2026-09-17 slop sweep · p3 · four pane bodies are oversized with no split that does not invent abstractions; re-measure after the dedupes land: [ticket](tickets/oversized-pane-bodies-have-no-obvious-split.md).
- [open] pdf passage positioning · 2026-09-17 passage cleanup · p2 · actual viewport verification is blocked by standalone renderer bootstrap: [ticket](tickets/pdf-passage-positioning-needs-browser-verification.md).
- [open] oi-167 · pdf highlights · 2026-09-17 typecheck cleanup · p2 · write-time matching combines cached text with current publication spans: [ticket](tickets/pdf-highlight-matching-mixes-publication-snapshots.md).
- [open] oi-170 · consumption activity · 2026-09-17 slop sweep · p3 · `clientMutationId` on activity uploads is a wire no-op held by the shipped android client: [ticket](tickets/activity-upload-client-mutation-id-is-a-wire-no-op.md).
- [open] oi-171 · appearance · 2026-09-18 owner decisions · p3 · Press and Study declare no color-scheme, so native controls and UA scrollbars follow the browser default: [ticket](tickets/press-and-study-leave-native-controls-on-the-ua-scheme.md).
- [open] secret scanning · 2026-09-18 pr #334 · gitguardian repeats an operator-classified false positive on a compose variable reference: [ticket](tickets/gitguardian-repeats-classified-variable-reference.md).
- [open] oi-175 · chat tool runtime · 2026-09-21 reauthoring · p3 · `tool_call_delta` is absent from current Python vocabulary but remains in the CHECK and browser path; removal needs one production owner preflight count: [ticket](tickets/tool-call-delta-event-has-no-producer.md).
- [open] oi-178 · dossiers · 2026-09-21 reauthoring · p2 · a recheck raising DossierInputTooLarge escapes the terminal writers and leaves a build active with no terminal: [ticket](tickets/dossier-recheck-can-raise-past-the-terminal-writer.md).

- [open] 2026-09-21 chat-database repair · chat worker runs synchronous database work on its execution loop: [ticket](tickets/chat-worker-database-work-runs-on-its-execution-loop.md).
- [open] 2026-09-21 cleanup audit · offline reading store retains unused construction modes: [ticket](tickets/cleanup-offline-reading-unused-construction-seams.md).
- [deferred] 2026-09-23 firefox v1 · the signed unlisted build needs AMO credentials and the production origins: [ticket](tickets/extension-firefox-distribution-consent-is-undeclared.md).
- [open] 2026-09-23 firefox v1 track a · remove the browser-capture conversion command after its production run: [ticket](tickets/remove-browser-capture-conversion-command.md).
- [open] 2026-09-21 auth audit · response cookie ownership is split between route clients and refresh: [ticket](tickets/auth-response-cookie-ownership-is-split.md).
- [open] 2026-09-21 auth audit · default android debug origin disagrees with bff csrf configuration: [ticket](tickets/android-debug-origin-disagrees-with-bff-csrf-origin.md).
- [open] 2026-09-21 auth audit · sdk fetch deadlines do not cover body reads or refresh retry/backoff: [ticket](tickets/supabase-operation-deadline-ends-at-response-headers.md).
- [open] 2026-09-25 local qualification · credential values appeared in an internal tool transcript; rotate outside the transcript's trust boundary: [ticket](tickets/local-qualification-credential-transcript-exposure.md).

- [open] 2026-09-26 processing review · 24 diagnosed imports still need individual owned recovery: [ticket](tickets/processing-backlog-needs-owned-recovery.md).
- [open] 2026-09-26 processing review · repeated ancestor-text scans exhaust the joyce epub parse budget: [ticket](tickets/epub-apparatus-prefix-scans-exhaust-parse-budget.md).
- [open] 2026-09-26 processing review · historical terminal codes prevent recovery after parser corrections: [ticket](tickets/processing-terminal-policy-blocks-corrected-parser-recovery.md).
- [open] 2026-09-26 processing review · missing images currently abort four epub imports: [ticket](tickets/epub-missing-images-abort-readable-books.md).
- [open] 2026-09-26 processing review · two stored keats publications need heading normalization before reindex: [ticket](tickets/old-web-publications-lack-index-heading-normalization.md).
- [open] 2026-09-26 processing review · historical gutenberg epub retry retains the wrong source adapter: [ticket](tickets/gutenberg-failed-import-retains-obsolete-web-adapter.md).
- [open] 2026-09-26 processing review · two historical note indexes still need owned recovery: [ticket](tickets/historical-note-index-failures-need-owned-recovery.md).
- [open] 2026-09-26 processing review · source acceptance can commit before runnable work is durable: [ticket](tickets/source-acceptance-can-commit-without-enqueued-work.md).
- [deferred] ingest reconciliation · 2026-10-03 source recheck · nonterminal semantic jobs can monopolize oldest-25 discovery; prior source/index paths are fixed, runtime NOT_RUN: [ticket](tickets/ingest-reconciler-dead-rows-can-starve-new-work.md).
- [open] 2026-09-26 processing review · transient storage errors are treated as permanent source loss: [ticket](tickets/storage-outage-is-misclassified-as-lost-source.md).
- [open] 2026-09-26 processing review · superseded oracle sources retain three unfiled failed media rows: [ticket](tickets/superseded-oracle-seeds-retain-unfiled-failed-media.md).
- [open] 2026-09-26 processing plan · publication lock upgrades can obstruct concurrent index settlement: [ticket](tickets/publication-lock-upgrade-can-block-index-settlement.md).
- [open] 2026-09-26 processing plan · epub reprocessing can replace fragment identities beneath reader state: [ticket](tickets/epub-reprocessing-can-replace-reader-fragment-identity.md).
- [open] 2026-09-26 processing implementation · artifact web acceptance can commit before its owning build result: [ticket](tickets/artifact-web-acceptance-commits-inside-build-transaction.md).
- [open] 2026-09-25 notes writing release preflight · census unsafe stored link hrefs on target data: [ticket](tickets/notes-writing-target-unsafe-links-census.md).
- [open] 2026-09-25 notes writing release preflight · census missing canonical body and links versions on target data: [ticket](tickets/notes-writing-target-missing-body-versions.md).
- [open] 2026-09-25 notes writing release preflight · checkpoint old browser drafts before removing readers: [ticket](tickets/notes-writing-legacy-draft-checkpoint.md).
- [open] 2026-09-25 notes writing acceptance · signed physical android w2 and optical input-to-visible-glyph w6 remain unverified: [ticket](tickets/notes-writing-android-acceptance-blocked.md).
- [deferred] 2026-09-26 notes bullets acceptance · physical android webview b7 is not run until the stacked prs are reviewable: [ticket](tickets/notes-bullets-android-acceptance-deferred.md).
- [open] 2026-09-27 epub apparatus identity · one note with distinct id/name aliases can become two target items with one dom stamp: [ticket](tickets/epub-note-id-name-alias-duplicates-target.md).
- [open] 2026-09-26 notes bullets cache review · non-note card labels lack a revision for ordering concurrent reads: [ticket](tickets/resource-surface-card-labels-have-no-revision.md).
- [open] 2026-09-25 notes writing live action probe · overlapping pdf highlight overlays block pointer access to a covered highlight: [ticket](tickets/pdf-overlapping-highlights-block-pointer-action.md).
- [open] 2026-09-28 chat admission / oracle web · web keeps E_RATE_LIMITED / E_RATE_LIMITER_UNAVAILABLE arms until the backend with 0248 ships: [ticket](tickets/web-rate-limit-copy-outlives-limiter.md).
- [open] 2026-09-28 sse transport · the listen cap's 429 E_RATE_LIMITED is misnamed and the sse client treats it as fatal: [ticket](tickets/sse-listen-cap-rejection-is-misnamed-and-fatal.md).
- [open] 2026-09-28 api / bff observability · server-timing phases outlived the tests that read them; keep or delete at the api/auth/bff reauthor: [ticket](tickets/server-timing-phases-outlived-their-tests.md).
- [open] search / typed wire · 2026-09-28 cleanup pr-08 · remaining always-sent locator output keys need a closure census and precise output views; compacted input/storage omissions remain intentional: [ticket](tickets/retrieval-locator-defaults-generate-optional-fields.md).
- [open] dossiers / resource graph · 2026-09-28 cleanup pr-08 · user links to or from an `artifact_revision` die at the next regenerate; revisions should not be link endpoints: [ticket](tickets/dossier-revision-user-links-die-on-regenerate.md).
- [open] dossiers / production migration · 2026-09-28 cleanup pr-08 · run 0250's stored-json preconditions and loss counts read-only against production before the backend deploy: [ticket](tickets/dossier-latest-revision-0250-production-preflight.md).
- [open] schema / production migration · 2026-09-28 pr #413 · restored production loss inventory recorded; owner acceptance and final drained backup/restore remain: [ticket](tickets/schema-0251-production-loss-preflight.md).
- [open] release / billing · 2026-09-28 cleanup pr-03 · record the billing counts before the 0252 release; cancel stripe, delete its webhook and drop the billing env keys after it: [ticket](tickets/billing-0252-release-steps.md).
- [open] podcasts / transcript api · 2026-09-27 cleanup pr-03 · p3 · the batch transcript forecast now only counts and fingerprints; removing it needs an expand step against the `extra=forbid` batch body: [ticket](tickets/podcast-batch-transcript-forecast-is-vestigial.md).
- [deferred] consumption / schema · 2026-09-28 consumption-stats reauthoring · four consumption state timestamps are written by nothing and read by nothing; drop them one release later: [ticket](tickets/drop-write-only-consumption-timestamps.md).
- [open] consumption / stats contracts · 2026-09-28 reauthoring, qualified 2026-10-03 · unproduced `Week` remains; retain read `recordedActiveMs` pending precision/conservation proof: [ticket](tickets/consumption-stats-over-its-line-target.md).
- [open] consumption / stats pane · 2026-09-28 consumption-stats reauthoring · p3 · timeline modalities all paint `CanvasText` in forced colors: [ticket](tickets/stats-timeline-modalities-merge-in-forced-colors.md).
- [open] consumption activity / web outbox · 2026-09-28 consumption-stats reauthoring · p3 · batches follow creation order, so two tabs on one work can fail a whole batch as out of order: [ticket](tickets/activity-outbox-batches-rows-in-creation-order.md).
- author non-media work dates have no producer: [ticket](tickets/author-nonmedia-work-dates-have-no-producer.md).


- [open] inbound share / account policy candidate · 2026-10-02 producer review · valid dependency failures reach the defect owner; terminal recovery policy is undecided, source-verified/live not_run: [ticket](tickets/share-account-transient-failures-escape-inline-feedback.md).
- [open] nexus / command policy candidate · 2026-10-02 producer review · valid auth-dependency503 reaches all three writes; terminal recovery policy is undecided, source-verified/live not_run: [ticket](tickets/nexus-auth-dependency-failure-escapes-retry-feedback.md).
- [open] local docker / inventory · 2026-10-03 selection-concurrency allocation · full enumeration failed again, then passed at cleanup; intermittent recurrence remains open, cause and initial stopped-state comparison unproved: [ticket](tickets/local-docker-stopped-container-snapshot-missing.md).

- [open] metadata bibliography · 2026-10-01 council · local book/collection/essay dates are qualified; targeted saved-production correction remains behind the historical release gate: [ticket](tickets/metadata-book-date-counts-serialization.md) · [github #485](https://github.com/NielsdaWheelz/nexus-web/issues/485).
- [open] epub contributors / saved repair · 2026-10-04 pr #482 closure · shipped parser/repair is locally qualified; production source-only preview/apply and preserved reader/credit verification remain: [ticket](tickets/epub-contributors-production-repair-pending.md) · [github #486](https://github.com/NielsdaWheelz/nexus-web/issues/486).
- [open] metadata production admission · 2026-10-01 investigation · catalog cause and three reviewed retry dispositions await runtime repair: [ticket](tickets/metadata-production-catalog-refresh-fails.md).
- [open] atlas / production migration · 2026-10-04 current-main composition · bcb86e actual0241→0257 retains all atlas identities/non-timestamp fields; 502 timestamp losses still need approval and final backup/restore: [ticket](tickets/atlas-0254-production-timestamp-loss.md).
- [open] reader / pane search · 2026-10-02 metadata browser acceptance · same-document find preview query replacement collapses the toolbar: [ticket](tickets/reader-find-preview-collapses-toolbar-on-query-replace.md).
- [open] native llm tool storage · 2026-10-04 source audit · nullable replay pointer has no current application reader or writer; qualify retained data before dropping it: [ticket](tickets/llm-tool-position-unused-replay-pointer.md).
- [deferred] resource activation / native output · 2026-10-04 chat read review · shared output validates href relation but not canonical resource_ref; retain browser leaf validation until the native owner does: [ticket](tickets/resource-activation-output-canonical-ref-contract.md).
- [deferred] chat trust tool / native output · 2026-10-04 chat read review · counts and machine-authorship identity correlations remain in the browser decoder, not the native output model: [ticket](tickets/trust-tool-output-correlation-contract.md).
