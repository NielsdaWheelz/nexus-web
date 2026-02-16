# s4 pr-05 worklog

## purpose
capture bounded-context evidence gathered while authoring `s4_pr05.md`.

## acceptance checklist (source: `docs/v1/s4/s4_roadmap.md`)
- [x] all remaining closure-edge/backfill writer touchpoints are updated together (no mixed old/new closure behavior).
- [x] builds on pr-02 intrinsic write-through baseline; does not regress pr-02 rollout safety.
- [x] membership accept/remove and library media add/remove enforce intrinsic/closure/gc rules from spec.
- [x] backfill worker task implements idempotent materialization and state transitions with atomic claim + status guards.
- [x] worker enforces tuple integrity and strict-revocation lock protocol.
- [x] automatic retries follow fixed delay schedule exactly with delay index semantics `delay[attempts-1]`.
- [x] queue topology remains `ingest` for s4 mvp with explicit backlog guardrails.
- [x] internal operator endpoint implemented:
  - [x] `POST /internal/libraries/backfill-jobs/requeue`
- [x] requeue endpoint semantics are explicit:
  - [x] `running` job -> `200` idempotent no-op (`idempotent=true`, `enqueue_dispatched=false`)
  - [x] `pending|failed|completed` -> `pending` + attempts reset + re-enqueue attempt
- [x] requeue endpoint response exposes operator state fields.
- [x] internal endpoint requires normal internal-header auth path; no public bff proxy route added.
- [x] tests cover:
  - [x] writer-path consistency (`test_libraries.py`, `test_upload.py`, `test_from_url.py`, `test_ingest_web_article.py`)
  - [x] backfill state machine/requeue behavior (new dedicated test module), including tuple-integrity and enqueue-failure cases

## evidence log
| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | roadmap acceptance extraction | `docs/v1/s4/s4_roadmap.md` | 215-246 | extracted pr-05 goal, dependencies, acceptance bullets, and non-goal for scaffold alignment. | seeded checklist and traceability rows for all l3 acceptance bullets. |
| e-002 | l2 requeue endpoint contract anchor | `docs/v1/s4/s4_spec.md` | 812-851 | internal endpoint auth boundary, request shape, and idempotent behavior are normative in l2. | anchored pr-05 endpoint cluster and no-bff constraint. |
| e-003 | l2 closure/worker contract anchor | `docs/v1/s4/s4_spec.md` | 855-919 | closure write rules, gc rule, worker behavior, retry delays, and idempotency are explicit. | anchored writer-path and worker clusters for phase 2 expansion. |
| e-004 | non-default add path currently misses closure-edge writes | `python/nexus/services/libraries.py` | 299-389 | `add_media_to_library` materializes default `library_media` rows but never writes `default_library_closure_edges`. | required shared closure helper and no mixed writer behavior. |
| e-005 | default remove behavior currently contradicts s4 section 7 | `python/nexus/services/libraries.py` | 478-517 | default remove cascades to single-member non-default libraries and deletes default row directly. | forced intrinsic+gc-only behavior and test rewrites. |
| e-006 | membership removal currently lacks closure and backfill cleanup | `python/nexus/services/libraries.py` | 815-885 | member deletion only removes `memberships` row. | added membership-removal cleanup and durable row delete deliverables. |
| e-007 | accept flow already upserts durable backfill row | `python/nexus/services/libraries.py` | 1174-1329 | invite accept resets/creates `default_library_backfill_jobs` row and calls enqueue hook post-commit. | pr-05 can build worker semantics without redesigning accept transaction. |
| e-008 | enqueue hook currently non-operational | `python/nexus/services/libraries.py` | 1470-1501 | `_enqueue_default_library_backfill_job` logs and returns `False`. | required concrete enqueue implementation in shared closure module. |
| e-009 | closure-edge table is read-only in app code today | `python/nexus/auth/permissions.py` | 49-89 | `can_read_media` reads closure edges but writers do not maintain them. | forced full writer touchpoint update set. |
| e-010 | upload writer path duplicates default intrinsic behavior | `python/nexus/services/upload.py` | 187-207, 477-516 | upload path and helper both write default materialization + intrinsic rows directly. | required central helper ownership for provenance writes. |
| e-011 | from-url path depends on upload default attach helper | `python/nexus/services/media.py` | 183-214 | provisional web article creation calls `_ensure_in_default_library`. | pr-05 must preserve path while de-duplicating helper logic. |
| e-012 | ingest dedupe path duplicates winner attach+intrinsic writes | `python/nexus/tasks/ingest_web_article.py` | 265-337 | duplicate handler directly inserts default `library_media` + intrinsic rows. | required migration to shared provenance helper. |
| e-013 | worker registry currently lacks backfill task wiring | `python/nexus/tasks/__init__.py`; `apps/worker/main.py`; `python/nexus/celery.py`; `docker/Dockerfile.worker` | tasks 1-20; worker 31-55; celery 37-43; docker 114-116 | only ingest task is wired and ingest queue is worker default. | locked queue decision to `ingest`, required explicit task route/import updates. |
| e-014 | internal auth boundary is middleware-level policy | `python/nexus/auth/middleware.py`; `python/nexus/config.py` | middleware 143-189; config 146-158 | `X-Nexus-Internal` enforcement is centralized based on environment. | locked no route-local auth fork decision. |
| e-015 | api router lacks internal-libraries registration | `python/nexus/api/routes/__init__.py` | 10-40 | no `internal_libraries` router included. | added route module + router registration deliverables. |
| e-016 | route registration patterns include one historical app-level exception | `python/nexus/app.py`; `python/nexus/api/routes/stream_tokens.py` | app 239-246; stream_tokens 21 | `/internal/stream-tokens` is app-level include, unlike router factory routes. | decision explicitly records exception and sets standard for new internal routes. |
| e-017 | legacy tests still encode pre-s4 default-remove cascade | `python/tests/test_libraries.py` | 714-808, 3065-3116 | tests assert default remove deletes from non-default libraries. | forced removal/rewrite of cascade expectations. |
| e-018 | no dedicated backfill worker/requeue test module exists | `python/tests/` | file inventory + grep | current tests cover invite-row upsert but not worker/requeue state machine. | required new `test_default_library_backfill.py` deliverable. |
| e-019 | sdlc decision-quality requirements were not fully satisfied in previous ledger | `docs/v1/sdlc/README.md` | 100-147 | companion artifacts require owner/defaults and decision-quality fields (problem, alternatives, invariant impact, test impact). | rewrote `s4_pr05_decisions.md` with explicit runtime-only decision schema. |
| e-020 | l2 contract previously underspecified requeue payload and worker concurrency mechanics | `docs/v1/s4/s4_spec.md` | 812-919 | prior text lacked operator response fields and precise atomic/guarded transition semantics. | patched l2 before l4 to prevent silent contract drift. |
| e-021 | l3 acceptance previously did not carry guardrails/tuple integrity/expanded response fields | `docs/v1/s4/s4_roadmap.md` | 229-244 | prior acceptance bullets were directionally correct but under-specified. | patched l3 acceptance to lock expected implementation and tests. |
| e-022 | no static assertion existed for "no public bff proxy" internal-route constraint | `apps/web/src/app/api/**`; `docs/v1/s4/s4_spec.md` | file inventory; spec 820-823 | internal endpoint must not be proxied through next.js api routes. | added dedicated static assertion test requirement. |
| e-023 | previous l4 decision summary was drifted vs decision companion file | `docs/v1/s4/s4_prs/s4_pr05.md`; `docs/v1/s4/s4_prs/s4_pr05_decisions.md` | previous draft tables | l4 summary omitted several locked decisions and lacked id parity. | rewrote l4 decision ledger to mirror companion decisions. |

## notes
- phase 1 complete: pr-05 skeleton + companion files created.
- phase 2 clusters complete: writer-path drift, worker wiring constraints, and test-suite gaps captured.
- phase 3 complete: roadmap completeness, boundary cleanup, ambiguity cleanup, and dependency sanity applied.
- phase 4 hardening complete: l2/l3/l4 alignment patch, decision quality upgrade, and traceability update for all approved gaps.
