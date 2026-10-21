# auth

## purpose

Who is asking, settled once per runtime, and what they may read, said once.
Supabase holds credentials, identities, refresh tokens and the auth mail; nexus
holds `users.id` (the token's `sub`) and a mirror of its email. Each runtime
reaches the provider through one module whose exports are the contract: leaving
supabase (`docs/issues/leave-supabase-auth.md`) replaces those modules behind
the same exports and keeps `users.id` equal to the new provider's subject.

| runtime | the one module | knows |
|---|---|---|
| web | `apps/web/src/lib/supabase/cookie.ts` | the session cookie's name and grammar; network-free classification (anonymous, active with more than 120 s left, refreshable, ended); edge-safe |
| web | `apps/web/src/lib/supabase/auth.ts` | the sdk (one client per operation, 5 s deadline, 2 s for verify); `verify`; the one refresh owner; every provider operation with its error table; the issuer and audiences to accept |
| api | `python/nexus/auth/verifier.py` `TokenVerifier` | the key set url, issuer, audiences, algorithms and the key cache |

Nothing else imports `@supabase/*`. Routes import the operations from
`lib/supabase/auth`; `lib/auth/session.ts` turns them into response effects.

config: the api requires `SUPABASE_JWKS_URL`, `SUPABASE_ISSUER` and
`SUPABASE_AUDIENCES` (`TokenVerifier` refuses to start without them); workers
read none. The web reads `NEXT_PUBLIC_SUPABASE_{URL,ANON_KEY}` and
`SUPABASE_{ISSUER,AUDIENCES}` (`lib/env.ts`: required in staging and prod,
locally the url + `/auth/v1` and `authenticated`).

## a valid bearer (one definition, both runtimes)

Signed by a key the project's key set publishes, in that key's algorithm
(RS256 or ES256), `iss` the issuer, an `aud` among the audiences, `exp` in force
(the api allows 60 s; the web never treats a session within 120 s of expiry as
active), `sub` a uuid.

- web `verify(token) -> Viewer | "Rejected"`: `getClaims` (local with asymmetric
  keys; the provider verifies a symmetric or kid-less token, and its `bad_jwt`
  is Rejected), then the claims above. A refusal logs
  `auth_verify_claim_refused <iss|aud|sub>`, never a value. A token `getClaims`
  throws on (a header that is not json, an `alg` other than RS256/ES256 or not
  its key's) is Rejected and logs `auth_verify_token_refused <error name>`. No
  answer within the deadline throws `AuthUnavailable`.
- api `await TokenVerifier.verify(token) -> (user_id, email | None)` (email
  stripped and lowercased): any token failure is 401 `E_UNAUTHENTICATED`
  `Invalid token: <reason>`; a key set that cannot be fetched, is not json or has
  no usable key is 503 `E_AUTH_UNAVAILABLE`. Keys are cached per process for an
  hour; an unknown kid refetches at most every 30 s and is otherwise 401.
  Fetches run in the threadpool, one at a time.
- key rotation: publish the new signing key as standby for over an hour first.

## web sessions (`apps/web/src/lib/auth/session.ts`)

`resolveEntry(cookies)` (middleware, the resolve route, extension connect)
verifies an active bearer and renews once when it is rejected or expiring;
`liveSession()` (the bff, actions) takes an active bearer on the 120 s margin
alone and renews only a refreshable one. Both answer `Live` (with the rotation's
writes to publish first), `Ended` (names to clear) or `Anonymous`, and throw
`AuthUnavailable`. `verifySession()` (server components) verifies only: a
rejected GET waits on the unavailable page, a POST goes to login.
`withActionSession` publishes a rotation before an operation's writes; `finish`
applies one `Effect` (Preserve, Write, Clear with the one-minute ended feedback)
with `private, no-store` and `Vary: Cookie`.

Network-free, restated (#607 verifies at entry): classifying the cookie never
touches the network, and a navigation reaches the provider only to renew a
session within 120 s of expiry or one `verify` rejected, to verify a symmetric
or kid-less token (the provider answers for those), or to fetch the key set when
the process's copy (auth-js, process-wide, 10 min) is cold, stale or lacks the
token's kid. With asymmetric keys and a warm key set, entry is local.

## api identity (`python/nexus/auth/middleware.py`)

A plain asgi middleware inside the edge. `PUBLIC_PATHS` pass untouched. With an
internal secret configured (staging and prod) every other request carries it as
`X-Nexus-Internal` (403 `E_INTERNAL_ONLY`). Route-authenticated paths stop
there: the handoff consume (body credential), the extension session and
`/extension/*` (`auth/extension.py`: an extension bearer resolves identity
only), `/public/resource-share[/…]` (share token). Every other request needs
`Authorization: Bearer` (401 `E_UNAUTHENTICATED`) and gets
`Viewer{user_id, email}` in the request state; `get_viewer` reads it. Each
refusal logs `auth_failure` with a `reason`; the edge's request context adds
`path` and `request_id`.

First sight: the first request of each (user, token email) pair in a process
runs `services/bootstrap.ensure_user_and_default_library` in its own session:
the `users` row (email mirrored; another row still holding the address gives it
up), the default library "My Library" and the owner's admin membership.
Idempotent; concurrent first sights converge through the SERIALIZABLE retry
(`users_pkey`, `uix_libraries_one_default_per_user`). A failure is 500
`E_INTERNAL` for that request and is retried by the next.

`GET /me`, `PATCH /me` (display name, calendar time zone; absolute values, so a
resend is a no-op) answer `UserProfileOut`; `email_ingest_address` only to the
account `EMAIL_INGEST_OWNER_USER_ID` names.

## readable relations (`python/nexus/auth/permissions.py`)

Each rule is spelled once, in SQL binding `:viewer_id`; the module docstring
states them. Point checks (`can_read_media`, `can_restore_media`,
`can_read_conversation`, `can_read_highlight`, `is_library_member`) answer a
bool; not found and not visible are the same False. The ORM adapters
`highlight_visibility_filter(viewer)` and `highlight_readability_filter(viewer)`
are text clauses correlated to the unaliased `highlights` table: a query that
aliases `Highlight` cannot use them.

## handles (`python/nexus/services/sealed_handles.py`)

A discovery handle is `ndt1.<payload>.<tag>`: a canonical base64url payload
(1..4,096 bytes) and an HMAC-SHA256 tag under
`HMAC(NEXUS_HANDLE_KEY, "nexus-handle-key\0browse-discovery-target")`; anything
else is 400 `E_INVALID_DISCOVERY_TARGET`. A share token is `nxshr1_` and 32
random bytes, stored as minted.

## invariants

- the browser never holds a provider client or token; auth cookies are
  HttpOnly, Lax, path `/`, Secure iff `APP_PUBLIC_URL` is https.
- one refresh owner: one provider refresh in flight per presented cookie per
  web process.
- a dependency failure keeps credentials and answers 503 (or the unavailable
  page); only terminal outcomes clear them.
- the web and the api accept the same bearers, but for two differences no
  bearer in use reaches: python's `UUID()` also takes a `sub` without hyphens,
  braced or as `urn:uuid:` (the provider mints the canonical form, the only one
  the web takes), and the api's 60 s `exp` leeway lies past anything the web
  forwards (it renews 120 s before expiry).
- a key fetch never runs on the api's event loop; a request whose key is cached
  never waits on one.
- `users.email` is held by at most the one account whose latest seen token
  carries it.
- not found and not visible are indistinguishable for every readable relation.
