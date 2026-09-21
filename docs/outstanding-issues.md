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

### [OPEN] OI-003 — Imports live re-read loses one tick after a failed re-key
frontend · opened 2026-09-08 by Claude (imports cutover, Track D2) · P3
A manual refresh or invalidation whose own summary read fails re-keys the page
and detail without delivering a tick, so the next successful observation is
suppressed and the 5 s cadence of contract D10 slips once. See
[docs/tickets/imports-live-reread-loses-one-tick-after-a-failed-rekey.md](tickets/imports-live-reread-loses-one-tick-after-a-failed-rekey.md).

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

### [OPEN] OI-019 — The media-kind Literal has no single owner
backend · opened 2026-09-08 by Claude (imports cutover, Track C1) · P3
The media-kind literal is re-listed in several wire schemas instead of being
owned once. See
[docs/tickets/media-kind-literal-has-no-owner.md](tickets/media-kind-literal-has-no-owner.md).

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

### [OPEN] OI-040 — The narrow `ResourceRow` state layout is unreviewed for Collections
frontend · opened 2026-09-09 by Claude (imports cutover, chain W1) · P3
Closing the Imports rows' orphaned `·` stopped the shared supporting cell from
growing, which also moves `CollectionRow`'s narrow state block off the trailing
edge; no proof or capture covers that second consumer. See
[docs/tickets/resource-row-narrow-state-layout-is-unreviewed-for-collections.md](tickets/resource-row-narrow-state-layout-is-unreviewed-for-collections.md).

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

### [OPEN] OI-049 — `player_descriptor` is installed after the media DTO is built
backend · opened 2026-09-08 by Claude (imports cutover, Phase 4 chain M) · P3
`_media_out_from_row` builds every `MediaOut` with an absent `playerDescriptor`
and `_apply_consumption_state` then rebuilds the whole DTO through
`model_validate` to install the derived one, so the descriptor's owner is a
second pass over an already-built object. See
[docs/tickets/media-player-descriptor-is-installed-after-construction.md](tickets/media-player-descriptor-is-installed-after-construction.md).

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

- [open] oi-069 · reader interaction · 2026-09-11 council · implemented map controls await manual assistive-technology and actual-touch review: [ticket](tickets/reader-map-inert-position-and-mobile-controls.md).
- [open] oi-075 · epub ingest · 2026-09-12 source review · decoded reserved delimiters make stored source urls ambiguous: [ticket](tickets/epub-normalized-href-reserved-delimiters.md).
- [open] oi-076 · import progress · 2026-09-12 source review · extraction progress calls spine files chapters: [ticket](tickets/epub-import-progress-counts-files-as-chapters.md).
- [open] oi-078 · web build · 2026-09-12 offline artifact · css minifier warns on existing custom-highlight syntax: [ticket](tickets/offline-css-minifier-rejects-highlight-syntax.md).
- [open] oi-080 · web ingest · 2026-09-12 source review · generated heading ids replace authored link and container targets: [ticket](tickets/web-ingest-replaces-authored-heading-anchors.md).
- [open] oi-085 · epub extraction · 2026-09-12 memory review · utf-8 output caps do not bound retained unicode string memory: [ticket](tickets/epub-utf8-output-cap-does-not-bound-resident-text.md).
- [open] oi-087 · ci actions · 2026-09-12 reader publication · the pinned buildx action targets a deprecated node runtime: [ticket](tickets/ci-buildx-action-deprecated-node-runtime.md).
- [open] client telemetry malformed json · 2026-09-17 telemetry cleanup · malformed beacons return an unstructured 500 before authentication or backend validation: [ticket](tickets/client-defect-telemetry-malformed-json-returns-500.md).

- [open] oi-106 · generation policy · 2026-09-14 spec review · p2 · background context-token budget is recorded without enforcement: [ticket](tickets/background-generation-context-budget-is-not-enforced.md).
- [open] metadata verification · 2026-09-14 implementation · live research judgments and external query contents still need smoke inspection: [ticket](tickets/metadata-live-research-smoke-unverified.md).
- [open] resource actions · 2026-09-14 highlight popup verification · manual follow-up must distinguish a mobile navigation defect from the removed journey's readiness race: [ticket](tickets/resource-action-parity-mobile-pane-readiness.md).
- [open] agent tools · 2026-09-14 pr #246 memory review · resource reads load full bodies before enforcing their output limit: [ticket](tickets/resource-reader-loads-full-body-before-limit.md).
- [open] oi-109 · local s3 development · 2026-09-15 pr #255 qualification · p2 · the pinned minio image pull failed on the devbox; establish supported access and prove a fresh pull: [ticket](tickets/local-minio-image-pull-fails-on-devbox.md).
- [open] oi-111 · reader publication · 2026-09-15 restoration rehearsal · p2 · web replacement can retain a cursor for a deleted fragment: [ticket](tickets/web-publication-invalidates-saved-reader-cursors.md).
- [open] oi-113 · interactive worker · 2026-09-15 pr #255 qualification · p2 · exact-image startup is oom-killed at 256 mib; isolate provider imports and qualify real execution demand: [ticket](tickets/interactive-worker-startup-reaches-memory-cap.md).

- [open] oi-115 · api availability · 2026-09-15 memory review · p2 · api startup requires codex catalogue availability despite its independent-readiness contract: [ticket](tickets/api-startup-requires-codex-catalog-availability.md).



- [open] oi-125 · epub assets · 2026-09-15 source review · p2 · complete asset bodies, broad media reads and per-request storage clients lack an aggregate allocation budget: [ticket](tickets/epub-asset-response-allocation-and-client-lifetime.md).
- [open] oi-126 · backend publication · 2026-09-15 restoration release · p2 · disk exhaustion aborts the runner before bundle upload and cleanup: [ticket](tickets/backend-publication-can-exhaust-devbox-disk.md).
- [open] oi-127 · devbox operations · 2026-09-15 memory diagnosis · p2 · runner stopped and user/docker services restarted during diagnosis; cause remains unresolved: [ticket](tickets/devbox-services-interrupted-memory-diagnosis.md).
- [open] oi-128 · generation · 2026-09-15 ecbe manual check · p2 · chat and metadata fail after codex dispatch with invalid_request; user defers chat repair: [ticket](tickets/restored-chat-codex-dispatch-fails.md).
- [open] oi-130 · synapse jobs · 2026-09-15 ecbe production observation · p2 · cancellation after lost admission claim requires an absent Prepared checkpoint: [ticket](tickets/synapse-cancellation-missing-prepared-checkpoint.md).
- [open] oi-131 · background memory · 2026-09-15 ecbe observation · p2 · retained peak447.902/448 mib leaves100 kib margin, without observed oom: [ticket](tickets/background-worker-production-memory-margin.md).

- [open] oi-132 · api observability · 2026-09-15 reader oom diagnosis · p2 · access logs label headers as completion and omit requests killed before headers: [ticket](tickets/api-request-logs-stop-at-response-headers.md).
- [open] oi-133 · dependency maintenance · 2026-09-15 pr #270 · p2 · integrate the isolated embedding import fix from published maintenance revisions into upstream main: [ticket](tickets/embedding-memory-maintenance-pins-need-upstream-integration.md).
- [open] oi-134 · search · 2026-09-15 pr #270 diagnosis · p1 · query fixes deployed; native and production search still exceeds the 30-second web deadline: [ticket](tickets/semantic-document-search-times-out-on-restored-corpus.md).
- [open] oi-135 · search memory · 2026-09-15 pr #270 review · p2 · selected result pages still retain complete fragment quotes without an aggregate byte bound: [ticket](tickets/search-result-pages-retain-full-fragment-quotes.md).
- [open] oi-136 · search performance · 2026-09-15 pr #270 diagnosis · p2 · semantic ranking still scans/sorts the embedding corpus and spills substantial temporary data: [ticket](tickets/semantic-ranking-still-scans-embedding-corpus.md).
- [open] oi-137 · api memory · 2026-09-16 utc pr #270 manual acceptance · p2 · paired readers stayed usable but reached the 320-mib cap; sustained margin remains unproved: [ticket](tickets/api-reader-search-memory-margin-remains-small.md).
- [open] oi-139 · codex host provisioning · 2026-09-16 retained pr #203 finding · p2 · encrypted-state formatting lacks a qualified memory bound and usable-keyslot check: [ticket](tickets/codex-state-luks-format-oom.md).

- [open] oi-174 · release · 2026-09-21 deploy collapse · p2 · the release no longer gates on the latest published stable Android release's player-protocol manifest; only the frontend's own contract is proved: [ticket](tickets/android-player-protocol-release-gate-removed.md).
- [open] oi-161 · web panes · 2026-09-17 slop sweep · p3 · four pane bodies are oversized with no split that does not invent abstractions; re-measure after the dedupes land: [ticket](tickets/oversized-pane-bodies-have-no-obvious-split.md).
- [open] pdf passage positioning · 2026-09-17 passage cleanup · p2 · actual viewport verification is blocked by standalone renderer bootstrap: [ticket](tickets/pdf-passage-positioning-needs-browser-verification.md).
- [open] oi-167 · pdf highlights · 2026-09-17 typecheck cleanup · p2 · write-time matching combines cached text with current publication spans: [ticket](tickets/pdf-highlight-matching-mixes-publication-snapshots.md).
- [open] oi-168 · pdf highlights · 2026-09-17 typecheck cleanup · p3 · three persisted quote-match columns have no current runtime readers: [ticket](tickets/pdf-highlight-match-columns-have-no-readers.md).
- [open] oi-170 · consumption activity · 2026-09-17 slop sweep · p3 · `clientMutationId` on activity uploads is a wire no-op held by the shipped android client: [ticket](tickets/activity-upload-client-mutation-id-is-a-wire-no-op.md).
- [open] oi-171 · appearance · 2026-09-18 owner decisions · p3 · Press and Study declare no color-scheme, so native controls and UA scrollbars follow the browser default: [ticket](tickets/press-and-study-leave-native-controls-on-the-ua-scheme.md).
- [open] oi-172 · contributors · 2026-09-18 owner decisions · p3 · author rename is dead end to end now that no viewer can hold the admin role; delete the feature or grant it to a real principal: [ticket](tickets/author-rename-has-no-principal-who-may-perform-it.md).
- [open] secret scanning · 2026-09-18 pr #334 · gitguardian repeats an operator-classified false positive on a compose variable reference: [ticket](tickets/gitguardian-repeats-classified-variable-reference.md).
- [open] oi-175 · chat tool runtime · 2026-09-21 reauthoring · p3 · `tool_call_delta` has no producer but remains in the event vocabulary, the CHECK and the browser decoder; removal needs one owner preflight count: [ticket](tickets/tool-call-delta-event-has-no-producer.md).
- [open] oi-176 · consumption · 2026-09-21 reauthoring · p3 · the python and SQL read-state ladders enter the audio arm on different predicates for a podcast episode with no audio: [ticket](tickets/consumption-read-state-divergence.md).
- [open] oi-177 · dossiers · 2026-09-21 reauthoring · p3 · the three artifact_learn_* tables have no writer and await a 0240 drop: [ticket](tickets/artifact-learn-tables-are-write-free.md).
- [open] oi-178 · dossiers · 2026-09-21 reauthoring · p2 · a recheck raising DossierInputTooLarge escapes the terminal writers and leaves a build active with no terminal: [ticket](tickets/dossier-recheck-can-raise-past-the-terminal-writer.md).

- [open] 2026-09-21 cleanup audit · action menus copy offline metadata they never read: [ticket](tickets/cleanup-action-menu-offline-state-projection.md).
- [open] 2026-09-21 cleanup audit · chat runs synchronous database phases on the api event loop: [ticket](tickets/cleanup-chat-database-work-blocks-api-event-loop.md).
- [open] 2026-09-21 cleanup audit · denied inspection permission incorrectly selects extension file capture: [ticket](tickets/cleanup-extension-document-permission-denial.md).
- [open] 2026-09-21 cleanup audit · offline reading store retains unused construction modes: [ticket](tickets/cleanup-offline-reading-unused-construction-seams.md).
- [open] pane find · 2026-09-21 reader cleanup · adapters echo request identities through redundant response contracts: [ticket](tickets/pane-find-response-echo-protocol.md).
- [open] epub find · 2026-09-21 reader cleanup · private adapter retains unused transport injection: [ticket](tickets/epub-find-unused-transport-injection.md).
- [open] highlight interaction · 2026-09-21 reader cleanup · hook keeps unused focus callbacks and hover metadata: [ticket](tickets/highlight-interaction-unused-api.md).
