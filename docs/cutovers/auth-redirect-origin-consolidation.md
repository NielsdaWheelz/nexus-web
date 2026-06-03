# Auth redirect-origin consolidation

**Status:** Built + verified + standards-reviewed (branch `auth-redirect-origin-consolidation`, 2026-06-03) · **Date:** 2026-06-02 · **Owner module:** `apps/web/src/lib/auth/callback-origin.ts`

**Built (2026-06-03):** Phases 1–3 + 5 applied per §8/§13/§14. `callback-origin.ts` is now policy-core + two resolvers (`getForwardedOrigin` takes `Headers`, `getHostOrigin` is host-only, parser private); `account/actions.ts` deletes its local resolver and fails closed through the owner. New `callback-origin.test.ts` (9 cases incl. the `x-forwarded-proto` parity guard) and `account/actions.test.ts` (3 cases) pass. Gates: grep gate clean (only `callback-origin.ts` + `middleware.ts:47`), full lint clean, unit 545/545, browser 829/829. Typecheck: changed files clean; 10 pre-existing errors remain in unrelated `*.ac4.test.tsx` panes (identical to base — out of scope). **Phase 4 (§17 rollout prereqs: Next `serverActions.allowedOrigins`, Supabase redirect allowlist, redirect-construction smoke) is deploy-time config, NOT code — still outstanding.**

**Revision (post-review):** direct origin is now built from `host` alone (no `x-forwarded-proto`); the allowlist parser stays **private** and the extension-route reuse is deferred (§9-C); added an action-level guard test (§12·6); added rollout prerequisites for Next's Server Action origin gate and the Supabase redirect allowlist (§16–17). See §16 for the decision rationale.

**Standards review (2026-06-03):** Validated end-to-end (grep gate clean, lint clean, unit 545/545, changed files typecheck-clean) and reviewed change-by-change against `docs/rules` via parallel subagents (code standards, tests, adversarial security, consolidation). Three fixes applied: (1) the `account/actions.ts` fail-closed `catch` now narrows the error + carries `justify-ignore-error` + logs `auth_email_change_origin_rejected` (control-flow.md:15 + the `lib/auth` `console.error("auth_*")` idiom); (2) the one-use `isLocalHost` helper was inlined into `getHostOrigin` (minimalism — `isLocalOrigin` is the sole local-host authority); (3) both new tests moved to the native `vi.stubEnv`/`vi.unstubAllEnvs`, assert the distinguishing throw message, and assert the fail-closed log. Adversarial security review found zero exploitable vectors across 8 probed (proto-parity, header smuggling, normalizeOrigin bypass, allowlist symmetry, IPv6/localhost, missing headers, trusted-proxy gate, downstream open-redirect/CRLF). Stale refs corrected below: `parseConnectOrigin` lives in `lib/env.ts` (not `lib/security/csp.ts`); the secure-context check is `middleware.ts:47` (not `:42`).

Source finding: `docs/cutovers/codebase-cleanliness-audit.md` **🟠 5** — *"resolveServerActionOrigin in account/actions.ts re-implements origin resolution already owned by lib/auth/callback-origin.ts"* (`Medium · High-confidence · Duplication · cleanliness.md §4/§6, layers.md`).

---

## 1. Summary

`apps/web/src/lib/auth/callback-origin.ts` is the canonical owner of "resolve a trusted origin for an auth redirect": it reads `AUTH_ALLOWED_REDIRECT_ORIGINS`, normalises candidate origins, accepts a forwarded host only when the direct connection is a trusted proxy, and **throws** when nothing is allowlisted. Route handlers (`/auth/oauth`, `/auth/callback`, `/auth/handoff`) all flow through it.

`changeEmailAction` (`settings/account/actions.ts`) does **not**. It has a private `resolveServerActionOrigin(headers)` that trusts `x-forwarded-host ?? host` directly, guesses the scheme from a string prefix, applies **no allowlist, no normalisation, no credential rejection, no proxy-trust**, and silently falls back to `http://localhost:3000`. The resulting origin is fed into Supabase `emailRedirectTo`.

This is duplication **and** an unguarded surface: the email-change confirmation link is built from an attacker-influenceable `Host`/`x-forwarded-host` header with zero app-side validation (the only backstop is Supabase's own redirect allowlist). Host-header poisoning can point the confirmation link — and its token — at an attacker origin.

This cutover deletes the private resolver and routes the server action through the canonical owner via a new, parallel entry point. It is a **hard cutover**: no compatibility shim, no retained fallback, the hardcoded `http://localhost:3000` default is removed.

---

## 2. Goals

- One owner for redirect-origin resolution. The server-action path enforces the **same** allowlist + trusted-proxy semantics as the route-handler path.
- Close the `changeEmail` Host-header trust gap with app-level allowlisting (defense-in-depth on top of Supabase).
- **Exact parity with the route resolver:** the direct origin is built only from the connection's `host` header; forwarded headers (`x-forwarded-*`) never influence it and are honoured only after the direct origin proves to be a trusted proxy.
- Give the module its first **direct** unit tests (today it is only covered transitively), including an action-level guard test the mocked UI test cannot provide.

## 3. Non-goals

- **`parseConnectOrigin` in `lib/env.ts` is explicitly NOT merged.** See §9. Different trust context, intentional policy divergence, kernel too small to dedupe across a security boundary.
- CSRF same-origin checks (`lib/api/proxy.ts:301`, `auth/password/route.ts:35`) — a different concern (request provenance, not redirect-target allowlisting). Left as-is.
- Client-side same-origin guards (`workspace/workspaceHref.ts`, `androidShell.ts`, `workspace/store.tsx` postMessage) — client trust model. Left as-is.
- `middleware.ts:47` `x-forwarded-proto === "https"` — secure-context detection, not origin resolution. Left as-is.
- The URL builders in `lib/auth/redirects.ts` (`buildAuthCallbackUrl`, `buildLoginRedirectUrl`, …) are already centralised; we compose with them and do not change them.
- **Extension OAuth allowlist consolidation** (`app/extension/connect/start/route.ts`) — deferred. Reusing the auth parser would couple a non-auth env var (`NEXUS_EXTENSION_REDIRECT_ORIGINS`) to an auth-callback owner across a layer boundary; the right move is a neutral `lib/security` parser, which is its own refactor. See §9-C.
- No change to env-var names or to the route-handler path's observable behaviour.

---

## 4. Target behaviour

**Server action (`changeEmailAction`).** Resolve the redirect origin from request headers using the same policy as auth callbacks:

| Condition | Result |
| --- | --- |
| `AUTH_ALLOWED_REDIRECT_ORIGINS` configured, `host`-derived origin is allowlisted | return it |
| Configured, host origin not allowlisted, but `x-forwarded-host` origin is allowlisted **and** host origin is a trusted proxy | return the forwarded origin |
| Configured, nothing matches (incl. spoofed host) | **throw** → action returns the public failure message, no email sent |
| Allowlist empty (local dev), host origin is localhost/127.0.0.1/[::1] | return it (scheme `http`, derived from `host` — never from `x-forwarded-proto`) |
| Allowlist empty, host origin non-local | **throw** (fail closed) |
| No `host` header at all | **throw** (fail closed) |

**Route handlers.** Unchanged. `resolveCallbackRedirectOrigin(request, requestUrl)` keeps identical inputs, outputs, and error messages.

---

## 5. Capability contract

The module owns one capability — *"given an inbound request's transport metadata, return an origin that is safe to build an auth redirect URL against, or throw."* It exposes exactly two entry points, one per request shape, both delegating to a single private policy core:

- `resolveCallbackRedirectOrigin(request: Request, requestUrl: URL): string` — for **route handlers**, which have a parsed request URL.
- `resolveServerActionRedirectOrigin(requestHeaders: Headers): string` — for **server actions**, which only have `headers()`.

Nothing else is exported. The allowlist parser, the two candidate-builders, and `normalizeOrigin` are private — the module's public surface is exactly these two resolvers.

These two resolvers are **not interchangeable duplicate APIs** (which `module-apis.md` forbids): a caller has exactly one applicable form, since a server action cannot produce a `Request`/`URL`. They are two constructors over disjoint inputs, sharing one policy implementation — analogous to `fromString`/`fromHeaders`.

---

## 6. API design

```ts
// Public — exactly two entry points, one per request shape
export function resolveCallbackRedirectOrigin(request: Request, requestUrl: URL): string;
export function resolveServerActionRedirectOrigin(requestHeaders: Headers): string;

// Private (single owner of policy + parsing)
function resolveAllowlistedRedirectOrigin(directOrigin: string | null, forwardedOrigin: string | null): string;
function parseAllowlistedOrigins(rawValue: string | undefined): string[];
function getForwardedOrigin(requestHeaders: Headers): string | null; // x-forwarded-host (+ x-forwarded-proto)
function getHostOrigin(requestHeaders: Headers): string | null;      // host header only; scheme derived from host
function normalizeOrigin(value: string): string | null;
function isLocalOrigin(origin: string): boolean;
function getFirstHeaderValue(value: string | null): string | null;
```

- **Inputs.** One object/primitive per boundary; no options bag (none is needed yet — `simplicity.md`).
- **Output.** A normalised origin string (`scheme://host[:port]`, no path/query/fragment/credentials).
- **Errors.** Throws `Error` with the existing two messages (`… must be configured for non-local auth callbacks`, `… rejected auth callback origin`). Callers fail closed.
- **Purity.** Resolvers read `process.env` internally so both entry points share env wiring; everything below them is pure.

---

## 7. Architecture / structure

```
                         process.env[AUTH_ALLOWED_REDIRECT_ORIGINS]
                         process.env[AUTH_TRUSTED_PROXY_ORIGINS]
                                          │
                         resolveAllowlistedRedirectOrigin(directOrigin, forwardedOrigin)   ← single policy core
                                          ▲                         ▲
              directOrigin = requestUrl.origin            directOrigin = getHostOrigin(headers)
              forwarded   = getForwardedOrigin(headers)   forwarded   = getForwardedOrigin(headers)
                                          │                         │
              resolveCallbackRedirectOrigin(req, url)   resolveServerActionRedirectOrigin(headers)
                          ▲                                         ▲
        /auth/oauth · /auth/callback · /auth/handoff        changeEmailAction (settings/account)
```

The only structural change to the existing route path is that `getForwardedOrigin` now takes `Headers` instead of `Request` (it only ever read `request.headers`); `resolveCallbackRedirectOrigin` passes `request.headers`. The decision logic is lifted verbatim into `resolveAllowlistedRedirectOrigin`, which now tolerates a `null` direct origin (only reachable on the server-action path when `host` is missing or unparseable).

---

## 8. Drafted code

### 8.1 `apps/web/src/lib/auth/callback-origin.ts` (full replacement)

```ts
const AUTH_ALLOWED_REDIRECT_ORIGINS = "AUTH_ALLOWED_REDIRECT_ORIGINS";
const AUTH_TRUSTED_PROXY_ORIGINS = "AUTH_TRUSTED_PROXY_ORIGINS";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function getFirstHeaderValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const first = value.split(",")[0]?.trim();
  return first ? first : null;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

function parseAllowlistedOrigins(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  const parsed = rawValue
    .split(",")
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => value !== null);

  return Array.from(new Set(parsed));
}

function getForwardedOrigin(requestHeaders: Headers): string | null {
  const forwardedHost = getFirstHeaderValue(requestHeaders.get("x-forwarded-host"));
  if (!forwardedHost) {
    return null;
  }

  const forwardedProto =
    getFirstHeaderValue(requestHeaders.get("x-forwarded-proto")) ?? "https";
  return normalizeOrigin(`${forwardedProto}://${forwardedHost}`);
}

function getHostOrigin(requestHeaders: Headers): string | null {
  const host = getFirstHeaderValue(requestHeaders.get("host"));
  if (!host) {
    return null;
  }

  // Direct origin is built from `host` ALONE — never from x-forwarded-*, which
  // is attacker-influenced and gates the forwarded-origin branch. Mirrors the
  // route path (direct origin = requestUrl.origin; forwarded headers consulted
  // only afterwards). The scheme is a deterministic candidate — local hosts get
  // http, everything else https — matched on raw-host prefixes since the host
  // may carry a port or bracketed IPv6 colons. The allowlist (prod) or
  // isLocalOrigin (empty allowlist) is the authority, so a wrong guess fails closed.
  const lowerHost = host.toLowerCase();
  const isLocal =
    lowerHost === "localhost" ||
    lowerHost.startsWith("localhost:") ||
    lowerHost.startsWith("127.0.0.1") ||
    lowerHost.startsWith("[::1]");
  return normalizeOrigin(`${isLocal ? "http" : "https"}://${host}`);
}

function resolveAllowlistedRedirectOrigin(
  directOrigin: string | null,
  forwardedOrigin: string | null
): string {
  const allowlistedOrigins = parseAllowlistedOrigins(
    process.env[AUTH_ALLOWED_REDIRECT_ORIGINS]
  );
  const trustedProxyOrigins = parseAllowlistedOrigins(
    process.env[AUTH_TRUSTED_PROXY_ORIGINS]
  );

  if (allowlistedOrigins.length === 0) {
    if (directOrigin && isLocalOrigin(directOrigin)) {
      return directOrigin;
    }

    throw new Error(
      `${AUTH_ALLOWED_REDIRECT_ORIGINS} must be configured for non-local auth callbacks`
    );
  }

  if (directOrigin && allowlistedOrigins.includes(directOrigin)) {
    return directOrigin;
  }

  if (
    forwardedOrigin &&
    allowlistedOrigins.includes(forwardedOrigin) &&
    directOrigin &&
    trustedProxyOrigins.includes(directOrigin)
  ) {
    return forwardedOrigin;
  }

  throw new Error(`${AUTH_ALLOWED_REDIRECT_ORIGINS} rejected auth callback origin`);
}

export function resolveCallbackRedirectOrigin(
  request: Request,
  requestUrl: URL
): string {
  return resolveAllowlistedRedirectOrigin(
    requestUrl.origin,
    getForwardedOrigin(request.headers)
  );
}

export function resolveServerActionRedirectOrigin(
  requestHeaders: Headers
): string {
  return resolveAllowlistedRedirectOrigin(
    getHostOrigin(requestHeaders),
    getForwardedOrigin(requestHeaders)
  );
}
```

### 8.2 `apps/web/src/app/(authenticated)/settings/account/actions.ts` (swap)

```ts
"use server";

import { headers } from "next/headers";

import { resolveServerActionRedirectOrigin } from "@/lib/auth/callback-origin";
import {
  EMAIL_CHANGE_FAILURE_MESSAGE,
  toPublicAuthErrorMessage,
} from "@/lib/auth/messages";
import { buildAuthCallbackUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/server";

export async function changeEmailAction({
  email,
}: {
  email: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { ok: false, error: EMAIL_CHANGE_FAILURE_MESSAGE };
  }

  let redirectOrigin: string;
  try {
    redirectOrigin = resolveServerActionRedirectOrigin(await headers());
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    // justify-ignore-error: a misconfigured allowlist or a spoofed Host must
    // fail closed as the public failure message — no confirmation link is minted
    // and the raw resolver error (which names env vars) never reaches the client.
    console.error("auth_email_change_origin_rejected", {
      reason: error.message,
    });
    return { ok: false, error: EMAIL_CHANGE_FAILURE_MESSAGE };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser(
    { email: normalized },
    {
      emailRedirectTo: buildAuthCallbackUrl(redirectOrigin, "/settings/account"),
    }
  );
  if (error) {
    return {
      ok: false,
      error:
        toPublicAuthErrorMessage(error.message) ?? EMAIL_CHANGE_FAILURE_MESSAGE,
    };
  }
  return { ok: true };
}
```

Deletes the local `resolveServerActionOrigin` (lines 12-25) and its `http://localhost:3000` fallback. Resolution moves ahead of `createClient()` and is wrapped so a misconfig/spoof fails closed with the existing public message rather than surfacing a raw server-action error; the catch narrows the error and logs `auth_email_change_origin_rejected` per control-flow.md:15.

---

## 9. Consolidation map (reuse / centralise / deliberately separate)

**A. `resolveServerActionOrigin` (account/actions.ts) → DELETE, route through owner.** This cutover. The one ad-hoc redirect-origin derivation in app code (verified: only `callback-origin.ts` and this file read `host`/`x-forwarded-*` for origin resolution; `emailRedirectTo` has one consumer).

**B. `parseConnectOrigin` (`lib/env.ts:139`) → KEEP SEPARATE (non-goal).** Looks like a duplicate (`new URL` → reject path/query/hash → return `.origin`) but the policies differ on purpose because the trust context differs:

| | `normalizeOrigin` (auth) | `parseConnectOrigin` (CSP) |
| --- | --- | --- |
| When | per-request, user-facing redirect | build/config-time, env-derived |
| Path | must be exactly `/` | `""` or `/` (lenient) |
| Credentials | rejected | not checked |
| `http` | accepted (allowlist gates it) | only localhost **or** non-prod |
| Trust source | `AUTH_ALLOWED_REDIRECT_ORIGINS` + proxy chain | `FASTAPI_BASE_URL` / `R2_S3_API_ORIGIN` + `.r2.cloudflarestorage.com` |
| Failure | throws | silent-skip in dev, throw in prod |

Merging would force an options-laden validator where **both** call sites need different flags at once — the exact anti-pattern `simplicity.md` warns against. The genuinely shared kernel is ~4 lines, under `cleanliness.md`'s "dedupe only when large or dangerous" bar. Matches the audit's own conversations-service precedent: *do not merge when semantics genuinely differ for product/security reasons.* Action: at most a one-line cross-reference comment; no code merge.

**C. Extension OAuth allowlist (`app/extension/connect/start/route.ts:~34`) → DEFERRED (not this cutover).** It re-implements the split/trim/filter parse against `NEXUS_EXTENSION_REDIRECT_ORIGINS` and compares `redirectUrl.origin` against **raw** strings. Tempting to point it at `callback-origin.ts`'s parser — but exporting that parser would (a) break the "exactly two entry points" contract, and (b) route an extension-OAuth env var through an **auth-callback** owner, coupling two different security policies across a layer boundary (`layers.md`). So `parseAllowlistedOrigins` stays **private** here. If this consolidation is worth doing later, extract a **policy-neutral** origin-allowlist parser into a `lib/security` utility with explicit semantics and have *both* the auth module and the extension route depend on that — a separate, properly-scoped refactor, not a side effect of this cutover. (The normalisation upside — trailing-slash/case-robust comparison — still applies and motivates that future refactor.)

---

## 10. How it composes with other systems

- **`redirects.ts`.** `resolveServerActionRedirectOrigin` returns a string origin → `buildAuthCallbackUrl(origin, "/settings/account")` → `/auth/callback?next=…` on an allowlisted origin. Symmetric with the OAuth route, which uses `resolveCallbackRedirectOrigin` into the same builder.
- **Supabase.** That URL becomes `emailRedirectTo`. The confirmation link now provably targets an allowlisted origin; the `/auth/callback` route then re-resolves via `resolveCallbackRedirectOrigin`, so both ends of the flow share the policy.
- **Env.** `AUTH_ALLOWED_REDIRECT_ORIGINS` (+ optional `AUTH_TRUSTED_PROXY_ORIGINS`) now also gate the server-action path. Documented in `apps/web/README.md:51`; prod already sets it (callbacks require it). Dev relies on the empty-allowlist → localhost branch.
- **Next.js — Server Action origin gate (runs *before* our code).** Next compares the `Origin` header host against `x-forwarded-host`/`host` and aborts the action (`Invalid Server Actions request`, 500) on mismatch unless `serverActions.allowedOrigins` is set. So `resolveServerActionRedirectOrigin` only ever runs on requests Next already judged same-origin — which is why the forwarded-origin branch is effectively belt-and-suspenders on the action path and why a proxied deployment must configure `allowedOrigins`. See §17.
- **Next.js — typing.** `headers()` returns `ReadonlyHeaders`, assignable to the `Headers` parameter in this repo's TS config (the prior `resolveServerActionOrigin(await headers())` already relied on this). If a future TS bump rejects it, narrow the helper params to `Pick<Headers, "get">`.

---

## 11. Rules applied

- `cleanliness.md` §4/§6 — collapse repeated logic to a single owner; one concern, one owner. (A)
- `module-apis.md` — one primary form per capability; the two resolvers are disjoint constructors, not interchangeable duplicates. The allowlist parser stays private (no new public surface). (A)
- `layers.md` / `architecture.md` — auth/redirect logic lives in the `lib/auth/*` boundary; the leaked copy returns home. (A)
- `simplicity.md` — no options bag, no speculative surface; fewer code paths after the swap. Also the reason **not** to merge B. (A, B)
- `testing_standards.md` — auth/session behaviour is verified; add direct unit coverage. (§12)

---

## 12. Acceptance criteria

1. `changeEmailAction` builds `emailRedirectTo` only from an allowlisted origin (configured envs) or a localhost origin (empty allowlist); never from an unvalidated `host`/`x-forwarded-host`.
2. A spoofed `Host` / `x-forwarded-host` not in the allowlist → resolver throws → action returns `EMAIL_CHANGE_FAILURE_MESSAGE`, no Supabase call side-effects a malicious link.
3. No ad-hoc origin derivation remains in app code: `grep -rn "x-forwarded-host\|x-forwarded-proto" apps/web/src` (excluding tests) returns only `callback-origin.ts` and `middleware.ts:47`.
4. Route-handler behaviour unchanged: existing `lib/auth/callback.test.ts` and `app/auth/callback/route.test.ts` pass without edits.
5. New `apps/web/src/lib/auth/callback-origin.test.ts` (unit project) covers both resolvers:
   - host-origin allowlisted → returned;
   - host not allowlisted, `x-forwarded-host` allowlisted + host is trusted proxy → forwarded returned;
   - spoofed forwarded host without trusted-proxy host → throws;
   - **`x-forwarded-proto` does not influence the direct origin** — a spoofed `x-forwarded-proto: https` cannot turn a non-trusted host into a trusted-proxy match (parity guard for Finding 1);
   - empty allowlist + localhost host → returned (`http://`);
   - empty allowlist + non-local host → throws;
   - missing `host` → throws;
   - route resolver: allowlisted `requestUrl.origin` and forwarded-via-trusted-proxy parity cases.
6. New `apps/web/src/app/(authenticated)/settings/account/actions.test.ts` (unit project) proves the **action-level** guard the mocked UI test cannot: `SettingsAccountPaneBody.test.tsx:11` stubs `changeEmailAction`, so it exercises no resolver/Supabase path. With `next/headers` returning spoofed headers and `@/lib/supabase/server` mocked, `changeEmailAction` returns `EMAIL_CHANGE_FAILURE_MESSAGE` and **neither `createClient` nor `updateUser` is called**; with an allowlisted host, `updateUser` is called with `emailRedirectTo` built on the allowlisted origin.
7. `bun run typecheck`, lint, and the unit + browser test projects are green (run from `apps/web`).

## 13. Files

- **Edit** `apps/web/src/lib/auth/callback-origin.ts` — extract policy core, add `resolveServerActionRedirectOrigin`, `getForwardedOrigin` takes `Headers`. `parseAllowlistedOrigins` stays private; `getHostOrigin` ignores `x-forwarded-proto`.
- **Edit** `apps/web/src/app/(authenticated)/settings/account/actions.ts` — delete local resolver, call the owner, fail-closed catch.
- **Add** `apps/web/src/lib/auth/callback-origin.test.ts` — direct resolver unit tests.
- **Add** `apps/web/src/app/(authenticated)/settings/account/actions.test.ts` — action-level guard test (mock `next/headers` + `@/lib/supabase/server`).

## 14. Cutover steps (ordered, hard cutover)

1. Refactor `callback-origin.ts` (policy core + two entry points; `getForwardedOrigin` takes `Headers`; `getHostOrigin` host-only; parser stays private). Verify the route path is behaviourally identical.
2. Add `callback-origin.test.ts`; run the unit project.
3. Swap `account/actions.ts`; delete the private resolver. Add `account/actions.test.ts` (spoof → failure + no Supabase call; happy path → `updateUser` with allowlisted `emailRedirectTo`).
4. Pre-prod config gate (§17): confirm `serverActions.allowedOrigins` (proxied deployments) and the Supabase redirect allowlist before relying on the new behaviour in any non-local env.
5. `grep` gate (criterion 3); typecheck + lint + full test run from `apps/web`.

## 15. Risks & mitigations

- **Behaviour change — `changeEmail` can now throw.** Mitigation: fail-closed catch returns the existing public message; prod has the env set; dev keeps the empty-allowlist→localhost path. The removed `http://localhost:3000` default was only reachable when `host` was absent — impossible for a real server action.
- **Proxy-trust parity.** The server-action `directOrigin` comes from the `host` header; behind a single proxy (e.g. Vercel) `host` is already the public host, so the trusted-proxy branch may not engage — identical to the route path, where `requestUrl.origin` is also the public host. The allowlist remains the authority.
- **IPv6 localhost scheme guess** is best-effort (dev only) and fails safe (a wrong scheme still passes `isLocalOrigin` by hostname).
- **`ReadonlyHeaders` typing** — see §10; narrow to `Pick<Headers, "get">` if needed.

## 16. Key decisions (post-review)

1. **Direct origin is `host`-only; `x-forwarded-proto` never feeds it.** The direct origin is the value checked against `AUTH_TRUSTED_PROXY_ORIGINS` to decide whether forwarded headers are honoured. Building it from a forwarded header would let an attacker influence the trust gate (e.g. `x-forwarded-proto: https` flipping a host into a trusted-proxy match). The route resolver derives its direct origin from `requestUrl.origin` and only looks at forwarded headers afterwards; `getHostOrigin` now mirrors that exactly. Scheme is derived deterministically from the host (local → `http`, else `https`); a wrong guess fails closed against the allowlist. *(Resolves review Finding 1; makes the §4 localhost/`http` row hold unconditionally.)*

2. **The allowlist parser stays private; extension-route reuse is deferred.** Exposing `parseAllowlistedOrigins` would have added a third public export (breaking the "exactly two entry points" contract) and funnelled a non-auth env var (`NEXUS_EXTENSION_REDIRECT_ORIGINS`) through an auth-callback owner — cross-policy coupling across a layer boundary. If reuse is wanted, the correct shape is a policy-neutral parser in `lib/security`, owned by neither caller. *(Resolves Finding 2; see §9-C.)*

3. **An action-level test is required, not just resolver tests.** The acceptance bar ("no malicious Supabase side effect") lives at the action, but the existing account UI test mocks `changeEmailAction`, so it cannot observe the resolver→Supabase path. A dedicated `actions.test.ts` asserts the fail-closed guard *and* that `createClient`/`updateUser` are never reached on a spoof. *(Resolves Finding 3.)*

## 17. Rollout prerequisites & verification

- **Next.js Server Action origin gate (blocking, runs before our resolver).** `next/dist/.../action-handler.js` compares `Origin` host against `parseHostHeader` (`x-forwarded-host` ?? `host`); on mismatch, unless the origin is in `serverActions.allowedOrigins`, it logs *"… does not match `origin` header … Aborting the action"* and returns **500 `Invalid Server Actions request`** — the action body never runs. `apps/web/next.config.ts:23` currently sets only `serverActions.bodySizeLimit`.
  - **RESOLVED 2026-06-03 — `allowedOrigins` is NOT needed in the current topology.** `deployment.md` is authoritative: the Next.js frontend/BFF runs **on Vercel** at the custom domain `https://nexus.nielseriknandal.com`; Caddy reverse-proxies only the *separate* FastAPI domain (`api:8000` → `api.nexus.nielseriknandal.com`), never the app. There is **no `vercel.json`/`vercel.ts` rewrite** and no proxy rewriting the app host, and **no `AUTH_TRUSTED_PROXY_ORIGINS`** is configured (single-origin allowlist). On Vercel the platform sets `host`/`x-forwarded-host` to the same custom domain the browser used, so `Origin` host == `x-forwarded-host` and the gate passes. `.vercel.app` preview/alias URLs likewise match (browser `Origin` and forwarded host are the same `.vercel.app` host). Next 15.5.18.
  - **Re-evaluate (add `serverActions.allowedOrigins: [...]`) only if** a host-rewriting layer is later placed in front of the Vercel app such that the host Next observes diverges from the browser origin (e.g. an edge/CDN that rewrites `Host` without setting `x-forwarded-host`, or serving actions under a domain Vercel doesn't report as the forwarded host). None of these hold today.
- **Supabase hosted Auth redirect allowlist (blocking for the email link).** The constructed `…/auth/callback` origin must also be in the Supabase project's **Auth → URL Configuration → Redirect URLs** list, or Supabase rejects the email-change confirmation link regardless of our app-side allowlist. **Action item:** verify the Supabase redirect allowlist contains every origin in `AUTH_ALLOWED_REDIRECT_ORIGINS` (prod: `https://nexus.nielseriknandal.com` per `deployment.md`).
- **Smoke coverage gap.** `deploy/smoke/auth-smoke.sh` (`make smoke`, `deployment.md:280`) verifies auth *health* (login redirect, expired-cookie redirect, public 200, BFF 401, `/docs` blocked, API health) — it does **not** exercise redirect-URL *construction*. **Action item:** add a post-deploy check that triggers the email-change flow (or asserts the constructed `emailRedirectTo`) and confirms the link targets an allowlisted origin, so a misconfigured `AUTH_ALLOWED_REDIRECT_ORIGINS` / `allowedOrigins` / Supabase list is caught at deploy, not by a user. *(Resolves Findings 4–5.)*
