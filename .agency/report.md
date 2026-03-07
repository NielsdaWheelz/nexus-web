# bugfix-library-members-search

## summary
- library member/invite management previously required raw user UUIDs — unusable for real humans
- implemented full email+display_name user identity layer: migration, bootstrap email sync from JWT, user search API, enriched member/invite responses, invite-by-email, display_name editing, frontend email search autocomplete
- 19 new backend integration tests, 16 frontend component tests, zero regressions across 160 backend tests

## decisions
- **email source**: extracted from Supabase JWT payload during bootstrap (every auth request), upserted with `ON CONFLICT DO UPDATE SET email = COALESCE(:email, users.email)` — no extra API call needed
- **search strategy**: email prefix match (`ILIKE 'query%'`) + display_name substring match (`ILIKE '%query%'`), minimum 3 chars, capped at 20 results, excludes self. uses escaped LIKE wildcards to prevent injection via `%` or `_` chars
- **invite backward compat**: `CreateLibraryInviteRequest` accepts both `invitee_user_id` (UUID) and `invitee_email` (string), at least one required. frontend detects which to send via `includes("@")`
- **display_name editing**: `PATCH /me` with `display_name` field, nullable, 1-100 chars. no signup page needed — users can edit from account pane
- **index strategy**: `text_pattern_ops` index on email for prefix LIKE. display_name search uses seq scan via ILIKE — fine at current scale, add GIN trigram index if user base grows to 100k+

## how to test
```bash
# backend: all tests including 19 new user profile + library member search tests
./scripts/with_test_services.sh bash -lc "make migrate-test && cd python && NEXUS_ENV=test uv run pytest tests/test_user_profiles.py tests/test_libraries.py tests/test_permissions.py -x --tb=short"

# frontend: component tests for LibraryEditDialog
cd apps/web && npx vitest run src/__tests__/components/LibraryEditDialog.test.tsx

# typecheck
cd apps/web && npx tsc --noEmit
```

## risks
- email uniqueness constraint assumes 1:1 supabase-auth-to-nexus-user mapping (correct by design)
- display_name search uses ILIKE %query% which is a seq scan — fine for current scale, add GIN trigram index if user base grows to 100k+
- bootstrap email sync is eventually consistent — email updates propagate on next authenticated request, not instantly
