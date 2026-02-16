# s4 pr-04 worklog

## purpose
capture bounded-context evidence gathered while authoring `s4_pr04.md`.

## acceptance checklist (source: `docs/v1/s4/s4_roadmap.md`)
- [ ] implement endpoints:
  - [ ] `POST /libraries/{library_id}/invites`
  - [ ] `GET /libraries/{library_id}/invites`
  - [ ] `GET /libraries/invites`
  - [ ] `POST /libraries/invites/{invite_id}/accept`
  - [ ] `POST /libraries/invites/{invite_id}/decline`
  - [ ] `DELETE /libraries/invites/{invite_id}`
- [ ] accept flow transactionally performs invite lock + state check + membership upsert + invite update + backfill-job upsert.
- [ ] idempotent semantics for accept/decline/revoke match spec.
- [ ] default-library invite target forbidden.
- [ ] invitee lookup is user-id only with `404 E_USER_NOT_FOUND`.
- [ ] add matching next.js bff proxy routes for invite endpoints.
- [ ] new integration tests (or extension of `python/tests/test_libraries.py`) cover invite transitions and error masking.

## evidence log
| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | roadmap acceptance extraction | `docs/v1/s4/s4_roadmap.md` | 176-205 | extracted pr-04 goal/dependencies/acceptance/non-goal verbatim for scaffold alignment. | froze l3 boundary and seeded traceability rows/checklist. |
| e-002 | endpoint contract source of truth | `docs/v1/s4/s4_spec.md` | 408-568 | six invite endpoints, auth/error envelopes, and endpoint-level status codes are explicitly defined in l2. | pinned pr-04 endpoint list and response-status expectations. |
| e-003 | route surface currently missing invites | `python/nexus/api/routes/libraries.py` | 60-222 | file has library, members, transfer, media routes only; no `/libraries/*invites*` endpoints exist. | added explicit invite route deliverables and route-ordering constraint. |
| e-004 | route shape pattern | `python/nexus/api/routes/libraries.py` | 1-29 | routes are transport-only and call service once, returning `success_response(...)`. | required same transport-only discipline for invite routes. |
| e-005 | service module ownership | `python/nexus/services/libraries.py` | 1-24, 657-984 | library governance/media logic is centralized here; no invite functions exist yet. | locked pr-04 decision to keep invite service functions in this module. |
| e-006 | invite db model + constraints available | `python/nexus/db/models.py` | 1048-1108 | `LibraryInvitation` exists with role/status/self/responded_at constraints. | avoided schema invention; spec uses existing model invariants. |
| e-007 | backfill job model exists for accept response payload planning | `python/nexus/db/models.py` | 1170-1225 | `DefaultLibraryBackfillJob` exists and is intended to be created on invite accept. | included accept response field `backfill_job_status` and deferred worker mechanics to later cluster. |
| e-008 | invite error codes already defined | `python/nexus/errors.py` | 35-54, 117-129 | invite-specific not-found/conflict codes are present and status-mapped. | no new error enum work required in pr-04 endpoint cluster. |
| e-009 | invitation schema gaps | `python/nexus/schemas/library.py` | 17-34, 122-134 | `LibraryInvitationOut` exists, but no invite request/accept/decline payload schemas exist. | added schema deliverables for invite request/action response contracts. |
| e-010 | schema re-export gap | `python/nexus/schemas/__init__.py` | 20-30, 38-50 | only `LibraryInvitationOut` is exported; no invite request/action schemas to export. | added `schemas/__init__.py` export-update deliverable. |
| e-011 | bff proxy conventions and missing invite parity | `apps/web/src/app/api/libraries/route.ts` | 1-11 | proxy-only pattern with `runtime = "nodejs"` and no domain logic. | copied same pattern for all invite bff routes. |
| e-012 | bff route topology baseline | `apps/web/src/app/api/libraries/[id]/route.ts` | 1-20 | existing dynamic id route handles library CRUD via passthrough. | selected `[id]/invites/route.ts` for per-library invite routes to preserve topology consistency. |
| e-013 | existing test harness location | `python/tests/test_libraries.py` | 1-28, 1068-1997 | integration harness + library governance tests already live here. | kept invite integration tests in same module for mvp locality. |
| e-014 | migration-level invitation constraints are already covered | `python/tests/test_migrations.py` | 1515-1657 | tests already validate pending-unique, responded_at consistency, and self-invite check constraints. | pr-04 integration tests can focus on endpoint behavior rather than duplicating migration-constraint tests. |
| e-015 | transaction helper contract | `python/nexus/db/session.py` | 60-91 | `transaction(db)` commits on success and rolls back on exception. | accept/decline/revoke specs use ordered in-transaction state transitions with rollback safety. |
| e-016 | existing lock/mutation pattern in library service | `python/nexus/services/libraries.py` | 724-871, 885-974 | governance mutations lock rows with `FOR UPDATE` and operate inside `transaction(db)`. | invite transitions adopt same lock-first mutation pattern to avoid races. |
| e-017 | existing async enqueue reliability pattern | `python/nexus/services/media.py` | 261-302 | enqueue helper is best-effort and non-fatal; failures are logged and endpoint continues. | accept post-commit backfill enqueue in pr-04 is specified as best-effort, with durable DB row as truth. |
| e-018 | current task registry lacks backfill worker task | `python/nexus/tasks/__init__.py` | 1-20 | only `ingest_web_article` is exported today; no backfill task available pre-pr-05. | pr-04 specifies enqueue as non-fatal hook and defers concrete worker implementation to pr-05. |
| e-019 | invite state-machine/idempotency rules | `docs/v1/s4/s4_spec.md` | 267-287, 1091-1113 | legal transitions + idempotent repeats + illegal transition code are explicit. | added explicit test matrix for accept/decline/revoke idempotency and `E_INVITE_NOT_PENDING` cases. |
| e-020 | invite masking/error invariants | `docs/v1/s4/s4_spec.md` | 921-943 | unknown/invisible invite => masked `E_INVITE_NOT_FOUND`; user lookup => `E_USER_NOT_FOUND`. | specified masked-not-found tests and user-id lookup test for create invite. |
| e-021 | bff unit-test harness availability | `apps/web/package.json` | 1-26 | web package uses `vitest` and already tests `src/lib/api/proxy.test.ts`. | made route-level bff parity tests explicit and feasible without introducing a new test runner. |
| e-022 | immediate-access invariant after accept | `docs/v1/s4/s4_spec.md` | 979-994 | scenario 1 requires membership and media access immediately after accept, before worker runs. | added explicit integration test for immediate post-accept read access without worker execution. |
| e-023 | self-invite constraint exists at db layer | `python/nexus/db/models.py` | 1094-1097 | invitation model has `inviter_user_id <> invitee_user_id` check constraint. | specified service-level conflict behavior to avoid leaking raw constraint errors. |
| e-024 | no generic integrity-error mapper in library service today | `python/nexus/services/libraries.py` | 1-984 | service currently relies on explicit pre-checks and targeted conflicts; no broad integrity mapper exists. | added explicit requirement to map only pending-invite unique-index race and avoid blanket remapping. |
| e-025 | create invite masked-not-found requirement | `docs/v1/s4/s4_spec.md` | 439-445, 921-930 | create invite must return masked `E_LIBRARY_NOT_FOUND` for non-members and reserve `E_USER_NOT_FOUND` for authorized path. | added explicit non-member masking test and auth-before-user-lookup decision. |

## notes
- phase 1 complete: pr-04 skeleton is created.
- phase 2 cluster 1 complete: endpoint surfaces (schemas/service/routes/bff/tests) specified with codebase evidence.
- phase 2 cluster 2 complete: transaction ordering, idempotency matrix, default-library guard, and user-id lookup contracts are now explicit in l4 spec.
- phase 2 complete: every l3 acceptance bullet now has concrete deliverables + planned tests in `s4_pr04.md`.
- phase 3 complete: ambiguity cleanup done; immediate-access invariant test added; scope remains within pr-04 ownership.
- open questions collapsed to none; decisions are fully represented in the decision ledger.
- final pass applied: duplicate-race handling, self-invite behavior, and explicit bff test naming are now unambiguous.
