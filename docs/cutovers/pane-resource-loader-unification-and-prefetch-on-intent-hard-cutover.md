# Pane Resource Loader Unification + Prefetch-on-Intent — Hard Cutover

**Status:** SPEC — all open questions resolved (see §Resolved decisions). Ready to build.
**Author:** Niels (SME spec)
**Date:** 2026-06-19
**Type:** Hard cutover. No legacy code, no fallback resource-load path, no backward-compat shims, no dual definitions of "how a pane loads its primary resource." If two modules answer *"fetch and compose this pane's first-paint data,"* one of them stops answering it.

---

## North Star

Today a pane's primary first-paint resource is defined **twice** — once server-side in `paneServerLoaders.ts` (seed the hydration cache) and once client-side inside each `*PaneBody`'s `useResource({ load })` (fetch on mount). The two are kept in sync by hand and by a shape-only AC-4 render test. They have already **structurally diverged**: the media pane gates initial fragments with two *different* predicates (a server allowlist vs a client denylist). They happen to agree on every media kind that can exist today (see §The media-gate trap), so it is a latent trap rather than a live bug — but it is the canonical symptom of the real problem: **two definitions of one thing, drifting independently, that only a render test loosely couples.**

The missing concept is a **single, transport-agnostic pane resource loader** — one definition per pane, consumed by every caller that needs that pane's data: the **server bootstrap seed**, the **client mount** (`useResource`), and a **new third caller, prefetch-on-intent**. Inject the transport (`callFastAPI` on the server, `apiFetch` on the client); the fetch-and-compose body is written once. Server-seed ≡ client-load ≡ prefetch then holds *by construction*, not by a hand-maintained mirror.

Prefetch-on-intent closes the real asymmetry this work surfaced: the server bootstrap seeds pane data only on hard load / reload / deep-link (~10% of opens); ~90% of opens are mid-session client navigations (launcher, in-pane links) that mount cold. A client pane mount **cannot** RSC-prefetch (the router is a client pane system under nonce-CSP; PPR is rejected). So instead of server-prefetching the mount, we **warm the client resource cache the instant the user signals intent** (hover / focus / keyboard-active on a launcher row or an in-pane link), using the same loader and the same cache `useResource` already consumes.

---

## SME thesis

A subject-matter expert would not "rename the optional props and document the asymmetry," nor "add a BFF route at registry mount." Both describe a world that doesn't exist: `MediaPaneBody` is prop-less, `media/[id]/page.tsx` is `return null`, and the BFF route (`/api/media/[id]`) the client already calls *is* the only registry-mount data path. The expert names the actual missing contract — **one loader, three callers, one cache** — and notices that building it (a) makes seed-vs-fetch drift structurally impossible, and (b) yields prefetch-on-intent as a near-free third caller.

**The wrong moves are:**
- A separate client "prefetch loader" → a *third* definition of each pane's fetch, tripling the drift surface.
- Making prefetch a general persistent/SWR cache → changes freshness semantics app-wide (re-opens stop refetching); a different, larger decision (non-goal N1).
- Depositing only *settled* prefetch results → reintroduces the prefetch→open double-fetch race and the existing no-dedup gap.
- "Fixing" the media gate by hand-copying one predicate onto the other → resolves today's instance, guarantees tomorrow's.
- Server-prefetching client navigations → impossible under the client pane-router + nonce-CSP; warming the client cache is the correct equivalent.

---

## The media-gate trap (latent, not live — and why unification is still the fix)

Two contradictory predicates gate the media pane's second fetch:

- **Server (shared)** `shouldLoadInitialMediaFragments` (`lib/media/documentReadiness.ts:31`): `(kind === "podcast_episode" || kind === "video") && can_read` — an **allowlist**.
- **Client (local)** `shouldLoadInitialFragments` (`MediaPaneBody.tsx:304`): load for everything **except** epub/pdf/web_article, and for podcast/video require `can_read` — a **denylist**.

They diverge only for kinds outside `{epub, pdf, web_article, podcast_episode, video}`. **That set is empty:** the backend `MediaKind` enum is exactly those five (`python/nexus/db/models.py:89-96`, CHECK `ck_media_kind` at `:1146`); there is no `text`/`audio`/`tweet`/etc. (X ingest emits `web_article`). For all five real kinds the predicates produce identical results, so **no production behaviour differs today**, and deleting the client denylist is behaviour-preserving.

It is nonetheless a real trap, because of a property of the seed path worth stating as an invariant:

> **A server seed that under-loads is not self-healing.** When the server seeds `{ fragments: [] }`, `useResource` starts `ready` and **skips the client's first fetch** (consume-once, `useResource.ts:104`). So the client `load`'s gate never runs on a server-seeded first paint — the seed's gate is authoritative. If a sixth, fragment-rendering kind were added and added only to the client denylist, the allowlist seed would paint it empty with **no client recovery**.

Unifying the loader removes the trap by construction: one gate governs seed, mount, and prefetch, so they cannot disagree per kind. The **canonical predicate is the allowlist** — only `TranscriptContentPanel` (podcast/video) consumes the `fragments` array as first-paint content; epub→`/sections`, pdf→binary, web_article→its own deferred `webFragmentsResource` (`shouldLoadWebArticleFragments`) all render from dedicated loaders, so seeding fragments for any other kind is a fetch with no consumer.

(Two lesser duplications the unification also erases: author's `Array.isArray(works) ? works : []` guard is written inline server-side *and* inside `fetchContributorWorks`; `notes` tolerates a missing `pages` array server-side (`?? []`) but `fetchNotePages` throws client-side.)

---

## Goals

- **G1** — One transport-agnostic loader per prefetchable pane, in one isomorphic registry, consumed by server-seed, client-mount, and client-prefetch. The fetch-and-compose body exists exactly once per pane.
- **G2** — Exactly one media initial-fragments predicate (the allowlist `shouldLoadInitialMediaFragments`). Delete the local `shouldLoadInitialFragments`. Behaviour-preserving for all real kinds.
- **G3** — `useResource`'s server-seed ≡ client-load equality holds **by construction** (same body), not by a hand-maintained mirror + shape test.
- **G4** — Prefetch-on-intent: a single `warmPaneOnIntent(href)` that warms the pane's JS chunk **and** its primary data into the cache `useResource` reads, fired wherever the user signals an imminent open.
- **G5** — No duplicated network fetch for the same `cacheKey` across prefetch + mount (request dedup), and no prefetch→open race.
- **G6** — Freshness semantics unchanged: consume-once. A re-open after the entry is claimed refetches. Prefetch front-runs an *imminent* open; it is not a cache.
- **G7** — Bounded prefetch: hovering many candidates must not leak in-flight fetches or memory.

## Non-goals

- **N1** — Not a persistent / stale-while-revalidate resource cache. Re-opening an item after its pane mounted still refetches. (The "make re-opens instant" option is a separate freshness decision, deferred.)
- **N2** — No RSC/server prefetch on client navigation. Client mounts can't RSC-prefetch under the pane-router + nonce-CSP; warming the client cache is the equivalent.
- **N3** — No new global query library (React Query / SWR). `useResource` stays the one async-resource hook; only its internal claim gains a `pending` branch.
- **N4** — No new BFF routes. Prefetch reuses each descriptor's existing `clientPath` via `apiFetch`.
- **N5** — No data prefetch for non-deterministically-keyed / client-only panes (daily, page, conversation, podcasts/podcastDetail, browse, search, settingsIdentities, settingsLocalVault). Intent still warms their **chunk**; their data stays client-fetched on open (unchanged, deliberate — see the exclusion list inherited from `paneServerLoaders.ts:47-54`).
- **N6** — No change to `useResource`'s public call signature; every existing call site is untouched.
- **N7** — No change to the hover-preview popover behaviour (`ReaderCitation`). Citation-hover warming is explicitly deferred (Resolved decision OQ4).
- **N8** — No full pane-body SSR (still out of scope, per the first-paint cutover N3).

---

## Capability contract (invariants)

- **C1** — For every prefetchable pane there is exactly one `paneResourceLoaders[id]`. The server seed, the client mount, and the client prefetch all call it. `grep` proves no second definition of the fetch/merge survives (R1–R3).
- **C2** — Server-seeded data ≡ client-loaded data ≡ prefetched data for a given `(pane, params)`, because all three run the identical loader body with only the transport injected. The media initial-fragments gate is one predicate, evaluated in one place.
- **C3** — One resource cache holding `ready | pending` entries, **consume-once**: a claim returns and removes the entry. Server bootstrap deposits `ready`; client prefetch deposits `pending` and resolves it to `ready` (or removes on error). `useResource`: `ready` → seed ready + skip fetch; `pending` → seed loading + await the shared promise (no new fetch); miss → fetch as today. A miss is always correctness-safe.
- **C4** — `warmPaneOnIntent(href)` warms the **chunk always** (`preloadPane`) and the **data only when a loader exists** (C1, N5). It is idempotent (a warm for a key already `ready`/`pending` is a no-op) and abortable.
- **C5** — At most one in-flight fetch per `cacheKey`. A `pending` entry deduplicates concurrent prefetch + mount (and concurrent mounts), closing the current "every `useResource` passes a signal, so `apiFetch`'s in-flight coalescing never applies" gap.
- **C6** — Prefetch never changes correctness, only latency. Removing every `warmPaneOnIntent` call leaves behaviour identical (each pane still client-fetches on mount).
- **C7** — Bounded: prefetch entries are tracked in an LRU of size `PREFETCH_CACHE_LIMIT` (16); exceeding it aborts (if pending) and evicts the oldest *prefetch* entry. Server seeds are not LRU-evicted (claimed on first paint).
- **C8** — The loader registry and its bodies import **no transport** (`callFastAPI`/`apiFetch`) and no client-only or server-only module; they are pure composition over `ResourceDescriptor` + pure normalizers. Transport lives only in the two fetcher modules (R5).
- **C9** — Because the gate is shared (C2), a server seed cannot under-load relative to the client for any kind. **Adding any future fragment-rendering media kind requires (a) adding it to the allowlist gate and (b) giving it a dedicated empty-seed recovery loader (the `web_article`/`shouldLoadWebArticleFragments` pattern).** Encoded as a comment on the gate + a guard test.

---

## Architecture & API design

### Key constants

- `PREFETCH_CACHE_LIMIT = 16` — LRU bound on prefetch entries (C7).
- `INTENT_WARM_DEBOUNCE_MS = 70` — debounce for continuous intent signals (pointer hover, keyboard-active row). Discrete focus warms immediately.
- `PREFETCH_OPTS = { timeoutMs: 500 }` — unchanged; the server fetcher's paint-adjacent deadline.

### 1. Transport abstraction — `ResourceFetcher`

```ts
// lib/api/resourceTransport.ts  (isomorphic: types only)
export type ResourceFetcher = <P, T>(descriptor: ResourceDescriptor<P>, params: P) => Promise<T>;
```
```ts
// lib/api/resourceTransport.server.ts   ("server-only")
export const serverResourceFetcher: ResourceFetcher =
  (d, p) => callFastAPI(d.serverPath(p), PREFETCH_OPTS);     // timeout baked in
```
```ts
// lib/api/resourceTransport.client.ts    (client)
export function clientResourceFetcher(signal: AbortSignal): ResourceFetcher {
  return (d, p) => apiFetch(d.clientPath(p), { signal });     // abort baked in
}
```
Both return the parsed envelope verbatim (neither unwraps `{ data }`; every loader does its own `.data`, matching today). `callFastAPI` cancels via `timeoutMs`; `apiFetch` cancels via `signal`. This is the only place server/client transport differs.

### 2. The loader registry — `paneResourceLoaders` (replaces `paneServerLoaders`)

```ts
// lib/panes/paneResourceLoaders.ts   (ISOMORPHIC — no transport import, C8)
export interface PaneResourceLoader {
  cacheKey: (params: RouteParams) => string;                         // the seed/claim key
  load: (fetch: ResourceFetcher, params: RouteParams) => Promise<unknown>;
}

export const paneResourceLoaders: Partial<Record<PaneRouteId, PaneResourceLoader>> = {
  media: {
    cacheKey: (p) => mediaResource.cacheKey({ id: p.id }),
    load: async (fetch, p) => {
      const params = { id: p.id };
      const media = (await fetch<IdParams, { data: MediaHead }>(mediaResource, params)).data;
      const fragments = shouldLoadInitialMediaFragments(media)          // ← the one (allowlist) gate, C2/C9
        ? (await fetch<IdParams, { data: unknown[] }>(mediaFragmentsResource, params)).data
        : [];
      return { media, fragments };
    },
  },
  library, author,      // the 2-fetch merges, once (author folds the works Array.isArray guard)
  note, notes,          // normalizeBlock / pages.map(normalizePageSummary), once
  libraries, conversations, settingsAccount, settingsKeys, settingsBilling,  // trivial single fetch
};
```

- **Composed/normalizing panes** (media, library, author, note, notes) move their full fetch/merge/normalize body here. This is where the duplication dies.
- **Single-fetch panes** (libraries, conversations, settings*) get a trivial loader (`fetch(descriptor, params)`, full envelope) needed by server-seed + prefetch. Their client `*PaneBody` keeps the **default** descriptor load (no `load`), which is byte-identical — no client churn (Resolved decision OQ-scope/D7).
- The registry stays `Partial<Record<…>>`; the deliberate exclusions (N5) have no entry. The header comment documenting *why* each is excluded moves here verbatim.

### 3. Wiring the three callers

```ts
// server seed — bootstrap.server.ts, inside seedPane(href)
const loader = paneResourceLoaders[route.id];
if (!loader) return null;
return { cacheKey: loader.cacheKey(route.params),
         data: await loader.load(serverResourceFetcher, route.params) };
```
```ts
// client mount — MediaPaneBody / LibraryPaneBody / AuthorPaneBody / NotePaneBody / NotesPaneBody
useResource({ descriptor: mediaResource, params: { id },
  load: (params, signal) => paneResourceLoaders.media!.load(clientResourceFetcher(signal), params) });
```
```ts
// client prefetch — paneWarm.ts
cache.prefetch(loader.cacheKey(params), (signal) => loader.load(clientResourceFetcher(signal), params));
```

### 4. The resource cache (generalizes the hydration cache)

`lib/api/hydrationCache.tsx` → `lib/api/resourceCache.tsx`. It now holds both server seeds and client prefetches, so the "Bootstrap/Hydration" name is retired. The store generalizes from `Map<string, unknown>` to `ready | pending` entries and owns consume-once + bounded prefetch:

```ts
type ResourceCacheEntry =
  | { status: "ready";   data: unknown }
  | { status: "pending"; promise: Promise<unknown> };

interface ResourceCache {
  claim(key: string): ResourceCacheEntry | null;                              // consume-once: returns + removes
  prefetch(key: string, run: (signal: AbortSignal) => Promise<unknown>): void; // bounded(16), abortable, idempotent
}
```

- **Wire format unchanged:** `DehydratedResources = Record<string, unknown>` (settled values) still serializes across the RSC boundary. `ResourceCacheProvider` wraps each seeded value into `{ status: "ready", data }`.
- `prefetch(key, run)`: present → no-op (C4). Else insert `{ status: "pending", promise }`; on resolve, *if still present*, replace with `ready`; on reject/abort, remove (never a poisoned entry). Track `key` in the LRU; evict + abort oldest when > `PREFETCH_CACHE_LIMIT` (C7).
- `useResource` change (the only change to the hook): replace the `has`/`get`/`delete` dance with one `claim(cacheKey)` and branch on `.status` — `ready` → current synchronous seed + skip; `pending` → start `loading`, `await entry.promise` (abort-aware), then `ready`, no fetch.

### 5. `warmPaneOnIntent` + intent surface

```ts
// lib/panes/paneWarm.ts
export function usePaneWarm(): (href: string) => void;     // closes over the cache via context, debounced
// warmPaneOnIntent(href):
//   const { id, params } = resolvePaneRouteModel(href); if id === "unsupported" return;
//   preloadPane(id);                                       // chunk — existing, CSP-safe (always)
//   const loader = paneResourceLoaders[id];                // data — only if a loader exists (N5)
//   if (loader) cache.prefetch(loader.cacheKey(params), s => loader.load(clientResourceFetcher(s), params));
```

Wired at the surfaces where intent already lives, reusing existing seams, adding no new dispatch path and no link wrapper:

- **In-pane links — one capture-phase delegate.** `PaneRouteBoundary.tsx` already intercepts every in-pane `<a href>` via `onClickCapture` → `closest("a[href]")`. Add a sibling capture-phase `onMouseOver` + `onFocus` (debounced) → `warmPaneOnIntent(anchor.href)`. Covers ResourceRow / `ResourceActivation` links, prose links, media cards, and anchor-form citations — all in-pane anchors at once, zero per-component change.
- **Launcher rows.** `LauncherRow` / `LauncherList` rows carry their target and an `onHover`→`setActiveId`. Add `onMouseEnter` + `onFocus` → derive the href (`target.href`, or `hrefForResourceActivation(activation)` for `kind:"resource"`) → `warmPaneOnIntent`. Also warm the **keyboard-active** row (the `setActiveId` path, debounced), since arrow-key highlight is intent for the imminent Enter.

`ReaderCitation`'s bespoke `onPointerEnter`/`onFocus` (preview popover) is **not** wired here (N7 / OQ4). All `warmPaneOnIntent` calls are fire-and-forget, debounced, and idempotent; the cache + LRU absorb hover storms.

---

## Slices (hard cutover — all land together, no interim dual paths)

- **S0 — Transport + pure-helper extraction.** Add `resourceTransport.ts` / `.server.ts` / `.client.ts`. **Extract `normalizeBlock` + `normalizePageSummary` (and their types) into a transport-free `lib/notes/normalize.ts`** (required: `notes/api.ts` imports `apiFetch` at module scope, so the isomorphic registry must not import normalizers from it — C8). `notes/api.ts` re-imports from `normalize.ts`. *Acceptance:* fetchers compile on their respective sides; `normalize.ts` and the registry import no transport.
- **S1 — Isomorphic loader registry + server rewire.** Create `paneResourceLoaders.ts` (all 10 loaders, one media gate, the exclusion comment). Rewire `bootstrap.server.ts` `seedPane` to `serverResourceFetcher` + registry. **Delete `paneServerLoaders.ts`.** *Acceptance:* server bootstrap seeds byte-identical data for all five media kinds; migrations/typecheck green.
- **S2 — Client mount rewire + drift deletion.** Composed/normalizing panes (media, library, author, note, notes) consume the registry loader via `clientResourceFetcher(signal)`. **Delete the local `shouldLoadInitialFragments`** (and the inline merges). Route `NotePaneBody` (descriptor overload, dropping the literal `note-block:${blockId}`) and `NotesPaneBody` through the loaders; **delete `fetchNotePages`** (now unused); **keep `fetchNoteBlock`** (still used by `PagePaneBody`). Single-fetch panes unchanged. *Acceptance:* R1–R3 green; client-fetch behaviour unchanged; `useResource` call sites untouched.
- **S3 — Resource cache.** Rename hydration cache → `resourceCache`, generalize to `ready | pending`, move consume-once into `claim`, add bounded `prefetch`. Add the `pending` branch to `useResource`. *Acceptance:* existing AC-4 seed tests pass against the renamed provider; a `pending`-seeded resource resolves with a single fetch.
- **S4 — Prefetch core.** `paneWarm.ts` + `usePaneWarm` (debounced), idempotent + bounded(16) + abortable. *Acceptance:* unit tests for idempotency, dedup (C5), eviction+abort (C7), error→remove, debounce.
- **S5 — Intent wiring.** `PaneRouteBoundary` capture-phase `onMouseOver`/`onFocus`; `LauncherRow`/`LauncherList`/controller hover+focus+active. *Acceptance:* hovering a launcher row / in-pane link warms chunk+data; opening it paints with zero mount fetch; the launcher DOM contract (roles/labels/ids) preserved.
- **S6 — Tests, gates, docs.** Extend AC-4 with: a **gate guard** (all five kinds → server seed gate ≡ client gate, now one function) + the C9 future-kind comment/guard; warm→open hit (zero mount fetch); prefetch dedup; eviction. Add negative gates. Append "Implementation divergences (as built)." *Acceptance:* full unit + browser suites green; negative gates green.

---

## Acceptance criteria

- **AC-1** — One definition: for media/library/author/note/notes the fetch/merge/normalize body exists only in `paneResourceLoaders.ts` (R1–R3).
- **AC-2** — One media predicate: `shouldLoadInitialFragments` (local) is deleted; only `shouldLoadInitialMediaFragments` remains; a guard test asserts it returns the expected value for all five kinds (and documents C9).
- **AC-3** — Seed unchanged: AC-4 hydration tests (media, library, author, notes, libraries) still assert zero mount fetch on a server-seeded pane, with byte-identical seeds.
- **AC-4** — Warm→open hit: after `warmPaneOnIntent(href)` settles, opening that pane mounts cache-hit with **zero** `useResource` fetch (asserted via the real `apiFetch`→`fetch` boundary).
- **AC-5** — Warm-in-flight dedup: if the pane opens while its prefetch is still `pending`, exactly **one** network fetch occurs (the pending promise is awaited, not re-fetched).
- **AC-6** — Bounded: warming 17 distinct hrefs leaves ≤ 16 entries; the evicted one's fetch is aborted.
- **AC-7** — Correctness without prefetch: removing all `warmPaneOnIntent` calls leaves every pane loading on mount (C6) — proven by the unchanged client-fetch tests.
- **AC-8** — Excluded panes: warming a `daily`/`browse`/`search`/`conversation` href warms the chunk but deposits **no** data entry (N5).
- **AC-9** — Freshness: opening a pane, closing it, and re-opening it in-session issues a fresh fetch (consume-once preserved, G6/N1).

## Negative gates (grep — must return zero)

- **R1** — `rg "paneServerLoaders" apps/web/src` → 0 (renamed/removed).
- **R2** — `rg "shouldLoadInitialFragments\b" apps/web/src` → 0 (local denylist gone; only `shouldLoadInitialMediaFragments` survives).
- **R3** — `rg "fragments: \[\]" apps/web/src/app/\(authenticated\)/media` → 0 (the `{media, fragments}` assembly left `MediaPaneBody`).
- **R4** — `rg "callFastAPI" apps/web/src` → only `resourceTransport.server.ts` (transport isolated, C8).
- **R5** — `rg "apiFetch|callFastAPI" apps/web/src/lib/panes/paneResourceLoaders.ts apps/web/src/lib/notes/normalize.ts` → 0 (registry + normalizers transport-free, C8).
- **R6** — `rg "HydrationCacheContext|BootstrapHydrationProvider|hydrationCache" apps/web/src` → 0 (renamed to `ResourceCache*` / `resourceCache`).
- **R7** — `rg "fetchNotePages" apps/web/src` → 0 (subsumed by the notes loader and deleted).

---

## How it composes with other systems

- **Server bootstrap two-wave** (`bootstrap.server.ts`): unchanged shape (wave-1 URL pane, wave-2 restored-visible panes, 500ms deadline, best-effort). It now calls the shared loaders via `serverResourceFetcher`. A timed-out/failed seed still yields a cache miss → client fetch (single path preserved).
- **`useResource`**: public signature unchanged (N6); only the claim gains the `pending` branch + the dedup it brings (C5). All ~30 call sites untouched.
- **View-transition chunk preload** (`paneRuntime.tsx` `panePreloadForHref` / `runPaneNavigation`): unchanged. Intent-time `warmPaneOnIntent` *front-runs* the click-time chunk warm; both call the idempotent `preloadPane`, so they coalesce.
- **Launcher dispatch** (`lib/launcher/dispatch.ts` → `requestOpenInAppPane`): unchanged. Warm is additive on hover/focus/active; the open path is identical.
- **nonce-CSP / strict-dynamic**: no new surface. Prefetch data uses `apiFetch` (same-origin BFF, already in `connect-src`); prefetch chunk uses `preloadPane` (the Next runtime's CSP-trusted module loader). PPR stays rejected; client pane-router stays.
- **`PagePaneBody`**: unaffected — it keeps importing `fetchNoteBlock` (which keeps normalizing via the extracted `normalizeBlock`).
- **AC-4 render tests** (`*.ac4.test.tsx`): extended, not replaced — now also pin the gate guard and the warm→open hit.
- **Consume-once freshness**: preserved end-to-end; no persistent cache introduced (N1).

## Risks & mitigations

- **A future fragment-rendering media kind under-seeds.** → C9: the unified gate makes seed≡client per kind; the gate carries a comment + guard test requiring any new such kind to be added to the allowlist *and* given an empty-seed recovery loader (web_article pattern). (No current risk: predicates already agree on all five kinds.)
- **Prefetch leak under hover-heavy use.** → bounded LRU(16) + abort-on-evict (C7/AC-6); debounced (`INTENT_WARM_DEBOUNCE_MS`); idempotent warms (C4).
- **Un-opened prefetch wastes a request.** → bounded by 16; pending entries abort on eviction. Acceptable for a single-user prototype; matches the existing best-effort server-seed posture.
- **Stale prefetch (data changes between warm and open).** → consume-once + short intent→open window; identical staleness class to the server seed. No new exposure.
- **Writing to the cache without a re-render.** → intentional: `useResource` reads the cache at mount only; prefetch must not re-render hover targets. Documented in `resourceCache.tsx`.
- **Isomorphic loader pulling client/server-only code.** → C8 + R4/R5 + the S0 `normalize.ts` extraction.
- **Claimed-then-unmounted pending entry.** → the warm controller owns the underlying fetch; the settle handler checks presence before writing; `useResource`'s await is abort-aware. Bounded, no correctness impact.

## Files

**Create**
- `apps/web/src/lib/api/resourceTransport.ts` — `ResourceFetcher` type + `PREFETCH_OPTS`.
- `apps/web/src/lib/api/resourceTransport.server.ts` — `serverResourceFetcher` (`"server-only"`).
- `apps/web/src/lib/api/resourceTransport.client.ts` — `clientResourceFetcher(signal)`.
- `apps/web/src/lib/panes/paneResourceLoaders.ts` — isomorphic loader registry (replaces `paneServerLoaders.ts`).
- `apps/web/src/lib/panes/paneWarm.ts` — `warmPaneOnIntent` + `usePaneWarm` (debounced) + bounded prefetch.
- `apps/web/src/lib/notes/normalize.ts` — pure `normalizeBlock` / `normalizePageSummary` + types (transport-free).
- Tests: `paneWarm.test.ts`; gate-guard + warm-hit additions to `*.ac4.test.tsx`.

**Modify**
- `apps/web/src/lib/api/hydrationCache.tsx` → rename to `resourceCache.tsx`; `ready | pending` entries; `claim` + bounded `prefetch`; `ResourceCacheProvider`/`ResourceCacheContext`.
- `apps/web/src/lib/api/useResource.ts` — `claim` + `pending` branch (internal only).
- `apps/web/src/lib/workspace/bootstrap.server.ts` — `seedPane` via `serverResourceFetcher` + registry.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` — consume the media loader; **delete** local `shouldLoadInitialFragments`.
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`, `authors/[handle]/AuthorPaneBody.tsx`, `notes/[blockId]/NotePaneBody.tsx`, `notes/NotesPaneBody.tsx` — consume loaders.
- `apps/web/src/lib/notes/api.ts` — re-import normalizers from `normalize.ts`; **delete `fetchNotePages`**; keep `fetchNoteBlock`.
- `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx` — provider rename (`ResourceCacheProvider`).
- `apps/web/src/components/workspace/PaneRouteBoundary.tsx` — capture-phase `onMouseOver`/`onFocus` → warm.
- `apps/web/src/components/launcher/LauncherRow.tsx`, `LauncherList.tsx`, `lib/launcher/useLauncherController.ts` — hover/focus/active → warm.
- (if needed for C8) `apps/web/src/lib/contributors/api.ts` — the author loader composes via the injected fetcher; trim the now-duplicated inline works guard if it becomes dead.

**Delete**
- `apps/web/src/lib/panes/paneServerLoaders.ts`.
- `MediaPaneBody`'s local `shouldLoadInitialFragments` (≈ lines 304-313).
- `fetchNotePages` in `lib/notes/api.ts` (subsumed; unused after S2).

---

## Resolved decisions

- **OQ1 — media gate semantics → ALLOWLIST.** Exactly five media kinds exist (`web_article, epub, pdf, video, podcast_episode`; `db/models.py:89-96,1146`); the allowlist and denylist agree on all five, so unifying is behaviour-preserving. The allowlist is canonical: only `TranscriptContentPanel` (podcast/video) reads the `fragments` array at first paint; epub/pdf/web_article render from dedicated loaders. Recorded as C9 + a guard test; deleting the client denylist is safe. (No live bug today — it was a latent trap.)
- **OQ2 — prefetch bound → `PREFETCH_CACHE_LIMIT = 16`.** Covers a full launcher result set plus a few in-pane hovers; abort-on-evict.
- **OQ3 — keyboard-active / hover warming → debounced `INTENT_WARM_DEBOUNCE_MS = 70`.** Continuous signals (pointer hover, arrow-key active row) debounce; discrete focus warms immediately. Idempotency + the LRU bound make storms harmless.
- **OQ4 — `ReaderCitation` hover → NOT wired (deferred).** Citations are previewed far more often than opened, and the preview popover already fetches; anchor-form citations inside a pane are already covered by the `PaneRouteBoundary` delegate. Bespoke citation-hover data-warming is a future enhancement (N7).
- **OQ5 — note/notes routing → route both through the loader.** `fetchNotePages` (only `NotesPaneBody`) is deleted; `fetchNoteBlock` is **kept** (still used by `PagePaneBody:374`). `normalizeBlock`/`normalizePageSummary` are extracted to a transport-free `lib/notes/normalize.ts` so the isomorphic registry stays clean (C8).
- **Single-fetch client panes → unchanged (D7).** Their default descriptor `useResource` load is byte-identical to the trivial loader; only the registry (server-seed + prefetch) gains their entry. Minimizes churn with zero divergence risk.

No open questions remain.

---

## Implementation divergences (as built)

Built in worktree `pane-resource-loader-prefetch` (S0–S6). All green: typecheck 0, lint 0,
unit 905/906 (the one failure — `workspaceRestore.test.ts` "reuses and activates the saved
pane for same-resource deep links" — fails identically on untouched `main`, pre-existing and
out of scope), browser 1168/1168. Gates R1/R2/R6/R7 = 0.

- **D1 — `claim()` split into `peek()` + `consume()` (React-correctness).** The spec's single
  `claim(key)` (return + remove) can't run during render: removal is a mutation, and React
  render must be pure, yet the no-flash synchronous seed needs a render-phase *read*. So the
  cache exposes `peek(key)` (read-only, called in render) + `consume(key)` (removal, called
  post-commit in an effect). Consume-once semantics are identical. `prefetch` unchanged.
- **D2 — the injected `ResourceFetcher` parameter is named `request`, not `fetch`.** The
  `effect-discipline` architecture test flags any `fetch(...)` call outside an allowlist of
  boundary modules; naming the injected fetcher `fetch` made `fetch(descriptor, params)` in the
  registry a false positive. `request(descriptor, params)` reads as well and keeps the registry
  out of the raw-fetch allowlist (it is genuinely transport-free — R5).
- **D3 — intent warming is uniformly debounced (focus not special-cased to immediate).** The
  chunk preload (`preloadPane`) is always synchronous; only the *data* prefetch waits the 70ms
  per-key debounce. A 70ms delay on a discrete focus is immaterial, and the per-key debounce +
  LRU already absorb hover storms, so `usePaneWarm` is one function, not two.
- **D4 — launcher warming wired at the single `setActiveId` seam, not per-row handlers.** Every
  active-row change — pointer hover (`LauncherRow onMouseMove → onHover`), action-row hover, and
  arrow-key nav (`LauncherInput`) — already routes through `controller.setActiveId`. Warming
  there covers pointer + keyboard intent with one change and no double-dispatch; launcher rows
  aren't focusable (focus stays on the input via `aria-activedescendant`), so per-row
  `onFocus`/`onMouseEnter` would be redundant. The launcher DOM contract is untouched.
- **D5 — client mounts cast the loader result (`as Promise<{…}>`).** The isomorphic registry
  types every loader's return as `Promise<unknown>` (it must not import client-only pane types
  like `Media`/`Fragment` — C8). Each `*PaneBody` casts the result to its known shape at the
  call boundary; the runtime shape is identical (same endpoints) and the cast is from `unknown`,
  so it is honest and local.
- **D6 — `AUTHOR_WORKS_LIMIT` relocated from `AuthorPaneBody` to `resource.ts`.** The isomorphic
  registry needed it transport-free; it now lives beside `contributorWorksResource` and
  `AuthorPaneBody` re-imports it (still used by in-place reload). Confirmed `= 100`, equal to the
  old server loader's hardcoded limit, so the seed is byte-identical (C2).
- **D7 — `requiredRecord` / `requiredString` moved into `normalize.ts`.** They are used by both
  the extracted normalizers and the rest of `notes/api.ts`; co-locating them in the leaf
  `normalize.ts` keeps it self-contained (C8) and avoids a circular import. `api.ts` re-imports
  them and re-exports the `NoteBlock`/`NotePageSummary` types so its many type importers are
  untouched.
- **D8 — the `notes` loader adopts the server's tolerant `?? []`.** The deleted client
  `fetchNotePages` threw on a missing `pages` array; the server seed used `?? []`. Unifying to one
  body makes the tolerant behavior canonical (a missing array from our own BFF is not a real
  scenario; an empty list is a safe first paint).
- **Gate notes.** R4 ("`callFastAPI` only in `resourceTransport.server.ts`") is stricter than
  reality: `callFastAPI` legitimately remains in `bootstrap.server.ts` (the non-pane reader-
  profile/session fetches), `server.ts` (its definition), and the pre-existing oracle page. The
  cutover invariant — *no pane loader touches transport* — is the one that matters and is enforced
  by R5 (registry + normalizers transport-free), which passes (only comment mentions of the
  helper names remain). R3's lone hit is a test seed (`fragments: []` as fixture data), not the
  production assembly, which left `MediaPaneBody`.
- **Not run:** Playwright e2e and CSP suites (consistent with prior cutovers; the unit + browser
  + architecture-discipline gates cover the changed surface).

---

## Adversarial review (2026-06-19) — outcome

Five parallel adversarial reviewers (launcher wiring, href-parse consistency, standards+consolidation,
test coverage vs ACs, dead-code/hard-cutover) + a direct re-run of R1–R7.

**Confirmed solid (no change needed):** all negative gates green; intent wiring is real and total —
hover (`LauncherRow onMouseMove → onHover → setActiveId`) and arrow-key (`LauncherInput → setActiveId`)
both reach `warmPane`, and the warm key ≡ the mount key *by construction* (both flow through
`resolvePaneRouteModel`/`matchPattern`, pathname-only, decoded identically; proven through the media
cacheKey). `resolvePaneRouteModel` is total — no path through the capture-phase hover handler can throw.
Zero dead code, zero stale refs, zero unused imports, zero leftover dual paths. The design choices the
reviewers stress-tested are all rules-compliant: the 3-file transport split is forced by the
`"server-only"` bundle boundary; `usePaneWarm`'s per-key timer map mirrors the repo's existing
multi-key-timer idiom (`Feedback.tsx`) — no fitting debounce util exists; the LRU has no reuse target;
the comments are WHY/invariant comments; `useResource`'s `seededRef`/`skipKeyRef` are distinct
(seed value vs one-shot skip latch), not duplicated state.

**Fixed:**
- **Backward-compat re-export removed (hard-cutover compliance, `codebase.md` "no re-exports").**
  `notes/api.ts` re-exported `NoteBlock`/`NotePageSummary` from `normalize.ts` "so existing importers are
  unaffected" — a compat shim the hard cutover forbids. Deleted it and repointed all **8** importers
  (`collections/presenters/note.ts`, `notes/prosemirror/schema.ts(+test)`, `resourceSurfacePersistence.ts`,
  `PagePaneBody.tsx`, `CreatePanel.tsx`, `NotesPaneBody.tsx`, `NotePaneBody.tsx`) to the real owner
  `@/lib/notes/normalize` (splitting mixed value/type imports). Type-only; zero runtime change.
- **The two headline ACs now have integrated tests through the real warm path + fetch boundary.**
  New `paneWarmIntegration.test.tsx`: **AC-4** (warm `/media/m1` via `usePaneWarm`, then mount
  `MediaPaneBody`'s exact `useResource` call under the same `ResourceCache` → ready with **zero** mount
  fetch — verified to have teeth: drifting the id makes it fail), **AC-5** (warm in flight, mount mid-fetch
  → adopts the pending promise, **exactly one** network fetch total), **AC-8** extended to `/browse`,
  `/search`, and the `conversation` *detail* href (chunk warmed, no data) — pinning the
  `conversations`-list-has-a-loader vs `conversation`-detail-excluded distinction.
- **Intent-wiring surfaces now tested.** `PaneRouteBoundary.test.tsx`: hover + focus on an in-pane
  `<a href>` warm chunk **and** data into a real provided cache (the prior harness omitted
  `ResourceCacheProvider`, silently no-opping the data path); `#`-fragment and non-anchor targets warm
  nothing. `Launcher.test.tsx`: hovering an in-app go-to row warms its pane; Create / externalShell rows
  do not.

**Considered and deliberately NOT changed (rationale):**
- **`preloadPaneForHref` consolidation — rejected.** The three href→`preloadPane` sites differ in
  contract (`paneRuntime.panePreloadForHref` returns a thunk that's `undefined` for unsupported — the
  view-transition API shape; `AuthenticatedShell` does a batched Set-deduped preload; `paneWarm` needs
  `{id, params}` from the *same* resolve, so a helper forces a wasteful double-resolve). The shared logic
  is just `resolvePaneRouteModel` (already centralized) + a one-line guard; extracting it is the
  premature abstraction the rules caution against.
- **C9 compile-time exhaustiveness — rejected.** There is no frontend `MediaKind` union (`kind` is a loose
  `string` from the backend envelope, by design). Enforcing C9 at compile time would require inventing a
  frontend enum that *mirrors* the backend `MediaKind` source of truth — which the rules forbid and which
  could drift. The spec's AC-2 requires the guard test "documents C9," which the enumerated all-five-kinds
  test already does.
- **`browse-acquire` owned-media warming — out of scope (documented enhancement).** A browse-lane row for
  already-owned media opens `/media/{id}` on Enter but isn't warmed (its target kind is `browse-acquire`,
  not `href`/`resource`). The id is known, so it *could* warm — but the spec (§S5) deliberately scoped the
  launcher intent surface to `href` + route-`resource` rows. Expanding it is new scope, not an
  unimplemented part of the spec; left as a future enhancement.
- **AC-9 true open→close→reopen lifecycle — sufficient as-is.** Consume-once-then-refetch is already
  proven (`useResource.test.tsx`); the remaining nuance (a *fetched* mount, vs a seeded one, re-opening)
  adds no new code path.

**Final verification (post-review):** typecheck 0, lint 0, gates R1–R7 green, full unit **905/906** (the
1 = pre-existing `workspaceRestore.test.ts`, unrelated — touches none of this diff's files), full browser
**1178/1178** (+10 review tests). e2e/CSP still not run.
