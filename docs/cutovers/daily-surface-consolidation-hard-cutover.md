# Today Dies as a Surface — Daily Pages Are Just Pages — Hard Cutover

**Status:** Spec · **Rev 1** · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior.

## One-line

Delete the Today surface (`DailyNotePaneBody`, the `daily`/`dailyDate` pane routes, the Today nav entry); keep `daily_note_pages` and the backend lookup; make "today" a verb — a Notes-pane button, a launcher command, a keybinding — that resolves-or-creates today's page then opens it in the ordinary Page pane.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** The universal-launcher cutover is landed (`docs/cutovers/universal-launcher-hard-cutover.md`). `dispatchTarget` (`lib/launcher/dispatch.ts`) is the sole opener; `DESTINATIONS` (`lib/navigation/destinations.ts`) is the sole destination registry. This spec adds one new dispatch target kind and removes one destination entry.
- **P-2.** `PagePaneBody` (`app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`) accepts `pageIdOverride` and `initialPage` props and renders the ProseMirror editor. This is verified: `DailyNotePaneBody.tsx:112–118` already delegates to it.
- **P-3.** `daily_note_pages` table (`db/models.py:251–292`) exists with `user_id`, `local_date`, `page_id`, `time_zone`, unique on `(user_id, local_date)` and `(user_id, page_id)`. The service layer (`services/notes.py`) already exposes `resolve_daily_note_page_ref`, `get_daily_note`, and `get_daily_note_for_today`. Nothing here migrates or deletes.
- **P-4.** The dawn-write cutover (#4) renders `DawnWriteBlock` above `PagePaneBody` in `DailyNotePaneBody`'s return. **When this cutover deletes `DailyNotePaneBody`, the dawn-write spec's host moves to `PagePaneBody` — dawn-write must land after this spec, or its host must be updated as part of this PR.** The `DawnWriteBlock` API contract is stable regardless of host.

---

## 1. Problem (grounded diagnosis)

Two nav entries, one editor, one model:

- **`DESTINATIONS` (line 57–63, `lib/navigation/destinations.ts`)** declares a `today` entry with `slot: "primary"` pointing to `href: "/daily"`. The Notes entry (lines 65–71) points to `/notes`. Both reach the same ProseMirror editor; neither is a distinct data domain.
- **`DailyNotePaneBody.tsx` (32–119)** is a date-resolution wrapper. It calls `fetchDailyNotePage(localDate)`, extracts the `page.id`, and immediately delegates to `<PagePaneBody pageIdOverride={page.id} initialPage={page} />`. Its only logic beyond the delegation: validate the `localDate` param, handle a `shellPageId` shortcut, and publish a `daily-open-yesterday` chrome option (lines 69–82) that navigates to `/daily/{date-1}`. That is the entire surface.
- **`paneRouteModel.ts`** declares two route IDs — `"daily"` (line 45) and `"dailyDate"` (line 46) — with separate `PANE_ROUTE_MODELS` entries (lines 219–236) and `PANE_ROUTE_META` entries (lines 143–150 in `paneRouteTable.ts`). Both render `DailyNotePaneBody` via `paneRenderRegistry.tsx:30–31`.
- **`paneResourceLocator.ts`** carries two locator kinds (`daily_note_today`, `daily_note_date`, lines 11–12) purely to pre-resolve the shell resource for the daily pane. Once the pane dies, these locator kinds have no frontend caller.
- **`lib/panes/paneResourceLoaders.ts:36`** explicitly notes daily is NOT prefetchable (needs browser timezone). The absence of server-side prefetch means the daily pane is strictly client-side resolved — the same as `PagePaneBody` with a `fetchDailyNotePage` call ahead of it.

Net: the Today surface is a 119-line file doing a lookup then delegating. The lookup should be a verb, not a surface.

---

## 2. Target behavior (user-facing)

- The Today nav rail entry is gone. The Notes entry is the sole entry point for the notes domain.
- "Open today" is reachable three ways: a **Today button in the Notes pane toolbar**, a **launcher command** ("Open today" in the create/go sections), and a **keybinding** (the existing `today` action id, user-assignable, no default).
- Opening today: the verb calls `GET /api/notes/daily/{localDate}?time_zone=…`, gets the `page.id`, then navigates to `/pages/{id}`. The page opens in `PagePaneBody`. No intermediate pane, no double-render.
- **Date navigation (prev/next day)** lives in `PagePaneBody` as chrome options — shown only when the loaded page has `dailyNote` set. The "Open yesterday" option opens the previous day's page via the same `fetchDailyNotePage` → `/pages/{id}` path.
- **`/daily` and `/daily/[localDate]` routes** (bookmarks, browser history, mobile deep links) redirect to `/notes`. The date context is lost on redirect — this is acceptable; date navigation is now an in-pane affordance.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Delete `DailyNotePaneBody`, its tests, the `daily`/`dailyDate` pane route IDs, and the Today destination entry exhaustively.
- **G2.** Extend `NotePageOut` with `daily_note: { local_date: str } | None` so `PagePaneBody` knows when a page is a daily page (for date-nav chrome) and dawn-write knows when its host is a daily page.
- **G3.** One new dispatch target: `kind: "open-today"` in `LauncherActionTarget`, handled in `dispatchTarget` via `fetchDailyNotePage` → `requestOpenInAppPane('/pages/{id}')`.
- **G4.** Notes pane gains a "Today" button in its toolbar that dispatches `open-today`.
- **G5.** The `today` keybinding stays bindable (`BINDABLE_ACTIONS`) with a non-destination dispatch path in the launcher keybinding loop.
- **G6.** Server-side redirects: `app/(authenticated)/daily/page.tsx` and `app/(authenticated)/daily/[localDate]/page.tsx` both redirect to `/notes`.
- **G7.** All callers updated: `CreatePanel.openToday`, `ShareCapture`, `dispatch.ts` `create-note` action — all switch from `href: "/daily"` to `target: { kind: "open-today" }`.

### Non-goals

- **N1.** No migration. `daily_note_pages` table stays; the backend service and FastAPI routes stay; the BFF `GET /api/notes/daily` and `GET /api/notes/daily/[localDate]` routes stay (used by `fetchDailyNotePage`).
- **N2.** No new date-navigation UI beyond chrome options. A full calendar-picker or date-range browser is a future horizon.
- **N3.** No change to `quick_capture` or the quick-note composer in the launcher (the notes goes to today's page regardless of how the user opened it).
- **N4.** No change to the backend locator types (`DailyNoteTodayLocatorIn`, `DailyNoteDateLocatorIn` in `schemas/resource_items.py`). They are still used by the workspace locator resolution for external callers. Only the frontend side (`paneResourceLocator.ts`) loses its `daily_note_today`/`daily_note_date` branches.

---

## 4. Architecture and final state

### 4.1 Ownership map

| Concern | Final owner | Replaces |
|---|---|---|
| "Open today" verb | `lib/notes/openToday.ts` (`openTodayPage()`) | `DailyNotePaneBody`, `CreatePanel.openToday`, `ShareCapture`'s `/daily` path |
| Dispatch target `kind: "open-today"` | `lib/launcher/dispatch.ts` (new case in switch) | `href: "/daily"` dispatch |
| Notes pane today button | `app/(authenticated)/notes/NotesPaneBody.tsx` | Today nav entry |
| Keybinding dispatch (non-destination) | `useLauncherController.ts` keybinding loop | destination `today` dispatch |
| Date-nav chrome options | `PagePaneBody` (reads `page.dailyNote`) | `DailyNotePaneBody`'s `openYesterday` chrome option |
| Daily page identity | `NotePageOut.daily_note` + `NotePage.dailyNote` | implicit in `/daily` route |
| /daily redirects | Next.js server redirect in `daily/page.tsx` + `[localDate]/page.tsx` | `return null` shell pages |

### 4.2 `openTodayPage()` — the new verb primitive

```ts
// lib/notes/openToday.ts
export async function openTodayPage(): Promise<void> {
  const page = await fetchDailyNotePage(todayLocalDate());
  requestOpenInAppPane(`/pages/${page.id}`, { titleHint: page.title });
}
```

`dispatchTarget` for `kind: "open-today"` calls this. `NotesPaneBody`'s Today button calls this. The keybinding loop calls this. One implementation, three entry points.

### 4.3 `NotePageOut.daily_note` — the minimal read

Backend `_page_out` in `services/notes.py` already receives the viewer's `page` ORM object. Add a single scalar query against `daily_note_pages`:

```python
daily_entry = db.scalar(
    select(DailyNotePage.local_date).where(
        DailyNotePage.page_id == page.id,
        DailyNotePage.user_id == viewer_id,
    )
)
```

`NotePageOut` gains a `daily_note: DailyNotePageSummaryOut | None` field (new schema class with just `local_date: date`). `PagePaneBody` reads `page.dailyNote?.localDate` and if set, publishes chrome options for "Open yesterday" and "Open tomorrow" that call `fetchDailyNotePage(shiftLocalDate(localDate, ±1))` then navigate to the result.

### 4.4 Keybinding dispatch update (D-5)

`useLauncherController.ts:503–514` currently dispatches keybindings by looking them up in `DESTINATIONS`. After removing `today` from DESTINATIONS, add a fallthrough inside the for-loop, before the `if (!destination) continue` guard:

```ts
// inside the for loop, when no destination matches the action id:
if (actionId === "today") {
  event.preventDefault();
  void openTodayPage().catch(fail);
  return;
}
// then the existing guard:
if (!destination) continue;
```

`actionId` is a loop variable and is only in scope inside the `for (const [actionId, combo] of …)` body; the check must live there, not after the loop.

`today` stays in `BINDABLE_ACTIONS` (`KeybindingsPaneBody.tsx:34`) and in `keybindings.ts`'s `STORAGE_KEY` namespace (no default binding, user-assignable).

---

## 5. Data model / migration

No Alembic migration. `daily_note_pages` is untouched. The only change is a scalar join in `_page_out` (`services/notes.py`) and a new optional field on `NotePageOut` / `DailyNotePageSummaryOut` in `schemas/notes.py`.

---

## 6. API

No new FastAPI routes. No new BFF routes. The following existing routes are **kept**:
- `GET /api/notes/daily` → BFF → `GET /notes/daily` (used by `fetchDailyNotePage` for today)
- `GET /api/notes/daily/{localDate}` → BFF → `GET /notes/daily/{local_date}` (used by `fetchDailyNotePage`)
- `GET /notes/daily` and `GET /notes/daily/{local_date}` in `python/nexus/api/routes/notes.py` (lines 75–113)

The following existing routes **die** (Next.js app directory, not FastAPI):
- `app/(authenticated)/daily/page.tsx` → becomes `redirect('/notes')`
- `app/(authenticated)/daily/[localDate]/page.tsx` → becomes `redirect('/notes')`

---

## 7. Frontend

### 7.1 New file: `lib/notes/openToday.ts`

```ts
import { fetchDailyNotePage } from "@/lib/notes/api";
import { todayLocalDate } from "@/lib/localDate";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";

export async function openTodayPage(): Promise<void> {
  const page = await fetchDailyNotePage(todayLocalDate());
  requestOpenInAppPane(`/pages/${page.id}`, { titleHint: page.title });
}
```

### 7.2 `lib/launcher/model.ts` — new dispatch target kind

Add `{ kind: "open-today" }` to the `LauncherActionTarget` union (alongside `"href"`, `"resource"`, etc.).

### 7.3 `lib/launcher/dispatch.ts`

Add a case for `"open-today"`:

```ts
case "open-today":
  await openTodayPage();
  return;
```

Replace the existing `"create-note"` case's `requestOpenInAppPane("/daily", ...)` with `await openTodayPage()` (the note is already captured; then open the page).

### 7.4 `lib/navigation/destinations.ts`

Remove the `today` entry (lines 57–63). The `notes` entry already matches `/notes/` and `/pages/` prefixes (lines 65–71); daily pages reached via `/pages/{id}` now fall under the `notes` active state naturally.

### 7.5 `lib/panes/paneRouteModel.ts`

- Remove `"daily"` and `"dailyDate"` from the `PaneRouteId` union (lines 45–46).
- Remove the two `route({...})` entries (lines 219–236) from `PANE_ROUTE_MODELS`.

### 7.6 `lib/panes/paneRouteTable.ts`

Remove the `daily` and `dailyDate` entries from `PANE_ROUTE_META` (lines 143–150).

### 7.7 `lib/panes/paneRenderRegistry.tsx`

Remove `daily` and `dailyDate` entries (lines 30–31). The `Record<PaneRouteId, PaneLoader>` type now enforces the deletion.

### 7.8 `lib/panes/paneResourceLocator.ts`

Remove `daily_note_today` and `daily_note_date` from the `PaneResourceLocator` union (lines 11–12) and remove the two `if (route.id === "daily")` / `if (route.id === "dailyDate")` branches (lines 47–59).

### 7.9 `app/(authenticated)/notes/NotesPaneBody.tsx`

Add a "Today" button alongside the "Create page" form in the toolbar. On click, dispatches `openTodayPage()`. The button lives inside the existing `<form>` area or as a sibling action. Uses the existing `Button` component.

### 7.10 `app/(authenticated)/pages/[pageId]/PagePaneBody.tsx`

After the page loads, read `page.dailyNote?.localDate`. If set:
- Publish chrome options `"Open yesterday"` (navigate to yesterday's page via `fetchDailyNotePage(shiftLocalDate(localDate, -1))`) and `"Open tomorrow"` (same for +1) via `usePaneChromeOverride`.
- The dawn-write block (from sibling #4) renders above the editor whenever `page.dailyNote` is set; the `PagePaneBody` hosts it.

### 7.11 `components/launcher/CreatePanel.tsx`

Replace the `openToday` callback (lines 116–119) to dispatch `{ kind: "open-today" }` through `onOpen` instead of `{ kind: "href", href: "/daily", ... }`.

### 7.12 `app/share/ShareCapture.tsx`

Replace `path: "/daily"` (line 68) with `path: "/notes"` (the quick-capture already wrote to today's page; the user can navigate there from Notes).

Also update the label conditional at line 201 — change `result.path === "/daily"` to `result.path === "/notes"` so the "Open" label continues to render for text captures that now land on `/notes`:

```ts
// line 201 before:
{result.path === "/daily" ? "Open" : "Open in Nexus"}
// line 201 after:
{result.path === "/notes" ? "Open" : "Open in Nexus"}
```

Without this change the conditional always evaluates false (result.path is now "/notes"), the link renders "Open in Nexus", and the e2e assertion `getByRole("link", { name: "Open" })` at `e2e/tests/share.spec.ts:23` would find nothing.

### 7.13 `components/launcher/useLauncherController.ts`

Inside the for-loop at line 503, before the `if (!destination) continue` guard (line 507), insert the `today` keybinding fallthrough as described in §4.4.

### 7.14 `components/appnav/navActive.test.ts`

Remove the assertion `expect(resolve("/daily/2026-06-01")).toBe("today")` (line 43). Add assertions confirming `/pages/{any-id}` matches `notes`.

### 7.15 `lib/panes/paneRouteTable.test.tsx`

Remove the "resolves daily note routes as document panes" test (lines 67–88) and the `/daily` + `/daily/2026-05-06` entries from the route-alignment test (lines 134–135).

### 7.16 `lib/panes/paneResourceLocator.test.ts`

Remove the `"builds product alias locators for author and daily routes"` test entry for daily (lines 57–63).

### 7.17 `lib/launcher/launcherCutover.guards.test.ts`

Remove `/daily` from the `hrefs` array in the AC-8 test (line 101). Add a gate asserting `/daily` does not appear as an `href` in `destinations.ts`.

---

## 8. Key decisions

**D-1: Date navigation lives in `PagePaneBody`, gated by `page.dailyNote`.** Rejected: date-nav as a pane-level chrome row independent of page metadata (would require reading `daily_note_pages` in the pane host, not the service). Rejected: no date navigation at all (existing users depend on yesterday access). The `dailyNote` field is the minimal data contract.

**D-2: `/daily` and `/daily/[localDate]` redirect to `/notes`, not to `/pages/{resolved-id}`.** A server-side redirect to `/pages/{id}` would require a DB call in a Next.js server component with a user session and timezone. The session/timezone dependency is non-trivial (the server bootstrap doesn't have the browser timezone). Redirecting to `/notes` is correct: the user can click "Today" once there. External links / bookmarks land on the Notes surface; date context is not recoverable server-side without the browser timezone.

**D-3: `today` keybinding survives as a non-destination built-in.** Rejected: making `today` a DESTINATIONS entry with `slot: undefined` (the keybinding dispatch would navigate to `href: "/daily"` which no longer exists as a pane route). Rejected: deleting the keybinding entirely (existing users who bound a key lose it). The non-destination fallthrough in the keybinding loop is two lines.

**D-4: `openTodayPage()` is a standalone module, not inlined in the dispatch switch.** All three call sites (dispatch, Notes pane, keybinding) call the same function. Duplication in dispatch.ts would violate the one-implementation rule.

**D-5: `NotePageOut.daily_note` via a scalar join in `_page_out`, not a separate API endpoint.** The page is already loaded by `fetchNotePage`; a scalar `SELECT local_date FROM daily_note_pages WHERE page_id=…` adds one indexed lookup (FK index on `page_id`). Rejected: a separate `GET /api/notes/pages/{id}/daily-status` endpoint (extra round-trip, extra BFF route).

**D-6: BFF routes `/api/notes/daily` and `/api/notes/daily/[localDate]` stay.** `fetchDailyNotePage` is still called for the `open-today` verb and for the date-nav chrome options. Deleting them would require rewriting the frontend to call `/api/resource-items/resolve` instead — more change for no gain.

**D-7: `ShareCapture.tsx` path changes to `/notes`, not a full `openTodayPage()` call.** `ShareCapture` runs in the share-sheet context where `requestOpenInAppPane` may be unavailable; the "Open" button navigates via a plain `href` (line 201: `result.path`). Since the note is already persisted, `/notes` is a correct landing. If full today-navigation is desired from the share sheet, it's a follow-up.

---

## 9. What dies (exhaustive deletion list)

**Files deleted:**
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx`
- `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.test.tsx`
- `apps/web/src/app/(authenticated)/daily/__screenshots__/` (screenshot directory)

**Files with content deleted/replaced:**
- `app/(authenticated)/daily/page.tsx` — `return null` → `redirect('/notes')`
- `app/(authenticated)/daily/[localDate]/page.tsx` — `return null` → `redirect('/notes')`

**Identifiers deleted from source:**
- `PaneRouteId: "daily" | "dailyDate"` (paneRouteModel.ts)
- `PANE_ROUTE_MODELS` entries for `daily` and `dailyDate` (paneRouteModel.ts)
- `PANE_ROUTE_META` entries for `daily` and `dailyDate` (paneRouteTable.ts)
- `PANE_LOADERS["daily"]` and `PANE_LOADERS["dailyDate"]` (paneRenderRegistry.tsx)
- `PaneResourceLocator: { kind: "daily_note_today" }` and `{ kind: "daily_note_date" }` (paneResourceLocator.ts)
- `resolvePaneResourceLocator` branches for `daily`/`dailyDate` (paneResourceLocator.ts)
- `DESTINATIONS` entry `id: "today"` (destinations.ts)
- `fetchDailyNotePage` import from DailyNotePaneBody (already disappears with file deletion)
- `shiftLocalDate` import from DailyNotePaneBody (same)
- `dailyNotePageCacheKey` function (DailyNotePaneBody)
- `pageIdFromResourceRef` function (DailyNotePaneBody — was local-only)

**Tests deleted or updated:**
- All tests in `DailyNotePaneBody.test.tsx` (deleted with file)
- `navActive.test.ts:43` — `today` daily prefix match assertion
- `paneRouteTable.test.tsx:67–88` — daily route resolution test
- `paneRouteTable.test.tsx:134–135` — `/daily` entries in the alignment test
- `paneResourceLocator.test.ts:57–63` — daily locator assertions
- `launcherCutover.guards.test.ts:101` — `/daily` in hrefs gate
- `paneWarm.test.tsx:46–58` — "warms only the chunk for an excluded pane" test; after removing `"daily"` from `PaneRouteId`, `resolvePaneRouteModel("/daily")` returns `{ id: "unsupported" }` and the hook never calls `preloadPane`, breaking the assertion. Replace the `/daily` exemplar with a route that stays in `PaneRouteId` but has no `paneResourceLoader` entry (e.g. `/browse`), or substitute any other non-prefetchable route, to preserve the AC-8 test intent.
- `CreatePanel.test.tsx:139–144` and `163–168` — both assertions expect `{ kind: "href", href: "/daily", externalShell: false, titleHint: "Today" }`; update to `{ kind: "open-today" }` after §7.11 change.
- `bootstrap.server.test.ts:412` — uses `"/daily"` as the "unprefetched route" fixture; after the cutover `/daily` is a redirect URL, not a pane route. Change the fixture to a non-redirecting non-prefetchable path (e.g. `"/chat/new"`) so the test intent remains legible.
- `e2e/tests/share.spec.ts:23–26` — asserts `getByRole("link", { name: "Open" }).toHaveAttribute("href", "/daily")`. After §7.12 changes the captured path to `/notes`, update both assertions: `href` → `"/notes"`; the link name stays `"Open"` (because the label conditional is also updated in §7.12).

---

## 10. Sibling cutovers and sequencing

| # | Sibling | Dependency |
|---|---|---|
| #2 | running-journal | Must remove `daily: "notes"` and `dailyDate: "notes"` from `ROUTE_SECTION` in `standingHead.ts` after this lands — those route IDs are deleted from `PaneRouteId`, making them a compile error in the exhaustive map. |
| #4 | dawn-write | Dawn write renders `DawnWriteBlock` above the editor in `DailyNotePaneBody`. After this cutover, the host is `PagePaneBody`. Dawn-write **must** land after this spec and update its render site to `PagePaneBody` (gated on `page.dailyNote`). The `DawnWriteBlock` component and API contract are host-agnostic. |
| #6 | browse-surface-deletion | No dependency. Both delete nav destinations from `DESTINATIONS`. Order does not matter. |

---

## 11. Slices

**S0 — Backend: `NotePageOut.daily_note` field**
Add `DailyNotePageSummaryOut(BaseModel)` to `schemas/notes.py` with one field `local_date: date`. Add `daily_note: DailyNotePageSummaryOut | None` to `NotePageOut`. Update `_page_out` in `services/notes.py` to do a scalar `SELECT local_date FROM daily_note_pages WHERE page_id = :pid AND user_id = :uid`.
Verification: unit test asserts that `get_page(db, viewer_id, daily_page.id).daily_note.local_date == expected_date` and that a non-daily page returns `daily_note = None`.

**S1 — Frontend types: `NotePage.dailyNote`**
Add `dailyNote: { localDate: string } | null` to the `NotePage` interface in `lib/notes/api.ts` (line 67). `NotePageSummary` — defined in `lib/notes/normalize.ts` — is the list-shape and does **not** get `dailyNote`; the backend `NotePageSummaryOut` list endpoint does not emit `daily_note`. Update `normalizePage` in `lib/notes/api.ts` to read `daily_note` from the raw API response. Add `lib/notes/openToday.ts`.
Verification: unit test (`lib/notes/api.test.ts`) asserts `normalizePage` populates `dailyNote.localDate` when `daily_note` is present and that the `NotePageSummary` shape is not widened.

**S2 — `PagePaneBody` date-nav chrome options**
Read `page.dailyNote?.localDate` after page load. If set, use `usePaneChromeOverride` to publish `"Open yesterday"` and `"Open tomorrow"` options, each calling `fetchDailyNotePage(shiftLocalDate(localDate, ±1))` then `router.push('/pages/{id}')`.
Verification: browser test renders `PagePaneBody` with a page carrying `dailyNote: { localDate: "2026-07-07" }` and asserts the chrome options appear; renders without `dailyNote` and asserts they are absent.

**S3 — `open-today` dispatch target + Notes pane button**
Add `{ kind: "open-today" }` to `LauncherActionTarget`. Add case in `dispatchTarget`. Add "Today" button to `NotesPaneBody` toolbar. Update `CreatePanel.openToday` to dispatch `open-today`. Update `useLauncherController.ts` keybinding loop with `today` fallthrough.
Verification: unit test mocks `fetchDailyNotePage` and asserts `dispatchTarget({ kind: "open-today" }, ctx)` navigates to `/pages/{resolved-id}`. Browser test asserts the Today button is visible in the Notes pane and triggers the navigation.

**S4 — Delete daily surface + nav entry**
Remove `DailyNotePaneBody.tsx`, `DailyNotePaneBody.test.tsx`, `__screenshots__/`. Remove `today` from `DESTINATIONS`. Remove `daily`/`dailyDate` from `PaneRouteId`, `PANE_ROUTE_MODELS`, `PANE_ROUTE_META`, `PANE_LOADERS`, `paneResourceLocator.ts`. Replace `daily/page.tsx` and `daily/[localDate]/page.tsx` with redirects. Update `ShareCapture.tsx` path. Remove daily from `paneRouteTable.test.tsx`, `navActive.test.ts`, `paneResourceLocator.test.ts`.
Verification: `bun typecheck` passes. All test suites pass. The deleted `DailyNotePaneBody.test.tsx` is gone; its formerly-tested behaviors (date validation, chrome options) are now covered by S2 + S3.

**S5 — Guards test**
Add negative-gate assertions to `launcherCutover.guards.test.ts` (or a new `dailyCutover.guards.test.ts`): no source file under `src/` imports `DailyNotePaneBody`; `DESTINATIONS` in `destinations.ts` has no entry with `id: "today"`; `paneRouteModel.ts` has no `"daily"` in `PaneRouteId`; no source file references `href: "/daily"` outside of the redirect file.
Verification: the guard tests are green.

---

## 12. Acceptance criteria

- **AC-1.** The Today nav entry is absent from the rail and mobile sheet. `navActive.test.ts` has no `today` active-state assertion.
- **AC-2.** Navigating to `/daily` in any browser returns a redirect to `/notes` (HTTP 307 or Next.js client redirect).
- **AC-3.** Navigating to `/daily/2026-07-07` redirects to `/notes`.
- **AC-4.** The Notes pane contains a visible "Today" button. Clicking it opens a `PagePaneBody` pane whose URL is `/pages/{resolved-uuid}`.
- **AC-5.** The Launcher's Create section contains an "Open today" command that, when selected, opens `/pages/{today-id}`.
- **AC-6.** The `today` keybinding, when bound by the user and triggered, opens `/pages/{today-id}`.
- **AC-7.** A daily page opened via the Today verb shows "Open yesterday" and "Open tomorrow" chrome options.
- **AC-8.** A non-daily page opened directly has no date-nav chrome options.
- **AC-9.** `DailyNotePaneBody.tsx` does not exist in the working tree.
- **AC-10.** `PaneRouteId` does not include `"daily"` or `"dailyDate"`. TypeScript typecheck is clean.
- **AC-11.** The quick-note composer's "Open today" button (in the launcher Create panel) navigates to `/pages/{id}`, not `/daily`.
- **AC-12.** `daily_note_pages` table remains untouched; `GET /notes/daily` and `GET /notes/daily/{date}` FastAPI routes still respond 200 for valid authenticated requests.

---

## 13. Negative gates (grep-able)

```bash
# G1: DailyNotePaneBody must not exist
! find apps/web/src -name "DailyNotePaneBody*"

# G2: No source file may import from the deleted module
! grep -r "DailyNotePaneBody" apps/web/src --include="*.ts" --include="*.tsx"

# G3: today destination must not appear in DESTINATIONS
! grep -n '"today"' apps/web/src/lib/navigation/destinations.ts | grep 'id:'

# G4: "daily" and "dailyDate" must not appear in PaneRouteId
! grep -n '"daily"\|"dailyDate"' apps/web/src/lib/panes/paneRouteModel.ts

# G5: href /daily must not appear in dispatch or providers (except the redirect file itself)
! grep -rn 'href.*"/daily"' apps/web/src/lib apps/web/src/components --include="*.ts" --include="*.tsx"

# G6: daily_note_today and daily_note_date locator kinds must not appear in frontend
! grep -rn "daily_note_today\|daily_note_date" apps/web/src --include="*.ts" --include="*.tsx"

# G7: Backend daily routes still exist
grep -q "get_daily_note_for_today" python/nexus/api/routes/notes.py
grep -q "get_daily_note_by_date" python/nexus/api/routes/notes.py
```

---

## 14. Test plan

1. **Unit (node):** `lib/notes/api.test.ts` — `normalizePage` handles `daily_note` field. `lib/launcher/dispatch.test.ts` (if exists) — `open-today` case navigates to `/pages/{id}`.
2. **Browser (Chromium):** `NotesPaneBody` — Today button visible and triggers navigation. `PagePaneBody` — chrome options present/absent by `dailyNote`. `CreatePanel` — "Open today" dispatches `open-today`.
3. **Guards (unit/node):** `dailyCutover.guards.test.ts` — G1–G7 assertions above.
4. **Typecheck:** `bun typecheck` — `PaneRouteId` exhaustive maps in `paneRenderRegistry`, `paneRouteTable`, `standingHead.ts` (sibling #2) all compile clean after removing `daily`/`dailyDate`.
5. **Integration:** Manual verification: navigate to `/daily`, confirm redirect to `/notes`; click Today, confirm `/pages/{uuid}` opens with the correct date title; open yesterday, confirm previous day's page loads.
6. **E2e (Playwright):** `e2e/tests/share.spec.ts:23–26` asserts `href="/daily"` on the "Open" link — this test must be updated as described in §7.12 and §9. Update the `href` assertion to `"/notes"`; the link name stays `"Open"` because the label conditional at `ShareCapture.tsx:201` is also updated to check for `"/notes"`.

---

## 15. Files (touched / created / deleted)

| File | Action |
|---|---|
| `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.tsx` | **DELETE** |
| `apps/web/src/app/(authenticated)/daily/DailyNotePaneBody.test.tsx` | **DELETE** |
| `apps/web/src/app/(authenticated)/daily/__screenshots__/` | **DELETE** (dir) |
| `apps/web/src/app/(authenticated)/daily/page.tsx` | **EDIT** → server redirect to `/notes` |
| `apps/web/src/app/(authenticated)/daily/[localDate]/page.tsx` | **EDIT** → server redirect to `/notes` |
| `apps/web/src/lib/notes/openToday.ts` | **CREATE** |
| `apps/web/src/lib/notes/api.ts` | **EDIT** — add `dailyNote` to `NotePage`, update `normalizePage` |
| `apps/web/src/lib/navigation/destinations.ts` | **EDIT** — remove `today` entry |
| `apps/web/src/lib/panes/paneRouteModel.ts` | **EDIT** — remove `daily`/`dailyDate` from union + `PANE_ROUTE_MODELS` |
| `apps/web/src/lib/panes/paneRouteTable.ts` | **EDIT** — remove `daily`/`dailyDate` from `PANE_ROUTE_META` |
| `apps/web/src/lib/panes/paneRenderRegistry.tsx` | **EDIT** — remove `daily`/`dailyDate` entries |
| `apps/web/src/lib/panes/paneResourceLocator.ts` | **EDIT** — remove `daily_note_today`/`daily_note_date` |
| `apps/web/src/lib/launcher/model.ts` | **EDIT** — add `open-today` target kind |
| `apps/web/src/lib/launcher/dispatch.ts` | **EDIT** — `open-today` case; update `create-note` |
| `apps/web/src/components/launcher/useLauncherController.ts` | **EDIT** — `today` keybinding fallthrough |
| `apps/web/src/components/launcher/CreatePanel.tsx` | **EDIT** — `openToday` → `open-today` dispatch |
| `apps/web/src/app/share/ShareCapture.tsx` | **EDIT** — path `/daily` → `/notes` |
| `apps/web/src/app/(authenticated)/notes/NotesPaneBody.tsx` | **EDIT** — add Today button |
| `apps/web/src/app/(authenticated)/pages/[pageId]/PagePaneBody.tsx` | **EDIT** — date-nav chrome options |
| `apps/web/src/components/appnav/navActive.test.ts` | **EDIT** — remove `today` assertion |
| `apps/web/src/lib/panes/paneRouteTable.test.tsx` | **EDIT** — remove daily route tests |
| `apps/web/src/lib/panes/paneResourceLocator.test.ts` | **EDIT** — remove daily locator assertions |
| `apps/web/src/lib/launcher/launcherCutover.guards.test.ts` | **EDIT** — remove `/daily` from hrefs gate |
| `apps/web/src/lib/panes/paneIdentity.test.ts` | **EDIT** — remove `daily_note_date` locator assertion (line 80) |
| `apps/web/src/lib/notes/api.test.ts` | **EDIT** — add `dailyNote` normalization test |
| `apps/web/src/lib/panes/paneWarm.test.tsx` | **EDIT** — replace `/daily` exemplar in AC-8 test (lines 46–58) with a non-prefetchable route that stays in `PaneRouteId` (e.g. `/browse`) |
| `apps/web/src/components/launcher/CreatePanel.test.tsx` | **EDIT** — update `onOpen` assertions (lines 139–144, 163–168) from `{ kind: "href", href: "/daily", … }` to `{ kind: "open-today" }` |
| `apps/web/src/lib/workspace/bootstrap.server.test.ts` | **EDIT** — change fixture path on line 412 from `"/daily"` to a non-redirecting non-prefetchable path (e.g. `"/chat/new"`) |
| `e2e/tests/share.spec.ts` | **EDIT** — update `href` assertion (line 25) from `"/daily"` to `"/notes"`; link name stays `"Open"` |
| `python/nexus/schemas/notes.py` | **EDIT** — add `DailyNotePageSummaryOut`; `NotePageOut.daily_note` |
| `python/nexus/services/notes.py` | **EDIT** — `_page_out` scalar join for `daily_note` |
| `python/nexus/services/command_palette.py` | **EDIT** — remove `/daily` and `/daily/{date}` palette-target cases (lines 338–339, 386–387) since the pane routes die |

---

## 16. Risks

**R-1. `command_palette.py` still accepts `/daily` hrefs (lines 338–339, 386–387).** These exist because the command palette can open `/daily` from the back end (e.g. the Android shell palette sync). After the frontend pane routes die, `/daily` still redirects to `/notes`. The command palette entries are safe to delete since no backend path still produces `/daily` as a target href. Decision: delete them in S4.

**R-2. Browser history entries pointing to `/daily/*` will land on the redirect.** Users with tabs pinned to `/daily` will be redirected to `/notes`. Acceptable: the Today button in Notes immediately recovers the expected destination.

**R-3. Running-journal spec (#2) has `daily: "notes"` and `dailyDate: "notes"` in the exhaustive `ROUTE_SECTION` map.** These become compile errors when `PaneRouteId` loses `"daily"` and `"dailyDate"`. Sequencing: this spec must land before or simultaneously with #2, which must remove those two entries and the browse comment placeholder.

**R-4. Dawn-write spec (#4) renders above `DailyNotePaneBody`.** If #4 is built concurrently against the old host, it will need a rebase onto this cutover's new host (`PagePaneBody`, gated on `page.dailyNote`). The coordination requirement is documented in §10 and in #4's own prerequisites.

**R-5. `paneIdentity.test.ts:80` asserts `daily_note_date` locator kind.** This is a direct test of the locator that dies in S4. The test is removed in S4. No other test covers this behavior after deletion.
