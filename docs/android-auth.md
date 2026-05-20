# Android Native Authentication — Spec

**Status:** Planned.
**Date:** 2026-05-19.
**Owners:** Android shell (`apps/android`), web auth (`apps/web` `/auth/*`), backend (`python/nexus`).
**Supersedes:** the debug-only `nexus-dev://auth/callback` OAuth return path (deleted by this spec).

---

## 1. Summary

The Android app is a native WebView shell wrapping the Next.js web app. Google sign-in is broken because OAuth begins inside the WebView, the WebView ejects the off-origin authorization URL to a Chrome Custom Tab, and the PKCE code-verifier cookie (written in the WebView's cookie jar) is then unreachable when the callback completes in the Custom Tab's separate jar. Google additionally blocks OAuth in embedded WebViews entirely (`disallowed_useragent`).

This spec defines a **hard cutover** to a correct, RFC 8252-compliant native auth architecture:

- **Sign-in never runs in the WebView.** It runs in an external user-agent — a Chrome Custom Tab (GitHub) or the native Credential Manager (Google).
- The resulting Supabase session crosses from that external context into the WebView via a **one-time-code handoff**: a single-use, ≤90-second, server-stored code, bound to a native-held verifier (a PKCE-style challenge/verifier pair) to defeat interception.
- The WebView ends up authenticated by its own `HttpOnly` session cookie, set server-side. No tokens ever touch JavaScript or native Kotlin variables.

There is **no fallback path and no backward compatibility**: the legacy `nexus-dev://` debug callback, `shouldUseAndroidDebugAuthCallback`, and `buildAndroidDebugAuthCallbackUrl` are deleted. The new `nexus://auth/handoff` mechanism is environment-agnostic and behaves identically in debug and release.

This spec is the plan for **Option 1** (Custom Tab + handoff, provider-agnostic) and **Option 2** (native Credential Manager for Google). **Fix #1** — adding `/auth/oauth` to the middleware public-routes allowlist, which restores sign-in on web and is a prerequisite for Option 1 — is already applied.

---

## 2. Problem

| # | Problem | Root cause |
|---|---|---|
| 1 | Tapping "Continue with Google" in the Android app does nothing — it bounces back to `/login`. | `/auth/oauth` (the server route that *starts* OAuth) was missing from `PUBLIC_ROUTES` in `apps/web/src/lib/supabase/middleware.ts`; the auth middleware redirected the unauthenticated request to `/login` before the route ran. **Fixed (fix #1).** |
| 2 | Even reachable, OAuth cannot complete in a release Android build. | The WebView is an RFC 8252 *embedded user-agent*. OAuth starts in the WebView (PKCE verifier cookie → WebView jar); the WebView ejects the off-origin authorize URL to a Chrome Custom Tab; the callback + `exchangeCodeForSession` run in the Custom Tab's *separate* cookie jar. RFC 7636 requires one client/jar to mint and redeem the verifier. RFC 8252 §8.12 forbids embedded-user-agent OAuth; Google enforces this with `disallowed_useragent`. |

Problem 2 is not a defect to patch — it is the architecture meeting a security standard. The WebView↔Custom-Tab cookie-jar split is RFC 8252's security boundary working as designed. The fix is architectural: stop the WebView from being the OAuth user-agent.

---

## 3. Goals

- G1. A user can sign in with **Google** in the Android app, via the native Credential Manager account picker.
- G2. A user can sign in with **GitHub** in the Android app, via a Chrome Custom Tab.
- G3. Identity **linking** (`mode=link`, from settings) works in the Android app for both providers.
- G4. Sign-in works **identically in debug and release** builds — no environment-specific auth path.
- G5. OAuth runs **only** in an external user-agent — RFC 8252 compliant; no `disallowed_useragent`.
- G6. Long-lived credentials (refresh tokens, the Google ID token) **never** enter JavaScript-readable storage or native Kotlin variables.
- G7. The browser (non-shell) sign-in flow is unchanged and unbroken.
- G8. The implementation is a hard cutover: no legacy code, no fallbacks, no dead branches.

---

## 4. Non-Goals

- N1. Converting the Android shell to a Trusted Web Activity. (Considered and rejected — see §15, Key Decision K1.)
- N2. iOS. There is no iOS app in this repo.
- N3. Passkey or password sign-in. Credential Manager makes these reachable later, but this spec ships Google + GitHub only.
- N4. Changing the web/desktop-browser auth flow beyond fix #1.
- N5. A native Supabase client or any native product-API client. The Android shell makes exactly one auth-bootstrap HTTP call (Option 2) and otherwise touches no API.
- N6. App-level encryption of the short-lived handoff record at rest (see K7).
- N7. Email/magic-link auth changes.

---

## 5. Scope

**In scope:** the Android shell (`apps/android`); the web `/auth/*` routes and `apps/web/src/lib/auth`, `apps/web/src/lib/supabase`, the login page; a new backend table + FastAPI endpoints + service + cleanup job; `docs/rules/codebase.md`.

**Out of scope:** the FastAPI request pipeline, the worker beyond one cleanup job, the browser extension, the reader, the workspace.

---

## 6. Glossary

- **Shell** — the Android app, a native WebView wrapper. Detected server-side by the `NexusAndroidShell` User-Agent token.
- **External user-agent** (RFC 8252 §3) — a browser context the app cannot inspect: a Chrome Custom Tab or the system browser. Has its own cookie jar.
- **Embedded user-agent** — a WebView. Shares the app's security domain. RFC 8252 forbids OAuth in it.
- **Handoff code** — a single-use, ≤90 s, high-entropy code that names a server-stored Supabase session, used to move that session from an external context into the WebView.
- **Handoff verifier / challenge** — a PKCE-style pair: the native shell holds a random *verifier*; its SHA-256 *challenge* is stored with the handoff code; the verifier must be presented to redeem the code. Defeats handoff-code interception.
- **`flow`** — a query parameter on `/auth/oauth` and `/auth/callback`: absent (or `web`) for the browser flow, `handoff` for the native flow.

---

## 7. Target Behaviour

### 7.1 Flow A — Browser sign-in (baseline; unchanged except fix #1)

1. A desktop/mobile browser loads `/login`. Server-side `isShell` is `false`. The provider buttons are `<form action="/auth/oauth" method="get">` (existing `ProviderForm`).
2. Submit → `GET /auth/oauth?provider=google&next=/libraries`. `signInWithOAuth`; `redirectTo = <origin>/auth/callback?next=/libraries`; 307 → Google.
3. Google → `<origin>/auth/callback?next=/libraries&code=…`. No `flow=handoff` → `exchangeCodeForSession` → 307 → `/libraries`, session cookies set.

### 7.2 Flow B — Android GitHub sign-in (Option 1: Custom Tab + handoff)

1. The shell WebView loads `/login`. Server-side `isShell` is `true`. The GitHub button is a link: `<a href="nexus://auth/start?provider=github&mode=signin&next=/libraries">`.
2. Tap → main-frame navigation to `nexus://auth/start?…` → `MainActivity.shouldOverrideUrlLoading` intercepts it → `startAuthFlow(uri)`.
3. `startAuthFlow`: validates `provider`/`mode`; generates a random **handoff verifier** and its SHA-256 **challenge**, holds the verifier in memory; builds `<NEXUS_BASE_URL>/auth/oauth?provider=github&mode=signin&flow=handoff&hc=<challenge>&next=/libraries`; launches a **Chrome Custom Tab** at that URL. The WebView stays on `/login`.
4. The Custom Tab loads `/auth/oauth`. `signInWithOAuth`; `redirectTo = <origin>/auth/callback?flow=handoff&hc=<challenge>&next=/libraries`. The PKCE verifier cookie is written in the **Custom Tab's** jar. 307 → GitHub.
5. The user authenticates with GitHub **in the Custom Tab**. GitHub → Supabase → `<origin>/auth/callback?flow=handoff&hc=<challenge>&next=/libraries&code=…` — still in the Custom Tab, same jar; the PKCE verifier is present.
6. `/auth/callback` sees `flow=handoff`. `exchangeCodeForSession` succeeds → it holds the Supabase session. It mints a handoff code: `POST <fastapi>/auth/handoff-codes` (Bearer = the new access token; body = refresh token + `hc`) → `{ code }`. → `307 → nexus://auth/handoff?code=<code>&next=/libraries`.
7. Chrome cannot render the `nexus://` scheme → fires an Android `VIEW` intent.
8. The `nexus://auth/handoff` intent-filter on `MainActivity` (`singleTask`) catches it → `onNewIntent` → `loadUrlFromIntent` rewrites `nexus://auth/handoff?code=…` to `<NEXUS_BASE_URL>/auth/handoff?code=…&hv=<verifier>` (the verifier is added from native memory) → `webView.loadUrl(…)`.
9. The **WebView** loads `/auth/handoff`. It calls `POST <fastapi>/auth/handoff-codes/consume` (body = `code` + `verifier`). The server atomically deletes-and-returns the row iff `code` and `verifier` match and the row is unexpired → the session token pair. `setSession(...)` on a route-handler client → `307 → /libraries`, `applyCookies` sets the WebView's `HttpOnly` `sb-…-auth-token` cookie, `Cache-Control: no-store`.
10. The WebView is at `/libraries`, authenticated. The Custom Tab is left backgrounded.

### 7.3 Flow C — Android Google sign-in (Option 2: Credential Manager + handoff)

1. The shell WebView loads `/login`. The Google button is a link: `<a href="nexus://auth/native?provider=google&next=/libraries">`.
2. Tap → `shouldOverrideUrlLoading` intercepts `nexus://auth/native` → `GoogleSignInController.signIn(next)`.
3. The controller generates a random **handoff verifier** + **challenge** (held in memory), and a random **OIDC nonce** (raw + SHA-256). It calls `CredentialManager.getCredential` with `GetSignInWithGoogleOption(serverClientId = GOOGLE_WEB_CLIENT_ID, nonce = hashedNonce)` → the system Google account picker → a `GoogleIdTokenCredential` → the Google **ID token**.
4. `POST <NEXUS_BASE_URL>/auth/native/google` with `{ idToken, nonce: <rawNonce>, hc: <challenge> }`.
5. `/auth/native/google` calls `signInWithIdToken({ provider: "google", token: idToken, nonce: rawNonce })` → Supabase session. It mints a handoff code (`POST <fastapi>/auth/handoff-codes`, body = refresh token + `hc`) → responds `200 { code }`.
6. The controller loads the WebView at `<NEXUS_BASE_URL>/auth/handoff?code=<code>&hv=<verifier>&next=/libraries`.
7. Same as Flow B step 9–10.

### 7.4 Error & cancellation behaviour

- **OAuth error / user cancels in the Custom Tab (Flow B):** `/auth/callback` with `flow=handoff` redirects to `nexus://auth/handoff?error=<code>&next=…` (no `code`). Native rewrites to `/auth/handoff?error=<code>&next=…`. `/auth/handoff` maps `error` to a whitelisted message and redirects the WebView to `/login?error_description=…`.
- **Credential Manager cancel (Flow C):** the user dismissed the picker. The controller does nothing; the WebView stays on `/login`. A cancel is not an error and is not a fallback.
- **Credential Manager error (Flow C):** the controller loads the WebView at `/auth/handoff?error=native_google_signin_failed&next=…` → `/auth/handoff` → `/login?error_description=…`.
- **`signInWithIdToken` rejects (Flow C):** `/auth/native/google` responds with an error body; the controller loads the WebView at `/auth/handoff?error=native_google_signin_failed&next=…`.
- **Expired / used / wrong-verifier handoff code:** `/auth/handoff-codes/consume` returns 410; `/auth/handoff` redirects to `/login?error_description=…`.

Every error path terminates at `/login` in the WebView with a whitelisted message. There is no silent dead-end.

---

## 8. Architecture

### 8.1 Components

```
apps/android (Kotlin shell)          apps/web (Next.js)                python/nexus (FastAPI)
─────────────────────────            ──────────────────────            ──────────────────────
MainActivity                         /login  (isShell branch)          POST /auth/handoff-codes
  shouldOverrideUrlLoading  ──tap──▶  /auth/oauth   (flow=handoff)         (mint; Bearer-authed)
    nexus://auth/start                /auth/callback (flow=handoff,     POST /auth/handoff-codes/consume
    nexus://auth/native                 mints handoff code) ───────▶      (atomic delete-returning)
  startAuthFlow → Custom Tab          /auth/handoff (consumes code,     auth_handoff_codes table
  loadUrlFromIntent                     setSession, sets cookie)        purge job (periodic)
    nexus://auth/handoff  ◀──intent── /auth/native/google (Option 2)
GoogleSignInController                middleware PUBLIC_ROUTES
  (Credential Manager)
```

### 8.2 The handoff, in one paragraph

A Supabase session established in an external context (a Custom Tab, or the `/auth/native/google` route) cannot be read by the WebView — different cookie jar. So the establishing context **mints a handoff code**: it POSTs the session token pair plus a challenge to FastAPI, which stores `{code_hash, challenge, access_token, refresh_token, expires_at}` and returns the code. The code travels to the native shell (via a `nexus://` intent in Flow B, or an HTTP response in Flow C). The shell loads the **WebView** at `/auth/handoff?code=…&hv=<verifier>`. The WebView's server-side route presents `code` + `verifier` to FastAPI, which atomically deletes-and-returns the row iff `sha256(code)` and `sha256(verifier)` match an unexpired row. The route then `setSession`s those tokens, so `@supabase/ssr` writes the WebView's own `HttpOnly` session cookie. The session is now first-party to the WebView.

### 8.3 Flow B sequence (the full Custom-Tab handoff)

```
WebView          Native              Custom Tab            Next.js              FastAPI
  │  tap nexus://auth/start            │                     │                    │
  ├───────────────▶ startAuthFlow      │                     │                    │
  │            gen verifier+challenge  │                     │                    │
  │                 launch ───────────▶ GET /auth/oauth ─────▶ signInWithOAuth     │
  │                                    │  ◀─── 307 to GitHub ─┤                    │
  │                                    │  GitHub auth … 307   │                    │
  │                                    │  GET /auth/callback ─▶ exchangeCodeFor    │
  │                                    │     ?flow=handoff     │   Session         │
  │                                    │                       ├── mint ──────────▶ store row
  │                                    │  ◀ 307 nexus://       │  ◀── { code } ────┤
  │                                    │     auth/handoff      │                    │
  │                  ◀── VIEW intent ──┤                       │                    │
  │  ◀ loadUrl /auth/handoff?code&hv ──┤                       │                    │
  ├──────────────────────────────────────────▶ GET /auth/handoff                   │
  │                                              ├── consume ──────────────────────▶ delete-returning
  │                                              │  ◀── { access, refresh } ───────┤
  │  ◀──── 307 /libraries  (Set-Cookie) ─────────┤ setSession                       │
```

### 8.4 Why each leg is correct

- The OAuth handshake (steps 4–5) runs entirely in **one** browser context (the Custom Tab) — RFC 7636's "same client/jar" holds; RFC 8252's "external user-agent" holds; Google sees a real browser.
- The handoff code crosses the trust boundary; the **session tokens never do** until the final server-set `HttpOnly` cookie.
- The WebView is only ever loaded with first-party `<NEXUS_BASE_URL>` URLs — it is never an OAuth user-agent.

---

## 9. Capability Contract

### 9.1 Native ↔ web URL surface (the `nexus://` scheme)

| URL | Direction | Caught by | Meaning |
|---|---|---|---|
| `nexus://auth/start?provider={google\|github}&mode={signin\|link}&next={path}` | WebView → native | `MainActivity.shouldOverrideUrlLoading` (WebView-internal; **no** manifest filter) | Start a Custom Tab OAuth flow. Used for GitHub sign-in and for identity-linking of either provider. |
| `nexus://auth/native?provider=google&next={path}` | WebView → native | `MainActivity.shouldOverrideUrlLoading` (WebView-internal; **no** manifest filter) | Start native Credential Manager Google sign-in. |
| `nexus://auth/handoff?code={code}&next={path}` or `nexus://auth/handoff?error={errorCode}&next={path}` | Custom Tab → native | `MainActivity` `<intent-filter>` (registered OS `VIEW` intent) | Deliver the auth result. Native rewrites it to `<NEXUS_BASE_URL>/auth/handoff?…` (adding `hv=<verifier>`) and loads it in the WebView. |

`nexus://auth/start` and `nexus://auth/native` carry no secret and need no manifest filter — they are intercepted inside the WebView, like the existing `nexus-share://` scheme. Only `nexus://auth/handoff` arrives from outside the app and so needs a registered `<intent-filter>`.

### 9.2 Invariants

- The handoff **verifier** is generated by native, held only in native memory for the duration of one sign-in attempt, and never leaves the device except as `hv` in the WebView-internal `loadUrl` to `/auth/handoff`.
- The handoff **challenge** (`hc`) is `sha256(verifier)`; it is not secret and may appear in URLs and the DB.
- The handoff **code** is single-use and ≤90 s; it is dead after one `consume`.
- `provider` is validated against the closed set `{google, github}` at every entry point (native `startAuthFlow`, `/auth/oauth`, the login page).

---

## 10. API Design

### 10.1 Web routes (Next.js, `apps/web`)

**`GET /auth/oauth`** — modified. Reads `provider`, `mode`, `next`, **`flow`**, **`hc`**. Deletes the android-debug branch. When `flow=handoff`, `redirectTo = buildAuthCallbackUrl(origin, next, { flow: "handoff", hc })`; otherwise `redirectTo = buildAuthCallbackUrl(origin, next)`. Unchanged: provider validation, `signInWithOAuth`/`linkIdentity`, 307 to the provider. `runtime = "nodejs"`.

**`GET /auth/callback`** — modified. `handleAuthCallback` gains a `flow` read and a `mintHandoffCode` dependency (DI, like the existing `exchangeCodeForSession`). After a successful exchange, if `flow=handoff`: call `mintHandoffCode({ session, hc })` → `307 → nexus://auth/handoff?code=<code>&next=<next>`. On OAuth error with `flow=handoff`: `307 → nexus://auth/handoff?error=<errorCode>&next=<next>`. Without `flow=handoff`: unchanged (`307 → next`).

**`GET /auth/handoff`** — new. Public route, `runtime = "nodejs"`, `Cache-Control: no-store`. Reads `code`, `hv` (verifier), `next`, `error`.
  - If `error` present → map to a whitelisted message → `307 → /login?error_description=…`.
  - Else `POST <fastapi>/auth/handoff-codes/consume { code, verifier: hv }`. On 410/any failure → `307 → /login?error_description=<AUTH_CALLBACK_FAILURE_MESSAGE>`. On success → `createRouteHandlerClient`, `setSession({ access_token, refresh_token })`, `settlePendingCookieWrites()`, `applyCookies(307 → next)`.

**`POST /auth/native/google`** — new (Option 2). Public route, `runtime = "nodejs"`. Body `{ idToken, nonce, hc }`. `signInWithIdToken({ provider: "google", token: idToken, nonce })`. On success → mint a handoff code → `200 { code }`. On error → `4xx { error: <errorCode> }`.

**`PUBLIC_ROUTES`** (`apps/web/src/lib/supabase/middleware.ts`): add `/auth/handoff` and `/auth/native/google`. (`/auth/oauth` added by fix #1.)

### 10.2 Backend (FastAPI, `python/nexus`)

**`POST /auth/handoff-codes`** — mint. Auth: `Authorization: Bearer <access_token>` (verified by the existing JWKS verification → `user_id`). Body `{ refresh_token, challenge }`. Generates `code = secrets.token_urlsafe(32)`; stores a row `{ user_id, code_hash = sha256(code), challenge, access_token (from the bearer header), refresh_token, created_at, expires_at = now()+90s }`. Returns `{ code }`. Mirrors `python/nexus/api/routes/extension_sessions.py`.

**`POST /auth/handoff-codes/consume`** — consume. No auth (the code is the credential). Body `{ code, verifier }`. Executes one atomic statement:
`DELETE FROM auth_handoff_codes WHERE code_hash = :h_code AND challenge = :h_verifier AND expires_at > now() RETURNING access_token, refresh_token` where `:h_code = sha256(code)`, `:h_verifier = sha256(verifier)`. One row → `200 { access_token, refresh_token }`. Zero rows → `410`. A wrong verifier matches no row (no delete), so it does not burn a legitimate code.

### 10.3 Database (`auth_handoff_codes`)

New Alembic migration (next sequential revision; `0105_workspace_sessions.py` was the latest observed — confirm `alembic heads` at implementation). Conventions per `migrations/alembic/versions/0043_extension_sessions_and_capture.py`.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | `server_default gen_random_uuid()` |
| `user_id` | `UUID` FK → `users.id` | `ON DELETE CASCADE` |
| `code_hash` | `TEXT` | SHA-256 hex; `UNIQUE`; `CHECK char_length = 64` |
| `challenge` | `TEXT` | SHA-256 hex of the native verifier; `CHECK char_length = 64` |
| `access_token` | `TEXT` | the Supabase session access token |
| `refresh_token` | `TEXT` | the Supabase session refresh token |
| `created_at` | `TIMESTAMPTZ` | `server_default now()` |
| `expires_at` | `TIMESTAMPTZ` | `CHECK expires_at > created_at` |

Single-use is enforced by `DELETE … RETURNING` on consume (no `used_at` column — a consumed row no longer exists). A periodic job purges expired-unconsumed rows.

### 10.4 Android surface (`apps/android`)

- **`AndroidManifest.xml`** (main): a new `<intent-filter>` on `.MainActivity` — `action VIEW`, categories `DEFAULT` + `BROWSABLE`, `<data android:scheme="nexus" android:host="auth" android:path="/handoff" />`. Identical for debug and release (a custom scheme needs no `autoVerify`).
- **`MainActivity.shouldOverrideUrlLoading`** — before the `isOwnedUrl` check, intercept `scheme=nexus, host=auth`: `path=/start` → `startAuthFlow(uri)`; `path=/native` → `googleSignInController.signIn(uri)`; return `true`.
- **`MainActivity.startAuthFlow(uri)`** — `internal`. Validate `provider`/`mode`; generate `verifier`/`challenge`; persist the verifier on a pending-attempt field; build the `/auth/oauth?…&flow=handoff&hc=<challenge>` URL; launch a Custom Tab (reusing the `openExternalUrl` `CustomTabsIntent` builder).
- **`MainActivity.loadUrlFromIntent`** — delete the `nexus-dev://auth/callback` branch; add a `nexus://auth/handoff` branch (not debug-gated) that rewrites to `<NEXUS_BASE_URL>/auth/handoff`, appending `hv=<verifier>` from the pending attempt, then loads it in the WebView.
- **`GoogleSignInController.kt`** — new. Owns the Credential Manager call, the OIDC nonce, the verifier/challenge, the `POST /auth/native/google` call, and loading the WebView at `/auth/handoff`.
- **`build.gradle.kts`** — add `androidx.credentials:credentials:1.6.0`, `androidx.credentials:credentials-play-services-auth:1.6.0`, `com.google.android.libraries.identity.googleid:googleid:1.1.1`; add a `GOOGLE_WEB_CLIENT_ID` `buildConfigField` sourced from a Gradle property (per the release-signing precedent — not committed).

### 10.5 Login page (`apps/web/src/app/login`)

`LoginPage` (`page.tsx`) computes `isShell = isAndroidShellUserAgent(headers().get("user-agent"))` and passes it to `LoginPageClient`. `ProviderForm`: when `isShell`, render an `<a>` (styled as the button) with `href = nexus://auth/native?provider=google&next=…` (Google) or `nexus://auth/start?provider=github&mode=signin&next=…` (GitHub); when not, render the existing `<form>`. Identity-linking entry points render `nexus://auth/start?…&mode=link` in the shell.

---

## 11. Composition with Existing Systems

- **Auth middleware** (`apps/web/src/lib/supabase/middleware.ts`): `/auth/handoff` and `/auth/native/google` join `PUBLIC_ROUTES` — they must be reachable by an unauthenticated WebView. `/auth/oauth` is already public (fix #1).
- **`@supabase/ssr` / `createRouteHandlerClient`**: `/auth/handoff` uses the established `createRouteHandlerClient` → `setSession` → `settlePendingCookieWrites` → `applyCookies` pattern (`apps/web/src/lib/supabase/route-handler.ts`) so the WebView receives a normal SSR `HttpOnly` session cookie — identical to a desktop web session.
- **Extension-session precedent**: the mint/consume endpoints, the SHA-256-hashed token, the `Bearer`-authenticated Next.js→FastAPI call, and the table mirror the existing `extension_sessions` flow (`python/nexus/{services,api/routes}/extension_sessions.py`, migration `0043`).
- **`nexus-share://` precedent**: the `nexus://auth/*` interception mirrors `ShareActivity`'s custom-scheme handling (scheme + host + path check, param validation, consume with `return true`).
- **App Links**: the existing `https` `autoVerify` VIEW filter, `assetlinks.json`, and the Gradle fingerprint checks are **retained** — they are general deep-linking, independent of auth. The new auth design neither uses nor depends on them.
- **CSP** (`apps/web/src/middleware.ts`): `form-action 'self'` governs form submissions only — the shell's `<a href="nexus://…">` anchors are unaffected; `upgrade-insecure-requests` upgrades `http:`, not `nexus:`.
- **Job registry** (`python/nexus/jobs/registry.py`): a new periodic job `purge_expired_auth_handoff_codes` (hourly) deletes rows past `expires_at`.

---

## 12. Security Model & Threat Model

- **Where credentials live.** The Supabase refresh token's path: minted by Supabase → Custom Tab cookie jar (Flow B) or `/auth/native/google` server memory (Flow C) → POSTed over TLS to FastAPI → stored in `auth_handoff_codes` for ≤90 s → consumed once → returned over TLS to `/auth/handoff` → set as an `HttpOnly` cookie in the WebView. It is **never** in JavaScript-readable storage, **never** in a native Kotlin variable, **never** in a `nexus://` URL. The Google ID token (Flow C) lives only in native memory and one TLS POST body; it is never stored.
- **What crosses the `nexus://` boundary.** Only the handoff **code** (Flow B) — single-use, ≤90 s. The **verifier** never crosses a `nexus://` URL: native generates it before the flow and presents it directly to `/auth/handoff` via an in-process `loadUrl`.
- **Handoff-code interception (the main threat).** A malicious app could register an `<intent-filter>` for `nexus://auth/handoff` and receive the code. Mitigation: the **handoff binding** — the code is redeemable only with the verifier, which the attacker does not have (it is in the legitimate shell's memory, derived before the flow began). This is a PKCE-equivalent for the handoff leg. Without the verifier an intercepted code is inert. Residual risk: a malicious app that intercepts the intent can deny service by… not redeeming it (the legitimate app simply does not receive the intent) — a nuisance, not a compromise, and it requires pre-installed malware declaring that filter.
- **`code`/`verifier` in the `/auth/handoff` GET URL.** Both may land in server access logs. Acceptable: both are single-use and are consumed within that same request — they are dead before any log is read. (Same property as OAuth `?code=` in `/auth/callback`.)
- **The stored session row.** It holds a live token pair for ≤90 s. Mitigations: short TTL, atomic single-use delete, the binding verifier. No app-level encryption (K7) — the database already holds session-equivalent state and is the system trust anchor.
- **RFC 8252 compliance.** OAuth runs only in an external user-agent; the embedded WebView is never the OAuth user-agent. Credential isolation and anti-phishing (the WebView cannot keylog Google's password field) are preserved.

---

## 13. Rules & Invariants

Honors the repo rules (`docs/rules/`):

- **`layers.md`** — OAuth is initiated server-side; the browser holds no Supabase client. `signInWithOAuth`, `signInWithIdToken`, `exchangeCodeForSession`, and `setSession` all run in route handlers. The Android shell never calls Supabase. Each auth route owns one total deadline (reuse `createRouteHandlerClient`'s 5 s deadline).
- **`control-flow.md`** — `flow` (`web` | `handoff`) and `provider` (`google` | `github`) are matched exhaustively; the `consume` outcome is matched on its finite result set; no catch-all branches. Errors are handled by name; any discarded error carries `justify-ignore-error`.
- **`errors.md`** — handoff failures are modelled as typed errors (expired, not-found, verifier-mismatch collapse to one public `410`/`AUTH_CALLBACK_FAILURE_MESSAGE` to avoid leaking which); no swallowed exceptions.
- **`entrypoints.md`** — side effects live only in `route.ts` files, the FastAPI route modules, and `AndroidManifest.xml`-declared components.
- **`codebase.md`** — the Android module gains auth-orchestration responsibility; this rule is updated in the same change (see §14, K8).
- **`naming.md` / `conventions.md`** — scheme/host/path strings, the 90 s TTL, and route paths are named constants; observable identifiers use the repo's PascalCase convention.
- **`correctness.md`** — `consume` is a single atomic `DELETE … RETURNING`; concurrent or replayed consume attempts cannot both succeed.

New invariants introduced:

- **I1.** The WebView is never navigated to an OAuth provider or to a Supabase authorize URL. It only ever loads `<NEXUS_BASE_URL>` origins.
- **I2.** A handoff code is redeemable exactly once, only with its verifier, only within 90 s.
- **I3.** Debug and release builds run the identical auth code path. No `BuildConfig.DEBUG` branch exists in the auth flow.

---

## 14. Key Decisions

- **K1. Native shell, not a Trusted Web Activity.** A TWA would make OAuth "just work" but would force the web app to become an installable PWA, rewrite the native share-sheet feature as Web Share Target, turn web 5xx responses into app crashes, and discard `NexusWebView.kt`. The app has a substantial, deliberate native surface (file chooser, App Links, share sheet, custom back-stack). It is a native shell; this spec keeps it one.
- **K2. OAuth in an external user-agent.** Required by RFC 8252 §8.12 and enforced by Google (`disallowed_useragent`). Rejected: in-WebView OAuth (banned); User-Agent spoofing (a ToS violation and a brittle treadmill).
- **K3. One-time-code handoff.** The WebView and the Custom Tab have separate cookie jars by design (RFC 8252 §3). Rejected: sharing jars (impossible and a security regression); native injecting cookies (native would hold the refresh token).
- **K4. Google → Credential Manager; GitHub → Custom Tab.** Each provider has exactly one path — no redundancy. Credential Manager is Google's current native API (the legacy Google Sign-In SDK is being removed from the SDK as of 2026). GitHub has no native SDK, so it uses the RFC 8252 Custom Tab flow. There is no Custom-Tab fallback for Google and no Credential-Manager path for GitHub.
- **K5. The handoff binding (verifier/challenge).** A bare single-use code is interceptable by a malicious app within the 90 s window. Binding the code to a native-held verifier (PKCE-shaped) closes that vector. Applied uniformly to Flow B and Flow C so `/auth/handoff` has one code path.
- **K6. Hard cutover — delete the `nexus-dev://` debug path.** The new `nexus://auth/handoff` is environment-agnostic and works identically in debug and release. The debug/release auth asymmetry that masked the original bug is eliminated. `shouldUseAndroidDebugAuthCallback`, `buildAndroidDebugAuthCallbackUrl`, the debug manifest, and the `nexus-dev` scheme are deleted.
- **K7. No app-level encryption of the handoff row.** The row holds a live token pair for ≤90 s, single-use, atomically deleted. The database already holds all session-equivalent state and is the trust anchor; encrypting a 90 s row adds key-management surface for negligible gain.
- **K8. One native HTTP call, authorized by a rule update.** Flow C requires native to `POST /auth/native/google`. `docs/rules/codebase.md` forbids adding auth code to the Android module without updating the rule; the rule is updated in this change to permit exactly this one auth-bootstrap endpoint call. Flow B requires zero native HTTP calls.
- **K9. The browser flow is shared, not duplicated.** `/auth/oauth` and `/auth/callback` serve both the browser and the handoff flow, differing only by the `flow` parameter. No parallel route set.
- **K10. App Links retained.** They are general deep-linking, orthogonal to auth.

---

## 15. Final State

After this change:

- The Android app signs in with Google (Credential Manager) and GitHub (Custom Tab); identity-linking works for both. Debug and release behave identically.
- The web/browser flow is unchanged (plus fix #1).
- OAuth runs only in external user-agents. The WebView only ever loads `<NEXUS_BASE_URL>`.
- There is one auth code path; no `BuildConfig.DEBUG` auth branch; no `nexus-dev`.

**Deleted (hard cutover):**

- `apps/android/app/src/debug/AndroidManifest.xml` — the whole file (its two intent-filters were the legacy debug auth callback).
- `MainActivity.loadUrlFromIntent` — the `nexus-dev://auth/callback` branch.
- `apps/web/src/lib/androidShell.ts` — `shouldUseAndroidDebugAuthCallback`.
- `apps/web/src/lib/auth/redirects.ts` — `buildAndroidDebugAuthCallbackUrl`.
- `apps/web/src/app/auth/oauth/route.ts` — the `useAndroidDebugCallback` branch.
- The `nexus-dev` URI scheme — every reference, and the tests asserting it (`oauth/route.test.ts` "uses the debug Android callback scheme…", `MainActivityTest.kt` `debugDevCallbackIntent…`).

**Retained:** the `NexusAndroidShell` UA token, `isAndroidShellUserAgent`, the browser OAuth flow, App Links.

---

## 16. Files

**Created**

- `apps/web/src/app/auth/handoff/route.ts` (+ `route.test.ts`)
- `apps/web/src/app/auth/native/google/route.ts` (+ `route.test.ts`)
- `apps/android/app/src/main/java/app/nexus/android/GoogleSignInController.kt`
- `migrations/alembic/versions/0106_auth_handoff_codes.py` (number = current head + 1)
- `python/nexus/services/auth_handoff_codes.py` (+ tests)
- `python/nexus/api/routes/auth_handoff_codes.py` (+ tests)
- `docs/android-auth.md` (this spec)

**Modified**

- `apps/web/src/lib/supabase/middleware.ts` (+ `/auth/handoff`, `/auth/native/google`; `/auth/oauth` done) and `middleware.test.ts`
- `apps/web/src/lib/androidShell.ts` (− `shouldUseAndroidDebugAuthCallback`) and its test
- `apps/web/src/lib/auth/redirects.ts` (− `buildAndroidDebugAuthCallbackUrl`; + handoff/`nexus://` builders; `buildAuthCallbackUrl` gains `flow`/`hc`) and `redirects.test.ts`
- `apps/web/src/lib/auth/callback.ts` (+ `flow=handoff` branch, `mintHandoffCode` dep) and its test
- `apps/web/src/app/auth/oauth/route.ts` (− debug branch; + `flow`/`hc`) and `route.test.ts`
- `apps/web/src/app/auth/callback/route.ts` (+ `mintHandoffCode` impl) and `route.test.ts`
- `apps/web/src/app/login/page.tsx` (+ `isShell`) and `LoginPageClient.tsx` (+ shell `ProviderForm` branch) and `LoginPageClient.test.tsx`
- `apps/web/src/lib/auth/messages.ts` (+ a handoff-failure error code/message in the public allowlist, if not already covered)
- `apps/android/app/src/main/AndroidManifest.xml` (+ `nexus://auth/handoff` filter)
- `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt` (intercept `nexus://auth/start`+`/native`; `startAuthFlow`; − `nexus-dev` branch, + `nexus://auth/handoff` branch)
- `apps/android/app/build.gradle.kts` (+ 3 deps, + `GOOGLE_WEB_CLIENT_ID` field) and `gradle.properties`
- `apps/android/app/src/androidTest/java/app/nexus/android/MainActivityTest.kt`
- `python/nexus/db/models.py` (+ `AuthHandoffCode`)
- `python/nexus/jobs/registry.py` (+ purge job) and its handler module
- the FastAPI router registration module
- `docs/rules/codebase.md` (Android section — K8)

**Deleted**

- `apps/android/app/src/debug/AndroidManifest.xml`

---

## 17. External Setup (operator tasks — not implementable by code)

These must be done by the maintainer; Option 2 cannot be completed without O1–O3.

- **O1. Google Cloud — Web OAuth client.** Confirm the existing Google OAuth *Web* client ID (already used by the Supabase Google provider). It becomes `GOOGLE_WEB_CLIENT_ID` (Credential Manager `serverClientId`) and the ID token's `aud`.
- **O2. Google Cloud — Android OAuth clients.** Create an Android OAuth client for `app.nexus.android` (release package) with the **release keystore SHA-1**, and one for `app.nexus.android.debug` with the **debug keystore SHA-1**. Required for Credential Manager.
- **O3. Supabase dashboard.** Confirm the Google provider is enabled and accepts the Web client ID; no redirect-allowlist change is needed (the `nexus://` hop is app-side, after the Supabase callback).
- **O4. Gradle property.** Provide `GOOGLE_WEB_CLIENT_ID` as a Gradle property / CI secret (uncommitted), per the release-signing-property precedent.

---

## 18. Acceptance Criteria

- AC1. On a release Android build, "Continue with Google" opens the native account picker and lands the user authenticated at `/libraries`; no browser/Custom Tab is shown.
- AC2. On a release Android build, "Continue with GitHub" opens a Custom Tab, and after GitHub auth the user lands authenticated at `/libraries` in the WebView.
- AC3. AC1 and AC2 also pass on a debug build (against the local dev server) with no code difference.
- AC4. Cancelling the Google picker, or dismissing the Custom Tab, returns the user to `/login` with no error and no broken state.
- AC5. An OAuth provider error surfaces at `/login` in the WebView with a whitelisted message.
- AC6. A handoff code cannot be redeemed twice; a redeem without the matching verifier fails; a redeem after 90 s fails. Each failure ends at `/login` with a message.
- AC7. The desktop-browser sign-in flow (Google, GitHub) is unaffected.
- AC8. No `nexus-dev`, `shouldUseAndroidDebugAuthCallback`, `buildAndroidDebugAuthCallbackUrl`, or `apps/android/app/src/debug/AndroidManifest.xml` remains. `grep` is clean.
- AC9. `make verify` (typecheck, lint, unit, integration, browser) and `make verify-android` pass; the new e2e spec passes in CI.

## 19. Test Plan

- **Web unit** (vitest): `/auth/handoff` (success, expired/used → 410, error param); `/auth/native/google` (success, `signInWithIdToken` error); `/auth/oauth` (`flow=handoff` builds the `hc`-bearing `redirectTo`; debug-branch test deleted); `handleAuthCallback` (`flow=handoff` mints + redirects to `nexus://`); `redirects.ts` builders; `LoginPageClient` (shell vs browser rendering); `middleware.test.ts` (the public-routes list).
- **Backend** (pytest): `auth_handoff_codes` service + routes — mint, atomic consume, single-use, wrong-verifier, expiry; mirror the `extension_sessions` tests.
- **Android instrumentation** (`MainActivityTest`): `nexus://auth/start` launches a Custom Tab at the `/auth/oauth` URL (espresso-intents); `nexus://auth/handoff` `VIEW` intent loads `<base>/auth/handoff?code=…&hv=…` in the WebView; the `nexus-dev` test is deleted.
- **E2E** (Playwright): a shell-UA handoff round-trip against the real stack (extend `e2e/tests/auth.spec.ts`, gated like the existing GitHub-provider round-trip).
- **Manual**: a release APK on a physical device — Google and GitHub sign-in, cancel, error, and a backgrounded-app return.

## 20. Implementation Phases

- **Phase 0 — fix #1.** `/auth/oauth` → `PUBLIC_ROUTES` + test. **Done.** Ship as a standalone hotfix.
- **Phase 1 — backend.** Migration, `AuthHandoffCode` model, service, mint/consume routes, purge job, tests.
- **Phase 2 — web handoff.** `/auth/handoff`, `mintHandoffCode`, the `/auth/oauth` + `/auth/callback` `flow=handoff` branches, `redirects.ts` builders, `PUBLIC_ROUTES`, the login-page shell branch, tests. Delete the `nexus-dev` web code.
- **Phase 3 — Android Option 1.** The `nexus://auth/handoff` filter, `shouldOverrideUrlLoading` interception, `startAuthFlow`, the `loadUrlFromIntent` rewrite; delete the debug manifest and the `nexus-dev` branch; tests. End-to-end GitHub sign-in works.
- **Phase 4 — Option 2.** `/auth/native/google`, `GoogleSignInController`, the Gradle deps + `GOOGLE_WEB_CLIENT_ID`, tests. Requires O1–O4. End-to-end Google sign-in works.
- **Phase 5 — cutover verification.** `codebase.md` update, the e2e spec, `make verify` + `make verify-android`, manual release-device testing, `grep` for deleted symbols.

## 21. Risks & Mitigations

- **R1. External setup blocks Phase 4.** Mitigation: Phases 1–3 (GitHub) need no external setup and ship independently; Option 2 follows once O1–O4 land.
- **R2. The Custom Tab is left backgrounded after the handoff.** A Custom Tab cannot be reliably closed programmatically; the `VIEW` intent brings `MainActivity` to the front, so the user is in the app. Accepted minor UX cost.
- **R3. Handoff-code interception by pre-installed malware.** Mitigated by the verifier binding (K5); residual risk is denial-of-service only, requiring malware already present.
- **R4. Credential Manager unavailable** (no Play services / de-Googled device). Google sign-in then fails with a surfaced error; GitHub remains available. No fallback, by K4.
- **R5. The Android build cannot be fully exercised in CI without an emulator.** Mitigation: instrumentation tests run on the CI emulator (`make test-android`); `make verify-android` covers lint + build without a device.
