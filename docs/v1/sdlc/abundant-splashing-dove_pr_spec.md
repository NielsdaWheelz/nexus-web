# pr-01: testing standards + testing infrastructure overhaul

## goal
Establish a version-controlled testing standards document and refactor the current backend, frontend, E2E, Makefile, and CI testing infrastructure to align with that standard in one PR without changing product behavior.

## context
- `docs/v1/sdlc/L4-pr-spec.md` defines the required L4 structure for a single-PR implementer contract.
- `docs/v1/sdlc/testing_standards.md` is the target-state testing policy this PR will codify and implement.
- This L4 spec uses a descriptive filename under `docs/v1/sdlc/` because the work is cross-cutting (not slice-scoped); the naming deviation is intentional for discoverability.
- `Makefile` currently runs `verify` as a serial chain (`lint fmt-check typecheck build test`) and does not provide `verify-fast`, `test-back-unit`, `test-e2e`, or `test-e2e-ui`.
- `.github/workflows/ci.yml` currently allows frontend typecheck failures (`npm run typecheck || true`) and has no E2E job.
- `apps/web/vitest.config.ts` currently uses `happy-dom`.
- `apps/web/vitest.setup.ts` currently installs a global `vi.mock("next/navigation")`, which contaminates all frontend tests.
- `apps/web/src/lib/api/proxy.test.ts` is currently 1064 lines and mixes pure tests with heavily mocked integration-style tests.
- `apps/web/src/app/(authenticated)/media/[id]/page.test.tsx`, `apps/web/src/app/(authenticated)/conversations/[id]/page.test.tsx`, and `apps/web/src/app/(authenticated)/conversations/page.test.tsx` currently exist as page-level Vitest tests that rely on heavy mocking.
- `python/pyproject.toml` currently defines only the `supabase` pytest marker.
- `python/tests/` currently contains 46 `patch("nexus.services...")` occurrences and 14 local `auth_client` fixture definitions across multiple files.
- `.gitignore` currently has no explicit ignore for Playwright auth state (`e2e/.auth/`).
- There is no `e2e/` Playwright test project in the merged state yet.

## dependencies
- none (this PR is written against merged state only and is self-contained)

---

## deliverables

### `docs/v1/sdlc/testing_standards.md`
- Create the version-controlled normative testing standards document (target state) and keep it focused on durable policy, not migration choreography.
- Define the five-tier model (`Tier 0` static analysis through `Tier 4` E2E), behavior-first assertions, mocking boundaries, fixture/data rules, naming/markers, and target command/CI shape.
- Document the temporary-exception rule for migration-only deviations (for example, an external-boundary mock reachable only through an internal seam).

### `Makefile`
- Add `verify-fast` for fast local feedback with exact composition: `lint`, `fmt-check`, `typecheck`, backend unit tests, and frontend unit tests only (no build, no browser-mode component tests, no E2E).
- Add `test-back-unit` (`pytest -m unit`) target.
- Add `test-front-unit` and `test-front-browser` targets so frontend unit and browser-mode component runs can be invoked independently.
- Add `test-e2e` and `test-e2e-ui` targets for Playwright.
- Define `verify` explicitly as full routine local verification (static checks + `build` + backend tests + frontend unit/browser tests) while excluding E2E by default.
- Parallelize independent parts of `verify` and `verify-fast` via explicit helper targets and `make -j` orchestration (avoid dense shell command chains) while preserving deterministic failure behavior.
- Keep existing service bootstrapping patterns (`with_test_services.sh`, `with_supabase_services.sh`, `ensure-node-ingest`) unless explicitly replaced in this PR.

### `.github/workflows/ci.yml`
- Remove the frontend typecheck bypass (`|| true`).
- Update frontend test job to install Playwright browser dependencies required by Vitest Browser Mode.
- Add a `test-e2e` job that runs after lower layers pass.
- Upload Playwright artifacts/report on failure (or always if low-cost).

### `.gitignore`
- Add explicit ignores for Playwright auth/session state under `e2e/.auth/` (and related local E2E artifacts if introduced).

### `python/pyproject.toml`
- Add pytest markers: `unit`, `integration`, `slow`, `supabase`.
- Preserve existing default marker exclusion behavior (for example `not supabase`) unless deliberately revised and documented in the decision ledger.

### `python/tests/conftest.py`
- Add/centralize the shared `auth_client` fixture used across backend tests.
- Keep fixture semantics compatible with existing test usage unless an owning test file is also updated in this PR.

### `python/tests/factories.py`
- Migrate factory helpers from raw SQL inserts to SQLAlchemy ORM models where those helpers are used in the touched tests.
- Preserve generated test data semantics (defaults, relationships) needed by existing tests.

### `python/tests/fixtures.py`
- Migrate composite fixtures to consume ORM-backed factories where required by the factory migration.
- Keep fixture names and outputs stable unless the owning tests are updated in the same PR.

### `python/tests/test_*.py` (backend test cleanup scope)
- Add module/class-level pytest markers (`unit`, `integration`, `slow`, `supabase`) across all backend test files.
- Convert API-behavior tests in the enumerated cleanup scope (and any other edited backend API tests) from raw SQL assertions to API-response assertions or follow-up API reads.
- Where a schema-level assertion is required and API visibility is intentionally absent, prefer ORM queries over raw SQL `text()`.
- Preserve `python/tests/test_migrations.py` as the primary schema-level raw SQL exception.

Representative high-priority files in scope (non-exhaustive for marker/assertion cleanup):
- `python/tests/test_libraries.py`
- `python/tests/test_media.py`
- `python/tests/test_conversations.py`
- `python/tests/test_shares.py`
- `python/tests/test_contexts.py`
- `python/tests/test_web_article_highlight_e2e.py`
- `python/tests/test_permissions.py`
- `python/tests/test_highlights.py`
- `python/tests/test_fragment_blocks.py`

### `python/tests/test_send_message.py`
- Remove internal `nexus.services.send_message.*` patching patterns used to simulate core behavior.
- Replace internal behavior mocks with real seeded data and external-boundary HTTP mocking (`respx`) where required.
- Preserve API contract assertions, streaming behavior assertions, and error semantics.

### `python/tests/test_send_message_stream.py`
- Remove internal session/service patching where behavior can be exercised through real test dependencies.
- Keep streaming contract assertions focused on observable output.

### `python/tests/test_epub_ingest.py`
- Remove internal session factory patching.
- Storage mocking may remain only if implemented as a documented migration exception tied to an external boundary seam.

### `python/tests/test_media.py`
- Remove internal behavior mocks where the test is validating app behavior.
- If a temporary external-storage seam patch remains, document it in the decision ledger and keep assertions behavior-first.

### `apps/web/vitest.setup.ts`
- Remove the global `next/navigation` mock.
- Keep only minimal shared test setup (for example, jest-dom matchers and cleanup).

### `apps/web/vitest.workspace.ts` (new)
- Add a Vitest workspace splitting fast Node unit tests from browser-mode component tests.
- Configure the browser project to run in Chromium via the Playwright provider.

### `apps/web/vitest.config.ts`
- Update config to support workspace/shared configuration without `happy-dom` as the default environment for all tests.

### `apps/web/package.json`
- Add browser-mode dependencies needed by Vitest Browser Mode (for example `@vitest/browser` and Playwright provider support).
- Remove `happy-dom`.
- Add/update scripts required by the final frontend test commands if needed.

### `apps/web/eslint.config.mjs`
- Add `eslint-plugin-testing-library` rules scoped to frontend test files.
- Preserve existing lint behavior outside test files.

### `apps/web/src/lib/api/proxy.test.ts`
- Keep only pure unit tests that validate deterministic proxy helper behavior without mocking internal modules or the network stack.
- Delete or rewrite heavily mocked integration-style tests that are replaced by Playwright E2E coverage in this PR.

### `apps/web/src/app/(authenticated)/media/[id]/page.test.tsx`
- Delete or drastically trim mocked page-level Vitest tests; page behavior must be covered by Playwright E2E in this PR.

### `apps/web/src/app/(authenticated)/conversations/[id]/page.test.tsx`
- Delete or drastically trim mocked page-level Vitest tests; page behavior must be covered by Playwright E2E in this PR.

### `apps/web/src/app/(authenticated)/conversations/page.test.tsx`
- Delete or drastically trim mocked page-level Vitest tests; page behavior must be covered by Playwright E2E in this PR.

### `e2e/package.json` (new)
- Create the E2E project package manifest with Playwright scripts and dependencies.

### `e2e/tsconfig.json` (new)
- Add TS config for E2E tests and setup scripts.

### `e2e/playwright.config.ts` (new)
- Configure Playwright to run against a real local stack.
- Use Playwright `webServer` for app processes (Next.js + FastAPI) only.
- Do not make Playwright responsible for bootstrapping Supabase local or Redis; `make test-e2e`/wrapper scripts own dependency readiness.

### `e2e/seed-e2e-user.ts` (new)
- Add deterministic seed logic for the E2E test user via Supabase admin APIs and/or app-supported seed flows.
- Make the script safe to rerun locally and in CI.

### `e2e/tests/auth.setup.ts` (new)
- Implement real-login setup using Supabase local auth UI/flow and persist Playwright `storageState` for reuse.

### `e2e/tests/` (new journey specs)
- Add journey coverage files:
  - `auth.spec.ts`
  - `libraries.spec.ts`
  - `web-articles.spec.ts`
  - `epub.spec.ts`
  - `search.spec.ts`
  - `conversations.spec.ts`
  - `sharing.spec.ts`
  - `api-keys.spec.ts`
  - `settings.spec.ts`
- Each file must assert user-visible behavior against the real stack (not mocked API responses).
- Minimum required journey coverage by file:

| File | Required flows (minimum) |
|---|---|
| `auth.spec.ts` | login success, logout, session persistence across reload, invalid credentials error |
| `libraries.spec.ts` | create library, browse/select library, invite member or membership workflow, ownership transfer or ownership-management guardrail |
| `web-articles.spec.ts` | add article from URL, open/view article, create highlight, annotate highlight |
| `epub.spec.ts` | upload EPUB, open reader, navigate chapters/TOC, create highlight |
| `search.spec.ts` | search returns results across at least two content types, no-results behavior |
| `conversations.spec.ts` | create conversation, send message, streaming response UI, attach/use context |
| `sharing.spec.ts` | share conversation, recipient access succeeds, permission enforcement/forbidden path |
| `api-keys.spec.ts` | add key, list keys, delete key |
| `settings.spec.ts` | view settings, update preference, persisted settings state after reload/navigation |

### replacement mapping: mocked page tests -> e2e coverage

| Removed/trimmed Vitest file | Replacement Playwright spec(s) | Required replacement scenarios |
|---|---|---|
| `apps/web/src/app/(authenticated)/media/[id]/page.test.tsx` | `web-articles.spec.ts`, `epub.spec.ts` | media page render/load, reading interactions, highlight/annotation behavior |
| `apps/web/src/app/(authenticated)/conversations/[id]/page.test.tsx` | `conversations.spec.ts`, `sharing.spec.ts` | conversation load, send/stream response, access control/share behavior |
| `apps/web/src/app/(authenticated)/conversations/page.test.tsx` | `conversations.spec.ts` | conversation list/create/navigation behavior |

### `python/tests/test_s4_helper_retirement_audit.py`
- Delete one-time migration audit coverage that no longer represents ongoing product behavior.

### `python/tests/test_crypto.py`
- Trim dependency-internals tests; keep tests for app-owned crypto behavior and invariants.

### `python/tests/test_s4_compatibility_audit.py`
- Trim configuration/query introspection tests that assert implementation details instead of runtime behavior.

---

## decision ledger

| question | decision | rationale | fallback/default |
|---|---|---|---|
| Is the standards model "four tiers" or "five tiers" for this repo? | Use a five-tier model: Tier 0 static analysis, Tier 1 unit, Tier 2 browser component, Tier 3 backend integration, Tier 4 E2E. | Backend integration tests are a distinct layer with different feedback speed and failure localization than E2E. Collapsing them hides ownership. | If naming becomes confusing, keep behavior the same and relabel tiers later without changing policy boundaries. |
| Should `make verify` include E2E? | No. `make verify` stays non-E2E for a routine local loop; E2E is explicit (`make test-e2e`) and CI-gated. | Keeps local feedback frequent and predictable while still enforcing E2E in CI. | If local workflows need one-shot full validation, add a separate `verify-full` later; do not overload `verify`. |
| What exact command composition should `verify-fast` and `verify` enforce in this PR? | `verify-fast` must run `lint`, `fmt-check`, `typecheck`, backend unit tests, and frontend unit tests only. `verify` must run static checks + `build` + backend tests + frontend unit/browser tests, excluding E2E. | Removes ambiguity in local workflow semantics and prevents accidental slow/partial verification loops. | If command naming changes during implementation, preserve the same semantics and update both this spec and `docs/v1/sdlc/testing_standards.md` together. |
| Where should the durable policy live versus migration choreography? | Durable policy lives in `docs/v1/sdlc/testing_standards.md`; migration choreography and temporary exceptions live in this L4 PR spec. | Prevents drift and duplication. Standards stay stable; the PR spec is disposable after merge. | If a policy rule changes during implementation, update the standards doc first, then align this spec. |
| How strict is the "no internal mocks" rule during migration? | Target state is strict. Temporary exceptions are allowed only when an external boundary is currently reachable only through an internal seam, and must be documented in this PR's decisions. | Preserves the quality bar without blocking migration on unrelated architectural refactors. | If a clean seam can be introduced cheaply in this PR, prefer refactoring and remove the exception. |
| How should Playwright boot the test environment? | `make test-e2e` (or an existing wrapper script) ensures Supabase/Redis readiness; Playwright `webServer` starts only app processes (Next.js and FastAPI). | Keeps heavy dependency lifecycle outside Playwright and reduces config fragility. | If `webServer` orchestration proves sufficient later, dependency bootstrapping can be consolidated in a follow-up cleanup. |
| How should backend tests verify API behavior after cleanup? | Assert through API responses and follow-up API reads; use ORM queries only when API intentionally hides the asserted state; keep schema-level raw SQL in migration tests. | Behavior-first assertions survive refactors better and align with the testing standards. | If a touched test has no practical API/ORM assertion path in this PR, document a temporary exception and narrow it to that case only. |
| What is the required handling for `test_media.py` storage-boundary seam patches in this PR? | Default to removing `patch("nexus.services...get_storage_client")` seam patches in `python/tests/test_media.py`. A temporary seam patch is allowed only if needed to isolate the external storage boundary without broader architectural refactor, and any remaining patch must be explicitly documented in this PR's decisions with exact patch site(s), rationale, replacement layer/test, and removal trigger. | Gives a junior implementer a clear target-state decision while preserving a narrow fallback for real migration friction. | If removal is not feasible within this PR without product-risking refactor, keep the smallest possible seam patch for external storage only, document it explicitly, and keep all assertions behavior-first. |
| What happens to heavily mocked frontend page tests? | Replace page-level mocked Vitest coverage with Playwright E2E coverage in the same PR; keep only pure unit or true component tests. | Page tests with heavy internal mocks provide false confidence and duplicate E2E intent. | If a page test is truly pure and no mocks are required, it may remain or move to browser-mode component coverage. |
| Should Playwright auth state files be tracked? | No. Ignore `e2e/.auth/` (and related local auth artifacts) in `.gitignore`. | Prevents accidental session/secrets commits and keeps local E2E runs repeatable. | If auth state storage location changes, update `.gitignore` in the same PR. |
| How is one-PR scope kept implementable without weakening the contract? | Keep one PR, but execute in documented checkpoints and require every listed deliverable/acceptance to pass before merge. Anything deferred must be removed from deliverables via explicit spec revision. | Preserves the user's one-PR constraint while keeping the L4 contract deterministic and reviewable. | If implementation pressure forces deferral, revise this spec first and add explicit deferral entries (with replacement coverage) before changing code. |
| Should CI E2E artifacts upload on failure only or always? | Upload on failure by default in this PR. | Lower CI cost/noise while still preserving debugging evidence for the failure path. | Switch to always-upload later if debugging volume justifies it. |

---

## traceability matrix

| l3 acceptance item | deliverable(s) | test(s) |
|---|---|---|
| Version-controlled testing policy exists and defines the target testing model. | `docs/v1/sdlc/testing_standards.md` | `standards_doc_defines_tiers_mocking_and_assertion_rules` |
| Local verification/test commands support a fast loop and explicit E2E entrypoints with explicit semantics. | `Makefile` | `makefile_adds_verification_and_layer_targets`; `makefile_verify_target_semantics_are_explicit`; `verify_fast_executes_successfully`; `verify_executes_successfully_without_e2e` |
| Backend test infrastructure and cleanup in this PR's listed scope use explicit markers, centralized fixtures, ORM-backed factories, behavior-first assertions, and reduced internal mocking. | `python/pyproject.toml`; `python/tests/conftest.py`; `python/tests/factories.py`; `python/tests/fixtures.py`; listed backend cleanup test files | `pytest_markers_defined_and_all_backend_test_files_marked`; `auth_client_fixture_centralized_or_documented_exceptions`; `backend_factories_and_fixtures_use_orm_for_common_entity_setup`; `backend_send_message_tests_remove_internal_service_patches`; `backend_send_message_stream_and_epub_ingest_tests_remove_internal_session_patches`; `backend_media_external_storage_seam_exception_is_explicit_if_present`; `backend_listed_api_tests_assert_behavior_not_schema`; `backend_unit_target_executes_unit_marker_only` |
| Frontend test infrastructure is split into unit + real-browser component testing without global navigation mocks and with test linting rules. | `apps/web/vitest.setup.ts`; `apps/web/vitest.workspace.ts`; `apps/web/vitest.config.ts`; `apps/web/package.json`; `apps/web/eslint.config.mjs`; `Makefile` | `frontend_vitest_setup_has_no_global_next_navigation_mock`; `frontend_browser_mode_workspace_configured`; `frontend_package_replaces_happy_dom`; `frontend_eslint_testing_library_rules_enabled`; `frontend_unit_and_browser_targets_execute` |
| Mock-heavy frontend tests are pruned and replaced with appropriate-layer coverage. | `apps/web/src/lib/api/proxy.test.ts`; page test files; `e2e/tests/*.spec.ts` | `proxy_test_trimmed_to_pure_unit_scope`; `mocked_page_tests_removed_or_trimmed_with_e2e_replacement` |
| Playwright E2E layer exists with real auth and major user journeys (with required behaviors per spec file). | `e2e/*`; `.gitignore` | `e2e_project_exists_and_lists_journey_specs`; `playwright_auth_setup_uses_storage_state`; `e2e_auth_spec_covers_required_flows`; `e2e_libraries_spec_covers_required_flows`; `e2e_web_articles_spec_covers_required_flows`; `e2e_epub_spec_covers_required_flows`; `e2e_search_spec_covers_required_flows`; `e2e_conversations_spec_covers_required_flows`; `e2e_sharing_spec_covers_required_flows`; `e2e_api_keys_spec_covers_required_flows`; `e2e_settings_spec_covers_required_flows`; `e2e_suite_executes_against_real_stack`; `gitignore_blocks_e2e_auth_state` |
| CI enforces the new testing posture. | `.github/workflows/ci.yml` | `ci_removes_typecheck_bypass`; `ci_adds_playwright_install_for_frontend_tests`; `ci_adds_e2e_job_and_artifact_upload` |
| Obsolete or implementation-detail tests are removed/trimmed. | `python/tests/test_s4_helper_retirement_audit.py`; `python/tests/test_crypto.py`; `python/tests/test_s4_compatibility_audit.py` | `obsolete_audit_test_removed`; `dependency_internal_tests_trimmed` |

---

## acceptance tests

### file: `docs/v1/sdlc/testing_standards.md`

**test: `standards_doc_defines_tiers_mocking_and_assertion_rules`**
- input: run `rg -n 'Tier 3: Integration Tests|Tier 4: E2E|Mocking Policy|MSW Policy|Assertion Standards|Migration Rules for Existing Tests' docs/v1/sdlc/testing_standards.md`
- output: all required sections are present; the document defines behavior-first assertions, mocking boundaries, and the tier model used by this PR.

### file: `Makefile`

**test: `makefile_adds_verification_and_layer_targets`**
- input: run `rg -n '^(verify-fast|test-back-unit|test-front-unit|test-front-browser|test-e2e|test-e2e-ui):' Makefile`
- output: each required target exists exactly once with executable recipes.

**test: `makefile_verify_target_semantics_are_explicit`**
- input: inspect `verify-fast`, `verify`, and helper targets in `Makefile`; run `make -n verify-fast` and `make -n verify`.
- output: `verify-fast` runs only static checks + backend unit + frontend unit; `verify` runs static checks + build + backend tests + frontend unit/browser tests; E2E is not silently included in either target.

**test: `verify_fast_executes_successfully`**
- input: run `make verify-fast` in a configured local environment (or equivalent CI command path for the same target).
- output: target completes successfully and does not invoke E2E or frontend build.

**test: `verify_executes_successfully_without_e2e`**
- input: run `make verify` in a configured local environment.
- output: target completes successfully, includes build and non-E2E test layers, and does not invoke Playwright E2E.

### file: `python/pyproject.toml` and backend test files

**test: `pytest_markers_defined_and_all_backend_test_files_marked`**
- input: run `rg -n '\"unit:|\"integration:|\"slow:|\"supabase:' python/pyproject.toml` and `rg -L '@pytest\\.mark\\.|pytestmark\\s*=' python/tests/test_*.py`
- output: marker definitions exist in `python/pyproject.toml`; no backend test files are left unmarked (unless explicitly documented as a temporary exception in this spec).

### file: `python/tests/conftest.py` and backend fixtures/tests

**test: `auth_client_fixture_centralized_or_documented_exceptions`**
- input: run `rg -n '^def auth_client\\b' python/tests/*.py` and review remaining non-`conftest.py` definitions against this spec decision ledger.
- output: duplicated generic `auth_client` fixtures are centralized in `python/tests/conftest.py`; any remaining file-local definitions are test-specific and explicitly justified.

**test: `backend_factories_and_fixtures_use_orm_for_common_entity_setup`**
- input: inspect `python/tests/factories.py` and `python/tests/fixtures.py`, then run backend tests that consume edited helpers (`make test-back` or targeted `pytest` runs for affected files).
- output: common entity-creation helpers used by edited tests create ORM objects (not raw SQL inserts), and edited tests still pass with unchanged product behavior.

### file: `python/tests/test_send_message.py`

**test: `backend_send_message_tests_remove_internal_service_patches`**
- input: run `rg -n 'patch\\(\"nexus\\.services\\.send_message\\.' python/tests/test_send_message.py`
- output: internal `send_message` service patching patterns are removed; tests rely on real seeded behavior and external-boundary mocks only.

### file: `python/tests/test_send_message_stream.py` and `python/tests/test_epub_ingest.py`

**test: `backend_send_message_stream_and_epub_ingest_tests_remove_internal_session_patches`**
- input: run `rg -n 'patch\\(\"nexus\\.services\\.(send_message_stream|epub_ingest|epub_lifecycle)\\.' python/tests/test_send_message_stream.py python/tests/test_epub_ingest.py`
- output: no internal session/service patching remains in these files, except a documented temporary external-boundary seam exception if explicitly listed in this spec decision ledger.

### file: `python/tests/test_media.py`

**test: `backend_media_external_storage_seam_exception_is_explicit_if_present`**
- input: inspect `python/tests/test_media.py` for remaining `patch(\"nexus.services...get_storage_client\"` style seams and cross-check this spec decision ledger / open questions.
- output: either no such seam patches remain, or any remaining patch is limited to an external storage boundary seam, documented explicitly, and paired with behavior-first assertions.

### file: listed backend API cleanup tests

**test: `backend_listed_api_tests_assert_behavior_not_schema`**
- input: run `make test-back` and targeted `pytest` invocations for edited files in the listed backend cleanup scope; inspect edited assertions.
- output: edited API-behavior tests assert via API responses/follow-up API reads (or documented narrow exceptions), preserve behavior semantics, and avoid raw SQL table assertions for API outcomes.

**test: `backend_unit_target_executes_unit_marker_only`**
- input: run `make test-back-unit` and (if needed) inspect target recipe in `Makefile`.
- output: target executes only `@pytest.mark.unit` backend tests and does not require DB-backed integration setup.

### file: `apps/web/vitest.setup.ts`

**test: `frontend_vitest_setup_has_no_global_next_navigation_mock`**
- input: run `rg -n 'vi\\.mock\\(\"next/navigation\"' apps/web/vitest.setup.ts`
- output: no match (global `next/navigation` mock has been removed).

### file: `apps/web/vitest.workspace.ts`, `apps/web/vitest.config.ts`, `apps/web/package.json`

**test: `frontend_browser_mode_workspace_configured`**
- input: run `test -f apps/web/vitest.workspace.ts` and inspect config for a browser-mode project using Vitest Browser Mode with a Playwright/Chromium provider.
- output: workspace exists and clearly separates Node unit tests from browser-mode component tests.

**test: `frontend_package_replaces_happy_dom`**
- input: run `rg -n 'happy-dom|@vitest/browser' apps/web/package.json`
- output: `happy-dom` is absent and `@vitest/browser` (and required browser-mode support deps) are present.

### file: `apps/web/eslint.config.mjs`

**test: `frontend_eslint_testing_library_rules_enabled`**
- input: inspect `apps/web/eslint.config.mjs` for `eslint-plugin-testing-library` usage scoped to test files, then run `cd apps/web && npm run lint`.
- output: testing-library rules are configured for frontend tests and lint passes (or fails only on real violations unrelated to configuration syntax).

### file: `Makefile` + frontend test config

**test: `frontend_unit_and_browser_targets_execute`**
- input: run `make test-front-unit` and `make test-front-browser`.
- output: frontend unit tests run in Node mode and browser component tests run in real Chromium/Vitest Browser Mode as separate invocations.

### file: `apps/web/src/lib/api/proxy.test.ts` and page test files

**test: `proxy_test_trimmed_to_pure_unit_scope`**
- input: inspect `apps/web/src/lib/api/proxy.test.ts` and run `rg -n 'vi\\.mock|fetch\\s*=|mockResolvedValue|mockRejectedValue' apps/web/src/lib/api/proxy.test.ts`
- output: remaining tests cover pure deterministic proxy helper behavior; heavy mocked integration-style coverage is removed or moved.

**test: `mocked_page_tests_removed_or_trimmed_with_e2e_replacement`**
- input: inspect the three page test files and the explicit replacement mapping table in this spec, then run the mapped Playwright specs.
- output: page-level mocked Vitest coverage is removed or reduced to truly pure cases, and each removed behavior cluster has corresponding Playwright coverage per the replacement mapping table.

### file: `e2e/` project

**test: `e2e_project_exists_and_lists_journey_specs`**
- input: run `test -f e2e/playwright.config.ts`, `test -f e2e/package.json`, `test -f e2e/tsconfig.json`, and `ls e2e/tests/*.spec.ts`
- output: E2E project exists and includes the nine journey spec files listed in this spec.

**test: `playwright_auth_setup_uses_storage_state`**
- input: inspect `e2e/tests/auth.setup.ts` and `e2e/playwright.config.ts` for storage-state setup usage.
- output: Playwright auth setup performs real login and persists `storageState` for reuse.

### file: `e2e/tests/auth.spec.ts`

**test: `e2e_auth_spec_covers_required_flows`**
- input: run `make test-e2e` targeting `e2e/tests/auth.spec.ts` (or `npx playwright test e2e/tests/auth.spec.ts` within the `e2e/` project) against the real local stack.
- output: the spec validates login success, logout, session persistence across reload/navigation, and invalid-credentials error handling.

### file: `e2e/tests/libraries.spec.ts`

**test: `e2e_libraries_spec_covers_required_flows`**
- input: run the libraries E2E spec against the real local stack.
- output: the spec validates library creation, browsing/selection, membership/invite workflow (or equivalent membership management path), and ownership transfer or equivalent ownership-management guardrail behavior.

### file: `e2e/tests/web-articles.spec.ts`

**test: `e2e_web_articles_spec_covers_required_flows`**
- input: run the web-articles E2E spec against the real local stack.
- output: the spec validates add-from-URL, article viewing, highlight creation, and annotation behavior.

### file: `e2e/tests/epub.spec.ts`

**test: `e2e_epub_spec_covers_required_flows`**
- input: run the EPUB E2E spec against the real local stack.
- output: the spec validates EPUB upload, reader load, chapter/TOC navigation, and highlight behavior.

### file: `e2e/tests/search.spec.ts`

**test: `e2e_search_spec_covers_required_flows`**
- input: run the search E2E spec against the real local stack.
- output: the spec validates search results across at least two content types and no-results behavior.

### file: `e2e/tests/conversations.spec.ts`

**test: `e2e_conversations_spec_covers_required_flows`**
- input: run the conversations E2E spec against the real local stack.
- output: the spec validates conversation creation, message send, streaming response UI, and context attach/use behavior.

### file: `e2e/tests/sharing.spec.ts`

**test: `e2e_sharing_spec_covers_required_flows`**
- input: run the sharing E2E spec against the real local stack (including a second user/session where needed).
- output: the spec validates conversation sharing, recipient access success, and permission enforcement/forbidden behavior.

### file: `e2e/tests/api-keys.spec.ts`

**test: `e2e_api_keys_spec_covers_required_flows`**
- input: run the API keys E2E spec against the real local stack.
- output: the spec validates add, list, and delete key flows.

### file: `e2e/tests/settings.spec.ts`

**test: `e2e_settings_spec_covers_required_flows`**
- input: run the settings E2E spec against the real local stack.
- output: the spec validates settings display, preference update, and persisted settings state across reload/navigation.

### file: `e2e/` project (full suite)

**test: `e2e_suite_executes_against_real_stack`**
- input: run `make test-e2e` against the real local stack with Supabase/Redis/app services ready via the chosen bootstrap path.
- output: the full Playwright suite executes against the real stack (no MSW/mock API servers) and publishes failure artifacts in CI when failing.

### file: `.gitignore`

**test: `gitignore_blocks_e2e_auth_state`**
- input: run `rg -n '^e2e/\\.auth/|^e2e/\\.auth$' .gitignore`
- output: `.gitignore` explicitly ignores Playwright auth state artifacts.

### file: `.github/workflows/ci.yml`

**test: `ci_removes_typecheck_bypass`**
- input: run `rg -n 'typecheck \\|\\| true' .github/workflows/ci.yml`
- output: no match.

**test: `ci_adds_playwright_install_for_frontend_tests`**
- input: inspect `test-frontend` job steps in `.github/workflows/ci.yml`.
- output: frontend test job installs browser dependencies required for Vitest Browser Mode before running tests.

**test: `ci_adds_e2e_job_and_artifact_upload`**
- input: inspect `.github/workflows/ci.yml` for a dedicated E2E job and artifact upload step.
- output: CI runs Playwright E2E in a dedicated job after lower layers pass and publishes failure artifacts/reports.

### file: backend cleanup tests

**test: `obsolete_audit_test_removed`**
- input: run `test ! -f python/tests/test_s4_helper_retirement_audit.py`
- output: file is removed.

**test: `dependency_internal_tests_trimmed`**
- input: inspect diffs in `python/tests/test_crypto.py` and `python/tests/test_s4_compatibility_audit.py`; run their tests.
- output: implementation-detail assertions are removed while app-owned behavior assertions still pass.

---

## execution sequence (recommended)

1. Land docs first: finalize `docs/v1/sdlc/testing_standards.md` and keep this PR spec in sync with any policy edits.
2. Add Makefile target scaffolding (`verify-fast`, `test-back-unit`, `test-front-unit`, `test-front-browser`, `test-e2e`, `test-e2e-ui`) with placeholder wiring if needed, then finalize semantics.
3. Update frontend test infrastructure (`vitest.setup.ts`, `vitest.workspace.ts`, `vitest.config.ts`, `package.json`, `eslint.config.mjs`) and get `make test-front-unit` / `make test-front-browser` green.
4. Add E2E project skeleton (`e2e/` config, package, tsconfig, auth setup, seed script, `.gitignore`) before writing all journey specs.
5. Implement high-value E2E journeys that replace mocked page/proxy behavior first (`conversations`, `sharing`, `web-articles`, `epub`) so test deletions have coverage in place.
6. Trim mocked frontend tests (`proxy.test.ts` and page tests) only after mapped E2E replacements pass.
7. Centralize backend fixtures and add pytest markers across all backend test files; ensure `make test-back-unit` works.
8. Migrate factories/fixtures to ORM-backed setup and convert listed backend API assertions to behavior-first assertions.
9. Remove internal backend service patching (`test_send_message*`, `test_epub_ingest.py`, `test_media.py` seams where feasible), documenting any narrow temporary seam exception.
10. Finalize CI (`.github/workflows/ci.yml`) and run end-state acceptance commands (`make verify-fast`, `make verify`, `make test-e2e`) before merge.

---

## non-goals
- does not change product features, API contracts, or user-visible behavior outside test infrastructure and test code
- does not rewrite every existing backend assertion/mock in the repo beyond the listed cleanup scope and explicitly edited files (global backend marker rollout is included; full assertion/mock cleanup of untouched files is not)
- does not introduce enterprise governance/runbook/ownership documents beyond the standards doc and this PR spec
- does not guarantee specific runtime numbers (`<30s`, `<90s`) across all developer machines or CI hardware in this PR
- does not redesign application architecture solely to create perfect mock seams

---

## constraints
- implement in one PR (large diff and many commits are allowed)
- only touch files listed in deliverables unless this spec is revised during implementation
- preserve current product behavior and public contracts
- keep testing standards durable and PR spec migration-specific (avoid duplicating long-lived policy in multiple docs)
- prefer incremental replacement of brittle tests over broad rewrites unrelated to testing correctness
- every listed deliverable in this spec is required for merge unless removed or revised via an explicit spec update before code changes
- any deleted/trimmed mocked test coverage must have mapped replacement coverage in the same PR per the replacement mapping table
- any temporary exception to the target testing standards must be explicit in the decision ledger and removed before merge when feasible

---

## boundaries (for ai implementers)

**do**:
- implement only the testing standards and test-infrastructure changes listed in deliverables
- preserve behavior while changing tests (assertions may change, product semantics may not)
- replace internal mocks with real-stack or external-boundary testing where specified
- add E2E coverage for user journeys that replace mocked page/proxy tests
- keep changes auditable by mapping each cleanup to an acceptance test or replacement test

**do not**:
- ship unrelated product features or refactors under the cover of test cleanup
- leave new global mocks in shared frontend setup
- add new `happy-dom`-dependent tests
- bypass failing checks in CI (for example via `|| true`) to get the PR green
- silently keep internal behavior mocks without documenting an explicit temporary exception

---

## open questions + temporary defaults

| question | temporary default behavior | owner | due |
|---|---|---|---|
| none | n/a | n/a | n/a |

---

## checklist
- [x] every l3 acceptance bullet is in traceability matrix (using this PR's initiative acceptance items)
- [x] every traceability row has at least one test
- [x] every behavior-changing decision has assertions
- [ ] only scoped files are touched
- [x] non-goals are explicit and enforced
