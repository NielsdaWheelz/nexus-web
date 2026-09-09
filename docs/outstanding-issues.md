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

### [OPEN] OI-004 — An Imports invalidation unmounts the rows it is refreshing
frontend · opened 2026-09-08 by Claude (imports cutover, Track E) · P3
Every invalidation re-keys `useImportsPage`, so the visible rows unmount for one
round trip and any row-local state goes with them; the false empty state this
caused is fixed, the churn is not. See
[docs/tickets/imports-invalidation-unmounts-the-visible-rows.md](tickets/imports-invalidation-unmounts-the-visible-rows.md).

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

### [OPEN] OI-016 — The Imports pane body has no browser proof
frontend · opened 2026-09-08 by Claude (imports cutover, Track E) · P2
`ImportsPaneBody` composes the secondary group, the return-memento token and the
Account-menu mobile entrance, and no browser proof renders it: the mobile
list → detail → Back flow, the readiness gate and the mobile entrance are all
unproven. See
[docs/tickets/imports-inspector-mobile-sheet-dismissal-has-no-proof.md](tickets/imports-inspector-mobile-sheet-dismissal-has-no-proof.md).

### [OPEN] OI-017 — The Imports page read runs two statements under one snapshot
backend · opened 2026-09-08 by Claude (imports cutover, Track C2) · P3
`read_import_page` runs its CTE twice under the route's REPEATABLE READ
snapshot, and the service fixture cannot prove that isolation. See
[docs/tickets/imports-page-read-runs-two-statements-under-one-snapshot.md](tickets/imports-page-read-runs-two-statements-under-one-snapshot.md).

### [DEFERRED] OI-018 — Evaluate adopting llm-agent-kernel as the generation kernel
backend · opened 2026-09-06 by Claude (owner request, PR #203) · P3
Not adopted in PR #203; re-evaluate as its own hard cutover once the recorded
prerequisites exist. See
[docs/tickets/llm-agent-kernel-adoption.md](tickets/llm-agent-kernel-adoption.md).

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
The status CHECK admits a value nothing writes; migration 0225 is fail-closed
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

