# s4 pr-07 worklog

## purpose
capture bounded-context evidence gathered while authoring `s4_pr07.md`.

## acceptance checklist (source: `docs/v1/s4/s4_roadmap.md`)
- [x] `GET /fragments/{fragment_id}/highlights` supports `mine_only` with default `true`.
- [x] `mine_only=false` returns visible shared highlights under canonical predicate.
- [x] `GET /highlights/{highlight_id}` supports shared readers under canonical predicate.
- [x] mutation endpoints remain author-only with masked 404 semantics.
- [x] highlight endpoints consume pr-02 canonical helpers; no ad-hoc duplicate read-auth sql paths.
- [x] `HighlightOut` includes `author_user_id` and `is_owner`.
- [x] tests updated in `python/tests/test_highlights.py` and `python/tests/test_web_article_highlight_e2e.py`.

## evidence log
| id | acceptance item | file | lines | evidence | impact on spec |
|---|---|---|---|---|---|
| e-001 | roadmap acceptance extraction | `docs/v1/s4/s4_roadmap.md` | 291-312 | pr-07 goal, dependencies, acceptance bullets, and non-goal were extracted as the ownership boundary. | seeded traceability rows and non-goal constraints. |
| e-002 | l2 highlight endpoint contract | `docs/v1/s4/s4_spec.md` | 764-789 | l2 defines `mine_only` default/behavior, shared point-read, and author-only mutation masking. | locked transport behavior and mutation invariants. |
| e-003 | l2 highlight schema contract | `docs/v1/s4/s4_spec.md` | 204-213 | `HighlightOut` must add `author_user_id` and `is_owner`, additive-only. | required schema + constructor updates across highlight-returning endpoints. |
| e-004 | l2 acceptance scenarios | `docs/v1/s4/s4_spec.md` | 1092-1121 | scenario 8 and 8b require shared highlight visibility with backward-compatible default mine-only list mode. | forced list/get shared-read test cluster in acceptance plan. |
| e-005 | route baseline missing `mine_only` query | `python/nexus/api/routes/highlights.py` | 67-88 | list route currently has no query param and no explicit input validation path. | required route-level query contract + deterministic validation decision. |
| e-006 | service baseline is owner-filtered list | `python/nexus/services/highlights.py` | 263-292 | list query filters `Highlight.user_id == viewer_id`, blocking shared-read list mode entirely. | required list query contract expansion for `mine_only=false`. |
| e-007 | canonical helper gap for list visibility reuse | `python/nexus/auth/permissions.py` | 211-253 | only point-read `can_read_highlight(...)` exists; no reusable sql predicate path for list query reuse. | forced decision to add canonical helper reuse surface. |
| e-008 | schema baseline missing additive fields | `python/nexus/schemas/highlights.py` | 41-63 | `HighlightOut` currently omits `author_user_id` and `is_owner`. | required additive schema patch and response constructor updates. |
| e-009 | tests encode pre-s4 owner-only assumption | `python/tests/test_highlights.py` | 325-366 | existing get test asserts non-author always gets masked 404. | required replacement with shared-reader success and mutation-denial split. |
| e-010 | e2e ownership-isolation test conflicts with shared-read contract | `python/tests/test_web_article_highlight_e2e.py` | 297-377 | current test asserts different user cannot list/get any highlight, irrespective of shared membership. | required e2e scenario rewrite to s4 shared-read + author-only mutate boundary. |
| e-011 | prior pr established deterministic input hardening pattern | `docs/v1/s4/s4_prs/s4_pr06.md` | 214-223 | pr-06 locked invalid scope behavior to app-level `400 E_INVALID_REQUEST` (not framework `422`). | justified applying same deterministic parsing standard to `mine_only`. |
| e-012 | current list ordering contract lacks deterministic tie-break key | `python/nexus/services/highlights.py` | 285-289 | list query orders by `start_offset`, `created_at` only; ties can be planner-dependent. | required explicit deterministic tie-break decision (`id ASC`) and test coverage. |
| e-013 | canonical helper currently exists only as point-read wrapper | `python/nexus/auth/permissions.py` | 211-253 | `can_read_highlight(...)` is point-read focused and there is no list-query predicate helper API. | required helper-surface decision defining predicate-builder + exists-wrapper reuse pattern. |
| e-014 | traceability row for test-file updates was previously module-level and non-actionable | `docs/v1/s4/s4_prs/s4_pr07.md` | 99-111 | one matrix row used generic “module updates” wording rather than explicit test ids. | replaced with explicit named tests in both `test_highlights.py` and `test_web_article_highlight_e2e.py`. |
| e-015 | e2e shared-reader test text could be misread as default-list behavior instead of shared-list mode | `docs/v1/s4/s4_prs/s4_pr07.md` | 159-167 | wording “list/get succeeds” did not explicitly bind list assertion to `mine_only=false`. | patched to require explicit `?mine_only=false` in e2e shared-reader test contract. |
| e-016 | strict-token decision needed explicit compatibility-tradeoff callout | `docs/v1/s4/s4_prs/s4_pr07_decisions.md` | 8-12 | deterministic parse decision could hide intentional rejection of legacy non-canonical bool tokens. | decision d-002 now explicitly documents accepted compatibility tradeoff and required token-level test assertions. |

## notes
- phase 1 complete: created `s4_pr07.md` skeleton + companion artifacts.
- phase 2 complete: resolved forced decisions for deterministic query parsing, canonical helper reuse, and additive field uniformity.
- phase 3 complete: hardening pass confirms all l3 acceptance bullets map to deliverables + tests with no open defaults remaining.
