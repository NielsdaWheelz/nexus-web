# Slice 5 (EPUB) - Roadmap Ownership Ledger

This ledger is normative for PR ownership boundaries in `docs/v1/s5/s5_roadmap.md`.

## Ownership Rules

1. Each L2 contract cluster has exactly one owning PR.
2. Non-owning PRs may consume a contract surface but may not redefine its behavior.
3. If implementation reveals unavoidable overlap, split the cluster and update this ledger before coding.
4. PR-07 may harden and verify, but it may not expand feature scope.

## Cluster Ledger

| cluster id | contract cluster | L2 source sections | owning PR | boundary note |
|---|---|---|---|---|
| C1 | TOC persistence model and deterministic order key storage constraints | 2.2, 6.4, 6.13 | PR-01 | PR-02/PR-04 consume schema and ordering rules; they do not redefine schema semantics. |
| C2 | S5 API/error primitive registration (new error usage and stable status mapping) | 5 | PR-01 | PR-03/PR-04 enforce behavior invariants (including 6.15-6.16) using these primitives without changing error taxonomy or status semantics. |
| C3 | EPUB extraction artifact materialization (chapters, fragment blocks, TOC snapshot, title/resource rules, internal asset safe fetch path, archive safety validation) | 2.1-2.6, 3.1 guards, 4.8, 6.1-6.3, 6.12, 6.15-6.17 | PR-02 | PR-03 orchestrates state transitions around extraction and owns retry cleanup semantics (6.10); it does not redefine extraction outputs. |
| C4 | Upload-init/ingest/retry lifecycle orchestration and cleanup/reset semantics | 3.1, 4.1-4.3, 6.10, 6.16, 6.18-6.19 | PR-03 | PR-02 owns extraction behavior; PR-03 owns when/how extraction is entered and retried, including ingest idempotent re-entry and retry source-integrity gates, and how ingest/retry contracts are exposed. |
| C5 | Chapter + TOC read API behavior (ordering, pagination, navigation, readiness, visibility, kind guards) plus required BFF transport parity for non-streaming browser path | 4.4-4.6, 6.5, 6.9, 6.11, 6.13-6.14, L0 request topology | PR-04 | PR-05 consumes this surface in UI flows; it does not redefine endpoint/BFF contracts. |
| C6 | EPUB reader baseline UX adoption of chapter-first navigation | S5 goal/outcome alignment + read contracts | PR-05 | PR-05 is UI adoption only and must not change backend endpoint semantics. |
| C7 | Highlight/chat compatibility reuse on EPUB fragments | 4.7, 6.6-6.8 | PR-06 | PR-06 preserves existing contracts; any feature expansion is out of scope. |
| C8 | Slice-level acceptance closure and freeze gates | 6, 7, 8 | PR-07 | PR-07 is hardening-only and may only make minimal blocking fixes. |

## Dependency Commitments

- PR-01 is the only zero-dependency PR.
- PR-02 depends on PR-01.
- PR-03 depends on PR-01 and PR-02.
- PR-04 depends on PR-03.
- PR-05 depends on PR-04.
- PR-06 depends on PR-02 and PR-04.
- PR-07 depends on PR-03, PR-05, and PR-06.

## Drift Handling Policy

- If a PR uncovers contract drift in a cluster it does not own, stop and route the change to the owning PR.
- If drift invalidates L2 intent, fix L2 first, then regenerate L3/L4 downstream docs.
- If drift is purely implementation-local and does not alter cluster ownership, fix forward in the current owning PR.
