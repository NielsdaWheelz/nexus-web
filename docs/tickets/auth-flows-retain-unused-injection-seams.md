# auth flows retain unused injection seams

status: open · origin: 2026-09-21 auth audit · area: web auth

under `apps/web/src/`, `lib/auth/login-entry.ts:12-15` accepts a verification
function; its sole caller passes `getSessionVerification`. the callback's
single-use dependency/wire wrapper was removed in the 2026-10-02 native failure
repair; callback now owns fixed sdk execution and response publication.
the structural clients in `password-flow.ts:27-51` and
`email-confirmation.ts:23-30` have only the fixed sdk implementation, but this
alone does not prove waste: these flows own substantial provider-to-product
error projection while routes own cookie clients. their narrow capabilities
need reassessment after the concrete callback/login cuts, not automatic deletion
or replacement with whole-sdk dependencies.

fix: inline the one-use login planning where it clarifies control
flow; let auth own its fixed sdk dependency. retain operation-specific error
projection and any interface that actually hides substantial complexity.

next bounded cut after native handoff: move the 37-line login planning module's
sole decision into `app/login/page.tsx`, then remove its plan union and injected
reader. preserve anonymous render versus verified target redirect;
`AuthDependencyError`, refresh-required and ended sessions recover; unexpected
defects propagate. keep sanitized/default/deep targets, feedback precedence and
shell props intact. do not substitute `dal.verifySession`: its anonymous case
redirects to login, unlike this page's render policy. verify controlled actual
page outcomes and redirects, then the sole static gate; no provider/db needed.

acceptance: the remaining login indirection is removed at its responsible owner;
remaining structural interfaces are retained or changed based on actual
ownership and complexity evidence. oauth/native callback, login recovery,
password and email-link outcomes retain their wire contracts. pass
`./scripts/test`.
