# Universal Launcher — Hard Cutover

**Status:** Implemented · **Rev 2** · 2026-07-21
**Type:** Hard cutover — no legacy code, no fallbacks, no backward-compat shims, no dual entry points, no flags-for-old-behavior.

> **Current Add contract:** [`add-content-intake-hard-cutover.md`](add-content-intake-hard-cutover.md)
> replaces this document's original Add lane, sigil, chooser, automatic submit,
> and automatic-open behavior. Add is now a direct, source-first Launcher detail;
> the historical problem evidence below remains attributable context, not a
> supported path.

## One-line

Collapse the five separate "front doors" — command palette, `/search`, `/browse`,
the former Add-Content tray, and note creation — into **one Launcher**. Its
omni-input parses once into a shared query/item/target model; Add is a direct
Launcher detail rather than another search lane.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** The search intent-model cutover is landed (it is — `lib/search/{query,parseSearchInput,searchParams,searchApi,kinds}.ts` + `services/search/` package). The Launcher consumes `SearchQuery`, `parseSearchInput`, `searchHref`, `fetchSearchResultPage` **as-is**; it does not re-implement search semantics.
- **P-2.** The resource-graph activation seam is the sole opener: `ResourceActivation` + `activateResource` (`lib/resources/activation.ts`) + `requestOpenInAppPane` (`lib/panes/openInAppPane.ts`). The Launcher adds no new way to open a resource.
- **P-3.** The mobile-sheet/overlay family is landed: `MobileSheet`, `useDialogOverlay`, `useHistoryDismiss`. The Launcher introduces **no new modal primitive** — it reuses `PaletteSurface`'s desktop glass and `MobileSheet`.

> Rationale: this is a frontend-led consolidation. Its backend capabilities
> already existed (`/search`, `/browse`, `/media/from_url`, `/media/upload/init`,
> `/notes/quick-capture`, `/me/palette-history`, `/oracle/readings`) except a
> standalone read-only web-search endpoint (S7). The cutover's value is
> collapsing duplicated parsing, item, dispatch, registry, and fetch logic into
> single owners — not new storage.

---

## 1. Problem

### 1.1 Five front doors, one job

A user who wants to "get to a thing" today faces five disjoint surfaces:

- **Command palette** (`components/palette/`) — omni-input with sigil lanes (`>` actions, `@` content, `?` ask), recents, inline search, ask-AI, tab switching. Already ~80% of a launcher.
- **`/search`** (`app/(authenticated)/search/SearchPaneBody.tsx`) — six-kind intent search with operator chips. Full-page.
- **`/browse`** (`app/(authenticated)/browse/`) — external discovery (docs/Gutenberg/YouTube/podcasts) via `services/browse.py`. Full-page.
- **Add-Content tray** (`components/AddContentTray.tsx`) — a separate event-dispatched modal (`OPEN_ADD_CONTENT_EVENT`) for URL paste / file upload / OPML / quick-note.
- **Note creation** — `quickCaptureDailyNote` / `createNotePage` reachable only from the tray's quick-note tab or the palette `create-page` command.

The palette already _links to_ all five (`STATIC_COMMANDS` has `nav-browse`, `nav-search`, `create-url`, `create-upload`, `quick-note-today`, `create-opml`), but it **delegates** — it opens the other surfaces rather than owning the intent. "Add from URL" dispatches `OPEN_ADD_CONTENT_EVENT`; "Browse" navigates to `/browse`; search is a 5-row teaser that hands off to `/search`.

### 1.2 The same logic, parsed and shaped five times

The recon surfaced concrete duplication the cutover must collapse (full catalog in §9):

- **Input parsing** lives in two places that should compose: `parsePaletteInput` (`paletteIntent.ts:27`, sigil→lane) and `parseSearchInput` (`parseSearchInput.ts:104`, operators→chips). `extractUrls` (`lib/extractUrls.ts`) is a third, consumed only by the tray.
- **Destinations are enumerated twice**: `STATIC_COMMANDS` (`paletteModel.ts:94`, 21 items) and `NAV_MODEL` (`appnav/navModel.ts:34`, 9 items) both list `/oracle`, `/libraries`, `/browse`, `/podcasts`, `/daily`, `/notes`, `/conversations`, `/settings` — divergent shapes, hand-synced.
- **Dispatch is split**: the palette's `navigate(item)` (`usePaletteController.ts:268`) and `runAction(action)` (`:376`) are two switches over near-identical target/run unions, each independently calling `requestOpenInAppPane` / `activateResource` / `window.location.assign`.
- **Debounced async fetch** is hand-rolled twice (`usePaletteController.ts:168` and `SearchPaneBody.tsx:99`) — both debounce 200 ms, abort on change, toggle a loading flag, with subtly different cancellation (`AbortController` vs `requestIdRef`).

### 1.3 The palette is already the launcher core — but its model is search-shaped, not intent-shaped

`PaletteItem` / `PaletteTarget` / `PaletteView` (`paletteModel.ts:47–332`) are a clean provider→rank→action→dispatch pipeline. But the lane model (`all | actions | content | ask`) folds "open existing" and "search all" into one `content` lane, has no concept of "browse external," and treats "add" and "create" as `action` commands that punt to the tray. The user's six explicit choices do not have six homes.

### 1.4 The gaps

- **`web_search` is trapped inside chat** (`services/agent_tools/web_search.py`) — it persists per-conversation snapshots and is only callable as an LLM tool. There is no read-only "search the web" the Launcher can show.
- **Recency is href-keyed and palette-only** (`CommandPaletteUsage`, `command_palette.py`) — fine for "open existing," but unused by search/browse. (We keep href-keying — see D-9.)

---

## 2. Target behavior (user-facing)

- **One surface.** `Cmd/Ctrl-K`, the nav rail's "Search or ask anything" button,
  the mobile command button, and the navigation `+` all open the Launcher. The
  `+` opens Add directly with Content/Links as the initial intent. There is no
  separate modal, Add lane, menu, chooser, sigil, or deep link.
- **Paste/type anything, then choose.** The blended default (`all`) shows ranked, grouped interpretations of the input: **Open** (your tabs/recents/resources), **Search** (top in-library hits + "See all"), and pinned-last rows for **Ask AI**, **Create note**, and **Browse the web**. No upfront mode picker.
- **Confident auto-suggest on hard signals, never auto-execution.** Paste a URL → the **top row** becomes "Add ⟨url⟩ to library" with Search/Open beneath; `Enter` adds and opens it. Ambiguous text defaults to search-inclusive; alternatives are one keystroke away.
- **Sigils + lane chips for retrieval power users.** `>` means go, `@` means
  open existing, and `?` means ask AI. Add has no lane chip or sigil.
  `Shift+Enter` routes the current text to Ask AI from any retrieval lane.
- **Add and create happen _inside_ the Launcher.** Navigation `+` and matching
  URL/file/OPML aliases open the direct Add workbench; create commands open the
  note editor. The bare-URL hard-signal row remains the deliberate one-step
  capture path. The workbench stages URL/file intent locally and submits only
  through its explicit action.
- **Browse external is first-class.** A `browse` lane shows live external
  discovery (documents/Gutenberg/videos/podcasts) and, via S7, live web results;
  each result is openable or acquirable through its canonical action.
- **Identical input → identical results.** The `search` lane and the `/search` page parse the same operators into the same `SearchQuery`; "See all" round-trips through `searchHref`. The `/search` and `/browse` pages remain as deep-linkable full-pane "see all" targets.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Promote the palette to **the** Launcher: one omni-input owning retrieval
  lanes (`open`, `search`, `browse`, `create`, `ask`) plus `go` commands, with
  Add represented by matching command results and a direct detail—not a lane.
- **G2.** **One boundary parser.** `parseLauncherInput(raw): LauncherInput` composes sigil detection + `parseSearchInput` (operators) + URL hard-signal detection into one typed value the rest of the Launcher never re-parses.
- **G3.** **One query model, shared with `/search`.** The `search` lane carries the full `SearchQuery` (operators, filters) — deleting the palette's hardcoded `{ limit: 5 }` all-types-no-filters fetch.
- **G4.** **One item schema** (`LauncherItem`) and **one target/dispatch owner** (`dispatchTarget`) — merging `navigate` + `runAction`, with search rows and browse results adapted into `LauncherItem` for the Launcher list.
- **G5.** **One destination registry.** `lib/navigation/destinations.ts` is the single source for nav destinations; `NAV_MODEL` and the Launcher's `go` commands both derive from it.
- **G6.** **Absorb Add-Content and note creation into Launcher details.** Re-home
  the destination picker, intake queue, OPML boundary, and note composer under
  Launcher-owned details. Delete the standalone surfaces and their open event.
- **G7.** **Add a standalone read-only web search** (`GET /api/web/search`) reusing the existing provider, so `browse` can show live web results without chat persistence.
- **G8.** **Consolidate the debounced-fetch loop** into one `useDebouncedFetch` hook used by the Launcher and `/search`.
- **G9.** **Rename the surface.** `components/palette/` → `components/launcher/`, `Palette*` → `Launcher*`, `open-palette` → `open-launcher`, the DOM contract, and e2e selectors. It is the Launcher everywhere.

### Non-goals (explicit)

- **N1.** **No god aggregator endpoint.** There is no `/api/launcher`. Each lane calls its existing single-owner endpoint; the client fans out concurrently (as the palette already does for history/oracle/search). Rationale: one owner per capability; a monolithic endpoint would re-aggregate logic that already has homes.
- **N2.** **Do not collapse the dense `/search` and `/browse` page renderers into the Launcher row.** They keep their rich layouts (`SearchResultRow`, browse cards) and remain deep-link targets; they share only the **query model and URL serialization**, not the compact `LauncherItem` row component.
- **N3.** **No ResourceRef re-keying of recency.** `CommandPaletteUsage` stays href-keyed — the href _is_ the canonical open target (D-9). No migration.
- **N4.** **No local intent-classifier model.** Disambiguation is deterministic (hard signals + sigils + frecency ranking). A learned/local router is a future horizon, not this cutover (matches _AI-first, simple_; no speculative ML).
- **N5.** **Ask AI does not duplicate chat's NL→filter parsing.** The `ask` lane hands the text to the existing chat draft path; deterministic operator parsing stays in the Launcher, agentic parsing stays in chat.
- **N6.** **No new web-search persistence.** S7 is read-only; per-conversation `resource_external_snapshots` persistence remains chat-only and unchanged.
- **N7.** **No change to the ingest pipeline, note model, browse providers, or resource routing.** The Launcher composes them.

---

## 4. Architecture & final state

### 4.1 Final ownership map

| Concern                                                                    | Sole owner (final)                                                                               | Replaces                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Boundary input parse                                                       | `lib/launcher/parseLauncherInput.ts`                                                             | `paletteIntent.ts` + inline `parseSearchInput` calls + tray's `extractUrls` use |
| Lane / section / item / target / view types                                | `lib/launcher/model.ts`                                                                          | `paletteModel.ts`                                                               |
| Item providers (one per lane)                                              | `lib/launcher/providers.ts`                                                                      | `paletteProviders.ts`                                                           |
| Ranking + lane filter + disambiguation policy                              | `lib/launcher/ranking.ts`                                                                        | `paletteRanking.ts`                                                             |
| Drill-down actions                                                         | `lib/launcher/actions.ts`                                                                        | `paletteActions.ts`                                                             |
| **Unified dispatch** (open/command/ask/create/browse and one-step capture) | `lib/launcher/dispatch.ts`                                                                       | palette `navigate` + `runAction` (merged)                                       |
| Controller (state, fetches, pages)                                         | `components/launcher/useLauncherController.ts`                                                   | `usePaletteController.ts`                                                       |
| Desktop glass + mobile sheet surface                                       | `components/launcher/{LauncherSurface,LauncherSheet,LauncherInput,LauncherList,LauncherRow}.tsx` | `palette/*` (renamed)                                                           |
| Add / Create details                                                       | `components/launcher/AddPanel.tsx`, `CreatePanel.tsx`                                            | `AddContentTray.tsx`, `QuickNotePanel.tsx`                                      |
| Open event                                                                 | `lib/launcher/launcherEvents.ts` (`OPEN_LAUNCHER_EVENT`, tagged Root/Add detail)                 | `commandPaletteEvents.ts` + `addContentEvents.ts`                               |
| Nav destination registry                                                   | `lib/navigation/destinations.ts`                                                                 | `NAV_MODEL` literal + nav half of `STATIC_COMMANDS`                             |
| Debounced async fetch                                                      | `lib/api/useDebouncedFetch.ts`                                                                   | hand-rolled loops in palette + `/search`                                        |
| Standalone web search (read-only)                                          | `GET /api/web/search` → `services/web_search.search_web_readonly`                                | (new; extracted from chat tool)                                                 |

### 4.2 The three layers (parse → provide → dispatch)

```
raw string
   │  parseLauncherInput            (lib/launcher/parseLauncherInput.ts) — ONE boundary parse
   ▼
LauncherInput  { explicitLane, text, searchQuery, url }
   │  buildLauncherItems(ctx)       (lib/launcher/providers.ts) — per-lane providers emit LauncherItem[]
   │  rankLauncher(ctx, items)      (lib/launcher/ranking.ts)   — lane filter + omnibox ranking + groups
   ▼
LauncherView   { resting groups | querying results | actions }   ──render──▶ LauncherList / LauncherRow
   │  select / drill / runAction
   ▼
dispatchTarget(target)             (lib/launcher/dispatch.ts) — ONE switch → requestOpenInAppPane / activateResource / ingest / quick-capture / file-picker
```

Dependency arrows (one-directional, no cycles): `model.ts ◀ parseLauncherInput.ts ◀ providers.ts ◀ ranking.ts ◀ useLauncherController.ts ◀ {LauncherSurface, LauncherSheet}`. `dispatch.ts` depends only on `model.ts` + the shared seams (`activation.ts`, `openInAppPane.ts`, `ingestionClient.ts`, `notes/api.ts`). `destinations.ts` is a leaf consumed by both `navModel.ts` and `providers.ts`.

### 4.3 Lanes & sections

```ts
// lib/launcher/model.ts
export type LauncherLane =
  | "all" // blended default — "show all interpretations"
  | "open" // existing resources: context, open tabs, recents, folios
  | "search" // in-library search (shared SearchQuery)
  | "browse" // external discovery (/browse aggregator + web, S7)
  | "create" // create note / page
  | "ask" // ask AI (hands off to chat)
  | "go"; // commands: navigate + settings

// Sigils for the common retrieval lanes; every lane is also reachable via a
// visible lane chip. Add is a direct detail and has neither.
// `search`, `browse`, `create` have no sigil (search is implicit in `all`; the others use chips/rows)
// to avoid sigil sprawl (research: back sigils with visible affordances + a `?` legend).
export const LANE_SIGIL: Partial<Record<LauncherLane, string>> = {
  go: ">",
  open: "@",
  ask: "?",
};

export type LauncherSectionId =
  | "context"
  | "open-tabs"
  | "recent"
  | "recent-folios" // → open
  | "search-results" // → search
  | "browse-results" // → browse
  | "add" // Add command results; not a lane
  | "create" // → create
  | "go"
  | "settings" // → go
  | "ask"; // → ask
```

`inLane(sectionId, lane)` (in `ranking.ts`) maps section→lane. `"add"` is a
result section, not a `LauncherLane`; matching URL/file/OPML aliases can appear
in the blended root but cannot select or encode an Add lane.

### 4.4 Disambiguation policy (the omnibox contract)

The policy lives in `ranking.ts` and is the SME core of the cutover (reconciles _explicit UI over automation_ with _AI-first, show your work_):

1. **Explicit lane wins.** If `input.explicitLane` is set (sigil or chip), filter to that lane only.
2. **Hard URL signal → confident top suggestion, not auto-run.** If `input.url` is non-null, inject an `add` item `{ target: { kind: "add-url", url } }` titled "Add ⟨host⟩ to library" at **rank top** of the blended view. It is the default `Enter` target but executes only on selection.
3. **Plain text → blended `all` = all interpretations.** Emit, ranked by score: Open (context/tabs/recents, frecency-boosted) + Search (top hits) interleaved; then **pinned-last** rows — "Ask AI about ⟨text⟩", "Create note: ⟨text⟩", "Browse the web for ⟨text⟩" / "See all results". Pinned rows are visibly distinct (machine/AI rows are labeled — Synapse N3 discipline).
4. **AI never auto-executes.** The ask row is always an explicit choice. `Shift+Enter` is a modifier override that routes the current `text` to `ask` from any lane.
5. **No silent broadening.** A sigil/lane with zero results shows an explicit empty state for that lane, never a silent fallthrough to another lane.

### 4.5 Pages (drill + embedded panels)

```ts
export type LauncherPage =
  | { kind: "root" }
  | { kind: "actions"; item: LauncherItem; actions: LauncherAction[] }
  | { kind: "add" } // lifted session owns AddSeed
  | { kind: "create" };
```

The navigation `+` initializes the lifted Add session from a typed seed, then
opens `{kind: "add"}` directly. Matching URL/file/OPML results do the same with
no intermediate chooser;
bare-URL capture remains an explicit one-step target. Create results push
`{kind: "create"}`. Details render **inside** the same
`LauncherSurface`/`LauncherSheet`, reusing its focus, history, and dismissal
contract.

### 4.6 Surfaces & shell

- `LauncherSurface` (desktop glass, from `PaletteSurface`) and `LauncherSheet`
  (mobile, wraps `MobileSheet`) host the root input/list and Add/Create details.
- The shell (`AuthenticatedShell.tsx`) mounts one `<Launcher />` where `<CommandPalette />` was, and **deletes** the `<AddContentTray />` mount.
- The rail/top-bar command controls open `{kind: "Root"}`. The navigation `+`
  opens `{kind: "Add", seed: {kind: "Content", initialFocus: "Url", ...}}`.

---

## 5. Capability contract (frontend core types)

```ts
// lib/launcher/parseLauncherInput.ts
export interface LauncherInput {
  raw: string;
  explicitLane: LauncherLane | null; // leading sigil OR chip-selected lane; null ⇒ blended `all`
  text: string; // raw minus sigil minus operators — the free-text query
  searchQuery: SearchQuery; // ALWAYS derivable; operators absorbed (shared model, G3)
  url: ParsedUrl | null; // hard signal for the add result section, else null
}

// Composes the three formerly-separate parsers; the rest of the Launcher never re-parses `raw`.
export function parseLauncherInput(raw: string): LauncherInput;
//   1. peel leading sigil → explicitLane (LANE_SIGIL reverse map)
//   2. parseSearchInput(remainder) → applyParsedInput(emptySearchQuery(), parsed) → searchQuery; parsed.text → text
//   3. first extractUrls(text) hit that is a bare URL with no free-text remainder → url
```

```ts
// lib/launcher/model.ts
export type LauncherTarget =
  | { kind: "href"; href: string; externalShell: boolean }
  | { kind: "resource"; activation: ResourceActivation; labelHint?: string }
  | { kind: "command"; commandId: LauncherCommandId } // was "action"
  | { kind: "ask"; text: string; scopeHref?: string }
  | { kind: "add-url"; url: string } // quick add (hard-signal row)
  | { kind: "create-note"; text: string } // quick capture → daily note
  | { kind: "browse-acquire"; result: BrowseResult }; // open/add an external hit

export type LauncherSource =
  | "static"
  | "workspace"
  | "recent"
  | "oracle"
  | "search"
  | "browse"
  | "ai";

export interface LauncherItem {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string[];
  sectionId: LauncherSectionId;
  icon: LauncherIcon;
  target: LauncherTarget;
  source: LauncherSource;
  rank: LauncherRankSignals; // { searchScore?, frecencyBoost?, scopeBoost?, urlSignal? }
  shortcutLabel?: string;
  hasActions?: boolean;
  pin?: "last";
  trailingAction?: { commandId: LauncherCommandId; ariaLabel: string };
  // optional rich-render hints used by LauncherRow when a search/browse row is adapted in:
  snippet?: SnippetSegment[];
  meta?: string;
  contributors?: ContributorCredit[];
}

export type LauncherView =
  | { state: "resting"; groups: LauncherGroup[] }
  | { state: "querying"; results: LauncherItem[] }
  | { state: "actions"; item: LauncherItem; actions: LauncherAction[] };
```

```ts
// Adapters (lib/launcher/adapters.ts) — the ONLY bridges from other surfaces' view models:
export function launcherItemFromSearchRow(
  row: SearchResultRowViewModel,
): LauncherItem; // → resource target + snippet/meta
export function launcherItemFromBrowseResult(r: BrowseResult): LauncherItem; // → browse-acquire target + meta
```

```ts
// lib/launcher/dispatch.ts — ONE owner; merges palette navigate + runAction.
export async function dispatchTarget(
  target: LauncherTarget,
  ctx: LauncherDispatchCtx,
): Promise<void>;
//   href      → externalShell ? window.location.assign : requestOpenInAppPane
//   resource  → activateResource(activation, { navigate, openInNewPane })
//   command   → exhaustive switch over LauncherCommandId (nav handled via href; create/Add open details)
//   ask       → openAskConversation(text)
//   add-url   → addMediaFromUrl({ url, libraryIds: ctx.defaultLibraryIds }) then open /media/{id}
//   create-note → quickCaptureDailyNote({ blockId, clientMutationId, bodyPmJson: docFromText(text) }) then open /daily
//   browse-acquire → result.media_id ? open : addMediaFromUrl(result.url) then open
```

```ts
// components/launcher/useLauncherController.ts
export interface LauncherController {
  open: boolean;
  query: string;
  input: LauncherInput; // parsed once per keystroke
  lane: LauncherLane; // input.explicitLane ?? "all"
  page: LauncherPage;
  view: LauncherView;
  searchLoading: boolean;
  browseLoading: boolean;
  activeId: string | null;
  setQuery(next: string): void;
  setLane(lane: LauncherLane): void; // chip selection (writes/peels sigil to keep input.raw canonical)
  clearLane(): void;
  setActiveId(id: string): void;
  select(item: LauncherItem): void; // → dispatchTarget OR push page
  drill(item: LauncherItem): void;
  back(): void;
  runAction(action: LauncherAction): void;
  trailing(item: LauncherItem): void;
  askCurrent(): void; // Shift+Enter → ask with input.text
  close(): void;
}
```

DOM contract (renamed, documented breaking change — see §8.7): `LAUNCHER_LISTBOX_ID = "launcher-listbox"`, `LAUNCHER_OPTION_ID_PREFIX = "launcher-option-"`, dialog `aria-label="Launcher"`, input `aria-label="Search, add, or ask"`.

---

## 6. API design (HTTP)

All lanes reuse existing single-owner endpoints; the client fans out concurrently (N1). Only one endpoint is new.

| Lane / need             | Endpoint                                                           | Owner                                                                  | Change                                                               |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Open — recents/frecency | `GET /api/me/palette-history[?query=]`                             | `command_palette.py`                                                   | none (rename path optional; keep)                                    |
| Open — folios           | `GET /api/oracle/readings`                                         | `oracle.py`                                                            | none                                                                 |
| Search                  | `GET /api/search?q&kinds&formats&authors&roles&scope&cursor&limit` | `routes/search.py`                                                     | none — Launcher now sends full operators (was `limit:5`, no filters) |
| Browse external         | `GET /api/browse?q&limit&page_type&cursor`                         | `routes/browse.py`                                                     | none                                                                 |
| **Browse — web (new)**  | **`GET /api/web/search?q&freshness_days`**                         | **`routes/web_search.py` → `services/web_search.search_web_readonly`** | **new, read-only, no persistence (S7)**                              |
| Add — URL               | `POST /media/from_url`                                             | `media_ingest.py`                                                      | none                                                                 |
| Add — file              | `POST /media/upload/init` → PUT → `POST /media/{id}/ingest`        | `media_ingest.py`                                                      | none                                                                 |
| Add — OPML              | existing OPML import route                                         | podcasts/import                                                        | none                                                                 |
| Create — note           | `POST /api/notes/quick-capture`                                    | `routes/notes.py`                                                      | none                                                                 |
| Create — page           | `POST /api/notes/pages` (`createNotePage`)                         | `routes/notes.py`                                                      | none                                                                 |

**New endpoint contract:**

```python
# routes/web_search.py
@router.get("/web/search")
def web_search(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    q: Annotated[str, Query(min_length=2)],
    freshness_days: Annotated[int | None, Query(ge=1)] = None,
) -> dict:  # success_response({ "results": [WebSearchCitationOut, ...] })
    return success_response(search_web_readonly(q, freshness_days=freshness_days))
```

`search_web_readonly` is extracted from `web_search.py:execute_web_search` (the provider call + projection to `WebSearchCitation`), **without** the `persist_web_search_run` side effects. The chat tool keeps its persisting wrapper (`execute_web_search` = `search_web_readonly` + persist). One provider, two callers, no duplication.

---

## 7. Frontend architecture

### 7.1 Module layout (final)

```
components/launcher/
  Launcher.tsx               # mount; surface dispatch (desktop glass vs mobile sheet)
  LauncherSurface.tsx        # desktop glass (was PaletteSurface)
  LauncherSheet.tsx          # mobile (wraps MobileSheet) (was PaletteSheet)
  LauncherInput.tsx          # omni-input + lane chips + sigil legend + keyboard
  LauncherList.tsx           # listbox; sections (resting) / results (querying) / actions
  LauncherRow.tsx            # option row (icon/title/subtitle/snippet/meta/trailing/drill)
  LauncherLaneChips.tsx      # visible lane chips (reuse ui/Chip pressable)
  AddPanel.tsx               # embedded add UI (re-homed AddContentTray internals)
  CreatePanel.tsx            # embedded note editor (re-homed QuickNotePanel internals)
  useLauncherController.ts   # state, fetches (useDebouncedFetch), pages, dispatch wiring
lib/launcher/
  model.ts  parseLauncherInput.ts  providers.ts  ranking.ts  actions.ts
  dispatch.ts  adapters.ts  launcherEvents.ts
lib/navigation/destinations.ts     # single destination registry (P9)
lib/api/useDebouncedFetch.ts        # one debounced+aborted fetch hook (P7)
```

### 7.2 Providers (one per lane, generalized from `buildPaletteItems`)

```ts
export function buildLauncherItems(ctx: LauncherContext): LauncherItem[] {
  const base = [
    ...contextItems(ctx),
    ...openTabItems(ctx),
    ...recentItems(ctx),
    ...folioItems(ctx), // open
    ...commandItems(ctx), // go (from destinations.ts)
    ...searchItems(ctx), // search (adapted rows)
    ...browseItems(ctx), // browse (adapted results, incl. web)
  ];
  return [
    ...urlAddItem(ctx), // hard-signal add row, rank-top (§4.4.2)
    ...base,
    ...createNoteItem(ctx), // pin: "last"
    ...askItem(ctx, base), // pin: "last"
    ...browseWebItem(ctx), // pin: "last" → seeds browse lane / web
    ...seeAllItem(ctx), // pin: "last" → searchHref(ctx.input.searchQuery)
  ].filter(Boolean);
}
```

`searchItems` carries `ctx.input.searchQuery` (full operators); the inline fetch uses `fetchSearchResultPage(ctx.input.searchQuery, { limit: 6 })`. `seeAllItem` serializes the **same** query via `searchHref(ctx.input.searchQuery)` so the page opens identically (preserves the search-cutover round-trip invariant).

### 7.3 Controller fetches (via `useDebouncedFetch`)

The controller runs three concurrent debounced fetches keyed on `input`: history (`/me/palette-history`), search (`fetchSearchResultPage`), and — only when `lane ∈ {browse, all}` and `text.length ≥ 2` — browse (`/browse` + `/web/search`). Each uses `useDebouncedFetch(fetcher, [key], { debounceMs: 200, enabled })`, replacing the two hand-rolled loops.

### 7.4 Shell integration

`launcherEvents.ts` exposes `OPEN_LAUNCHER_EVENT` with one tagged
`OpenLauncherDetail`: `{kind: "Root", lane?, query?}` or `{kind: "Add", seed}`.
`dispatchOpenLauncher()` defaults to Root. Add has no URL-param/deep-link form;
legacy `?lane=add` is unknown input. The `open-launcher` keybinding replaces
`open-palette` in `DEFAULT_KEYBINDINGS`.

---

## 8. Composition with other systems

- **8.1 Search.** Consumes `SearchQuery`/`parseSearchInput`/`searchHref`/`fetchSearchResultPage` unchanged; `searchItems` adapts `SearchResultRowViewModel → LauncherItem` (`launcherItemFromSearchRow`). `/search` page unchanged except both now share `useDebouncedFetch`.
- **8.2 Ingest.** The Add session stages URL/file intent locally, freezes its
  destinations and idempotency key on explicit submit, and calls
  `addMediaFromUrl`/`uploadIngestFile` through one bounded mutation owner.
  Outcomes remain in the workbench; only explicit Open dispatches
  `requestOpenInAppPane('/media/{id}')`. The bare-URL result remains a separate,
  deliberate one-step capture target.
- **8.3 Notes.** `create-note` calls `quickCaptureDailyNote`; `CreatePanel` reuses `ProseMirrorOutlineEditor` + `useNoteEditorSession`; "Create page…" calls `createNotePage` then opens `/pages/{id}` (preserving the existing `pendingNoteFocus` behavior).
- **8.4 Browse.** `browseItems` adapts `BrowseResult → LauncherItem` (`launcherItemFromBrowseResult`); `browse-acquire` opens (`media_id` present) or adds (`url`). Web sub-results come from S7.
- **8.5 Resource graph.** Opening any resource funnels through `activateResource` + `ResourceActivation` (18-scheme grammar) — the Launcher adds no scheme and no route.
- **8.6 Workspace/panes.** All opens emit `requestOpenInAppPane`; pane creation/activation stays owned by the workspace store (`openPane`/`navigatePane`). Tab switching (`pane-activate`/`pane-close`) is a `command` target.
- **8.7 Nav.** `destinations.ts` feeds both `NAV_MODEL` (rail/sheet) and `commandItems` (`go` lane) — the two registries can no longer drift. Create-actions stay Launcher commands (not destinations).
- **8.8 Mobile sheet & overlays.** `LauncherSheet` wraps `MobileSheet`; `LauncherSurface` uses `useDialogOverlay`; both keep `useHistoryDismiss`. No new overlay primitive (P-3, N-2 of overlays module).
- **8.9 DOM/e2e contract.** Renamed ids/labels (§5) are a deliberate breaking change; `e2e/tests/command-palette.spec.ts` → `launcher.spec.ts` and the [[reference_palette_dom_contract]] memory are updated in the same slice (S8).

---

## 9. Reuse / consolidation map

| Pattern                       | Today (duplicated / leaked)                                                                                                   | After (single owner)                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input parse**               | `parsePaletteInput` (sigil) + `parseSearchInput` (operators) + `extractUrls` (tray)                                           | `parseLauncherInput` composes all three → `LauncherInput`                                                                                             |
| **Item schema**               | `PaletteItem` + `SearchResultRowViewModel` + 4 `BrowseResult` types rendered ad hoc                                           | `LauncherItem` + `launcherItemFrom{SearchRow,BrowseResult}` adapters (Launcher list only; dense pages keep their renderers — N2)                      |
| **Dispatch**                  | palette `navigate` switch + `runAction` switch (two unions, dup'd open calls)                                                 | one `dispatchTarget(target, ctx)`                                                                                                                     |
| **Destinations**              | `STATIC_COMMANDS` nav half + `NAV_MODEL` (hand-synced)                                                                        | `lib/navigation/destinations.ts`; both derive                                                                                                         |
| **Debounced fetch**           | `usePaletteController` loop + `SearchPaneBody` loop (AbortController vs requestIdRef)                                         | `useDebouncedFetch` (AbortController-only)                                                                                                            |
| **Open event + add event**    | `OPEN_COMMAND_PALETTE_EVENT` + `OPEN_ADD_CONTENT_EVENT`                                                                       | one `OPEN_LAUNCHER_EVENT` with tagged Root/Add detail                                                                                                 |
| **Add UI / note UI**          | standalone `AddContentTray` + `QuickNotePanel` modals                                                                         | direct `AddPanel`/`CreatePanel` details inside the Launcher                                                                                           |
| **Web search**                | trapped in chat (`execute_web_search` w/ persistence)                                                                         | `search_web_readonly` shared by chat tool + `GET /api/web/search`                                                                                     |
| Roving-focus keyboard         | `PaletteInput` handler + `rovingIndex.ts`                                                                                     | reuse `rovingIndex.ts`; Launcher-specific keys (Tab drill, Backspace clear-lane, Shift+Enter ask) stay in `LauncherInput` (opportunistic, not forced) |
| **Already clean (no action)** | `MobileSheet`/`useDialogOverlay`/`useHistoryDismiss`; `searchParams` serialization; `extractUrls`; `activateResource` routing | unchanged owners                                                                                                                                      |

---

## 10. Key decisions

- **D-1.** **Parse once at the boundary.** `parseLauncherInput` is the only place raw text becomes structured; downstream consumes `LauncherInput` and never re-tokenizes (`boundaries.md`).
- **D-2.** **Retrieval lanes and direct Add are different interaction shapes.**
  `open` and `search` stay distinct, while Add is a typed Launcher detail reached
  directly from navigation or matching results. It is not a lane, mode menu, or
  sigil.
- **D-3.** **Auto-suggest on hard signals; never auto-execute; AI is always an explicit row.** Resolves _explicit UI over automation_ ⊕ _AI-first_ the way Synapse does — trust the model's content, keep the human's action, show machine rows as machine.
- **D-4.** **One query model, shared.** The `search` lane and `/search` parse identical operators into one `SearchQuery`; "See all" round-trips via `searchHref`. Deletes the palette's `limit:5`/no-filter divergence.
- **D-5.** **Add/Create live inside the Launcher** as details, not separate
  modals—one surface and one focus/dismiss contract. The standalone surfaces and
  Add-specific event are deleted.
- **D-6.** **No god endpoint.** Per-lane endpoints, client fan-out (N1).
- **D-7.** **One destination registry.** `destinations.ts` ends the `NAV_MODEL`/`STATIC_COMMANDS` drift; create-actions remain commands.
- **D-8.** **Standalone web search is read-only.** Persistence stays chat-only; one provider, two callers (S7, N6).
- **D-9.** **Recency stays href-keyed.** The href is the canonical open target; ResourceRef re-keying is unjustified churn + a migration for no behavior gain (N3).
- **D-10.** **Rename to Launcher everywhere.** Hard cutover ⇒ no "palette" alias; the DOM/e2e contract change is documented and applied in the same pass (D-10 is the reason S8 exists).
- **D-11.** **`/search` and `/browse` pages survive as deep-link "see all" targets** — they share the query model, not the compact row (N2); URL-shareability is preserved.

---

## 11. Migration / data

**None.** No schema change, no migration file. Recency stays href-keyed (D-9); web search adds no table (D-8); all add/note/browse storage is unchanged. The cutover is frontend modules + one read-only backend route + one extracted service function.

---

## 12. Slices (hard cutover plan)

- **S0 — Core model + boundary parser.** Create `lib/launcher/{model,parseLauncherInput}.ts` (retrieval lanes, result sections, `LauncherItem`, `LauncherTarget`, `LauncherView/Page`, `LauncherInput`). Delete `paletteIntent.ts`. Unit-test `parseLauncherInput` (supported sigils, operators, URL hard-signal, sigil+operator combos, empty, and `+` as ordinary text rather than an Add sigil).
- **S1 — Destination registry.** Extract `lib/navigation/destinations.ts`; rebuild `NAV_MODEL` and the Launcher `go` commands from it; assert no destination string is literal in two places.
- **S2 — Providers, ranking, adapters.** Generalize to `buildLauncherItems` + `rankLauncher` (retrieval-lane `inLane`, §4.4 omnibox policy) + `launcherItemFrom{SearchRow,BrowseResult}`. Search provider carries full `SearchQuery`; Add remains a result section only.
- **S3 — Unified dispatch.** Create `dispatch.ts` merging `navigate` + `runAction`; handle `add-url`/`create-note`/`browse-acquire`/`command`; exhaustive `never` check.
- **S4 — Controller + fetch consolidation.** `useLauncherController` with Root/Actions/Create pages and a direct Add detail + three `useDebouncedFetch` fetches (history/search/browse). Create `lib/api/useDebouncedFetch.ts`; migrate `/search` page onto it.
- **S5 — Surfaces + embedded panels.** Rename `palette/*` → `launcher/*`, `Palette*` → `Launcher*`. Build direct `AddPanel`/`CreatePanel` details from the former standalone internals. Keep retrieval lane chips; Add has no chip or sigil. Delete the standalone surfaces.
- **S6 — Events + shell wiring.** Create `launcherEvents.ts` (`OPEN_LAUNCHER_EVENT` with tagged Root/Add detail); delete the old palette/Add events. Point command controls at Root and `+` at a seeded Add detail; mount one `<Launcher />`. Rename `open-palette` → `open-launcher` keybinding.
- **S7 — Standalone web search (backend).** Extract `services/web_search.search_web_readonly` (provider call + projection, no persist); refactor `execute_web_search` to wrap it; add `routes/web_search.py` (`GET /api/web/search`); register route + worker allowlist drift guard if applicable. Wire `browseItems` web sub-results.
- **S8 — DOM contract, tests, gates.** Rename ids/labels (§5); `command-palette.spec.ts` → `launcher.spec.ts`; update [[reference_palette_dom_contract]] memory; browser tests for lane chips/add/create panels; negative gates (§14).

---

## 13. Acceptance criteria

- **AC-1.** `Cmd/Ctrl-K` and command controls open Launcher Root; navigation
  `+` opens the source-first Add detail directly. No Add lane, chooser,
  standalone surface, legacy Add event, or Add deep link exists.
- **AC-2.** Pasting a URL makes "Add ⟨host⟩ to library" the top row; `Enter` ingests via `addMediaFromUrl` and opens `/media/{id}`. It is never auto-executed without selection.
- **AC-3.** Plain text in `all` shows Open + Search groups plus pinned-last Ask / Create-note / Browse-web rows; AI rows are visibly machine-labeled and never auto-run; `Shift+Enter` routes text to Ask AI.
- **AC-4.** `>`/`@`/`?` route to `go`/`open`/`ask`; retrieval lanes remain
  available through their chips. `+` is not a sigil and Add is not a chip. An
  empty retrieval lane shows its own empty state without silent fallthrough.
- **AC-5.** The `search` lane sends the full `SearchQuery` (operators/filters honored); "See all" opens `/search` with the identical query (`searchHref` round-trip). No `{ limit: 5 }` all-types fetch remains.
- **AC-6.** "Create note: ⟨text⟩" calls `quickCaptureDailyNote` and opens `/daily`;
  "Create note…" opens the embedded editor; matching URL/file/OPML results open
  the source-first Add detail with the corresponding typed focus/branch seed and
  no intermediate chooser.
- **AC-7.** `browse` shows `/browse` results and live `GET /api/web/search` web results; opening an in-library hit routes to its pane, an external hit opens externally or offers Add. `GET /api/web/search` persists nothing.
- **AC-8.** `NAV_MODEL` and Launcher `go` commands derive from `lib/navigation/destinations.ts`; no destination href is a string literal in both.
- **AC-9.** One `dispatchTarget` owns every open; grep finds no `requestOpenInAppPane`/`window.location.assign`/`activateResource` call inside Launcher components outside `dispatch.ts`.
- **AC-10.** Launcher and `/search` both fetch via `useDebouncedFetch`; no hand-rolled debounce/abort loop remains in either.
- **AC-11.** Static gates green: typecheck/lint/pyright 0; the renamed e2e
  (`launcher.spec.ts`) passes; browser tests cover retrieval lanes plus direct
  Add/Create details.

---

## 14. Negative gates (grep, CI-enforced)

- No `palette` identifier in `components/` or `lib/` except inside historical migration/doc text — `paletteModel`/`parsePaletteInput`/`PaletteItem`/`usePaletteController` are gone.
- No `OPEN_ADD_CONTENT_EVENT`, `AddContentTray`, `QuickNotePanel`, `commandPaletteEvents`, `addContentEvents` anywhere.
- No Add `LauncherLane`, lane chip, `+` sigil, chooser/menu, or deep-link
  decoder. The `"add"` result section and typed Add detail are the only Add
  identities in Launcher architecture.
- No `open-palette` key id; `open-launcher` only.
- No `fetchSearchResultPage(.., { limit: 5 ` and no all-types/no-filter fetch outside `/search` and the Launcher's full-`SearchQuery` call.
- No `requestOpenInAppPane(`/`activateResource(`/`window.location.assign(` inside `components/launcher/**` except `dispatch.ts`.
- No second debounce-timer + `AbortController`/`requestIdRef` loop outside `lib/api/useDebouncedFetch.ts`.
- No nav destination href literal (e.g. `"/libraries"`, `"/oracle"`) in both `navModel.ts` and the Launcher providers — only in `destinations.ts`.
- `persist_web_search_run` is called only from the chat tool path, never from `routes/web_search.py`.

---

## 15. Test plan

- **Unit (.test.ts, node):** `parseLauncherInput` (sigil peel, operator absorption into `SearchQuery`, URL hard-signal, `Shift+Enter` text, malformed→text); `rankLauncher` (lane filter matrix, URL-top, pinned-last order, empty-lane state); `dispatchTarget` (each target kind → correct seam, exhaustive `never`); `launcherItemFrom{SearchRow,BrowseResult}` adapters; `destinations.ts` ↔ `NAV_MODEL` parity.
- **Browser (.test.tsx, Chromium):** retrieval lane chips/sigils; URL-paste top row; blended interpretations; direct Add/Create details open inside the surface and dismiss correctly (focus-trap + history); search lane honors operators; "See all" href.
- **Backend (integration):** `GET /api/web/search` returns projected citations and writes no `resource_external_snapshots`; `search_web_readonly` parity with the chat tool's projection; chat `execute_web_search` still persists.
- **E2E (`launcher.spec.ts`):** Root/Add entry contracts; explicit
  Review→Submit→retained outcome→Open; bare-URL one-step capture; create-note
  opens `/daily`; `Cmd-K` → type → open existing.

---

## 16. Files

**Created (frontend):** `lib/launcher/{model,parseLauncherInput,providers,ranking,actions,dispatch,adapters,launcherEvents}.ts`; `components/launcher/{Launcher,LauncherSurface,LauncherSheet,LauncherInput,LauncherList,LauncherRow,LauncherLaneChips,AddPanel,CreatePanel}.tsx`, `useLauncherController.ts`; `lib/navigation/destinations.ts`; `lib/api/useDebouncedFetch.ts`.

**Created (backend):** `python/nexus/api/routes/web_search.py`; `python/nexus/services/web_search.py` (`search_web_readonly`, extracted) — or split the existing `services/agent_tools/web_search.py`.

**Modified (frontend):** `app/(authenticated)/AuthenticatedShell.tsx` (mount `<Launcher/>`, drop `<AddContentTray/>`); `components/appnav/{NavRail,NavTopBar,navModel}.tsx`/`.ts` (open Launcher, derive from `destinations.ts`); `app/(authenticated)/search/SearchPaneBody.tsx` (use `useDebouncedFetch`); `lib/keybindings.ts` (`open-launcher`); `app/(authenticated)/browse/*` (unchanged behavior; shares query model only).

**Modified (backend):** `services/agent_tools/web_search.py` (wrap `search_web_readonly`); `api/router` registration; deploy worker allowlist drift guard if touched.

**Deleted (frontend):** `components/palette/*` (renamed → `launcher/`); `components/AddContentTray.tsx`; `components/QuickNotePanel.tsx`; `components/commandPaletteEvents.ts`; `components/addContentEvents.ts`; `lib/search`-`palette` `paletteIntent.ts`.

**Tests:** `e2e/tests/command-palette.spec.ts` → `launcher.spec.ts`; new browser/unit suites per §15.

**Memory:** update [[reference_palette_dom_contract]] (ids/labels renamed); add a launcher project memory on merge.

---

## 17. Risks & mitigations

- **R1. Rename churn (D-10) is broad.** Mitigation: mechanical, gate-enforced (§14 "no `palette`"); do it as one slice (S5/S8) with the e2e + DOM-contract update in the same commit so nothing references the old names mid-flight.
- **R2. Add on a mobile sheet.** A mixed queue and filing controls can become
  dense. Mitigation: source-first progressive disclosure, compact destination
  summary, one scroll body, stacked sticky actions, and one lifted session that
  survives viewport changes. Verify the mobile-sheet history contract.
- **R3. Disambiguation feels wrong (Dia failure mode).** Over-eager auto-routing erodes trust. Mitigation: D-3 — auto-_suggest_ only on hard URL signals, never auto-execute; default ambiguous text to search-inclusive; AI strictly opt-in. Tune ranking weights behind the deterministic policy, not a classifier (N4).
- **R4. Web-search decouple leaks persistence.** Mitigation: extract `search_web_readonly` as pure read; gate (§14) that `persist_web_search_run` is unreachable from the route; integration test asserts zero snapshot rows.
- **R5. Losing search/browse page richness.** Mitigation: N2 keeps the dense renderers and deep links; only the query model + serialization are shared. "See all" parity is an AC (AC-5).
- **R6. Concurrent agent shares this checkout.** Mitigation (per repo memory): stage explicitly, never `git add -A`; coordinate the `palette/`→`launcher/` rename to avoid stepping on in-flight edits.

```

```
