# Outstanding Issues & Follow-ups

A register of **open code-level work** — issues found but left out of scope, bugs,
refactors deferred because they were too much churn, and things that warrant a
closer look later. **Add entries as they surface; delete them once resolved (record
the fix in the commit/PR). This doc tracks only outstanding work, never history.**

It is **not** a checklist for routine verification (running test / e2e / CSP
suites), release process (commit / PR / merge), or already-settled design decisions
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

### [OPEN] OI-006 — Decide the disposition of the generation-cutover adversarial review
documentation · opened 2026-09-06 by Claude (PR #203 takeover) · P3
A 1272-line adversarial review of the generation-backends cutover exists only as
an untracked file in a stale worktree; decide whether to archive it in the repo
or drop it. See
[docs/tickets/adversarial-review-artifact-disposition.md](tickets/adversarial-review-artifact-disposition.md).

### [OPEN] OI-007 — Bring the local `pr` gate back inside its time budget
test-control · opened 2026-09-06 by Claude (PR #203 release work) · P1
A green local `pr` run takes 43.5 minutes against a five-minute target; the
kernel lane and sensitivity red/green dominate it. See
[docs/tickets/ci-gate-time-budget.md](tickets/ci-gate-time-budget.md).

### [OPEN] OI-008 — BASE provisioning can take the candidate runtime's recorded ports
test-control · opened 2026-09-06 by Claude (PR #203 takeover) · P2
Sensitivity BASE provisioning reuses the candidate runtime's ports, so `pr`
fails in its first sensitivity execution with an opaque compose error. See
[docs/tickets/controller-base-provisioning-port-allocation.md](tickets/controller-base-provisioning-port-allocation.md).

### [OPEN] OI-009 — Dispatch-error HUD copy has no cross-subject proof
frontend · opened 2026-09-08 by Claude (imports cutover, Track E) · P3
The imports-scoped `E_RESOURCE_CONFLICT` branch in the shared dispatch-error
owner is correct but unproved for every other subject. See
[docs/tickets/dispatch-error-copy-has-no-cross-subject-proof.md](tickets/dispatch-error-copy-has-no-cross-subject-proof.md).

### [OPEN] OI-010 — Register an exact canonical node for the capacity-pause proof owner
test-control · opened 2026-09-06 by Claude (PR #203 takeover) · P2
`test_generation_capacity_pause.py` is a whole-file owner with neither an exact
node nor a fault, so `pr` never produces a red/green pair for it. See
[docs/tickets/gate-capacity-pause-owner-exact-node.md](tickets/gate-capacity-pause-owner-exact-node.md).

### [OPEN] OI-011 — Guard the isolation marker in the two whole-file Chat owners
test-control · opened 2026-09-06 by Claude (PR #203 takeover) · P2
Both Chat owners depend on a `service/conftest.py` fixture the controller's BASE
overlay does not copy, so a BASE run errors at setup instead of failing red. See
[docs/tickets/gate-chat-owner-isolation-marker-guard.md](tickets/gate-chat-owner-isolation-marker-guard.md).

### [OPEN] OI-012 — Import history collapses three queue execution codes
backend · opened 2026-09-08 by Claude (imports cutover, Track A) · P3
`queue_failure_code` maps three distinct queue execution codes onto
`E_WORKER_HANDLER_FAILED`, which costs the inspector precision it could keep. See
[docs/tickets/import-history-collapses-three-queue-execution-codes.md](tickets/import-history-collapses-three-queue-execution-codes.md).

### [OPEN] OI-013 — `E_PDF_TEXT_UNAVAILABLE` is a catalogued code that names no failure
backend · opened 2026-09-08 by Claude (imports cutover, Track A) · P3
The safe-code catalog carries a PDF text warning as if it were a failure; the
copy owner half is done, the emission assertion is not. See
[docs/tickets/import-history-pdf-text-warning-is-not-a-failure.md](tickets/import-history-pdf-text-warning-is-not-a-failure.md).

### [OPEN] OI-014 — The browser failure-code catalog has no drift proof
frontend · opened 2026-09-08 by Claude (imports cutover, Track D1) · P2
`lib/imports/importRef.ts` mirrors the Python `SafeFailureCode` catalog by hand;
the cross-language equality proof that stops it drifting is still missing. See
[docs/tickets/imports-browser-failure-code-catalog.md](tickets/imports-browser-failure-code-catalog.md).

### [OPEN] OI-015 — History date bounds require an explicit offset the date control cannot give
backend · opened 2026-09-08 by Claude (imports cutover, Track C1) · P3
`GET /imports` accepts only explicit-offset instants; the codec side is resolved
and the pane-level proof of the calendar-day contract is still owed. See
[docs/tickets/imports-history-date-bounds-require-an-explicit-offset.md](tickets/imports-history-date-bounds-require-an-explicit-offset.md).

### [OPEN] OI-017 — The Imports page read runs two statements under one snapshot
backend · opened 2026-09-08 by Claude (imports cutover, Track C2) · P3
`read_import_page` runs its CTE twice under the route's REPEATABLE READ
snapshot, and the service fixture cannot prove that isolation. See
[docs/tickets/imports-page-read-runs-two-statements-under-one-snapshot.md](tickets/imports-page-read-runs-two-statements-under-one-snapshot.md).

### [OPEN] OI-019 — The media-kind Literal has no single owner
backend · opened 2026-09-08 by Claude (imports cutover, Track C1) · P3
The media-kind literal is re-listed in several wire schemas instead of being
owned once. See
[docs/tickets/media-kind-literal-has-no-owner.md](tickets/media-kind-literal-has-no-owner.md).

### [OPEN] OI-020 — The reindex embedding seam serves only the index proof
backend · opened 2026-09-08 by Claude (imports cutover, Track B) · P3
`run_media_content_reindex(embed_texts=...)` exists only so the index-recovery
proof can run without an embedding peer; accepted until a loopback peer exists. See
[docs/tickets/media-reindex-embedding-seam-serves-only-the-index-proof.md](tickets/media-reindex-embedding-seam-serves-only-the-index-proof.md).

### [OPEN] OI-021 — `media_source_attempts.status = 'superseded'` has no writer
backend · opened 2026-09-08 by Claude (imports cutover, Track A) · P3
The status CHECK admits a value nothing writes; migration 0227 is fail-closed
against it, so the allowed value is dead vocabulary. See
[docs/tickets/media-source-attempt-superseded-status-has-no-writer.md](tickets/media-source-attempt-superseded-status-has-no-writer.md).

### [OPEN] OI-022 — URL-source reuse joining an in-flight attempt has no proof
backend · opened 2026-09-08 by Claude (imports cutover, Track B) · P2
The behavior is fixed; the named case that keeps a second URL acceptance joining
the in-flight attempt is missing. See
[docs/tickets/url-source-in-flight-join-has-no-proof.md](tickets/url-source-in-flight-join-has-no-proof.md).

### [OPEN] OI-023 — X-post quote completion defects when its ingest job is not running
backend · opened 2026-09-08 by Claude (imports cutover, Track B) · P2
A pre-existing defect surfaced while fixing the completion's lock cycle: quote
completion raises when its ingest job is not running. See
[docs/tickets/x-quote-completion-defects-when-its-ingest-job-is-not-running.md](tickets/x-quote-completion-defects-when-its-ingest-job-is-not-running.md).

### [OPEN] OI-025 — The `operator_repair` media-reindex reason has no producer
backend · opened 2026-09-08 by Claude (imports cutover, Track C2) · P3
`MEDIA_CONTENT_REINDEX_REASONS` admits a payload reason nothing writes; repair
requeues the existing job and keeps its original reason. See
[docs/tickets/media-reindex-operator-repair-reason-has-no-producer.md](tickets/media-reindex-operator-repair-reason-has-no-producer.md).

### [OPEN] OI-030 — The source-refusal sentence is duplicated in Python with no mirror
backend · opened 2026-09-09 by Claude (imports cutover, Track C2) · P3
The repairable-state refusal in `media_source_ingest.py` now repeats, word for
word, the copy `mediaErrorMessage.ts` composes from the action catalog, and
nothing compares the two. See
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

### [OPEN] OI-037 — The label-hidden badge case is subsumed by the collapsed-rail proof
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2) · P3
`ImportsWorkspace.browser.test.tsx` still renders `ImportsBadge` alone to prove
its label-hidden branch; `NavRail.browser.test.tsx` now proves that branch in the
collapsed rail it exists for, with the chip geometry as well. See
[docs/tickets/label-hidden-badge-case-is-subsumed-by-the-rail-proof.md](tickets/label-hidden-badge-case-is-subsumed-by-the-rail-proof.md).

### [OPEN] OI-038 — The Imports pane's wrapping geometry has no automated gate
frontend · opened 2026-09-09 by Claude (imports cutover, chain W1) · P3
`Refresh`'s fixed slot and the row separator's adjacency are both layout facts
the browser proof cannot reach: `setViewportWidth` only redefines
`window.innerWidth`, so no toolbar row re-wraps and no container query changes
branch. The D15 recapture is their only gate. See
[docs/tickets/imports-toolbar-wrapping-geometry-has-no-automated-gate.md](tickets/imports-toolbar-wrapping-geometry-has-no-automated-gate.md).

### [OPEN] OI-040 — The narrow `ResourceRow` state layout is unreviewed for Collections
frontend · opened 2026-09-09 by Claude (imports cutover, chain W1) · P3
Closing the Imports rows' orphaned `·` stopped the shared supporting cell from
growing, which also moves `CollectionRow`'s narrow state block off the trailing
edge; no proof or capture covers that second consumer. See
[docs/tickets/resource-row-narrow-state-layout-is-unreviewed-for-collections.md](tickets/resource-row-narrow-state-layout-is-unreviewed-for-collections.md).

### [OPEN] OI-041 — The mobile switchboard's Account-menu host has no proof
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2) · P3
`NavRail.browser.test.tsx` proves the shared Account menu's `Imports` item, but
nothing renders `SwitchboardTask` or asserts it hands the switchboard pages an
Account menu with the utilities and the active utility id. See
[docs/tickets/mobile-switchboard-account-menu-host-has-no-proof.md](tickets/mobile-switchboard-account-menu-host-has-no-proof.md).

### [OPEN] OI-042 — Any appnav edit selects the whole document-import-reliability risk
test-control · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2) · P3
Registering the rail proof required `components/appnav/**/*` in that priority
risk's source globs, so an edit to any navigation file now selects the risk's
migration and service nodes too. See
[docs/tickets/appnav-glob-selects-the-whole-import-reliability-risk.md](tickets/appnav-glob-selects-the-whole-import-reliability-risk.md).

### [OPEN] OI-043 — The collapsed count chip scales out of its fixed-width rail
frontend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain W2) · P3
The collapsed rail is fixed px while the count chip anchored inside it is sized
in rem, so a large document root font size grows the chip past the rail's left
edge, which clips it; the proof measures the default root only. See
[docs/tickets/collapsed-count-chip-scales-out-of-its-fixed-width-rail.md](tickets/collapsed-count-chip-scales-out-of-its-fixed-width-rail.md).

### [OPEN] OI-044 — The new `failed` content-index defect has no preflight over extant rows
backend · opened 2026-09-09 by Claude (imports cutover, Phase 6 chain P review) · P2
`_item` now raises for any media whose content index reports `failed`, including
the shape the previous classifier rendered as a repairable `NeedsAttention` row;
0227's preflight surveys attempt codes only, so no evidence says such rows are
absent from production. See
[docs/tickets/imports-ingress-defect-has-no-preflight-over-extant-index-rows.md](tickets/imports-ingress-defect-has-no-preflight-over-extant-index-rows.md).

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

### [OPEN] OI-051 — The packaged offline reader bundle drifted from its sources for five phases
frontend · opened 2026-09-10 by Claude (imports cutover, Phase 7 chain Z review) · P2
Five declared inputs of `nexus-offline/source-manifest.sha256` went stale between
`4d457ab1` and `26b8161b` without a regeneration; chain Z added a sixth and
regenerated, absorbing all six. The regeneration also grew the declared input set
from 119 to 126 lines, so the packaged shelf now ships seven modules it never
carried before — none of which the Android offline-reading proof has run
against. See
[docs/tickets/offline-reader-bundle-drifted-for-five-phases.md](tickets/offline-reader-bundle-drifted-for-five-phases.md).

### [OPEN] OI-052 — The offline-bundle staleness gate is unreachable from the sources it guards
tooling · opened 2026-09-10 by Claude (imports cutover, Phase 7 chain Z review) · P2
`immutable-production-release` owns the only proof that runs Gradle's
`verifyOfflineReadingAssets`, but its `source_globs` cover none of the ~110
shared web sources the bundle's source manifest pins, so a change that breaks the
gate can never select it. Cause of OI-051. See
[docs/tickets/offline-bundle-gate-is-not-selected-by-its-own-sources.md](tickets/offline-bundle-gate-is-not-selected-by-its-own-sources.md).

### [OPEN] OI-053 — The durable activity outbox suite fails in the imports runner container
frontend · opened 2026-09-10 by Claude (imports cutover, Phase 7 chain Z2) · P2
`activityRuntime.browser.test.ts` fails 8 of 13 cases deterministically in the
cutover's Linux runner, with every failure reading as an IndexedDB write that
never landed. `lib/consumption/**` is untouched by this cutover, but any change
broad enough to select that suite inherits the failure. See
[docs/tickets/durable-activity-outbox-suite-fails-in-the-imports-runner.md](tickets/durable-activity-outbox-suite-fails-in-the-imports-runner.md).

### [OPEN] OI-054 — Docker Desktop VM crashes block trustworthy database/process verification
infrastructure · opened 2026-09-09 by Claude (shared-kernel worktree) · P1
Docker Desktop's Apple Virtualization VM stops with `VZErrorInternal` during
verification; recover the shared engine, then clean only owned interrupted
resources and repeat the blocked checks. See
[docs/tickets/docker-desktop-virtualization-crash.md](tickets/docker-desktop-virtualization-crash.md).

### [OPEN] OI-055 — The supervisor residency limit is 19 MiB looser than the supervisor it guards
backend · opened 2026-09-10 by Claude (imports cutover, Phase 9) · P2
`SUPERVISOR_RESIDENT_KIB_LIMIT` (96 MiB) is asserted once, after a real
eight-job run, while main's supervisor imports at 73 MiB; a 19 MiB import leak
(the ORM reached the supervisor through the history projections) surfaced only
as a marginal run-time overshoot. Assert the import-only residency in a cheap
kernel case at the boundary that owns it. See
[docs/tickets/supervisor-residency-limit-hides-import-growth.md](tickets/supervisor-residency-limit-hides-import-growth.md).

### [OPEN] OI-056 — Fault patches with no leading context can reverse onto another occurrence
testing · opened 2026-09-10 by Claude (imports cutover, Phase 9) · P2
`applied_fault` reverses a registered patch by context; a hunk with one context
line and none leading can bind to a different occurrence than it was cut from,
so `prove` fails "fault reversal did not restore the isolated checkout" (or
reverses the wrong site). Five registered patches still have that shape.
Regenerate them with default context and reject such hunks at registration. See
[docs/tickets/zero-context-fault-patches-can-reverse-onto-another-occurrence.md](tickets/zero-context-fault-patches-can-reverse-onto-another-occurrence.md).

### [OPEN] OI-057 — The coherent-fault owner digest omits the imports and support modules the standard says it pins
testing · opened 2026-09-10 by Claude (imports cutover, Phase 9 review) · P3
testing-standards §3 says a coherent-fault owner pin covers the exact test "plus
its imports and non-test module support"; `python_exact_proof_owner_sha256`
hashes the owner test file alone, so strengthening the containment probe module
produced no owner drift and no review. Extend the digest or narrow the sentence. See
[docs/tickets/coherent-fault-owner-digest-omits-imported-support.md](tickets/coherent-fault-owner-digest-omits-imported-support.md).

### [OPEN] OI-058 — `pr` sensitivity cannot accept a new or repointed vitest proof owner
testing · opened 2026-09-11 by Claude (imports cutover, final gates) · P2
BASE replay of a vitest owner that is new or imports a new module fails at
module resolution, never at a behavioral assertion, and coherent-fault is
Python-only, so a hard cutover with new vitest owners cannot turn `pr` green
even when every owner's fault reddens it. Let a fault-owned vitest owner opt into
coherent-fault, or state that `pr` sensitivity is Python-only. See
[docs/tickets/pr-sensitivity-cannot-accept-new-vitest-owners.md](tickets/pr-sensitivity-cannot-accept-new-vitest-owners.md).

### [OPEN] OI-059 — Three changed Python proof owners on the imports branch lack a coherent-fault witness
testing · opened 2026-09-11 by Claude (imports cutover, final gates) · P2
Two claim-adapted service nodes have no registered fault and one fault owns a
whole file, so `pr` routes them to a BASE that cannot load the branch's testkit.
Register a product-only fault for each node, repoint the whole-file fault at its
exact node, mark all three coherent-fault. See
[docs/tickets/three-changed-python-owners-lack-a-coherent-fault-witness.md](tickets/three-changed-python-owners-lack-a-coherent-fault-witness.md).

### [OPEN] OI-060 — Production synapse scans repeatedly time out
background jobs / semantic search · opened 2026-09-11 by Codex (production deployment) · P1
The production background worker repeatedly records PostgreSQL statement
timeouts while scanning synapses, leaving inherited work pending. Deploy the
current execution cutover, then prove the backlog converges without new
unexpected timeouts. See
[docs/tickets/production-synapse-scan-statement-timeout-backlog.md](tickets/production-synapse-scan-statement-timeout-backlog.md).

- [open] oi-061 · reader · 2026-09-11 council · epub headings absent from coarse publisher navigation: [ticket](tickets/reader-structure-epub-headings-missing.md).
- [open] oi-062 · reader · 2026-09-11 council · transitive marker clusters collapse document geography: [ticket](tickets/reader-map-transitive-marker-clusters.md).
- [open] oi-063 · reader · 2026-09-11 council · navigation intervals cannot represent nested or multi-file chapter extents: [ticket](tickets/reader-structure-epub-semantic-extents.md).
- [open] oi-064 · reader · 2026-09-11 council · current section ignores scrolling and local section progress is absent: [ticket](tickets/reader-map-active-section-and-local-position.md).
- [open] oi-065 · reader · 2026-09-11 council · previous/next can follow backward publisher toc targets: [ticket](tickets/reader-structure-epub-reading-order.md).
- [open] oi-066 · reader · 2026-09-11 council · themed marginalia records a separate, misleading progress history: [ticket](tickets/reader-map-marginalia-parallel-progress.md).
- [open] oi-067 · offline reader · 2026-09-11 council · web navigation emits document offsets as fragment offsets: [ticket](tickets/reader-map-offline-web-coordinate-mismatch.md).
- [open] oi-068 · epub ingest · 2026-09-11 council · long colliding section ids can loop indefinitely: [ticket](tickets/reader-structure-long-section-id-loop.md).
- [open] oi-069 · reader interaction · 2026-09-11 council · requested position/mobile map actions need an explicit contract: [ticket](tickets/reader-map-inert-position-and-mobile-controls.md).
- [open] oi-070 · reader verification · 2026-09-11 council · inspect the exact shadow & claw and pillow book imports: [ticket](tickets/reader-map-shadow-claw-reproduction.md).
- [open] oi-071 · offline reader · 2026-09-11 spec review · epub package duplicates complete fragment content per navigation target: [ticket](tickets/reader-map-offline-content-duplication.md).
- [open] oi-072 · offline reader · 2026-09-11 spec review · text capture/restore estimates exact locators from scroll percentages: [ticket](tickets/reader-map-offline-pixel-locators.md).
- [open] oi-073 · reader migration · 2026-09-11 adversarial review · retire synthetic section references without breaking stored passages: [ticket](tickets/reader-map-retired-spine-references.md).
- [open] oi-074 · nexus history · 2026-09-13 council · valid titles exceed history ingress and can crash the workspace: [ticket](tickets/second-tab-selection-history-rejects-valid-labels.md).
- [open] oi-075 · failure containment · 2026-09-13 council · selection-history defects replace healthy workspace panes: [ticket](tickets/second-tab-selection-history-can-fail-workspace.md).
- [open] oi-076 · failure containment · 2026-09-13 council · current resource-registry defects escape pane boundaries: [ticket](tickets/second-tab-resource-resolution-escapes-pane-boundary.md).
- [open] oi-077 · workspace persistence · 2026-09-13 council · save state advances before acknowledgment and failed flushes lose ownership: [ticket](tickets/second-tab-workspace-save-acknowledgment.md).
- [open] oi-078 · diagnostics · 2026-09-13 council · shared-workspace failures have no remote client receipt: [ticket](tickets/second-tab-workspace-defect-telemetry.md).
- [open] oi-079 · production api · 2026-09-13 council · six confirmed api memory kills cause gateway failures: [ticket](tickets/second-tab-production-api-restarts.md).
- [open] oi-080 · reader memory · 2026-09-13 council · complete document responses have no content or byte window: [ticket](tickets/second-tab-reader-content-response-budget.md).
- [open] oi-081 · document map memory · 2026-09-13 council · aggregate evidence reads drain all lower-layer pages: [ticket](tickets/second-tab-document-map-response-budget.md).
- [open] oi-082 · nexus history memory · 2026-09-13 council · five recent targets materialize lifetime usage rows: [ticket](tickets/second-tab-nexus-history-read-budget.md).
- [open] oi-083 · production search · 2026-09-13 council · content search reaches its statement timeout: [ticket](tickets/second-tab-production-search-timeout.md).
- [open] oi-084 · recovery copy · 2026-09-13 council · workspace fallback promises unverified durability: [ticket](tickets/second-tab-workspace-recovery-durability-copy.md).
- [open] oi-085 · gateway classification · 2026-09-13 user trace · raw upstream 502s become fatal workspace defects: [ticket](tickets/second-tab-gateway-outage-classified-as-workspace-defect.md).
- [open] oi-087 · reader durability · 2026-09-13 follow-up · pending cursor intent loses its owner on reader teardown: [ticket](tickets/second-tab-reader-cursor-teardown-durability.md).
- [open] oi-088 · api startup memory · 2026-09-13 follow-up · provider configuration imports every vendor execution sdk into the api: [ticket](tickets/second-tab-eager-provider-sdk-imports.md).
- [open] oi-089 · workspace startup load · 2026-09-13 follow-up · restored-pane seeding fans out across offscreen mobile panes: [ticket](tickets/second-tab-bootstrap-read-fanout.md).
- [open] oi-090 · speculative reads · 2026-09-13 follow-up · per-key prefetch timers and cache limits do not bound outstanding work: [ticket](tickets/second-tab-speculative-read-admission.md).
- [open] oi-091 · reader consistency · 2026-09-13 architecture council · hosted content reads lack a selected publication identity: [ticket](tickets/reader-source-lacks-publication-revision.md).
- [open] oi-092 · resource cache · 2026-09-13 architecture review · older prefetch completion can overwrite or delete a newer pending read: [ticket](tickets/second-tab-prefetch-settlement-identity.md).
- [open] oi-093 · offline reader · 2026-09-13 architecture review · navigation repeatedly scans preceding text and allocates code-point arrays: [ticket](tickets/offline-reader-navigation-repeated-text-allocation.md).
- [open] oi-094 · offline delivery · 2026-09-13 architecture review · downloads rebuild unchanged publications inside foreground api threads: [ticket](tickets/offline-download-rebuilds-publication-in-api.md).
- [open] oi-095 · pdf loading · 2026-09-13 architecture review · streaming configuration undermines the requested demand-fetch policy: [ticket](tickets/reader-pdf-streaming-defeats-on-demand-fetch.md).
- [open] oi-096 · offline reader · 2026-09-13 architecture review · loading a descriptor decodes the complete publication payload: [ticket](tickets/offline-reader-decodes-whole-publication.md).
- [open] oi-099 · native response memory · 2026-09-13 implementation · reader json limits apply after whole-body allocation: [ticket](tickets/native-reader-json-bound-applied-after-allocation.md).
- [open] oi-100 · api image memory · 2026-09-13 implementation · the image proxy retains up to 128 mib inside a 320 mib api limit: [ticket](tickets/second-tab-image-proxy-api-memory-budget.md).
- [open] oi-103 · browser qualification · 2026-09-13 implementation · large browser experiments lack an execution memory ceiling: [ticket](tickets/test-browser-capacity-experiment-memory-ceiling.md).
- [open] oi-105 · native artwork · 2026-09-13 implementation · preview sends relative authenticated artwork to media3 without origin/auth normalization: [ticket](tickets/native-preview-artwork-relative-origin.md).
- [open] oi-106 · reader publication · 2026-09-13 implementation · oversized tables and header associations exceed bounded reading units: [ticket](tickets/reader-table-continuation-capacity.md).
- [open] oi-107 · image validation · 2026-09-13 implementation · compressed png metadata expands inside foreground api memory: [ticket](tickets/image-validation-expanded-metadata-allocation.md).
- [open] oi-108 · reader publication · 2026-09-13 implementation · html parsing can allocate more browser nodes than publication counts: [ticket](tickets/reader-browser-dom-expansion-bound.md).
- [open] oi-109 · image validation · 2026-09-13 implementation · eager exif parsing materializes aliased unselected values: [ticket](tickets/image-validation-exif-tag-alias-allocation.md).
- [open] oi-111 · bounded workspace · 2026-09-13 implementation · small table node trees can allocate large browser span grids: [ticket](tickets/reader-table-span-layout-allocation.md).
- [open] oi-112 · bounded workspace · 2026-09-13 implementation · svg use instances can expand beyond authored-node admission: [ticket](tickets/reader-svg-instance-residency.md).
- [open] oi-113 · reader coordinates · 2026-09-13 implementation · svg title and description metadata enter canonical text: [ticket](tickets/reader-svg-metadata-canonical-text.md).
- [open] oi-114 · browser test runtime · 2026-09-13 implementation · vitest cdp once removes its listener twice: [ticket](tickets/vitest-cdp-once-double-removal.md).
- [open] oi-115 · bounded workspace · 2026-09-13 implementation · native newer movement can conflict with its own earlier acknowledgment: [ticket](tickets/native-progress-new-intent-own-ack-conflict.md).
- [open] oi-116 · bounded workspace · 2026-09-13 implementation · whole-fragment highlight queries escape reader residency limits: [ticket](tickets/reader-highlight-query-residency.md).
- [open] oi-117 · bounded workspace · 2026-09-13 implementation · escaped svg paint URLs escape resource binding: [ticket](tickets/reader-svg-paint-resource-binding.md).
- [open] oi-118 · native asset memory · 2026-09-13 implementation · svg validation materializes the complete XML tree: [ticket](tickets/native-svg-validation-materializes-dom.md).
- [open] oi-119 · reader query latency · 2026-09-13 implementation · quote resolution can require a roundtrip per publication unit: [ticket](tickets/reader-quote-resolution-roundtrip-capacity.md).
- [open] oi-120 · browser test runtime · 2026-09-13 implementation · concurrent vitest cdp requests can lose handler initialization: [ticket](tickets/vitest-cdp-concurrent-handler-initialization.md).
- [open] oi-121 · reader display · 2026-09-13 implementation · svg local references can resolve another pane's definitions: [ticket](tickets/reader-svg-reference-scope.md).
- [open] oi-122 · reader capacity · 2026-09-13 implementation · supported source attributes can exceed unit and migration token budgets: [ticket](tickets/reader-oversized-attribute-capacity.md).
- [open] oi-123 · offline identity · 2026-09-13 implementation · schema-2 UUID-only fragments cannot preserve valid older opaque locators: [ticket](tickets/offline-legacy-opaque-fragment-identity.md).
- [open] oi-124 · offline conversion · 2026-09-13 implementation · installed schema-1 verification materializes the whole member before migration: [ticket](tickets/offline-installed-legacy-verification-whole-member.md).
- [open] oi-125 · reader find · 2026-09-13 implementation · UAX word boundaries do not prove existing dictionary segmentation: [ticket](tickets/reader-whole-word-dictionary-segmentation.md).
- [open] oi-126 · offline delivery · 2026-09-13 implementation · extensionless publication assets lose declared MIME and PDF byte ranges: [ticket](tickets/native-publication-member-mime-and-ranges.md).
- [open] oi-127 · offline navigation · 2026-09-13 implementation · offset-only index targets cannot distinguish zero-text units: [ticket](tickets/reader-publication-offline-navigation-identity.md).
- [open] oi-128 · offline conversion · 2026-09-13 implementation · ICU dictionary segmentation allocates complete CJK spans behind its iterator: [ticket](tickets/native-legacy-icu-dictionary-span-allocation.md).
- [open] oi-129 · reader navigation · 2026-09-13 implementation · contents paging shares the unit lookup chain and drains unrelated records: [ticket](tickets/reader-publication-contents-index-purpose.md).
- [open] oi-133 · publication proof · 2026-09-13 implementation · foreign controller occupies the real-source fixture producer port: [ticket](tickets/reader-source-fixture-producer-port-contention.md).
- [open] oi-134 · offline conversion · 2026-09-13 implementation · crop candidates can repeatedly scan an entire installed source: [ticket](tickets/native-legacy-crop-query-scan-capacity.md).
- [open] oi-136 · reader table metadata · 2026-09-13 implementation · explicit cell-to-header associations can grow quadratically from small source tables: [ticket](tickets/reader-table-header-association-expansion.md).
- [open] oi-139 · reader evidence · 2026-09-13 implementation · connection summaries materialize whole current bodies and associations: [ticket](tickets/reader-connection-summary-materialization.md).
- [open] oi-140 · reader provenance · 2026-09-13 implementation · mutable apparatus rows cannot establish retained-generation source facts: [ticket](tickets/reader-retained-apparatus-source-projection.md).
- [open] oi-141 · offline capacity · 2026-09-13 implementation · schema2 representation can exceed schema1 aggregate/member limits for accepted sources: [ticket](tickets/reader-schema-two-aggregate-expansion.md).
- [open] oi-145 · proof ownership · 2026-09-13 implementation · changed reader proofs cannot reach behavioral assertions through absent BASE interfaces: [ticket](tickets/changed-reader-proof-base-interface-mismatch.md).
- [open] oi-147 · transcript coordinates · 2026-09-13 implementation · mutable embed cards replace authored transcript text: [ticket](tickets/transcript-embed-display-canonical-mismatch.md).
- [open] oi-151 · reader navigation · 2026-09-13 implementation · media-only pulses cross view/source boundaries: [ticket](tickets/reader-pulse-missing-view-source-identity.md).
- [open] oi-152 · retained evidence · 2026-09-13 implementation · passage quote resolution needs its existing unbounded-quote semantics under bounded reads: [ticket](tickets/reader-evidence-normalized-anchor-query.md).
- [open] oi-153 · native table context · 2026-09-13 qualification · ordinary btree prefix scans multiply across large principal spans: [ticket](tickets/native-table-ray-query-prefix-cost.md).
- [open] oi-156 · document figures · 2026-09-13 implementation · assets lack attested pre-decode raster facts and measured admission: [ticket](tickets/reader-figure-predecode-admission.md).
- [open] oi-157 · pdf evidence · 2026-09-13 implementation · geometry lacks immutable source attestation: [ticket](tickets/reader-evidence-pdf-highlight-source-provenance.md).
- [open] oi-158 · pdf quote search · 2026-09-13 review · pdf normalization does not establish the search projection's nfc premise: [ticket](tickets/reader-pdf-search-nfc-source-assumption.md).
- [open] oi-160 · pdf mutations · 2026-09-13 review · duplicate lookup materializes every candidate's authored text and quads: [ticket](tickets/pdf-highlight-duplicate-query-materializes-candidates.md).
- [open] oi-161 · reader residency · 2026-09-13 review · session close releases published query charges before their committed consumers retire: [ticket](tickets/reader-published-query-close-retention.md).
- [open] oi-163 · reader residency · 2026-09-14 review · contents and chapter controls retain raw query results after reservation release: [ticket](tickets/reader-contents-raw-result-retirement.md).
- [open] oi-167 · native table conversion · 2026-09-14 review · local table conversion still needs canonical-boundary and activation acceptance: [ticket](tickets/native-legacy-table-metadata-producer.md).
- [open] oi-168 · reader navigation · 2026-09-14 review · section commands save before prepared source positioning: [ticket](tickets/reader-section-ready-before-position.md).
- [open] oi-169 · pdf memory · 2026-09-14 qualification · complete-find native allocation and post-close reclamation remain unqualified: [ticket](tickets/pdf-complete-find-native-memory-qualification.md).
- [open] oi-170 · foreground image memory · 2026-09-14 adversarial review · image admission is not qualified until its allocation is measured: [ticket](tickets/image-read-admission-needs-client-recovery.md).
- [open] oi-171 · retained publication · 2026-09-14 adversarial review · retained epub internal href identity needs cross-language conformance: [ticket](tickets/reader-retained-epub-internal-href.md).
- [open] oi-172 · sensitivity evidence · 2026-09-14 adversarial review · the coherent-fault portfolio must be replayed, not re-pinned: [ticket](tickets/coherent-fault-replay-portfolio.md).
- [open] oi-173 · proof registry · 2026-09-14 adversarial review · the ownership pin and routing sha need their independent review: [ticket](tickets/priority-risk-ownership-floor-review.md).
- [open] oi-174 · release process · 2026-09-14 adversarial review · no exact candidate exists, so every gate naming one is unreachable: [ticket](tickets/bounded-workspace-candidate-is-not-committed.md).
- [open] oi-175 · evidence · 2026-09-14 adversarial review · 217 of 470 cited receipts cannot be reached from the candidate: [ticket](tickets/dossier-receipt-index-is-not-auditable.md).
- [open] oi-176 · capacity qualification · 2026-09-14 adversarial review · thread/database headroom, host reserve and retained-growth tolerance are recorded nowhere: [ticket](tickets/gate-0a-recorded-capacity-limits-incomplete.md).
- [open] oi-177 · composition qualification · 2026-09-14 adversarial review · twelve-pane restore, pinned selection and slow cancellation have no artifact: [ticket](tickets/gate-e-twelve-pane-restore-journey.md).
- [open] oi-178 · release artifact · 2026-09-14 adversarial review · the deployed compose and release.py cannot boot the candidate: [ticket](tickets/gate-g-release-artifact-carries-no-capacity-profile.md).
- [open] oi-179 · hosted reader progress · 2026-09-14 adversarial review · a cross-tab acknowledgment leaves the live writer with a stale baseline: [ticket](tickets/hosted-progress-crosstab-ack-leaves-a-stale-baseline.md).
- [open] oi-180 · hosted reader progress · 2026-09-14 adversarial review · a ContentChanged view applies the device locator while saying it did not: [ticket](tickets/content-changed-view-applies-a-locator-it-reports-as-unapplied.md).
- [open] oi-181 · workspace persistence · 2026-09-14 adversarial review · recovery offers an arbitrary row and its discard path has no proof: [ticket](tickets/workspace-recovery-row-selection-and-discard.md).
- [open] oi-182 · workspace session sync · 2026-09-14 adversarial review · a test-only scheduler seam and a dead positional parameter: [ticket](tickets/session-sync-scheduler-seam-and-dead-parameter.md).
- [open] oi-183 · resource cache · 2026-09-14 adversarial review · useResource publishes defects but never their clearance: [ticket](tickets/use-resource-defect-clearance-has-no-consumer.md).
- [open] oi-184 · speculative reads · 2026-09-14 adversarial review · closing the nexus withdraws the warm read for the pane it is opening: [ticket](tickets/nexus-close-withdraws-the-pane-it-just-opened.md).
- [open] oi-185 · publication render · 2026-09-14 adversarial review · direct render-node construction has no closed element/attribute vocabulary: [ticket](tickets/render-node-vocabulary-has-no-closed-enumeration.md).
- [open] oi-186 · reader evidence · 2026-09-14 adversarial review · evidence seek by source marker cannot be verified by its caller: [ticket](tickets/evidence-seek-does-not-return-its-resolved-selection.md).
- [open] oi-187 · reader stance · 2026-09-14 adversarial review · stance target resolution has no addressed read: [ticket](tickets/stance-target-resolution-has-no-addressed-route.md).
- [open] oi-188 · publication render · 2026-09-14 adversarial review · svg paint scope and member byte charging are still unowned: [ticket](tickets/deferred-unit-resources-lack-paint-scope-and-byte-charge.md).
- [open] oi-189 · hard-cut cleanliness · 2026-09-14 adversarial review · dead error codes, types and helpers left by the reader retirement: [ticket](tickets/retired-reader-surface-orphans.md).
- [open] oi-190 · overrides · 2026-09-14 adversarial review · three lint suppressions omit the repository-standard justification token: [ticket](tickets/lint-suppressions-missing-justification.md).
- [open] oi-191 · publication preparation · 2026-09-14 adversarial review · every prepared member takes the media row lock and enqueues its own job: [ticket](tickets/publication-member-preparation-reservation-flood.md).
- [open] oi-192 · publication schema · 2026-09-14 adversarial review · a changed title still copies every unit's text: [ticket](tickets/publication-content-identity-split.md).
- [open] oi-193 · pdf highlights · 2026-09-14 adversarial review · the paint page budget re-serializes the page per candidate row: [ticket](tickets/pdf-paint-page-budget-is-measured-quadratically.md).
- [open] oi-194 · epub ingest · 2026-09-14 adversarial review · the svg asset sanitizer screens by value, not by an allowlist: [ticket](tickets/epub-svg-asset-sanitizer-lacks-an-attribute-allowlist.md).
- [open] oi-195 · foreground image memory · 2026-09-14 adversarial review · epub asset and oracle plate reads still hold the whole object: [ticket](tickets/publication-asset-reads-materialize-whole-objects.md).
- [open] oi-196 · reader progress · 2026-09-14 adversarial review · the retired offline identity survives in bff constants and two proof modules: [ticket](tickets/reader-progress-identity-leftovers.md).
- [open] oi-197 · browser artwork memory · 2026-09-14 adversarial review · residency charges decoded pixels only, not the retained png derivative: [ticket](tickets/artwork-residency-ignores-its-encoded-derivative.md).
- [open] oi-198 · client transport · 2026-09-14 adversarial review · the client still retries every 5xx, including deterministic refusals: [ticket](tickets/blanket-5xx-retry-rule-survives-the-terminal-code-cut.md).
- [open] oi-199 · media pane proofs · 2026-09-14 adversarial review · four fixed pane defects have no proof for want of a fixture: [ticket](tickets/media-pane-proof-fixture-lacks-pdf-and-transcript-surfaces.md).
- [open] oi-200 · native offline reading · 2026-09-14 adversarial review · the publication verifier retains one identity per anchor and section: [ticket](tickets/native-publication-verifier-heap-scales-with-content.md).
- [open] oi-201 · native offline reading · 2026-09-14 adversarial review · the verifier's origin admission has three unmigrated call sites: [ticket](tickets/native-verifier-origin-admission-call-sites.md).
- [open] oi-202 · native offline reading proofs · 2026-09-14 adversarial review · three jvm fixtures no longer match the schema they construct: [ticket](tickets/native-test-fixtures-out-of-step-with-the-package-schema.md).
- [open] oi-203 · native offline conversion · 2026-09-14 adversarial review · schema-2 to schema-2 conversion still stages a full second copy: [ticket](tickets/native-schema-two-conversion-copies-the-whole-tree.md).
- [open] oi-204 · native transfer scheduling · 2026-09-14 adversarial review · a server capacity refusal does not honour its retry-after: [ticket](tickets/native-transfer-capacity-refusal-has-no-retry-after-floor.md).
- [open] oi-205 · native playback artwork · 2026-09-14 adversarial review · the over-limit refusal cannot be told from the absent-length refusal: [ticket](tickets/native-artwork-over-limit-shares-its-absent-length-message.md).
- [open] oi-206 · cross-language corpus · 2026-09-14 adversarial review · no producer archive exercises embed, svg-paint or schema-2 rejects: [ticket](tickets/native-producer-corpus-lacks-embed-svg-and-reject-vectors.md).
- [open] oi-207 · native table metadata · 2026-09-14 adversarial review · the table characterization workloads have no capacity owner: [ticket](tickets/native-table-characterization-capacity-entry.md).
- [open] oi-208 · offline delivery · 2026-09-14 adversarial review · the server preparation/status/transfer owner has no sensitivity witness: [ticket](tickets/offline-package-delivery-has-no-registered-product-fault.md).
- [open] oi-209 · offline delivery · 2026-09-14 adversarial review · archive preparation has no committed per-attempt budget: [ticket](tickets/offline-preparation-has-no-committed-attempt-budget.md).
- [open] oi-210 · x ingest · 2026-09-14 adversarial review · the duplicate-media race is fixed but unproved: [ticket](tickets/x-duplicate-media-race-has-no-proof.md).
- [open] oi-211 · fixture provenance · 2026-09-14 adversarial review · the committed schema-2 corpus has no producer-agreement assertion: [ticket](tickets/cross-language-corpus-producer-agreement.md).
- [open] oi-212 · test controller · 2026-09-14 adversarial review · controller experiment limits reach every local-stack proof: [ticket](tickets/local-stack-proofs-inherit-controller-experiment-limits.md).

- [open] note source activation · accepted destination is not yet carried through note pulses: [ticket](tickets/note-source-pulse-pane-scope.md).
- [open] reader source delivery · 2026-09-14 review · pre-admission pending quotes have no payload owner: [ticket](tickets/reader-source-delivery-input-admission.md).

- [open] native metadata capacity · member count does not bound retained anchor records; maximum heap remains unqualified: [ticket](tickets/native-publication-metadata-memory-qualification.md).

- [open] indivisible grapheme capacity · accepted source can contain a grapheme larger than the candidate unit bound: [ticket](tickets/reader-indivisible-grapheme-capacity.md).

- source table sanitizer loses caption identity: [ticket](tickets/reader-source-table-caption-sanitizer-loss.md).
- hosted reader cache lacks account retirement: [ticket](tickets/hosted-reader-cache-account-retirement.md).

- release host parser temp ownership harness fails: [ticket](tickets/release-host-parser-temp-ownership-harness.md).

- [shared main deliberate fault mutation](tickets/shared-main-deliberate-fault-mutation.md): external sensitivity work can contaminate shared source snapshots.
- initial strict-mode replay proofs are nested below the fixture root: [ticket](tickets/browser-strict-mode-root-proof-gap.md).
- resource-action fixtures lack the required account cache: [ticket](tickets/resource-action-fixture-account-cache-composition.md).
- native main contains unreviewed source/proof deltas: [ticket](tickets/native-main-snapshot-review-gap.md).

- [open] text highlight selection · late acknowledgment clears a newer same-reader selection: [ticket](tickets/reader-text-highlight-late-ack-selection-loss.md).

- [open] text highlight completion · retired presentation discards a committed write result: [ticket](tickets/reader-text-highlight-late-ack-outcome-loss.md).

- [open] pdf loading · resource wrapper churn reopens an unchanged binary: [ticket](tickets/reader-pdf-resource-wrapper-reopens-source.md).

- [open] text selection links · late completion clears a later selection: [ticket](tickets/reader-selection-link-late-ack-selection-loss.md).


- packaged web ingest selects its Node path from the data environment: [ticket](tickets/worker-web-ingest-command-uses-data-environment.md).



- epub source preparation / worker memory: [ticket](tickets/reader-epub-source-worker-cgroup-ceiling.md).


- epub sanitizer discards caption semantics: [ticket](tickets/reader-epub-caption-sanitizer-loss.md).

- [open] reader link completion · late response clears a newer dialog and can install its old retry: [ticket](tickets/reader-link-late-response-replaces-session.md).
- [open] reader pending writes · completion closures retain source ranges after reader retirement: [ticket](tickets/reader-pending-write-retains-source-range.md).


- history recency sorts the retained corpus: [ticket](tickets/nexus-history-recency-sorts-retained-corpus.md).

- content indexing rejects an accepted unbroken source: [ticket](tickets/content-indexing-rejects-accepted-unbroken-source.md).


- accepted paragraph cardinality exceeds document-index spool and block retention: [ticket](tickets/content-indexing-paragraph-cardinality-exceeds-spool.md).

- bulk resource cleanup exceeds postgres stack depth: [ticket](tickets/resource-graph-bulk-cleanup-exceeds-postgres-stack.md).
- indexing publication blocks a job heartbeat: [ticket](tickets/content-indexing-publication-blocks-job-heartbeat.md).
- parent and child test processes deadlock on the shared heavy lock: [ticket](tickets/controller-parent-child-heavy-lock-deadlock.md).

- native progress-choice proof still corrupts the retired schema-one member: [ticket](tickets/native-progress-choice-proof-retains-schema-one-member.md).

- failed reader-layer rollback can retain a released prepared view: [ticket](tickets/reader-layer-rollback-retired-view.md).

- native conversion retains all fragment rows to close one cursor: [ticket](tickets/native-legacy-fragment-list-allocation.md).

- [epub retained canonical block corpus](tickets/epub-retains-canonical-block-corpus.md): body spooling leaves separator-sized block metadata and per-fragment ORM allocation unqualified.
- conversation context has no common fence with ephemeral target deletion: [ticket](tickets/conversation-context-can-race-resource-death.md).

- native reconciliation can orphan its claimed run when its initial sqlite-backed notification fails; see [ticket](tickets/native-reconciliation-start-can-orphan-claimed-run.md).

- native job reconciliation reads sqlite before its owned failure boundary; see [ticket](tickets/native-reconciliation-job-fast-path-reads-before-owned-boundary.md).


- immutable member stream retirement lacks explicit storage-body close ownership: [ticket](tickets/immutable-member-stream-close-ownership.md).

- [open] oi-214 · foreground admission · 2026-09-14 bounded-workspace review · deadline cancellation lacks physical-worker lifetime proof: [ticket](tickets/read-deadline-can-retire-a-live-synchronous-worker.md).

- [open] oi-215 · foreground admission · 2026-09-14 bounded-workspace review · route-owned timeout can spin the admitted event loop: [ticket](tickets/read-admission-confuses-route-timeout-with-permit-expiry.md).

- [open] oi-216 · test controller · 2026-09-14 bounded-workspace review · bounded service logs discard the primary assertion: [ticket](tickets/controller-service-tail-loses-primary-assertion.md).
