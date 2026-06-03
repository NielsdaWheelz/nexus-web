# CSP & Security-Headers Hardening — Cutover Spec

Status: **implemented** (pending full `make test-csp` on a real stack + clean-tree
`make build`/`make check`) · Owner: web · Type: hard cutover (no legacy, no fallbacks,
no back-compat) · Created: 2026-06-01

> Implementation note (2026-06-01): all §12 files landed. Verified locally: `test:unit`
> 34/34 (incl. CSP-Evaluator no-HIGH gate), eslint clean, Playwright collects all CSP
> specs, `actionlint` clean, `bash -n`/`make -n` clean. Not yet run: the full
> stack-backed `make test-csp` (CI `test-e2e-csp`) and a clean-tree `make build`.
>
> Review note (2026-06-01, post-implementation): a multi-agent review found and fixed a
> **critical nonce-propagation defect** — the CSP was set only on the *response*, but Next
> reads the script nonce from the *request-side* CSP header, so every framework script was
> blocked under enforcement (masked by `E2E_DISABLE_CSP=1`). Fixed by forwarding the policy
> on the request headers via `updateSession` (see §10). Also fixed: `playwright.csp.config.ts`
> had drifted from the base config (missing `NEXUS_KEY_ENCRYPTION_KEY`/rate-limit/file-env →
> seeding would crash; `make api` → `make api-e2e`); `/api/csp-report` gained `runtime`/
> `dynamic` exports + a pre-buffer body cap + assertion-free parsing; YouTube embed origins
> centralized to `lib/security/youtube.ts` (was duplicated across csp.ts/headers.ts/the embed
> component); `R2_S3_API_ORIGIN`/`E2E_DISABLE_CSP` added to `.env.example`. Deferred
> (documented, not defects): `style-src` elem/attr split, dropping `img-src data:`, an
> SSE-open e2e assertion, the oracle `images.remotePatterns` gap (pre-existing, non-CSP).

## 1. Summary

The Next.js app ships a nonce + `strict-dynamic` `script-src` that is directionally
right, but the rest of the Content-Security-Policy is incomplete: there is **no
`default-src`**, and no `connect-src` / `img-src` / `media-src` / `manifest-src`.
Because absent fetch directives fall back to `default-src` and there is none, those
resource classes are **completely unrestricted** — a compromised/injected script can
exfiltrate anywhere. The current strict `script-src` is doing more work than it should.
There is also no CSP violation reporting, the policy is hand-inlined in `middleware.ts`,
the enforced policy is **not gated in CI** (the default E2E suite runs with
`E2E_DISABLE_CSP=1`; a dedicated CSP Playwright profile and YouTube CSP spec exist but
are not wired into Make/CI), and the modern companion headers (`Permissions-Policy`,
COOP, CORP) are absent.

This cutover makes the frontend document CSP fetch-directive-complete and self-contained,
centralizes the Next.js document/static-header surface behind one `lib/security` module,
adds a same-origin violation report sink, and makes CI enforce the real policy. It is a
**hard cutover**: the inlined policy and the legacy `X-Frame-Options` header are deleted,
not kept alongside.

The original trigger — the Firefox console line *"Ignoring 'self' within script-src:
'strict-dynamic' specified"* — is resolved as a **side effect**: `'self'` (a CSP2-era
fallback that modern browsers ignore under `strict-dynamic`) is removed from `script-src`
in line with the no-fallback philosophy. The warning was cosmetic; the substantive work is
closing the unrestricted fetch directives and enforcing the policy in tests.

## 2. Context (audit findings, grounded)

| # | Finding | Evidence |
|---|---|---|
| A | No `default-src`; `connect-src`/`img-src`/`media-src`/`manifest-src` absent → unrestricted | `apps/web/src/middleware.ts:25-40` |
| B | No CSP reporting (`report-to`/`Reporting-Endpoints`/`report-uri`); no Report-Only | repo-wide: none |
| C | Policy hand-inlined in middleware; no single source of truth; partial unit assertions | `middleware.ts:25-40`, `apps/web/src/lib/supabase/middleware.test.ts:277-323` |
| D | Enforced CSP not gated in CI; default E2E ignores CSP specs and runs with `E2E_DISABLE_CSP=1`; CSP profile exists but is not Make/CI-wired | `e2e/playwright.config.ts:31,83`, `e2e/playwright.csp.config.ts:51-73`, `e2e/package.json:7`, `.github/workflows/ci.yml:300-301`, `Makefile:221,397-404` |
| E | `Permissions-Policy`, COOP, CORP absent at every layer | `next.config.ts:28-48`, `deploy/hetzner/Caddyfile:8-12` |
| F | `X-Frame-Options` (legacy) duplicates `frame-ancestors 'none'` intent | `next.config.ts:34-35` vs `middleware.ts:35` |

Runtime facts that constrain the policy (derived from code, not guessed):

- **Frontend = Vercel; backend = Hetzner/Caddy.** Current production is
  `https://nexus.nielseriknandal.com` → `https://api.nexus.nielseriknandal.com`
  (`deployment.md:17-18`); the example envs use `api.example.com`
  (`deploy/vercel/sync-env.sh`, `deploy/env/env-prod-frontend.example:4`,
  `deploy/env/env-prod-backend.example:5`). `FASTAPI_BASE_URL` is a server-side env var
  available in middleware.
- **SSE is cross-origin to the FastAPI host**: browser opens fetch-based event streams to
  `stream_base_url` (`apps/web/src/lib/api/streamToken.ts`, `sse-stream.ts`, `sse-client.ts`).
  `STREAM_BASE_URL` shares the `FASTAPI_BASE_URL` origin in the current/reference deploys
  (`deploy/env/env-prod-backend.example:28` = `https://api.example.com`), but this is
  convention rather than a code-enforced invariant today.
- **Signed storage URLs are browser-visible**: file upload does a direct `PUT` to
  `init.data.upload_url` (`apps/web/src/lib/media/ingestionClient.ts:84`), and PDF.js loads
  the original file from the signed URL returned by `/api/media/{id}/file`
  (`apps/web/src/components/PdfReader.tsx:304,1056-1062`). These URLs are generated from
  the R2/S3 endpoint (`python/nexus/storage/client.py:126-163`). → `connect-src` needs the
  configured presigned-storage origin(s), unless upload/download are later proxied
  same-origin. The frontend must get those as derived origin-only, non-secret config; do
  **not** expose backend storage env names or credentials to Vercel.
- **Browser never talks to Supabase directly** — only `createServerClient` exists
  (`lib/supabase/route-handler.ts`, `lib/auth/refresh.ts`); no `createBrowserClient`,
  no realtime/websocket. → Supabase is **out of `connect-src`**.
- **Images are same-origin proxied** via `/api/media/image?url=…` for UI helpers
  (`lib/media/imageProxy.ts:1-2`, `next.config.ts:8-14`). Backend-sanitized HTML currently
  rewrites remote images to `/media/image?url=…` (`python/nexus/services/sanitize_html.py:84`),
  which is also same-origin but should be route-audited during implementation. →
  `img-src 'self'` (+ `data:` for `next/image` placeholders/icons).
- **Podcast audio plays from arbitrary third-party HTTPS origins**: `<audio src={track.stream_url}>`
  (`components/GlobalPlayerFooter.tsx:714`) where `stream_url` is the podcast's external
  enclosure URL (`python/nexus/services/playback_source.py:23-35`). → `media-src` needs `https:`.
- **Fonts are self-hosted** by `next/font` at build (`app/layout.tsx`, `app/(oracle)/layout.tsx`).
  → `font-src 'self'`, no Google origin.
- **PDF.js worker is a same-origin file** `/pdfjs/pdf.worker.min.mjs`
  (`components/pdfReaderRuntime.ts:83`); no `blob:` workers, no `new Worker`/`createObjectURL`.
  → `worker-src 'self'`.
- **No `next/dynamic`** anywhere → the Next 15.5.18 un-nonced `next/dynamic` preload bug
  (fixed only in 15.6/16) does **not** apply. Constraint: do not add client-side `next/dynamic`
  on a CSP route until on Next ≥ 15.6.
- **Asset-specific CSP already exists outside the document policy**: FastAPI serves SVG/EPUB
  assets with their own restrictive CSP, and the BFF allowlist forwards
  `content-security-policy` for those responses (`python/nexus/api/routes/media.py:644`,
  `apps/web/src/lib/api/proxy.ts:68-80`). This cutover does not move those asset policies
  into `lib/security`.

## 3. Goals

1. Every resource class the browser can fetch is constrained by an explicit directive
   backed by a `default-src 'self'` backstop. No unrestricted fetch class remains.
2. The frontend document/static security-header surface is defined **once**, as data, in
   `lib/security`, and consumed by two frontend application points (per-request middleware
   for the dynamic CSP; `next.config` for the static suite). No inlined frontend policy
   strings anywhere else.
3. CSP violations are reported to a same-origin sink and logged.
4. CI **enforces** the real policy: a full-page zero-violation smoke test across the major
   routes, a structured full-policy unit assertion, and a CSP-Evaluator assertion.
5. Add the modern companion headers (`Permissions-Policy`, COOP, CORP) without breaking
   the YouTube embed, podcast audio, image proxy, SSE, PDF rendering, clipboard actions,
   extension connect/capture flows, or Android WebView auth flows.
6. Resolve the `'self'`/`strict-dynamic` warning by removing the dead fallback token.

## 4. Non-goals

- **Trusted Types** (`require-trusted-types-for`/`trusted-types`). Deferred: one sink
  (`HtmlRenderer.tsx`) renders server-pre-sanitized HTML by deliberate design; full TT
  enforcement is over-engineering for a single-user prototype. Revisit trigger: multi-user,
  more `dangerouslySetInnerHTML`/`eval`/dynamic-`script.src` sinks, or untrusted content.
- **COEP / full cross-origin isolation** (`require-corp`). High breakage, no
  `SharedArrayBuffer`/high-res-timer need. Explicitly out.
- **Same-origin audio proxy.** Proxying podcast audio through `/api/media/audio` to achieve
  `media-src 'self'` is a possible future hardening but a non-trivial streaming/range
  backend feature — out of scope; `media-src https:` is the correct value for now.
- **Production Report-Only header.** The hard cutover ships the **enforced** policy only.
  Report-Only is a one-time local bring-up technique (see §13), not a shipped dual-header.
- **Flipping the default E2E suite to CSP-on.** `E2E_DISABLE_CSP=1` stays for the default
  suite (stable auth bootstrapping); new coverage comes from the dedicated CSP profile.
- **Consolidating the `no-store` auth-route pattern** (`auth/{password,handoff,refresh}/route.ts`).
  Observed adjacent duplication, but it's cache-control on cookie-bearing responses, a
  different concern from the security-header suite. Flagged for separate cleanup (§11).
- **Backend document CSP.** API serves JSON/SSE, not HTML; document CSP is N/A there.
  Existing FastAPI asset-specific CSP stays owned by the asset routes and BFF proxy allowlist.
- **HSTS preload.** The backend already sends one-year HSTS with `includeSubDomains`
  (`deploy/hetzner/Caddyfile:9`). Adding `preload` is a separate operational opt-in that
  requires checking the submitted hostname and every subdomain; it is not part of this hard
  cutover.

## 5. Key decisions (with rationale)

1. **`default-src 'self'` is mandatory** and every fetch class is named explicitly even when
   it equals the backstop — clarity + defense against future drift.
2. **Drop `'self'` from `script-src`.** Under `strict-dynamic`, modern (CSP3) browsers ignore
   `'self'`/host-sources; it is a CSP2 compatibility fallback, not modern-browser hardening.
   Per the no-fallback philosophy and our controlled modern client, remove it. New
   `script-src`: `'nonce-{NONCE}' 'strict-dynamic'` (+ `'unsafe-eval'` only when `isDev`).
   This eliminates the Firefox warning. The CSP E2E gate is Chromium-only, so Android WebView
   and Safari/WebKit smoke checks remain release verification.
3. **`connect-src 'self' {CONNECT_ORIGINS}`**, where `{CONNECT_ORIGINS}` includes the origin
   of `process.env.FASTAPI_BASE_URL` plus the shared origin-only `R2_S3_API_ORIGIN` for
   presigned storage. Required for SSE and signed storage. Current deploys keep
   `STREAM_BASE_URL` on the same origin as `FASTAPI_BASE_URL`; if they diverge, add a
   dedicated named stream-origin env contract and `connect-src` must list both.
   Missing/malformed `FASTAPI_BASE_URL` or `R2_S3_API_ORIGIN` in production is a
   configuration error, not a silent `connect-src 'self'` fallback.
4. **`media-src 'self' https:`.** Podcast enclosures are unbounded third-party HTTPS origins;
   `https:` is a domain-driven functional requirement, not a fallback. `'self'` covers dev
   `http://localhost` and any same-origin media.
5. **`img-src 'self' data:`.** Proxied images are same-origin; `data:` is required for
   `next/image` blur placeholders and inline icons.
6. **`style-src 'self' 'unsafe-inline'` stays.** React emits inline `style` attributes and Next
   emits inline styles; nonce-only styles are impractical with React. This is a functional
   requirement, not a back-compat fallback. Style-based injection is far lower severity than
   script, and `script-src` remains strict. Documented as an accepted residual.
7. **`base-uri 'none'`** (was `'self'`). The app uses no `<base>`; `'none'` blocks
   `<base>`-injection outright. Gated by the smoke test.
8. **Delete `X-Frame-Options`, but only after CSP cannot be disabled in production.**
   Clickjacking is owned solely by `frame-ancestors 'none'` (modern, already enforced).
   `X-Frame-Options` is its legacy predecessor and a second source of truth — removed per the
   no-legacy rule. The implementation must make `E2E_DISABLE_CSP=1` impossible in production
   (`NEXUS_ENV=prod`; `NODE_ENV` is the build axis and is irrelevant here) before deleting XFO.
9. **Add `Permissions-Policy` (explicit allowlists)**, delegating the features the app and
   YouTube embed actually use. The top-level app keeps same-origin clipboard write for copy
   actions; the YouTube origins receive the features in the iframe `allow=""` list
   (`accelerometer`, `autoplay`, `clipboard-write`, `encrypted-media`, `gyroscope`,
   `picture-in-picture`, `web-share`, and fullscreen via `allowFullScreen`). The existing
   "embed + click-to-seek works under CSP" E2E is the acceptance gate against over-restriction.
10. **Add `COOP: same-origin` + `CORP: same-origin`.** No `window.open`/popup OAuth exists
    (OAuth is server-side redirects; Android uses `nexus://` deeplinks/custom tabs), so the
    stricter `same-origin` COOP is safe. If a popup OAuth flow is later added, relax to
    `same-origin-allow-popups`.
11. **One source of truth, two application points for frontend document/static headers.**
    Per-request nonce CSP **must** live in middleware (cannot be static); static headers
    **must** cover all paths incl. `_next/static` (so `nosniff` protects served JS), which
    only `next.config.headers()` does. The split is principled; both sides import their
    values from `lib/security`.
12. **Same-origin report sink** `/api/csp-report` (Next route handler), referenced by an
    absolute URL built from the request origin in `Reporting-Endpoints` and by relative
    `report-uri /api/csp-report` for older reporter compatibility. Avoids CORS; needs no auth
    (`/api/*` already passes through middleware ungated, `lib/supabase/middleware.ts:98-104`).
13. **Enforced-only ship; CI is the validation gate.** No production Report-Only straddle.
    The CI zero-violation smoke test under enforcement is the decisive gate; the prod report
    sink catches the long tail.

## 6. Architecture & final state

```
apps/web/
├─ src/lib/security/              ← NEW: single source of truth
│  ├─ csp.ts                      ← CSP directives (data) + generateNonce + builders
│  ├─ headers.ts                  ← STATIC_SECURITY_HEADERS (suite) + Permissions-Policy
│  └─ csp.test.ts                 ← structured full-policy assertions + CSP-Evaluator check
│
├─ src/middleware.ts              ← MODIFIED: import builders; set CSP + Reporting-Endpoints;
│                                    generateNonce() replaces Buffer/createRandomId nonce
├─ src/lib/supabase/middleware.ts ← MODIFIED: updateSession forwards the CSP on the request
│                                    headers (3rd arg) so Next reads the nonce; sets x-nonce
├─ src/lib/supabase/middleware.test.ts ← MODIFIED: wiring assertions only (header set, nonce
│                                    match, disable flag); script-src 'self' assertion removed
├─ next.config.ts                 ← MODIFIED: headers() returns STATIC_SECURITY_HEADERS;
│                                    X-Frame-Options deleted
├─ src/app/api/csp-report/route.ts ← NEW: POST report sink (204; logs; no auth; no persistence)
└─ package.json                   ← MODIFIED: + csp_evaluator (devDependency for csp.test.ts)

e2e/
├─ playwright.csp.config.ts       ← MODIFIED: only runs *.csp.spec.ts for chromium-csp, or the
│                                    Makefile target passes that filter explicitly
├─ tests/youtube-transcript.csp.spec.ts ← EXISTING: keep embed/seek/runtime frame-src coverage
└─ tests/security-headers.csp.spec.ts ← NEW: full-page zero-violation smoke across routes
                                         + static-header assertions (uses chromium-csp profile)

.github/workflows/ci.yml          ← MODIFIED: + test-e2e-csp job (runs the CSP profile)
Makefile                          ← MODIFIED: + test-csp target
```

Request-time data flow (hardened policy):

```
middleware(request)
  → nonce = generateNonce()
  → csp = shouldDisableCspForE2E()        // test-only; forbidden in production
        ? null
        : buildContentSecurityPolicy({ nonce, isDev, isHttpsRequest, connectOrigins })
            // connectOrigins = getConnectOriginsFromEnv()
            // isHttpsRequest  = (req "x-forwarded-proto" === "https") || nextUrl.protocol === "https:"
  → response = updateSession(request, nonce, csp)
        // sets x-nonce AND (when csp) the request-side Content-Security-Policy header
  → if csp:
      response.headers.set("Content-Security-Policy", csp)        // browser enforcement
      response.headers.set("Reporting-Endpoints", `csp="${origin}/api/csp-report"`)
Next.js reads the REQUEST Content-Security-Policy header (parseRequestHeaders → script-src
  nonce), NOT x-nonce → stamps framework/RSC scripts → strict-dynamic propagates to chunks
next.config.headers() applies STATIC_SECURITY_HEADERS to /:path*  (all responses)
```

## 7. Capability contract / API design (`lib/security`)

`csp.ts` — dependency-free, runtime-agnostic (no Node-only APIs; edge + node safe):

```ts
/** CSP source of truth. Values are directive → source-list (script-src's nonce slot is
 *  templated at build time). This object is what tests and CSP-Evaluator assert against. */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>>;

/** 16 random bytes, base64. Uses Web Crypto + btoa (no Buffer). Fresh per request. */
export function generateNonce(): string;

export interface CspBuildOptions {
  nonce: string;
  isDev: boolean;          // adds 'unsafe-eval' to script-src (React dev stacks / HMR)
  isHttpsRequest: boolean; // adds upgrade-insecure-requests only for HTTPS document requests
  connectOrigins: readonly string[]; // FastAPI, stream if distinct, presigned storage
  devWebSocketOrigins?: readonly string[]; // dev-only HMR websocket origins
}

/** Serialize CSP_DIRECTIVES into a header string with the nonce/dev/connect values applied.
 *  Always includes `report-to csp` and `report-uri /api/csp-report`. Deterministic ordering. */
export function buildContentSecurityPolicy(opts: CspBuildOptions): string;

/** External browser-connect origins from frontend env. Throws in production if FASTAPI_BASE_URL
 *  or R2_S3_API_ORIGIN are unset/invalid. R2_S3_API_ORIGIN is origin-only, non-secret
 *  shared config for presigned storage. */
export function getConnectOriginsFromEnv(): readonly string[];

/** Test-only CSP bypass; returns false in production even if E2E_DISABLE_CSP=1. */
export function shouldDisableCspForE2E(): boolean;

export const CSP_REPORT_PATH = "/api/csp-report";
/** Builds the Reporting-Endpoints header value (absolute, same-origin). */
export function buildReportingEndpoints(origin: string): string; // → `csp="${origin}${CSP_REPORT_PATH}"`
```

`headers.ts` — dependency-free (importable from `next.config.ts` via relative path):

```ts
export interface SecurityHeader { key: string; value: string; }
/** Static suite applied to all paths by next.config.headers(). No per-request data. */
export const STATIC_SECURITY_HEADERS: readonly SecurityHeader[];
```

Guarantees / invariants the contract enforces:
- `script-src` never contains `'self'`, `'unsafe-inline'`, or host/scheme sources; only
  `'nonce-…'`, `'strict-dynamic'`, and `'unsafe-eval'` **iff** `isDev`.
- `getConnectOriginsFromEnv` accepts origins only (no path/query/fragment), dedupes them, and
  rejects non-HTTPS origins outside localhost/test mode.
- `buildContentSecurityPolicy` is pure and deterministic given its options.
- `generateNonce` produces a base64 value with ≥128 bits entropy, never empty.
- `upgrade-insecure-requests` is emitted for HTTPS document requests only, so local
  `http://localhost` CSP tests do not rewrite `http://localhost:8000` SSE.
- `isHttpsRequest` is derived in middleware from the `x-forwarded-proto` header (the Vercel/
  edge TLS terminator), with `nextUrl.protocol` as fallback; localhost/test resolve to HTTP.
- Dev-only websocket origins are included only under `NODE_ENV=development`; the dedicated
  CSP E2E profile uses `next start`, so it should not need them.

## 8. Target policy (exact)

**Enforced CSP** (production HTTPS document response; `isDev` adds only `'unsafe-eval'`
to `script-src`; local HTTP responses omit `upgrade-insecure-requests`):

```
default-src 'self';
script-src 'nonce-{NONCE}' 'strict-dynamic';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self' {CONNECT_ORIGINS};
media-src 'self' https:;
worker-src 'self';
manifest-src 'self';
frame-src https://www.youtube.com https://www.youtube-nocookie.com;
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
report-to csp;
report-uri /api/csp-report
```

**Companion response header** (middleware, absolute same-origin URL):

```
Reporting-Endpoints: csp="https://{APP_ORIGIN}/api/csp-report"
```

**Static suite** (`STATIC_SECURITY_HEADERS` → `next.config.headers()`, `/:path*`):

```
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy:
  accelerometer=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"),
  autoplay=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"),
  clipboard-write=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"),
  encrypted-media=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"),
  fullscreen=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"),
  gyroscope=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"),
  picture-in-picture=(self "https://www.youtube.com" "https://www.youtube-nocookie.com"),
  web-share=("https://www.youtube.com" "https://www.youtube-nocookie.com"),
  camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(),
  bluetooth=(), hid=(), midi=(), magnetometer=()
```

(`Permissions-Policy` is emitted as a single comma-joined line. The YouTube allowlist
delegates the features the embed's `allow=""` requests; same-origin `clipboard-write` stays
enabled for app copy actions. Features the app and embed do not use are explicitly denied.)

## 9. Directive derivation (why each value)

| Directive | Value | Driver |
|---|---|---|
| `default-src` | `'self'` | backstop for any unlisted fetch class |
| `script-src` | `'nonce-{N}' 'strict-dynamic'` (+`'unsafe-eval'` dev) | nonce flow; no host fallback (decision 2) |
| `style-src` | `'self' 'unsafe-inline'` | React inline styles (decision 6) |
| `img-src` | `'self' data:` | proxied images + next/image placeholders/icons |
| `font-src` | `'self'` | next/font self-hosts |
| `connect-src` | `'self' {CONNECT_ORIGINS}` | cross-origin SSE + signed upload/PDF-download storage origins; dev adds HMR websocket origins |
| `media-src` | `'self' https:` | arbitrary podcast enclosure origins |
| `worker-src` | `'self'` | same-origin pdf.js worker |
| `manifest-src` | `'self'` | `app/manifest.ts` |
| `frame-src` | youtube + youtube-nocookie | only embedded iframe |
| `object-src` | `'none'` | no plugins |
| `base-uri` | `'none'` | no `<base>`; block injection |
| `form-action` | `'self'` | forms post same-origin (deeplink login is `<a>`, not a form) |
| `frame-ancestors` | `'none'` | sole clickjacking owner |
| `upgrade-insecure-requests` | — | force HTTPS subresources on HTTPS document responses; omitted locally |
| `report-to` | `csp` | modern reports → `/api/csp-report` via `Reporting-Endpoints` |
| `report-uri` | `/api/csp-report` | legacy reporter fallback; ignored by browsers that honor `report-to` |

## 10. Composition with other systems

- **Next.js nonce propagation:** Next reads the script nonce from the *request-side*
  `Content-Security-Policy` header (`app-render` `parseRequestHeaders` → `script-src`'s
  `'nonce-…'`), **not** from `x-nonce`. So `updateSession` forwards the full policy on the
  request headers (alongside `x-nonce`, which only the app reads); Next then stamps the
  framework + RSC flight scripts, and `strict-dynamic` propagates trust to `_next/static`
  chunks (which the matcher correctly excludes from middleware). Setting the CSP only on the
  *response* would leave Next's scripts un-nonced and `strict-dynamic` would block them all.
  No `next/dynamic` ⇒ no preload-nonce gap.
- **Vercel:** serves the app and may add its own HSTS at the edge; our app headers compose
  with (do not conflict with) it. Verify the live response on securityheaders.com post-cutover.
- **Caddy (backend):** unchanged by this cutover. Keep current one-year HSTS with
  `includeSubDomains`; evaluate preload later only as an explicit operational decision for
  the submitted hostname.
- **FastAPI SSE:** browser → API-origin event streams require both `connect-src`
  (this spec) and backend `STREAM_CORS_ORIGINS` (currently the frontend origins). Both
  must allow; the CSP smoke test must actually open chat/media/oracle direct streams, not only
  visit pages.
- **R2/S3 signed storage:** browser direct upload and PDF.js signed-download fetches require
  the storage endpoint origin in `connect-src`. Configure that with shared
  `R2_S3_API_ORIGIN` as an origin-only value; keep R2 credentials and bucket names out of
  Vercel. The CSP smoke test must exercise one upload and one PDF open, or assert the
  configured storage origin through focused unit coverage. Addressing is path-style
  (`storage/client.py:120`), so this is a single origin
  (`https://<account>.r2.cloudflarestorage.com`), not per-bucket subdomains; PDF.js range/GET
  fetches run in its same-origin worker, which inherits the document `connect-src`.
- **Image proxy / podcast audio / YouTube:** `img-src 'self'` / `media-src https:` /
  `frame-src` + `Permissions-Policy` delegation respectively (§8–§9). Implementation should
  reconcile or explicitly accept the `/api/media/image` vs `/media/image` same-origin proxy
  paths.
- **Report sink:** `/api/csp-report` is public (ungated `/api/*`), returns 204, logs each
  report; CSP applies to it harmlessly.
- **Extension / share flows:** `/extension/connect/start` and `/share` are top-level route
  handlers (no iframe/postMessage/window.open), so `COOP`, `CORP: same-origin`, and
  `frame-ancestors 'none'` do not affect them.

## 11. Consolidation / dedup (the "reuse/centralize" ask)

- **Primary consolidation:** the frontend document/static security-header surface is currently split between
  `middleware.ts` (inlined CSP) and `next.config.ts` (3 inlined headers), with partial,
  duplicated assertions in `middleware.test.ts`. This cutover centralizes that frontend
  surface into `lib/security` as data, consumed by both application points and asserted once.
  The CSP becomes a structured object (`CSP_DIRECTIVES`) so the unit test and the
  CSP-Evaluator assertion check the *source of truth* directly instead of re-parsing strings.
- **Nonce generation** moves from an ad-hoc `Buffer.from(createRandomId()).toString("base64")`
  in `middleware.ts:14` to `generateNonce()` in `lib/security/csp.ts` (runtime-agnostic).
- **Accepted minor duplication:** `e2e/tests/*.csp.spec.ts` keeps its own tiny
  `parseCspDirectives` (cross-package boundary; trivial). The structured source of truth
  removes the need to re-parse in *unit* tests.
- **Out-of-scope duplication (flagged):** `Cache-Control: no-store` is set ad hoc in
  `auth/password/route.ts:21`, `auth/handoff/route.ts:27`, and via a local `noStore()` helper
  in `auth/refresh/route.ts`. Promote one shared `noStore(response)` util — **separate
  cleanup**, different concern (cache vs. security headers).

## 12. Files

**Created**
- `apps/web/src/lib/security/csp.ts`
- `apps/web/src/lib/security/headers.ts`
- `apps/web/src/lib/security/csp.test.ts`
- `apps/web/src/app/api/csp-report/route.ts`
- `e2e/tests/security-headers.csp.spec.ts`

**Modified**
- `apps/web/src/middleware.ts` — use `generateNonce`/`buildContentSecurityPolicy`/
  `getConnectOriginsFromEnv`; set `Reporting-Endpoints`; delete inlined CSP + `Buffer`
  nonce; make `E2E_DISABLE_CSP` test-only.
- `apps/web/next.config.ts` — `headers()` returns `STATIC_SECURITY_HEADERS`; delete inlined
  trio + `X-Frame-Options`.
- `apps/web/src/lib/supabase/middleware.test.ts` — CSP block asserts wiring only (header set,
  nonce matches `x-nonce`, `E2E_DISABLE_CSP` omits header); remove the `^script-src 'self'`
  assertion; policy-content assertions live in `csp.test.ts`.
- `apps/web/package.json` — add `csp_evaluator` devDependency.
- `apps/web/bun.lock` — lock the `csp_evaluator` dependency.
- `deploy/env/env-prod.example` — add shared `R2_S3_API_ORIGIN` with the presigned-storage
  origin.
- `deploy/vercel/sync-env.sh` — require/allow `R2_S3_API_ORIGIN` while keeping R2
  credentials and bucket names forbidden.
- `e2e/playwright.csp.config.ts` — either restrict `chromium-csp` to `*.csp.spec.ts` or leave
  filtering to the root Makefile target; set `R2_S3_API_ORIGIN` in its `webServer` env to
  the test storage origin (local MinIO/S3) so the upload/PDF smoke passes under the
  enforced `connect-src`.
- `.github/workflows/ci.yml` — add `test-e2e-csp` job (depends on `test-front`).
- `Makefile` — add `test-csp` target (wraps the existing CSP Playwright profile with
  Supabase/test services and a CSP-spec filter).
- `docs/rules/testing_standards.md` — update the canonical CSP command if `make test-csp`
  becomes the preferred root entrypoint.

**Deleted:** none (the cutover edits in place; no parallel old/new paths remain).

## 13. Rollout / cutover plan (hard cutover)

1. Add `lib/security/{csp,headers}.ts` + `csp.test.ts`; wire `middleware.ts` and
   `next.config.ts`; delete inlined policy + `X-Frame-Options` after production cannot disable
   CSP. (Single PR.)
2. Add `R2_S3_API_ORIGIN` to the shared env example and Vercel sync allowlist; populate it
   in production with the presigned-storage origin.
3. Add `/api/csp-report/route.ts`.
4. Add the `security-headers.csp.spec.ts` smoke test; add the `test-csp` Makefile target and
   the `test-e2e-csp` CI job; add the `csp_evaluator` assertion.
   - Reuse the existing `e2e/playwright.csp.config.ts`, `e2e/package.json` `test:csp`
     script, `auth.csp.setup.ts`, and `youtube-transcript.csp.spec.ts`.
   - Ensure `make test-csp` runs only CSP specs, e.g.
     `cd e2e && bun run test:csp -- tests/*.csp.spec.ts --project=chromium-csp`, unless the
     CSP config itself gets `testMatch`.
   - Set `R2_S3_API_ORIGIN` in the CSP test env to the local storage origin so the
     upload + PDF smoke can fetch signed URLs under enforced `connect-src` (the parser allows
     localhost HTTP in test mode).
5. **Local bring-up validation:** run `make test-csp`. The smoke test runs against the
   *enforced* policy; any blocked resource fails a route and names the directive — fix
   `CSP_DIRECTIVES` and re-run. (This is the derivation loop; it replaces a prod Report-Only
   window. If a directive is genuinely unknowable locally, temporarily rename the header to
   `Content-Security-Policy-Report-Only` in a scratch branch to observe — never merged.)
6. Merge once `make check`, `make test-csp`, and the CSP-Evaluator assertion are green.
7. Deploy and verify the live frontend on securityheaders.com / MDN Observatory. Leave HSTS
   preload as a separate explicit operations decision; this cutover does not change Caddy.

## 14. Acceptance criteria

- [ ] `Content-Security-Policy` on a document response equals the §8 policy (with a real
      nonce and the resolved `connect-src` origins); contains `default-src`, `connect-src`,
      `img-src`, `media-src`, `manifest-src`, `base-uri 'none'`, `report-to csp`, and
      `report-uri /api/csp-report`.
- [ ] Production shared env includes `R2_S3_API_ORIGIN` with the origin-only
      presigned-storage origin; parser rejects paths, queries, fragments, and non-HTTPS
      origins outside localhost/test mode.
- [ ] `script-src` contains `'nonce-…'` and `'strict-dynamic'` and **no** `'self'`,
      `'unsafe-inline'`, or host/scheme source; `'unsafe-eval'` present only when `isDev`.
- [ ] `Reporting-Endpoints: csp="…/api/csp-report"` present on document responses.
- [ ] `upgrade-insecure-requests` is present on HTTPS document responses and absent in the
      local HTTP CSP profile.
- [ ] `STATIC_SECURITY_HEADERS` present on all responses; `X-Frame-Options` **absent**;
      `Permissions-Policy`, `COOP: same-origin`, `CORP: same-origin` present.
- [ ] No browser console CSP warning about `'self'` under `strict-dynamic`.
- [ ] `csp.test.ts`: full structured policy assertion passes; CSP-Evaluator reports **no HIGH
      findings** (documented accepted items: `style-src 'unsafe-inline'`, `media-src https:`,
      deprecated `report-uri`).
- [ ] `middleware.test.ts`: header set + nonce matches `x-nonce` + `E2E_DISABLE_CSP` omits it
      only outside production; production env ignores or rejects the disable flag.
- [ ] `security-headers.csp.spec.ts`: **zero** `securitypolicyviolation` events on each of
      `/libraries`, a reader/document page, a PDF-backed page, chat with an opened direct SSE
      stream, media-processing direct SSE, oracle direct SSE, search, podcasts, one upload
      flow using the signed storage `PUT`, and a YouTube media page, under enforced CSP.
- [ ] PDF smoke observes successful dynamic imports of `/pdfjs/pdf.mjs` and
      `/pdfjs/pdf_viewer.mjs`, use of `/pdfjs/pdf.worker.min.mjs`, and the signed file URL
      fetch/range requests under `connect-src`.
- [ ] Existing `youtube-transcript.csp.spec.ts` (embed + click-to-seek) still passes →
      `Permissions-Policy` did not over-restrict; podcast `<audio>` plays under `media-src`.
- [ ] `POST /api/csp-report` returns 204 and logs a structured entry for both
      `application/reports+json` (`report-to`) and `application/csp-report` (`report-uri`);
      malformed body → still 204.
- [ ] `test-e2e-csp` runs in CI and gates merges; `make test-csp` works locally.
- [ ] `make check` and `make build` pass; `/api/csp-report` reachable without auth.

## 15. Rules / invariants (post-cutover)

1. **One source of truth.** The Next document CSP and static suite live only in
   `lib/security`. Never inline those policy strings in middleware, config, or a test.
   FastAPI asset-specific CSP remains a separate route-owned exception.
2. **`script-src` stays strict.** Only `'nonce-…'`, `'strict-dynamic'`, and dev-only
   `'unsafe-eval'`. Never add `'unsafe-inline'`, `'self'`, or a host/scheme source to it.
3. **New external origin ⇒ explicit directive + smoke-test route.** Adding a new fetch
   target requires the matching directive in `CSP_DIRECTIVES` and a route in the
   zero-violation smoke test. No silent reliance on `default-src`.
4. **Clickjacking is `frame-ancestors` only.** Do not reintroduce `X-Frame-Options`.
5. **Reporting stays wired.** `report-to csp`, `report-uri /api/csp-report`, and
   `/api/csp-report` remain in production.
6. **No client `next/dynamic` on CSP routes** until Next ≥ 15.6 (preload-nonce fix).
7. **CI enforces the real policy.** The `test-e2e-csp` job and the CSP-Evaluator assertion are
   required gates; `E2E_DISABLE_CSP` is only for the default (non-CSP) suite.

## 16. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `base-uri 'none'` or a missing directive breaks a page | low | zero-violation smoke test across all major routes gates merge |
| `Permissions-Policy` over-restricts the YouTube embed | med | embed + click-to-seek E2E is the acceptance gate; delegate requested features |
| `media-src` too tight for a podcast CDN | low | `https:` allows any HTTPS enclosure; smoke-test a podcast play |
| PDF.js module/worker/signed URL loading violates CSP | med | PDF page smoke covers `/pdfjs/pdf.mjs`, `/pdfjs/pdf_viewer.mjs`, `/pdfjs/pdf.worker.min.mjs`, and signed storage requests |
| `next.config.ts` cannot import from `./src/lib/security/headers` | low | Next 15 TS-config supports relative TS imports; if not, the only fallback is to inline the array in config while keeping CSP in the module (verify in step 1) |
| `connect-src` wrong if `STREAM_BASE_URL` ≠ `FASTAPI_BASE_URL` origin | low | Direct SSE smoke test fails loudly; list both origins if they diverge |
| `connect-src` misses presigned storage origin | med | upload + PDF signed-download smoke test gates merge; storage origins are explicit config |
| Upload/PDF smoke fails because the test storage origin isn't in `connect-src` | med | set `R2_S3_API_ORIGIN` in the CSP test env to the local MinIO/S3 origin (parser allows localhost HTTP in test mode) |
| Backend storage env leaks into frontend config | low | expose only shared public `R2_S3_API_ORIGIN`; keep R2 credentials and bucket names forbidden in Vercel sync |
| HSTS preload is confused with normal HSTS | med | no preload change in this cutover; document as separate opt-in ops work |
