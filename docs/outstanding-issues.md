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

- [open] oi-069 · reader interaction · 2026-09-11 council · implemented map controls await manual assistive-technology and actual-touch review: [ticket](tickets/reader-map-inert-position-and-mobile-controls.md).
- [open] oi-074 · test infrastructure · 2026-09-11 reader verification · host release harness cannot establish worker-owned parser directory: [ticket](tickets/test-host-release-worker-owner-privilege.md).
- [open] oi-075 · epub ingest · 2026-09-12 source review · decoded reserved delimiters make stored source urls ambiguous: [ticket](tickets/epub-normalized-href-reserved-delimiters.md).
- [open] oi-076 · import progress · 2026-09-12 source review · extraction progress calls spine files chapters: [ticket](tickets/epub-import-progress-counts-files-as-chapters.md).
- [open] oi-078 · web build · 2026-09-12 offline artifact · css minifier warns on existing custom-highlight syntax: [ticket](tickets/offline-css-minifier-rejects-highlight-syntax.md).
- [open] oi-079 · test controller · 2026-09-12 sensitivity · fault registry rejects literal next route brackets: [ticket](tickets/fault-registry-rejects-literal-route-brackets.md).
- [open] oi-080 · web ingest · 2026-09-12 source review · generated heading ids replace authored link and container targets: [ticket](tickets/web-ingest-replaces-authored-heading-anchors.md).
- [open] oi-081 · pdf activity · 2026-09-12 input review · zoom renews reading eligibility through the page-turn control wrapper: [ticket](tickets/pdf-zoom-renews-reading-activity.md).
