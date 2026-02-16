# s4 pr roadmap

implements `docs/v1/s4/s4_spec.md` in a dependency-safe sequence.

## baseline we are building from

- current alembic head is `0006` (`down_revision = "0005"`), so s4 migration is `0007`.
- current gaps are real and confirmed in code:
  - no invite/member/ownership-transfer routes in `python/nexus/api/routes/libraries.py`.
  - no conversation share routes in `python/nexus/api/routes/conversations.py`.
  - conversation read helper is owner-only in `python/nexus/services/conversations.py`.
  - highlight read helper is owner-only in `python/nexus/services/highlights.py`.
  - search auth is inconsistent with shared-read requirements in `python/nexus/services/search.py`.
  - media visibility predicate is still plain membership join in `python/nexus/auth/permissions.py`.
  - multi-member delete guard still exists in `python/nexus/services/libraries.py`.

## locked pre-l4 decisions

1. one migration pr for full s4 schema + indexes + deterministic seed.
2. additive-only compatibility for existing endpoint contracts unless s4 spec explicitly changes them.
3. `GET /search` response shape stays `{ results, page }` in s4.
4. internal operator requeue endpoint is implemented in fastapi; no next.js `/api/*` proxy route for it in s4.
5. all new public fastapi endpoints get matching next.js bff proxy routes in the same pr.
6. no stale duplicate visibility helpers at slice end.

## ownership matrix (endpoint/table/helper -> pr)

| surface | owning pr |
|---|---|
| s4 migration `0007` + new tables + indexes + seed | pr-01 |
| s4 error codes | pr-01 |
| canonical visibility predicates and helper replacement | pr-02 |
| rollout-safe default-library intrinsic write-through on existing writer touchpoints | pr-02 |
| library delete owner-only + member management + transfer ownership | pr-03 |
| library invite lifecycle endpoints | pr-04 |
| closure-edge materialization + backfill job mechanics across writer paths | pr-05 |
| internal requeue endpoint `/internal/libraries/backfill-jobs/requeue` | pr-05 |
| conversation read scopes + share endpoints + `ConversationOut` additive fields | pr-06 |
| highlight shared read + mine_only default + `HighlightOut` additive fields | pr-07 |
| search predicate alignment + library-scope message search | pr-08 |
| full acceptance matrix + compatibility and helper-retirement audit | pr-09 |

## helper retirement targets (must be resolved by pr-09)

- `python/nexus/services/conversations.py`:
  - replace owner-only read gate `get_conversation_for_viewer_or_404` with explicit split:
    - visible-read helper
    - owner-write helper
- `python/nexus/services/highlights.py`:
  - replace owner-only read gate `get_highlight_for_viewer_or_404` with explicit split:
    - visible-read helper
    - author-write helper
- `python/nexus/services/search.py`:
  - remove direct coupling to owner-only conversation helper for scope auth.

## retry orchestration (fixed for s4 mvp)

automatic retry orchestration for backfill jobs is worker-driven and deterministic:

- delay schedule: `[60, 300, 900, 3600, 21600]` seconds.
- on worker failure:
  1. transition `running -> failed`, increment `attempts`, store `last_error_code`.
  2. if `attempts < 5`, transition `failed -> pending` and enqueue task with `countdown = delay[attempts-1]`.
  3. if `attempts >= 5`, leave job `failed` (terminal) until explicit operator requeue.
- explicit requeue endpoint resets attempts and returns job to `pending`.

## pr sequence

## pr-01: schema + error contract ✅

goal: land s4 data contract atomically and make errors/types available to later prs.

status: **implemented**. migration 0007, ORM models, error codes, schemas, and all 8 migration tests pass.

dependencies: none.

primary surfaces:
- `migrations/alembic/versions/0007_slice4_library_sharing.py`
- `python/nexus/db/models.py`
- `python/nexus/errors.py`
- `python/nexus/schemas/library.py` (new invite/member models)

acceptance:
- migration revision is `0007`, `down_revision` is `0006`.
- migration creates:
  - `library_invitations`
  - `default_library_intrinsics`
  - `default_library_closure_edges`
  - `default_library_backfill_jobs`
- migration adds supporting indexes on `memberships`, `library_media`, `conversation_shares`.
- seed logic from s4 spec section 3.7 runs deterministically and is idempotent.
- s4 error codes are present in enum + status map.
- `make test-migrations` passes.
- `python/tests/test_errors.py` covers new code/status mappings.

non-goals:
- no endpoint behavior changes.
- no visibility predicate rewrites.

## pr-02: canonical visibility predicates + auth base refactor ✅

goal: land the internal auth kernel for s4 visibility so later prs can switch public read contracts without duplicated auth logic.

status: **implemented**. s4 provenance predicates, helper split, intrinsic write-through, and all acceptance tests pass (816 passed).

dependencies: pr-01.

primary surfaces:
- `python/nexus/auth/permissions.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/search.py` (helper coupling cleanup only; no behavior change)
- `python/nexus/services/upload.py`
- `python/nexus/services/libraries.py`
- `python/nexus/tasks/ingest_web_article.py`

acceptance:
- `can_read_media` implements s4 provenance rules (non-default membership, intrinsic, active closure edge).
- conversation helper split is complete:
  - canonical visible-read helper exists for conversation/message visibility checks.
  - owner-write helper exists for mutation endpoints.
- highlight helper split is complete:
  - canonical visible-read helper exists for highlight/annotation visibility checks.
  - author-write helper for mutations.
- strict revocation is proven with internal tests: membership/share revocation flips helper/predicate outcomes immediately after commit.
- no duplicate owner-only read helper paths remain for domains touched in this pr.
- `python/nexus/services/search.py` no longer depends on deprecated/ambiguous conversation read helper names.
- search behavior remains unchanged in pr-02 (no scope/query/output contract changes).
- default-library writer touchpoints touched in this pr are intrinsic-write-through safe:
  - upload init + dedupe winner ensure path
  - provisional from-url media creation path
  - ingest dedupe winner attach path
  - explicit default-library add/remove path in libraries service
- `python/tests/test_permissions.py` and new/updated helper-level tests pass.

non-goals:
- no public endpoint contract/behavior changes yet (`/conversations*`, `/highlights*`, `/search` remain externally unchanged in this pr).
- no invite/member routes yet.
- no response schema shape changes yet.

## pr-03: library governance (owner boundary + members + transfer) ✅

goal: enforce owner/admin separation and owner-exit constraints for library containers.

status: **implemented**. owner-only delete, member management endpoints, ownership transfer, invariant repair, and all acceptance tests pass (853 passed).

dependencies: pr-01, pr-02.

primary surfaces:
- `python/nexus/services/libraries.py`
- `python/nexus/api/routes/libraries.py`
- `python/nexus/schemas/library.py`
- `python/nexus/schemas/__init__.py`
- `python/nexus/errors.py`
- `apps/web/src/app/api/libraries/**` (new bff proxy routes)
- `apps/web/src/app/(authenticated)/libraries/page.tsx`

acceptance:
- remove old multi-member delete prohibition; container delete is owner-only.
- non-owner admin delete returns `403 E_OWNER_REQUIRED`.
- implement member endpoints:
  - `GET /libraries/{library_id}/members`
  - `PATCH /libraries/{library_id}/members/{user_id}`
  - `DELETE /libraries/{library_id}/members/{user_id}`
- implement ownership transfer endpoint:
  - `POST /libraries/{library_id}/transfer-ownership`
- enforce owner non-removable/non-demotable-before-transfer behavior with `E_OWNER_EXIT_FORBIDDEN`.
- enforce `E_LAST_ADMIN_FORBIDDEN` and default-library member mutation prohibition.
- add matching next.js bff proxy routes for new public library endpoints.
- `python/tests/test_libraries.py` covers these contracts.

non-goals:
- no invite lifecycle endpoints.
- no closure backfill worker logic.

## pr-04: invitation lifecycle ✅

goal: implement user-id invite lifecycle with atomic accept semantics.

status: **implemented**. all 6 invite endpoints, atomic accept with backfill job upsert, idempotent state transitions, BFF proxy routes, and 30 integration tests pass (878 total backend passed).

dependencies: pr-01, pr-03.

primary surfaces:
- `python/nexus/schemas/library.py` (new invite request/response schemas)
- `python/nexus/schemas/__init__.py` (re-exports)
- `python/nexus/services/libraries.py` (invite service functions)
- `python/nexus/api/routes/libraries.py` (invite route handlers)
- `apps/web/src/app/api/libraries/[id]/invites/route.ts` (BFF proxy)
- `apps/web/src/app/api/libraries/invites/route.ts` (BFF proxy)
- `apps/web/src/app/api/libraries/invites/[inviteId]/accept/route.ts` (BFF proxy)
- `apps/web/src/app/api/libraries/invites/[inviteId]/decline/route.ts` (BFF proxy)
- `apps/web/src/app/api/libraries/invites/[inviteId]/route.ts` (BFF proxy)
- `apps/web/src/app/api/libraries/invites-routes.test.ts` (BFF proxy tests)
- `python/tests/test_libraries.py` (30 new invite tests)

acceptance:
- implement endpoints:
  - `POST /libraries/{library_id}/invites`
  - `GET /libraries/{library_id}/invites`
  - `GET /libraries/invites`
  - `POST /libraries/invites/{invite_id}/accept`
  - `POST /libraries/invites/{invite_id}/decline`
  - `DELETE /libraries/invites/{invite_id}`
- accept flow transactionally performs invite lock + state check + membership upsert + invite update + backfill-job upsert.
- idempotent semantics for accept/decline/revoke match spec.
- default-library invite target forbidden.
- invitee lookup is user-id only with `404 E_USER_NOT_FOUND`.
- add matching next.js bff proxy routes for invite endpoints.
- new integration tests (or extension of `python/tests/test_libraries.py`) cover invite transitions and error masking.

non-goals:
- no closure materialization worker implementation.

## pr-05: closure materialization + backfill worker + internal requeue

goal: make closure invariants true across all writer paths and make failure recovery operational.

dependencies: pr-01, pr-02, pr-04.

primary surfaces:
- `python/nexus/services/libraries.py`
- `python/nexus/services/upload.py`
- `python/nexus/services/media.py`
- `python/nexus/tasks/ingest_web_article.py`
- new backfill task/service modules
- new internal route module + app registration

acceptance:
- all remaining closure-edge/backfill writer touchpoints are updated together (no mixed old/new closure behavior).
- builds on pr-02 intrinsic write-through baseline; does not regress pr-02 rollout safety.
- membership accept/remove and library media add/remove enforce intrinsic/closure/gc rules from spec.
- backfill worker task implements idempotent materialization and state transitions with:
  - atomic single-statement claim (`pending -> running`)
  - status-guarded completion/failure updates (`WHERE status='running'`)
- worker enforces tuple integrity and strict-revocation lock protocol:
  - `(default_library_id, source_library_id, user_id)` must be structurally valid
  - membership lock/read gates closure materialization to prevent revoke race reintroduction
- automatic retries follow fixed delay schedule exactly with delay index semantics `delay[attempts-1]` after increment.
- queue topology remains `ingest` for s4 mvp, with explicit backlog guardrails:
  - degraded if pending age p95 > 900s for 15m, or pending count > 500 for 15m.
- internal operator endpoint implemented:
  - `POST /internal/libraries/backfill-jobs/requeue`
- requeue endpoint semantics are explicit:
  - `running` job -> `200` idempotent no-op (`idempotent=true`, `enqueue_dispatched=false`)
  - `pending|failed|completed` -> `pending` + attempts reset + re-enqueue attempt
- requeue response exposes operator state fields:
  - `status`, `attempts`, `last_error_code`, `updated_at`, `finished_at`, `idempotent`, `enqueue_dispatched`
- internal endpoint requires normal internal-header auth path; no public bff proxy route added.
- tests cover:
  - writer-path consistency (`test_libraries.py`, `test_upload.py`, `test_from_url.py`, `test_ingest_web_article.py`)
  - backfill state machine/requeue behavior (new dedicated test module), including:
    - tuple-integrity failures
    - enqueue-failure-after-state-commit behavior
    - no-public-bff-proxy assertion for internal requeue route

non-goals:
- no frontend/ux operator tooling.

## pr-06: conversation shared-read + share routes

goal: align conversation read contracts with s4 visibility while keeping writes owner-only.

dependencies: pr-02, pr-04.

primary surfaces:
- `python/nexus/services/conversations.py`
- `python/nexus/services/shares.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/schemas/conversation.py`
- `apps/web/src/app/api/conversations/**` (new share bff proxy route)

acceptance:
- `GET /conversations` supports `scope=mine|all|shared`, default `mine`.
- `GET /conversations/{id}` and `GET /conversations/{id}/messages` allow shared readers via canonical visibility.
- write/send/delete endpoints remain owner-only.
- conversation endpoints consume pr-02 canonical helpers; no ad-hoc duplicate read-auth sql paths.
- share endpoints implemented:
  - `GET /conversations/{conversation_id}/shares`
  - `PUT /conversations/{conversation_id}/shares`
- share target default-library prohibition enforced with `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN`.
- `ConversationOut` now includes `owner_user_id` and `is_owner` across all serialized conversation payloads (including send-message responses).
- add matching next.js bff proxy route for conversation share endpoints.
- tests updated in `python/tests/test_conversations.py`, `python/tests/test_shares.py`, and send-message tests where conversation payload is returned.

non-goals:
- no multi-author conversation writes.

## pr-07: highlight shared-read contract

goal: expose shared highlight reads while preserving author-only mutation.

dependencies: pr-02.

primary surfaces:
- `python/nexus/services/highlights.py`
- `python/nexus/api/routes/highlights.py` and/or fragment highlight route module
- `python/nexus/schemas/highlights.py`

acceptance:
- `GET /fragments/{fragment_id}/highlights` supports `mine_only` with default `true`.
- `mine_only=false` returns visible shared highlights under canonical predicate.
- `GET /highlights/{highlight_id}` supports shared readers under canonical predicate.
- mutation endpoints remain author-only with masked 404 semantics.
- highlight endpoints consume pr-02 canonical helpers; no ad-hoc duplicate read-auth sql paths.
- `HighlightOut` includes `author_user_id` and `is_owner`.
- tests updated in `python/tests/test_highlights.py` and `python/tests/test_web_article_highlight_e2e.py`.

non-goals:
- no annotation mutation model changes.

## pr-08: search alignment

goal: make search auth exactly match primary read contracts and enable library-scope message results.

dependencies: pr-02, pr-06, pr-07.

primary surfaces:
- `python/nexus/services/search.py`
- `python/nexus/api/routes/search.py` (contract remains same shape)

acceptance:
- scope auth uses canonical visibility helpers, not owner-only read helper.
- annotation search visibility follows s4 highlight visibility, not owner-only filter.
- message search for `scope=library:*` is enabled and constrained to conversations shared to target library.
- unauthorized scope masking preserves existing typed 404 behavior:
  - `media:*` -> `E_NOT_FOUND`
  - `library:*` -> `E_NOT_FOUND`
  - `conversation:*` -> `E_CONVERSATION_NOT_FOUND`
- response shape remains `{ results, page }`.
- tests updated in `python/tests/test_search.py` for shared conversation scope, shared annotation visibility, and library-scope message constraints.

non-goals:
- no ranking/weighting/snippet algorithm changes.

## pr-09: hardening + acceptance matrix + l4 handoff gate

goal: prove s4 contract end-to-end and freeze clean handoff boundaries for individual pr specs.

dependencies: pr-01 through pr-08.

acceptance:
- s4 scenarios 1-15 are each mapped to at least one automated test, with traceability table in this pr description.
- route structure constraints still pass (`python/tests/test_route_structure.py`).
- compatibility audit confirms:
  - conversation/message list limits unchanged (`50`, bounds `1..100`)
  - search response shape unchanged
  - additive-only response evolution honored
- helper retirement audit confirms no stale duplicate visibility helpers remain.
- a short handoff note lists final `l4` spec inputs per pr (files, invariants, tests, non-goals).

non-goals:
- no new product surface.
- no opportunistic refactors unrelated to s4 invariants.

## dependency graph

`pr-01 -> pr-02 -> pr-03 -> pr-04 -> pr-05`

`pr-02 -> pr-06`

`pr-02 -> pr-07`

`pr-06 + pr-07 -> pr-08`

`pr-01..pr-08 -> pr-09`

## global non-goals

- email/link invites
- public libraries
- multi-author conversation writes
- search relevance redesign
- ui polish work outside required bff proxies
