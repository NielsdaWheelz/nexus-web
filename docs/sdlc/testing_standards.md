# Nexus Testing Standards

> Normative target-state document for tests in this repo. This describes the desired steady state, not necessarily the current state. All new tests must conform. Existing tests should be migrated when touched or when a planned cleanup PR explicitly owns them.

## 1. Philosophy

Tests exist to verify behavior, not implementation. Tests are the primary verification gate — specs give direction, but passing tests prove the code works.

- If a test breaks when internals are refactored but observable behavior is unchanged, the test is wrong.
- Tests are contracts: they document what the system promises to users and operators, not how the code is arranged internally.
- A passing test suite should mean "the product works." A failing test should mean "something meaningful regressed."
- Prefer fewer, higher-confidence tests over many shallow tests. One real user-flow E2E test is worth many brittle mocked tests.
- Use red/green TDD: write failing tests from acceptance criteria first (red), then write code to make them pass (green). This prevents both non-functional code and unnecessary code.
- When starting a session, run the existing test suite first. This reveals project scope, surfaces pre-existing failures, and establishes a testing mindset.

## 2. Scope and Definitions

This document covers backend (`python/`), frontend (`apps/web/`), and end-to-end tests (`e2e/`).

Definitions used throughout this document:

- `behavior`: observable HTTP responses, persisted state visible through supported APIs, rendered UI state, routing/navigation outcomes, and user-visible error handling.
- `implementation`: internal helper calls, module wiring, service composition, ORM query shape, React child composition details, or framework internals.
- `internal boundary`: code owned by this repo (for example `nexus.services.*`, `apps/web/src/lib/*`, Next.js BFF proxy code in this app).
- `external boundary`: third-party systems or APIs outside this repo (for example LLM providers, external object storage, external auth verification providers).
- `real stack`: real running app services and dependencies used in local/CI (Next.js, FastAPI, PostgreSQL, Supabase local), not mocked equivalents.

## 3. Testing Trophy (Adapted for SSR / Next.js)

```text
           /  E2E (Playwright)  \        <- LARGEST layer: real browser,
          /----------------------\          real server, real DB/services
         /   Component (Browser)  \       <- Vitest Browser Mode (Chromium)
        /--------------------------\         for UI behavior and browser APIs
       /  Unit (Node / pytest unit) \      <- Pure logic, no I/O
      /------------------------------\
     /        Static Analysis          \   <- TypeScript, ESLint, ruff
    /----------------------------------\
```

Note: the trophy visual is frontend/user-flow weighted. Backend integration is still a required, separate tier (Tier 3) and is not collapsed into E2E.

For server-rendered apps (Next.js App Router), E2E should be the largest test layer because:

1. SSR integration tests often require mocking framework boundaries, which undermines confidence.
2. Modern E2E tooling is fast enough to cover high-value user journeys directly.
3. Real-stack E2E catches routing, auth forwarding, streaming, rendering, and proxy bugs other layers miss.

Backend integration tests remain a separate tier (see Tier 3 below) because they validate API and DB behavior faster than E2E and provide better failure localization.

## 4. Test Tiers

### Tier 0: Static Analysis

- Frontend: TypeScript (`tsc --noEmit`)
- Frontend: ESLint (including testing rules)
- Backend: `ruff check`
- Backend: `ruff format --check`

Rules:

- Runs on every PR and in local verification commands.
- Treat static-analysis failures as real failures (no `|| true`).

### Tier 1: Unit Tests

- Backend: `pytest` tests marked `@pytest.mark.unit`
- Frontend: Vitest in Node environment

What belongs here:

- Pure functions (text processing, offsets, normalization, crypto wrappers, serializers)
- Schema validation
- Configuration parsing

What does not belong here:

- Database access
- Network calls
- React component rendering
- Anything that requires mocks to execute

Rules:

- No database fixtures, no file I/O, no network I/O
- No mocks by default; move the test up a tier if behavior depends on external interactions
- Keep tests fast and deterministic

### Tier 2: Component Tests (Frontend Only)

- Tool: Vitest Browser Mode (Playwright provider, real Chromium)

What belongs here:

- React component rendering and interaction
- Browser API usage (`Range`, `ResizeObserver`, clipboard, selection APIs)
- Interaction-heavy UI (highlighting, selection, drag/drop, toggles)
- UI behavior and accessibility states

What does not belong here:

- Page-level flows that require real app routing and API calls (E2E)
- Tests that rely on `vi.mock` of internal modules

Rules:

- Run in a real browser (no `happy-dom`, no `jsdom` fallback for component behavior)
- Prefer Testing Library queries (`getByRole`, `findByRole`, `getByText`) and user-level interactions
- No global `next/navigation` mock in shared setup

### Tier 3: Integration Tests (Backend Only)

- Tool: `pytest` tests marked `@pytest.mark.integration`

What belongs here:

- FastAPI endpoint tests via `TestClient`
- Database-backed service workflows
- Multi-step backend behavior that is faster to validate at API level than through UI

Rules:

- Use a real PostgreSQL test database
- Assert through API responses (status + payload), not raw SQL table inspection, except documented schema-level exceptions
- Mock only external boundaries (Section 6)
- Use ORM-backed factories and fixtures, not raw SQL inserts in factories

### Tier 4: E2E Tests

- Tool: Playwright against a real running stack

What belongs here:

- End-to-end user journeys
- Auth and session behavior
- BFF proxy behavior and token forwarding
- Streaming UX and cross-page workflows
- Multi-user permission and sharing flows

Rules:

- Run against real services (Next.js, FastAPI, PostgreSQL, Supabase local)
- No MSW, no mock API servers, no `vi.mock(fetch)` style shortcuts
- Use Playwright `storageState` for login reuse (authenticate once per worker where possible)
- Seed data through app APIs or dedicated seed scripts, not ad hoc SQL from browser tests
- Tests must be independent and parallelizable

## 5. Assertion Standards

### Backend: Assert Through the API

Prefer API-response assertions over raw SQL when testing API behavior.

```python
# WRONG: Asserting API behavior by querying tables directly
response = client.post("/libraries", json={"name": "Test"}, headers=headers)
assert response.status_code == 201
row = db.execute(text("SELECT role FROM memberships WHERE ..."))
assert row.scalar() == "admin"

# RIGHT: Assert the API contract
response = client.post("/libraries", json={"name": "Test"}, headers=headers)
assert response.status_code == 201
data = response.json()["data"]
assert data["role"] == "admin"

# ALSO RIGHT: Follow-up API read when create response does not include the field
members = client.get(f"/libraries/{lib_id}/members", headers=headers).json()["data"]
assert any(m["role"] == "admin" for m in members)
```

Exceptions:

- `python/tests/test_migrations.py` and other schema-level tests
- DB-level constraint tests where the API intentionally hides the internal detail (prefer ORM queries over raw SQL `text()` where feasible)

### Assertion Messages Should Be Rich

Include extra context in assertion messages. When a test fails, the failure message is often the only feedback an agent or developer sees. Rich messages enable faster self-correction.

```python
# WEAK: No context in failure
assert response.status_code == 201

# BETTER: Context in failure message
assert response.status_code == 201, (
    f"Expected 201 but got {response.status_code}: {response.json()}"
)

# BEST: Structured context for complex assertions
assert data["role"] == "admin", (
    f"Expected role='admin' for creator, got '{data['role']}'. "
    f"Library: {lib_id}, User: {user_id}, Full response: {data}"
)
```

This is especially valuable for integration and E2E tests where failures can be indirect and hard to diagnose.

### Frontend: Assert User-Visible Behavior

```typescript
// WRONG: Implementation-coupled callback assertions
const onToggle = vi.fn();
render(<Navbar onToggle={onToggle} />);
await user.click(screen.getByLabelText("Collapse"));
expect(onToggle).toHaveBeenCalledWith(true);

// RIGHT: Behavior assertion
render(<Navbar />);
await user.click(screen.getByLabelText("Collapse navigation"));
expect(screen.getByRole("navigation")).toHaveAttribute("aria-expanded", "false");
```

Guidelines:

- Prefer role/text/label queries over selectors and test IDs when practical
- Assert visible state, navigation outcome, or response behavior
- Avoid testing library/framework internals

## 6. Mocking Policy

### Allowed Mocks (External Boundaries Only)

| Boundary | Tool / Pattern | Why |
|---|---|---|
| External LLM APIs (OpenAI, Anthropic, Gemini) | `respx` (HTTP-level) | Third-party cost, nondeterminism, rate limits |
| External auth verification boundary | test verifier / fake verifier at boundary | Third-party dependency boundary |
| Async job dispatch boundary | mock queue enqueue helper | Verifies dispatch intent without running the worker inline |
| External object storage | mock storage client | Third-party service dependency |

### Disallowed Mocks (Internal Boundaries)

| Thing | Why |
|---|---|
| `patch("nexus.services.*")` | Couples tests to implementation; refactors break tests without behavior regressions |
| Database sessions/queries | The DB is part of the behavior contract for integration tests |
| Global `next/navigation` mock | Hides routing behavior and contaminates unrelated tests |
| `vi.mock` for internal API helpers / proxy modules | Bypasses the codepath under test |
| Internal React components | Stops testing real composition and behavior |
| The app's BFF proxy | Critical integration layer; must be tested real |

### MSW Policy

MSW is better than module-level mocks because it intercepts at the network boundary, but it is still a mock. For this project's target state, we do not use MSW.

Instead:

- Component tests validate rendering and interaction without network-dependent page flows
- Backend integration tests hit real DB/services and mock only external HTTP boundaries
- E2E tests hit the real running stack

### Exceptions (Temporary and Explicit)

Short-term exceptions are allowed only when migration work is in progress and the test would otherwise be deleted or blocked. Requirements:

- The exception must be documented in the PR description or a code comment at the mock site
- The exception must be time-bounded (for example, "remove in this PR before merge" or "remove in next planned cleanup PR")
- The exception must not be hidden in global/shared test setup
- If an external boundary is only reachable through an internal accessor in current code, a temporary patch at that seam may be used during migration, but the test must still assert behavior and the exception must be called out explicitly
- Every exception entry must name the intended replacement layer/test (or the exact follow-up test to be added)

## 7. Data Setup and Fixtures

### Backend: Factories Use ORM Models

Prefer ORM-backed factory helpers over raw SQL inserts.

```python
# WRONG: Raw SQL factory insert
def create_test_media(session, library_id, title="Test"):
    session.execute(text("INSERT INTO media (...) VALUES (...)"))

# RIGHT: ORM-backed factory insert
def create_test_media(session, library_id, title="Test"):
    media = Media(library_id=library_id, title=title, kind="web_article")
    session.add(media)
    session.flush()
    return media
```

Reasons:

- Uses the same validation/default paths as production code
- Reduces schema-coupled test breakage
- Produces clearer fixture code

### Backend: Fixture Placement

- `python/tests/conftest.py`: shared fixtures used in multiple files
- `python/tests/factories.py`: data creation helpers (single-entity helpers)
- `python/tests/fixtures.py`: composite fixtures / scenario setup
- test files: only test-local fixtures unique to that file

Rule:

- If the same fixture appears in multiple files, centralize it.

### E2E Seeding

- Seed through app APIs or a dedicated `e2e/` seed script
- Avoid direct DB writes from Playwright tests
- Prefer deterministic seed inputs and idempotent setup behavior
- Prefer Playwright `globalSetup` for centralized seeding/bootstrap so all invocation paths (`make test-e2e`, direct `bun run test:e2e`, CI) share identical setup guarantees
- `globalSetup` may load repo `.env`/runtime port files to mirror Makefile behavior when tests are run outside Make

### E2E Determinism and Pane-Aware Assertions

- Normalize persisted per-media state before asserting initial reader UI (for example, reset reader state and explicitly select chapter/page where applicable)
- Quote-to-chat assertions must be deterministic:
  - If the active pane is chat (`/conversations/new` or `/conversations/:id`), assert quote-to-chat updates that pane with new `attach_*` params and does not open another chat tab
  - If the active pane is not chat and exactly one chat pane exists, assert quote-to-chat updates that existing chat pane and does not open another chat tab
  - Otherwise, assert quote-to-chat opens one new chat pane at `/conversations/new` with the expected `attach_*` params
  - In all quote-to-chat cases, assert the linked-context chip is visible in chat composer after navigation
- Prefer explicit action-menu interactions (`Actions` -> `menuitem`) over styling-dependent selectors
- Keep single-flow E2E tests focused on one behavior; use API setup for prerequisites already covered by separate UI stress/interaction tests

## 8. Test Organization

### Backend Layout

```text
python/tests/
|- conftest.py
|- factories.py
|- fixtures.py
|- helpers.py
|- support/
|  `- ...
|- utils/
|  `- ...
|- test_*.py
```

Expectations:

- Mark every test file (module-level or class-level) with the appropriate pytest marker(s)
- Keep migration/schema tests separate (`test_migrations.py`)

### Frontend Layout

```text
apps/web/
|- vitest.config.ts           # unit (node) + browser (chromium) projects
|- vitest.setup.ts            # minimal shared setup (jest-dom, cleanup)
|- src/
|  |- lib/                    # pure unit tests live near pure modules
|  |- __tests__/components/   # browser-mode component tests
|  `- app/                    # avoid page-level vitest tests unless truly pure
```

Guidance:

- Pure utility tests stay near source files
- Browser-mode component tests can live in `src/__tests__/components/` or near components if consistent
- Page-level behavior belongs in E2E unless the page unit is truly pure and isolated

### E2E Layout

```text
e2e/
|- playwright.config.ts
|- global-setup.mjs
|- package.json
|- tsconfig.json
|- seed-*.ts
`- tests/
   |- auth.setup.ts
   `- *.spec.ts
```

## 9. Markers and Naming

### Pytest Markers

Expected marker set in `python/pyproject.toml`:

- `unit`: pure logic tests, no DB/network
- `integration`: DB/API-backed tests
- `slow`: tests that are materially slower than normal local feedback loops
- `supabase`: requires Supabase local auth/storage services

Rules:

- No unmarked backend tests
- Markers describe execution requirements, not implementation details

### Naming Conventions

Backend:

```python
def test_create_library_with_valid_name_returns_201():
def test_search_with_no_results_returns_empty_list():
```

Frontend (Vitest):

```typescript
it("shows error message when API returns 500")
it("navigates to article when card is clicked")
```

E2E (Playwright):

```typescript
test("user creates library -> library appears in sidebar")
test("user highlights text -> highlight persists after reload")
```

## 10. CI and Local Commands

Target local commands after migration:

```makefile
make check          # static analysis + format checks
make test-unit      # backend unit tests + frontend unit tests
make test           # full non-E2E verification
make verify         # check + build + non-E2E tests
make verify-full    # verify + E2E
make test-e2e       # Playwright E2E
make test-e2e-ui    # Playwright UI mode
make test-back-unit      # backend unit tests only
make test-back-integration # backend integration tests only
make test-front-unit     # frontend unit tests only (Node)
make test-front-browser   # frontend component tests (Vitest Browser Mode / Chromium)
make test-migrations     # migration/schema tests only
make test-supabase       # Supabase-local auth/storage tests only
make test-network        # network-dependent backend tests only
make test-real           # real-content backend tests only
cd e2e && bun run test:csp -- tests/youtube-transcript.csp.spec.ts --project=chromium-csp # strict CSP runtime assertions
```

Command semantics:

- `make check`: static checks and format checks only
- `make test-unit`: fast unit tests only (no DB, no browser-mode component tests, no E2E)
- `make test`: non-E2E automated tests, including backend integration and frontend browser-mode component tests
- `make verify`: check + build + non-E2E tests for routine development
- `make verify-full`: verify + E2E
- `make test-e2e`: explicit real-stack Playwright run (used before merge and in CI)
- `make test-e2e-ui`: interactive Playwright UI mode
- `bun run test:csp` in `e2e/`: strict CSP profile for runtime policy assertions against production Next runtime

Target CI shape:

1. Run static checks and type checks
2. Run backend and frontend tests in parallel where independent
3. Run E2E after lower layers pass
4. Upload E2E artifacts on failure (and optionally always)

## 11. What Not to Test

- Library internals (for example, PyNaCl internals, SQLAlchemy internals)
- Framework behavior already guaranteed by the framework (unless you are testing your integration with it)
- One-time migration audit assertions that are no longer part of ongoing product behavior
- Configuration introspection via implementation details (prefer runtime behavior assertions)

## 12. Migration Rules for Existing Tests

When modifying existing tests during cleanup:

1. Prefer replacement over patching brittle mocks
2. If deleting a test, identify the replacement layer (`unit`, `component`, `integration`, or `E2E`)
3. Do not add new global test mocks
4. Do not add new `happy-dom`-dependent tests
5. If a temporary exception is required, document it in the PR description and remove it before merge when feasible
