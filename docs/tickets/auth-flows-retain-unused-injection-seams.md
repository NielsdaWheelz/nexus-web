# auth flows retain unused injection seams

status: open · origin: 2026-09-21 auth audit · area: web auth

under `apps/web/src/`, `lib/auth/callback.ts:16-26` accepts callback
dependencies from its sole route caller, which wraps the sdk and reshapes
an error only to have its truthiness checked. `lib/auth/login-entry.ts:12-15`
accepts a verification function; its sole caller passes `getSessionVerification`.
the structural clients in `password-flow.ts:27-51` and
`email-confirmation.ts:23-30` likewise have only the fixed sdk implementation.

fix: inline the one-use callback/login planning where it clarifies control
flow; let auth own its fixed sdk dependency. retain operation-specific error
projection and any interface that actually hides substantial complexity.

acceptance: no alternate injected implementation remains without a production
consumer; oauth/native callback, login recovery, password and email-link
outcomes retain their wire contracts. pass `./scripts/test`.
