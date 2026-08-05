# Invite-Only Password Auth Hard Cutover

Status: APPROVED SPEC — 2026-08-05

Type: hard cutover. No legacy signup route, password-removal path, compatibility
alias, fallback, dual behavior, or feature flag.

No blocking question remains. Decisions already approved:

- Supabase Dashboard is the invitation control plane.
- Existing users keep OAuth sign-in.
- Invited users can use email/password without OAuth.
- Nexus has no public signup or in-app user administration.
- An authenticated user gets one **Set or replace password** action.

## Goal

Provide closed-membership authentication for a tiny prototype:

1. existing users can sign in with Google/GitHub;
2. the operator can invite a person from the Supabase Dashboard;
3. the invitee can choose, use, replace, and recover an email password; and
4. every auth attempt reaches an explicit terminal state.

Supabase owns users, password hashes, email tokens, provider identities, and
sessions. Nexus owns the ceremony, routing, copy, strict error projection, and
proof.

## Target behavior

- `/login` offers email/password, **Forgot password?**, Google, and GitHub.
- There is no create-account toggle and `/sign-up` does not exist.
- Global Supabase signup is disabled. Existing users can sign in; only an admin
  invitation can create another user.
- A dashboard invitation email opens a safe landing page. Only the user's
  **Accept invitation** POST consumes the token, establishes the session, and
  lands on **Choose a password**.
- `/account/password` is a focused protected surface outside the workspace
  shell. It serves invitation, recovery, and settings entry points.
- Account settings always says **Set or replace password**. Linked Identities
  remains OAuth-only and never claims whether a password exists.
- The Account-settings action links to
  `/account/password?next=/settings/account`; invitation/recovery use the
  canonical authenticated home as their Continue target.
- A successful update remains visibly confirmed until the user chooses
  **Continue**.
- Password recovery gives the same public response for known and unknown email
  addresses.
- Invalid or expired email links end with explicit recovery guidance.
- Display-name editing remains the existing Account-settings capability. It is
  not part of authentication.

## Scope and key decisions

In scope: closed provider configuration, invitation acceptance, password
sign-in, one set/replace operation, password recovery, explicit UX outcomes,
provider-config proof, and the smallest real-stack auth journeys.

- Dashboard invitation is the only provisioning ceremony.
- The email link proves membership; setting a password is not another access
  gate.
- A buddy may ignore OAuth; Nexus does not enforce password-only authentication.
- An active verified session is sufficient to set/replace a password in this
  prototype.
- Nexus stores no invitation, enrollment, authenticator, or password state.
- Email-link GET is non-consuming; only explicit POST may spend a token.

## Capability contract

| Capability | Actor | Supabase operation | Nexus success |
| --- | --- | --- | --- |
| OAuth sign-in | existing user | `signInWithOAuth` + PKCE callback | verified session, validated return target |
| Password sign-in | existing user | `signInWithPassword` | verified session, validated return target |
| Accept invitation | dashboard-invited user | explicit POST, then `verifyOtp({ token_hash, type: "invite" })` | session, then `/account/password` |
| Set or replace password | authenticated user | `updateUser({ password })` | persistent **Password saved** state |
| Request/complete recovery | anyone / link holder | `resetPasswordForEmail`, then `verifyOtp({ type: "recovery" })` | session, then the same password surface |

No other account-creation or password capability exists.

### Membership contract

```text
absent
  -> admin invitation creates Supabase user
  -> invitation token verifies email and creates session
  -> invitee sets password
  -> ordinary password sign-in
```

`auth.enable_signup = false` is the membership boundary: Supabase documents
that disabling new-user signup leaves sign-in available only to existing users.
Admin invitations are the only provisioning path.

The invitation session is valid application access even before a password is
set. Password enrollment is for future sign-in, not a second membership gate.
There is therefore no `enrollment_complete` flag or onboarding authorization
state.

“Email/password only” is a supported user journey, not an authentication-method
restriction. Nexus does not prevent an existing account from later using a
linked OAuth identity.

## Final architecture

```text
Supabase Dashboard
  -> admin invite
  -> custom invite email: token_hash
  -> GET /auth/invite
       no-store/no-referrer landing; token remains unused
  -> POST /auth/confirm/invite
       route fixes type=invite
       Supabase verifyOtp
       session cookies
  -> GET /account/password
  -> POST /auth/password/update
       Supabase updateUser
  -> Password saved -> Continue
  -> first product request
       existing FastAPI idempotent user/default-library bootstrap
```

```text
/forgot-password
  -> POST /auth/password/recovery
       always the same public acknowledgement
       Supabase resetPasswordForEmail
  -> custom recovery email: token_hash
  -> GET /auth/recovery
       no-store/no-referrer landing; token remains unused
  -> POST /auth/confirm/recovery
       route fixes type=recovery
       Supabase verifyOtp
  -> the same /account/password update path
```

The existing `/auth/callback` remains OAuth/PKCE-code-only. Supabase admin
invitations do not have a PKCE verifier; invitation and recovery email templates
must therefore use token-hash landing pages and POST confirmation routes. Do not
combine the two callback protocols, consume a token on GET, accept a
caller-selected verification type, or accept a return target from an email URL.
This prevents email-link scanners from consuming a one-time credential.

## State and schemas

No Nexus database migration, table, column, trigger, password status, invitation
record, or role is added.

Provider-owned state:

- `auth.users`: principal, verified email, password hash, session metadata;
- `auth.identities`: external/email identities only, never password presence;
- Supabase email token storage: invitation and recovery lifecycle.

Nexus continues to key users by Supabase UUID. The existing FastAPI bootstrap
creates the application `users` row and default library on first authenticated
product access.

Internal boundary types are exhaustive tagged outcomes:

```ts
type EmailLinkKind = "invite" | "recovery";

type PasswordSignInOutcome =
  | { kind: "SignedIn" }
  | { kind: "InvalidCredentials" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };

type PasswordUpdateOutcome =
  | { kind: "Saved" }
  | { kind: "PolicyRejected"; reasons: readonly ["length"] }
  | { kind: "SessionEnded" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };

type PasswordRecoveryOutcome =
  | { kind: "Requested" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };

type EmailConfirmationOutcome =
  | { kind: "Confirmed"; purpose: EmailLinkKind }
  | { kind: "InvalidOrExpired" }
  | { kind: "RateLimited" }
  | { kind: "ServiceUnavailable" };
```

Unknown provider codes and malformed provider payloads are defects, not generic
expected failures. Raw tokens, passwords, cookies, and email URLs never enter
application logs or public errors.

## HTTP design

Form mutations are server-owned endpoints and use `303 See Other` on success.
Mounted forms retain drafts across typed, no-store failure responses and follow
the successful redirect; email addresses and one-time tokens never enter a
redirect URL. Email-link GETs only render confirmation forms; they never call
Supabase. Every auth response is `no-store`.

| Endpoint | Access | Input | Result |
| --- | --- | --- | --- |
| `POST /auth/password/sign-in` | public | `email`, `password`, optional canonical `next` | login feedback or session + target |
| `POST /auth/password/recovery` | public | `email` | `/forgot-password?sent=1` for every address |
| `GET /auth/invite` | public | non-empty `token_hash` | non-consuming **Accept invitation** form |
| `POST /auth/confirm/invite` | public | non-empty `token_hash` | `verifyOtp(type=invite)`; session + `/account/password` |
| `GET /auth/recovery` | public | non-empty `token_hash` | non-consuming **Continue password reset** form |
| `POST /auth/confirm/recovery` | public | non-empty `token_hash` | `verifyOtp(type=recovery)`; session + `/account/password` |
| `POST /auth/password/update` | authenticated by handler | `password`, optional canonical `next` | `/account/password?saved=1` |

`/auth/password/update` is middleware-pass-through so its handler can return a
correct `303` for an ended session; the handler itself verifies the Supabase
session before mutation. Public reachability is not authorization.

`/account/password` is outside the authenticated workspace layout but calls the
existing `verifySession()` gate directly before rendering.

`next` uses the existing `AuthReturnTarget` parser/builders. Email confirmation
has one fixed destination and accepts no return target from the email URL. The
landing responses add `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex, nofollow`; token hashes are posted in the form body and
never appear in the post-confirmation URL or application logs.

The adapter branches on stable Supabase `AuthError.code`, never message text.
`same_password` is `Saved`: **Set or replace** is intentionally convergent, so a
retry after an ambiguous timeout reaches the correct result.

## UX rules

- Reuse `FeedbackNotice`, `Button`, `Input`, auth-return-target helpers, callback
  origin validation, route-handler cookie application, and bounded Supabase
  fetches.
- Extract one small branded `AuthSurface` only for the literal frame shared by
  login, forgot-password, and password-update pages. Do not create an auth UI
  framework.
- Use `autocomplete="email"`, `current-password`, and `new-password` correctly.
- Allow paste and password managers; provide a reveal control.
- Disable repeat submit while pending. Preserve email after recoverable failure;
  clear password fields.
- Field errors are adjacent; page-level outcomes use `FeedbackNotice` and are
  announced as status/alert. A toast is never the sole outcome.
- Password creation policy is at least 15 characters, with no composition rule
  or periodic rotation.
- The public reset acknowledgement is: **If this email belongs to a Nexus
  account, a password-reset link is on its way.**
- The authenticated success is: **Password saved. You can now sign in with your
  email and password.**

## Security and configuration

Required local and hosted state:

- global signup disabled;
- anonymous users and the phone provider disabled;
- custom OAuth, third-party Auth integrations, SAML, passkeys, Auth hooks,
  unverified-email sign-in, CAPTCHA, and compromised-password add-ons disabled
  under this prototype's explicit non-goals;
- email provider enabled (`auth.email.enable_signup = true` despite that CLI
  name); global signup closure still prevents new public users;
- email confirmation enabled;
- minimum password length `15`; no composition requirement;
- exact site URL and callback allowlist; no wildcard;
- custom invite and recovery templates targeting their non-consuming landing
  pages with `{{ .TokenHash }}`;
- production SMTP before inviting a production user;
- password-changed notification enabled;
- ordinary Google/GitHub identity linking enabled;
- existing Supabase rate limits retained.

The email-provider switch must remain enabled: GoTrue checks it during
`signInWithPassword` and returns `email_provider_disabled` when it is false.

An active or refreshable verified session is sufficient authorization to set or
replace a password in this prototype. The update POST refreshes in place before
continuing the same submitted mutation. Hosted reauthentication and
current-password requirements stay disabled; their additional UX branches,
CAPTCHA, compromised-password subscription features, and session revocation UI
are deliberately deferred. The reauthentication flag is release-gated through
the supported Management API. The newer current-password toggle is a documented
dashboard check until that API exposes it; no private Studio endpoint is a
deployment dependency.

The existing deployed-auth verifier becomes the single full Auth configuration
gate. It verifies signup closure, the exact provider/hook and password-update
posture, password policy, SMTP/notification/template state, site URL, and exact
redirect allowlist. It never prints secrets or template tokens.

## Hard cut and ownership cleanup

Delete, do not preserve:

- `/sign-up` and `?mode=create` behavior;
- `signUp()` and the post-signup display-name PATCH;
- the overloaded `POST /auth/password` route;
- `password-actions.ts` and parallel set/change/remove actions;
- password removal UI, messages, helpers, and its call to `unlinkIdentity`;
- `findEmailIdentity`, `mayRemovePassword`, and every inference that an email
  identity means a password exists;
- message-substring classification for password errors;
- stale documentation claiming passwords live in `auth.identities`;
- tests or route mappings that encode any deleted path.

Keep unchanged:

- OAuth start, PKCE callback, Android handoff, refresh, signout, and return-target
  contracts;
- ordinary OAuth start/link behavior and multi-OAuth unlinking; unlink safety
  never treats an email identity as proof that a usable password exists;
- FastAPI JWT verification and idempotent account bootstrap;
- Account settings as the display-name owner;
- Supabase as the only password/token/session store.

No compatibility redirects, re-export shims, legacy form modes, or source-grep
tombstone tests remain after the cutover.

## Implementation surface

Create:

- `apps/web/src/app/auth/invite/page.tsx`
- `apps/web/src/app/auth/recovery/page.tsx`
- `apps/web/src/app/auth/confirm/invite/route.ts`
- `apps/web/src/app/auth/confirm/recovery/route.ts`
- `apps/web/src/app/auth/password/sign-in/route.ts`
- `apps/web/src/app/auth/password/recovery/route.ts`
- `apps/web/src/app/auth/password/update/route.ts`
- `apps/web/src/app/forgot-password/page.tsx`
- `apps/web/src/app/account/password/page.tsx`
- focused client forms beside the two pages for pending/reveal/accessible
  feedback; no shared form-state framework
- `apps/web/src/components/auth/AuthSurface.tsx` and its CSS module
- `apps/web/src/components/auth/EmailActionLanding.tsx` for the two fixed,
  non-consuming email-link pages
- `apps/web/src/lib/auth/email-confirmation.ts`
- `supabase/templates/invite.html`
- `supabase/templates/recovery.html`
- `apps/web/src/lib/auth/email-confirmation.unit.test.ts`
- focused password-flow and auth-surface browser proofs
- `apps/web/e2e/journeys/password-recovery.journey.spec.ts`
- `deploy/supabase/verify-auth-config.sh`
- `deploy/smoke/auth-smoke.sh`

Change:

- login page/client/styles: sign-in only, recovery link, shared frame;
- `password-flow.ts`: sign-in, recovery, and convergent update only;
- `messages.ts`: code-driven finite public projections;
- `redirects.ts`: remove create-mode construction;
- Account settings: add one state-independent **Set or replace password** link;
- Settings index: publish the existing Account settings destination;
- `SettingsIdentitiesPaneBody.tsx`: OAuth identities only;
- identity unlink action: reject `provider=email` at its authenticated boundary;
- `identities.ts`: retain identity behavior, remove password helpers;
- Supabase config/templates, middleware pass-through routes and landing security
  headers, deployment smoke, Make target references, architecture, env docs,
  and local codebase rules;
- the test controller: copy template assets into each isolated Supabase workdir,
  provide an admin-invite fixture, and expose the existing typed Inbucket
  endpoint without exposing the service-role key to Playwright;
- the existing mailbox helper: reuse/extract its strict captured-email link
  parsing for the journeys;
- `apps/web/e2e/journeys/auth-session.journey.spec.ts`: own the invitation,
  first-password, sign-in, replacement, and refresh lifecycle;
- `apps/web/e2e/fixtures.ts`, `python/nexus_test_control/{runtime,services,runner}.py`,
  their focused kernel tests, and `testdata/proofs.json`: route the two exact
  critical journeys through controller-owned admin credentials and captured
  mail.

Delete:

- `apps/web/src/app/sign-up/page.tsx`
- `apps/web/src/app/auth/password/route.ts`
- `apps/web/src/lib/auth/password-actions.ts`
- `apps/web/src/app/(authenticated)/settings/identities/PasswordRow.tsx`
- `deploy/supabase/verify-auth-redirects.sh` after all callers move to the new
  full-config verifier
- `deploy/smoke/auth-redirect-construction-smoke.sh` and the
  `smoke-auth-redirects` Make target after callers move to `auth-smoke.sh` and
  `make smoke-auth`.

No database migration is allowed by this scope.

## Acceptance criteria

1. Provider configuration and source contain no public account-creation path;
   a direct `signUp()` attempt returns `signup_disabled`.
2. An existing OAuth user still signs in after signup is disabled.
3. A dashboard-invited address receives the custom email. GET/scanner prefetch
   does not consume it; one explicit acceptance POST does, creates a session,
   and lands on `/account/password` with no token in the destination URL.
4. The invitee saves a valid password, signs out, and signs in with it.
5. Any authenticated user can replace a password; the old value then fails and
   the new value succeeds. Retrying the same value succeeds idempotently.
6. Known and unknown recovery requests render materially identical public
   responses. A valid recovery link reaches the same update surface; the old
   password fails afterward.
7. Invalid, expired, reused, and malformed email links do not create a session
   and show stable recovery guidance. No endpoint accepts a caller-selected
   purpose.
8. Weak password, invalid credentials, ended session, `429`, provider `5xx`,
   and ambiguous network failure each reach an explicit terminal state.
9. Password UI and behavior are unchanged by the contents of
   `auth.identities`; there is no password-removal capability or claim.
10. Auth success is never reclassified by a FastAPI profile write. First product
    access still bootstraps the user/default library idempotently.
11. Pending, error, and success states are keyboard-operable and announced to a
    screen reader; duplicate submit cannot produce contradictory feedback.
12. The deployed Auth gate proves signup and anonymous-user closure, the exact
   enabled provider set and absence of third-party Auth integrations,
   SMTP/template and notification state, password policy, site URL, and redirect
   configuration before release.
13. No browser/app runtime contains a Supabase service-role/admin key, and no
    Nexus database schema stores password, invitation, or password-presence
    state.

## Proof plan

Use the smallest independent proofs required by `docs/rules/testing.md` and
`docs/local-rules/testing-standards.md`:

- kernel: strict token landing/POST decoding, scanner-safe non-consumption, and
  exhaustive provider-code projection;
- browser component: login/recovery/password terminal and accessible states;
- real-stack journey 1: admin invite -> Inbucket -> confirm -> set -> sign out ->
  password sign-in -> replace -> old fails/new works;
- real-stack journey 2: known/unknown reset response parity -> Inbucket ->
  confirm -> replace -> old fails/new works;
- deployment proof: hosted Auth configuration and existing OAuth canary.

Use real local GoTrue, cookie handling, Chromium, FastAPI, PostgreSQL, and
Inbucket. Mock only external SMTP delivery beyond the local captured-mail
boundary.
Demonstrate sensitivity against the pre-cutover password-state defect and an
injected wrong confirmation/error projection before claiming completion.

## Non-goals

- Public signup, email allowlists, or invite codes.
- In-app invitations, resend, user lists, roles, or administration.
- Enforcing that an invitee never chooses OAuth.
- Account merge or new identity-linking work.
- Password presence, last-changed metadata, or password deletion.
- Passkeys, MFA, recovery codes, security dashboards, or session/device UI.
- Custom password hashing, Auth tables, hooks, triggers, or application tokens.
- Step-up/nonce/current-password flows.
- CAPTCHA or adaptive-risk machinery.
- Identity-provider migration.

## Ordered cutover

1. Inventory `auth.users`; verify the existing owner can still use OAuth.
2. Land the scanner-safe landing/confirmation, update, recovery, templates, UI,
   and proofs as one application change.
3. Configure hosted SMTP, templates, notification, password policy, and disable
   global signup while retaining the email provider during the cutover window.
4. Run the full Auth configuration gate and OAuth/password smoke.
5. Send the buddy invitation only after the gate passes.

Failures are forward-fixed. Deleted application paths are not restored.

## Provider references

- [Supabase general Auth configuration](https://supabase.com/docs/guides/auth/general-configuration)
- [Supabase users and dashboard invitations](https://supabase.com/docs/guides/auth/users)
- [Supabase email-template token hashes](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase stable Auth error codes](https://supabase.com/docs/guides/auth/debugging/error-codes)
