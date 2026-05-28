# Reader Async Cutover

## Problem

The media reader's client-side async loading layer wedges intermittently. EPUBs (and the same code path for web articles and PDFs) sometimes get stuck on "Loading EPUB navigation…" with no error and no recovery. Reload sometimes fixes it; reload sometimes breaks a working state. Symptoms are non-deterministic in production.

Root cause is the same shape in multiple places: hand-rolled `useEffect` + `let cancelled = false` + `useRef`-based single-flight guard, with **asymmetric reset between the success-bailout and the catch-bailout** of the in-flight promise. When the effect re-fires while a fetch is in flight (which it does every 3 s while document processing polling is active), the cleanup sets `cancelled = true`, the in-flight fetch later resolves successfully, the success-path bails on the cancel check without resetting the guard ref, and the next effect run hits the guard and short-circuits forever. The UI stays on the loading message; no error, no retry, no observability.

Confirmed instances of the same bug shape:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:1299-1391` (EPUB navigation).
- `apps/web/src/lib/useLazyFetchOnOpen.ts:47-69` (`loadedRef.current` only set in `.then()`; reset on `cacheKey` change but not on rejection — wedges after first error per `cacheKey`).
- A weaker variant at `MediaPaneBody.tsx:1527-1569` (web-article navigation): no guard ref, but same `cancelled` + setState shape; survives because there is no guard to wedge — but it shares the systemic missing-primitive problem (no `AbortSignal`, no retry, no observability).

Surrounding causes the fix must also address:

- `apiFetch` (`apps/web/src/lib/api/client.ts:127-140`) does not accept `AbortSignal`. There is no way for any caller to use the standard platform cancellation primitive. All callers invent their own `let cancelled` flag.
- The async state across the reader is modeled as scattered `useState` triplets (`data`, `loading`, `error`) that admit impossible combinations like `{ loading: false, data: null, error: null }` — the wedged state.
- The 3-second `processing_status` poll (`apps/web/src/lib/useIntervalPoll.ts` + `MediaPaneBody.tsx:1230`) is what fires the race trigger by replacing the `media` object identity inside the EPUB effect's deps array. It also violates `docs/rules/polling.md` ("Avoid polling by default. Prefer push- or event-driven designs.").
- First paint is always a client loading state because `page.tsx` is `"use client"` and does no server-side prefetch. Even when the client load works, the user sees "Loading EPUB navigation…" for the duration of one network round trip.

## Target Behavior

Opening a media pane satisfies these invariants:

1. **First paint shows content, not a loading state**, for any media whose `processing_status` is in `{ready_for_reading, embedding, ready}` at the time the request hits the server. The navigation payload is prefetched in the server component and hydrated into the client.
2. **Async state on the client is a single discriminated union** per resource: `{ status: "idle" | "loading" | "ready" | "error", … }`. The impossible state (`loading: false, data: null, error: null`) is unrepresentable.
3. **Every in-flight fetch is cancellable via `AbortSignal`.** When the owning component unmounts or its `cacheKey` changes, the controller aborts; aborted fetches never call `setState` and never poison any cache.
4. **Re-entry is always safe.** There is no module-level or component-ref-level "in-flight" flag that can be left in the wrong state by a cancellation. A re-render that changes `cacheKey` always either reuses a successful cached value or starts a fresh attempt.
5. **Transient failures retry automatically.** Network errors and `5xx` get exponential-backoff retry, capped. `4xx` does not retry. Retry exhaustion produces an `error` status with an explicit `retry()` callback that the UI can wire to a button.
6. **`processing_status` updates arrive via push**, not poll. The client opens a single SSE subscription per open media pane; the server emits updates as the worker advances the state machine, and the stream self-terminates on a terminal status (`ready`, `failed`).
7. **The "Loading EPUB navigation…" string is removed.** With the above, that state cannot occur on first paint, and on subsequent client-side revalidation it is bounded by retry budget; the UI shows the cached navigation while a revalidation runs.

## Architecture

Four layers, each owning one concern. Lower layers do not know about higher layers.

```
L3  SSE push for processing_status (server emits → client subscribes once)
L2  Server Component prefetch of navigation + media in page.tsx
L1  useAsyncResource<T> — one hook owning AbortController, single-flight,
    retry-with-backoff, discriminated-union state. Replaces every hand-
    rolled effect+cancel-flag+ref-guard pattern in the reader.
L0  apiFetch accepts AbortSignal; ApiError carries enough info to drive retry
    decisions (status code, code string).
```

L0 is the platform primitive. L1 is the only client async loader anywhere in the reader. L2 makes the first paint instant. L3 removes the bug trigger entirely by deleting the poll.

### How it composes with existing systems

- **`apiFetch`** stays the only browser-side HTTP entry point; it gains an `AbortSignal` and nothing else. All 127 call sites across 48 files continue to work; the new ones in `useAsyncResource` pass a signal.
- **`useIntervalPoll`** is kept as a generic utility but **no longer used for `processing_status`** (SSE replaces it). Other callers (metadata retry polling) are out of scope and continue to use it.
- **`useLazyFetchOnOpen`** is reimplemented as a thin wrapper over `useAsyncResource` (it adds the `open` gate; everything else is the hook). Same external API; same call sites; bug instance #2 is closed.
- **`useReaderResumeState`** is unchanged. It's already correct; it is the in-repo reference for "ref-based state lifecycle done right" and stays as is.
- **`proxy.ts`** gains a server-side counterpart `callFastAPI<T>()` for use from React Server Components. The cookie-based session refresh logic in `proxy.ts:331-369` is extracted into a shared helper both call paths use.
- **SSE infrastructure**: the chat SSE pattern in `apps/web/src/lib/api/sse/` and `python/nexus/api/routes/stream.py` is the model. The media SSE endpoint uses the same `text/event-stream` framing, the same `stream_tokens` auth, the same `StreamingResponse` server pattern, the same `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` headers, and the same server-side DB poll under the hood (same `justify-polling` rationale: the API process has no push channel to the worker).
- **Resume / restore state machine** (`beginRestoreSession`, `updateRestorePhase`, `settleRestoreSession`, `restoreSessionIdRef`) stays. Its job is sequencing the post-navigation restore steps; that is a separate concern from "fetch navigation." After the cutover it consumes the navigation payload that `useAsyncResource` returns as `status: "ready"`, instead of being entangled with the fetch lifecycle.

## Capability Contract

### L0 — `apiFetch` with `AbortSignal`

`apps/web/src/lib/api/client.ts`

```ts
export interface ApiFetchOptions extends RequestInit {
  signal?: AbortSignal;
}

export async function apiFetch<T>(
  path: string,
  options?: ApiFetchOptions,
): Promise<T>;
```

`AbortError` (thrown by `fetch` when the signal aborts) is **not** wrapped in `ApiError`. It propagates as a native `DOMException` with `name === "AbortError"`. Consumers use `isAbortError(err)` from `@/lib/errors` (already exists, used in `proxy.ts:29`) — never `isApiError`.

### L1 — `useAsyncResource<T>`

`apps/web/src/lib/useAsyncResource.ts`

```ts
export type AsyncResource<T> =
  | { status: "idle" }
  | { status: "loading"; attempt: number }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError; attempt: number; retry: () => void };

export interface UseAsyncResourceArgs<T> {
  /** Stable string identity. Changing this invalidates the in-flight request
   *  and starts a fresh attempt. Pass null to keep the resource idle. */
  cacheKey: string | null;
  /** Async loader. Receives an AbortSignal that aborts on unmount, cacheKey
   *  change, or manual retry. */
  load: (signal: AbortSignal) => Promise<T>;
  /** Optional initial value, used when the parent has prefetched the resource
   *  (e.g. a Server Component). If provided, status starts as "ready". */
  initialData?: T;
  /** Retry policy. Defaults: 2 retries, base 250ms, factor 2, jitter ±25%,
   *  cap 2000ms. Only network errors and 5xx are retried. */
  retry?: RetryPolicy;
}

export interface RetryPolicy {
  maxAttempts: number;          // including the first attempt
  baseDelayMs: number;
  factor: number;
  jitter: number;               // fraction of delay, 0..1
  capMs: number;
  /** Predicate; if false, error is final. Default: retry on network errors
   *  (no ApiError instance) and ApiError where status >= 500. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

export function useAsyncResource<T>(
  args: UseAsyncResourceArgs<T>,
): AsyncResource<T>;
```

Behavior guarantees the hook must enforce:

- **No setState after abort.** Every state transition is guarded by `if (signal.aborted) return` after the `await` resolves or throws.
- **Single-flight per `cacheKey`.** Same render: one inflight controller. New render with same `cacheKey`: no new fetch. New render with different `cacheKey`: previous controller aborts, new attempt starts.
- **`initialData` short-circuit.** If provided and `cacheKey` non-null, first render returns `{status: "ready", data: initialData}` and no fetch starts. A subsequent `cacheKey` change starts a normal fetch.
- **`retry` resets attempt counter to 1.** The returned `retry()` aborts any in-flight retry-delay and starts a fresh attempt; idempotent under repeated calls.
- **Discriminated union is the only state.** No separate booleans, no separate refs visible to the caller.

### L2 — Server Component prefetch helper

`apps/web/src/lib/api/server.ts`

```ts
/**
 * Server-side equivalent of apiFetch. Reads the Supabase session from
 * cookies(), refreshes if needed, calls FastAPI with the bearer token, and
 * parses the response with the same ApiError semantics as the browser path.
 *
 * Server Component / Route Handler use only — throws if called in browser.
 */
export async function callFastAPI<T>(
  path: string,
  init?: RequestInit,
): Promise<T>;
```

Shared with `proxy.ts` via an extracted `apps/web/src/lib/api/internal/forward.ts` module that owns: bearer-token resolution, request-id propagation, cookie-refresh, header allow/block lists, response parsing. Both `proxyToFastAPI()` (route-handler proxy) and `callFastAPI()` (server-component direct) are thin wrappers over it.

### L3 — `useMediaProcessingStatus(mediaId)`

`apps/web/src/lib/media/useMediaProcessingStatus.ts`

```ts
export interface MediaProcessingStatusEvent {
  processing_status: ProcessingStatus;
  last_error_code: string | null;
  capabilities: MediaCapabilities | null;
  transcript_state: TranscriptState | null;
  transcript_coverage: TranscriptCoverage | null;
  failure_stage: FailureStage | null;
  updated_at: string;
}

/** Subscribes to /api/media/{id}/events while the component is mounted.
 *  Returns the latest server snapshot (or null until first event). Stream
 *  self-terminates when status reaches a final state (ready, failed). */
export function useMediaProcessingStatus(
  mediaId: string | null,
  initialState: MediaProcessingStatusEvent | null,
): MediaProcessingStatusEvent | null;
```

Initial state seeded from the server component prefetch; SSE only opens for non-terminal initial states.

## API Design — SSE endpoint

`GET /media/{media_id}/events` on FastAPI. The browser opens the stream **directly** against FastAPI via `sseClientDirect` (`apps/web/src/lib/api/sse-client.ts`) — no `/api/*` proxy. Per the carve-out in `docs/rules/layers.md:24-26`, streaming SSE is the one client-side product call that bypasses the BFF; same pattern chat uses.

FastAPI implementation in a new `python/nexus/api/routes/media_events.py` mounted under the existing API router. Auth via `stream_token`: the client calls `POST /api/stream-token` to mint a single-use short-lived token, then opens the stream against `${stream_base_url}/media/{id}/events` with that token (identical to the chat SSE auth path).

Events emitted, framed per `apps/web/src/lib/api/sse/events.ts` rules:

| Event | When | Data |
|---|---|---|
| `state` | On stream open with current snapshot; on every change thereafter | `MediaProcessingStatusEvent` |
| `done` | When `processing_status ∈ {ready, failed}` | `{ final: MediaProcessingStatusEvent }` |
| (keepalive comment) | Every 15s of idle | `: keepalive` |

Server-side cadence: the FastAPI handler polls the DB every 1.0s (`justify-polling`: identical rationale to chat SSE — the API process has no push channel to the worker). Stream idle TTL is 60s; client reconnects with `Last-Event-ID` carrying the last `updated_at`. The handler self-terminates after emitting `done` and closes the stream cleanly.

Client implementation: `apps/web/src/lib/media/useMediaProcessingStatus.ts` opens one fetch-based SSE reader (`sseClientDirect`) per mounted media pane, reconnects on transport errors with backoff, never opens for `null` mediaId, closes on unmount. The chat-SSE event parsers in `apps/web/src/lib/api/sse/` are the model for the strongly-typed payload parsing.

## Rules

R1. **One async primitive in the reader.** `useAsyncResource` is the only way to model client-side async state inside a media pane. No new `let cancelled = false` + `useEffect` patterns are permitted; reviewers reject them on sight.

R2. **`AbortSignal` is mandatory** for any `apiFetch` call whose lifetime is bounded by component or hook lifecycle. Fire-and-forget calls (e.g. saving a position on unmount) may omit it; these are the only exceptions and they must be commented as such.

R3. **No guard refs for fetch single-flighting.** Cancellation and de-duplication are properties of `AbortController` and `cacheKey`. Any `*ResolvedRef`, `*LoadedRef`, `*InFlightRef`, `*InitializedRef` pattern outside the hook's own implementation is a defect.

R4. **No polling for server-driven state when SSE exists.** `processing_status` and any future media-row column the worker mutates is consumed via `useMediaProcessingStatus`. New polls require `justify-polling` referencing why SSE cannot serve the use case (e.g. background tab — but EventSource handles that natively).

R5. **Discriminated unions for all async UI state.** A media pane never holds `loading: boolean` and `data: T | null` as separate `useState`s. The `AsyncResource<T>` shape is the contract; UI branches on `status`.

R6. **First paint is server-rendered for `?processing_status ∈ {ready_for_reading, embedding, ready}`.** Media that is still extracting/pending degrades to a client-side `useAsyncResource` that polls the processing-status SSE (not navigation) until readable.

R7. **No retry inside loaders; retry lives in the hook.** Loader functions are pure: call `apiFetch`, parse, return or throw. They do not loop, sleep, or `try`/`catch` to swallow errors.

R8. **Errors propagate as `ApiError` or `AbortError`.** Loaders neither swallow nor re-wrap. The hook decides retry vs. terminal; the UI decides display.

## Files

### New

- `apps/web/src/lib/useAsyncResource.ts` — the hook.
- `apps/web/src/lib/useAsyncResource.test.tsx` — Vitest, must cover the cancel-during-success race specifically.
- `apps/web/src/lib/api/internal/forward.ts` — extracted shared forwarder (used by both `proxy.ts` and the new server.ts).
- `apps/web/src/lib/api/server.ts` — `callFastAPI<T>` for Server Components.
- `apps/web/src/lib/media/useMediaProcessingStatus.ts` — SSE subscriber hook.
- `apps/web/src/lib/media/useMediaProcessingStatus.test.tsx` — Vitest.
- `apps/web/src/lib/media/processingStatusEvents.ts` — parsers for media SSE events (mirrors `apps/web/src/lib/api/sse/events.ts` structure).
- `python/nexus/api/routes/media_events.py` — FastAPI SSE handler.
- `python/tests/test_media_events.py` — backend test.

### Modified

- `apps/web/src/lib/api/client.ts` — accept `AbortSignal`; thread through `fetch`.
- `apps/web/src/lib/useLazyFetchOnOpen.ts` — reimplemented over `useAsyncResource`; same external API.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`:
  - Remove `initialEpubRestoreResolvedRef`, `restoreSessionIdRef`-as-fetch-guard, the 13-dep EPUB-loading `useEffect` (lines 1299-1405), and the equivalent web-article `useEffect` (lines 1527-1569). Replace with `useAsyncResource` calls keyed on `media.id`.
  - Remove `useIntervalPoll` for document processing (line 1230). Replace with `useMediaProcessingStatus(media?.id, initialProcessingStatus)`. Derive the same booleans (`isReadableStatus`, `shouldPollDocumentProcessing` becomes `isProcessingTerminal`) from the SSE-driven snapshot.
  - Accept new `initialMedia` and `initialNavigation` props from the server component; seed `useAsyncResource` `initialData` from them.
  - Remove `pollDocumentProcessing`, `refreshDocumentProcessingState`, `documentProcessingPollEnabled`.
  - Replace `setMedia(nextMedia)` from the poll callback with the SSE hook's returned snapshot (consumed via `useMediaProcessingStatus` → merge into local `media` via a `useMemo` over `initialMedia + statusSnapshot`).
  - The line-3361 branch returning `"Loading EPUB navigation…"` is deleted. The new render path either has `navigationResource.status === "ready"` (server-prefetched or client-loaded) or `"error"` (shows `error.message` with a Retry button bound to `navigationResource.retry`). The intermediate `"loading"` state is shown only on a `cacheKey` change after first paint (e.g. switching media), and uses the same skeleton that other panes use.
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx` — converted to async Server Component; `await`s `callFastAPI` for media metadata + navigation; passes as props.
- `apps/web/src/lib/api/proxy.ts` — `proxyToFastAPI` reimplemented over `forward.ts`. No behavior change for callers; just deduplicates with `callFastAPI`.
- `apps/web/src/lib/media/readerNavigation.ts` — exports a `loadReaderNavigation(id, signal)` standalone function that both the server prefetch and the client `useAsyncResource` call.
- `python/nexus/api/routes/__init__.py` — register the new media-events router.

### Deleted

- The "Loading EPUB navigation…" string (and its loading branch).
- `initialEpubRestoreResolvedRef` and any other `*ResolvedRef` / `*LoadedRef` / `*InitializedRef` used as a fetch single-flight guard inside MediaPaneBody.
- The `documentProcessingPollEnabled` + `DOCUMENT_PROCESSING_POLL_INTERVAL_MS` poll setup for `processing_status` (the constant and the `useIntervalPoll` call). Constant deleted; the metadata-retry poll (separate concern, separate cadence, different terminal logic) is left in place and out of scope.
- The catch-block fallback `setWebSections([])` / `setWebToc([])` in the web-article effect that masked errors as empty TOCs. The hook reports errors as `status: "error"` and the UI renders an error message; empty-array-as-error is gone.

## Key Decisions

D1. **Custom hook, not TanStack Query / SWR.** Matches the repo's DIY convention (`useReaderResumeState`, `useIntervalPoll`, `useLazyFetchOnOpen`). 80 LoC vs. ~30KB dependency. The hook's surface is intentionally narrower than TanStack — no global cache, no mutation primitives — because the reader does not need them. If a future feature needs cross-component cache, revisit.

D2. **`cacheKey` as opaque string, not an object.** Forces callers to be explicit about identity. Eliminates referential-equality pitfalls and keeps the hook stable under polling that replaces parent state object identity.

D3. **Retry policy lives in the hook, not in `apiFetch`.** Retry is a property of the consumption pattern (component lifecycle, debounce, idempotency), not of the transport. `apiFetch` stays one round trip.

D4. **No global cache.** Cross-component sharing is not a current requirement. Each `useAsyncResource` instance owns its own data. The Server Component prefetch covers the "same data needed on first paint by N components" case via prop drilling.

D5. **Server Components own first-paint data.** Page.tsx becomes `async`. The "first visible state is a spinner" antipattern is removed. This also gives us strong cacheability headers when we want them.

D6. **SSE for `processing_status`, server-side DB poll under the hood.** Push from client's perspective; pulls from worker tables on the server. Same architectural compromise the chat SSE made (`stream.py:26-31`), same `justify-polling` comment carried over. Moves the poll out of the browser entirely.

D7. **One stream per media pane, not one per status field.** The SSE event payload carries the full snapshot the client cares about (processing_status, capabilities, transcript_state, …). Granular per-field streams would multiply connections; bundling is the right tradeoff.

D8. **Stream auth via existing `stream_token`.** Reuse, do not invent. The chat SSE auth path is the model: client `POST /api/stream-token` → opens `EventSource` with `Authorization` (via `EventSource` polyfill that supports headers, or via query-param if we standardize on that — match chat's existing choice exactly).

D9. **AbortError is not an ApiError.** Native `DOMException` propagates unchanged. The hook recognizes it and treats it as "not a failure, just a cancellation." Loaders that wrap `apiFetch` must not catch and re-throw `AbortError`.

D10. **No fallback to client-fetch when server prefetch fails.** If `callFastAPI` throws in the Server Component, the page renders an error boundary — not a "client tries to fetch anyway." Hard cutover: one source of truth for first paint, with an explicit error path.

D11. **Restore state machine stays.** `beginRestoreSession`/`updateRestorePhase`/`settleRestoreSession` are for post-navigation restore sequencing (resolving → opening_target → settled), which is a separate concern from "fetch the navigation payload." After cutover, the restore machine reads from `navigationResource.data` when status flips to `"ready"`; before that, restore is `idle`.

D12. **No EPUB-specific code in the hook.** `useAsyncResource` is generic. The EPUB-specific orchestration stays in `MediaPaneBody`, but with one effect (`if (navigationResource.status === "ready") setupRestore(...)`) rather than the current 13-dep tangle.

## Non-Goals

- Not introducing a global query cache (TanStack/SWR-style). Not introducing optimistic mutations infrastructure. Both are future features if a use case emerges; not needed for this fix.
- Not changing the metadata retry polling (separate poll, separate cadence, different terminal logic; out of scope).
- Not changing the chat SSE pattern or any chat infrastructure. The chat path is the reference; we copy from it but do not modify it.
- Not changing PDF binary loading inside `PdfReader.tsx` (`loadPdfJs`, `loadPdfJsViewer`). Navigation/section loading is in `MediaPaneBody` and that is what the cutover replaces.
- Not adding Postgres `NOTIFY/LISTEN` or Redis pub/sub. Server-side DB poll is acceptable (matches chat); revisit only if connection count becomes a problem.
- Not changing the URL synchronization rules from `docs/reader-implementation.md`. `?loc` continues to drive the restore machine; that is not part of this cutover.
- Not changing route or auth shapes. The new SSE endpoint reuses `stream_token`; no new auth surface.

## Scope / Phasing

Hard cutover applies to the patterns, not the merge order. The implementation lands in this order so each phase is independently green:

**Phase 1 — Foundation (L0 + L1).** Land `apiFetch` signal support, `useAsyncResource`, and its tests. No call-site changes yet. Tests cover: success, cancel-before-resolve, cancel-during-resolve (the exact race that wedges today), retry on 5xx, no-retry on 4xx, retry exhaustion → `error` status + working `retry()`.

**Phase 2 — Callers (L1 applied).** Refactor `useLazyFetchOnOpen` over `useAsyncResource` (kills bug instance #2). Refactor EPUB navigation effect (kills bug instance #1). Refactor web-article navigation effect. Stabilize `MediaPaneBody` effect deps to `(media.id, media.processing_status, media.kind)` where applicable.

**Phase 3 — Server prefetch (L2).** Extract `forward.ts`. Add `callFastAPI`. Convert `page.tsx` to async Server Component. Wire `initialMedia` + `initialNavigation` props. Delete the "Loading EPUB navigation…" branch and the first-paint client spinner.

**Phase 4 — SSE (L3).** Add `python/nexus/api/routes/media_events.py`. Add `useMediaProcessingStatus` (direct SSE via `sseClientDirect`, authed with `stream_token`) and its parsers. Replace the `useIntervalPoll` for processing status in `MediaPaneBody`. Delete `DOCUMENT_PROCESSING_POLL_INTERVAL_MS` and `pollDocumentProcessing` / `refreshDocumentProcessingState`.

**Phase 5 — Verification.** Typecheck, full Vitest, full pytest, e2e suite, dev server smoke test of the previously-broken EPUB load (the Hyperion Cantos epub in the repo root is a known reproduction case for large EPUBs).

## Hard Cutover

No compatibility layer. No feature flag. No "old path runs if hook fails." Each phase lands as one commit (small phases) or coordinated commits within a single branch (Phase 4 spans frontend + backend). PRs cannot be partially-merged: the EPUB effect refactor and the `useLazyFetchOnOpen` refactor go together with their tests.

After Phase 5, none of the following exist in the codebase:

- `let cancelled = false` followed by `useEffect` body that calls `apiFetch` inside a media pane (or its descendants).
- `*ResolvedRef` / `*LoadedRef` / `*InFlightRef` / `*InitializedRef` used as a fetch single-flight guard.
- Any `useState<T | null>(null)` + sibling `useState<boolean>(false)` + sibling `useState<string | null>(null)` triple modeling an async resource.
- The string `"Loading EPUB navigation..."`.
- A poll for `processing_status` from the browser.
- A `"use client"` directive in `apps/web/src/app/(authenticated)/media/[id]/page.tsx`.
- Calls to `useIntervalPoll` whose `onPoll` reads media metadata to detect `processing_status` transitions.

Reviewers reject PRs that reintroduce any of these patterns.

## Acceptance Criteria

A1. Opening a media pane for an EPUB whose `processing_status ∈ {ready_for_reading, embedding, ready}` renders the first chapter heading and TOC on first paint, with no client-side loading state.

A2. Reproduction case: the existing intermittent wedge no longer reproduces. With React 19 StrictMode double-invoke enabled, with throttled network, and with simulated processing-status state changes occurring during the navigation fetch, the EPUB always reaches `status: "ready"` or `status: "error"` — never stays in `"loading"`.

A3. When the navigation fetch fails with a 5xx, the UI shows the error message and a Retry button. Clicking Retry restarts the load and succeeds when the server recovers, without a page reload.

A4. When the navigation fetch fails with a 4xx (e.g. `E_MEDIA_NOT_READY`), the UI shows the matching message and does **not** retry automatically (4xx are user-facing, not transient).

A5. `useLazyFetchOnOpen`-backed disclosures recover after a failure: closing and reopening triggers a fresh fetch instead of permanently displaying the stale error.

A6. The browser opens one `EventSource` per mounted media pane (visible in Network tab). No `GET /api/media/{id}` requests fire on a 3-second cadence.

A7. Hard-reload of a working media pane preserves the working state (server prefetch + SSE re-subscribe). Multiple reloads in a row never wedge the loader.

A8. No `useEffect` inside `MediaPaneBody` has more than 6 entries in its dependency array. (Indirect: deps balloon when a single effect owns multiple concerns; this enforces the separation.)

A9. Vitest suite includes a test that simulates the cancel-during-success race against `useAsyncResource` and asserts the next render starts a fresh attempt rather than wedging.

A10. e2e EPUB tests pass without flakes. The reload-during-restore scenario added in `e2e/tests/epub.spec.ts:824` continues to pass. A new e2e test asserts: open EPUB → server returns 504 once → client shows error UI → click Retry → success.

A11. Type check passes. Full Vitest passes. Full pytest passes. Playwright EPUB suite passes locally with the in-repo Hyperion Cantos EPUB.

A12. Grep verification: zero matches for the deleted-pattern strings listed in **Hard Cutover** above.
