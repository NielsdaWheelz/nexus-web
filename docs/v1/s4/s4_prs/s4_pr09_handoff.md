# s4 pr-09 handoff note

## per-pr summary

| pr | critical files | contract invariants | acceptance tests | non-goals |
|---|---|---|---|---|
| pr-01 | `migrations/.../0007_slice4_library_sharing.py`, `python/nexus/db/models.py`, `python/nexus/errors.py`, `python/nexus/schemas/library.py` | s4 tables created; error codes in enum + status map; seed logic idempotent | `test_migrations.py`, `test_errors.py` | no endpoint behavior changes |
| pr-02 | `python/nexus/auth/permissions.py`, `python/nexus/services/conversations.py`, `python/nexus/services/highlights.py`, `python/nexus/services/upload.py`, `python/nexus/services/libraries.py`, `python/nexus/tasks/ingest_web_article.py` | s4 provenance predicates; helper split (visible-read / owner-write); intrinsic write-through on default-library writer paths; strict revocation | `test_permissions.py`, `test_visibility_helpers.py`, `test_libraries.py`, `test_upload.py`, `test_from_url.py`, `test_ingest_web_article.py` | no public endpoint contract changes |
| pr-03 | `python/nexus/services/libraries.py`, `python/nexus/api/routes/libraries.py`, `python/nexus/schemas/library.py`, `apps/web/src/app/api/libraries/**` | owner-only delete; member management; ownership transfer; E_OWNER_EXIT_FORBIDDEN; E_LAST_ADMIN_FORBIDDEN | `test_libraries.py` | no invite lifecycle |
| pr-04 | `python/nexus/services/libraries.py`, `python/nexus/api/routes/libraries.py`, `python/nexus/schemas/library.py`, `apps/web/src/app/api/libraries/invites/**` | invite lifecycle (create/accept/decline/revoke); atomic accept with backfill-job upsert; idempotent state transitions | `test_libraries.py` (30 invite tests) | no closure materialization worker |
| pr-05 | `python/nexus/services/libraries.py`, `python/nexus/services/upload.py`, `python/nexus/services/media.py`, `python/nexus/tasks/ingest_web_article.py`, backfill task/service modules, internal route module | closure-edge materialization across all writer paths; backfill worker with atomic claim + retry; internal requeue endpoint | `test_libraries.py`, `test_upload.py`, `test_from_url.py`, `test_ingest_web_article.py`, backfill test module | no frontend operator tooling |
| pr-06 | `python/nexus/services/conversations.py`, `python/nexus/services/shares.py`, `python/nexus/api/routes/conversations.py`, `python/nexus/schemas/conversation.py`, `apps/web/src/app/api/conversations/**` | conversation scope=mine\|all\|shared; share endpoints; ConversationOut additive fields (owner_user_id, is_owner); default-library share prohibition | `test_conversations.py`, `test_shares.py`, `test_send_message.py` | no multi-author writes |
| pr-07 | `python/nexus/services/highlights.py`, `python/nexus/api/routes/highlights.py`, `python/nexus/schemas/highlights.py` | mine_only default=true; shared read under canonical predicate; HighlightOut additive fields (author_user_id, is_owner); author-only mutation | `test_highlights.py`, `test_web_article_highlight_e2e.py` | no annotation mutation model changes |
| pr-08 | `python/nexus/services/search.py`, `python/nexus/api/routes/search.py` | scope auth via canonical visibility; annotation search matches s4 highlight visibility; library-scope message search constrained; response shape preserved | `test_search.py` | no ranking/weighting changes |
| pr-09 | `python/nexus/services/shares.py`, `python/nexus/services/conversations.py` (docstring), `python/nexus/services/highlights.py` (docstring), `python/tests/test_s4_compatibility_audit.py`, `python/tests/test_s4_helper_retirement_audit.py`, `python/tests/test_conversations.py`, `python/tests/test_shares.py`, `docs/v1/s4/s4_prs/s4_pr09_acceptance_matrix.md`, `docs/v1/s4/s4_prs/s4_pr09_handoff.md` | scenarios 1-15 mapped; compatibility audit; helper retirement audit; default-library share prohibition closed across legacy service paths | `test_s4_compatibility_audit.py`, `test_s4_helper_retirement_audit.py`, `test_conversations.py`, `test_shares.py`, `test_route_structure.py` | no new product surface |

## deferred churn

none. all blocking drift was resolved within pr-09 scope (legacy share service default-library prohibition). no feature-level churn was discovered during audits that requires reassignment to owner prs.

## blocking drift fixed in pr-09

| drift | fix | justification |
|---|---|---|
| legacy `set_sharing_mode`, `add_share`, `set_shares` in `shares.py` did not enforce default-library target prohibition | added `is_default` check + `E_CONVERSATION_SHARE_DEFAULT_LIBRARY_FORBIDDEN` raise in all three functions | s4 invariant 9: conversation share targets must be non-default libraries; enforcement must hold across all callable service paths, not only the route-owned `set_conversation_shares_for_owner` |
| existing service tests used default library as share target | replaced with non-default library fixtures; added 3 explicit prohibition tests | tests must not depend on behavior that violates s4 invariants |
| module docstrings in `conversations.py` and `highlights.py` claimed pre-s4 owner-only semantics | updated to reflect s4 shared-read semantics and helper split | stale docs create implementation mistakes during handoff |
| scenario 11 ordering proof was missing for tie-break under `scope=all` | added `test_list_conversations_scope_all_order_is_updated_at_desc_id_desc` | blocking acceptance gap per pr-09 spec |
