# s4 pr-06 worklog

## purpose
capture bounded-context evidence gathered while authoring `s4_pr06.md`.

## acceptance checklist (source: `docs/v1/s4/s4_roadmap.md`)
- [x] `GET /conversations` supports `scope=mine|all|shared`, default `mine`.
- [x] invalid conversation scope input is deterministic:
  - [x] `GET /conversations?scope=<invalid>` returns `400 E_INVALID_REQUEST` (not framework `422`).
- [x] `GET /conversations/{id}` and `GET /conversations/{id}/messages` allow shared readers via canonical visibility.
- [x] write/send/delete endpoints remain owner-only.
- [x] conversation endpoints consume pr-02 canonical helpers; no ad-hoc duplicate read-auth sql paths.
- [x] share endpoints implemented:
  - [x] `GET /conversations/{conversation_id}/shares`
  - [x] `PUT /conversations/{conversation_id}/shares`
- [x] share target default-library prohibition enforced with `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN`.
- [x] `ConversationOut` includes `owner_user_id` and `is_owner` across all serialized conversation payloads (including send-message responses).
- [x] add matching next.js bff proxy route for conversation share endpoints.
- [x] tests updated in `python/tests/test_conversations.py`, `python/tests/test_shares.py`, and send-message tests where conversation payload is returned.

## evidence log
| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | roadmap acceptance extraction | `docs/v1/s4/s4_roadmap.md` | 260-287 | pr-06 goal, acceptance bullets, and non-goal were extracted verbatim for scaffold alignment. | seeded traceability matrix rows and test clusters. |
| e-002 | l2 conversation scope/read contract | `docs/v1/s4/s4_spec.md` | 696-732 | l2 defines `scope=mine|all|shared`, deterministic ordering/cursor, shared-read endpoints, and owner-only writes. | locked list/read/write scope and non-goal boundaries. |
| e-003 | l2 share endpoint + default-library prohibition contract | `docs/v1/s4/s4_spec.md` | 733-757 | l2 defines share endpoint request and forbids default-library targets with explicit error code. | forced explicit share route deliverables and prohibition tests. |
| e-004 | l2 `ConversationOut` additive schema contract | `docs/v1/s4/s4_spec.md` | 188-203 | `owner_user_id` + `is_owner` are required in all serialized conversation payloads, including embedded send-message payloads. | required schema + constructor-path updates and send-message assertions. |
| e-005 | l2 masking/error policy anchor | `docs/v1/s4/s4_spec.md` | 946-979 | normative masking policy distinguishes visibility (`404`) vs capability (`403`), and `E_OWNER_REQUIRED` is a valid s4 code. | resolved share-endpoint non-owner behavior to `403 E_OWNER_REQUIRED` for visible conversations. |
| e-006 | acceptance scenario anchors | `docs/v1/s4/s4_spec.md` | 1072-1149 | scenario 7 requires shared-read success and scenario 11 requires deterministic list ordering/cursor behavior. | reinforced scope/list/read test coverage requirements. |
| e-007 | route baseline missing scope + share endpoints | `python/nexus/api/routes/conversations.py` | 44-68, 87-160 | `GET /conversations` has no `scope` query and no `/conversations/{id}/shares` handlers exist. | required route contract expansion deliverables. |
| e-008 | service baseline has owner-only list path and incomplete `ConversationOut` shape | `python/nexus/services/conversations.py` | 170-178, 243-331 | list query filters `owner_user_id = :viewer_id`; constructor omits `owner_user_id` and `is_owner`. | required scope-aware list logic and constructor updates. |
| e-009 | share service baseline has no route-facing owner checks/default-library prohibition and owns commits | `python/nexus/services/shares.py` | 65-145, 198-309 | helpers do not enforce visible-vs-owner split for route context, do not block default libraries explicitly, and call `db.commit()` internally. | required owner-scoped API functions, prohibition handling, and transaction ownership cleanup. |
| e-010 | conversation schema baseline lacks required additive fields and share request/response models | `python/nexus/schemas/conversation.py` | 31-44, 86-147 | no `owner_user_id`/`is_owner`; no share-route schema types available. | required schema additions and re-exports. |
| e-011 | send-message response path depends on shared conversation constructor | `python/nexus/services/send_message.py` | 748-749, 847-848 | send-message returns `conversation_to_out(...)` output, so additive `ConversationOut` fields must flow through this path. | required explicit send-message test coverage for new fields. |
| e-012 | bff baseline lacks conversation share proxy and existing proxy tests provide template | `apps/web/src/app/api/conversations`; `apps/web/src/app/api/libraries/invites-routes.test.ts` | inventory; 1-82 | no `[id]/shares` route exists; invite proxy tests define expected route-test pattern. | required new bff proxy route + dedicated proxy tests. |
| e-013 | existing tests encode owner-only list/read assumptions and need pr-06 updates | `python/tests/test_conversations.py`; `python/tests/test_shares.py`; `python/tests/test_send_message.py` | conversations 162-706; shares 1-331; send_message 302-413 | conversations tests currently assert owner-only visibility; share tests are service-only invariants; send-message tests do not assert owner fields. | required explicit test updates across all three modules per roadmap acceptance. |
| e-014 | l3 dependency contradiction was present for pr-06 | `docs/v1/s4/s4_roadmap.md` | 264, 360 | pr-06 entry listed `pr-02, pr-04` while dependency graph listed `pr-02 -> pr-06`. | patched roadmap dependency to `pr-02` before finalizing l4 to avoid phantom dependency drift. |
| e-015 | first pr-06 draft left share-route response shape ambiguous | `docs/v1/s4/s4_spec.md`; `docs/v1/s4/s4_prs/s4_pr06.md` | spec 733-757; draft decision table | l2 defines route existence/rules but not explicit response schema, leaving GET/PUT share payload drift risk. | added `ConversationSharesOut` and locked both share routes to that schema. |
| e-016 | first pr-06 draft did not explicitly forbid post-limit filtering for scope pagination | `docs/v1/s4/s4_spec.md`; `python/nexus/services/conversations.py`; `docs/v1/s4/s4_prs/s4_pr06.md` | spec 709-713; svc 243-331 | global cursor invariants can be violated if visibility filtering happens after `LIMIT` in mixed-visibility scopes. | added explicit SQL-before-limit filtering constraint and dedicated mixed-visibility matrix test requirement. |
| e-017 | first pr-06 draft had decision-id parity drift between spec and companion ledger | `docs/v1/s4/s4_prs/s4_pr06.md`; `docs/v1/s4/s4_prs/s4_pr06_decisions.md` | decision tables | spec decision table omitted one companion decision, risking audit drift during implementation. | synchronized decision ids and content across normative spec and companion ledger. |
| e-018 | conversation scope validation remained framework-dependent and could leak non-contract `422` | `docs/v1/s4/s4_spec.md`; `docs/v1/s4/s4_roadmap.md`; `python/nexus/errors.py`; `docs/v1/s4/s4_prs/s4_pr06.md` | spec 698-717; roadmap 273-286; errors 39,131; l4 decision/traceability sections | existing docs allowed implicit enum validation behavior without explicit API-level status determinism. | locked strict contract: invalid scope => `400 E_INVALID_REQUEST`, never `422`, with explicit route/service/tests requirements. |

## notes
- phase 1 complete: pr-06 normative spec scaffold + companion artifacts created.
- phase 2 complete: forced decisions captured for scope semantics, owner-gated share behavior, atomic replacement, and transaction ownership.
- phase 3 complete: traceability matrix now covers every pr-06 acceptance bullet with at least one planned automated test.
- phase 3 complete: roadmap dependency contradiction resolved before l4 lock-in.
- phase 4 critical pass complete: resolved response-schema ambiguity, cursor-filter correctness constraint, and decision-ledger parity drift.
- phase 5 determinism hardening complete: invalid-scope behavior is now explicitly contract-locked across l2/l3/l4.
