# Password authentication

Status: Spec.
Scope owner: `apps/web` + `python/nexus`.
Date: 2026-05-20.

## 1. Summary

Adds email + password authentication as a first-class sign-in method alongside the existing Google and GitHub OAuth flows. Coexists with linked-identity management: a user may sign up with email/password, sign up with OAuth and later add a password, or have multiple sign-in methods at once. Works identically on the web and inside the Android WebView shell (same-origin form, no deep links, no native code).

Hard cutover. No feature flag. No fallback. No backward compatibility — there is no prior password code to be compatible with. One PR brings the feature live; Supabase config flips simultaneously.

The implementation is thin because Supabase Auth ships email/password natively (`signInWithPassword`, `signUp`, `updateUser`, `unlinkIdentity({ provider: "email" })`). The work is overwhelmingly UI, server-action plumbing, and a single FastAPI display-name endpoint. No password hashing, no reset-token table, no SMTP, no schema changes to `public.users`.

## 2. Problem

The login page in `apps/web/src/app/login/page.tsx` exposes only Google and GitHub OAuth. A user who prefers not to use a third-party identity provider, or who wants a recoverable credential that is not tied to a Google/GitHub account, has no way in. The codebase otherwise treats Supabase Auth as the authentication substrate (`apps/web/src/lib/supabase/*`, `python/nexus/auth/middleware.py`) but only consumes Supabase's OAuth surface.

Three feature gaps follow:

| Gap | Where today | What's missing |
|---|---|---|
| Sign in with email/password | `LoginPageClient.tsx` renders only `ProviderForm` | No email/password form, no `signInWithPassword` call site |
| Sign up open to anyone | No `/sign-up` route exists | Sign-up route, server action calling `signUp`, link from `/login` |
| Manage password / email on an existing account | `/settings/identities` lets you link/unlink OAuth identities; no email/password row, no email change, no display-name change | Password row in identities pane; new `/settings/account` for email and display name |

## 3. Goals

- **G1.** A new user signs up at `/sign-up` with email + password + display name and lands at `/libraries` already signed in.
- **G2.** An existing user with a password signs in at `/login` with email + password and lands at the requested protected route.
- **G3.** A user signed in via OAuth can set a password on their account from `/settings/identities` without losing any linked OAuth identity.
- **G4.** A user with a password can change the password from `/settings/identities`.
- **G5.** A user with at least one OAuth identity can remove their password (unlink the email identity) from `/settings/identities`, provided they keep at least one sign-in method.
- **G6.** A user can change their account email and display name from `/settings/account`. Email change is instant under the current `enable_confirmations = false` configuration; the JWT `email` claim updates, the bootstrap callback syncs `public.users.email` on next FastAPI hit.
- **G7.** All of G1–G6 work identically inside the Android WebView shell, with no native code changes and no new deep-link surfaces.
- **G8.** Open signup. Anyone with a valid email can create an account. No invite tokens, no allow-list.

## 4. Non-Goals

- **N1.** Password reset by email ("forgot password"). Skipped because no SMTP provider is wired and adding one is out of scope. A user who forgets their password and has no linked OAuth identity is locked out; this is acceptable for the current operational footprint.
- **N2.** Usernames. The user model is keyed by email + display name. No `username` column is added; no username-based sign-in is supported.
- **N3.** Email-address verification. `[auth.email] enable_confirmations` stays `false`. New emails take effect immediately. Reintroducing verification is a follow-up that requires SMTP.
- **N4.** Magic-link sign-in, OTP, TOTP, WebAuthn, passkeys, biometric unlock. Out of scope.
- **N5.** Password-strength meter, breach-corpus check (HIBP), or any password requirement beyond a minimum length.
- **N6.** Account deletion or data export. The privacy policy continues to direct users to support.
- **N7.** Rate limiting or fraud detection beyond Supabase's built-in defaults. Supabase enforces ~30 auth attempts per IP per 5 minutes.
- **N8.** A native Kotlin password UI on Android. Password forms render in the WebView, same-origin. No `nexus://` deep links are added for password flows.
- **N9.** A migration / coexistence period. Password support ships in one PR; the feature is either present or it is not.
- **N10.** Any change to OAuth flows. Google + GitHub flows are untouched. Rule I1 of `docs/android-auth.md` (no OAuth provider URL in WebView) is preserved unchanged.

## 5. Scope

**In scope.** The Next.js web app (`apps/web`): new `/sign-up` and `/settings/account` routes; password fields on `/login`; new server actions for password and email/display-name management; a Password row on `/settings/identities`; whitelisted message constants; middleware public-route additions. The FastAPI backend (`python/nexus`): one new endpoint to update `public.users.display_name`. The Supabase project configuration (`supabase/config.toml`): enable signup, set minimum password length, leave email confirmations off. Docs: this spec; one-paragraph update to `docs/android-auth.md`; one-line update to `docs/rules/codebase.md`.

**Out of scope.** SMTP. The `auth_handoff_codes` table and Android native auth pipeline (`apps/android`, `/auth/native/google`, `/auth/handoff`, `/auth/oauth?flow=handoff`). The Postgres `public.users` schema (no new columns). The extension session model. The worker.

## 6. Glossary

- **Email identity.** A row in Supabase's `auth.identities` table with `provider = 'email'`. Created by `signUp({ email, password })` or by calling `updateUser({ password })` on a user who has no email identity yet. Removed by `unlinkIdentity({ provider: 'email' })`. Existence of an email identity is equivalent to "this user has a password set."
- **OAuth identity.** A row in `auth.identities` with `provider = 'google'` or `'github'`. Managed today by `/settings/identities`.
- **Sign-in method.** Any identity row (email, google, github). A user must always have at least one.
- **Linked identity.** A non-primary identity attached to a user. From the user's perspective, all identities are equivalent; "linked" is a UI label, not a database property.
- **Set a password.** Calling `updateUser({ password })` on a user with no current email identity. Creates the identity. Used by OAuth-only users who want to add a password.
- **Change password.** Calling `updateUser({ password })` on a user who already has an email identity. Replaces the password hash. The user is already signed in.
- **Remove password.** Calling `unlinkIdentity({ provider: 'email' })`. Removes the email identity. Subject to the "keep ≥1 sign-in method" invariant.
- **Bootstrap callback.** The function `ensure_user_and_default_library` in `python/nexus/services/bootstrap.py`, invoked by `AuthMiddleware` on the first authenticated FastAPI request after sign-in or sign-up. Creates the `public.users` row (idempotent UPSERT) and the default library. Identity-agnostic: it does not care how the JWT was minted.
- **Whitelisted message.** A user-facing string in `apps/web/src/lib/auth/messages.ts`. Any error displayed to the user must be one of these constants; raw Supabase or upstream errors are never surfaced.

## 7. Target behaviour

### 7.1 Sign-up (new account)

1. User navigates to `/login`, clicks "Create account."
2. `/sign-up` renders a Server Component shell that delegates to a Client Component form with three fields: email, password, display name.
3. User submits. The form submits to a Server Action `signUpWithPasswordAction({ email, password, displayName })`.
4. The action runs a `createRouteHandlerClient()` and calls `supabase.auth.signUp({ email, password, options: { data: { display_name: displayName } } })`.
5. On Supabase success: cookies are settled, applied via `applyCookies`, the action throws a `redirect("/libraries")` (Next.js Server Action redirect). The browser/WebView follows the 303 and navigates to `/libraries`.
6. On the first authenticated FastAPI call from `/libraries`, `AuthMiddleware` fires `ensure_user_and_default_library(user_id, email)`. The `public.users` row is created with `email` set from the JWT. The default library is created.
7. The display-name from `user_metadata.display_name` is read by the front-end where needed (existing OAuth users already do this for Google's `name`). It is also written into `public.users.display_name` by the server action via the new `PATCH /me/display-name` BFF call **after** the signup session is established and **before** the redirect. (See §11.3 for ordering.)
8. On Supabase failure (email already in use, password too short, generic error), the action returns `{ ok: false, error: "<whitelisted constant>" }`. The form re-renders with a `FeedbackNotice` carrying the message. No partial state: no `auth.users` row is created if Supabase rejects.

Cancel path: the user clicks "Cancel" or navigates away. No state has been written. No cleanup required.

### 7.2 Sign-in (existing account)

1. User navigates to `/login`.
2. The page renders the existing OAuth buttons **and** a new email/password form. Both render identically in the browser and the Android WebView shell (`isShell` does not branch the password form; it branches OAuth only).
3. User submits. The form submits to a Server Action `signInWithPasswordAction({ email, password, nextPath })`.
4. The action calls `supabase.auth.signInWithPassword({ email, password })`.
5. On success: cookies applied, redirect to `nextPath` (validated against the existing safe-redirect rules; defaults to `/libraries`).
6. On failure: returns `{ ok: false, error: PASSWORD_SIGN_IN_FAILURE_MESSAGE }`. The form re-renders with the notice. We do not distinguish "no such email" from "wrong password" in the UI; the message is intentionally uniform.

### 7.3 Set password on an existing OAuth account

Entry: `/settings/identities`. The pane queries linked identities via the existing `loadLinkedIdentities()` server action, which calls `supabase.auth.getUserIdentities()`. The result includes any `provider = 'email'` row.

1. If the user has **no** email identity: the Password row renders "No password set" + a "Set password" button.
2. The user clicks "Set password." A Client-only modal collects the new password (single field; no email — the email is already on the user) and submits to `setPasswordAction({ password })`.
3. The action calls `supabase.auth.updateUser({ password })`. Supabase implicitly creates the email identity using the user's current `auth.users.email`.
4. On success: the modal closes, the identities list reloads, the Password row now shows "Password set on <current email>." The user remains signed in.
5. On failure: a `FeedbackNotice` carries `PASSWORD_CHANGE_FAILURE_MESSAGE`. The password field is cleared. No partial state.

### 7.4 Change password

Entry: `/settings/identities`, when an email identity already exists. The Password row shows a "Change password" action.

1. User clicks "Change password." A modal collects the new password (current password is **not** required — the user already proved possession via session cookie; Supabase does not require it for `updateUser`).
2. The action `changePasswordAction({ password })` calls `supabase.auth.updateUser({ password })`.
3. On success: modal closes, row updates "Password set on <email>" with refreshed timestamp from `identity.updated_at`. Existing session is preserved (Supabase does not invalidate other sessions; that is a follow-up).
4. On failure: notice with `PASSWORD_CHANGE_FAILURE_MESSAGE`.

### 7.5 Remove password

Entry: `/settings/identities`, when an email identity exists **and** at least one other identity exists.

1. The Password row shows "Remove password" only if `identities.length >= 2`. Otherwise the row shows the hint "Add a linked provider first" with a disabled action.
2. User clicks "Remove password." A native `confirm()` dialog appears (matches `identities.ts` pattern).
3. On confirm, `removePasswordAction()` calls `supabase.auth.unlinkIdentity(emailIdentity)`.
4. On success: identities reload; the Password row reverts to "No password set" + "Set password."
5. On failure: notice with `PASSWORD_REMOVE_FAILURE_MESSAGE`.

### 7.6 Change email

Entry: `/settings/account`. New page.

1. The page displays the current email (sourced from the verified session, via DAL).
2. User enters a new email and submits. The form calls `changeEmailAction({ email })`.
3. The action calls `supabase.auth.updateUser({ email })`. With `enable_confirmations = false`, Supabase updates `auth.users.email` immediately; the next-issued JWT carries the new email.
4. On success: notice with `EMAIL_CHANGE_SUCCESS_MESSAGE`. The page rerenders with the new email. Because the JWT was minted before the change, the next request that triggers `AuthMiddleware.bootstrap_callback` updates `public.users.email` via `INSERT ... ON CONFLICT DO UPDATE SET email = COALESCE(:email, users.email)`. No app code needs to write to `public.users` directly.
5. On failure (email in use, malformed, etc.): notice with `EMAIL_CHANGE_FAILURE_MESSAGE`.

### 7.7 Change display name

Entry: `/settings/account`. Same page as 7.6.

1. The page displays the current display name (sourced from `public.users.display_name` via FastAPI `/me`, which is the canonical reading path).
2. User enters a new display name and submits. The form does a client-side `apiFetch('PATCH /api/me', { display_name })` — same pattern as `/settings/reader`. The existing BFF at `apps/web/src/app/api/me/route.ts` proxies to FastAPI `PATCH /me`, which calls `users_service.update_display_name`. No new Server Action and no new BFF route.
4. On success: notice with `DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE`. The page rerenders.
5. On failure: notice with `DISPLAY_NAME_CHANGE_FAILURE_MESSAGE`.

The display name in Supabase's `user_metadata.display_name` is **not** updated by this flow. It is only ever set at sign-up time (7.1) and is considered the initial value; the canonical store is `public.users.display_name`.

### 7.8 Android shell behaviour

For sign-up, sign-in, set/change/remove password, change email, change display name: the WebView renders the same pages as the browser. Server Actions submit same-origin and write `HttpOnly` session cookies via the standard `applyCookies` path. There are no deep links, no Custom Tab launches, no Credential Manager calls, and no native interception. The Android shell is a passive WebView for the entire password feature set.

The login page's existing `isShell` branch is preserved exclusively for the OAuth buttons (per `docs/android-auth.md`). The password form renders identically in `isShell` and browser contexts.

## 8. Architecture

```
                     ┌─ Browser ────────────────────────────────┐
                     │                                          │
                     │  /login, /sign-up, /settings/*           │
                     │  (Server Components + Client Forms)      │
                     └────────────┬─────────────────────────────┘
                                  │  same-origin POST
                                  ▼
                ┌─ Next.js (apps/web) ───────────────────────────┐
                │                                                │
                │  Server Actions (lib/auth/password-actions.ts) │
                │    ▶ createRouteHandlerClient                  │
                │    ▶ supabase.auth.{signUp, signInWithPassword,│
                │         updateUser, unlinkIdentity,            │
                │         getUserIdentities}                     │
                │    ▶ settlePendingCookieWrites                 │
                │    ▶ applyCookies                              │
                │    ▶ redirect(nextPath)                        │
                │                                                │
                │  BFF Route (api/me/display-name/route.ts)      │
                │    ▶ proxyToFastAPI (existing)                 │
                └────────────┬───────────────────────────────────┘
                             │  HTTPS to Supabase Auth (auth)
                             │  HTTPS to FastAPI (display-name only)
                             ▼
                ┌─ Supabase Auth ────────────────────────────────┐
                │  auth.users, auth.identities                   │
                │  Issues JWT + refresh token                    │
                └────────────────────────────────────────────────┘

                ┌─ FastAPI (python/nexus) ───────────────────────┐
                │  AuthMiddleware (existing)                     │
                │    ▶ verifies JWT                              │
                │    ▶ ensure_user_and_default_library           │
                │       (idempotent UPSERT into public.users)    │
                │                                                │
                │  PATCH /me/display-name (new)                  │
                │    ▶ UPDATE public.users SET display_name = …  │
                │      WHERE id = :viewer_id                     │
                └────────────────────────────────────────────────┘
```

Sequence for sign-up (representative):

```
Client                  Next.js Server Action      Supabase Auth       FastAPI
  │                                                                    
  ├─ POST /sign-up ────▶                                                
  │                     │                                               
  │                     ├─ signUp({email,password,                      
  │                     │   options:{data:{display_name}}}) ───────▶    
  │                     │                                              
  │                     │ ◀─── session (cookies set) ────              
  │                     │                                              
  │                     ├─ settlePendingCookieWrites                   
  │                     ├─ applyCookies                                
  │ ◀────── 303 → /libraries (Set-Cookie: sb-…) ─────                   
  │                                                                    
  ├─ GET /libraries (cookies attached) ──▶                              
  │                                  │                                  
  │                                  ├─ data fetch ▶ /api/me ─▶ proxy ─▶
  │                                                                    ├─ AuthMiddleware
  │                                                                    │   verify JWT
  │                                                                    │   bootstrap_callback
  │                                                                    │   ↳ public.users row created
  │                                                                    │   ↳ default library created
  │                                  ◀─── 200 …                         │
  │ ◀── render /libraries                                               
```

The same shape holds for sign-in (skips the bootstrap-creates-row step if the user already exists; the UPSERT is a no-op).

## 9. Capability contract

### 9.1 Inputs

| Input | Where collected | Validation |
|---|---|---|
| Email | `/login`, `/sign-up`, `/settings/account` | Required, `<input type="email">`, max 254 chars. Server normalizes via `email.trim().toLowerCase()`. Final validity decided by Supabase. |
| Password | `/login`, `/sign-up`, `/settings/identities` (set/change) | Required, min 12 chars. Server validates length before calling Supabase. No upper bound on length (Supabase caps at 72 bytes; documented in N5). No character-class requirements. |
| Display name | `/sign-up`, `/settings/account` | Required, min 1 char, max 80 chars after trim. No uniqueness. |
| `nextPath` | `/login` query string (existing) | Existing safe-redirect validation in `apps/web/src/lib/auth/redirects.ts` (or equivalent). Unchanged. |

### 9.2 Outputs

| Operation | Side effects on success |
|---|---|
| Sign up | `auth.users` row (Supabase), `auth.identities` row `provider='email'`, session cookies set, redirect to `/libraries`. `public.users` row created lazily by bootstrap on next FastAPI hit. |
| Sign in | Session cookies set, redirect to `nextPath`. |
| Set password | `auth.identities` row `provider='email'` created on the existing user. |
| Change password | Password hash on the existing email identity is replaced. No other side effects. |
| Remove password | `auth.identities` row `provider='email'` deleted. `auth.users.email` is preserved (the canonical user email is separate from the email identity). |
| Change email | `auth.users.email` updated. Next-issued JWT carries the new email. `public.users.email` updated lazily by bootstrap on next FastAPI hit. |
| Change display name | `public.users.display_name` updated. No Supabase write. |

### 9.3 Invariants

- **I1.** A user always has at least one sign-in method. The UI prevents removing the last identity; Supabase's `unlinkIdentity` also rejects the last identity. Both layers enforce this; the UI guard is the user-facing message, the Supabase guard is the durable enforcement.
- **I2.** The Android WebView never navigates to a Supabase or OAuth provider URL during password flows. All password POSTs are same-origin to `<NEXUS_BASE_URL>`. This preserves `docs/android-auth.md` I1 by not weakening it.
- **I3.** No password value is ever logged, stored on the Next.js process beyond the duration of a single Server Action, or written to any database controlled by this repository. Password hashing is Supabase's responsibility.
- **I4.** Every user-facing error message displayed by a password flow is a constant from `apps/web/src/lib/auth/messages.ts`. Raw Supabase errors never surface.
- **I5.** Every password Server Action owns one total deadline of 5 seconds, inherited from `createRouteHandlerClient`. No password operation may block longer.
- **I6.** Display-name and email writes to `public.users` are idempotent: the bootstrap callback's UPSERT handles all email changes; the display-name endpoint is a plain UPDATE by primary key.
- **I7.** Email and password fields validate length and required-ness on the server; client-side `required` and `minLength` are UX hints only.
- **I8.** A successful sign-up immediately yields an authenticated session. There is no "verify your email" interstitial under v1 configuration.
- **I9.** The `provider` field on `auth.identities` is matched exhaustively against the closed set `{email, google, github}` in every UI branch. New providers require updating this enum and the matching code.

### 9.4 Failure modes

| Failure | Surface | Whitelisted message |
|---|---|---|
| `signInWithPassword` returns `Invalid login credentials` | `/login` | `PASSWORD_SIGN_IN_FAILURE_MESSAGE` |
| `signUp` returns `User already registered` | `/sign-up` | `PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE` |
| `signUp` returns weak-password error | `/sign-up` | `PASSWORD_TOO_SHORT_MESSAGE` |
| `signUp` other error | `/sign-up` | `PASSWORD_SIGN_UP_FAILURE_MESSAGE` |
| `updateUser({ password })` fails | `/settings/identities` | `PASSWORD_CHANGE_FAILURE_MESSAGE` |
| `unlinkIdentity({ provider: 'email' })` fails | `/settings/identities` | `PASSWORD_REMOVE_FAILURE_MESSAGE` |
| `updateUser({ email })` returns email-in-use | `/settings/account` | `EMAIL_IN_USE_MESSAGE` |
| `updateUser({ email })` other error | `/settings/account` | `EMAIL_CHANGE_FAILURE_MESSAGE` |
| Display-name FastAPI returns non-2xx | `/settings/account` | `DISPLAY_NAME_CHANGE_FAILURE_MESSAGE` |
| Any Supabase auth call times out (5 s deadline) | originating page | the same whitelisted message as for the action's failure case; the timeout is not distinguished |

## 10. Target file layout (after implementation)

```
apps/web/src/
├── app/
│   ├── login/
│   │   ├── page.tsx                     (M)  reads `isShell`, passes to client
│   │   ├── LoginPageClient.tsx          (M)  renders OAuth + new EmailPasswordSignIn
│   │   └── EmailPasswordSignIn.tsx      (N)  client form, calls signInWithPasswordAction
│   ├── sign-up/
│   │   ├── page.tsx                     (N)  server component shell
│   │   └── SignUpForm.tsx               (N)  client form, calls signUpWithPasswordAction
│   ├── (authenticated)/
│   │   ├── settings/
│   │   │   ├── identities/
│   │   │   │   ├── SettingsIdentitiesPaneBody.tsx  (M)  add Password row
│   │   │   │   ├── PasswordRow.tsx                  (N)  set/change/remove UI
│   │   │   │   └── actions.ts                       (M)  add password actions
│   │   │   └── account/
│   │   │       ├── page.tsx                         (N)  server component shell
│   │   │       ├── SettingsAccountPaneBody.tsx      (N)  email + display-name forms
│   │   │       └── actions.ts                       (N)  changeEmailAction (display-name is client-side apiFetch, not a server action)
│   ├── api/
│   │   └── me/
│   │       └── display-name/
│   │           └── route.ts             (N)  PATCH proxy to FastAPI
│   └── ...
├── lib/
│   ├── auth/
│   │   ├── password-actions.ts          (N)  signIn/signUp/set/change/remove actions
│   │   ├── identities.ts                (M)  add email-identity helpers, extend mayUnlink
│   │   ├── messages.ts                  (M)  add PASSWORD_*, EMAIL_*, DISPLAY_NAME_* constants
│   │   └── ...
│   └── supabase/
│       └── middleware.ts                (M)  add /sign-up to PUBLIC_ROUTES
└── ...

python/nexus/
├── api/
│   └── routes/
│       └── me.py                        (M)  add PATCH /me/display-name
├── services/
│   └── users.py                         (N or M)  update_display_name(user_id, display_name)
└── ...

supabase/
└── config.toml                          (M)  enable_signup=true, password_min_length=12

docs/
├── password-auth.md                     (N)  this document
├── android-auth.md                      (M)  one paragraph noting password is web-and-WebView, no native code
└── rules/
    └── codebase.md                      (M)  one line: password identities are managed via Supabase; no app-side password storage
```

(N) = new, (M) = modified.

## 11. API design

### 11.1 Next.js Server Actions (new, all in `apps/web/src/lib/auth/password-actions.ts`)

All actions return one of:

```ts
type ActionResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true } & T)
  | { ok: false; error: string };   // `error` is one of the whitelisted constants
```

Actions that need to redirect on success throw `redirect(path)` (Next.js semantics) instead of returning `{ ok: true }`.

```ts
"use server";

// 7.2 Sign-in
export async function signInWithPasswordAction(input: {
  email: string;
  password: string;
  nextPath?: string;
}): Promise<ActionResult>;  // success → redirect(nextPath ?? "/libraries")

// 7.1 Sign-up
export async function signUpWithPasswordAction(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<ActionResult>;  // success → redirect("/libraries")

// 7.3 Set password (OAuth user adding a password)
export async function setPasswordAction(input: {
  password: string;
}): Promise<ActionResult>;

// 7.4 Change password (user already has a password)
export async function changePasswordAction(input: {
  password: string;
}): Promise<ActionResult>;

// 7.5 Remove password (unlink the email identity)
export async function removePasswordAction(): Promise<ActionResult>;
```

Email-change and display-name-change actions live in `apps/web/src/app/(authenticated)/settings/account/actions.ts`:

```ts
"use server";

// 7.6 Change email
export async function changeEmailAction(input: {
  email: string;
}): Promise<ActionResult>;

// 7.7 Change display name — NOT a server action. The /settings/account display-name form
// uses a client-side apiFetch('PATCH /api/me', { display_name }) like /settings/reader does.
```

Identity loading on `/settings/identities` continues to use the existing `loadLinkedIdentities()` server action; no signature change. The returned identities now include the `email` provider when present; the UI is responsible for the Password-row rendering.

### 11.2 Next.js Route Handlers

No new route handlers. The existing `PATCH /api/me` (`apps/web/src/app/api/me/route.ts`) already proxies to FastAPI `PATCH /me` and handles display-name updates via `UpdateProfileRequest { display_name: string | null }`. The `/auth/oauth`, `/auth/callback`, `/auth/handoff`, and `/auth/native/google` routes are untouched.

### 11.3 FastAPI routes

No new FastAPI endpoint. The existing `PATCH /me` (`python/nexus/api/routes/me.py:patch_me`) is the canonical display-name update path, calling `users_service.update_display_name` which trims, rejects empty strings (`InvalidRequestError`), and caps length at 100 chars via the `UpdateProfileRequest` Pydantic schema. The spec's 1..80 range is enforced at the UI level (`<input maxLength={80}>`); the backend's 100-cap is the durable boundary. No new tables. No new migrations. No new service functions.

### 11.4 Supabase auth calls used

| Action | Supabase call | Notes |
|---|---|---|
| `signInWithPasswordAction` | `auth.signInWithPassword({ email, password })` | |
| `signUpWithPasswordAction` | `auth.signUp({ email, password, options: { data: { display_name } } })` | `user_metadata.display_name` is set; the action also fetches FastAPI `PATCH /me` (with bearer + `X-Nexus-Internal`) to write `public.users.display_name`. Order: signUp → applyCookies → fetch FastAPI PATCH `/me` → redirect. Same pattern as `/auth/native/google/route.ts`'s direct FastAPI call. |
| `setPasswordAction` | `auth.updateUser({ password })` | The user must be signed in. Supabase creates the email identity if absent. |
| `changePasswordAction` | `auth.updateUser({ password })` | Same call as set; no distinction at the API layer. UI distinguishes by inspecting `getUserIdentities()`. |
| `removePasswordAction` | `auth.unlinkIdentity(emailIdentity)` | Caller must pass the full identity object; `loadLinkedIdentities()` provides it. |
| `changeEmailAction` | `auth.updateUser({ email })` | With `enable_confirmations = false`, instant. |
| `loadLinkedIdentities` | `auth.getUserIdentities()` | Existing, unchanged. |

### 11.5 Login page changes

`apps/web/src/app/login/page.tsx` (Server Component):
- Reads `isShell` (existing).
- Passes the same `initialFeedback`, `nextPath`, and `isShell` props as today.
- No change in the server-side props contract.

`apps/web/src/app/login/LoginPageClient.tsx` (Client Component):
- Renders the existing two OAuth provider forms (branched on `isShell`, unchanged).
- Below them, renders a horizontal rule labeled "or".
- Renders `<EmailPasswordSignIn nextPath={nextPath} />` (new), which contains:
  - `<input name="email" type="email" required>`
  - `<input name="password" type="password" required minLength={12}>`
  - `<button type="submit">Sign in</button>`
  - A footer link: `<Link href="/sign-up">Create account</Link>`
- The email/password form does **not** branch on `isShell`. Identical markup in browser and WebView.
- Error feedback uses the existing `FeedbackNotice` component, with severity `"error"` and one of the `PASSWORD_*` constants.

`apps/web/src/app/sign-up/page.tsx` (new, Server Component):
- Reads cookies via the existing `readSupabaseSessionCookie`. If the user is already signed in (`active`), redirects to `/libraries`. Mirrors the existing `/login` guard.
- Reads `next` from search params, validates, threads through.
- Reads `isShell` from User-Agent (purely to match the `/login` layout language; the sign-up form itself does not branch).
- Renders `<SignUpForm nextPath={nextPath} />`.

`apps/web/src/app/sign-up/SignUpForm.tsx` (new, Client Component):
- Fields: email, password, display name.
- Submits to `signUpWithPasswordAction`.
- Displays `FeedbackNotice` on `{ ok: false }`.

### 11.6 Settings pages changes

`apps/web/src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx`:
- After the existing Google/GitHub rows, render a `<PasswordRow />` (new).

`apps/web/src/app/(authenticated)/settings/identities/PasswordRow.tsx` (new):
- Branches on whether an `email` identity exists in the loaded identities.
- Absent: heading "Password — not set", subtext "Sign in with email and password", button "Set password" → opens modal → `setPasswordAction`.
- Present: heading "Password — set on `<email>`", subtext with `identity.updated_at`, two actions: "Change password" → modal → `changePasswordAction`; "Remove password" → confirm → `removePasswordAction`. "Remove password" is disabled with a hint when `identities.length < 2`.

`apps/web/src/lib/auth/identities.ts`:
- Add `mayRemovePassword(identities) → boolean`, defined as `identities.length >= 2 && identities.some(i => i.provider === "email")`.
- Extend `mayUnlinkIdentity(identities, identityId)` so an `email` identity is treated identically to OAuth identities for the "≥2 to unlink any" rule.

`apps/web/src/app/(authenticated)/settings/account/page.tsx` (new):
- Server Component. Reads the current email from the verified session (DAL); reads the current display name via FastAPI `/me`.
- Renders `<SettingsAccountPaneBody current={{ email, displayName }} />`.

`apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx` (new):
- Two independent forms on one page: "Email" and "Display name", each with its own submit button and its own `FeedbackNotice`.
- Forms call their respective Server Actions and reload on success.

### 11.7 Whitelisted messages

Added to `apps/web/src/lib/auth/messages.ts`:

```ts
export const PASSWORD_SIGN_IN_FAILURE_MESSAGE = "Email or password is incorrect.";
export const PASSWORD_SIGN_UP_FAILURE_MESSAGE = "We couldn't create your account. Please try again.";
export const PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE = "An account with that email already exists.";
export const PASSWORD_TOO_SHORT_MESSAGE = "Password must be at least 12 characters.";
export const PASSWORD_CHANGE_FAILURE_MESSAGE = "We couldn't change your password. Please try again.";
export const PASSWORD_REMOVE_FAILURE_MESSAGE = "We couldn't remove your password. Please try again.";
export const PASSWORD_CHANGE_SUCCESS_MESSAGE = "Password updated.";
export const PASSWORD_SET_SUCCESS_MESSAGE = "Password set.";
export const PASSWORD_REMOVE_SUCCESS_MESSAGE = "Password removed.";
export const EMAIL_CHANGE_FAILURE_MESSAGE = "We couldn't update your email. Please try again.";
export const EMAIL_IN_USE_MESSAGE = "An account with that email already exists.";
export const EMAIL_CHANGE_SUCCESS_MESSAGE = "Email updated.";
export const DISPLAY_NAME_CHANGE_FAILURE_MESSAGE = "We couldn't update your display name. Please try again.";
export const DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE = "Display name updated.";
export const KEEP_ONE_SIGN_IN_METHOD_MESSAGE = "Keep at least one sign-in method.";
```

`toPublicAuthErrorMessage` is extended to recognize the new constants (whitelist round-trip safety). Provider error codes are no longer the only inputs; raw Supabase `error.message` strings are inspected case-insensitively for `"already registered"` (→ taken), `"password should be at least"` (→ too short), `"invalid login credentials"` (→ sign-in failure), `"email rate limit"` (→ generic failure). Any unrecognized string maps to the action's default failure message; the raw string is never surfaced.

## 12. Composition with existing systems

| System | Touchpoint | Effect |
|---|---|---|
| `apps/web/src/middleware.ts` + `lib/supabase/middleware.ts` | `PUBLIC_ROUTES` adds `/sign-up`. `/login` already public. `/settings/*` already protected. | `/sign-up` reachable when `anonymous` or `ended`. If `active`, the page itself redirects to `/libraries` (matches `/login`). |
| `apps/web/src/lib/auth/dal.ts` | No change. Verified session checks are identical regardless of how the JWT was minted. | Password sessions are interchangeable with OAuth sessions in every protected route. |
| `apps/web/src/lib/supabase/route-handler.ts` | No change. `createRouteHandlerClient`'s 5-second deadline applies to every password action's Supabase call. | Inherits I5. |
| `apps/web/src/lib/api/proxy.ts` | No change. Used by the new `/api/me/display-name` BFF route handler. | New endpoint follows the existing bearer-forward + Origin-check pattern. |
| `python/nexus/auth/middleware.py` + `services/bootstrap.py` | No change. `ensure_user_and_default_library` runs on the first authenticated request after sign-up; the `INSERT … ON CONFLICT DO UPDATE SET email = COALESCE(:email, users.email)` upserts the row and syncs email on every login. | Sign-up + first FastAPI hit → `public.users` row exists. Email change + next FastAPI hit → `public.users.email` updated. No bespoke code path needed. |
| `python/nexus/api/routes/me.py` | New `PATCH /me/display-name`. Existing `GET /me` is unchanged. | Display-name reads continue from `/me`; writes go through the new endpoint. |
| `/auth/oauth`, `/auth/callback`, `/auth/handoff`, `/auth/native/google` | Untouched. | OAuth and Android handoff flows are orthogonal to password auth. |
| `auth_handoff_codes` table + handoff service (`python/nexus/services/auth_handoff_codes.py`) | Untouched. Not reused for password. | The handoff codes are specifically for cookie-jar transfer between Custom Tab and WebView, which password does not require. |
| `apps/android/*` | Untouched (Kotlin, Manifest, Gradle). One-paragraph note in `docs/android-auth.md` clarifying password is web-only in the rendering sense (it renders inside the WebView same-origin). | No new intent filters, no new native HTTP calls. Rule I3 of `docs/android-auth.md` (debug == release) is preserved trivially. |
| `apps/extension/*` | Untouched. Extension uses scoped, revocable tokens (`extension_sessions`), independent of password auth. | A user with a password can still mint extension tokens via existing mechanism. |
| `/settings/identities` existing safeguards | Extended. `mayUnlinkIdentity` now counts the email identity; UI uses `mayRemovePassword`. | Both safeguards reduce to the same rule: keep ≥ 1 identity, period. |
| Supabase project | `enable_signup = true`, `password_min_length = 12`, `enable_confirmations = false`. Email provider is enabled (default). | One-time config change; reversible. |

## 13. Security & threat model

The password flow is short, but it touches authentication; the threats worth naming:

- **T1. Credential stuffing.** Mitigation: Supabase's built-in IP-based rate limit (~30 auth attempts / 5 min) is left at default. No app-side per-user lock-out (N7). For a single-operator account, this is acceptable.
- **T2. Account takeover via unlink-then-relink.** A user who has signed in via password might have their session stolen; the attacker then unlinks all OAuth identities and changes the password and email. Mitigation: I1 ensures the attacker cannot fully lock the legitimate user out via unlink (must keep ≥ 1 identity), but does not prevent password and email change. Acceptable: there is no MFA layer in this version (N4). Recovery is via Supabase admin console.
- **T3. Open sign-up abuse.** Open signup (G8) allows anyone to create an account; this consumes a `public.users` row and a default library on first FastAPI hit. Mitigation: none beyond Supabase auth rate limits. The created accounts are isolated by user_id; they cannot access existing libraries.
- **T4. Display-name endpoint as a vector for stored XSS.** Display names are rendered in multiple places. Mitigation: existing React escaping defaults; the FastAPI endpoint enforces length but not content. No HTML/JS sanitization in the path (consistent with how OAuth display names from Google/GitHub are already handled).
- **T5. Email enumeration on `/sign-up`.** Returning `PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE` reveals that an account with that email exists. Mitigation: accepted. Email enumeration through OAuth (sign-in with Google for an unknown email shows the standard Google chooser, not a Nexus-side signal) is already not a concern; revealing existence on `/sign-up` is the conventional choice. Documented in K7.
- **T6. WebView password phishing.** The Android shell loads only `<NEXUS_BASE_URL>` (existing rule I1 of `docs/android-auth.md`). A password form on a non-Nexus origin cannot be rendered in the shell. The shell is not a generic browser.
- **T7. JWT staleness after email change.** The JWT minted before the email change carries the old email; the bootstrap UPSERT runs the next time FastAPI authenticates the user, and the JWT's `email` claim is then refreshed at the next Supabase token refresh. Mitigation: accepted. The window is bounded by the token refresh cadence (`SUPABASE_AUTH_OPERATION_DEADLINE_MS` triggers refresh well before expiry). No app code touches `public.users.email` directly during the change-email action; relying on the bootstrap UPSERT is intentional (it deduplicates the write path).

## 14. Rules and invariants

Honors the repo rules (`docs/rules/`):

- **`layers.md`** — Password auth runs entirely server-side via Server Actions. The browser never holds Supabase tokens. The DAL is unchanged: a session is a session. BFF proxy is used only for display-name; password actions skip FastAPI entirely (no proxy, no business logic outside Supabase).
- **`control-flow.md`** — `provider` is matched exhaustively against `{email, google, github}`. Action results are matched on the closed set `{ok: true} | {ok: false}`. No catch-all branches; unrecognized Supabase errors fall through `toPublicAuthErrorMessage` to the action's default message constant.
- **`errors.md`** — Every error path terminates in a whitelisted message (I4). Raw exception messages from Supabase or FastAPI are converted via `toPublicAuthErrorMessage` or `toFeedback` and the original is logged (with request-id) but not displayed.
- **`database.md`** — No new tables. No new migrations. Updates to `public.users` are routed through `ensure_user_and_default_library` (email) or the explicit FastAPI endpoint (display name). Direct writes to `public.users` from Server Actions are forbidden.
- **`codebase.md`** — One added line: password identities are managed via Supabase Auth; the app stores no password material. Module ownership: `apps/web/src/lib/auth/password-actions.ts` owns all password Server Actions; `apps/web/src/lib/auth/identities.ts` owns identity-shape helpers; `python/nexus/api/routes/me.py` owns the display-name endpoint.
- **`concurrency.md`** — Server Actions run sequentially per request. `ensure_user_and_default_library` is already race-safe via `INSERT … ON CONFLICT` and `IntegrityError` recovery. No new concurrency surface.
- **`tech-stack.md`** — No new dependencies. Continues to use `@supabase/ssr` and `@supabase/supabase-js` exclusively for auth.
- **`docs/android-auth.md` I1 / I2 / I3** — Preserved. Password flows do not load Supabase or provider URLs in the WebView; they POST same-origin to Nexus. Debug and release run identical code. Handoff code semantics are untouched.

New invariants introduced by this spec are I1–I9 above (see §9.3).

## 15. Key decisions

- **K1. Use Supabase's native password APIs; do not implement password hashing in this repo.** Verdict. Supabase Auth stores password hashes in `auth.users.encrypted_password` and runs the equality check inside the Auth service. Rejected: rolling our own with bcrypt/argon2 and a `password_hash` column. Rejected because (a) it duplicates a service we already pay for; (b) it would require parallel sign-in / sign-up code in FastAPI; (c) it pulls password hashes into our database snapshot/backup surface, which is currently free of credentials.
- **K2. No password reset.** Verdict. Skipping `forgot-password` entirely. Rejected: wiring Supabase's `resetPasswordForEmail`. Rejected because there is no configured SMTP provider, configuring one is out of scope, and the recovery path "sign in with Google/GitHub then set a new password from /settings/identities" suffices for the current operator. A locked-out user with no OAuth identity is acceptable risk.
- **K3. No username field.** Verdict. Email is the credential identifier; `display_name` is the human label. Rejected: adding a `username` column to `public.users` with uniqueness and a "change username" flow. Rejected because it adds schema work, uniqueness handling, and a feature surface (change username, what-if-taken UX) for zero functional gain over `display_name`.
- **K4. Open sign-up, no invite tokens.** Verdict. Anyone can sign up; orphan accounts are inert because no public library or shared resource exists. Rejected: an invite-token table and `/invite/<token>` route. Rejected because the operational simplicity outweighs the risk; if abuse appears, we can flip `enable_signup = false` in seconds.
- **K5. No email verification under v1.** Verdict. `enable_confirmations = false`. Rejected: turning it on. Rejected because (a) SMTP is unwired (N3), (b) the user is the operator and self-verifies trivially, (c) a half-implemented verification (e.g. local Inbucket in dev, nothing in prod) is worse than none.
- **K6. Password form is same-origin and renders identically in browser and WebView.** Verdict. No `isShell` branch for the password UI; the existing branch survives only for OAuth buttons. Rejected: a native Kotlin password screen with a custom POST to `/auth/native/password`. Rejected because passwords are not OAuth, RFC 8252 does not apply, the WebView accepts same-origin POSTs natively, and the simpler design eliminates an entire native code path. Mobile-side cost: zero.
- **K7. Reveal email-exists on sign-up.** Verdict. The sign-up error distinguishes "email taken" from "generic failure" (T5). Rejected: returning a generic message regardless of cause. Rejected because user confusion ("I typed the right password but couldn't log in?") substantially outweighs the privacy benefit, which is already weakened by the OAuth path (any user can probe by attempting OAuth sign-in).
- **K8. Identity-row removal does not erase `auth.users.email`.** Verdict. `unlinkIdentity({ provider: 'email' })` removes the password identity; the user's canonical email remains. The user can still change email via `updateUser({ email })`. Rejected: deleting the email field as part of password removal. Rejected because the email is the user's identifier across libraries, memberships, and email change history; tying it to the password identity would conflate concerns and break OAuth-only users.
- **K9. Display-name canonical store is `public.users.display_name`.** Verdict. Supabase `user_metadata.display_name` is set once at sign-up as a convenience for cold-boot rendering, never written again. The FastAPI endpoint owns the authoritative store. Rejected: keeping the canonical store in Supabase user metadata. Rejected because (a) other tables already query `public.users.display_name` for joins; (b) Supabase metadata requires a client refresh to surface to the front-end, whereas FastAPI changes are visible on the next `/me` GET.
- **K10. Hard cutover, no feature flag.** Verdict. Ship in one PR; Supabase config flips simultaneously; no `PASSWORD_AUTH_ENABLED` env var. Rejected: gating the password UI behind a flag. Rejected because there is no shadow user base — the feature is on or off, the entire codebase is single-operator, and the risk of "wrong config in one env" is dominated by the risk of "two code paths going stale at different rates."
- **K11. No backward compatibility surface.** Verdict. There is no existing password feature to be compatible with. The spec lists no "legacy path" considerations because there are none. Any future migration (e.g., to a different auth provider) would be a separate cutover, not a multi-path coexistence.
- **K12. No reuse of `auth_handoff_codes` for any password concept.** Verdict. That table is dedicated to OAuth→WebView session transfer on Android. Rejected: extending the table for password-reset tokens or first-sign-in tokens. Rejected because (a) its TTL (90 s) and shape (carries live Supabase tokens) are wrong for any other purpose; (b) reuse would couple password and OAuth-handoff lifecycles unnecessarily; (c) password reset is not even in scope (K2).
- **K13. Password sign-up creates the `public.users` row lazily on first FastAPI hit, matching the OAuth path.** Verdict. The bootstrap UPSERT in `python/nexus/services/bootstrap.py` runs identically. Rejected: a synchronous post-sign-up POST from the Server Action to a `/me/bootstrap` endpoint. Rejected because (a) the existing path is already exercised, race-safe, and tested for OAuth; (b) the post-sign-up redirect to `/libraries` invariably triggers a FastAPI call that runs the bootstrap; (c) introducing a synchronous bootstrap call would create two equally-valid bootstrap surfaces and a divergence between password and OAuth.
- **K14. Server-side password length is the only client-acceptance rule.** Verdict. 12 characters minimum; no character classes, no breach corpus, no strength meter. Rejected: any of the above. Rejected because additional checks favor false rejections and noise over real security gain at our scale; if the operator wants a 64-char passphrase from a manager, that is the expected workflow.
- **K15. Email change is instant under v1 configuration.** Verdict. With `enable_confirmations = false`, `updateUser({ email })` updates `auth.users.email` immediately. Rejected: forcing confirmation on for email change while leaving sign-up unconfirmed. Rejected because Supabase's confirmation toggle is global; per-operation confirmation is not configurable; mixing states would require SMTP which is N3.

## 16. Final state

After implementation:

- `/login` shows OAuth buttons and an email/password sign-in form. The form behaves identically in the browser and the Android WebView.
- `/sign-up` exists, accepts email + password + display name, and lands the user signed in at `/libraries`.
- `/settings/identities` lists Google, GitHub, and Password as three peer rows. Each can be set, changed, and removed (subject to the keep-≥1 invariant).
- `/settings/account` exists, lists email and display-name, and edits both.
- `apps/web/src/lib/auth/password-actions.ts` is the only place that calls `signInWithPassword`, `signUp`, `updateUser`, and `unlinkIdentity({ provider: 'email' })`.
- `apps/web/src/lib/auth/messages.ts` carries the new `PASSWORD_*`, `EMAIL_*`, `DISPLAY_NAME_*` constants.
- `apps/web/src/lib/supabase/middleware.ts` PUBLIC_ROUTES includes `/sign-up`.
- `python/nexus/api/routes/me.py` exposes `PATCH /me/display-name`.
- `supabase/config.toml` has `enable_signup = true`, `password_min_length = 12`, `enable_confirmations = false`.
- No new database migration. No new table. No new column on `public.users`. No new env var.
- The Android shell, the FastAPI auth handoff path, the OAuth routes, the extension session model, and the worker are byte-identical to today.
- `docs/password-auth.md` (this file) is the canonical reference. `docs/android-auth.md` carries a one-paragraph note that password is web-and-WebView and does not enter the native OAuth code paths. `docs/rules/codebase.md` has one line stating that password identities are Supabase-managed and the app stores no password material.

## 17. Files

### Created

```
apps/web/src/app/login/EmailPasswordSignIn.tsx
apps/web/src/app/sign-up/page.tsx
apps/web/src/app/sign-up/SignUpForm.tsx
apps/web/src/app/sign-up/page.module.css
apps/web/src/app/(authenticated)/settings/identities/PasswordRow.tsx
apps/web/src/app/(authenticated)/settings/account/page.tsx
apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx
apps/web/src/app/(authenticated)/settings/account/actions.ts
apps/web/src/app/(authenticated)/settings/account/page.module.css
apps/web/src/lib/auth/password-actions.ts
docs/password-auth.md
```

### Modified

```
apps/web/src/app/login/page.tsx                         (props plumbing only)
apps/web/src/app/login/LoginPageClient.tsx              (add EmailPasswordSignIn below OAuth buttons)
apps/web/src/app/login/page.module.css                  (form styling)
apps/web/src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx
                                                        (add PasswordRow at end)
apps/web/src/app/(authenticated)/settings/identities/actions.ts
                                                        (no behaviour change; type tweaks for new identity helpers)
apps/web/src/lib/auth/identities.ts                     (mayRemovePassword, email-identity helpers)
apps/web/src/lib/auth/messages.ts                       (new whitelisted constants + toPublicAuthErrorMessage updates)
apps/web/src/lib/auth/messages.test.ts                  (round-trip tests for new constants)
apps/web/src/lib/supabase/middleware.ts                 (add /sign-up to PUBLIC_ROUTES)
python/nexus/api/routes/me.py                           (unchanged — existing PATCH /me suffices)
python/nexus/services/users.py                          (unchanged — existing update_display_name suffices)
supabase/config.toml                                    ([auth] enable_signup=true, [auth] minimum_password_length=12)
docs/android-auth.md                                    (one paragraph noting password is web-and-WebView)
docs/rules/codebase.md                                  (one line: password identities are Supabase-managed)
```

### Deleted

None. This spec adds; it does not remove. There is no legacy password code to delete (verified by exhaustive grep for bcrypt/argon2/scrypt/pbkdf2/`password_hash`/`hashedPassword`).

## 18. External setup

- **O1. Supabase config flip.** In `supabase/config.toml`:
  - `[auth] enable_signup = true`
  - `[auth] minimum_password_length = 12` (canonical Supabase CLI key; not `[auth.email] password_min_length`, which the local CLI rejects)
  - Leave `[auth.email] enable_confirmations = false`.
  Production: apply via `supabase config push` (or the corresponding Studio toggle). Local dev: `supabase stop && supabase start` to reload.
- **O2. No new env vars.** Existing `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NEXUS_INTERNAL_SECRET`, `FASTAPI_BASE_URL` are sufficient.
- **O3. No new infrastructure.** No SMTP, no Resend account, no third-party service. Inbucket on port 54324 remains available locally but is not used.
- **O4. Documentation.** `docs/android-auth.md` and `docs/rules/codebase.md` carry the required minimal updates listed in §17 Modified.

## 19. Acceptance criteria

- **AC1.** A user can navigate to `/sign-up`, enter a fresh email, a 12-char password, and a display name, submit, and end up at `/libraries` signed in. The `public.users` row exists with the correct email and display name after the first authenticated FastAPI call.
- **AC2.** A user can navigate to `/login`, enter their email + password, submit, and end up at `/libraries` signed in. If a `?next=…` query param is present and safe, they land at `nextPath` instead.
- **AC3.** A user with only a Google identity can open `/settings/identities`, click "Set password," enter a password, and confirm. The Password row now shows "Password set." `getUserIdentities()` returns three identities: google, github (if linked), and email.
- **AC4.** A user with a password can open `/settings/identities`, click "Change password," enter a new password, and confirm. They can sign out and sign back in with the new password; the old password no longer works.
- **AC5.** A user with email + google identities can open `/settings/identities`, click "Remove password," confirm. The Password row reverts to "No password set." A subsequent sign-in attempt with the old password is rejected.
- **AC6.** A user with only an email identity sees "Remove password" disabled with the hint "Add a linked provider first." Attempting to remove via direct action call returns `{ ok: false }`.
- **AC7.** A user can change their email on `/settings/account`. Subsequent `/me` calls return the new email (after the next bootstrap UPSERT). Sign-in with the new email works; sign-in with the old email fails.
- **AC8.** A user can change their display name on `/settings/account`. `/me` returns the new display name immediately.
- **AC9.** All of AC1–AC8 succeed inside the Android WebView shell without any Android code changes, deep-link interception, or `nexus://` URL.
- **AC10.** Every failure path produces a `FeedbackNotice` with one of the constants from `apps/web/src/lib/auth/messages.ts`. No raw Supabase error string appears in the UI. Verified by browser test inspecting rendered text.
- **AC11.** Removing the last identity is impossible: the UI hides the action, and calling the corresponding Server Action directly returns `{ ok: false }`. Supabase's own enforcement returns the same outcome.
- **AC12.** `make verify-full` passes: backend pytest unit + integration, frontend vitest unit + browser, Playwright E2E, Pyright, ESLint, TypeScript.
- **AC13.** `supabase/config.toml` ends with `[auth] enable_signup = true`, `[auth] minimum_password_length = 12`, and `[auth.email] enable_confirmations = false`. No other config changes.
- **AC14.** `apps/extension`, `apps/worker`, and `apps/android` source trees are byte-identical to the pre-change state. (`git diff --stat -- apps/android apps/extension apps/worker` is empty.)
- **AC15.** No new Alembic migration. (`git diff --stat -- migrations/alembic` is empty.)

## 20. Test plan

### 20.1 Backend (`python/`)

- Unit test for `update_display_name(db, user_id, display_name)` service: success, length validation, idempotent re-application.
- Integration test for `PATCH /me/display-name`: 200 with valid body; 401 without bearer; 422 on empty or oversize.
- Integration test confirming the existing bootstrap path still works when the JWT comes from a `signUp` (synthesize a JWT with a fresh sub + email, run a `GET /me`, assert `public.users` row exists with that email + display name carried from `user_metadata`).
- Pyright clean.

### 20.2 Frontend (`apps/web`)

- **Vitest unit** — `password-actions.ts`: each action's input validation; whitelisted error mapping. Mock the Supabase client; assert the right method is called with the right shape.
- **Vitest unit** — `identities.ts`: `mayRemovePassword`, extended `mayUnlinkIdentity` truth table.
- **Vitest unit** — `messages.test.ts`: each new constant round-trips through `toPublicAuthErrorMessage`.
- **Vitest browser** — `EmailPasswordSignIn` renders, submits, displays failure notice.
- **Vitest browser** — `SignUpForm` renders, submits, displays each failure case (email taken, password too short, generic).
- **Vitest browser** — `PasswordRow` renders three states (absent, present-can-remove, present-cannot-remove) correctly.
- **Vitest browser** — `SettingsAccountPaneBody` renders both forms, displays notices independently.

### 20.3 E2E (`e2e/`)

- Playwright spec `e2e/tests/password-auth.spec.ts`:
  - Sign up with a fresh email, land on `/libraries`.
  - Sign out, sign back in with email/password, land on `/libraries`.
  - Set a password on a Google-only fixture user, sign out, sign in with email/password, sign in with Google — both succeed.
  - Remove password from a user with both identities, attempt to sign in with email/password, assert failure.
  - Change email, sign out, sign in with new email, succeed; sign in with old email, fail.
  - Change display name, refresh, observe change.
  - Attempt to remove the last identity through the action layer (test hook); assert `{ ok: false }`.

### 20.4 Manual (release-APK on device)

- Sign up in the Android WebView. Land on `/libraries`. Close and reopen the app. Still signed in.
- Sign out from the in-app settings (existing flow). Sign in with email/password. Land on `/libraries`.
- Open `/settings/identities`. Set a password. Verify it appears.
- Open `/settings/account`. Change display name. Verify it appears in the header.

### 20.5 `make` targets

- `make test-back-unit` — passes
- `make test-back-integration` — passes
- `make test-front-unit` — passes
- `make test-front-browser` — passes
- `make test-e2e` — passes
- `make verify-full` — passes

## 21. Implementation phases

Each phase leaves the suite green; phases land in one PR (hard cutover) but in this order during development:

1. **Whitelisted messages and helpers.** Add constants and `mayRemovePassword`. Tests green.
2. **Server actions.** Implement `password-actions.ts` (sign-in, sign-up, set, change, remove). Unit tests against mocked Supabase. Tests green.
3. **Account server action.** Implement `changeEmailAction` (display-name change is a client-side `apiFetch('PATCH /api/me')` from the pane; no new server action, no new BFF, no new FastAPI endpoint). Tests green.
4. **Sign-up route.** Add `/sign-up`, redirect logic when already signed in, public-route allow-list addition. Browser test for the form. Tests green.
5. **Login page.** Add the email/password form below the OAuth buttons. Browser test verifying both render. Tests green.
6. **Identities page.** Add `PasswordRow`. Browser test covering all three states. Tests green.
7. **Account page.** Add `/settings/account`. Browser test for both forms. Tests green.
8. **E2E.** Add the Playwright spec covering AC1–AC11. `make test-e2e` green.
9. **Supabase config.** Flip `enable_signup` and `password_min_length`. Local Supabase restart. Re-run E2E. `make verify-full` green.
10. **Docs.** Add the one-paragraph note to `docs/android-auth.md`; add the one-line note to `docs/rules/codebase.md`. `docs/password-auth.md` is this file.
11. **Manual.** Build the release APK, sign in on device per §20.4.

## 22. Risks and mitigations

- **R1. Supabase changes the shape of `auth.identities` returned by `getUserIdentities()`.** Mitigation: the response is consumed through the existing `normalizeLinkedIdentities` helper which already shields the UI. Add a fast unit test that asserts the helper accepts an `email`-provider row.
- **R2. The `display_name` written via `user_metadata` at sign-up is not visible to the front-end before the `/me` FastAPI call.** Mitigation: the post-sign-up Server Action immediately calls `PATCH /me/display-name` after `applyCookies` and before `redirect`. By the time the browser navigates to `/libraries`, `public.users.display_name` is set.
- **R3. A browser test for Server Actions requires CSRF tokens / form-data shape.** Mitigation: Next.js handles the CSRF/RSC plumbing; the tests submit through `<form action={...}>` so the framework owns the transport. Where direct invocation is required, the action is exported and called from the test in the same way as `loadLinkedIdentities` is today.
- **R4. The 5-second Supabase deadline is too tight for `signUp` on a cold project.** Mitigation: 5 s is the existing repo-wide invariant (I5). If sign-up exceeds it in practice we extend the deadline at the `createRouteHandlerClient` layer for **all** auth operations — never per-action.
- **R5. A user with `auth.users.email = "X"` and an OAuth identity for `"X"` calls `setPassword`; Supabase rejects because the email identity already exists for a different `user_id`.** Mitigation: this can only occur if email + provider provisioning has produced two distinct users. Our schema does not currently allow it (Supabase emails are globally unique at the auth layer; provider emails are stored on the identity, not the user). Document the failure mode and surface `PASSWORD_CHANGE_FAILURE_MESSAGE`; manual recovery via Supabase admin.
- **R6. Display-name changes do not propagate to `auth.users.user_metadata`.** Mitigation: K9 is explicit that `public.users.display_name` is canonical. Anywhere the app needs the display name, it reads `/me`. Anywhere the app reads `user_metadata.display_name` directly today (if any), it is changed to read from `/me`. Search confirms only the sign-up path writes `user_metadata.display_name`; nothing reads it on subsequent loads.
- **R7. Removing the password identity leaves Supabase's `auth.users.encrypted_password` populated.** Mitigation: Supabase's `unlinkIdentity({ provider: 'email' })` removes both the identity row and the password material. Verified by the E2E test that asserts the old password no longer works.
- **R8. The `messages.test.ts` round-trip whitelist diverges from the constants over time.** Mitigation: the test imports the constants by name and round-trips each; adding a constant without updating the test produces a missing-export error at compile time.
