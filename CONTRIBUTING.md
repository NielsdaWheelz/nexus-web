# Contributing to Nexus

## Development Setup

1. Install prerequisites:
   - Python 3.12+
   - Node.js 20+
   - Docker
   - [uv](https://github.com/astral-sh/uv)

2. Run setup:
   ```bash
   make setup
   ```

3. Start development:
   ```bash
   make dev           # Start postgres + redis
   make api           # Start API (terminal 1)
   make web           # Start frontend (terminal 2)
   ```

## Code Style

### Backend (Python)

- Formatter: ruff
- Linter: ruff
- Run: `make lint` and `make fmt`

### Frontend (TypeScript)

- Formatter: Prettier (via ESLint)
- Linter: ESLint
- Run: `make lint-front`

### Key Rules

1. **Routes are transport-only**: No business logic in API routes or Next.js handlers
2. **No raw SQL in routes**: Only call service functions
3. **Single HtmlRenderer**: Only component allowed to use `dangerouslySetInnerHTML`
4. **BFF pattern**: Next.js route handlers proxy to FastAPI, no direct browser→FastAPI

## Testing

### Commands

```bash
make test              # All tests (backend + migrations + frontend)
make test-back         # Backend tests (excludes migrations)
make test-migrations   # Migration tests
make test-front        # Frontend tests
make test-supabase     # Supabase auth/storage integration tests (opt-in)
make verify            # Full verification
```

### Writing Tests

- **Backend**: Use `authenticated_client` fixture for auth tests
- **Frontend**: Mock fetch for unit tests, real stack for integration
- **Fixtures**: Use `seeded_media` fixture for media tests

### Test Environment

- `NEXUS_ENV=test` enables test-only endpoints
- Tests use `MockJwtVerifier` with local RSA keypair
- Database uses savepoint isolation (auto-rollback)
- Backend tests are hermetic by default: they start their own Postgres + Redis
- `make test-supabase` starts and stops Supabase local (set `SUPABASE_KEEP_RUNNING=1` to keep it up)
- Override hermetic ports with `TEST_POSTGRES_PORT` / `TEST_REDIS_PORT`
- Hermetic test env variables are centralized in `scripts/test_env.sh`

## Pull Request Checklist

- [ ] Tests pass: `make test`
- [ ] Linting passes: `make lint && make lint-front`
- [ ] No new `dangerouslySetInnerHTML` outside HtmlRenderer
- [ ] No direct FastAPI calls from browser code
- [ ] No access tokens in localStorage/sessionStorage
- [ ] API routes are 3-10 lines and delegate to services
- [ ] Error responses use standard envelope format
- [ ] Visibility rules enforced server-side

## Architecture Constraints

### Authentication

- Supabase auth only
- Access tokens never in browser storage
- All auth validation in FastAPI

### Request Topology

```
Browser → Next.js (BFF) → FastAPI → Database
```

- Browser NEVER calls FastAPI directly
- Next.js attaches Bearer token + internal header
- FastAPI is single source of truth for auth/visibility

### Error Handling

- Standard envelope: `{ data: ... }` or `{ error: { code, message } }`
- 404 for existence masking (not 403)
- Error codes: `E_CATEGORY_NAME` format

## Slice Development

See `docs/v1/slice_roadmap.md` for feature slices.

### Current Slice: S0 (Auth + Libraries Core)

- Auth flow working
- Library CRUD
- Pane-based UI shell
- Seeded fixture media

### Not Yet Implemented

- Real media ingestion
- Highlights/annotations
- Chat/conversations
- Search
