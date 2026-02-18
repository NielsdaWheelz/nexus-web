# s4 pr-09 implementation report

## 1. summary of changes

| file | change type | description |
|---|---|---|
| `python/nexus/services/shares.py` | behavior fix | added default-library prohibition (`is_default` check + `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN`) in `set_sharing_mode`, `add_share`, `set_shares` — closes blocking invariant drift where only the route-level `set_conversation_shares_for_owner` enforced this |
| `python/nexus/services/conversations.py` | docstring | updated module docstring to reflect S4 shared-read semantics and helper split |
| `python/nexus/services/highlights.py` | docstring | updated module docstring to reflect S4 shared-read semantics and helper split |
| `python/tests/test_shares.py` | test fix + new tests | fixed 4 existing tests that used default library as share target (replaced with non-default libraries); added 3 new prohibition tests |
| `python/tests/test_conversations.py` | new test | added `test_list_conversations_scope_all_order_is_updated_at_desc_id_desc` for scenario 11 strict ordering proof with tie-break |
| `python/tests/test_s4_compatibility_audit.py` | new file | 5 deterministic introspection tests: route limit contracts (2), service constants (1), schema evolution (2) |
| `python/tests/test_s4_helper_retirement_audit.py` | new file | 4 static source-level audit tests: deprecated helper absence (1), canonical helper presence (2), search dependency check (1) |
| `docs/v1/s4/s4_prs/s4_pr09_acceptance_matrix.md` | new file | canonical scenario coverage matrix for S4 scenarios 1-15 |
| `docs/v1/s4/s4_prs/s4_pr09_handoff.md` | new file | per-PR handoff table with critical files, invariants, tests, non-goals, and deferred churn section |
| `docs/v1/s4/s4_roadmap.md` | status update | marked pr-09 as implemented with summary |

## 2. problems encountered

| problem | resolution |
|---|---|
| FastAPI `Query()` objects don't compare directly to int values via `==` | introspected `.default` attribute on the FieldInfo and `.metadata` for ge/le constraints |
| 4 existing share service tests used default library as share target, which broke after prohibition enforcement | replaced all default-library usage with non-default library fixtures |
| `test_set_shares_replaces_existing` and `test_set_sharing_private_removes_all_shares` needed two non-default libraries for multi-share tests | created inline second non-default library within those tests |
| ruff flagged unused `pytest` import and unused variable in initial audit test | removed unused imports and dead code |

## 3. solutions implemented

- **default-library prohibition**: added `db.get(Library, lib_id)` + `is_default` check in all three legacy share service functions, placed after existing validation checks to preserve error priority ordering
- **scenario 11 ordering test**: creates mixed-visibility conversations (owned, shared, public) with forced identical `updated_at` timestamps, asserts strict `updated_at DESC, id DESC` ordering and deterministic tie-break
- **compatibility audit**: uses `inspect.signature()` and FastAPI FieldInfo introspection for route param contracts; uses Pydantic `model_fields` for schema field presence checks
- **helper retirement audit**: scans `python/nexus/` source tree for deprecated helper names; checks canonical helper presence in specific modules; verifies search service dependency on read-path helpers

## 4. decisions made (and why)

| decision | rationale |
|---|---|
| placed default-library check after existing error checks in legacy share functions | preserves existing error priority (e.g., `E_SHARES_NOT_ALLOWED` before `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN` for private conversations) per spec: "keep remaining legacy error semantics unchanged unless required by this prohibition" |
| used source string scanning rather than AST parsing for helper retirement audit | simpler, sufficient for the purpose, and explicitly called for in the spec ("static-source checks only") |
| no README update | pr-09 adds no user-facing product surface; README already documents S4 library sharing from prior PRs |
| existing `test_add_share_to_private_conversation_fails` left unchanged | still passes because `E_SHARES_NOT_ALLOWED` is checked before the new default-library check; test purpose (private-sharing prohibition) is unaffected |

## 5. deviations from l4/l3/l2 with justification

none. all changes strictly conform to the pr-09 spec deliverables and boundaries.

## 6. commands to run new/changed behavior

```bash
# verify shares.py default-library prohibition
cd python && uv run pytest tests/test_shares.py::TestSharingInvariants::test_set_sharing_mode_default_library_forbidden tests/test_shares.py::TestSharingInvariants::test_add_share_default_library_forbidden tests/test_shares.py::TestSharingInvariants::test_set_shares_default_library_forbidden -v

# verify scenario 11 ordering
cd python && uv run pytest tests/test_conversations.py::TestListConversationsScope::test_list_conversations_scope_all_order_is_updated_at_desc_id_desc -v

# verify compatibility audit
cd python && uv run pytest tests/test_s4_compatibility_audit.py -v

# verify helper retirement audit
cd python && uv run pytest tests/test_s4_helper_retirement_audit.py -v
```

## 7. commands used to verify correctness

```bash
# full verification (lint + format + typecheck + build + test)
make verify
# result: exit code 0, 978 passed, 0 failed, 2 deselected (backend)
#         294 passed (frontend), 49 passed (migrations)
```

## 8. traceability table: acceptance item → files → tests → status

| acceptance item | files changed | tests | status |
|---|---|---|---|
| s4 scenarios 1-15 mapped to automated tests with traceability table | `docs/v1/s4/s4_prs/s4_pr09_acceptance_matrix.md`, `python/tests/test_conversations.py` | matrix references 30+ existing tests + new `test_list_conversations_scope_all_order_is_updated_at_desc_id_desc` | ✅ pass |
| route structure constraints pass | none (audit only) | `test_route_structure.py` (all existing tests) | ✅ pass |
| compatibility audit: list limits unchanged | `python/tests/test_s4_compatibility_audit.py` | `test_conversation_list_route_limit_contract_unchanged`, `test_message_list_route_limit_contract_unchanged`, `test_conversation_service_limit_constants_unchanged` | ✅ pass |
| compatibility audit: search response shape unchanged | `python/tests/test_s4_compatibility_audit.py` | existing `test_search_response_shape_remains_results_page` | ✅ pass |
| compatibility audit: additive-only evolution | `python/tests/test_s4_compatibility_audit.py` | `test_conversation_out_required_fields_preserved`, `test_highlight_out_required_fields_preserved` | ✅ pass |
| helper retirement audit: no stale duplicates | `python/tests/test_s4_helper_retirement_audit.py` | `test_deprecated_visibility_helper_names_absent_from_python_code`, `test_conversation_helper_split_surfaces_present`, `test_highlight_helper_split_surfaces_present`, `test_search_read_scope_does_not_depend_on_owner_write_helpers` | ✅ pass |
| default-library share prohibition across legacy service paths | `python/nexus/services/shares.py`, `python/tests/test_shares.py` | `test_set_sharing_mode_default_library_forbidden`, `test_add_share_default_library_forbidden`, `test_set_shares_default_library_forbidden` | ✅ pass |
| drift triage explicit | `docs/v1/s4/s4_roadmap.md`, `docs/v1/s4/s4_prs/s4_pr09_handoff.md` | audit suites above; handoff note deferred-churn section | ✅ pass |
| handoff note lists l4 inputs per pr | `docs/v1/s4/s4_prs/s4_pr09_handoff.md` | doc review | ✅ pass |

## 9. commit message

```
pr-09: s4 hardening + acceptance matrix + l4 handoff gate

Prove the full S4 contract with deterministic audits and freeze clean
handoff boundaries for individual PR specs. No new product behavior.

Blocking drift fix:
- Enforce default-library conversation-share prohibition in legacy share
  service entry points (set_sharing_mode, add_share, set_shares) to close
  invariant gap where only the route-level set_conversation_shares_for_owner
  enforced this check. Raises E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN.
- Fix 4 existing share tests that used default library as share target.

Scenario 11 coverage gap:
- Add test_list_conversations_scope_all_order_is_updated_at_desc_id_desc
  proving strict updated_at DESC, id DESC ordering with deterministic
  tie-break under equal timestamps for mixed-visibility rows.

New audit test suites:
- test_s4_compatibility_audit.py: 5 introspection tests verifying
  conversation/message list limit contracts (default 50, bounds 1..100),
  service constants, and additive-only schema evolution for ConversationOut
  and HighlightOut.
- test_s4_helper_retirement_audit.py: 4 static source-level tests verifying
  deprecated get_*_for_viewer_or_404 helpers are absent, canonical split
  helpers are present, and search service depends on can_read_conversation.

Documentation:
- s4_pr09_acceptance_matrix.md: scenario 1-15 coverage matrix with exact
  test references.
- s4_pr09_handoff.md: per-PR handoff table with critical files, contract
  invariants, acceptance tests, non-goals, and deferred churn section.
- Updated module docstrings in conversations.py and highlights.py to
  reflect S4 shared-read semantics and helper split.
- Marked pr-09 implemented in s4_roadmap.md.

Test results: 978 passed, 0 failed (make verify exit 0).

Touches: python/nexus/services/shares.py, python/nexus/services/conversations.py,
python/nexus/services/highlights.py, python/tests/test_shares.py,
python/tests/test_conversations.py, python/tests/test_s4_compatibility_audit.py,
python/tests/test_s4_helper_retirement_audit.py,
docs/v1/s4/s4_prs/s4_pr09_acceptance_matrix.md,
docs/v1/s4/s4_prs/s4_pr09_handoff.md, docs/v1/s4/s4_roadmap.md
```
