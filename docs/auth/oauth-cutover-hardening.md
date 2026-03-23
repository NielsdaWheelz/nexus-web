# OAuth cutover hardening notes

## Scope

This branch removes client-side hash-token session import on `/login` and
enforces server-side callback exchange as the only supported session completion
path.

## Runtime expectations

- `AUTH_ALLOWED_REDIRECT_ORIGINS` must be configured for non-local callback
  traffic. Local/test traffic may fall back to request origin.
- Callback redirect `next` values are normalized to in-app paths only.
- `/auth/signout` uses local-scope signout and returns a 302 to `/login`.

## Public login behavior

- `/login` renders Google/GitHub OAuth entrypoints only.
- Email/password fields are intentionally removed from the page.
- Query-string auth errors are mapped to a small allowlisted set of safe
  messages.

## E2E auth bootstrap contract

- Test setup no longer depends on `/login` hash-token processing.
- The bootstrap path verifies a magic link, extracts session tokens, and writes
  Supabase session cookies directly in the Playwright context.
- The optional live GitHub round-trip assertion remains gated behind
  `E2E_GITHUB_USERNAME` and `E2E_GITHUB_PASSWORD` (plus `E2E_GITHUB_OTP_CODE`
  if prompted).
